/**
 * End-to-end tests — tests the API via direct imports (same typed client the frontend uses).
 *
 * Run:  npm run test:e2e   (set INVITE_CODE to the local invite code first)
 *
 * Covers the invite-gated auth + agent conversation flow against the local canned
 * model provider (no AWS, no Bedrock). Messages are benign so the canned provider
 * does NOT trigger the searchDocs tool — keeps these tests hermetic and fast.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { spawn, type ChildProcess } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { installCookieJar, isServerRunning } from '@aws-blocks/blocks/utils';
import type { api as ApiType } from 'aws-blocks';

// The invite code seeded into .bb-data/settings.json for local dev. Override via env.
const INVITE = process.env.INVITE_CODE ?? 'test-invite';

// Unique users per run so the persistent local auth store doesn't cause
// "already exists" collisions across re-runs.
const U1 = `u1-${randomUUID()}@example.com`;
const U2 = `u2-${randomUUID()}@example.com`;

// Install cookie jar before importing the API client — Node's fetch doesn't
// persist cookies between requests, which breaks authenticated API calls.
installCookieJar();

let server: ChildProcess | null = null;
let api: typeof ApiType;

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

// ─── Auth (invite-gated) ────────────────────────────────────────────────────────

test('auth: starts signed out', async () => {
  assert.strictEqual(await api.me(), null);
});

test('auth: signup is rejected without a valid invite code', async () => {
  await assert.rejects(() => api.signUp('wrong-code', 'gate@example.com', 'TestPass123!'));
  assert.strictEqual(await api.me(), null, 'no account should have been created');
});

test('auth: signup with the invite code creates the account and signs in', async () => {
  const res = await api.signUp(INVITE, U1, 'TestPass123!');
  assert.strictEqual(res.username, U1);
  const me = await api.me();
  assert.strictEqual(me?.username, U1);
});

test('agent: unauthenticated createConversation is rejected', async () => {
  await api.signOut();
  await assert.rejects(() => api.createConversation());
  // sign back in for the remaining tests
  await api.signIn(U1, 'TestPass123!');
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
  await api.signUp(INVITE, U2, 'OtherPass123!');

  await assert.rejects(() => api.getConversation(conversationId), 'cross-user read must be denied');
});
