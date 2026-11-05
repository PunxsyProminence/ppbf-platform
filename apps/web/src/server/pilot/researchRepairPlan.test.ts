import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { parse } from 'csv-parse/sync';

// The production repair tool (scripts/pilot-repair-research-baseline.mjs)
// builds its plan from three committed things: the repair logs say WHICH rows,
// the seed says what each row ends as, and repairs/pre_repair_values.csv says
// what each changed field holds before. If they disagree, production is
// repaired to something nobody reviewed, or the tool calls a correct
// production DRIFTED and nothing can run. Fast suite, no database.
//
// Three things are held here:
//   1. the plan the tool builds from the committed files -- the counts a
//      production dry run must report as pending, pinned;
//   2. the files agree with each other the way the owner's rulings need:
//      every retired id is gone from the seed, every SET_TIER_BY_SPEC tier is
//      the seed's, every repointed chunk's target is a live row of the seed;
//   3. pre_repair_values.csv IS the seed production imported (commit
//      95f3c79e, the last seed before #1008), and every difference between that
//      seed and today's is in the plan, the corrected chunk texts included
//      (2026-11-05_text_correction_log.csv).
// Uses git history for 3 (ci.yml checks out with fetch-depth: 0).

const WEB_DIR = path.resolve(__dirname, '../../..');
const REPO_ROOT = path.resolve(WEB_DIR, '../..');
const TOOL_URL = pathToFileURL(path.join(WEB_DIR, 'scripts/pilot-repair-research-baseline.mjs')).href;
const IMPORTER_URL = pathToFileURL(path.join(WEB_DIR, 'scripts/import-shadow-research.mjs')).href;
const SEED_PATH = 'apps/web/seed-data/shadow-research/2026-08-07';
// The seed production imported: the last commit to touch it before #1008.
const IMPORTED_SEED_COMMIT = '95f3c79e';
// The chunk texts the seed corrected after the import, by organization:
// - chk_f4cf693a55fe0315 (A7-054): the "Source:" line named the ISSN 2025
//   stand's first author as Jagim AR; PubMed 40059405 lists Ricci AA first and
//   no Jagim among its 18 authors (#1887).
// - chk_3ca9344108b270a1 (A5-132): the "Source:" line dated Zubac et al. 2016
//   (online-first year); PubMed 27173991 gives J Sports Sci 2017;35(8):719-726
//   (#1887).
// - chk_39fac3160bf60743, chk_473c8284ef33ff26: #1003 corrected two sentences.
//   PPBF house documents, on the gym's policy shelf since 2026-10-17.
const TEXT_CORRECTIONS: Record<string, string> = {
  chk_f4cf693a55fe0315: '__platform__',
  chk_3ca9344108b270a1: '__platform__',
  chk_39fac3160bf60743: 'punxsy_prominence',
  chk_473c8284ef33ff26: 'punxsy_prominence',
};

type Field = { field: string; before: string | null; after: string | null };
type Plan = {
  sources: Array<{ source_id: string; retire: boolean; fields: Field[] }>;
  chunks: Array<{ chunk_id: string; organization_id: string; fields: Field[] }>;
  retireIds: string[];
  liveSources: string[];
  textChunkIds: string[];
  expected: Record<string, { fields: number; sources: number; chunks: number }>;
  managedKeys: string[];
  seedSources: Array<Record<string, unknown> & { source_id: string; status: string; metadata: Record<string, unknown> }>;
  seedChunks: Array<Record<string, unknown> & { chunk_id: string; source_id: string }>;
  policySeedChunks: Array<{ chunk_id: string; metadata: Record<string, unknown> }>;
  logs: Array<{ name: string; rows: Array<Record<string, string>> }>;
};

/** The tool's own plan, plus the platform seed it was built from, via a real node process. */
function loadPlan(): Plan {
  const script = `
    import fs from 'node:fs';
    import path from 'node:path';
    import { parse } from 'csv-parse/sync';
    import * as tool from ${JSON.stringify(TOOL_URL)};
    import { loadSeedPackage, DEFAULT_SEED_DIR } from ${JSON.stringify(IMPORTER_URL)};
    const plan = await tool.loadRepairPlan();
    const seed = await loadSeedPackage({ organizationId: '__platform__', accountId: 'x', scope: 'platform_baseline' });
    const policy = await loadSeedPackage({ organizationId: 'punxsy_prominence', accountId: 'x', scope: 'ppbf_policy' });
    const logs = tool.REPAIR_LOG_FILES.map((name) => ({ name, rows: parse(fs.readFileSync(path.join(tool.DEFAULT_REPAIR_DIR, name), 'utf8'), { bom: true, columns: true }) }));
    process.stdout.write(JSON.stringify({
      ...plan,
      managedKeys: tool.MANAGED_METADATA_KEYS,
      seedSources: seed.sources.map(({ source_id, status, authority_tier, metadata }) => ({ source_id, status, authority_tier, metadata })),
      seedChunks: seed.chunks.map(({ chunk_id, source_id }) => ({ chunk_id, source_id })),
      policySeedChunks: policy.chunks.map(({ chunk_id, metadata }) => ({ chunk_id, metadata })),
      logs,
    }));
  `;
  return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: WEB_DIR, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  }));
}

function gitShow(file: string): Array<Record<string, string>> {
  const text = execFileSync('git', ['show', `${IMPORTED_SEED_COMMIT}:${SEED_PATH}/${file}`], {
    cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
  return parse(text, { bom: true, columns: true });
}

function readCurrent(file: string): Array<Record<string, string>> {
  return parse(fs.readFileSync(path.join(REPO_ROOT, SEED_PATH, file), 'utf8'), { bom: true, columns: true });
}

let plan: Plan;
beforeAll(() => {
  plan = loadPlan();
});

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((k) => `${JSON.stringify(k)}:${canonical(object[k])}`).join(',')}}`;
}

describe('the plan the tool builds from the committed files', () => {
  it('pins what a production dry run must report pending', () => {
    // A production dry run whose pending counts differ from these is not the
    // state these files describe: stop (docs/SHADOW_RESEARCH_IMPORT_RUNBOOK.md).
    expect(plan.expected).toEqual({
      repoint: { fields: 221, sources: 0, chunks: 221 },
      retire: { fields: 213, sources: 213, chunks: 0 },
      retier: { fields: 65, sources: 11, chunks: 32 },
      metadata: { fields: 706, sources: 224, chunks: 71 },
      text: { fields: 4, sources: 0, chunks: 4 },
    });
    expect(plan.sources).toHaveLength(437);
    // 247 listed by the 2026-09-28/29 logs, plus the two gym-shelf chunks only
    // the text log names.
    expect(plan.chunks).toHaveLength(249);
    expect(plan.retireIds).toHaveLength(213);
  });

  it('corrects exactly the four texts, each in the organization it lives in, and its claim is the one the log names', () => {
    const textLog = plan.logs.find((l) => l.name === '2026-11-05_text_correction_log.csv')!;
    expect(Object.fromEntries(textLog.rows.map((r) => [r.chunk_id, r.organization_id]))).toEqual(TEXT_CORRECTIONS);
    const corrected = plan.chunks.filter((c) => c.fields.some((f) => f.field === 'text_content'));
    expect(Object.fromEntries(corrected.map((c) => [c.chunk_id, c.organization_id]))).toEqual(TEXT_CORRECTIONS);
    expect(plan.textChunkIds).toEqual(Object.keys(TEXT_CORRECTIONS).sort());
    // The gym rows are in the ppbf_policy scope and the platform rows are not.
    const policyIds = new Set(plan.policySeedChunks.map((c) => c.chunk_id));
    for (const [id, organization] of Object.entries(TEXT_CORRECTIONS)) {
      expect([id, policyIds.has(id)]).toEqual([id, organization === 'punxsy_prominence']);
    }
    // A mistyped id would correct some other claim's text.
    const claimOf = new Map(readCurrent('seed_shadow_library_chunks.csv')
      .map((c) => [c.chunk_id, (JSON.parse(c.metadata || '{}') as Record<string, unknown>).claim_id]));
    for (const row of textLog.rows) {
      expect([row.chunk_id, row.claim_id]).toEqual([row.chunk_id, claimOf.get(row.chunk_id)]);
    }
  });

  it('retires exactly the MERGE_DUPLICATE and DELETE_DEAD_BOGUS_SOURCE rows of both logs, as archived', () => {
    const logged = plan.logs.flatMap((l) => l.rows)
      .filter((r) => r.action === 'MERGE_DUPLICATE' || r.action === 'DELETE_DEAD_BOGUS_SOURCE')
      .map((r) => r.source_id).sort();
    expect(plan.retireIds).toEqual(logged);
    for (const s of plan.sources.filter((x) => x.retire)) {
      expect(s.fields).toEqual([{ field: 'status', before: '"active"', after: '"archived"' }]);
    }
  });
});

describe('the committed logs and seed agree', () => {
  it('every retired id is absent from the seed', () => {
    const seedIds = new Set(plan.seedSources.map((s) => s.source_id));
    expect(plan.retireIds.filter((id) => seedIds.has(id))).toEqual([]);
  });

  it('every SET_TIER_BY_SPEC tier is the seed tier, on the source row and every chunk of it', () => {
    const seedSources = new Map(plan.seedSources.map((s) => [s.source_id, s]));
    const wrong: string[] = [];
    for (const row of plan.logs.flatMap((l) => l.rows).filter((r) => r.action === 'SET_TIER_BY_SPEC')) {
      const planned = plan.sources.find((s) => s.source_id === row.source_id)!;
      if (planned.fields.find((f) => f.field === 'authority_tier')!.after !== row.tier_to) wrong.push(`${row.source_id} plan`);
      if (String(seedSources.get(row.source_id)?.authority_tier) !== row.tier_to) wrong.push(`${row.source_id} seed`);
      for (const chunk of plan.chunks.filter((c) => c.fields.find((f) => f.field === 'source_id')?.after === JSON.stringify(row.source_id))) {
        if (chunk.fields.find((f) => f.field === 'metadata.authority_tier')!.after !== row.tier_to) wrong.push(chunk.chunk_id);
      }
    }
    expect(wrong).toEqual([]);
  });

  it('every repointed chunk\'s target is a live row of the platform seed, and every target the tool checks is one', () => {
    const seedSources = new Map(plan.seedSources.map((s) => [s.source_id, s]));
    const retired = new Set(plan.retireIds);
    // A chunk only the text log names carries no source_id field.
    const targets = plan.chunks
      .flatMap((c) => c.fields.filter((f) => f.field === 'source_id'))
      .filter((f) => f.before !== f.after)
      .map((f) => JSON.parse(f.after!) as string);
    expect(targets).toHaveLength(221);
    for (const id of new Set([...targets, ...plan.liveSources])) {
      expect([id, seedSources.get(id)?.status, retired.has(id)]).toEqual([id, 'active', false]);
    }
    expect(targets.every((id) => plan.liveSources.includes(id))).toBe(true);
  });
});

describe('pre_repair_values.csv is the seed production imported', () => {
  let importedSources: Map<string, Record<string, string>>;
  let importedChunks: Map<string, Record<string, string>>;
  let currentSources: Map<string, Record<string, string>>;
  let currentChunks: Map<string, Record<string, string>>;

  beforeAll(() => {
    importedSources = new Map(gitShow('seed_shadow_library_sources.csv').map((r) => [r.source_id, r]));
    importedChunks = new Map(gitShow('seed_shadow_library_chunks.csv').map((r) => [r.chunk_id, r]));
    currentSources = new Map(readCurrent('seed_shadow_library_sources.csv').map((r) => [r.source_id, r]));
    currentChunks = new Map(readCurrent('seed_shadow_library_chunks.csv').map((r) => [r.chunk_id, r]));
  });

  function importedValue(row: Record<string, string>, field: string): string | null {
    if (field.startsWith('metadata.')) {
      const metadata = JSON.parse(row.metadata || '{}') as Record<string, unknown>;
      const key = field.slice('metadata.'.length);
      return key in metadata ? canonical(metadata[key]) : null;
    }
    if (field === 'authority_tier') return canonical(Number(row.authority_tier));
    // The importer trims text before it writes it.
    if (field === 'text_content') return canonical(row.text_content.trim());
    return canonical(row[field]);
  }

  it('every planned before-value is the imported seed\'s value', () => {
    const wrong: string[] = [];
    for (const s of plan.sources) {
      const imported = importedSources.get(s.source_id);
      if (!imported) { wrong.push(`${s.source_id} not in the imported seed`); continue; }
      for (const f of s.fields) {
        if (importedValue(imported, f.field) !== f.before) wrong.push(`${s.source_id} ${f.field}`);
      }
    }
    for (const c of plan.chunks) {
      const imported = importedChunks.get(c.chunk_id)!;
      for (const f of c.fields) {
        if (importedValue(imported, f.field) !== f.before) wrong.push(`${c.chunk_id} ${f.field}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  type Rows = Map<string, Record<string, string>>;

  /**
   * Every difference between an imported seed and a current one that the plan
   * does not carry (`unplanned`), and the text changes it does carry
   * (`textPlanned`). Takes the rows as arguments so the negative control below
   * can hand it a seed with differences injected.
   */
  function seedDiff(imported: { sources: Rows; chunks: Rows }, current: { sources: Rows; chunks: Rows }) {
    const plannedSource = new Map(plan.sources.map((s) => [s.source_id, new Set(s.fields.filter((f) => f.before !== f.after).map((f) => f.field))]));
    const plannedChunk = new Map(plan.chunks.map((c) => [c.chunk_id, new Set(c.fields.filter((f) => f.before !== f.after).map((f) => f.field))]));
    const unplanned: string[] = [];
    const textPlanned: string[] = [];

    for (const [id, importedRow] of imported.sources) {
      const currentRow = current.sources.get(id);
      if (!currentRow) {
        if (!plan.retireIds.includes(id)) unplanned.push(`source ${id} removed`);
        continue;
      }
      const fields = plannedSource.get(id) ?? new Set<string>();
      for (const column of Object.keys(importedRow).filter((k) => k !== 'metadata')) {
        if (importedRow[column] !== currentRow[column] && !fields.has(column)) unplanned.push(`source ${id} ${column}`);
      }
      const a = JSON.parse(importedRow.metadata || '{}') as Record<string, unknown>;
      const b = JSON.parse(currentRow.metadata || '{}') as Record<string, unknown>;
      for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
        if (canonical(a[key] ?? null) !== canonical(b[key] ?? null) && !fields.has(`metadata.${key}`)) {
          unplanned.push(`source ${id} metadata.${key}`);
        }
      }
    }
    for (const id of current.sources.keys()) if (!imported.sources.has(id)) unplanned.push(`source ${id} added`);

    for (const [id, importedRow] of imported.chunks) {
      const currentRow = current.chunks.get(id);
      if (!currentRow) { unplanned.push(`chunk ${id} removed`); continue; }
      const fields = plannedChunk.get(id) ?? new Set<string>();
      for (const column of Object.keys(importedRow).filter((k) => k !== 'metadata')) {
        if (importedRow[column] === currentRow[column]) continue;
        if (fields.has(column)) {
          if (column === 'text_content') textPlanned.push(id);
          continue;
        }
        unplanned.push(`chunk ${id} ${column}`);
      }
      const a = JSON.parse(importedRow.metadata || '{}') as Record<string, unknown>;
      const b = JSON.parse(currentRow.metadata || '{}') as Record<string, unknown>;
      for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
        if (canonical(a[key] ?? null) !== canonical(b[key] ?? null) && !fields.has(`metadata.${key}`)) {
          unplanned.push(`chunk ${id} metadata.${key}`);
        }
      }
    }
    for (const id of current.chunks.keys()) if (!imported.chunks.has(id)) unplanned.push(`chunk ${id} added`);

    return { unplanned, textPlanned };
  }

  it('every difference between the imported seed and today\'s is in the plan, the corrected texts included', () => {
    const { unplanned, textPlanned } = seedDiff(
      { sources: importedSources, chunks: importedChunks },
      { sources: currentSources, chunks: currentChunks },
    );
    expect(unplanned).toEqual([]);
    // Positive control: the diff does see real differences. The four
    // corrected texts are the only text changes, so it must have found exactly
    // them, each carried by the plan.
    expect([...textPlanned].sort()).toEqual(Object.keys(TEXT_CORRECTIONS).sort());
  });

  it('negative control: a difference the plan does not carry is reported', () => {
    // One unlisted source, one unlisted chunk's metadata and another unlisted
    // chunk's text, each changed where no log row reaches: the diff must name
    // all three, and nothing else.
    const listedSources = new Set(plan.sources.map((s) => s.source_id));
    const listedChunks = new Set(plan.chunks.map((c) => c.chunk_id));
    const sourceId = [...currentSources.keys()].sort().find((id) => !listedSources.has(id))!;
    const [chunkId, textChunkId] = [...currentChunks.keys()].sort().filter((id) => !listedChunks.has(id));
    const sources = new Map(currentSources);
    const chunks = new Map(currentChunks);
    const source = sources.get(sourceId)!;
    sources.set(sourceId, { ...source, authority_tier: source.authority_tier === '1' ? '2' : '1' });
    const chunk = chunks.get(chunkId)!;
    chunks.set(chunkId, { ...chunk, metadata: JSON.stringify({ ...JSON.parse(chunk.metadata || '{}'), authority_tier: 9 }) });
    const textChunk = chunks.get(textChunkId)!;
    chunks.set(textChunkId, { ...textChunk, text_content: `${textChunk.text_content} (edited)` });

    const { unplanned } = seedDiff(
      { sources: importedSources, chunks: importedChunks },
      { sources, chunks },
    );
    expect(unplanned.sort()).toEqual([
      `chunk ${chunkId} metadata.authority_tier`,
      `chunk ${textChunkId} text_content`,
      `source ${sourceId} authority_tier`,
    ].sort());
  });
});
