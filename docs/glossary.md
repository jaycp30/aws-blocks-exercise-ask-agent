# Glossary — acronyms & technical terms

Plain-language definitions for the terms that show up while building this exercise
(the "Ask my handover docs" RAG agent on AWS Blocks). Each entry says what the term
means *and* how it's used **here**, so the definitions stay concrete.

Related: [How RAG is implemented in this exercise](./rag-implementation.md) ·
[Exercise Q&A / wiki notes](./exercise-wiki.md)

---

## RAG, ML & retrieval terms

### RAG — Retrieval-Augmented Generation
A pattern where, instead of answering from the model's own memory, you first
**retrieve** relevant passages from your own documents and hand them to the model as
context, so it **generates** an answer grounded in *your* data (and can cite it).
Here it lets the agent answer from handover docs it was never trained on.

### Agentic RAG
RAG where the **LLM decides when to retrieve** by calling a search *tool*, rather
than a fixed "always retrieve, then answer" pipeline. In this app the model is given
a `searchDocs` tool; it chooses to call it, reads the returned passages, and may
search again with a refined query before answering.

### Tool (tool call)
A named function the **model is allowed to invoke** — described to it by name +
description + a parameter schema. Mid-reasoning the model can emit a "call this tool
with these args" request; the agent runtime (Strands) runs the function and feeds the
result back. It's a language-model capability, **not** an AWS resource. Here the one
tool is `searchDocs` (`aws-blocks/index.ts:133`): a plain async handler that calls
`kb.retrieve()`. Note the distinction from **Lambda** — the handler *runs on* the
agent's Lambda in the cloud (and in the local node process during `npm run dev`), but
a "tool" is a function in the agent's code, not a separate Lambda function; one Lambda
hosts the agent and all its tools. Full write-up:
[Agent tools — what they are & how to add them](./agent-tools.md).

### LLM — Large Language Model
The text-generation model that writes the answers. Here the user can pick between
Claude Sonnet 4.6, Amazon Nova Pro, and NVIDIA Nemotron.

### FM — Foundation Model
AWS's umbrella term for the base models served by Bedrock (Claude, Nova, Titan,
etc.). "Foundation model" and "LLM" are used interchangeably for the chat models.

### Embedding
A list of numbers (a **vector**) that represents the *meaning* of a piece of text,
so that texts with similar meaning have nearby vectors. Retrieval works by embedding
the query and finding chunks whose embeddings are closest. Produced here by Titan.

### Titan Text Embeddings V2 — `amazon.titan-embed-text-v2:0`
Amazon's embedding **model** on Bedrock (the "Titan" family is Amazon's own set of
foundation models). It turns each document chunk — and each query — into a
1024-dimension embedding vector. It is *not* a chat model; its only job is
text → vector. Used only on the deployed path (local dev uses TF-IDF instead).

### Vector / dimension
A vector is the embedding's array of numbers; its **dimension** is how many numbers
(1024 here). The vector store's index dimension must match the embedding model's
output, so Titan-V2-at-1024 and the S3 Vectors index are locked together — you can't
swap embedders to a different dimension without rebuilding the index.

### Cosine similarity
The distance metric used to compare vectors: it measures the *angle* between two
vectors (direction of meaning), ignoring their length. The S3 Vectors index is
configured with `distanceMetric: 'cosine'`; retrieval returns the chunks with the
smallest angle to the query.

### ANN — Approximate Nearest Neighbour
The class of algorithms vector stores use to find "closest vectors" fast without
comparing against every single one. It uses a pre-built index to return *almost
certainly* the closest vectors while checking only a fraction of them — trading a
tiny, usually unnoticeable bit of accuracy for a large speed win. It's what makes
similarity search scale.

### top-k
The **k** best-scoring results, where k is just a count. Retrieval scores chunks by
similarity to the query and keeps only the closest few rather than all of them. Here
**k = 5** (the `maxResults ?? 5` default in the `searchDocs` handler), so "top-k
passages" means "the 5 most relevant chunks."

### Cosine ANN search
The retrieval step in one phrase — two ideas combined: use an **ANN** index to
*quickly* find the chunks whose embeddings have the smallest **cosine** angle to the
query's embedding (most similar meaning), and return the [top-k](#top-k) of them.
See [cosine similarity](#cosine-similarity) and [ANN](#ann--approximate-nearest-neighbour).

### Chunking
Splitting source documents into smaller passages before embedding, so retrieval can
return a focused snippet instead of a whole file. Bedrock KB here uses `FIXED_SIZE`
chunks of **300 tokens with 20% overlap** (overlap avoids cutting an answer in half
at a chunk boundary).

### TF-IDF — Term Frequency – Inverse Document Frequency
A classic **pre-ML** ranking method used by the *local* mock. A chunk scores high if
the query's words appear often in it (term frequency), weighted by how *rare* each
word is across all chunks (inverse document frequency) — so "rollback" or "Priya"
count for a lot, "the" or "account" for almost nothing. Pure word counting: free,
instant, no model, but only matches **literal words** (no synonyms). It exists so
local dev needs no Bedrock; the cloud path uses real embeddings instead.

### Token
The unit models read/generate — roughly ¾ of a word. Chunk size (300 tokens) and
embedding pricing are both measured in tokens.

### System prompt
The instruction block that sets the agent's behaviour. Here it enforces RAG
discipline: *search first, answer only from retrieved passages, cite the source, say
"not found" otherwise.*

---

## AWS services

### Amazon Bedrock
AWS's managed service for calling foundation models (Claude, Nova, Titan, …) via one
API. Both the chat models and the Titan embedding model are invoked through Bedrock.

### Bedrock Knowledge Bases
The **managed RAG** feature of Bedrock. You point it at documents in S3; it handles
chunking, embedding (via Titan), writing vectors to a vector store, and answering
`Retrieve` queries. This is what does the heavy lifting here — the app just calls
`kb.retrieve()`.

### S3 — Simple Storage Service
Object storage. Holds the raw source documents from the `knowledge/` folder that
Bedrock ingests.

### S3 Vectors
A **newer, purpose-built vector store** that lives in the S3 family
(`AWS::S3Vectors::*`) — distinct from a normal S3 bucket. A normal bucket stores
*objects* keyed by path and can only fetch by key; S3 Vectors stores **embedding
vectors** and answers **similarity queries** (`QueryVectors`) with metadata
filtering. It's serverless and pay-per-use (no always-on compute). See
[the RAG page](./rag-implementation.md#why-s3-vectors-over-opensearch-serverless)
for why it was chosen over OpenSearch Serverless.

**Don't confuse it with the data source bucket.** Documents live in a *plain S3
bucket* that Bedrock reads from; S3 Vectors only holds the embeddings Bedrock writes.
See [Two buckets — don't confuse them](./rag-implementation.md#two-buckets--dont-confuse-them).

### Bedrock Agent Runtime
The API surface (`@aws-sdk/client-bedrock-agent-runtime`) whose `Retrieve` call the
KnowledgeBase block uses at query time.

### DynamoDB
AWS's serverless NoSQL key-value/document database. The Agent block uses two tables
for conversation + message history.

### API Gateway (WebSocket)
Managed API front door. The WebSocket variant streams the model's tokens to the
browser live (the typewriter effect).

### SQS — Simple Queue Service
Managed message queue. The Agent runs asynchronously off a queue so long answers
aren't cut off by API Gateway's request timeout.

### Lambda
Serverless functions — the compute that runs the backend/agent code without managing
servers.

### IAM — Identity and Access Management
AWS's permissions system. A dedicated IAM role lets Bedrock read the S3 docs, invoke
Titan, and manage the S3 Vectors index — scoped to least privilege.

### SSM — Systems Manager (Parameter Store)
Where the secret invite code lives in production (a SecureString parameter), read at
request time so rotating it needs no redeploy. Locally it's in `.bb-data/settings.json`.

### OpenSearch Serverless
An alternative vector store (an always-on search engine with a vector mode).
Considered but **not** used here — see the [RAG page](./rag-implementation.md#why-s3-vectors-over-opensearch-serverless).

### CloudFront / S3 (hosting)
The deployed React frontend is served as static files from S3 behind the CloudFront
CDN.

---

## AWS Blocks & tooling

### AWS Blocks / `bb-` / Building Block
`bb` = **Building Block**. AWS Blocks is a framework where one constructor call
(e.g. `new KnowledgeBase(...)`, `new Agent(...)`) expands into a pile of AWS
resources *plus* the runtime code that drives them — and runs locally with mocks,
then deploys to the real services unchanged. Every package is `bb-<thing>`.

### CDK — Cloud Development Kit
AWS's infrastructure-as-code tool: define cloud resources in TypeScript, then
`cdk deploy` provisions them via CloudFormation. AWS Blocks generates CDK under the
hood; `npm run deploy` ultimately runs `cdk deploy`.

### Strands (Strands Agents SDK)
The open-source agent framework (`@strands-agents/sdk`, docs at strandsagents.com)
that runs the agent's "brain" — the **agentic loop**: it feeds the model your tools,
detects when the model wants to call one, runs the handler, feeds the result back,
and loops until a final answer; it also manages conversation history, session-state
snapshots, and token streaming. `bb-agent` wraps it. Mental split for this exercise:

- **Strands** = the agent loop (reasoning + tool-calling + history + streaming).
- **`bb-agent` block** = the plumbing that runs Strands on AWS — DynamoDB (history),
  S3/FileBucket (snapshots), SQS + Lambda (async execution), API Gateway WebSocket
  (streaming to the browser).
- **Bedrock** = where the actual model (Sonnet / Nova / Nemotron) runs.

Strands is model-agnostic — the same loop drives Bedrock in the cloud and
Ollama/canned locally (via `model-factory.js`), which is why swapping models "just
works." See also [Tool (tool call)](#tool-tool-call).

### Ollama
A tool to run open LLMs locally. In local dev the agent uses Ollama (`llama3.2:3b`)
if present, else falls back to a canned mock response.

### MCP — Model Context Protocol
A standard for giving models tools/data sources. Used earlier in the exercise (the
AWS API MCP server) before the pivot to RAG; the frontend effects work also used
MCP registries (shadcn/ReactBits).

### Vite
The frontend build tool / dev server for the React app (`npm run dev:client`).

### RAG discipline
Shorthand in this repo for the prompt rules that keep the agent honest: only answer
from retrieved passages, cite sources, and admit when the docs don't contain the
answer.
