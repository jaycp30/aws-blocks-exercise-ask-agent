# Agent tools in this exercise — what they are & how to add them

How the agent's **tools** work here: what a "tool" is, the one this app ships
(`searchDocs`), whether it's custom or plugged-in, and how you'd add your own safely.

Related: [Glossary → Tool](./glossary.md#tool-tool-call) ·
[Glossary → Strands](./glossary.md#strands-strands-agents-sdk) ·
[How RAG is implemented](./rag-implementation.md) ·
[Exercise wiki](./exercise-wiki.md)

---

## TL;DR

- A **tool** is a function the *model* is allowed to call — described by name +
  description + parameter schema. It is **not** a Lambda function (Lambda is just the
  compute the agent runs on).
- This app has **one** tool, **`searchDocs`**, and **we wrote it** — it's custom, not
  a drop-in. But it's a thin ~3-line adapter: its handler just calls `kb.retrieve()`
  (managed Bedrock Knowledge Base). *We built the wrapper; Bedrock does the work.*
- Through the `bb-agent` block, the **only** supported way to add a tool is the custom
  `tool()` factory. Strands' pre-built ("vended") tools and MCP servers exist, but
  `bb-agent`'s config exposes no hook for them — you'd wrap anything external inside a
  custom tool (which is exactly what the original MCP version of this exercise did).

---

## What a tool is (and isn't)

A tool is a **model capability**: you hand the model a labelled function ("`searchDocs`
— searches the handover docs, takes a `query`"). Mid-reasoning the model can emit a
"call `searchDocs` with `{query: …}`" request; the Strands runtime runs the handler
and feeds the result back, looping until the model writes a final answer.

It is **not** an AWS resource. The handler *runs on* the agent's Lambda in the cloud
(and in your local node process during `npm run dev`), but a tool is a function in the
agent's code — one Lambda hosts the agent and all its tools. See
[Glossary → Tool](./glossary.md#tool-tool-call).

---

## How `bb-agent` registers tools

Tools are declared in `AgentConfig.tools` as a **callback** that receives the `tool()`
factory and returns a `Record` keyed by tool name (`bb-agent .../types.d.ts:53-65`).
A plain object/array is rejected at compile time — the callback form lets TypeScript
infer each tool's `input` from its Zod `parameters`.

This app's actual tool (`aws-blocks/index.ts:112-128`):

```ts
tools: (tool) => ({
  searchDocs: tool({
    description: 'Search the handover documents for passages relevant to the ' +
      "user's question. Returns ranked chunks, each with its `source` and `score`.",
    parameters: z.object({
      query: z.string().describe('What to look for, in natural language'),
      maxResults: z.number().optional().describe('Max passages to return (default 5)'),
    }),
    needsApproval: false, // read-only retrieval — no human approval needed
    handler: async ({ input }) => {
      const results = await kb.retrieve(input.query, { maxResults: input.maxResults ?? 5 });
      return results.map((r) => ({ text: r.text, source: r.source, score: r.score }));
    },
  }),
}),
```

### Anatomy of a tool

| Field | Purpose |
|---|---|
| `description` | **The model reads this** to decide when to call the tool. Write it for the model, not for humans. |
| `parameters` | A **Zod schema** — becomes the tool's input contract; the runtime validates the model's args against it. |
| `handler` | **Your code.** Runs when the model calls the tool; must return a `JSONValue` (plain JSON, not SDK types). |
| `needsApproval` | If `true`, the agent **pauses for human approval** (interrupt) before running — a guardrail for side-effectful tools (`index.hooks.d.ts:79`). |
| `context` | Per-call data (e.g. `userId`, auth claims) threaded in via `toolContextSchema` (`types.d.ts:79`) so a tool can scope behaviour to the caller. |

---

## Did we make it, or plug it in?

**We made it** — `searchDocs` is custom code in this repo, not a pre-built tool. But
the split is worth seeing:

- **The tool = ours.** We authored the description, the Zod schema, and the handler.
- **The muscle = plugged in.** The handler is a ~3-line adapter over `kb.retrieve()`,
  i.e. managed **Bedrock Knowledge Base**. We didn't write the embedding/vector search.

So: *a thin custom tool exposing a plugged-in managed capability to the model.*

### The three ways to source a tool (and what applies here)

| Source | What it is | Usable via `bb-agent`? |
|---|---|---|
| **Custom** (`tool()` factory) | You write the description + Zod schema + handler | ✅ The supported path — this is `searchDocs` |
| **Vended tools** (Strands) | Pre-built tools shipped in the SDK: `http-request`, `bash`, `file-editor`, `notebook` (`@strands-agents/sdk/vended-tools/*`) | ⚠️ No block-config hook — not a drop-in here |
| **MCP servers** | Tools exposed by an MCP server, consumed via Strands' `McpClient` (`@strands-agents/sdk` → `./mcp.js`) | ⚠️ No block-config hook — you'd bridge it inside a custom tool (as the original "ask my AWS account" version did) |

The upshot: through this block, **every tool you add is a custom `tool()`** — whether
its handler runs pure logic, calls a managed service (like `searchDocs`), or bridges
to an MCP server.

---

## Adding your own tool

Add another entry to the `tools` callback. Example — a safe, read-only tool that
reports how fresh the docs are (illustrative):

```ts
tools: (tool) => ({
  searchDocs: tool({ /* …as above… */ }),

  listSources: tool({
    description: 'List the document sources available to search. Use when the user ' +
      'asks what documents/topics are covered.',
    parameters: z.object({}),
    needsApproval: false,
    handler: async () => {
      const results = await kb.retrieve('overview', { maxResults: 20 });
      return [...new Set(results.map((r) => r.source))]; // unique source names
    },
  }),
}),
```

### Safety rules (this is a public agent)
The app is reachable by anyone with (or leaking) the invite code, so a tool is an
attack surface. Prompt injection can talk the model into calling any tool you expose.

- **Prefer read-only, side-effect-free tools** (another KnowledgeBase, a read lookup,
  a calculation). This is why the exercise ships *only* `searchDocs`.
- **Never expose shell/filesystem/broad-network tools** (`bash`, `file-editor`,
  unrestricted `http-request`) or account-mutating tools on a public agent — this is
  the same reasoning that killed the original AWS-write-access design
  ([wiki §6](./exercise-wiki.md#6-the-rag-pivot--ask-my-handover-docs)).
- **Gate anything with side effects behind `needsApproval: true`** so a human confirms
  before it runs.
- **Scope by caller** with `toolContextSchema` (e.g. pass `userId`) when a tool should
  only touch the caller's own data.

After changing tools, remember the deploy story: `npm run build && npm run deploy`
(and `npm run reindex` if you also changed `knowledge/`).

---

## Key files

| File | What's there |
|---|---|
| `aws-blocks/index.ts:112-128` | The `searchDocs` tool definition |
| `aws-blocks/index.ts:132` | The `tools: (tool) => ({ … })` callback |
| `@aws-blocks/bb-agent/dist/types.d.ts:53-65` | `AgentConfig.tools` (ToolsConfig) |
| `@strands-agents/sdk` → `./mcp.js`, `./vended-tools/*` | MCP client + pre-built tools (SDK layer) |
