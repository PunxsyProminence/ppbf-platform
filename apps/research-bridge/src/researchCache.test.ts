import assert from 'node:assert/strict';
import test from 'node:test';

import { CachedResearchSource } from './researchCache.js';
import type { ResearchExport } from './schemas.js';

/**
 * CL-C22. Every MCP tool call fetched the whole staging export again -- one
 * full export query per list or lookup. The MCP server now reads through a
 * short-lived cache; the sync job keeps its own fresh fetch.
 */

function snapshot(label: string): ResearchExport {
  return {
    schema_version: '1',
    classification: 'sanitized-staging-only',
    generated_at: label,
    research_needs: [],
    approved_evidence: [],
  } as ResearchExport;
}

function countingSource(results: Array<ResearchExport | Error>) {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    fetchExport: async () => {
      const next = results[Math.min(calls, results.length - 1)];
      calls += 1;
      if (next instanceof Error) {
        throw next;
      }
      return next;
    },
  };
}

test('calls inside the TTL share one fetch', async () => {
  let now = 1_000;
  const upstream = countingSource([snapshot('a')]);
  const cache = new CachedResearchSource(upstream, { ttlMs: 60_000, now: () => now });

  assert.equal((await cache.fetchExport()).generated_at, 'a');
  now += 59_999;
  assert.equal((await cache.fetchExport()).generated_at, 'a');
  assert.equal(upstream.calls, 1);
});

test('concurrent calls wait on the one fetch in flight', async () => {
  const upstream = countingSource([snapshot('a')]);
  const cache = new CachedResearchSource(upstream, { ttlMs: 60_000, now: () => 0 });

  const results = await Promise.all([cache.fetchExport(), cache.fetchExport(), cache.fetchExport()]);

  assert.deepEqual(results.map((item) => item.generated_at), ['a', 'a', 'a']);
  assert.equal(upstream.calls, 1);
});

test('after the TTL the export is fetched again', async () => {
  let now = 0;
  const upstream = countingSource([snapshot('a'), snapshot('b')]);
  const cache = new CachedResearchSource(upstream, { ttlMs: 60_000, now: () => now });

  await cache.fetchExport();
  now += 60_000;
  assert.equal((await cache.fetchExport()).generated_at, 'b');
  assert.equal(upstream.calls, 2);
});

test('a failed fetch is not cached: the next call tries again', async () => {
  const upstream = countingSource([new Error('StagingExportHttp503'), snapshot('b')]);
  const cache = new CachedResearchSource(upstream, { ttlMs: 60_000, now: () => 0 });

  await assert.rejects(cache.fetchExport(), /StagingExportHttp503/);
  assert.equal((await cache.fetchExport()).generated_at, 'b');
  assert.equal(upstream.calls, 2);
});
