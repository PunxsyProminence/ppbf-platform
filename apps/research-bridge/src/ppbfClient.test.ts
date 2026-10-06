import assert from 'node:assert/strict';
import test from 'node:test';

import type { BridgeConfig } from './config.js';
import { PpbfResearchClient } from './ppbfClient.js';

/**
 * CL-C11. The export used to be parsed whole: one research need past the
 * bridge's limits, or one evidence URL over 2,000 characters, failed the parse,
 * the sync job failed, and its delete step never ran -- so evidence the app had
 * withdrawn for retraction stayed in the index. One bad item now costs only
 * that item.
 */

const config: BridgeConfig = {
  port: 3000,
  stagingAppOrigin: 'https://staging.example.test',
  mcpAudience: 'api://research-bridge',
  searchEndpoint: 'https://search.example.test',
  searchIndexName: 'research',
  storageAccountUrl: 'https://storage.example.test',
  researchContainerName: 'research-needs',
  evidenceContainerName: 'evidence-drafts',
  indexBootstrapMode: false,
  requirePlatformAuth: true,
  allowedHosts: ['localhost'],
};

const credential = { getToken: async () => ({ token: 't', expiresOnTimestamp: 0 }) };

function need(index: number) {
  return {
    id: `need_${String(index).padStart(32, '0')}`,
    title: `Close SHADOW Library coverage gap for capability cap_${index}`,
    knowledge_gap: 'No qualifying sources.',
    evidence_status: 'missing',
    confidence_tier: 'INSUFFICIENT',
    verification_state: 'unknown',
    status: 'open',
    created_at: '2026-10-01T00:00:00.000Z',
  };
}

function evidence(id: string, url: string | null) {
  return {
    id: `evidence_${id.padStart(32, '0')}`,
    title: `Source ${id}`,
    publisher: null,
    source_type: 'peer_reviewed',
    authority_tier: 1,
    url,
    publication_date: null,
    excerpt: 'Open-licence excerpt.',
  };
}

function clientFor(body: unknown) {
  const request = (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;
  return new PpbfResearchClient(config, credential as never, request);
}

function envelope(overrides: Record<string, unknown>) {
  return {
    schema_version: '1',
    classification: 'sanitized-staging-only',
    generated_at: '2026-10-06T00:00:00.000Z',
    research_needs: [],
    approved_evidence: [],
    ...overrides,
  };
}

test('one evidence URL over 2,000 characters drops that item, not the export', async () => {
  const snapshot = await clientFor(envelope({
    approved_evidence: [
      evidence('1', 'https://example.org/ok'),
      evidence('2', `https://example.org/${'a'.repeat(2_100)}`),
    ],
  })).fetchExport();

  assert.deepEqual(snapshot.approved_evidence.map((item) => item.id), [evidence('1', null).id]);
});

test('more than 500 research needs keeps the first 500, not none', async () => {
  const snapshot = await clientFor(envelope({
    research_needs: Array.from({ length: 501 }, (_unused, index) => need(index)),
    approved_evidence: [evidence('1', null)],
  })).fetchExport();

  assert.equal(snapshot.research_needs.length, 500);
  assert.equal(snapshot.approved_evidence.length, 1);
});

test('an envelope that is not a PPBF export is still refused whole', async () => {
  await assert.rejects(clientFor(envelope({ classification: 'public' })).fetchExport());
  await assert.rejects(clientFor(envelope({ approved_evidence: 'nope' })).fetchExport());
});
