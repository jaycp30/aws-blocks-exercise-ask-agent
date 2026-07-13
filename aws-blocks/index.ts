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
 *   - `AuthCognito` scopes access to administrator-created users and requires
 *     TOTP MFA before any document or conversation API can be used.
 */
import {
  ApiNamespace,
  Scope,
  AuthCognito,
  Agent,
  OllamaModels,
  KnowledgeBase,
} from '@aws-blocks/blocks';
import { z } from 'zod';

const scope = new Scope('ask-aws');

// ─── Auth ────────────────────────────────────────────────────────────────────
// Production accounts are created by an administrator in Cognito. There is no
// browser sign-up endpoint or shared invite code. TOTP is the only second factor,
// avoiding SMS cost/SIM-swap exposure and SES configuration for email MFA.
//
// Retain the pool and session table if the stack is deleted accidentally. This is
// deliberately different from the temporary RAG document bucket below.
const localAuthCodes = new Map<string, string>();
const auth = new AuthCognito(scope, 'auth', {
  selfSignUp: false,
  signInWith: 'email',
  mfa: 'required',
  mfaTypes: ['TOTP'],
  passwordPolicy: {
    minLength: 12,
    requireUppercase: true,
    requireLowercase: true,
    requireDigits: true,
    requireSymbols: true,
  },
  authFlowType: 'USER_PASSWORD_AUTH',
  featurePlan: 'essentials',
  sessionTtlSeconds: 8 * 60 * 60,
  removalPolicy: 'retain',
  crossDomain: process.env.BLOCKS_SANDBOX === 'true',
  // Mock-only delivery hook. NODE_ENV is explicitly "production" in the
  // deployed Lambda, so verification codes are never captured in AWS.
  ...(process.env.NODE_ENV !== 'production'
    ? {
        codeDelivery: async (username: string, code: string, purpose: string) => {
          localAuthCodes.set(`${purpose}:${username}`, code);
        },
      }
    : {}),
});

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

// ─── Abuse / cost guards ───────────────────────────────────────────────────────
// A handover-doc question is short; these bounds exist to cap accidental or
// malicious oversized requests before they reach Bedrock (token cost) or the
// retriever. They are deliberately generous so normal use never hits them.
const MAX_MESSAGE_LENGTH = 8_000; // characters per chat message
const MAX_SEARCH_RESULTS = 10; // upper bound for the searchDocs `maxResults` tool arg
const DEFAULT_SEARCH_RESULTS = 5;

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
          // Clamp to [1, MAX_SEARCH_RESULTS] so a model- or client-supplied value can't
          // request an unbounded retrieval. Non-finite/absent values fall back to the default.
          const requested = Number.isFinite(input.maxResults) ? (input.maxResults as number) : DEFAULT_SEARCH_RESULTS;
          const maxResults = Math.min(MAX_SEARCH_RESULTS, Math.max(1, Math.floor(requested)));
          const results = await kb.retrieve(input.query, { maxResults });
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
    return auth.signIn(username.trim().toLowerCase(), password, context);
  },

  /** Continue a TOTP enrolment or normal TOTP challenge. */
  async confirmSignInCode(session: string, code: string) {
    if (!/^\d{6}$/.test(code)) throw new Error('Enter the 6-digit authenticator code');
    return auth.confirmSignIn(session, { code }, context, {
      friendlyDeviceName: 'Handover Base Camp',
    });
  },

  /** Complete the first-login temporary-password challenge for admin-created users. */
  async completeNewPassword(session: string, newPassword: string) {
    return auth.confirmSignIn(session, { newPassword }, context);
  },

  /** Email a password-reset code. Cognito deliberately does not reveal unknown users. */
  async beginPasswordReset(username: string) {
    const normalized = username.trim().toLowerCase();
    if (!normalized) throw new Error('Enter your email address');
    await auth.resetPassword(normalized);
    return { ok: true };
  },

  /** Complete the reset using the code delivered by Cognito. TOTP remains enabled. */
  async confirmPasswordReset(username: string, code: string, newPassword: string) {
    const normalized = username.trim().toLowerCase();
    if (!/^\d{6}$/.test(code)) throw new Error('Enter the 6-digit verification code');
    if (newPassword.length < 12) throw new Error('Password must be at least 12 characters');
    await auth.confirmResetPassword(normalized, code, newPassword);
    localAuthCodes.delete(`resetPassword:${normalized}`);
    return { ok: true };
  },

  async signOut() {
    // Revoke the Cognito refresh token as well as clearing the browser cookie.
    await auth.signOut(context, { global: true });
    return { ok: true };
  },

  /**
   * Local test fixture only. Production has NODE_ENV=production and Cognito
   * self-sign-up disabled, so this path cannot create a deployed account.
   */
  async createLocalTestUser(username: string, password: string) {
    if (process.env.NODE_ENV === 'production') throw new Error('Not found');
    const normalized = username.trim().toLowerCase();
    await auth.signUp(normalized, password);
    const code = localAuthCodes.get(`signUp:${normalized}`);
    if (!code) throw new Error('Local confirmation code was not captured');
    await auth.confirmSignUp(normalized, code);
    localAuthCodes.delete(`signUp:${normalized}`);
    return { username: normalized };
  },

  /** Read a mock delivery code in E2E tests; unavailable in the deployed Lambda. */
  async getLocalPasswordResetCode(username: string) {
    if (process.env.NODE_ENV === 'production') throw new Error('Not found');
    const normalized = username.trim().toLowerCase();
    const code = localAuthCodes.get(`resetPassword:${normalized}`);
    if (!code) throw new Error('Local password-reset code was not captured');
    return { code };
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
    // Validate the payload at the boundary, before any owned-conversation lookup or
    // Bedrock call: reject empty and oversized messages so a single request can't run
    // up an unbounded token bill.
    if (typeof message !== 'string' || message.trim().length === 0) {
      throw new Error('Message cannot be empty');
    }
    if (message.length > MAX_MESSAGE_LENGTH) {
      throw new Error(`Message is too long (max ${MAX_MESSAGE_LENGTH} characters)`);
    }
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
    const user = await auth.requireAuth(context);
    const { agent } = resolveAgent(model);
    // The Realtime channel id IS the conversation id (see src/App.tsx subscribe()),
    // so a signed subscription token must be gated by conversation ownership — the
    // same check the read/write/delete routes apply. Without this, any signed-in
    // user who learns a conversation UUID could subscribe to its streamed replies.
    await assertOwns(agent, user.username, channelId);
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
