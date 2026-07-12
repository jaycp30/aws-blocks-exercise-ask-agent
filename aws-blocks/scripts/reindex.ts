// Re-index the Bedrock Knowledge Base after you change files in ./knowledge.
//
// Why this exists: `npm run deploy` re-uploads the docs to S3 but does NOT re-run
// ingestion — the ingestion trigger uses a stable physical id, so CloudFormation
// only fires it when the KB/data-source *definition* changes, not when document
// *contents* change. Until an ingestion job runs, retrieval keeps serving the old
// index. This script finds the KB + its data source and fires StartIngestionJob,
// then polls until the job finishes.
//
// Usage:
//   npm run reindex                    auto-detect the KB, wait for completion
//   npm run reindex -- --kb-id KB_ID   target a specific knowledge base id
//   npm run reindex -- --name docs     disambiguate by name substring
//   npm run reindex -- --no-wait       fire the job and exit without polling
//
// Region defaults to ap-northeast-1 (Tokyo); override with AWS_REGION. Credentials
// come from your usual AWS profile/env — confirm the account before running.

import {
  BedrockAgentClient,
  ListKnowledgeBasesCommand,
  ListDataSourcesCommand,
  StartIngestionJobCommand,
  GetIngestionJobCommand,
} from '@aws-sdk/client-bedrock-agent';

const REGION = process.env.AWS_REGION ?? 'ap-northeast-1';

// The ingestion-job statuses that mean "done" (success or failure).
const TERMINAL_STATUSES = new Set(['COMPLETE', 'FAILED']);
// Bounded polling so the script can't hang forever on a stalled job.
const POLL_INTERVAL_MS = 10_000;
const MAX_POLLS = 60; // ~10 minutes

const client = new BedrockAgentClient({ region: REGION });

/** Read the value after a `--flag` on the command line, if present. */
function getFlag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

const hasFlag = (name: string): boolean => process.argv.includes(`--${name}`);

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** List every knowledge base in the account/region, following pagination. */
async function listAllKnowledgeBases(): Promise<{ id: string; name: string }[]> {
  const found: { id: string; name: string }[] = [];
  let nextToken: string | undefined;
  do {
    const res = await client.send(new ListKnowledgeBasesCommand({ maxResults: 100, nextToken }));
    for (const kb of res.knowledgeBaseSummaries ?? []) {
      if (kb.knowledgeBaseId && kb.name) found.push({ id: kb.knowledgeBaseId, name: kb.name });
    }
    nextToken = res.nextToken;
  } while (nextToken);
  return found;
}

/** Decide which KB to target: explicit --kb-id wins, then --name filter, else the only one. */
async function resolveKnowledgeBaseId(): Promise<string> {
  const explicit = getFlag('kb-id');
  if (explicit) return explicit;

  const all = await listAllKnowledgeBases();
  if (all.length === 0) {
    throw new Error(`No knowledge bases found in ${REGION}. Deploy first, or check AWS_REGION / credentials.`);
  }

  const nameFilter = getFlag('name');
  const candidates = nameFilter ? all.filter((kb) => kb.name.includes(nameFilter)) : all;

  if (candidates.length === 1) return candidates[0].id;

  const list = candidates.map((kb) => `  - ${kb.name} (${kb.id})`).join('\n');
  throw new Error(
    `Ambiguous knowledge base (${candidates.length} found). Re-run with --kb-id <id> or --name <substr>:\n${list}`,
  );
}

async function main(): Promise<void> {
  console.log(`🌏 Region: ${REGION}`);

  const knowledgeBaseId = await resolveKnowledgeBaseId();

  // A KnowledgeBase block provisions exactly one data source — grab it.
  const dsRes = await client.send(new ListDataSourcesCommand({ knowledgeBaseId }));
  const dataSourceId = dsRes.dataSourceSummaries?.[0]?.dataSourceId;
  if (!dataSourceId) {
    throw new Error(`No data source found for knowledge base ${knowledgeBaseId}.`);
  }
  console.log(`📚 Knowledge base: ${knowledgeBaseId}`);
  console.log(`📎 Data source:    ${dataSourceId}`);

  const start = await client.send(new StartIngestionJobCommand({ knowledgeBaseId, dataSourceId }));
  const ingestionJobId = start.ingestionJob?.ingestionJobId;
  console.log(`🚀 Started ingestion job ${ingestionJobId} (status: ${start.ingestionJob?.status})`);

  if (hasFlag('no-wait')) {
    console.log('   --no-wait set; not polling. Check status in the Bedrock console.');
    return;
  }

  for (let poll = 0; poll < MAX_POLLS; poll++) {
    await sleep(POLL_INTERVAL_MS);
    const jobRes = await client.send(
      new GetIngestionJobCommand({ knowledgeBaseId, dataSourceId, ingestionJobId }),
    );
    const status = jobRes.ingestionJob?.status ?? 'UNKNOWN';
    const scanned = jobRes.ingestionJob?.statistics?.numberOfDocumentsScanned;
    console.log(`   … ${status}${scanned !== undefined ? ` (scanned ${scanned} docs)` : ''}`);

    if (TERMINAL_STATUSES.has(status)) {
      if (status === 'COMPLETE') {
        console.log('✅ Ingestion complete. Embeddings may take a short extra moment to become queryable.');
        return;
      }
      const reasons = jobRes.ingestionJob?.failureReasons?.join('; ') ?? '(no reason given)';
      console.error(`❌ Ingestion FAILED: ${reasons}`);
      process.exit(1);
    }
  }

  console.log('⏳ Still running after the poll window. Check the Bedrock console for the final status.');
}

main().catch((err) => {
  console.error('reindex failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
