/**
 * Backend — aws-blocks/index.ts
 *
 * A read-only "ask my AWS account" chat agent built on AWS Blocks.
 *
 * Architecture (Plan B — see understanding.md):
 *   - `Agent` block (bb-agent) provides streaming, conversation persistence
 *     (DynamoDB, automatic), and tool calling. Powered by Strands.
 *   - One tool, `runAwsRead`, wraps the AWS API MCP server's `call_aws`. The
 *     model proposes an AWS read command; the handler runs it via MCP and hands
 *     the output back for the agent to summarize.
 *   - `AuthBasic` scopes conversations per user.
 *
 * Guardrails (defense in depth, not prompt-trust):
 *   1. READ_OPERATIONS_ONLY=true on the MCP server (see aws-mcp.ts).
 *   2. Read-only IAM on the runtime principal (enforced at deploy).
 *   3. The system prompt below — a courtesy layer, NOT a control.
 */
import { ApiNamespace, Scope, AuthBasic, Agent, OllamaModels, AppSetting } from '@aws-blocks/blocks';
import { z } from 'zod';
import { runAwsRead } from './aws-mcp.js';

const scope = new Scope('ask-aws');

// ─── Auth ────────────────────────────────────────────────────────────────────
const auth = new AuthBasic(scope, 'auth', {
  passwordPolicy: { minLength: 8 },
  crossDomain: process.env.BLOCKS_SANDBOX === 'true',
});
// Secret invite code that gates signup — set out-of-band (SSM SecureString in prod,
// .bb-data/settings.json locally), never committed. Without it no one can create an
// account, so a public deploy can't be abused to burn Bedrock budget.
const inviteCode = new AppSetting(scope, 'invite-code', {
  name: '/ask-aws/invite-code',
  secret: true,
});

// NOTE: we deliberately do NOT expose auth.createApi() (the raw public signup
// endpoint). Auth is routed through the gated `api` methods below instead.

// ─── Agent ───────────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are a read-only assistant for the user's AWS account. Your default region is
ap-northeast-1 (Tokyo); use other regions only when the user names them.

You can inspect resources, costs, metrics, logs, and configuration using the
runAwsRead tool, which runs AWS read commands. You have READ-ONLY access. You must
never attempt to create, modify, or delete anything. If the user asks for a change,
explain what command would do it and tell them to run it themselves.

IMPORTANT — ALWAYS ACT, NEVER DESCRIBE: To answer ANY question about the account,
you MUST call the runAwsRead tool and base your answer ONLY on its actual output.
Never describe what a command "would" return, and never answer from your own
knowledge — call runAwsRead, wait for the real result, then summarize it. For
"list my S3 buckets", call runAwsRead with command "s3api list-buckets".

Work efficiently:
- Prefer targeted queries over broad dumps. Request only the data you need.
- Summarize results in plain language. Do not paste large raw payloads back to the user.
- Cost Explorer calls are billed per request, so minimize and batch cost queries.
- If a request is ambiguous about region, service, or time window, ask one short
  clarifying question before running expensive or broad calls.
- Always state the exact AWS command you used so the user can reproduce it.
- If any output contains credentials, access keys, or secrets, redact them. Never
  echo secret values.

When calling runAwsRead, pass the command WITHOUT the leading "aws" — for example
"ec2 describe-instances --region ap-northeast-1" or "s3api list-buckets".`;

const agent = new Agent(scope, 'aws-agent', {
  // Deployed: the `jp.` Sonnet 4.6 inference profile so inference stays inside
  // Japan (Tokyo), not the `us.` default that BedrockModels.DEFAULT would use.
  // Local: Ollama llama3.2:3b (~2 GB, fits this M2's ~5.3 GiB GPU without the
  // crash 8b caused); falls back to the canned mock if Ollama isn't running.
  model: {
    deployed: { provider: 'bedrock', modelId: 'jp.anthropic.claude-sonnet-4-6' },
    local: OllamaModels.XSMALL,
  },
  systemPrompt: SYSTEM_PROMPT,
  streamingMode: 'token', // typewriter-style UI
  tools: (tool) => ({
    runAwsRead: tool({
      description:
        'Run a single READ-ONLY AWS CLI command and return its output. Use for ' +
        'describe/list/get operations to inspect resources, costs, metrics, logs, ' +
        'and configuration. Pass the command WITHOUT the leading "aws", e.g. ' +
        '"ec2 describe-instances --region ap-northeast-1". Never use mutating verbs ' +
        '(create/delete/put/modify/update/run/terminate/...).',
      parameters: z.object({
        command: z
          .string()
          .describe('AWS CLI command without the leading "aws", e.g. "s3api list-buckets"'),
      }),
      needsApproval: false, // read-only; IAM + READ_OPERATIONS_ONLY are the real guard
      handler: async ({ input }) => runAwsRead(input.command),
    }),
  }),
});

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

  // ─── Agent ───────────────────────────────────────────────────────────────────
  async createConversation() {
    const user = await auth.requireAuth(context);
    return { conversationId: await agent.createConversationId(user.username) };
  },

  async sendMessage(conversationId: string, message: string, channelId: string) {
    const user = await auth.requireAuth(context);
    await assertOwns(user.username, conversationId);
    await agent.stream(message, { conversationId, channelId, userId: user.username });
    return { ok: true };
  },

  async getConversation(conversationId: string) {
    const user = await auth.requireAuth(context);
    await assertOwns(user.username, conversationId);
    return { messages: await agent.getConversation(conversationId) };
  },

  async getChannel(channelId: string) {
    await auth.requireAuth(context);
    return agent.getChannel(channelId);
  },
}));

/** Throw unless `userId` owns `conversationId`. */
async function assertOwns(userId: string, conversationId: string): Promise<void> {
  const owned = await agent.listConversations(userId);
  if (!owned.some((c) => c.conversationId === conversationId)) {
    throw new Error('Conversation not found');
  }
}
