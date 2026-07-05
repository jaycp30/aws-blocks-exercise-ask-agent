/**
 * Backend — aws-blocks/index.ts
 *
 * "Ask my handover docs" — a RAG (retrieval-augmented generation) chat agent that
 * answers questions about a set of documents, so a team can self-serve while a
 * colleague is away.
 *
 * Architecture:
 *   - `KnowledgeBase` block (bb-knowledge-base) indexes the ./knowledge folder:
 *     chunk -> embed (Titan) -> S3 Vectors. Local dev uses TF-IDF (free, no Bedrock).
 *   - `Agent` block (bb-agent) with a `searchDocs` tool that calls kb.retrieve();
 *     Claude answers from the retrieved passages and cites the source document.
 *   - `AuthBasic` + an invite-code gate scope access to invited teammates.
 */
import {
  ApiNamespace,
  Scope,
  AuthBasic,
  Agent,
  OllamaModels,
  AppSetting,
  KnowledgeBase,
} from '@aws-blocks/blocks';
import { z } from 'zod';

const scope = new Scope('ask-aws');

// ─── Auth ────────────────────────────────────────────────────────────────────
const auth = new AuthBasic(scope, 'auth', {
  passwordPolicy: { minLength: 8 },
  crossDomain: process.env.BLOCKS_SANDBOX === 'true',
});
// Secret invite code that gates signup — set out-of-band (SSM SecureString in prod,
// .bb-data/settings.json locally), never committed. Only invited teammates can sign up.
const inviteCode = new AppSetting(scope, 'invite-code', {
  name: '/ask-aws/invite-code',
  secret: true,
});

// NOTE: we deliberately do NOT expose auth.createApi() (the raw public signup
// endpoint). Auth is routed through the gated `api` methods below instead.

// ─── Knowledge base (RAG source) ──────────────────────────────────────────────
// Indexes everything in ./knowledge. Local dev scores with TF-IDF (free); on AWS it
// embeds with Titan and stores vectors in S3 Vectors (serverless, pay-per-use).
// removalPolicy 'destroy' so teardown removes the doc bucket + embeddings — this is
// meant to be a temporary handover assistant.
const kb = new KnowledgeBase(scope, 'docs', {
  source: './knowledge',
  description: 'Team handover documents',
  removalPolicy: 'destroy',
});

// ─── Models ──────────────────────────────────────────────────────────────────
// The models a user can pick in the UI. Every entry becomes its own Agent block
// (bb-agent binds the model at construction — there is no per-request override),
// so a conversation is tied to the model it was started with.
// All jp.* profiles keep inference inside Japan; Nova Pro only has an apac.
// profile (may route across APAC); Nemotron is on-demand, local to ap-northeast-1.
// Keys double as the Agent block id (`agent-<key>`), which feeds the S3 snapshot bucket
// name. S3 caps bucket names at 63 chars and the name includes the stack + scope chain,
// so keys are kept SHORT — the descriptive text lives in `label`, which is what the UI
// shows. (A long key like "nemotron-nano-30b" pushed the derived name to 69 chars.)
const MODELS = {
  sonnet: { label: 'Claude Sonnet 4.6', modelId: 'jp.anthropic.claude-sonnet-4-6' },
  nova: { label: 'Amazon Nova Pro', modelId: 'apac.amazon.nova-pro-v1:0' },
  nemotron: { label: 'Nvidia Nemotron Nano 3 30B', modelId: 'nvidia.nemotron-nano-3-30b' },
} as const;

type ModelKey = keyof typeof MODELS;
const DEFAULT_MODEL: ModelKey = 'sonnet';

// ─── Agent ───────────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You answer questions about a set of team handover documents, so colleagues can
self-serve while the document owner is away.

To answer ANY question, you MUST first call the searchDocs tool to find relevant
passages, then answer using ONLY what those passages say. Do not answer from your own
general knowledge, and do not guess.

- Cite the source document for each fact (use the "source" field from the results).
- If the documents don't contain the answer, say so plainly — e.g. "I couldn't find
  that in the handover documents" — rather than inventing one.
- Keep answers concise and skimmable; quote short snippets when it helps.
- If a question is ambiguous, ask one short clarifying question before searching.

TONE & PERSONA:
- By default, use a warm but professional, concise tone.
- If the user's message begins with the marker "[[FUN]]", ignore the marker itself and
  answer in a playful "Tokyo hiking buddy" persona: upbeat and a little witty, with the
  occasional fitting emoji (⛩️ 🗻 🥾) and a light Tokyo/hiking metaphor. Keep it genuinely
  helpful, never cringe.
- Persona affects ONLY tone. It never overrides the rules above: always search first,
  answer only from the documents, cite sources, and never invent facts to be entertaining.

(The "[[FUN]]" marker is added automatically by the UI in fun mode — never mention it or
echo it back to the user.)`;

// bb-agent binds the model at construction, so "let the user pick a model" means one
// Agent block per model. They share the same system prompt, tools, and knowledge base;
// only the deployed modelId differs. Local dev always uses Ollama (the selector still
// routes to the right block, so per-model conversation storage stays isolated locally).
function buildAgent(key: ModelKey) {
  return new Agent(scope, `agent-${key}`, {
    model: {
      deployed: { provider: 'bedrock', modelId: MODELS[key].modelId },
      local: OllamaModels.XSMALL, // llama3.2:3b; falls back to canned mock if Ollama is down
    },
    systemPrompt: SYSTEM_PROMPT,
    streamingMode: 'token', // typewriter-style UI
    tools: (tool) => ({
      searchDocs: tool({
        description:
          'Search the handover documents for passages relevant to the user\'s question. ' +
          'Call this for ANY question about the documents/handover. Returns ranked chunks, ' +
          'each with its `source` document and a relevance `score`.',
        parameters: z.object({
          query: z.string().describe('What to look for, in natural language'),
          maxResults: z.number().optional().describe('Max passages to return (default 5)'),
        }),
        needsApproval: false, // read-only retrieval
        handler: async ({ input }) => {
          const results = await kb.retrieve(input.query, { maxResults: input.maxResults ?? 5 });
          // Map to a plain JSON shape (RetrieveResult is an interface, not a JSONValue)
          // and hand the model just what it needs to answer + cite the source.
          return results.map((r) => ({ text: r.text, source: r.source, score: r.score }));
        },
      }),
    }),
  });
}

// One agent block per selectable model, keyed by ModelKey.
const agents = Object.fromEntries(
  (Object.keys(MODELS) as ModelKey[]).map((key) => [key, buildAgent(key)]),
) as Record<ModelKey, ReturnType<typeof buildAgent>>;

// Resolve an agent from an untrusted client-supplied model key. Unknown/absent keys
// fall back to the default rather than throwing — the caller never controls infra.
function resolveAgent(model?: string): { key: ModelKey; agent: ReturnType<typeof buildAgent> } {
  const key = (model && model in MODELS ? model : DEFAULT_MODEL) as ModelKey;
  return { key, agent: agents[key] };
}

// ─── API ─────────────────────────────────────────────────────────────────────
// userId is always derived server-side from the authenticated session — never
// trusted from the client. Read paths verify the conversation is owned by the
// caller (bb-agent does not authorize reads by itself).
export const api = new ApiNamespace(scope, 'api', (context) => ({
  // ─── Auth (gated: signup requires the invite code) ───────────────────────────
  async me() {
    return auth.getCurrentUser(context);
  },

  async signIn(username: string, password: string) {
    const user = await auth.signIn(username, password, context);
    return { username: user.username };
  },

  async signOut() {
    await auth.signOut(context);
    return { ok: true };
  },

  /** Create an account — only if the invite code matches. Then sign in. */
  async signUp(invite: string, username: string, password: string) {
    const expected = await inviteCode.get();
    if (!invite || invite !== expected) throw new Error('Invalid invite code');
    await auth.signUp(username, password);
    const user = await auth.signIn(username, password, context);
    return { username: user.username };
  },

  // ─── Models ────────────────────────────────────────────────────────────────
  /** The models a signed-in user can choose from (backend is the single source of truth). */
  async listModels() {
    await auth.requireAuth(context);
    return {
      models: (Object.keys(MODELS) as ModelKey[]).map((key) => ({ key, label: MODELS[key].label })),
      defaultModel: DEFAULT_MODEL as string,
    };
  },

  // ─── Agent ───────────────────────────────────────────────────────────────────
  // Every conversation-scoped call carries the model key: storage and the Realtime
  // channel are per-agent, so a conversation must be read/streamed on the SAME agent
  // that created it. The client keeps the key consistent for a conversation's lifetime.
  async createConversation(model?: string) {
    const user = await auth.requireAuth(context);
    const { key, agent } = resolveAgent(model);
    return { conversationId: await agent.createConversationId(user.username), model: key };
  },

  async sendMessage(conversationId: string, message: string, channelId: string, model?: string) {
    const user = await auth.requireAuth(context);
    const { agent } = resolveAgent(model);
    await assertOwns(agent, user.username, conversationId);
    await agent.stream(message, { conversationId, channelId, userId: user.username });
    return { ok: true };
  },

  async getConversation(conversationId: string, model?: string) {
    const user = await auth.requireAuth(context);
    const { agent } = resolveAgent(model);
    await assertOwns(agent, user.username, conversationId);
    return { messages: await agent.getConversation(conversationId) };
  },

  async getChannel(channelId: string, model?: string) {
    await auth.requireAuth(context);
    const { agent } = resolveAgent(model);
    return agent.getChannel(channelId);
  },

  /** Delete a conversation (used by "New chat" so abandoned threads don't pile up). */
  async deleteConversation(conversationId: string, model?: string) {
    const user = await auth.requireAuth(context);
    const { agent } = resolveAgent(model);
    await assertOwns(agent, user.username, conversationId);
    await agent.deleteConversation(conversationId, user.username);
    return { ok: true };
  },
}));

/** Throw unless `userId` owns `conversationId` on the given agent. */
async function assertOwns(
  agent: ReturnType<typeof buildAgent>,
  userId: string,
  conversationId: string,
): Promise<void> {
  const owned = await agent.listConversations(userId);
  if (!owned.some((c) => c.conversationId === conversationId)) {
    throw new Error('Conversation not found');
  }
}
