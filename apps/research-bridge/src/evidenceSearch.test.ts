import assert from 'node:assert/strict';
import test from 'node:test';

import { EvidenceSearchService } from './evidenceSearch.js';
import type { ResearchIndexDocument } from './schemas.js';

/**
 * CL-C11. The index keeps whatever the last successful sync wrote. When syncs
 * stop -- an export the bridge rejects, an outage, a revoked role -- evidence
 * the app has since withdrawn would stay served for as long as they stay
 * stopped. Every sync rewrites every document's syncedAt, so a document older
 * than the window has not been confirmed by the app recently, and is not served.
 */

const NOW = Date.parse('2026-10-06T12:00:00.000Z');
const HOUR = 3_600_000;

function document(id: string, syncedAt: string | null): ResearchIndexDocument {
  return {
    id,
    kind: 'approved_evidence',
    title: `Title ${id}`,
    content: `Excerpt ${id}`,
    publisher: null,
    sourceType: 'peer_reviewed',
    authorityTier: 1,
    url: null,
    publicationDate: null,
    status: 'approved_verified',
    syncedAt: syncedAt as string,
  };
}

function clientReturning(documents: ResearchIndexDocument[]) {
  const calls: Array<{ select?: string[] }> = [];
  const client = {
    search: async (_query: string, options: { select?: string[] }) => {
      calls.push(options);
      return {
        results: (async function* results() {
          for (const item of documents) {
            yield { document: item, score: 1 };
          }
        })(),
      };
    },
  };
  return { client: client as never, calls };
}

test('evidence synced within the window is served; older evidence is not', async () => {
  const { client, calls } = clientReturning([
    document('fresh', new Date(NOW - 2 * HOUR).toISOString()),
    document('stale', new Date(NOW - 49 * HOUR).toISOString()),
  ]);
  const service = new EvidenceSearchService(client, { maxAgeHours: 48, now: () => NOW });

  const results = await service.search('punch mechanics', 5);

  assert.deepEqual(results.map((item) => item.id), ['fresh']);
  assert.ok(calls[0].select?.includes('syncedAt'), 'syncedAt must be read to judge freshness');
});

test('evidence with no readable sync time is not served', async () => {
  const { client } = clientReturning([
    document('missing', null),
    document('garbled', 'not a date'),
  ]);
  const service = new EvidenceSearchService(client, { maxAgeHours: 48, now: () => NOW });

  assert.deepEqual(await service.search('punch mechanics', 5), []);
});

test('a sync time far in the future is not believed', async () => {
  const { client } = clientReturning([
    document('skewed', new Date(NOW + 5 * 60_000).toISOString()),
    document('future', new Date(NOW + 365 * 24 * HOUR).toISOString()),
  ]);
  const service = new EvidenceSearchService(client, { maxAgeHours: 48, now: () => NOW });

  assert.deepEqual((await service.search('punch mechanics', 5)).map((item) => item.id), ['skewed']);
});

test('the window defaults to 48 hours', async () => {
  const { client } = clientReturning([
    document('inside', new Date(NOW - 47 * HOUR).toISOString()),
    document('outside', new Date(NOW - 49 * HOUR).toISOString()),
  ]);
  const service = new EvidenceSearchService(client, { now: () => NOW });

  assert.deepEqual((await service.search('punch mechanics', 5)).map((item) => item.id), ['inside']);
});
