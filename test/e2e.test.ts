/**
 * End-to-end tests — tests the API via direct imports (same typed client the frontend uses).
 *
 * Run:  npm run test:e2e
 *
 * Covers Cognito-compatible local authentication (including required TOTP setup)
 * plus the agent conversation flow against the local canned model provider. Messages
 * are benign so the canned provider does NOT trigger searchDocs; RAG evals live in a
 * separate deployed/sandbox test suite.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { spawn, type ChildProcess } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { installCookieJar, isServerRunning } from '@aws-blocks/blocks/utils';
import type { api as ApiType } from 'aws-blocks';

// Unique users per run so the persistent local auth store doesn't cause
// "already exists" collisions across re-runs.
const U1 = `u1-${randomUUID()}@example.com`;
const U2 = `u2-${randomUUID()}@example.com`;
const U1_INITIAL_PASSWORD = 'TestPass123!';
const U1_RESET_PASSWORD = 'ChangedPass456!';

// Install cookie jar before importing the API client — Node's fetch doesn't
// persist cookies between requests, which breaks authenticated API calls.
installCookieJar();

let server: ChildProcess | null = null;
let api: typeof ApiType;

async function createAndSignInLocalUser(username: string, password: string) {
  await api.createLocalTestUser(username, password);
  const setup = await api.signIn(username, password);
  assert.strictEqual(setup.status, 'continueSignIn');
  if (setup.status !== 'continueSignIn') throw new Error('expected required MFA setup');
  assert.strictEqual(setup.nextStep.name, 'CONTINUE_SIGN_IN_WITH_TOTP_SETUP');

  // AuthCognito mock validates the six-digit shape; real Cognito verifies RFC 6238.
  const done = await api.confirmSignInCode(setup.nextStep.session, '123456');
  assert.strictEqual(done.status, 'signedIn');
  return done;
}

async function signInExistingLocalUser(username: string, password: string) {
  const challenge = await api.signIn(username, password);
  assert.strictEqual(challenge.status, 'continueSignIn');
  if (challenge.status !== 'continueSignIn') throw new Error('expected TOTP challenge');
  assert.strictEqual(challenge.nextStep.name, 'CONFIRM_SIGN_IN_WITH_TOTP_CODE');
  const done = await api.confirmSignInCode(challenge.nextStep.session, '654321');
  assert.strictEqual(done.status, 'signedIn');
  return done;
}

// ─── Setup (don't touch) ─────────────────────────────────────────────────────

test.before(async () => {
  // Use existing dev server if running, otherwise start one
  if (!await isServerRunning()) {
    server = spawn('npm', ['run', 'dev:server'], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
      env: { ...process.env, NODE_OPTIONS: '' },
    });
    server.unref();
    await setTimeout(2000);
  }

  const mod = await import('aws-blocks');
  api = mod.api;

  // Wait for server readiness (me() returns null when signed out — no throw).
  for (let i = 0; i < 30; i++) {
    try {
      await api.me();
      return;
    } catch {
      await setTimeout(1000);
    }
  }
  throw new Error('Dev server did not become ready within 30s');
});

test.after(() => {
  if (server?.pid) {
    try { process.kill(-server.pid, 'SIGTERM'); } catch {}
  }
});

// ─── Authentication ──────────────────────────────────────────────────────────

test('auth: starts signed out', async () => {
  assert.strictEqual(await api.me(), null);
});

test('auth: local fixture still requires TOTP before establishing a session', async () => {
  await api.createLocalTestUser(U1, U1_INITIAL_PASSWORD);
  const setup = await api.signIn(U1, U1_INITIAL_PASSWORD);
  assert.strictEqual(setup.status, 'continueSignIn');
  if (setup.status !== 'continueSignIn') throw new Error('expected MFA setup');
  assert.strictEqual(setup.nextStep.name, 'CONTINUE_SIGN_IN_WITH_TOTP_SETUP');
  assert.strictEqual(await api.me(), null, 'MFA must complete before a session exists');

  const done = await api.confirmSignInCode(setup.nextStep.session, '123456');
  assert.strictEqual(done.status, 'signedIn');
  const me = await api.me();
  assert.strictEqual(me?.username, U1);
});

test('auth: emailed reset code changes the password and preserves the TOTP challenge', async () => {
  await api.signOut();
  await api.beginPasswordReset(U1);
  const { code } = await api.getLocalPasswordResetCode(U1);
  assert.match(code, /^\d{6}$/);
  await api.confirmPasswordReset(U1, code, U1_RESET_PASSWORD);

  await assert.rejects(() => api.signIn(U1, U1_INITIAL_PASSWORD));
  await signInExistingLocalUser(U1, U1_RESET_PASSWORD);
});

test('agent: unauthenticated createConversation is rejected', async () => {
  await api.signOut();
  await assert.rejects(() => api.createConversation());
  // Sign back in through the normal post-enrolment TOTP challenge.
  await signInExistingLocalUser(U1, U1_RESET_PASSWORD);
});

// ─── Agent conversation flow ───────────────────────────────────────────────────

test('agent: createConversation returns an id', async () => {
  const { conversationId } = await api.createConversation();
  assert.ok(conversationId, 'expected a conversation id');
  assert.strictEqual(typeof conversationId, 'string');
});

test('agent: sendMessage persists the user message and an assistant reply', async () => {
  const { conversationId } = await api.createConversation();
  const channelId = randomUUID();

  // "hello" won't match a tool name, so the canned provider just replies.
  await api.sendMessage(conversationId, 'hello', channelId);

  // The agent runs asynchronously; poll persistence until the reply lands.
  let messages: { role: string; content: string }[] = [];
  for (let i = 0; i < 20; i++) {
    const res = await api.getConversation(conversationId);
    messages = res.messages;
    const hasUser = messages.some((m) => m.role === 'user');
    const hasAssistant = messages.some((m) => m.role === 'assistant');
    if (hasUser && hasAssistant) break;
    await setTimeout(500);
  }

  assert.ok(messages.some((m) => m.role === 'user' && m.content.includes('hello')), 'user message persisted');
  assert.ok(messages.some((m) => m.role === 'assistant'), 'assistant reply persisted');
});

test("agent: reads of another user's conversation are rejected", async () => {
  const { conversationId } = await api.createConversation();

  // Switch to a different user — they must not see the first user's conversation.
  await api.signOut();
  await createAndSignInLocalUser(U2, 'OtherPass123!');

  await assert.rejects(() => api.getConversation(conversationId), 'cross-user read must be denied');
});

test("agent: subscriptions to another user's realtime channel are rejected", async () => {
  // U1 owns a fresh conversation; its id doubles as the Realtime channel id.
  await api.signOut();
  await signInExistingLocalUser(U1, U1_RESET_PASSWORD);
  const { conversationId } = await api.createConversation();

  // U2 must not be able to obtain a signed subscription token for U1's channel,
  // even knowing the conversation UUID (Finding 1 — cross-user realtime authorization).
  await api.signOut();
  await signInExistingLocalUser(U2, 'OtherPass123!');
  await assert.rejects(
    () => api.getChannel(conversationId),
    'cross-user realtime channel must be denied',
  );
});
