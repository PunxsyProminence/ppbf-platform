import assert from 'node:assert/strict';
import test from 'node:test';

import { ensureResearchIndex, synchronizeResearchIndex, toIndexDocuments } from './syncCore.js';
import type { BridgeConfig } from './config.js';
import type { ResearchExport, ResearchIndexDocument } from './schemas.js';

function makeSnapshot(): ResearchExport {
  return {
    schema_version: '1',
    classification: 'sanitized-staging-only',
    generated_at: '2026-08-06T20:00:00.000Z',
    research_needs: [{
      id: 'need_0123456789abcdef',
      title: 'Study adaptive stance cues',
      knowledge_gap: 'Evidence is incomplete.',
      evidence_status: 'missing',
      confidence_tier: 'INSUFFICIENT',
      verification_state: 'unknown',
      status: 'open',
      created_at: '2026-08-06T19:00:00.000Z',
    }],
    approved_evidence: [],
  };
}

function makeConfig(indexBootstrapMode: boolean): BridgeConfig {
  return {
    port: 3000,
    stagingAppOrigin: 'https://staging.example.org',
    mcpAudience: 'api://example',
    searchEndpoint: 'https://srch.search.windows.net',
    searchIndexName: 'ppbf-research-evidence-v1',
    storageAccountUrl: 'https://example.blob.core.windows.net',
    researchContainerName: 'research',
    evidenceContainerName: 'evidence',
    indexBootstrapMode,
    requirePlatformAuth: true,
    allowedHosts: ['localhost'],
  };
}

type SyncInput = Parameters<typeof synchronizeResearchIndex>[0];

function makeHarness(indexBootstrapMode: boolean) {
  const stages: string[] = [];
  let createIndexCalls = 0;
  const containerClient = {
    getBlockBlobClient: () => ({ uploadData: async () => undefined }),
  };
  const input = {
    config: makeConfig(indexBootstrapMode),
    snapshot: makeSnapshot(),
    searchIndexClient: {
      createOrUpdateIndex: async () => { createIndexCalls += 1; },
    },
    searchClient: {
      mergeOrUploadDocuments: async () => undefined,
      search: async () => ({ results: [] as never[] }),
      deleteDocuments: async () => undefined,
    },
    blobServiceClient: { getContainerClient: () => containerClient },
    onStage: (stage: string) => { stages.push(stage); },
  } as unknown as SyncInput;

  return { stages, input, calls: () => createIndexCalls };
}

test('the sync path never touches the index definition', async () => {
  // Search Index Data Contributor cannot modify object definitions, so the
  // scheduled job must never call createOrUpdateIndex -- it would 403.
  const harness = makeHarness(false);
  await synchronizeResearchIndex(harness.input);

  assert.equal(harness.calls(), 0);
  assert.equal(harness.stages.includes('research.search-create-index'), false);
});

test('ensureResearchIndex manages the definition and reads no documents', async () => {
  const harness = makeHarness(true);
  await ensureResearchIndex({
    config: makeConfig(true),
    searchIndexClient: harness.input.searchIndexClient,
    onStage: (stage) => { harness.stages.push(stage); },
  });

  assert.equal(harness.calls(), 1);
  assert.deepEqual(harness.stages, ['research.search-create-index']);
});

test('document building reports its own stage', async () => {
  const harness = makeHarness(false);
  await synchronizeResearchIndex(harness.input);

  // A failure while transforming the export must not be attributed to Search.
  const buildAt = harness.stages.indexOf('research.build-documents');
  assert.ok(buildAt >= 0, 'build-documents stage must be reported');
  assert.ok(buildAt < harness.stages.indexOf('research.search-write-documents'));
});

test('indexes only the explicit sanitized export fields', () => {
  const snapshot: ResearchExport = {
    schema_version: '1',
    classification: 'sanitized-staging-only',
    generated_at: '2026-08-06T20:00:00.000Z',
    research_needs: [{
      id: 'need_0123456789abcdef',
      title: 'Study adaptive stance cues',
      knowledge_gap: 'Evidence is incomplete.',
      evidence_status: 'missing',
      confidence_tier: 'INSUFFICIENT',
      verification_state: 'unknown',
      status: 'open',
      created_at: '2026-08-06T19:00:00.000Z',
    }],
    approved_evidence: [{
      id: 'evidence_0123456789ab',
      title: 'Adaptive boxing review',
      publisher: 'Example Journal',
      source_type: 'peer_reviewed',
      authority_tier: 1,
      url: 'https://example.org/review',
      publication_date: '2026-01-01',
      excerpt: 'Reviewed evidence excerpt.',
    }],
  };

  const documents = toIndexDocuments(snapshot);
  assert.equal(documents.length, 2);
  assert.deepEqual(Object.keys(documents[0]).sort(), [
    'authorityTier', 'content', 'id', 'kind', 'publicationDate', 'publisher', 'sourceType', 'status', 'syncedAt', 'title', 'url',
  ]);
  assert.equal(documents[0].kind, 'research_need');
  assert.equal(documents[1].kind, 'approved_evidence');
  assert.equal(documents[1].publisher, 'Example Journal');
});
