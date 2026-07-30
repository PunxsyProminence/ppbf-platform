// Backfill embeddings for SHADOW Library chunks that predate the embedding
// deployment (or whose write-time embedding failed).
//
// Operator-run, explicit-target-only: like the fixture provisioner, this
// script refuses to write to a database nobody named -- set
// PPBF_EXPECTED_POSTGRES_HOSTNAME and PPBF_EXPECTED_POSTGRES_DATABASE to the
// exact target (see lib/postgres-write-target.mjs; the local .env.local
// points at PRODUCTION, which is precisely the accident this guard exists
// to stop). Requires the embedding env (AZURE_AI_ENDPOINT, AZURE_AI_KEY,
// AZURE_AI_EMBEDDING_DEPLOYMENT_NAME); exits without writing when unset.
//
// Idempotent: only rows with a NULL embedding are touched, so re-running
// after a partial failure resumes where it stopped. Each row is committed
// individually -- a mid-run crash loses nothing.

import { Client } from 'pg';

import { assertDeclaredWriteTargetFromEnv } from './lib/postgres-write-target.mjs';

const connectionString = process.env.AZURE_POSTGRES_CONNECTION_STRING || '';
const endpoint = (process.env.AZURE_AI_ENDPOINT || '').trim().replace(/\/+$/, '');
const apiKey = (process.env.AZURE_AI_KEY || '').trim();
const deployment = (process.env.AZURE_AI_EMBEDDING_DEPLOYMENT_NAME || '').trim();
const apiVersion = (process.env.AZURE_AI_EMBEDDING_API_VERSION || process.env.AZURE_AI_API_VERSION || '2024-10-21').trim();
const organizationFilter = (process.env.PPBF_BACKFILL_ORGANIZATION_ID || '').trim();
const BATCH_LIMIT = 500;

function fail(message) {
  console.error(message);
  process.exit(1);
}

if (!connectionString) fail('Missing AZURE_POSTGRES_CONNECTION_STRING');
if (!endpoint || !apiKey) fail('Missing AZURE_AI_ENDPOINT / AZURE_AI_KEY');
if (!deployment) fail('Missing AZURE_AI_EMBEDDING_DEPLOYMENT_NAME -- create the embedding deployment first; nothing to backfill without it.');

assertDeclaredWriteTargetFromEnv(connectionString);

async function embed(text) {
  const response = await fetch(
    `${endpoint}/openai/deployments/${encodeURIComponent(deployment)}/embeddings?api-version=${encodeURIComponent(apiVersion)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'api-key': apiKey },
      body: JSON.stringify({ input: [text.slice(0, 8_000)] }),
    },
  );
  if (!response.ok) {
    throw new Error(`Embedding request failed (${response.status})`);
  }
  const payload = await response.json();
  const embedding = payload?.data?.[0]?.embedding;
  if (!Array.isArray(embedding) || embedding.length === 0) {
    throw new Error('Embedding response malformed');
  }
  return embedding;
}

const client = new Client({ connectionString });
await client.connect();

try {
  const current = await client.query('select current_database() as db');
  console.log(`Backfilling chunk embeddings in database "${current.rows[0].db}" with deployment "${deployment}".`);

  const { rows } = await client.query(
    `select chunk_id, organization_id, text_content
     from pilot.shadow_library_chunks
     where embedding is null
       and ($1 = '' or organization_id = $1)
     order by created_at asc
     limit $2`,
    [organizationFilter, BATCH_LIMIT],
  );

  if (rows.length === 0) {
    console.log('No chunks need embedding. Done.');
  }

  let embedded = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      const embedding = await embed(row.text_content);
      await client.query(
        `update pilot.shadow_library_chunks
         set embedding = $3::jsonb, embedding_model = $4
         where chunk_id = $1 and organization_id = $2 and embedding is null`,
        [row.chunk_id, row.organization_id, JSON.stringify(embedding), deployment],
      );
      embedded += 1;
    } catch (error) {
      failed += 1;
      console.error(`Chunk ${row.chunk_id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  console.log(`Embedded ${embedded} chunk(s); ${failed} failure(s); re-run to resume if any remain.`);
  if (failed > 0) process.exitCode = 1;
} finally {
  await client.end();
}
