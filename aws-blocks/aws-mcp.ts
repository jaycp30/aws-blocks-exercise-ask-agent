/**
 * aws-mcp.ts — the bridge from a Blocks tool handler to the AWS API MCP server.
 *
 * Why this exists:
 *   AWS Blocks' Agent block (bb-agent 0.1.x) does NOT expose Strands' native MCP
 *   passthrough, so we cannot hand the agent an MCP server directly. Instead we
 *   follow the idiomatic Blocks pattern: wrap the capability in a normal `tool()`
 *   handler. That handler calls THIS module, which speaks MCP to the
 *   `awslabs.aws-api-mcp-server` and runs a single read-only AWS CLI command.
 *
 * How it runs the server:
 *   We spawn the Python server locally via `uvx` over stdio. The connection is a
 *   lazily-created singleton — the first tool call pays the startup cost, every
 *   call after reuses the same process. READ_OPERATIONS_ONLY=true is the
 *   server-side guardrail (paired with read-only IAM in production).
 *
 * Deploy note:
 *   `uvx` won't exist in a plain Node Lambda. The launch command is overridable
 *   via env (AWS_API_MCP_CMD / _ARGS) so production packaging can swap it without
 *   touching this code. Local-first by design — see understanding.md.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// Default region for every AWS read. Explicit on purpose — never rely on the
// CLI/profile default (a standing rule for this account).
const DEFAULT_REGION = process.env.AWS_REGION ?? 'ap-northeast-1';

// How to launch the MCP server. Defaults to uvx for local dev; overridable so a
// deployed runtime can point at a bundled/containerized server instead.
const SERVER_CMD = process.env.AWS_API_MCP_CMD ?? 'uvx';
const SERVER_ARGS = (process.env.AWS_API_MCP_ARGS ?? 'awslabs.aws-api-mcp-server@latest').split(' ');

let clientPromise: Promise<Client> | null = null;

/** Lazily connect (once) to the AWS API MCP server over stdio. */
function getClient(): Promise<Client> {
  if (clientPromise) return clientPromise;

  clientPromise = (async () => {
    const transport = new StdioClientTransport({
      command: SERVER_CMD,
      args: SERVER_ARGS,
      // Inherit the parent env (AWS creds, PATH for uvx) and force the safety rails.
      env: {
        ...(process.env as Record<string, string>),
        AWS_REGION: DEFAULT_REGION,
        READ_OPERATIONS_ONLY: 'true', // server refuses any mutating CLI verb
      },
    });

    const client = new Client(
      { name: 'aws-ask-agent', version: '0.1.0' },
      { capabilities: {} },
    );
    await client.connect(transport);
    return client;
  })();

  // If the connection fails, clear the cache so a later call can retry cleanly.
  clientPromise.catch(() => { clientPromise = null; });
  return clientPromise;
}

/**
 * Run a single read-only AWS CLI command through the MCP server's `call_aws`.
 *
 * @param command  The CLI command WITHOUT the leading "aws"
 *                 (e.g. "ec2 describe-instances --region ap-northeast-1").
 * @returns        The command's textual output, ready for the model to summarize.
 */
export async function runAwsRead(command: string): Promise<string> {
  // In a deployed Node Lambda there is no Python / uvx to spawn the MCP server.
  // For the "deploy chat first" milestone we degrade gracefully instead of
  // crashing; cloud tool-reach (via the AWS SDK) is the next build step.
  if (process.env.AWS_LAMBDA_FUNCTION_NAME) {
    return 'Live AWS account reads are not enabled in this cloud deployment yet — ' +
      'that is the next build step. (Running locally, this tool reads the account ' +
      'read-only via the AWS API MCP server.)';
  }

  const trimmed = command.trim();
  // `call_aws` requires the full command and rejects anything not starting with
  // "aws". Normalize so the model can pass either form.
  const cli = trimmed.startsWith('aws ') ? trimmed : `aws ${trimmed}`;

  const client = await getClient();
  const result = await client.callTool({
    name: 'call_aws',
    arguments: { cli_command: cli },
  });

  // MCP returns content blocks; concatenate the text parts.
  const text = Array.isArray(result.content)
    ? result.content
        .filter((c: { type: string }) => c.type === 'text')
        .map((c: { text: string }) => c.text)
        .join('\n')
    : '';

  // Surface server-side errors (e.g. a blocked mutating command) as text the
  // agent can read and explain, rather than throwing an opaque failure.
  if (result.isError) {
    return `AWS command failed:\n${text || '(no detail)'}`;
  }
  return text || '(empty result)';
}
