// Guards on the research-baseline repair tool (pilot-repair-research-baseline.mjs)
// and its workflow (.github/workflows/repair-research-baseline.yml).
//
// WHY THIS FILE EXISTS. The tool writes production library rows on Jason's
// per-run approval (2026-09-29, Q1-Q4). What must hold is that a dry run writes
// nothing, that apply writes only inside one BEGIN/COMMIT, in the order the
// foreign keys need (repoint before retire), that the state it reports is the
// state the rows are in, and that every refusal fires -- and rolls back.
//
// WHAT IT CANNOT DO. The pg client is a stub that keeps rows in memory and
// answers by statement shape, and the plan is a small synthetic one built by
// the real buildRepairPlan. That proves the decisions, not the SQL:
// src/server/pilot/repairResearchBaseline.pg.test.ts runs the committed plan
// against the production schema, and researchRepairPlan.test.ts checks the
// committed plan files. Neither proves the workflow runs on GitHub; only a
// staging dry-run dispatch does.
//
// HOW IT RUNS. The module is loaded in a real node subprocess, the way the
// workflow consumes it, rather than through a jest transform -- the same
// pattern as pilot-move-policy-shelf.test.ts.

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

jest.setTimeout(120_000);

const SCRIPT_PATH = path.resolve(__dirname, 'pilot-repair-research-baseline.mjs');
const MODULE_URL = pathToFileURL(SCRIPT_PATH).href;
const WORKFLOW_PATH = path.resolve(__dirname, '../../../.github/workflows/repair-research-baseline.yml');
const PACKAGE_JSON_PATH = path.resolve(__dirname, '../package.json');

const PLATFORM = '__platform__';
const PHRASE = 'REPAIR RESEARCH BASELINE';
// Harness sentinel: run a dry run of the same spec first and apply with the
// plan_fingerprint it printed -- the reviewed-dry-run-then-apply flow.
const FROM_DRY_RUN = 'from-dry-run';
const OTHER_FINGERPRINT = `sha256:${'f'.repeat(64)}`;
const STUB_ENV = {
  AZURE_POSTGRES_CONNECTION_STRING: 'postgres://u:p@stub-host/stub_db',
  PPBF_EXPECTED_POSTGRES_HOSTNAME: 'stub-host',
  PPBF_EXPECTED_POSTGRES_DATABASE: 'stub_db',
};

type Row = Record<string, unknown>;
type Inputs = {
  seedSources: Row[];
  seedChunks: Row[];
  logs: Array<{ name: string; rows: Row[] }>;
  preRepairValues: Row[];
};
type Spec = {
  entry?: 'repair' | 'run' | 'plan';
  options?: Record<string, unknown>;
  env?: Record<string, string>;
  inputs?: Inputs;
  organizationExists?: boolean;
  sources?: Row[];
  chunks?: Row[];
  documents?: Row[];
  shortUpdate?: string;
  verifyOverride?: Record<string, number>;
  failOn?: string;
  planThrows?: boolean;
};
type Call = { text: string; values?: unknown[] };
type ToolResult = {
  status: string;
  reason?: string;
  state?: string;
  would_apply?: boolean;
  blockers?: Array<string | { code: string }>;
  plan_fingerprint?: string;
  counts?: Record<string, { planned: number; pending: number; done: number; unchanged: number; drifted: number }>;
  written?: Record<string, number>;
  mismatches?: string[];
  [key: string]: unknown;
};
type Outcome = {
  ok: boolean;
  error?: string;
  result?: ToolResult;
  exitCode?: number;
  calls: Call[];
  events: Array<{ event: string; payload: Record<string, unknown> }>;
  clientsCreated: number;
  finalSources?: Row[];
  finalChunks?: Row[];
};

const blockerCodes = (result: ToolResult | undefined): string[] => (result?.blockers ?? [])
  .map((b) => (typeof b === 'string' ? b : b.code));

const reviewed = {
  approval_state: 'approved', verification_state: 'verified', retrieval_suppressed: false,
  approved_by_account_id: 'acct-owner', approved_at: '2026-08-13 00:00:00+00',
  verified_by_account_id: 'acct-owner', verified_at: '2026-08-13 00:00:00+00',
};

/**
 * A plan with one of everything: a mis-cited claim repointed off a wrong-paper
 * source, a duplicate merged, a dead DOI-fragment source retired, a tier set
 * on a source and its chunk, and a wrong verified_title cleared.
 */
function inputs(): Inputs {
  return {
    seedSources: [
      { source_id: 'src_target', status: 'active', authority_tier: 3, metadata: { verification_status: 'RESOLVED', verified_title: 'Real paper', merged_duplicate_source_ids: ['src_dup'] } },
      { source_id: 'src_tier', status: 'active', authority_tier: 1, metadata: { verification_status: 'RESOLVED', tier_conflict: { tier_set: 1, provisional: true } } },
      { source_id: 'src_clear', status: 'active', authority_tier: 3, metadata: { verification_status: 'MISRESOLVED', misresolved_verified_title: 'Another paper' } },
    ],
    seedChunks: [
      { chunk_id: 'chk_a', source_id: 'src_target', metadata: { claim_id: 'A2-076', authority_tier: 3, verified_title: 'Real paper', citation_repair: { bogus_source_id: 'src_bogus' } } },
      { chunk_id: 'chk_b', source_id: 'src_target', metadata: { claim_id: 'A1-002', authority_tier: 3 } },
      { chunk_id: 'chk_c', source_id: 'src_tier', metadata: { claim_id: 'A5-001', authority_tier: 1, evidence_tier: 'PROVEN' } },
    ],
    logs: [
      { name: '2026-09-28_repair_log.csv', rows: [
        { action: 'REPOINT_MISRESOLVED', claim_id: 'A2-076', source_id: 'src_bogus', target_source_id: 'src_target', chunk_id: 'chk_a' },
        { action: 'MERGE_DUPLICATE', claim_id: '', source_id: 'src_dup', target_source_id: 'src_target', chunk_id: 'chk_b' },
        // The wrong paper the claim was repointed off, and one nothing cited.
        { action: 'DELETE_DEAD_BOGUS_SOURCE', claim_id: '', source_id: 'src_bogus', target_source_id: '', chunk_id: '' },
        { action: 'DELETE_DEAD_BOGUS_SOURCE', claim_id: '', source_id: 'src_dead', target_source_id: '', chunk_id: '' },
      ] },
      { name: '2026-09-29_followup_log.csv', rows: [
        { action: 'SET_TIER_BY_SPEC', source_id: 'src_tier', target_source_id: '', chunk_id: 'chk_c', tier_to: '1', tier_before_1008: '4', verified_title_from: '' },
        { action: 'CLEAR_MISRESOLVED_VERIFIED_TITLE', source_id: 'src_clear', target_source_id: '', chunk_id: '', tier_to: '', tier_before_1008: '', verified_title_from: 'Another paper' },
      ] },
    ],
    preRepairValues: [
      { table: 'source', row_id: 'src_bogus', field: 'status', before_json: '"active"' },
      { table: 'source', row_id: 'src_clear', field: 'metadata.misresolved_verified_title', before_json: '' },
      { table: 'source', row_id: 'src_clear', field: 'metadata.verification_status', before_json: '"RESOLVED"' },
      { table: 'source', row_id: 'src_clear', field: 'metadata.verified_title', before_json: '"Another paper"' },
      { table: 'source', row_id: 'src_dead', field: 'status', before_json: '"active"' },
      { table: 'source', row_id: 'src_dup', field: 'status', before_json: '"active"' },
      { table: 'source', row_id: 'src_target', field: 'metadata.merged_duplicate_source_ids', before_json: '' },
      { table: 'source', row_id: 'src_tier', field: 'authority_tier', before_json: '4' },
      { table: 'source', row_id: 'src_tier', field: 'metadata.tier_conflict', before_json: '' },
      { table: 'chunk', row_id: 'chk_a', field: 'source_id', before_json: '"src_bogus"' },
      { table: 'chunk', row_id: 'chk_a', field: 'metadata.citation_repair', before_json: '' },
      { table: 'chunk', row_id: 'chk_a', field: 'metadata.verified_title', before_json: '"A virus paper"' },
      { table: 'chunk', row_id: 'chk_b', field: 'source_id', before_json: '"src_dup"' },
      { table: 'chunk', row_id: 'chk_c', field: 'metadata.authority_tier', before_json: '4' },
      { table: 'chunk', row_id: 'chk_c', field: 'metadata.evidence_tier', before_json: '"EXPERIMENTAL"' },
    ],
  };
}

/** The database before the repair: what production imported, approved. */
function preRepair(): Pick<Spec, 'sources' | 'chunks' | 'documents'> {
  const source = (source_id: string, authority_tier: number, metadata: Row, title = source_id) => ({
    source_id, organization_id: PLATFORM, title, status: 'active', authority_tier, metadata: { seeded_from: 'x', ...metadata }, ...reviewed,
  });
  return {
    sources: [
      source('src_target', 3, { verification_status: 'RESOLVED', verified_title: 'Real paper' }, 'Real paper'),
      source('src_tier', 4, { verification_status: 'RESOLVED' }),
      source('src_clear', 3, { verification_status: 'RESOLVED', verified_title: 'Another paper' }),
      source('src_bogus', 3, { verified_title: 'A virus paper' }, 'A virus paper'),
      source('src_dup', 3, {}),
      source('src_dead', 4, {}),
    ],
    chunks: [
      { chunk_id: 'chk_a', organization_id: PLATFORM, document_id: 'doc_1', source_id: 'src_bogus', metadata: { claim_id: 'A2-076', track: 'A2', authority_tier: 3, verified_title: 'A virus paper' } },
      { chunk_id: 'chk_b', organization_id: PLATFORM, document_id: 'doc_1', source_id: 'src_dup', metadata: { claim_id: 'A1-002', track: 'A1', authority_tier: 3 } },
      { chunk_id: 'chk_c', organization_id: PLATFORM, document_id: 'doc_1', source_id: 'src_tier', metadata: { claim_id: 'A5-001', track: 'A5', authority_tier: 4, evidence_tier: 'EXPERIMENTAL' } },
      // Not in the plan, on a source that stays: must never be touched.
      { chunk_id: 'chk_other', organization_id: PLATFORM, document_id: 'doc_1', source_id: 'src_target', metadata: { claim_id: 'A9-001' } },
    ],
    documents: [],
  };
}

function dryRunOptions(extra: Record<string, unknown> = {}) {
  return { apply: false, confirm: '', ...extra };
}

function applyOptions(extra: Record<string, unknown> = {}) {
  return dryRunOptions({ apply: true, confirm: PHRASE, expectFingerprint: FROM_DRY_RUN, ...extra });
}

/** Runs the tool against an in-memory stub database inside a real node process. */
function runTool(spec: Spec): Outcome {
  const script = `
    import * as m from ${JSON.stringify(MODULE_URL)};
    const spec = ${JSON.stringify(spec)};
    const calls = [];
    const events = [];
    let clientsCreated = 0;
    const db = {
      sources: structuredClone(spec.sources ?? []),
      chunks: structuredClone(spec.chunks ?? []),
      documents: structuredClone(spec.documents ?? []),
    };
    const ok = (rows = [], rowCount = rows.length) => ({ rows, rowCount });
    const short = (key, rows) => (spec.shortUpdate === key ? rows.slice(1) : rows);
    const client = {
      async connect() {},
      async end() {},
      async query(text, values = []) {
        const t = text.trim();
        calls.push({ text: t, values });
        if (spec.failOn && new RegExp(spec.failOn, 'i').test(t)) throw new Error('stub: statement failed');
        if (/^(begin|begin transaction read only|rollback|commit)$/i.test(t)) return ok();
        if (/^set local /i.test(t)) return ok();
        if (/^select organization_id from pilot\\.organizations/i.test(t)) {
          return ok(spec.organizationExists === false ? [] : [{ organization_id: values[0] }]);
        }
        if (/^select source_id, organization_id, title, status/i.test(t)) {
          return ok(db.sources.filter((r) => values[0].includes(r.source_id)).map((r) => structuredClone(r)));
        }
        if (/^select chunk_id, organization_id, document_id, source_id, metadata/i.test(t)) {
          return ok(db.chunks.filter((r) => values[0].includes(r.chunk_id)).map((r) => structuredClone(r)));
        }
        if (/^select chunk_id, organization_id, source_id\\s+from pilot\\.shadow_library_chunks/i.test(t)) {
          return ok(db.chunks.filter((r) => values[0].includes(r.source_id) && !values[1].includes(r.chunk_id))
            .map((r) => ({ chunk_id: r.chunk_id, organization_id: r.organization_id, source_id: r.source_id })));
        }
        if (/^select document_id, organization_id, source_id/i.test(t)) {
          return ok(db.documents.filter((r) => values[0].includes(r.source_id)));
        }
        if (/^select\\s+\\(select count\\(\\*\\)::int from pilot\\.shadow_evidence_items/i.test(t)) {
          return ok([{ evidence_items: 0, citation_checks: 0, retraction_checks: 0 }]);
        }
        if (/^select c\\.chunk_id, c\\.source_id, s\\.title as source_title/i.test(t)) {
          return ok(db.chunks.filter((c) => c.organization_id === values[0] && c.metadata.claim_id === values[1]).map((c) => {
            const s = db.sources.find((x) => x.source_id === c.source_id);
            return { chunk_id: c.chunk_id, source_id: c.source_id, source_title: s?.title ?? null, source_status: s?.status ?? null };
          }));
        }
        if (/^update pilot\\.shadow_library_chunks c\\s+set source_id = x\\.to_source_id/i.test(t)) {
          const hit = [];
          for (const x of JSON.parse(values[1])) {
            const row = db.chunks.find((r) => r.organization_id === values[0] && r.chunk_id === x.chunk_id && r.source_id === x.from_source_id);
            if (row) hit.push({ row, x });
          }
          const applied = short('chunks_repointed', hit);
          for (const { row, x } of applied) { row.source_id = x.to_source_id; row.updated = true; }
          return ok(applied.map(({ row }) => ({ chunk_id: row.chunk_id })));
        }
        const editMetadata = (row, x) => {
          for (const k of x.remove_keys) delete row.metadata[k];
          Object.assign(row.metadata, x.set_keys);
          row.updated = true;
        };
        if (/^update pilot\\.shadow_library_chunks c\\s+set metadata/i.test(t)) {
          const hit = JSON.parse(values[1]).map((x) => ({ x, row: db.chunks.find((r) => r.organization_id === values[0] && r.chunk_id === x.chunk_id) })).filter((h) => h.row);
          const applied = short('chunks_metadata', hit);
          for (const { row, x } of applied) editMetadata(row, x);
          return ok(applied.map(({ row }) => ({ chunk_id: row.chunk_id })));
        }
        if (/^update pilot\\.shadow_library_sources s\\s+set authority_tier/i.test(t)) {
          const hit = JSON.parse(values[1]).map((x) => ({ x, row: db.sources.find((r) => r.organization_id === values[0] && r.source_id === x.source_id) })).filter((h) => h.row);
          const applied = short('sources_tier_and_metadata', hit);
          for (const { row, x } of applied) {
            if (x.authority_tier !== null) row.authority_tier = x.authority_tier;
            editMetadata(row, x);
          }
          return ok(applied.map(({ row }) => ({ source_id: row.source_id })));
        }
        if (/^update pilot\\.shadow_library_sources\\s+set status = 'archived'/i.test(t)) {
          const hit = db.sources.filter((r) => r.organization_id === values[0] && values[1].includes(r.source_id) && r.status === 'active');
          const applied = short('sources_archived', hit);
          for (const row of applied) { row.status = 'archived'; row.updated = true; }
          return ok(applied.map((row) => ({ source_id: row.source_id })));
        }
        if (/^select\\s+\\(select count\\(\\*\\)::int from pilot\\.shadow_library_chunks where source_id/i.test(t)) {
          return ok([{
            chunks_on_retired_sources: db.chunks.filter((r) => values[1].includes(r.source_id)).length,
            sources_archived: db.sources.filter((r) => r.organization_id === values[0] && values[1].includes(r.source_id) && r.status === 'archived').length,
            ...(spec.verifyOverride ?? {}),
          }]);
        }
        if (/^insert into pilot\\.audit_events/i.test(t)) return ok([], 1);
        throw new Error('stub: unexpected statement: ' + t.slice(0, 80));
      },
    };
    const log = (event, payload) => events.push({ event, payload });
    const quiet = () => {};
    const STAND_IN = 'sha256:' + '0'.repeat(64);
    try {
      let result;
      if (spec.entry === 'plan') {
        result = m.buildRepairPlan(spec.inputs);
        console.log(JSON.stringify({ ok: true, result, calls, events, clientsCreated }));
      } else {
        const plan = m.buildRepairPlan(spec.inputs);
        if (spec.entry === 'run') {
          const env = { ...(spec.env ?? {}) };
          const loadPlan = async () => { if (spec.planThrows) throw new Error('PLAN_INVALID: stub'); return plan; };
          if (env.PPBF_RESEARCH_REPAIR_EXPECT_FINGERPRINT === ${JSON.stringify(FROM_DRY_RUN)}) {
            const dry = await m.run(
              { ...env, PPBF_RESEARCH_REPAIR_APPLY: 'false', PPBF_RESEARCH_REPAIR_EXPECT_FINGERPRINT: '' },
              { createClient: () => client, log: quiet, loadPlan },
            );
            env.PPBF_RESEARCH_REPAIR_EXPECT_FINGERPRINT = dry.plan_fingerprint ?? STAND_IN;
            calls.length = 0;
          }
          result = await m.run(env, { createClient: () => { clientsCreated += 1; return client; }, log, loadPlan });
        } else {
          const options = { ...spec.options };
          if (options.expectFingerprint === ${JSON.stringify(FROM_DRY_RUN)}) {
            const dry = await m.repairResearchBaseline(client, { apply: false, confirm: '' }, { log: quiet, plan });
            options.expectFingerprint = dry.plan_fingerprint ?? STAND_IN;
            calls.length = 0;
          }
          result = await m.repairResearchBaseline(client, options, { log, plan });
        }
        const exitCode = m.exitCodeFor(result);
        console.log(JSON.stringify({ ok: true, result, exitCode, calls, events, clientsCreated, finalSources: db.sources, finalChunks: db.chunks }));
      }
    } catch (error) {
      console.log(JSON.stringify({ ok: false, error: String(error && error.message || error), calls, events, clientsCreated, finalSources: db.sources, finalChunks: db.chunks }));
    }
  `;

  return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    cwd: __dirname,
    maxBuffer: 16 * 1024 * 1024,
  }));
}

function baseSpec(extra: Partial<Spec> = {}): Spec {
  return { inputs: inputs(), ...preRepair(), ...extra };
}

const WRITE = /^(insert|update|delete|truncate|alter|drop|create)\b/i;
const texts = (out: Outcome) => out.calls.map((c) => c.text);
const writes = (out: Outcome) => texts(out).filter((t) => WRITE.test(t));
const planEvent = (out: Outcome) => out.events.find((e) => e.event === 'plan')!.payload as Record<string, unknown>;

function expectRolledBackWithoutWrites(out: Outcome) {
  const all = texts(out);
  expect(all[all.length - 1]).toMatch(/^rollback$/i);
  expect(all).not.toContain('commit');
  expect(writes(out)).toEqual([]);
}

/** Sets one row's fields, returning a new spec. */
function withSource(spec: Spec, id: string, patch: Row): Spec {
  return { ...spec, sources: spec.sources!.map((s) => (s.source_id === id ? { ...s, ...patch } : s)) };
}
function withChunk(spec: Spec, id: string, patch: Row): Spec {
  return { ...spec, chunks: spec.chunks!.map((c) => (c.chunk_id === id ? { ...c, ...patch } : c)) };
}
/** The database after a complete repair, by running one. */
function repaired(): Spec {
  const out = runTool({ ...baseSpec(), options: applyOptions() });
  expect(out.result!.status).toBe('applied');
  // `updated` is the stub's own marker, not a column.
  const strip = (row: Row) => Object.fromEntries(Object.entries(row).filter(([key]) => key !== 'updated'));
  return { ...baseSpec(), sources: out.finalSources!.map(strip), chunks: out.finalChunks!.map(strip) };
}

describe('the plan the files describe', () => {
  test('counts every change by action, from the pre-repair values and the seed', () => {
    const out = runTool({ entry: 'plan', inputs: inputs() });
    expect(out.error).toBeUndefined();
    const plan = out.result as unknown as {
      expected: Record<string, { fields: number; sources: number; chunks: number }>;
      retireIds: string[]; liveSources: string[];
    };
    expect(plan.retireIds).toEqual(['src_bogus', 'src_dead', 'src_dup']);
    expect(plan.liveSources).toEqual(['src_target', 'src_tier']);
    expect(plan.expected).toEqual({
      repoint: { fields: 2, sources: 0, chunks: 2 },
      retire: { fields: 3, sources: 3, chunks: 0 },
      // src_tier's authority_tier; chk_c's metadata.authority_tier and evidence_tier.
      retier: { fields: 3, sources: 1, chunks: 1 },
      // src_clear x3, src_target merged ids, src_tier tier_conflict; chk_a x2.
      metadata: { fields: 7, sources: 3, chunks: 1 },
    });
  });

  const invalid: Array<[string, (i: Inputs) => Inputs, RegExp]> = [
    ['a retired source still in the seed', (i) => ({ ...i, seedSources: [...i.seedSources, { source_id: 'src_dead', status: 'active', authority_tier: 4, metadata: {} }] }), /RETIRED_SOURCE_STILL_IN_SEED:src_dead/],
    ['a log row moving a chunk from a source the pre-repair values disagree with', (i) => ({
      ...i, preRepairValues: i.preRepairValues.map((r) => (r.row_id === 'chk_b' && r.field === 'source_id' ? { ...r, before_json: '"src_other"' } : r)),
    }), /MOVE_FROM_DISAGREES_WITH_PRE_REPAIR_VALUE:chk_b/],
    // The log names the destination too. src_tier is a listed, live seed row,
    // so nothing else in the plan objects: only the destination check can.
    ['a log row moving a chunk to a source the seed does not put it on', (i) => ({
      ...i, logs: i.logs.map((l) => ({ ...l, rows: l.rows.map((r) => (r.action === 'REPOINT_MISRESOLVED' ? { ...r, target_source_id: 'src_tier' } : r)) })),
    }), /MOVE_TO_DISAGREES_WITH_SEED:chk_a:src_tier/],
    ['a SET_TIER row whose tier_to is not the seed tier', (i) => ({
      ...i, logs: i.logs.map((l) => ({ ...l, rows: l.rows.map((r) => (r.action === 'SET_TIER_BY_SPEC' ? { ...r, tier_to: '2' } : r)) })),
    }), /SET_TIER_DISAGREES_WITH_SEED:src_tier/],
    ['a SET_TIER row whose tier_before_1008 is not the pre-repair tier', (i) => ({
      ...i, logs: i.logs.map((l) => ({ ...l, rows: l.rows.map((r) => (r.action === 'SET_TIER_BY_SPEC' ? { ...r, tier_before_1008: '3' } : r)) })),
    }), /SET_TIER_DISAGREES_WITH_PRE_REPAIR_VALUE:src_tier/],
    ['a cleared title that is not the pre-repair title', (i) => ({
      ...i, logs: i.logs.map((l) => ({ ...l, rows: l.rows.map((r) => (r.action === 'CLEAR_MISRESOLVED_VERIFIED_TITLE' ? { ...r, verified_title_from: 'Something else' } : r)) })),
    }), /CLEARED_TITLE_DISAGREES:src_clear/],
    ['an action the tool does not know', (i) => ({
      ...i, logs: [...i.logs, { name: 'x.csv', rows: [{ action: 'DELETE_EVERYTHING', source_id: 'src_target' }] }],
    }), /UNKNOWN_ACTION:x\.csv:DELETE_EVERYTHING/],
    // (A move the seed made with no log row AND no pre-repair value is invisible
    // to the plan; researchRepairPlan.test.ts diffs the imported seed for it.)
    ['a pre-repair value that moves a chunk no log row moves', (i) => ({
      ...i, preRepairValues: [...i.preRepairValues, { table: 'chunk', row_id: 'chk_c', field: 'source_id', before_json: '"src_target"' }],
    }), /CHUNK_MOVED_WITHOUT_A_LOG_ROW:chk_c/],
    ['a pre-repair value equal to the seed value', (i) => ({
      ...i, preRepairValues: i.preRepairValues.map((r) => (r.row_id === 'src_tier' && r.field === 'authority_tier' ? { ...r, before_json: '1' } : r)),
    }), /PRE_REPAIR_VALUE_EQUALS_SEED:source\|src_tier\|authority_tier/],
  ];

  test.each(invalid)('refuses %s: PLAN_INVALID', (_label, change, pattern) => {
    const out = runTool({ entry: 'plan', inputs: change(inputs()) });
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/^PLAN_INVALID: /);
    expect(out.error).toMatch(pattern);
  });
});

describe('dry run', () => {
  test('opens read-only, reports PRE_REPAIR, writes nothing, and rolls back', () => {
    const out = runTool({ ...baseSpec(), options: dryRunOptions() });

    expect(out.error).toBeUndefined();
    const all = texts(out);
    expect(all[0]).toBe('begin transaction read only');
    expectRolledBackWithoutWrites(out);
    // A read-only transaction cannot take row locks, and must not try.
    expect(all.some((t) => /for update/i.test(t))).toBe(false);
    expect(all.some((t) => /lock_timeout/i.test(t))).toBe(false);

    expect(out.result).toMatchObject({
      status: 'dry-run',
      state: 'PRE_REPAIR',
      would_apply: true,
      blockers: [],
      counts: {
        repoint: { planned: 2, pending: 2, done: 0, drifted: 0 },
        retire: { planned: 3, pending: 3, done: 0, drifted: 0 },
        retier: { planned: 3, pending: 3, done: 0, drifted: 0 },
        metadata: { planned: 7, pending: 7, done: 0, drifted: 0 },
      },
    });
    expect(out.result!.plan_fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(out.exitCode).toBe(0);
  });

  test('the printed plan names every repoint, retire and tier change, and the spot-check claim', () => {
    const plan = planEvent(runTool({ ...baseSpec(), options: dryRunOptions() }));
    const changes = plan.changes as { repoint: string[]; retire: string[]; retier: string[]; metadata_by_key: Record<string, unknown> };

    expect(changes.repoint).toEqual([
      'chk_a: "src_bogus" -> "src_target" [pending]',
      'chk_b: "src_dup" -> "src_target" [pending]',
    ]);
    expect(changes.retire).toEqual(['src_bogus [pending]', 'src_dead [pending]', 'src_dup [pending]']);
    expect(changes.retier).toEqual([
      'source authority_tier src_tier: 4 -> 1 [pending]',
      'chunk metadata.authority_tier chk_c: 4 -> 1 [pending]',
      'chunk metadata.evidence_tier chk_c: "EXPERIMENTAL" -> "PROVEN" [pending]',
    ]);
    expect(changes.metadata_by_key).toMatchObject({ 'source metadata.verified_title': { pending: 1 } });
    expect(plan.spot_check).toEqual([
      { claim_id: 'A2-076', chunk_id: 'chk_a', source_id: 'src_bogus', source_title: 'A virus paper', source_status: 'active' },
    ]);
  });

  test('the fingerprint is stable, and moves when any planned row\'s current value moves', () => {
    const a = runTool({ ...baseSpec(), options: dryRunOptions() }).result!.plan_fingerprint;
    const b = runTool({ ...baseSpec(), options: dryRunOptions() }).result!.plan_fingerprint;
    // An unmanaged key is not part of the plan and does not move it.
    const unmanaged = runTool({ ...withChunk(baseSpec(), 'chk_c', { metadata: { claim_id: 'A5-001', track: 'A5', authority_tier: 4, evidence_tier: 'EXPERIMENTAL', note: 'x' } }), options: dryRunOptions() }).result!.plan_fingerprint;
    const managed = runTool({ ...withSource(baseSpec(), 'src_target', { metadata: { verification_status: 'RESOLVED', verified_title: 'Real paper!' } }), options: dryRunOptions() }).result!.plan_fingerprint;
    expect(b).toBe(a);
    expect(unmanaged).toBe(a);
    expect(managed).not.toBe(a);
  });

  test('PARTIAL when some changes are in place and the rest are still pending', () => {
    const spec = withChunk(baseSpec(), 'chk_b', { source_id: 'src_target' });
    const out = runTool({ ...spec, options: dryRunOptions() });
    expect(out.result).toMatchObject({ state: 'PARTIAL', would_apply: true, counts: { repoint: { pending: 1, done: 1 } } });
    expect(out.exitCode).toBe(0);
  });

  test('REPAIRED after a complete repair, with nothing to apply', () => {
    const out = runTool({ ...repaired(), options: dryRunOptions() });
    expect(out.result).toMatchObject({
      state: 'REPAIRED',
      would_apply: false,
      blockers: [],
      counts: { repoint: { pending: 0, done: 2 }, retire: { pending: 0, done: 3 }, retier: { pending: 0, done: 3 }, metadata: { pending: 0, done: 7 } },
    });
    expect(out.exitCode).toBe(0);
  });

  const drifts: Array<[string, (s: Spec) => Spec]> = [
    ['FIELD_DRIFTED', (s) => withSource(s, 'src_tier', { authority_tier: 2 })],
    ['FIELD_DRIFTED', (s) => withChunk(s, 'chk_a', { source_id: 'src_tier' })],
    ['FIELD_DRIFTED', (s) => withSource(s, 'src_dead', { status: 'retired' })],
    ['FIELD_DRIFTED', (s) => withSource(s, 'src_target', { metadata: { verification_status: 'UNRESOLVED', verified_title: 'Real paper' } })],
    ['LISTED_ROW_MISSING', (s) => ({ ...s, sources: s.sources!.filter((r) => r.source_id !== 'src_dead') })],
    ['LISTED_ROW_MISSING', (s) => ({ ...s, chunks: s.chunks!.filter((r) => r.chunk_id !== 'chk_c') })],
    ['LISTED_ROW_OUTSIDE_PLATFORM', (s) => withSource(s, 'src_dup', { organization_id: 'punxsy_prominence' })],
    ['LISTED_ROW_OUTSIDE_PLATFORM', (s) => withChunk(s, 'chk_b', { organization_id: 'punxsy_prominence' })],
    ['TARGET_NOT_LIVE', (s) => withSource(s, 'src_target', { retrieval_suppressed: true })],
    ['TARGET_NOT_LIVE', (s) => withSource(s, 'src_tier', { approval_state: 'rejected', verification_state: 'unverified' })],
    ['UNPLANNED_CHUNKS_ON_RETIRING_SOURCES', (s) => ({
      ...s, chunks: [...s.chunks!, { chunk_id: 'chk_new', organization_id: PLATFORM, document_id: 'doc_1', source_id: 'src_dead', metadata: {} }],
    })],
    ['DOCUMENTS_ON_RETIRING_SOURCES', (s) => ({ ...s, documents: [{ document_id: 'doc_x', organization_id: PLATFORM, source_id: 'src_dup' }] })],
  ];

  test.each(drifts)('DRIFTED on %s, and the exit code is 1', (code, drift) => {
    const out = runTool({ ...drift(baseSpec()), options: dryRunOptions() });
    expect(out.result).toMatchObject({ status: 'dry-run', state: 'DRIFTED', would_apply: false });
    expect(out.result!.blockers).toContain(code);
    expectRolledBackWithoutWrites(out);
    expect(out.exitCode).toBe(1);
  });
});

describe('apply', () => {
  test('every write sits between BEGIN and COMMIT, repoint first and retire last, then one audit row', () => {
    const out = runTool({ ...baseSpec(), options: applyOptions() });

    expect(out.error).toBeUndefined();
    expect(out.result).toMatchObject({
      status: 'applied', state_before: 'PRE_REPAIR', state_after: 'REPAIRED',
      written: { chunks_repointed: 2, chunks_metadata: 2, sources_tier_and_metadata: 3, sources_archived: 3 },
    });
    expect(out.exitCode).toBe(0);
    const all = texts(out);
    expect(all[0]).toBe('begin');
    expect(all[all.length - 1]).toBe('commit');
    expect(all.filter((t) => t === 'commit')).toHaveLength(1);
    expect(all).not.toContain('rollback');
    expect(writes(out).map((t) => /^(update|insert into) pilot\.\w+/.exec(t)![0])).toEqual([
      'update pilot.shadow_library_chunks',
      'update pilot.shadow_library_chunks',
      'update pilot.shadow_library_sources',
      'update pilot.shadow_library_sources',
      'insert into pilot.audit_events',
    ]);
    expect(writes(out)[0]).toMatch(/set source_id = x\.to_source_id/);
    expect(writes(out)[3]).toMatch(/set status = 'archived'/);
  });

  test('retire sets status and updated_at only: the review columns are never written', () => {
    const out = runTool({ ...baseSpec(), options: applyOptions() });
    const retire = writes(out).find((t) => /status = 'archived'/.test(t))!;
    expect(retire).not.toMatch(/approval_state|verification_state|approved_|verified_/);
    for (const text of writes(out)) {
      expect(text).not.toMatch(/approval_state\s*=|verification_state\s*=|delete from/i);
    }
    const archived = out.finalSources!.filter((s) => s.status === 'archived');
    expect(archived.map((s) => s.source_id).sort()).toEqual(['src_bogus', 'src_dead', 'src_dup']);
    for (const row of archived) expect(row).toMatchObject(reviewed);
  });

  test('ends every planned field at the seed value, keeps unmanaged keys, and leaves unplanned rows alone', () => {
    const out = runTool({ ...baseSpec(), options: applyOptions() });
    const chunk = (id: string) => out.finalChunks!.find((c) => c.chunk_id === id)!;
    const source = (id: string) => out.finalSources!.find((s) => s.source_id === id)!;

    expect(chunk('chk_a')).toMatchObject({ source_id: 'src_target', metadata: { claim_id: 'A2-076', track: 'A2', authority_tier: 3, verified_title: 'Real paper', citation_repair: { bogus_source_id: 'src_bogus' } } });
    expect(chunk('chk_b').source_id).toBe('src_target');
    expect(chunk('chk_c').metadata).toEqual({ claim_id: 'A5-001', track: 'A5', authority_tier: 1, evidence_tier: 'PROVEN' });
    expect(source('src_tier')).toMatchObject({ authority_tier: 1, metadata: { seeded_from: 'x', tier_conflict: { tier_set: 1, provisional: true } } });
    expect(source('src_clear').metadata).toEqual({ seeded_from: 'x', verification_status: 'MISRESOLVED', misresolved_verified_title: 'Another paper' });
    expect(source('src_target').metadata).toMatchObject({ seeded_from: 'x', merged_duplicate_source_ids: ['src_dup'] });
    expect(chunk('chk_other')).not.toHaveProperty('updated');
  });

  test('locks the planned rows and bounds the wait', () => {
    const all = texts(runTool({ ...baseSpec(), options: applyOptions() }));
    expect(all[1]).toMatch(/^set local lock_timeout/i);
    for (const shape of [/^select source_id, organization_id, title/i, /^select chunk_id, organization_id, document_id/i, /^select chunk_id, organization_id, source_id\s+from/i]) {
      expect(all.find((t) => shape.test(t))).toMatch(/for update$/i);
    }
  });

  test('every update is scoped to __platform__', () => {
    const out = runTool({ ...baseSpec(), options: applyOptions() });
    for (const call of out.calls.filter((c) => /^update/i.test(c.text))) {
      expect(call.text).toMatch(/organization_id = \$1/);
      expect(call.values![0]).toBe(PLATFORM);
    }
  });

  test('the audit row carries the fingerprint and what was written', () => {
    const dry = runTool({ ...baseSpec(), options: dryRunOptions() });
    const out = runTool({ ...baseSpec(), options: applyOptions({ expectFingerprint: dry.result!.plan_fingerprint }) });
    const audit = out.calls.find((c) => /^insert into pilot\.audit_events/i.test(c.text))!;
    expect(audit.text).toMatch(/'shadow_library_research_repair'/);
    expect(audit.values![0]).toBe(PLATFORM);
    expect(JSON.parse(audit.values![1] as string)).toMatchObject({
      plan_fingerprint: dry.result!.plan_fingerprint,
      state_before: 'PRE_REPAIR',
      written: { chunks_repointed: 2, sources_archived: 3 },
    });
  });

  test('resumes a PARTIAL repair, writing only what is still pending', () => {
    const out = runTool({ ...withChunk(baseSpec(), 'chk_b', { source_id: 'src_target' }), options: applyOptions() });
    expect(out.result).toMatchObject({ status: 'applied', state_before: 'PARTIAL', written: { chunks_repointed: 1 } });
    const repoint = out.calls.find((c) => /set source_id = x\.to_source_id/.test(c.text))!;
    expect(JSON.parse(repoint.values![1] as string)).toEqual([{ chunk_id: 'chk_a', from_source_id: 'src_bogus', to_source_id: 'src_target' }]);
  });

  test('on a REPAIRED database apply writes nothing and exits 0', () => {
    const out = runTool({ ...repaired(), options: applyOptions() });
    expect(out.result).toMatchObject({ status: 'already-repaired', state: 'REPAIRED' });
    expectRolledBackWithoutWrites(out);
    expect(out.exitCode).toBe(0);
  });

  test('a fingerprint from some other plan stops the apply before the first update', () => {
    const out = runTool({ ...baseSpec(), options: applyOptions({ expectFingerprint: OTHER_FINGERPRINT }) });
    expect(out.result).toMatchObject({ status: 'refused', reason: 'PLAN_FINGERPRINT_MISMATCH', expected: OTHER_FINGERPRINT });
    expectRolledBackWithoutWrites(out);
    expect(out.exitCode).toBe(1);
  });

  test('a row that changed after the reviewed dry run stops the apply: PLAN_FINGERPRINT_MISMATCH', () => {
    const reviewedRun = runTool({ ...baseSpec(), options: dryRunOptions() });
    const changed = withChunk(baseSpec(), 'chk_b', { source_id: 'src_target' });
    const out = runTool({ ...changed, options: applyOptions({ expectFingerprint: reviewedRun.result!.plan_fingerprint }) });
    expect(out.result).toMatchObject({ status: 'refused', reason: 'PLAN_FINGERPRINT_MISMATCH' });
    expectRolledBackWithoutWrites(out);
  });

  test('a DRIFTED database is refused even with its own fingerprint: PLAN_DRIFTED', () => {
    const out = runTool({ ...withSource(baseSpec(), 'src_tier', { authority_tier: 2 }), options: applyOptions() });
    expect(out.result).toMatchObject({ status: 'refused', reason: 'PLAN_DRIFTED' });
    expect(blockerCodes(out.result)).toContain('FIELD_DRIFTED');
    expectRolledBackWithoutWrites(out);
  });

  test.each(['chunks_repointed', 'chunks_metadata', 'sources_tier_and_metadata', 'sources_archived'])(
    'an update touching fewer rows than planned rolls back: PLAN_APPLY_COUNT_MISMATCH (%s)',
    (key) => {
      const out = runTool({ ...baseSpec(), shortUpdate: key, options: applyOptions() });
      expect(out.result).toMatchObject({ status: 'refused', reason: 'PLAN_APPLY_COUNT_MISMATCH', update: key });
      const all = texts(out);
      expect(all[all.length - 1]).toBe('rollback');
      expect(all).not.toContain('commit');
      expect(all.some((t) => /^insert into pilot\.audit_events/i.test(t))).toBe(false);
    },
  );

  test('an end state that does not hold rolls back: END_STATE_MISMATCH', () => {
    const out = runTool({ ...baseSpec(), verifyOverride: { chunks_on_retired_sources: 1 }, options: applyOptions() });
    expect(out.result).toMatchObject({ status: 'refused', reason: 'END_STATE_MISMATCH' });
    expect(out.result!.mismatches).toEqual(['chunks_on_retired_sources=1']);
    expect(texts(out)).not.toContain('commit');
  });

  test('a database error mid-apply rolls back and surfaces the error', () => {
    const out = runTool({ ...baseSpec(), failOn: "^update pilot\\.shadow_library_sources\\s+set status = 'archived'", options: applyOptions() });
    expect(out.ok).toBe(false);
    expect(out.error).toContain('stub: statement failed');
    const all = texts(out);
    expect(all[all.length - 1]).toBe('rollback');
    expect(all).not.toContain('commit');
  });

  test('a database without the platform organization is refused', () => {
    const out = runTool({ ...baseSpec(), organizationExists: false, options: applyOptions({ expectFingerprint: OTHER_FINGERPRINT }) });
    expect(out.result).toMatchObject({ status: 'refused', reason: 'PLATFORM_ORGANIZATION_NOT_FOUND' });
    expectRolledBackWithoutWrites(out);
  });
});

describe('refusals before the database', () => {
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ['apply with no phrase', { apply: true, confirm: '' }, 'APPLY_WITHOUT_CONFIRM_PHRASE'],
    ['apply with a near-miss phrase', { apply: true, confirm: 'repair research baseline' }, 'APPLY_WITHOUT_CONFIRM_PHRASE'],
    // A truthy non-boolean must not reach the writing transaction.
    ['apply as the string "true"', { apply: 'true', confirm: PHRASE, expectFingerprint: OTHER_FINGERPRINT }, 'INVALID_APPLY'],
    ['apply as 1', { apply: 1, confirm: PHRASE, expectFingerprint: OTHER_FINGERPRINT }, 'INVALID_APPLY'],
    ['apply with no expected fingerprint', { apply: true, confirm: PHRASE, expectFingerprint: '' }, 'APPLY_WITHOUT_EXPECTED_FINGERPRINT'],
    ['apply with a malformed fingerprint', { apply: true, confirm: PHRASE, expectFingerprint: 'sha256:abc' }, 'INVALID_EXPECTED_FINGERPRINT'],
  ];

  test.each(cases)('%s: %s', (_label, override, reason) => {
    const out = runTool({ ...baseSpec(), options: dryRunOptions(override) });
    expect(out.result).toMatchObject({ status: 'refused', reason });
    expect(out.calls).toEqual([]);
    expect(out.exitCode).toBe(1);
  });

  test('run() refuses a connection string that is not the declared target, before creating a client', () => {
    const out = runTool({ ...baseSpec(), entry: 'run', env: { ...STUB_ENV, AZURE_POSTGRES_CONNECTION_STRING: 'postgres://u:p@some-other-host/stub_db' } });
    expect(out.result).toMatchObject({ status: 'refused', reason: 'POSTGRES_TARGET_MISMATCH' });
    expect(out.clientsCreated).toBe(0);
  });

  test('run() refuses with no connection string at all', () => {
    const out = runTool({ ...baseSpec(), entry: 'run', env: {} });
    expect(out.result).toMatchObject({ status: 'refused', reason: 'MISSING_CONNECTION_STRING' });
    expect(out.clientsCreated).toBe(0);
  });

  test('run() refuses a plan whose files disagree, before creating a client', () => {
    const out = runTool({ ...baseSpec(), entry: 'run', env: STUB_ENV, planThrows: true });
    expect(out.result).toMatchObject({ status: 'refused', reason: 'PLAN_INVALID' });
    expect(out.clientsCreated).toBe(0);
  });

  test('run() applies only for exactly PPBF_RESEARCH_REPAIR_APPLY=true', () => {
    const base = { ...STUB_ENV, PPBF_RESEARCH_REPAIR_CONFIRM: PHRASE, PPBF_RESEARCH_REPAIR_EXPECT_FINGERPRINT: FROM_DRY_RUN };
    const loose = runTool({ ...baseSpec(), entry: 'run', env: { ...base, PPBF_RESEARCH_REPAIR_APPLY: 'TRUE' } });
    expect(loose.result!.status).toBe('dry-run');
    expect(writes(loose)).toEqual([]);

    const exact = runTool({ ...baseSpec(), entry: 'run', env: { ...base, PPBF_RESEARCH_REPAIR_APPLY: 'true' } });
    expect(exact.result!.status).toBe('applied');
    expect(exact.clientsCreated).toBe(1);
  });

  test('run() passes the expected fingerprint through, trimmed', () => {
    const base = { ...STUB_ENV, PPBF_RESEARCH_REPAIR_CONFIRM: PHRASE, PPBF_RESEARCH_REPAIR_APPLY: 'true' };
    const none = runTool({ ...baseSpec(), entry: 'run', env: base });
    expect(none.result).toMatchObject({ status: 'refused', reason: 'APPLY_WITHOUT_EXPECTED_FINGERPRINT' });
    expect(none.clientsCreated).toBe(0);

    const dry = runTool({ ...baseSpec(), entry: 'run', env: { ...base, PPBF_RESEARCH_REPAIR_APPLY: 'false' } });
    const padded = runTool({ ...baseSpec(), entry: 'run', env: { ...base, PPBF_RESEARCH_REPAIR_EXPECT_FINGERPRINT: ` ${dry.result!.plan_fingerprint} ` } });
    expect(padded.result!.status).toBe('applied');
  });

  test('the command line refuses a missing connection string and exits 1 without connecting', () => {
    const child = spawnSync(process.execPath, [SCRIPT_PATH], {
      encoding: 'utf8',
      cwd: __dirname,
      env: { NODE_ENV: 'test', PATH: process.env.PATH ?? '', SystemRoot: process.env.SystemRoot ?? '', AZURE_POSTGRES_CONNECTION_STRING: '' },
    });
    expect(child.status).toBe(1);
    expect(child.stderr).toContain('library.research_repair.refused');
    expect(child.stderr).toContain('MISSING_CONNECTION_STRING');
  });
});

describe('the workflow', () => {
  const workflow = fs.readFileSync(WORKFLOW_PATH, 'utf8').replace(/\r\n/g, '\n');
  const script = fs.readFileSync(SCRIPT_PATH, 'utf8');

  function inputBlock(name: string): string {
    const start = workflow.search(new RegExp(`^      ${name}:\\s*$`, 'm'));
    expect(start).toBeGreaterThan(-1);
    const rest = workflow.slice(start + 1);
    const next = rest.search(/^ {6}\S|^\S/m);
    return next === -1 ? rest : rest.slice(0, next);
  }

  test('dispatch-only, and mode defaults to dry-run', () => {
    expect(workflow).toMatch(/^on:\n {2}workflow_dispatch:\n/m);
    expect(workflow).not.toMatch(/^\s+(push|pull_request|schedule):/m);
    expect(inputBlock('mode')).toMatch(/default: dry-run/);
  });

  test('offers exactly these inputs: no organization can be chosen', () => {
    const inputs = [...workflow.matchAll(/^ {6}([a-z_]+):\s*$/gm)].map((m) => m[1]);
    expect(inputs).toEqual(['target', 'confirm_target', 'mode', 'confirm_repair', 'expected_fingerprint']);
    expect(script).toContain("export const PLATFORM_ORGANIZATION_ID = '__platform__';");
  });

  test('the job runs in the environment named by target (where production is approved), one run per target at a time', () => {
    expect(workflow).toMatch(/^ {4}environment: \$\{\{ inputs\.target \}\}$/m);
    expect(workflow).toMatch(/group: repair-research-baseline-\$\{\{ inputs\.target \}\}/);
    expect(workflow).toMatch(/cancel-in-progress: false/);
  });

  test('expected_fingerprint is optional for a dry run, and apply refuses without a well-formed one', () => {
    const block = inputBlock('expected_fingerprint');
    expect(block).toMatch(/required: false/);
    expect(block).not.toMatch(/default:/);
    expect(workflow).toContain('[ "$MODE" = "apply" ] && [[ ! "$EXPECTED_FINGERPRINT" =~ ^sha256:[0-9a-f]{64}$ ]]');
    expect(script).toContain('export const FINGERPRINT_PATTERN = /^sha256:[0-9a-f]{64}$/;');
    expect(workflow).toMatch(/^ {10}PPBF_RESEARCH_REPAIR_EXPECT_FINGERPRINT: \$\{\{ inputs\.expected_fingerprint \}\}$/m);
  });

  test('apply needs the same phrase the script checks, and the target retyped', () => {
    expect(script).toContain(`export const CONFIRM_PHRASE = '${PHRASE}';`);
    expect(workflow).toContain(`[ "$CONFIRM_REPAIR" != "${PHRASE}" ]`);
    expect(workflow).toContain('[ "$TARGET" != "$CONFIRM_TARGET" ]');
    expect(workflow).toMatch(/PPBF_RESEARCH_REPAIR_APPLY: \$\{\{ inputs\.mode == 'apply' \}\}/);
    expect(workflow).toMatch(/PPBF_RESEARCH_REPAIR_CONFIRM: \$\{\{ inputs\.confirm_repair \}\}/);
  });

  test('free-text inputs reach the shell only through env, never interpolated into run blocks', () => {
    const offenders = workflow.split('\n').filter((line) => (
      /\$\{\{\s*inputs\.(confirm_repair|confirm_target|expected_fingerprint)\s*\}\}/.test(line)
      && !/^\s+[A-Z_]+: \$\{\{\s*inputs\.\w+\s*\}\}\s*$/.test(line)
    ));
    expect(offenders).toEqual([]);
  });

  test('the connection string comes from the target Container App through OIDC, and the target guard is declared', () => {
    expect(workflow).toContain('uses: azure/login@v3');
    expect(workflow).toContain('--secret-name azure-postgres-connection-string');
    expect(workflow).toContain("CONTAINER_APP_NAME: ${{ inputs.target == 'production' && 'app-ppbf-production' || 'app-ppbf-staging' }}");
    expect(workflow).toContain('PPBF_EXPECTED_POSTGRES_HOSTNAME=');
    expect(workflow).toContain('PPBF_EXPECTED_POSTGRES_DATABASE=');
  });

  test('the npm script the workflow runs exists', () => {
    const pkg = JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, 'utf8')) as { scripts: Record<string, string> };
    expect(workflow).toContain('npm run pilot:repair-research-baseline');
    expect(pkg.scripts['pilot:repair-research-baseline']).toBe('node scripts/pilot-repair-research-baseline.mjs');
  });

  test('the script never reads a local env file (apps/web/.env.local points at production)', () => {
    expect(script).not.toMatch(/loadEnvLocal|dotenv|\.env\.local'/);
  });

  test('the script never deletes a library row', () => {
    expect(script).not.toMatch(/delete\s+from/i);
  });
});
