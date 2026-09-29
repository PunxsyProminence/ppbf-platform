// Guards on the policy-shelf move tool (pilot-move-policy-shelf.mjs) and its
// workflow (.github/workflows/move-policy-shelf.yml).
//
// WHY THIS FILE EXISTS. The tool writes production library rows across
// tenants, on Jason's per-run approval (OD-2026-09-28-011 item 6). What must
// hold is that a dry run writes nothing, that apply writes only inside one
// BEGIN/COMMIT, and that every refusal actually fires -- and that a refusal
// after BEGIN rolls back rather than committing half a move.
//
// WHAT IT CANNOT DO. It cannot prove the SQL is right against a real schema:
// the pg client is stubbed and answers by statement shape. That is what
// src/server/pilot/movePolicyShelf.pg.test.ts is for (embedded Postgres, full
// production schema). Neither proves the workflow runs on GitHub; only a staging
// dry-run dispatch does.
//
// HOW IT RUNS. The module is loaded in a real node subprocess, the way the
// workflow consumes it, rather than through a jest transform -- the same
// pattern as pilot-check-shadow-job-queue.test.ts.

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

jest.setTimeout(120_000);

const SCRIPT_PATH = path.resolve(__dirname, 'pilot-move-policy-shelf.mjs');
const MODULE_URL = pathToFileURL(SCRIPT_PATH).href;
const WORKFLOW_PATH = path.resolve(__dirname, '../../../.github/workflows/move-policy-shelf.yml');
const PACKAGE_JSON_PATH = path.resolve(__dirname, '../package.json');

const FROM = 'org-root';
const TO = 'org-gym';
const PHRASE = 'MOVE POLICY SHELF';
// Harness sentinel: run a dry run of the same spec first and apply with the
// plan_fingerprint it printed -- the reviewed-dry-run-then-apply flow.
const FROM_DRY_RUN = 'from-dry-run';
const OTHER_FINGERPRINT = `sha256:${'f'.repeat(64)}`;

type Row = Record<string, unknown>;
type Counts = Record<'sources' | 'documents' | 'chunks' | 'citation_checks' | 'retraction_checks', number>;

type Spec = {
  entry?: 'move' | 'run';
  options?: Record<string, unknown>;
  env?: Record<string, string>;
  organizations?: Row[];
  sources?: Row[];
  documents?: Row[];
  chunks?: Row[];
  citationChecks?: Row[];
  retractionChecks?: Row[];
  evidenceItems?: number;
  submissions?: Row[];
  rabbitHoles?: Row[];
  collisions?: { sourceUrls?: Row[]; documentShas?: Row[]; citationIds?: Row[]; retractionIds?: Row[] };
  capabilityRules?: Row[];
  before?: Record<string, Counts>;
  shortUpdate?: string;
  verifyOverride?: Record<string, number>;
  // Skews one organization's count once the updates have run, so the per-org
  // before/after totals no longer add up.
  skewAfter?: { org: string; key: string; delta: number };
  failOn?: string;
};

type Call = { text: string; values?: unknown[] };
type ToolResult = {
  status: string;
  reason?: string;
  would_apply?: boolean;
  // Codes on a dry run; { code, ...detail } objects on a refused apply.
  blockers?: Array<string | { code: string }>;
  plan_fingerprint?: string;
  mismatches?: string[];
  [key: string]: unknown;
};
type StateTally = {
  sources: { ready: number; not_ready: number; by_approval_state: Record<string, number> };
  documents: { ready: number; not_ready: number };
  chunks: { ready: number; not_ready: number };
};
type PlanEvent = {
  mode: string;
  state_tally: StateTally;
  state_note: string;
  sources: Array<{ source_id: string }>;
  documents: unknown[];
  chunk_ids: string[];
  citation_check_ids: string[];
  retraction_check_ids: string[];
  before: Record<string, Counts>;
  moving_total: number;
  capability_rules_not_moved: unknown[];
};
type Outcome = {
  ok: boolean;
  error?: string;
  result?: ToolResult;
  // exitCodeFor(result): what the command line would exit with.
  exitCode?: number;
  calls: Call[];
  events: Array<{ event: string; payload: Record<string, unknown> }>;
  clientsCreated: number;
};

const blockerCodes = (result: ToolResult | undefined): string[] => (result?.blockers ?? [])
  .map((b) => (typeof b === 'string' ? b : b.code));
const planEvent = (out: Outcome): PlanEvent => out.events.find((e) => e.event === 'plan')!.payload as unknown as PlanEvent;

const ZERO: Counts = { sources: 0, documents: 0, chunks: 0, citation_checks: 0, retraction_checks: 0 };

/** A clean shelf: an authority-model source with its own document, a policy
 * source whose chunks sit in copied documents, and the copied programme source
 * those documents belong to -- the shape the ppbf_policy import produced. The
 * authority document is indexed and approved; the two copied documents are
 * still pending, the state pilot-rescope-library-baseline.mjs inserted copies
 * in (:311). */
function cleanShelf(): Spec {
  const reviewed = { status: 'active', approval_state: 'approved', verification_state: 'verified', retrieval_suppressed: false };
  const readyDoc = { ingest_state: 'indexed', index_completed: true, approval_state: 'approved', verification_state: 'verified' };
  const pendingDoc = { ingest_state: 'pending', index_completed: false, approval_state: 'pending_review', verification_state: 'unverified' };
  return {
    organizations: [
      { organization_id: FROM, organization_name: 'Root', status: 'active' },
      { organization_id: TO, organization_name: 'Gym', status: 'active' },
    ],
    sources: [
      { source_id: 'pol-authority', title: 'Authority Model', source_type: 'internal_policy', authority_tier: 1, url: 'https://ex.test/authority', ...reviewed },
      { source_id: 'pol-a', title: 'Policy A', source_type: 'internal_policy', authority_tier: 3, url: 'https://ex.test/a', ...reviewed },
      { source_id: 'prog-copy', title: 'Programme (copy)', source_type: 'internal_policy', authority_tier: 3, url: 'https://ex.test/programme', ...reviewed },
    ],
    documents: [
      { document_id: 'doc-authority', source_id: 'pol-authority', organization_id: FROM, subject_id: null, content_sha256: 'sha-authority', ...readyDoc },
      { document_id: 'doc-copy-1', source_id: 'prog-copy', organization_id: FROM, subject_id: null, content_sha256: 'sha-track-1', ...pendingDoc },
      { document_id: 'doc-copy-2', source_id: 'prog-copy', organization_id: FROM, subject_id: null, content_sha256: 'sha-track-2', ...pendingDoc },
    ],
    chunks: [
      { chunk_id: 'ch-auth-1', document_id: 'doc-authority', source_id: 'pol-authority', organization_id: FROM, subject_id: null },
      { chunk_id: 'ch-auth-2', document_id: 'doc-authority', source_id: 'pol-authority', organization_id: FROM, subject_id: null },
      { chunk_id: 'ch-a-1', document_id: 'doc-copy-1', source_id: 'pol-a', organization_id: FROM, subject_id: null },
      { chunk_id: 'ch-a-2', document_id: 'doc-copy-2', source_id: 'pol-a', organization_id: FROM, subject_id: null },
    ],
    citationChecks: [{ organization_id: FROM, check_id: 'cc-1', source_id: 'pol-a' }],
    retractionChecks: [{ organization_id: FROM, retraction_check_id: 'rc-1', source_id: 'pol-a' }],
    before: {
      [FROM]: { sources: 10, documents: 5, chunks: 20, citation_checks: 3, retraction_checks: 2 },
      [TO]: { ...ZERO },
    },
  };
}

function dryRunOptions(extra: Record<string, unknown> = {}) {
  return {
    fromOrganizationId: FROM,
    toOrganizationId: TO,
    sourceType: 'internal_policy',
    apply: false,
    confirm: '',
    maxRows: 500,
    ...extra,
  };
}

function applyOptions(extra: Record<string, unknown> = {}) {
  return dryRunOptions({ apply: true, confirm: PHRASE, expectFingerprint: FROM_DRY_RUN, ...extra });
}

/** Runs the tool against a recording stub client inside a real node process. */
function runTool(spec: Spec): Outcome {
  const script = `
    import * as m from ${JSON.stringify(MODULE_URL)};
    const spec = ${JSON.stringify(spec)};
    const calls = [];
    const events = [];
    const moved = {};
    const planned = {};
    let movedFrom = null;
    let movedTo = null;
    let clientsCreated = 0;
    const TABLE_KEYS = {
      shadow_library_sources: 'sources',
      shadow_library_documents: 'documents',
      shadow_library_chunks: 'chunks',
      source_citation_checks: 'citation_checks',
      source_retraction_checks: 'retraction_checks',
    };
    const ZERO = { sources: 0, documents: 0, chunks: 0, citation_checks: 0, retraction_checks: 0 };
    const ok = (rows = [], rowCount = rows.length) => ({ rows, rowCount });
    const client = {
      async connect() {},
      async end() {},
      async query(text, values) {
        const t = text.trim();
        calls.push({ text: t, values });
        if (spec.failOn && new RegExp(spec.failOn, 'i').test(t)) throw new Error('stub: statement failed');
        if (/^(begin|begin read only|rollback|commit)$/i.test(t)) return ok();
        if (/^set local lock_timeout/i.test(t)) return ok();
        let match = /^update pilot\\.(\\w+)/i.exec(t);
        if (match) {
          const key = TABLE_KEYS[match[1]];
          if (!key) throw new Error('stub: update of unexpected table ' + match[1]);
          const ids = values[2];
          const n = Math.max(0, ids.length - (spec.shortUpdate === key ? 1 : 0));
          moved[key] = n;
          planned[key] = ids.length;
          movedFrom = values[0];
          movedTo = values[1];
          return ok(ids.slice(0, n).map((id) => ({ id })), n);
        }
        if (/^insert into pilot\\.audit_events/i.test(t)) return ok([], 1);
        if (/^select organization_id, organization_name, status\\s+from pilot\\.organizations/i.test(t)) {
          return ok((spec.organizations ?? []).filter((o) => values[0].includes(o.organization_id)));
        }
        if (/^select o\\.organization_id/i.test(t)) {
          return ok(values[0].filter((id) => (spec.organizations ?? []).some((o) => o.organization_id === id)).map((id) => {
            const base = { ...ZERO, ...((spec.before ?? {})[id] ?? {}) };
            for (const key of Object.keys(ZERO)) {
              if (id === movedFrom) base[key] -= moved[key] ?? 0;
              if (id === movedTo) base[key] += moved[key] ?? 0;
            }
            if (spec.skewAfter && movedFrom !== null && id === spec.skewAfter.org) {
              base[spec.skewAfter.key] += spec.skewAfter.delta;
            }
            return { organization_id: id, ...base };
          }));
        }
        if (/^select source_id, title, source_type/i.test(t)) return ok(spec.sources ?? []);
        if (/^select document_id, source_id, organization_id, subject_id, content_sha256/i.test(t)) return ok(spec.documents ?? []);
        if (/^select chunk_id, document_id, source_id, organization_id, subject_id/i.test(t)) return ok(spec.chunks ?? []);
        if (/^select organization_id, check_id, source_id/i.test(t)) return ok(spec.citationChecks ?? []);
        if (/^select organization_id, retraction_check_id, source_id/i.test(t)) return ok(spec.retractionChecks ?? []);
        if (/^select count\\(\\*\\)::int as n\\s+from pilot\\.shadow_evidence_items/i.test(t)) return ok([{ n: spec.evidenceItems ?? 0 }]);
        if (/^select organization_id, submission_id/i.test(t)) return ok(spec.submissions ?? []);
        if (/^select organization_id, rabbit_hole_id/i.test(t)) return ok(spec.rabbitHoles ?? []);
        if (/^select source_id, url from pilot\\.shadow_library_sources/i.test(t)) return ok(spec.collisions?.sourceUrls ?? []);
        if (/^select document_id, content_sha256 from pilot\\.shadow_library_documents/i.test(t)) return ok(spec.collisions?.documentShas ?? []);
        if (/^select check_id from pilot\\.source_citation_checks/i.test(t)) return ok(spec.collisions?.citationIds ?? []);
        if (/^select retraction_check_id from pilot\\.source_retraction_checks/i.test(t)) return ok(spec.collisions?.retractionIds ?? []);
        if (/^select f\\.capability_map_id/i.test(t)) return ok(spec.capabilityRules ?? []);
        if (/^select\\s+\\(select count\\(\\*\\)::int from pilot\\.shadow_library_sources/i.test(t)) {
          const left = (key) => (planned[key] ?? 0) - (moved[key] ?? 0);
          return ok([{
            sources_left_in_from: left('sources'),
            documents_left_in_from: left('documents'),
            chunks_left_in_from: left('chunks'),
            citation_checks_left_in_from: left('citation_checks'),
            retraction_checks_left_in_from: left('retraction_checks'),
            sources_in_to: moved.sources ?? 0,
            documents_in_to_with_local_source: moved.documents ?? 0,
            chunks_in_to_with_local_document_and_source: moved.chunks ?? 0,
            ...(spec.verifyOverride ?? {}),
          }]);
        }
        throw new Error('stub: unexpected statement: ' + t.slice(0, 80));
      },
    };
    const log = (event, payload) => events.push({ event, payload });
    const quiet = () => {};
    // A plan that cannot even be dry-run has no fingerprint; a well-formed
    // stand-in lets the apply reach the refusal the test is about.
    const STAND_IN = 'sha256:' + '0'.repeat(64);
    try {
      let result;
      if (spec.entry === 'run') {
        const env = { ...(spec.env ?? {}) };
        if (env.PPBF_POLICY_MOVE_EXPECT_FINGERPRINT === ${JSON.stringify(FROM_DRY_RUN)}) {
          const dry = await m.run(
            { ...env, PPBF_POLICY_MOVE_APPLY: 'false', PPBF_POLICY_MOVE_EXPECT_FINGERPRINT: '' },
            { createClient: () => client, log: quiet },
          );
          env.PPBF_POLICY_MOVE_EXPECT_FINGERPRINT = dry.plan_fingerprint ?? STAND_IN;
          calls.length = 0;
        }
        result = await m.run(env, { createClient: () => { clientsCreated += 1; return client; }, log });
      } else {
        const options = { ...spec.options };
        if (options.expectFingerprint === ${JSON.stringify(FROM_DRY_RUN)}) {
          const dry = await m.movePolicyShelf(
            client,
            { ...options, apply: false, confirm: '', expectFingerprint: undefined },
            { log: quiet },
          );
          options.expectFingerprint = dry.plan_fingerprint ?? STAND_IN;
          calls.length = 0;
        }
        result = await m.movePolicyShelf(client, options, { log });
      }
      const exitCode = m.exitCodeFor(result);
      console.log(JSON.stringify({ ok: true, result, exitCode, calls, events, clientsCreated }));
    } catch (error) {
      console.log(JSON.stringify({ ok: false, error: String(error && error.message || error), calls, events, clientsCreated }));
    }
  `;

  return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    cwd: __dirname,
    maxBuffer: 16 * 1024 * 1024,
  }));
}

const WRITE = /^(insert|update|delete|truncate|alter|drop|create)\b/i;
const texts = (out: Outcome) => out.calls.map((c) => c.text);
const writes = (out: Outcome) => texts(out).filter((t) => WRITE.test(t));

function expectRolledBackWithoutWrites(out: Outcome) {
  const all = texts(out);
  expect(all[all.length - 1]).toMatch(/^rollback$/i);
  expect(all).not.toContain('commit');
  expect(writes(out)).toEqual([]);
}

describe('dry run', () => {
  test('opens read-only, prints the plan, writes nothing, and rolls back', () => {
    const out = runTool({ ...cleanShelf(), options: dryRunOptions() });

    expect(out.ok).toBe(true);
    const all = texts(out);
    expect(all[0]).toBe('begin read only');
    expectRolledBackWithoutWrites(out);
    // A read-only transaction cannot take row locks, and must not try.
    expect(all.some((t) => /for update/i.test(t))).toBe(false);
    expect(all.some((t) => /lock_timeout/i.test(t))).toBe(false);

    expect(out.result).toMatchObject({
      status: 'dry-run',
      would_apply: true,
      blockers: [],
      moving: { sources: 3, documents: 3, chunks: 4, citation_checks: 1, retraction_checks: 1 },
    });
    expect(out.result!.plan_fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  test('the printed plan names every row that would move', () => {
    const out = runTool({ ...cleanShelf(), options: dryRunOptions() });
    const plan = planEvent(out);

    expect(plan.mode).toBe('dry-run');
    expect(plan.sources.map((s) => s.source_id)).toEqual(['pol-authority', 'pol-a', 'prog-copy']);
    const pending = { ingest_state: 'pending', index_completed: false, approval_state: 'pending_review', verification_state: 'unverified' };
    expect(plan.documents).toEqual([
      {
        document_id: 'doc-authority', source_id: 'pol-authority', chunks: 2,
        ingest_state: 'indexed', index_completed: true, approval_state: 'approved', verification_state: 'verified',
      },
      { document_id: 'doc-copy-1', source_id: 'prog-copy', chunks: 1, ...pending },
      { document_id: 'doc-copy-2', source_id: 'prog-copy', chunks: 1, ...pending },
    ]);
    expect(plan.chunk_ids).toEqual(['ch-auth-1', 'ch-auth-2', 'ch-a-1', 'ch-a-2']);
    expect(plan.citation_check_ids).toEqual(['cc-1']);
    expect(plan.retraction_check_ids).toEqual(['rc-1']);
    expect(plan.before[FROM].sources).toBe(10);
    expect(plan.moving_total).toBe(12);
  });

  test('tallies review state, so a pending copy shows before the move, not after', () => {
    const spec = cleanShelf();
    // One source still pending, as a programme copy would be.
    spec.sources = spec.sources!.map((s) => (s.source_id === 'prog-copy'
      ? { ...s, approval_state: 'pending_review', verification_state: 'unverified' }
      : s));
    const out = runTool({ ...spec, options: dryRunOptions() });
    const expected = {
      sources: { ready: 2, not_ready: 1, by_approval_state: { approved: 2, pending_review: 1 } },
      // Only the authority document is indexed and approved.
      documents: { ready: 1, not_ready: 2 },
      // The two authority chunks; pol-a's chunks sit in the pending copies.
      chunks: { ready: 2, not_ready: 2 },
    };

    expect(planEvent(out).state_tally).toEqual(expected);
    expect(planEvent(out).state_note).toMatch(/not their review state/);
    expect(out.result!.state_tally).toEqual(expected);
    // The one-line summary a dry run ends on carries it too.
    expect(out.events.find((e) => e.event === 'dry-run')!.payload.state_tally).toEqual(expected);
  });

  test('a source that is suppressed or inactive is not counted ready', () => {
    const spec = cleanShelf();
    spec.sources = spec.sources!.map((s) => {
      if (s.source_id === 'pol-authority') return { ...s, retrieval_suppressed: true };
      if (s.source_id === 'pol-a') return { ...s, status: 'retired' };
      return s;
    });
    const tally = planEvent(runTool({ ...spec, options: dryRunOptions() })).state_tally;

    expect(tally.sources).toMatchObject({ ready: 1, not_ready: 2 });
    expect(tally.chunks).toEqual({ ready: 0, not_ready: 4 });
  });

  test('exit code: 0 for a clean dry run, 1 for a dry run with blockers', () => {
    expect(runTool({ ...cleanShelf(), options: dryRunOptions() }).exitCode).toBe(0);

    const blocked = runTool({ ...cleanShelf(), evidenceItems: 1, options: dryRunOptions() });
    expect(blocked.result).toMatchObject({ status: 'dry-run', would_apply: false });
    expect(blocked.exitCode).toBe(1);
  });

  test('reports every blocker at once, and still writes nothing', () => {
    const spec = cleanShelf();
    const out = runTool({
      ...spec,
      evidenceItems: 2,
      collisions: { sourceUrls: [{ source_id: 'gym-own', url: 'https://ex.test/a' }] },
      submissions: [{ organization_id: FROM, submission_id: 'sub-1', source_id: 'pol-a', document_id: null }],
      options: dryRunOptions(),
    });

    expect(out.result).toMatchObject({ status: 'dry-run', would_apply: false });
    expect(out.result!.blockers).toEqual(expect.arrayContaining([
      'EVIDENCE_ITEMS_CITE_ROWS', 'TARGET_ORG_COLLISION', 'RESEARCH_SUBMISSIONS_REFERENCE_ROWS',
    ]));
    expectRolledBackWithoutWrites(out);
  });

  test('capability rules that ask for the type are listed and never moved', () => {
    const out = runTool({
      ...cleanShelf(),
      capabilityRules: [{ capability_map_id: 'cap-1', capability_key: 'shadow.doctrine.authority', coverage_state: 'covered', target_has_key: false }],
      options: applyOptions(),
    });
    const plan = planEvent(out);

    expect(plan.capability_rules_not_moved).toEqual([
      { capability_map_id: 'cap-1', capability_key: 'shadow.doctrine.authority', coverage_state: 'covered', target_has_key: false },
    ]);
    expect(texts(out).some((t) => /capability_map\s+set/i.test(t))).toBe(false);
    expect(out.result!.status).toBe('applied');
  });
});

describe('apply', () => {
  test('every write sits between BEGIN and COMMIT, and COMMIT is last', () => {
    const out = runTool({ ...cleanShelf(), options: applyOptions() });

    expect(out.ok).toBe(true);
    expect(out.result!.status).toBe('applied');
    expect(out.exitCode).toBe(0);
    const all = texts(out);
    expect(all[0]).toBe('begin');
    expect(all[all.length - 1]).toBe('commit');
    expect(all.filter((t) => t === 'commit')).toHaveLength(1);
    expect(all).not.toContain('rollback');

    const beginAt = all.indexOf('begin');
    const commitAt = all.indexOf('commit');
    all.forEach((t, i) => {
      if (WRITE.test(t)) {
        expect(i).toBeGreaterThan(beginAt);
        expect(i).toBeLessThan(commitAt);
      }
    });
    // Sources, documents, chunks, both check tables, then one audit row.
    expect(writes(out).map((t) => /^(update|insert into) pilot\.\w+/.exec(t)![0])).toEqual([
      'update pilot.shadow_library_sources',
      'update pilot.shadow_library_documents',
      'update pilot.shadow_library_chunks',
      'update pilot.source_citation_checks',
      'update pilot.source_retraction_checks',
      'insert into pilot.audit_events',
    ]);
  });

  test('locks the planned rows and bounds the wait', () => {
    const out = runTool({ ...cleanShelf(), options: applyOptions() });
    const all = texts(out);

    expect(all[1]).toMatch(/^set local lock_timeout/i);
    for (const shape of [/^select source_id, title/i, /^select document_id, source_id, organization_id/i, /^select chunk_id/i]) {
      expect(all.find((t) => shape.test(t))).toMatch(/for update$/i);
    }
  });

  test('each update is scoped to the from-organization and the planned ids', () => {
    const out = runTool({ ...cleanShelf(), options: applyOptions() });
    const updates = out.calls.filter((c) => /^update/i.test(c.text));

    for (const call of updates) {
      expect(call.text).toMatch(/where organization_id = \$1 and \w+ = any\(\$3::text\[\]\)/);
      expect(call.values!.slice(0, 2)).toEqual([FROM, TO]);
    }
    expect(updates.map((c) => c.values![2])).toEqual([
      ['pol-authority', 'pol-a', 'prog-copy'],
      ['doc-authority', 'doc-copy-1', 'doc-copy-2'],
      ['ch-auth-1', 'ch-auth-2', 'ch-a-1', 'ch-a-2'],
      ['cc-1'],
      ['rc-1'],
    ]);
  });

  test('apply with the reviewed dry run\'s fingerprint moves, and records it', () => {
    const dry = runTool({ ...cleanShelf(), options: dryRunOptions() });
    const applied = runTool({
      ...cleanShelf(), options: applyOptions({ expectFingerprint: dry.result!.plan_fingerprint }),
    });

    expect(applied.result!.status).toBe('applied');
    expect(applied.result!.plan_fingerprint).toBe(dry.result!.plan_fingerprint);
    const audit = applied.calls.find((c) => /^insert into pilot\.audit_events/i.test(c.text))!;
    expect(JSON.parse(audit.values![1] as string)).toMatchObject({
      from_organization: FROM,
      to_organization: TO,
      plan_fingerprint: dry.result!.plan_fingerprint,
      moved: { sources: 3, documents: 3, chunks: 4, citation_checks: 1, retraction_checks: 1 },
    });
  });

  test('a source added after the reviewed dry run stops the apply: PLAN_FINGERPRINT_MISMATCH', () => {
    const reviewed = runTool({ ...cleanShelf(), options: dryRunOptions() });
    const grown = cleanShelf();
    grown.sources = [...grown.sources!, {
      source_id: 'pol-late', title: 'Added after review', source_type: 'internal_policy', authority_tier: 3,
      url: 'https://ex.test/late', status: 'active', approval_state: 'approved', verification_state: 'verified',
      retrieval_suppressed: false,
    }];
    const out = runTool({ ...grown, options: applyOptions({ expectFingerprint: reviewed.result!.plan_fingerprint }) });

    expect(out.result).toMatchObject({
      status: 'refused',
      reason: 'PLAN_FINGERPRINT_MISMATCH',
      expected: reviewed.result!.plan_fingerprint,
    });
    expect(out.result!.actual).not.toBe(reviewed.result!.plan_fingerprint);
    expect(out.exitCode).toBe(1);
    expectRolledBackWithoutWrites(out);
  });

  test('a fingerprint from some other plan stops the apply before the first update', () => {
    const out = runTool({ ...cleanShelf(), options: applyOptions({ expectFingerprint: OTHER_FINGERPRINT }) });

    expect(out.result).toMatchObject({ status: 'refused', reason: 'PLAN_FINGERPRINT_MISMATCH', expected: OTHER_FINGERPRINT });
    expectRolledBackWithoutWrites(out);
  });

  test('an update that touches fewer rows than planned rolls back: PLAN_APPLY_COUNT_MISMATCH', () => {
    const out = runTool({ ...cleanShelf(), shortUpdate: 'chunks', options: applyOptions() });

    expect(out.result).toMatchObject({
      status: 'refused', reason: 'PLAN_APPLY_COUNT_MISMATCH', table: 'chunks', planned: 4, updated: 3,
    });
    const all = texts(out);
    expect(all[all.length - 1]).toBe('rollback');
    expect(all).not.toContain('commit');
    expect(all.some((t) => /^insert into pilot\.audit_events/i.test(t))).toBe(false);
  });

  test('an end state that does not add up rolls back: END_STATE_MISMATCH', () => {
    const out = runTool({ ...cleanShelf(), verifyOverride: { chunks_in_to_with_local_document_and_source: 3 }, options: applyOptions() });

    expect(out.result).toMatchObject({ status: 'refused', reason: 'END_STATE_MISMATCH' });
    expect(out.result!.mismatches).toEqual(['chunks_in_to_with_local_document_and_source=3!=4']);
    const all = texts(out);
    expect(all[all.length - 1]).toBe('rollback');
    expect(all).not.toContain('commit');
  });

  // Every end-state check fires on its own. Planned: 3 sources, 3 documents, 4 chunks.
  const verifyCases: Array<[string, number, string]> = [
    ['sources_left_in_from', 1, 'sources_left_in_from=1!=0'],
    ['documents_left_in_from', 1, 'documents_left_in_from=1!=0'],
    ['chunks_left_in_from', 1, 'chunks_left_in_from=1!=0'],
    ['citation_checks_left_in_from', 1, 'citation_checks_left_in_from=1!=0'],
    ['retraction_checks_left_in_from', 1, 'retraction_checks_left_in_from=1!=0'],
    ['sources_in_to', 2, 'sources_in_to=2!=3'],
    ['documents_in_to_with_local_source', 2, 'documents_in_to_with_local_source=2!=3'],
  ];

  test.each(verifyCases)('END_STATE_MISMATCH on %s', (key, value, mismatch) => {
    const out = runTool({ ...cleanShelf(), verifyOverride: { [key]: value }, options: applyOptions() });

    expect(out.result).toMatchObject({ status: 'refused', reason: 'END_STATE_MISMATCH', mismatches: [mismatch] });
    expect(texts(out)).not.toContain('commit');
    expect(texts(out).some((t) => /^insert into pilot\.audit_events/i.test(t))).toBe(false);
  });

  test.each([
    [FROM, 'chunks', `${FROM}.chunks=17!=16`],
    [TO, 'sources', `${TO}.sources=4!=3`],
  ])('END_STATE_MISMATCH when %s.%s does not add up across the move', (org, key, mismatch) => {
    const out = runTool({ ...cleanShelf(), skewAfter: { org, key, delta: 1 }, options: applyOptions() });

    expect(out.result).toMatchObject({ status: 'refused', reason: 'END_STATE_MISMATCH', mismatches: [mismatch] });
    expect(texts(out)).not.toContain('commit');
  });

  test('a database error mid-apply rolls back and surfaces the error', () => {
    const out = runTool({ ...cleanShelf(), failOn: '^update pilot\\.shadow_library_chunks', options: applyOptions() });

    expect(out.ok).toBe(false);
    expect(out.error).toContain('stub: statement failed');
    const all = texts(out);
    expect(all[all.length - 1]).toBe('rollback');
    expect(all).not.toContain('commit');
  });
});

describe('refusals before the database', () => {
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ['no target organization', { toOrganizationId: '' }, 'MISSING_TO_ORG'],
    ['from equals to', { toOrganizationId: FROM }, 'FROM_EQUALS_TO'],
    ['__platform__ as the source', { fromOrganizationId: '__platform__' }, 'PLATFORM_ORGANIZATION_REFUSED'],
    ['__platform__ as the target', { toOrganizationId: '__platform__' }, 'PLATFORM_ORGANIZATION_REFUSED'],
    ['a source type outside the allowlist', { sourceType: 'peer_reviewed' }, 'UNSUPPORTED_SOURCE_TYPE'],
    ['apply with no phrase', { apply: true, confirm: '' }, 'APPLY_WITHOUT_CONFIRM_PHRASE'],
    ['apply with a near-miss phrase', { apply: true, confirm: 'move policy shelf' }, 'APPLY_WITHOUT_CONFIRM_PHRASE'],
    // A truthy non-boolean must not reach the writing transaction.
    ['apply as the string "true", no phrase', { apply: 'true', confirm: '' }, 'INVALID_APPLY'],
    ['apply as the string "true", with phrase and fingerprint',
      { apply: 'true', confirm: PHRASE, expectFingerprint: OTHER_FINGERPRINT }, 'INVALID_APPLY'],
    ['apply as 1', { apply: 1, confirm: PHRASE, expectFingerprint: OTHER_FINGERPRINT }, 'INVALID_APPLY'],
    ['apply with no expected fingerprint', { apply: true, confirm: PHRASE, expectFingerprint: '' }, 'APPLY_WITHOUT_EXPECTED_FINGERPRINT'],
    ['apply with a malformed fingerprint', { apply: true, confirm: PHRASE, expectFingerprint: 'sha256:abc' }, 'INVALID_EXPECTED_FINGERPRINT'],
    ['an unusable row cap', { maxRows: 0 }, 'INVALID_MAX'],
  ];

  test.each(cases)('%s: %s', (_label, override, reason) => {
    const out = runTool({ ...cleanShelf(), options: dryRunOptions(override) });

    expect(out.result).toMatchObject({ status: 'refused', reason });
    expect(out.calls).toEqual([]);
    expect(out.exitCode).toBe(1);
  });

  test('run() plans against ppbf-default-org when no from-organization is given', () => {
    const spec = cleanShelf();
    const out = runTool({
      ...spec,
      organizations: [
        { organization_id: 'ppbf-default-org', organization_name: 'Default', status: 'active' },
        spec.organizations![1],
      ],
      entry: 'run',
      env: {
        AZURE_POSTGRES_CONNECTION_STRING: 'postgres://u:p@stub-host/stub_db',
        PPBF_EXPECTED_POSTGRES_HOSTNAME: 'stub-host',
        PPBF_EXPECTED_POSTGRES_DATABASE: 'stub_db',
        PPBF_POLICY_MOVE_TO_ORG: TO,
      },
    });

    expect(out.result!.status).toBe('dry-run');
    const sourcesSelect = out.calls.find((c) => /^select source_id, title, source_type/i.test(c.text))!;
    expect(sourcesSelect.values![0]).toBe('ppbf-default-org');
    expect(sourcesSelect.values![1]).toBe('internal_policy');
  });

  test('run() refuses bad input before it even creates a client', () => {
    const out = runTool({
      entry: 'run',
      env: {
        AZURE_POSTGRES_CONNECTION_STRING: 'postgres://u:p@stub-host/stub_db',
        PPBF_EXPECTED_POSTGRES_HOSTNAME: 'stub-host',
        PPBF_EXPECTED_POSTGRES_DATABASE: 'stub_db',
        PPBF_POLICY_MOVE_TO_ORG: '',
      },
    });

    expect(out.result).toMatchObject({ status: 'refused', reason: 'MISSING_TO_ORG' });
    expect(out.clientsCreated).toBe(0);
    expect(out.calls).toEqual([]);
  });

  test('run() refuses a connection string that is not the declared target', () => {
    const out = runTool({
      entry: 'run',
      env: {
        AZURE_POSTGRES_CONNECTION_STRING: 'postgres://u:p@some-other-host/stub_db',
        PPBF_EXPECTED_POSTGRES_HOSTNAME: 'stub-host',
        PPBF_EXPECTED_POSTGRES_DATABASE: 'stub_db',
        PPBF_POLICY_MOVE_TO_ORG: TO,
      },
    });

    expect(out.result).toMatchObject({ status: 'refused', reason: 'POSTGRES_TARGET_MISMATCH' });
    expect(out.clientsCreated).toBe(0);
  });

  test('run() refuses with no connection string at all', () => {
    const out = runTool({ entry: 'run', env: { PPBF_POLICY_MOVE_TO_ORG: TO } });

    expect(out.result).toMatchObject({ status: 'refused', reason: 'MISSING_CONNECTION_STRING' });
    expect(out.clientsCreated).toBe(0);
  });

  test('run() applies only for exactly PPBF_POLICY_MOVE_APPLY=true', () => {
    const base = {
      AZURE_POSTGRES_CONNECTION_STRING: 'postgres://u:p@stub-host/stub_db',
      PPBF_EXPECTED_POSTGRES_HOSTNAME: 'stub-host',
      PPBF_EXPECTED_POSTGRES_DATABASE: 'stub_db',
      PPBF_POLICY_MOVE_FROM_ORG: FROM,
      PPBF_POLICY_MOVE_TO_ORG: TO,
      PPBF_POLICY_MOVE_CONFIRM: PHRASE,
      PPBF_POLICY_MOVE_EXPECT_FINGERPRINT: FROM_DRY_RUN,
    };
    const loose = runTool({ ...cleanShelf(), entry: 'run', env: { ...base, PPBF_POLICY_MOVE_APPLY: 'TRUE' } });
    expect(loose.result!.status).toBe('dry-run');
    expect(writes(loose)).toEqual([]);

    const exact = runTool({ ...cleanShelf(), entry: 'run', env: { ...base, PPBF_POLICY_MOVE_APPLY: 'true' } });
    expect(exact.result!.status).toBe('applied');
    expect(exact.clientsCreated).toBe(1);
  });

  test('run() passes PPBF_POLICY_MOVE_EXPECT_FINGERPRINT through, and apply refuses without it', () => {
    const base = {
      AZURE_POSTGRES_CONNECTION_STRING: 'postgres://u:p@stub-host/stub_db',
      PPBF_EXPECTED_POSTGRES_HOSTNAME: 'stub-host',
      PPBF_EXPECTED_POSTGRES_DATABASE: 'stub_db',
      PPBF_POLICY_MOVE_FROM_ORG: FROM,
      PPBF_POLICY_MOVE_TO_ORG: TO,
      PPBF_POLICY_MOVE_CONFIRM: PHRASE,
      PPBF_POLICY_MOVE_APPLY: 'true',
    };

    const none = runTool({ ...cleanShelf(), entry: 'run', env: base });
    expect(none.result).toMatchObject({ status: 'refused', reason: 'APPLY_WITHOUT_EXPECTED_FINGERPRINT' });
    expect(none.clientsCreated).toBe(0);

    const other = runTool({ ...cleanShelf(), entry: 'run', env: { ...base, PPBF_POLICY_MOVE_EXPECT_FINGERPRINT: OTHER_FINGERPRINT } });
    expect(other.result).toMatchObject({ status: 'refused', reason: 'PLAN_FINGERPRINT_MISMATCH', expected: OTHER_FINGERPRINT });
    expect(writes(other)).toEqual([]);

    // Surrounding whitespace from a pasted value is not a different fingerprint.
    const dry = runTool({ ...cleanShelf(), entry: 'run', env: { ...base, PPBF_POLICY_MOVE_APPLY: 'false' } });
    const padded = runTool({
      ...cleanShelf(), entry: 'run', env: { ...base, PPBF_POLICY_MOVE_EXPECT_FINGERPRINT: ` ${dry.result!.plan_fingerprint} ` },
    });
    expect(padded.result!.status).toBe('applied');
  });

  test('the command line refuses a missing target and exits 1 without connecting', () => {
    const child = spawnSync(process.execPath, [SCRIPT_PATH], {
      encoding: 'utf8',
      cwd: __dirname,
      env: {
        NODE_ENV: 'test',
        PATH: process.env.PATH ?? '',
        SystemRoot: process.env.SystemRoot ?? '',
        AZURE_POSTGRES_CONNECTION_STRING: '',
        PPBF_POLICY_MOVE_TO_ORG: '',
      },
    });

    expect(child.status).toBe(1);
    expect(child.stderr).toContain('library.policy_move.refused');
    expect(child.stderr).toContain('MISSING_TO_ORG');
  });
});

describe('refusals inside the transaction roll back with nothing written', () => {
  test('an organization that does not exist: ORGANIZATION_NOT_FOUND', () => {
    const spec = cleanShelf();
    const out = runTool({ ...spec, organizations: spec.organizations!.slice(0, 1), options: applyOptions() });

    expect(out.result).toMatchObject({ status: 'refused', reason: 'ORGANIZATION_NOT_FOUND', missing: [TO] });
    expectRolledBackWithoutWrites(out);
  });

  const blockerCases: Array<[string, (spec: Spec) => Spec]> = [
    ['NOTHING_TO_MOVE', (s) => ({ ...s, sources: [], documents: [], chunks: [], citationChecks: [], retractionChecks: [] })],
    ['CROSS_TENANT_ROWS', (s) => ({
      ...s,
      chunks: [...s.chunks!, { chunk_id: 'ch-elsewhere', document_id: 'doc-authority', source_id: 'pol-authority', organization_id: '__platform__', subject_id: null }],
    })],
    ['CROSS_TENANT_ROWS', (s) => ({
      ...s,
      documents: [...s.documents!, { document_id: 'doc-elsewhere', source_id: 'pol-a', organization_id: '__platform__', subject_id: null, content_sha256: 'sha-x' }],
    })],
    ['CROSS_TENANT_ROWS', (s) => ({
      ...s, citationChecks: [...s.citationChecks!, { organization_id: '__platform__', check_id: 'cc-elsewhere', source_id: 'pol-a' }],
    })],
    ['CROSS_TENANT_ROWS', (s) => ({
      ...s, retractionChecks: [...s.retractionChecks!, { organization_id: '__platform__', retraction_check_id: 'rc-elsewhere', source_id: 'pol-a' }],
    })],
    ['CLOSURE_BROKEN', (s) => ({
      ...s,
      chunks: [...s.chunks!, { chunk_id: 'ch-stray', document_id: 'doc-not-moving', source_id: 'pol-a', organization_id: FROM, subject_id: null }],
    })],
    ['EVIDENCE_ITEMS_CITE_ROWS', (s) => ({ ...s, evidenceItems: 1 })],
    ['RESEARCH_SUBMISSIONS_REFERENCE_ROWS', (s) => ({
      ...s, submissions: [{ organization_id: FROM, submission_id: 'sub-1', source_id: 'pol-a', document_id: null }],
    })],
    ['RABBIT_HOLES_WOULD_LOSE_CITATION', (s) => ({
      ...s, rabbitHoles: [{ organization_id: FROM, rabbit_hole_id: 'rh-1', library_document_id: 'doc-authority', status: 'published' }],
    })],
    ['SUBJECT_SCOPED_ROWS', (s) => ({
      ...s, documents: s.documents!.map((d, i) => (i === 0 ? { ...d, subject_id: 'athlete-1' } : d)),
    })],
    ['SUBJECT_SCOPED_ROWS', (s) => ({
      ...s, chunks: s.chunks!.map((c, i) => (i === 0 ? { ...c, subject_id: 'athlete-1' } : c)),
    })],
    ['TARGET_ORG_COLLISION', (s) => ({ ...s, collisions: { sourceUrls: [{ source_id: 'gym-own', url: 'https://ex.test/a' }] } })],
    ['TARGET_ORG_COLLISION', (s) => ({ ...s, collisions: { documentShas: [{ document_id: 'gym-doc', content_sha256: 'sha-track-1' }] } })],
    ['TARGET_ORG_COLLISION', (s) => ({ ...s, collisions: { citationIds: [{ check_id: 'cc-1' }] } })],
    ['TARGET_ORG_COLLISION', (s) => ({ ...s, collisions: { retractionIds: [{ retraction_check_id: 'rc-1' }] } })],
  ];

  test.each(blockerCases)('%s', (code, shape) => {
    const out = runTool({ ...shape(cleanShelf()), options: applyOptions() });

    expect(out.result).toMatchObject({ status: 'refused', reason: 'PLAN_BLOCKED' });
    expect(blockerCodes(out.result)).toContain(code);
    expectRolledBackWithoutWrites(out);
  });

  test('BLAST_RADIUS_EXCEEDED', () => {
    const out = runTool({ ...cleanShelf(), options: applyOptions({ maxRows: 11 }) });

    expect(out.result!.blockers).toEqual([{ code: 'BLAST_RADIUS_EXCEEDED', moving: 12, max: 11 }]);
    expectRolledBackWithoutWrites(out);
  });

  test('a lesson IN the target citing a moving document is not a blocker', () => {
    const out = runTool({
      ...cleanShelf(),
      rabbitHoles: [{ organization_id: TO, rabbit_hole_id: 'rh-2', library_document_id: 'doc-authority', status: 'published' }],
      options: applyOptions(),
    });

    expect(out.result!.status).toBe('applied');
  });
});

describe('the workflow', () => {
  const workflow = fs.readFileSync(WORKFLOW_PATH, 'utf8').replace(/\r\n/g, '\n');

  function inputBlock(name: string): string {
    const start = workflow.search(new RegExp(`^      ${name}:\\s*$`, 'm'));
    expect(start).toBeGreaterThan(-1);
    const rest = workflow.slice(start + 1);
    const next = rest.search(/^ {6}\S|^\S/m);
    return next === -1 ? rest : rest.slice(0, next);
  }

  test('mode defaults to dry-run', () => {
    expect(inputBlock('mode')).toMatch(/default: dry-run/);
  });

  test('to_organization_id is required and has no default', () => {
    const block = inputBlock('to_organization_id');
    expect(block).toMatch(/required: true/);
    expect(block).not.toMatch(/default:/);
  });

  test('from_organization_id defaults to ppbf-default-org', () => {
    expect(inputBlock('from_organization_id')).toMatch(/default: ppbf-default-org/);
  });

  test('source_type offers internal_policy and nothing else', () => {
    const options = inputBlock('source_type').split('\n').filter((l) => /^\s+- /.test(l)).map((l) => l.trim());
    expect(options).toEqual(['- internal_policy']);
  });

  test('the job runs in the environment named by target (where production is approved)', () => {
    expect(workflow).toMatch(/^ {4}environment: \$\{\{ inputs\.target \}\}$/m);
  });

  test('expected_fingerprint is optional for a dry run, and apply refuses without a well-formed one', () => {
    const block = inputBlock('expected_fingerprint');
    expect(block).toMatch(/required: false/);
    expect(block).not.toMatch(/default:/);
    expect(workflow).toContain(
      '[ "$MODE" = "apply" ] && [[ ! "$EXPECTED_FINGERPRINT" =~ ^sha256:[0-9a-f]{64}$ ]]',
    );
    // The same shape the script accepts.
    const script = fs.readFileSync(SCRIPT_PATH, 'utf8');
    expect(script).toContain('export const FINGERPRINT_PATTERN = /^sha256:[0-9a-f]{64}$/;');
    expect(workflow).toMatch(/^ {10}PPBF_POLICY_MOVE_EXPECT_FINGERPRINT: \$\{\{ inputs\.expected_fingerprint \}\}$/m);
  });

  test('apply needs the same phrase the script checks, and the target retyped', () => {
    const script = fs.readFileSync(SCRIPT_PATH, 'utf8');
    expect(script).toContain(`export const CONFIRM_PHRASE = '${PHRASE}';`);
    expect(workflow).toContain(`[ "$CONFIRM_MOVE" != "${PHRASE}" ]`);
    expect(workflow).toContain('[ "$TARGET" != "$CONFIRM_TARGET" ]');
    expect(workflow).toMatch(/PPBF_POLICY_MOVE_APPLY: \$\{\{ inputs\.mode == 'apply' \}\}/);
    expect(workflow).toMatch(/PPBF_POLICY_MOVE_CONFIRM: \$\{\{ inputs\.confirm_move \}\}/);
  });

  test('free-text inputs reach the shell only through env, never interpolated into run blocks', () => {
    const offenders = workflow.split('\n').filter((line) => (
      /\$\{\{\s*inputs\.(from_organization_id|to_organization_id|confirm_move|confirm_target|expected_fingerprint)\s*\}\}/.test(line)
      && !/^\s+[A-Z_]+: \$\{\{\s*inputs\.\w+\s*\}\}\s*$/.test(line)
    ));
    expect(offenders).toEqual([]);
  });

  test('the npm script the workflow runs exists', () => {
    const pkg = JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, 'utf8')) as { scripts: Record<string, string> };
    expect(workflow).toContain('npm run pilot:move-policy-shelf');
    expect(pkg.scripts['pilot:move-policy-shelf']).toBe('node scripts/pilot-move-policy-shelf.mjs');
  });

  test('the script never reads a local env file (apps/web/.env.local points at production)', () => {
    const script = fs.readFileSync(SCRIPT_PATH, 'utf8');
    expect(script).not.toMatch(/loadEnvLocal|dotenv|readFile/);
  });
});
