/**
 * smoke-mcp.ts — prove the MCP → AWS read path end to end, without the model.
 *
 * Runs a couple of harmless read-only commands through the same `runAwsRead`
 * the agent's tool uses. This isolates the riskiest piece (MCP server spawn +
 * call_aws against Tokyo) from the LLM, and costs nothing but the AWS read calls.
 *
 *   npx tsx aws-blocks/scripts/smoke-mcp.ts
 */
import { runAwsRead } from '../aws-mcp.js';

async function main(): Promise<void> {
  const checks: string[] = [
    'sts get-caller-identity --region ap-northeast-1',
    's3api list-buckets --region ap-northeast-1',
  ];

  for (const cmd of checks) {
    console.info(`\n$ aws ${cmd}`);
    const out = await runAwsRead(cmd);
    console.info(out.slice(0, 800));
  }

  // Prove the read-only guard: a mutating command must be refused by the server.
  console.info('\n$ aws s3api create-bucket ... (expect REFUSED by READ_OPERATIONS_ONLY)');
  const blocked = await runAwsRead('s3api create-bucket --bucket should-never-be-created-xyz');
  console.info(blocked.slice(0, 800));

  process.exit(0);
}

main().catch((err: unknown) => {
  console.error('smoke-mcp failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
