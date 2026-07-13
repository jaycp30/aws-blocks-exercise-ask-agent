import * as cdk from 'aws-cdk-lib';
import { RemovalPolicies, Mixins } from 'aws-cdk-lib';
import { Effect, PolicyStatement } from 'aws-cdk-lib/aws-iam';

import { Hosting, BlocksStack, SandboxDisableDeletionProtection } from '@aws-blocks/blocks/cdk';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { getSandboxId } from './scripts/sandbox-id.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = new cdk.App();

// Tag every taggable resource in the stack. Tags.of(app) propagates to all
// constructs. (ResourceGroups themselves aren't tagged, but the resources they
// group — DynamoDB, S3, Lambda, SQS, etc. — are.)
cdk.Tags.of(app).add('iac-stack', 'CDK');
cdk.Tags.of(app).add('project', 'aws-block+aws-mcp');

const sandboxMode = app.node.tryGetContext('sandboxMode') === 'true';
const projectRoot = app.node.tryGetContext('projectRoot') || process.cwd();

// Stack name must NOT start with "aws"/"AWS": Blocks derives an AWS ResourceGroup
// name from it, and ResourceGroups reserve the "AWS" prefix (case-insensitive).
const stackName = sandboxMode ? `ask-aws-agent-stack-${getSandboxId(projectRoot)}` : 'ask-aws-agent-stack-prod';
export const blocksStack = await BlocksStack.create(app, stackName, {
  backendHandlerPath: join(__dirname, 'index.handler.ts'),
  backendCDKPath: join(__dirname, 'index.ts')
});

// ─── Least-privilege Bedrock (GitHub #5) ───────────────────────────────────────
// bb-agent hardcodes a Bedrock grant on `arn:aws:bedrock:*::foundation-model/*`
// (every model, every region) and exposes no prop to scope it. We can't remove that
// Allow, but an explicit Deny always wins, so we deny InvokeModel on everything EXCEPT
// the exact models this app uses. This shrinks the blast radius if the runtime or a
// dependency is compromised, while leaving the role's non-Bedrock permissions untouched.
//
// Region is intentionally wildcarded: the jp.* / apac.* profiles are CROSS-REGION and
// require invoke rights on their underlying model ARNs in whichever region they route
// to, so pinning regions risks locking out production chat. Model IDs mirror MODELS in
// aws-blocks/index.ts (+ Titan embed, used by kb.retrieve at query time) — keep in sync.
const ALLOWED_BEDROCK_MODELS = [
  // Sonnet 4.6 via the jp. cross-region inference profile
  'arn:aws:bedrock:*:*:inference-profile/jp.anthropic.claude-sonnet-4-6*',
  'arn:aws:bedrock:*::foundation-model/anthropic.claude-sonnet-4-6*',
  // Nova Pro via the apac. cross-region inference profile
  'arn:aws:bedrock:*:*:inference-profile/apac.amazon.nova-pro-v1*',
  'arn:aws:bedrock:*::foundation-model/amazon.nova-pro-v1*',
  // Nemotron Nano — on-demand foundation model
  'arn:aws:bedrock:*::foundation-model/nvidia.nemotron-nano-3-30b*',
  // Titan Text Embeddings V2 — query embedding for the knowledge base
  'arn:aws:bedrock:*::foundation-model/amazon.titan-embed-text-v2*',
];

blocksStack.handler.addToRolePolicy(new PolicyStatement({
  effect: Effect.DENY,
  actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
  notResources: ALLOWED_BEDROCK_MODELS,
}));

if (sandboxMode) {
  // Make all resources deletable so sandbox:destroy can clean up the entire stack.
  // This overrides removal policies and deletion protection (e.g. RDS) for every
  // resource in the stack, including any you add below.
  // Remove these lines if you want to manage teardown behavior yourself.
  RemovalPolicies.of(blocksStack).destroy();
  Mixins.of(blocksStack).apply(new SandboxDisableDeletionProtection());

  // Tell the runtime that cookies need cross-domain attributes (frontend on
  // localhost, API on API Gateway — different registrable domains).
  blocksStack.handler.addEnvironment('BLOCKS_SANDBOX', 'true');
}

// Content-Security-Policy for the static site. Without this, CloudFront serves the
// AWS managed SecurityHeadersPolicy, which intentionally ships no CSP. Setting the
// prop makes Hosting attach a custom response-headers policy carrying this value.
//
// Values were validated against the actual `npm run build` output:
//   - script-src 'self' (no 'unsafe-inline'/'unsafe-eval'): the build emits only an
//     external module script and no eval/Function — so scripts are fully locked down.
//   - style-src keeps 'unsafe-inline': the built index.html has one inline <style> and
//     GSAP animates via inline style attributes.
//   - img-src/font-src add data: for inline data-URI assets; no external origins load.
//   - connect-src keeps https: and wss:: the Realtime subscription connects to a
//     cross-origin AppSync endpoint (https handshake + wss stream) not known at build
//     time. A future tightening is to pin that exact endpoint host here.
//   - base-uri/object-src/frame-ancestors/form-action are defense-in-depth hardening.
// Note: Permissions-Policy is NOT set — Hosting has no prop for it, so it would need a
// separate custom CloudFront response-headers policy (tracked as a follow-up).
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self' https: wss:",
  'upgrade-insecure-requests',
].join('; ');

// Add static site hosting only when deploying (not in sandbox mode)
if (!sandboxMode) {
  new Hosting(blocksStack, 'Hosting', {
    root: join(__dirname, '..'),
    buildCommand: 'npm run build',
    buildOutputDir: 'dist',
    api: blocksStack,
    contentSecurityPolicy: CONTENT_SECURITY_POLICY
  });
}