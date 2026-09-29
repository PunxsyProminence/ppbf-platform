import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { parse } from 'csv-parse/sync';

// seed-data/shadow-research/2026-08-07/repairs/ holds the plan the owner-gated
// production repair tool applies to the platform baseline, which production
// imported and approved BEFORE the seed was repaired. The seed CSVs hold the
// target values; the logs say which rows move where. If the two ever
// disagree, production gets repaired to something the seed does not say --
// so every logged action must be visibly true of the committed seed, and
// every repair the seed carries must be in a log. Source-level, fast suite.

const PACKAGE = path.resolve(__dirname, '../../../seed-data/shadow-research/2026-08-07');
const REPAIRS = path.join(PACKAGE, 'repairs');
const LOG_0928 = path.join(REPAIRS, '2026-09-28_repair_log.csv');
const LOG_0929 = path.join(REPAIRS, '2026-09-29_followup_log.csv');

// sha256 of the lane's research_batch_repair_log.csv, header plus its first
// 243 rows (line 245, the reverted AAP merge, dropped), CRLF line endings.
// "Use the repair log as the pinned plan exactly as you validated it."
const VALIDATED_0928_PREFIX_SHA256 = '6e3c3a5c963286173b10f2e3c127ce77cb6ae8349c05f81a1689edb95b765de7';

type Row = Record<string, string>;

function readCsv(file: string): Row[] {
  return parse(fs.readFileSync(file, 'utf8'), { bom: true, columns: true, skip_empty_lines: true });
}
function list(value: string): string[] {
  return value ? value.split('|') : [];
}

const sources = new Map(readCsv(path.join(PACKAGE, 'seed_shadow_library_sources.csv')).map((row) => [row.source_id, {
  tier: Number(row.authority_tier),
  metadata: JSON.parse(row.metadata || '{}'),
}]));
const chunks = new Map(readCsv(path.join(PACKAGE, 'seed_shadow_library_chunks.csv')).map((row) => [row.chunk_id, {
  sourceId: row.source_id,
  metadata: JSON.parse(row.metadata || '{}'),
}]));
const log0928 = readCsv(LOG_0928);
const log0929 = readCsv(LOG_0929);
const allRows = [...log0928, ...log0929];

// A chunk merged onto a row that a later log merges again ends on the last target.
const mergedTo = new Map(allRows.filter((r) => r.action === 'MERGE_DUPLICATE').map((r) => [r.source_id, r.target_source_id]));
function finalTarget(sourceId: string): string {
  let current = sourceId;
  while (mergedTo.has(current)) current = mergedTo.get(current)!;
  return current;
}

describe('the committed repair logs are the plan that was validated', () => {
  it('2026-09-28 is the lane log byte for byte, less line 245, plus a trailing chunk_id column', () => {
    const text = fs.readFileSync(LOG_0928, 'utf8').replace(/\r?\n/g, '\r\n');
    const lines = text.split('\r\n');
    expect(lines.pop()).toBe('');
    expect(lines[0].endsWith(',chunk_id')).toBe(true);
    const withoutChunkId = `${lines.map((line) => line.slice(0, line.lastIndexOf(','))).join('\r\n')}\r\n`;
    expect(createHash('sha256').update(withoutChunkId, 'utf8').digest('hex')).toBe(VALIDATED_0928_PREFIX_SHA256);
    expect(log0928).toHaveLength(243);
    expect(log0928.some((r) => r.source_id === 'src_6dd70cf8a54ca4c8')).toBe(false);
  });

  it('uses only the actions the production tool knows', () => {
    expect([...new Set(log0928.map((r) => r.action))].sort())
      .toEqual(['DELETE_DEAD_BOGUS_SOURCE', 'MERGE_DUPLICATE', 'REPOINT_MISRESOLVED']);
    expect([...new Set(log0929.map((r) => r.action))].sort())
      .toEqual(['CLEAR_MISRESOLVED_VERIFIED_TITLE', 'DELETE_DEAD_BOGUS_SOURCE', 'MERGE_DUPLICATE', 'SET_TIER_BY_SPEC']);
  });
});

describe('every logged action is true of the committed seed', () => {
  it('every retired source is gone from the seed', () => {
    const retired = allRows
      .filter((r) => r.action === 'MERGE_DUPLICATE' || r.action === 'DELETE_DEAD_BOGUS_SOURCE')
      .map((r) => r.source_id);
    expect(retired.length).toBe(88 + 84 + 4 + 37);
    expect(retired.filter((id) => sources.has(id))).toEqual([]);
  });

  it('every repointed claim sits on its target, and is the chunk the log names', () => {
    const wrong: string[] = [];
    for (const r of log0928.filter((row) => row.action === 'REPOINT_MISRESOLVED')) {
      const [chunkId, ...extra] = list(r.chunk_id);
      const chunk = chunks.get(chunkId);
      if (extra.length || !chunk || chunk.metadata.claim_id !== r.claim_id || chunk.sourceId !== finalTarget(r.target_source_id)) {
        wrong.push(`${r.claim_id} ${r.chunk_id}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it('every merged chunk sits on its (final) target, and the target records the merge', () => {
    const wrong: string[] = [];
    for (const r of allRows.filter((row) => row.action === 'MERGE_DUPLICATE')) {
      const target = finalTarget(r.target_source_id);
      if (!sources.has(target)) wrong.push(`${r.source_id}: target ${target} missing`);
      if (!(sources.get(r.target_source_id)?.metadata.merged_duplicate_source_ids ?? []).includes(r.source_id)) {
        wrong.push(`${r.source_id}: not in ${r.target_source_id}.merged_duplicate_source_ids`);
      }
      for (const chunkId of list(r.chunk_id)) {
        if (chunks.get(chunkId)?.sourceId !== target) wrong.push(`${r.source_id}: ${chunkId} not on ${target}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it('every tier set by the spec is on the source row and on every chunk of it, and the log lists them all', () => {
    const wrong: string[] = [];
    for (const r of log0929.filter((row) => row.action === 'SET_TIER_BY_SPEC')) {
      const tier = Number(r.tier_to);
      if (sources.get(r.source_id)?.tier !== tier) wrong.push(`${r.source_id}: source row is not ${tier}`);
      const onSource = [...chunks].filter(([, c]) => c.sourceId === r.source_id).map(([id]) => id).sort();
      if (JSON.stringify(onSource) !== JSON.stringify(list(r.chunk_id).sort())) wrong.push(`${r.source_id}: chunk list`);
      for (const chunkId of onSource) {
        if (chunks.get(chunkId)!.metadata.authority_tier !== tier) wrong.push(`${chunkId}: chunk metadata is not ${tier}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it('every cleared verified_title is cleared in the seed exactly as logged', () => {
    const wrong: string[] = [];
    for (const r of log0929.filter((row) => row.action === 'CLEAR_MISRESOLVED_VERIFIED_TITLE')) {
      const metadata = sources.get(r.source_id)?.metadata;
      if (!metadata
        || 'verified_title' in metadata
        || metadata.misresolved_verified_title !== r.verified_title_from
        || metadata.verification_status !== 'MISRESOLVED') {
        wrong.push(r.source_id);
      }
    }
    expect(wrong).toEqual([]);
  });
});

describe('every repair the seed carries is in a log', () => {
  it('every source whose tier the ruling set has a SET_TIER_BY_SPEC row', () => {
    const logged = new Set(log0929.filter((r) => r.action === 'SET_TIER_BY_SPEC').map((r) => r.source_id));
    const unlogged = [...sources].filter(([id, s]) => s.metadata.tier_conflict && !logged.has(id)).map(([id]) => id);
    expect(unlogged).toEqual([]);
  });

  it('every MISRESOLVED source has a CLEAR_MISRESOLVED_VERIFIED_TITLE row', () => {
    const logged = new Set(log0929.filter((r) => r.action === 'CLEAR_MISRESOLVED_VERIFIED_TITLE').map((r) => r.source_id));
    const unlogged = [...sources]
      .filter(([id, s]) => s.metadata.verification_status === 'MISRESOLVED' && !logged.has(id))
      .map(([id]) => id);
    expect(unlogged).toEqual([]);
  });
});
