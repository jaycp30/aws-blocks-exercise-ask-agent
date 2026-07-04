# Understanding — read-only "ask my AWS account" agent on AWS Blocks

Living checklist (teaching mode). Tick items as they're demonstrated/understood.

## The problem & why it exists
- Goal: practice **AWS Blocks** (Public Preview, 0.1.x) end-to-end by building a
  read-only "ask my AWS account" chat agent. MCP integration is the *means*;
  exercising Blocks is the *point*.
- Target deploy region: **ap-northeast-1 (Tokyo)**.

## Verified facts (this session, 2026-06-28)
- Scaffolder: `@aws-blocks/create-blocks-app` (npm-create resolves
  `npm create @aws-blocks/blocks-app` -> this). Used `--template react`.
- `@aws-blocks/blocks` is a meta-package; it **re-exports** `Agent`, `AgentErrors`,
  `BedrockModels`, `OllamaModels` (from `bb-agent`). Import Agent from
  `@aws-blocks/blocks`, consistent with the scaffold.
- `bb-agent` 0.1.3 API:
  - `new Agent(scope, id, { model, systemPrompt, tools, toolContextSchema,
    inferenceOnly, conversation, streamingMode })`.
  - Tools: `tools: (tool) => ({ name: tool({ description, parameters: ZodSchema,
    handler: async ({input, context, interrupt}) => ..., needsApproval?,
    trustable?, interrupt? }) })`.
  - `needsApproval: false` for read-only (no human gate); `true` for mutations.
  - Streaming via Realtime; client hook `useChat` from `@aws-blocks/bb-agent/client`
    handles subscribe-before-send ordering.

## To-Verify items from handover — RESOLVED
1. Agent + tool shape: **confirmed** (above).
2. Native MCP passthrough (Plan A): **NOT supported in 0.1.3**. AgentConfig has no
   MCP field. -> **Plan B**: wrap the AWS read in a `tool()` handler (idiomatic;
   same pattern as the KnowledgeBase example).
3. Conversation persistence: **built in, DynamoDB**. Agent auto-provisions
   DistributedTable x2 (DynamoDB) + S3 FileBucket + Realtime + AsyncJob.
   No Aurora. Don't add a data block; just don't set `inferenceOnly`.
4. Prod model/region: `BedrockModels.DEFAULT` = `us.anthropic.claude-opus-4-8...`
   — a **`us.` cross-region inference profile** (routes through US regions).
   For Tokyo data residency, override `modelId` to an `apac.`/`jp.` profile at
   deploy; verify exact id via Bedrock console / list-foundation-models then.

## Footguns confirmed
- **Region is set nowhere in the scaffold.** Deploy falls back to CLI default =
  ap-southeast-1 (Singapore). MUST pass `AWS_REGION=ap-northeast-1` at deploy.
- IAM is the real read-only guardrail, not the prompt. Point the runtime at a
  read-only principal.
- Cost Explorer bills ~$0.01/request; broad describe/list calls balloon tokens.

## Design decision — RESOLVED
- `runAwsRead` handler connects to **awslabs.aws-api-mcp-server** (Python, via uvx)
  over **stdio** using `@modelcontextprotocol/sdk` client, and calls `call_aws`.
  MCP stays genuinely in the loop. Local-first: test the full loop locally with
  real read-only calls to Tokyo (free); defer Lambda/Python packaging to deploy.

## Build plan (Plan B)
- [x] `aws-blocks/aws-mcp.ts`: singleton MCP client + `runAwsRead`.
- [x] Replace `aws-blocks/index.ts`: Agent (read-only system prompt) + `runAwsRead`
      tool + AuthBasic + API namespace (create/send/get/getChannel).
- [x] Smoke test (`scripts/smoke-mcp.ts`): PROVEN against Tokyo — sts + s3 reads
      return 200; create-bucket REFUSED by READ_OPERATIONS_ONLY. No model, free.
- [x] Replace `src/App.tsx`: chat UI via `useChat`.
- [x] Run Blocks dev server: auth + streaming + persistence proven (canned), then
      real local model via Ollama (llama3.2:3b) calling runAwsRead -> real buckets.
      (8b crashed the M2 on memory; 3b fits but needs forceful prompting to tool-call.)
- [x] Deploy to ap-northeast-1 (sandbox): stack `ask-aws-agent-stack-jaycloudbridge-*`,
      model jp.anthropic.claude-sonnet-4-6, tags iac-stack/project. DONE + WORKING.
      - Fixed upstream bb-agent bug via patch-package: it created Strands S3Storage
        without a region, defaulting to us-east-1 -> PermanentRedirect on the Tokyo
        snapshot bucket -> "S3 error reading". Patch passes `region: process.env.AWS_REGION`.
      - Verified: real Claude Sonnet 4.6 (Bedrock Tokyo) replies; tool-call reaches the
        cloud stub ("account reads not enabled in cloud yet") = correct chat-first behavior.
      - Cloud MCP tool-reach (step 2) still TODO.
- [x] Filed upstream bug draft (docs/upstream-bb-agent-region-bug.md); renamed git
      identity to personal (jaycp30); tore down the jaycloudbridge sandbox.
- [x] Signup guardrail before going public: invite-code gate — removed the raw
      `authApi` (no public signup endpoint), routed auth through gated `api` methods
      (me/signIn/signOut/signUp(inviteCode)), secret AppSetting for the code. All 7
      e2e tests pass. (Also fixed: void-returning API methods break the RPC client —
      return `{ ok: true }`.)
- [~] Production go-live: `npm run deploy` -> prod stack `ask-aws-agent-stack-prod`
      + CloudFront public URL. Set invite code in SSM after deploy:
      `aws ssm put-parameter --name /ask-aws/invite-code --value <code> --type SecureString --overwrite --region ap-northeast-1`
