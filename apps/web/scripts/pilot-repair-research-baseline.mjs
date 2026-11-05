#!/usr/bin/env node

/**
 * Repairs the research baseline a database imported and approved before the
 * 2026-08-07 corpus was corrected: repoints mis-cited and duplicate claims to
 * their real paper, retires the wrong-paper and duplicate sources, sets the
 * tiers and citation metadata the corrected seed carries, and writes the
 * chunk texts corrected since the import.
 *
 * WHY THIS EXISTS
 *
 * Production imported the corpus into the platform baseline (organization
 * `__platform__`) and approved it on 2026-08-13. The seed was repaired after
 * that (#1008 and its follow-up), so the corrections live in the repository
 * and not in production. Re-running the importer cannot carry them: it upserts
 * `approval_state` from the seed, and shadow_library_sources_review_pair_check
 * refuses a pending row that still holds approval stamps -- it fails closed
 * rather than switching SHADOW's evidence off. Jason said yes to a tool for
 * this (2026-09-29, Q1), modelled on the gated workflows.
 *
 * WHAT IT DOES, AND WHERE EACH VALUE COMES FROM
 *
 * Nothing about the repair is decided here.
 *   - WHICH rows: the committed logs in
 *     seed-data/shadow-research/2026-08-07/repairs/ (2026-09-28_repair_log.csv,
 *     then 2026-09-29_followup_log.csv), exactly as validated, and
 *     2026-11-05_text_correction_log.csv for the chunk texts corrected after
 *     the 2026-09-30 production run (Jason 2026-11-05, "Yes, build it").
 *   - WHAT each row ends as: the committed seed CSVs, read through the
 *     importer's own loadSeedPackage with the platform_baseline scope ("the
 *     seed files are the authority", the rescope precedent).
 *   - WHAT each row holds before: repairs/pre_repair_values.csv, the value
 *     every field the repair changes held in the seed production imported
 *     (commit 95f3c79e). researchRepairPlan.test.ts re-derives it from that
 *     commit on every CI run.
 *
 * For every listed row it manages these fields, and only these:
 *   source   status, authority_tier, metadata.<key> for MANAGED_METADATA_KEYS
 *   chunk    source_id, metadata.<key> for MANAGED_METADATA_KEYS
 *   chunk    text_content, only for a chunk the text-correction log names
 * Every other column and every other metadata key is left exactly as it is
 * (metadata is edited with jsonb `-` and `||`, never replaced).
 *
 *   text      a corrected chunk's text_content is set to the seed's text, only
 *             where it still holds the imported text (the pre-repair value).
 *             Only those rows are updated, so the full-text rights trigger
 *             (shadow_library_chunk_rights_guard, which fires on any UPDATE
 *             that names text_content) runs on them alone, and the dry run
 *             reports a TEXT_NOT_PERMITTED blocker before it would refuse.
 *             The chunk's embedding is left as it is: the corrections are a
 *             name, a year and a clause, and the only re-embedding tool
 *             (pilot-backfill-chunk-embeddings.mjs) has no workflow.
 *             Text-only rows are not repoint targets: their source's review
 *             state is not checked here.
 *
 *   repoint   a chunk on a wrong-paper or duplicate source moves to the source
 *             the seed puts it on. FIRST: chunks -> sources is ON DELETE
 *             CASCADE, and a claim must never sit on a retired row.
 *   retire    status = 'archived' (Jason, Q2). approval_state,
 *             verification_state and the four approval stamps are NOT
 *             touched: setting approval_state = 'rejected' on an approved row
 *             breaks shadow_library_sources_review_pair_check, which is why
 *             the algorithm lane's SQL could not run. Retrieval, coverage and
 *             rabbit holes all require status = 'active', so an archived row
 *             drops out of every answer. Nothing is deleted, ever.
 *   retier    authority_tier on the source row AND metadata.authority_tier /
 *             metadata.evidence_tier on its chunks (Jason, Q3/Q4: both
 *             places). Runtime grades a claim on the source row's tier.
 *   metadata  citation_repair, verified_title, misresolved_verified_title,
 *             verification_status, tier_conflict, merged_duplicate_source_ids
 *             set to the seed's value; a key the seed removed is removed.
 *   updated_at = now() on every row touched.
 *
 * STATE, DECIDED PER FIELD (the lane SQL's preconditions, made exact)
 *
 *   pending   current value = the pre-repair value
 *   done      current value = the seed's value
 *   drifted   neither
 * and the whole run is one of
 *   PRE_REPAIR  every change pending            -> apply repairs
 *   PARTIAL     some pending, some done          -> apply resumes (safe)
 *   REPAIRED    every change done                -> apply writes nothing
 *   DRIFTED     any field drifted, a listed row missing or outside
 *               __platform__, a repoint target not live (status active,
 *               approved, verified, not suppressed), a chunk or document
 *               NOT in the plan sitting on a source it would retire, a
 *               pending text correction the rights trigger would refuse
 *               (TEXT_NOT_PERMITTED)
 *                                                -> apply refuses
 *
 *   SCOPE           organization `__platform__` only, fixed, not an input.
 *                   A listed id found in any other organization is a blocker,
 *                   and every UPDATE is scoped to `__platform__`. One
 *                   exception, also fixed: a CORRECT_CHUNK_TEXT row names its
 *                   chunk's organization, `__platform__` or the gym's
 *                   `punxsy_prominence` (TEXT_ORGANIZATIONS), in the committed
 *                   log; the chunk must be found there, and its UPDATE is
 *                   scoped to it.
 *   TARGET GUARD    PPBF_EXPECTED_POSTGRES_HOSTNAME / _DATABASE must match the
 *                   connection string (scripts/lib/postgres-write-target.mjs).
 *   READ-ONLY BY    A plain run opens `begin transaction read only`, prints the
 *   DEFAULT         state, the counts, the blockers and a plan fingerprint, and
 *                   rolls back. That is the production precondition check.
 *   REVIEWED PLAN   Apply needs PPBF_RESEARCH_REPAIR_APPLY=true, the phrase in
 *   ONLY            PPBF_RESEARCH_REPAIR_CONFIRM, and
 *                   PPBF_RESEARCH_REPAIR_EXPECT_FINGERPRINT set to the
 *                   plan_fingerprint of the dry run that was reviewed. The
 *                   fingerprint covers every planned row id, its target value
 *                   and the value the database holds now, so anything that
 *                   changed since the review stops the apply before its first
 *                   update.
 *   ONE TRANSACTION Plans with the rows locked (FOR UPDATE, lock_timeout),
 *                   writes, checks each UPDATE touched exactly the planned
 *                   rows, re-reads the end state (every field done, 0 chunks on
 *                   an archived source, every target live, review columns
 *                   unchanged) and only then commits, with one
 *                   pilot.audit_events row.
 *
 * It never reads a local env file: the connection string must come from the
 * environment, which in practice means the repair-research-baseline workflow.
 *
 * Usage (from the workflow):
 *   npm run pilot:repair-research-baseline
 *   PPBF_RESEARCH_REPAIR_APPLY=true \
 *     PPBF_RESEARCH_REPAIR_CONFIRM='REPAIR RESEARCH BASELINE' \
 *     PPBF_RESEARCH_REPAIR_EXPECT_FINGERPRINT='sha256:<from the dry run>' \
 *     npm run pilot:repair-research-baseline
 */

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse } from 'csv-parse/sync';
import pg from 'pg';

import { DEFAULT_SEED_DIR, loadSeedPackage } from './import-shadow-research.mjs';
import { assertDeclaredWriteTargetFromEnv } from './lib/postgres-write-target.mjs';

export const PLATFORM_ORGANIZATION_ID = '__platform__';
// The gym's policy shelf, moved out of the baseline on 2026-10-17
// (move-policy-shelf, OD-2026-09-28-011 item 6). A text correction may name it
// (Jason 2026-11-05, "A: All four, one run (Recommended)"); nothing else may.
export const GYM_ORGANIZATION_ID = 'punxsy_prominence';
export const TEXT_ORGANIZATIONS = Object.freeze([PLATFORM_ORGANIZATION_ID, GYM_ORGANIZATION_ID]);
export const CONFIRM_PHRASE = 'REPAIR RESEARCH BASELINE';
export const FINGERPRINT_PATTERN = /^sha256:[0-9a-f]{64}$/;
export const DEFAULT_REPAIR_DIR = path.join(DEFAULT_SEED_DIR, 'repairs');
// Applied in this order; a chunk may be moved by only one of them.
export const REPAIR_LOG_FILES = Object.freeze([
  '2026-09-28_repair_log.csv',
  '2026-09-29_followup_log.csv',
  '2026-11-05_text_correction_log.csv',
]);
export const PRE_REPAIR_VALUES_FILE = 'pre_repair_values.csv';
export const LIVE_STATUS = 'active';
export const RETIRED_STATUS = 'archived';
export const MANAGED_METADATA_KEYS = Object.freeze([
  'authority_tier',
  'citation_repair',
  'evidence_tier',
  'merged_duplicate_source_ids',
  'misresolved_verified_title',
  'tier_conflict',
  'verification_status',
  'verified_title',
]);
export const SOURCE_FIELDS = Object.freeze(['status', 'authority_tier', ...MANAGED_METADATA_KEYS.map((k) => `metadata.${k}`)]);
export const CHUNK_FIELDS = Object.freeze(['source_id', ...MANAGED_METADATA_KEYS.map((k) => `metadata.${k}`)]);
// Managed only on a chunk a CORRECT_CHUNK_TEXT row names.
export const TEXT_FIELD = 'text_content';
// The rights a document's source needs for its chunks to hold full text
// (pilot_slice_postgres_source_rights_migration.sql).
export const FULL_TEXT_RIGHTS = Object.freeze(['ppbf_owned', 'open_licence']);
export const ACTIONS = Object.freeze(['repoint', 'retire', 'retier', 'metadata', 'text']);
// The claim the runbook spot-checks: after the repair it cites "Quantifying
// head impacts and neurocognitive performance in collegiate boxers".
export const SPOT_CHECK_CLAIM_ID = 'A2-076';

const KNOWN_LOG_ACTIONS = new Set([
  'REPOINT_MISRESOLVED', 'MERGE_DUPLICATE', 'DELETE_DEAD_BOGUS_SOURCE',
  'SET_TIER_BY_SPEC', 'CLEAR_MISRESOLVED_VERIFIED_TITLE', 'CORRECT_CHUNK_TEXT',
]);
const RETIRING_LOG_ACTIONS = new Set(['MERGE_DUPLICATE', 'DELETE_DEAD_BOGUS_SOURCE']);
const MOVING_LOG_ACTIONS = new Set(['REPOINT_MISRESOLVED', 'MERGE_DUPLICATE']);
const REVIEW_COLUMNS = Object.freeze([
  'approval_state', 'verification_state', 'approved_by_account_id', 'approved_at',
  'verified_by_account_id', 'verified_at',
]);
const EVENT_PREFIX = 'library.research_repair';
const SAMPLE_LIMIT = 25;

function defaultLog(event, payload) {
  const line = JSON.stringify({ event: `${EVENT_PREFIX}.${event}`, ...payload }, null, event === 'plan' ? 2 : 0);
  if (event === 'refused' || event === 'failed') console.error(line);
  else console.log(line);
}

/**
 * JSON text with object keys sorted, so a value read back from jsonb (which
 * reorders keys) compares equal to the same value parsed from a CSV. Every
 * planned value is carried in this form; `null` (not the text 'null') means
 * the metadata key is absent.
 */
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

/** A row's value for one managed field, in the plan's form. */
export function fieldValue(row, field) {
  if (field.startsWith('metadata.')) {
    const key = field.slice('metadata.'.length);
    const metadata = row.metadata ?? {};
    return Object.prototype.hasOwnProperty.call(metadata, key) ? canonicalJson(metadata[key]) : null;
  }
  if (field === 'authority_tier') return canonicalJson(Number(row.authority_tier));
  return canonicalJson(row[field] ?? null);
}

/** Which of the four repair actions a field belongs to. */
export function actionOf(table, field) {
  if (table === 'chunk' && field === 'source_id') return 'repoint';
  if (table === 'chunk' && field === TEXT_FIELD) return 'text';
  if (table === 'source' && field === 'status') return 'retire';
  if (field === 'authority_tier' || field === 'metadata.authority_tier' || field === 'metadata.evidence_tier') {
    return 'retier';
  }
  return 'metadata';
}

function splitList(value) {
  return value ? String(value).split('|').filter(Boolean) : [];
}

/**
 * The plan, from the files alone -- no database. Pure, so the fast guard and
 * the stub test can build one from small inputs.
 *
 *   seedSources / seedChunks  rows as loadSeedPackage returns them (the
 *                             platform_baseline scope)
 *   logs                      [{ name, rows }] in apply order
 *   preRepairValues           rows of pre_repair_values.csv
 *   policySeedChunks          chunk rows of the ppbf_policy scope, where a
 *                             text correction naming the gym finds its text
 *
 * Throws PLAN_INVALID with every problem when the files disagree with each
 * other -- a plan that is not internally true is not run.
 */
export function buildRepairPlan({ seedSources, seedChunks, logs, preRepairValues, policySeedChunks = [] }) {
  const problems = [];
  const seedSourceById = new Map(seedSources.map((row) => [row.source_id, row]));
  const seedChunkById = new Map(seedChunks.map((row) => [row.chunk_id, row]));

  const listedSources = new Set();
  const listedChunks = new Set();
  const retiring = new Set();
  const moves = new Map(); // chunk_id -> { from, to, log, action }
  const tierRows = [];
  const clearRows = [];
  const textChunks = new Map(); // chunk id a CORRECT_CHUNK_TEXT row names -> its organization

  for (const { name, rows } of logs) {
    for (const row of rows) {
      if (!KNOWN_LOG_ACTIONS.has(row.action)) {
        problems.push(`UNKNOWN_ACTION:${name}:${row.action}`);
        continue;
      }
      // A text correction names exactly one chunk and its organization, and
      // nothing else: it moves, retires and retiers nothing, so it is kept out
      // of the listed rows.
      if (row.action === 'CORRECT_CHUNK_TEXT') {
        const ids = splitList(row.chunk_id);
        if (ids.length !== 1 || row.source_id || row.target_source_id) {
          problems.push(`TEXT_ROW_MALFORMED:${name}:${row.chunk_id ?? ''}`);
        }
        if (!TEXT_ORGANIZATIONS.includes(row.organization_id)) {
          problems.push(`TEXT_ORGANIZATION_NOT_ALLOWED:${row.chunk_id ?? ''}:${row.organization_id ?? ''}`);
        }
        for (const chunkId of ids) {
          if (textChunks.has(chunkId)) problems.push(`CHUNK_TEXT_CORRECTED_TWICE:${chunkId}`);
          textChunks.set(chunkId, row.organization_id);
        }
        continue;
      }
      if (row.source_id) listedSources.add(row.source_id);
      if (row.target_source_id) listedSources.add(row.target_source_id);
      if (RETIRING_LOG_ACTIONS.has(row.action)) {
        if (retiring.has(row.source_id)) problems.push(`SOURCE_RETIRED_TWICE:${row.source_id}`);
        retiring.add(row.source_id);
      }
      for (const chunkId of splitList(row.chunk_id)) {
        listedChunks.add(chunkId);
        if (MOVING_LOG_ACTIONS.has(row.action)) {
          if (moves.has(chunkId)) problems.push(`CHUNK_MOVED_TWICE:${chunkId}`);
          moves.set(chunkId, { from: row.source_id, to: row.target_source_id, log: name, action: row.action });
        }
      }
      if (row.action === 'SET_TIER_BY_SPEC') tierRows.push(row);
      if (row.action === 'CLEAR_MISRESOLVED_VERIFIED_TITLE') clearRows.push(row);
    }
  }

  const before = new Map(); // `${table}|${id}|${field}` -> canonical JSON or null
  for (const row of preRepairValues) {
    const table = row.table;
    if (table === 'chunk' && row.field === TEXT_FIELD) {
      if (!textChunks.has(row.row_id)) problems.push(`PRE_REPAIR_TEXT_FOR_UNCORRECTED_CHUNK:${row.row_id}`);
    } else {
      const known = table === 'source' ? SOURCE_FIELDS : table === 'chunk' ? CHUNK_FIELDS : null;
      if (!known || !known.includes(row.field)) {
        problems.push(`PRE_REPAIR_VALUE_UNKNOWN_FIELD:${table}:${row.row_id}:${row.field}`);
        continue;
      }
      const listed = table === 'source' ? listedSources : listedChunks;
      if (!listed.has(row.row_id)) problems.push(`PRE_REPAIR_VALUE_FOR_UNLISTED_ROW:${table}:${row.row_id}`);
    }
    const key = `${table}|${row.row_id}|${row.field}`;
    if (before.has(key)) problems.push(`PRE_REPAIR_VALUE_TWICE:${key}`);
    before.set(key, row.before_json === '' ? null : canonicalJson(JSON.parse(row.before_json)));
  }

  const sources = [];
  for (const sourceId of [...listedSources].sort()) {
    if (retiring.has(sourceId)) {
      if (seedSourceById.has(sourceId)) problems.push(`RETIRED_SOURCE_STILL_IN_SEED:${sourceId}`);
      const statusBefore = before.get(`source|${sourceId}|status`);
      if (statusBefore !== canonicalJson(LIVE_STATUS)) problems.push(`RETIRED_SOURCE_NOT_ACTIVE_BEFORE:${sourceId}`);
      for (const field of SOURCE_FIELDS.filter((f) => f !== 'status')) {
        if (before.has(`source|${sourceId}|${field}`)) problems.push(`PRE_REPAIR_VALUE_ON_RETIRED_SOURCE:${sourceId}:${field}`);
      }
      sources.push({
        source_id: sourceId,
        retire: true,
        fields: [{ field: 'status', before: canonicalJson(LIVE_STATUS), after: canonicalJson(RETIRED_STATUS) }],
      });
      continue;
    }
    const seedRow = seedSourceById.get(sourceId);
    if (!seedRow) {
      problems.push(`LISTED_SOURCE_NOT_IN_PLATFORM_SEED:${sourceId}`);
      continue;
    }
    sources.push({
      source_id: sourceId,
      retire: false,
      fields: SOURCE_FIELDS.map((field) => {
        const after = fieldValue(seedRow, field);
        const key = `source|${sourceId}|${field}`;
        return { field, before: before.has(key) ? before.get(key) : after, after };
      }),
    });
  }

  const chunks = [];
  const liveSources = new Set();
  for (const chunkId of [...listedChunks].sort()) {
    const seedRow = seedChunkById.get(chunkId);
    if (!seedRow) {
      problems.push(`LISTED_CHUNK_NOT_IN_PLATFORM_SEED:${chunkId}`);
      continue;
    }
    if (retiring.has(seedRow.source_id)) problems.push(`CHUNK_TARGET_IS_RETIRED:${chunkId}:${seedRow.source_id}`);
    if (!seedSourceById.has(seedRow.source_id)) problems.push(`CHUNK_TARGET_NOT_IN_SEED:${chunkId}:${seedRow.source_id}`);
    liveSources.add(seedRow.source_id);
    const fields = CHUNK_FIELDS.map((field) => {
      const after = fieldValue(seedRow, field);
      const key = `chunk|${chunkId}|${field}`;
      return { field, before: before.has(key) ? before.get(key) : after, after };
    });
    const move = moves.get(chunkId);
    const sourceField = fields.find((f) => f.field === 'source_id');
    if (move) {
      if (sourceField.before !== canonicalJson(move.from)) {
        problems.push(`MOVE_FROM_DISAGREES_WITH_PRE_REPAIR_VALUE:${chunkId}:${move.from}`);
      }
      if (sourceField.before === sourceField.after) problems.push(`MOVED_CHUNK_NOT_MOVED_IN_SEED:${chunkId}`);
      // The log is the reviewed plan: the chunk lands where the log says, and
      // the seed must say the same, or the tool would write a destination
      // nobody reviewed (a rebase onto a changed seed is when they drift).
      if (sourceField.after !== canonicalJson(move.to)) {
        problems.push(`MOVE_TO_DISAGREES_WITH_SEED:${chunkId}:${move.to}`);
      }
    } else if (sourceField.before !== sourceField.after) {
      problems.push(`CHUNK_MOVED_WITHOUT_A_LOG_ROW:${chunkId}`);
    }
    chunks.push({ chunk_id: chunkId, organization_id: PLATFORM_ORGANIZATION_ID, fields });
  }

  // Text corrections: the seed's text replaces the imported text, which
  // pre_repair_values.csv must state (it is the precondition). The seed row is
  // looked up in the scope of the organization the log names, so a row cannot
  // name the gym for a platform chunk or the other way round. A chunk the
  // other logs also list keeps its fields and gains this one.
  const policySeedChunkById = new Map(policySeedChunks.map((row) => [row.chunk_id, row]));
  for (const [chunkId, organizationId] of [...textChunks].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const seedRow = organizationId === GYM_ORGANIZATION_ID
      ? policySeedChunkById.get(chunkId)
      : organizationId === PLATFORM_ORGANIZATION_ID ? seedChunkById.get(chunkId) : undefined;
    if (!seedRow) {
      problems.push(`CORRECTED_CHUNK_NOT_IN_ITS_ORGANIZATION_SEED:${chunkId}:${organizationId ?? ''}`);
      continue;
    }
    const key = `chunk|${chunkId}|${TEXT_FIELD}`;
    if (!before.has(key) || before.get(key) === null) {
      problems.push(`CORRECTED_TEXT_WITHOUT_PRE_REPAIR_VALUE:${chunkId}`);
      continue;
    }
    const field = { field: TEXT_FIELD, before: before.get(key), after: fieldValue(seedRow, TEXT_FIELD) };
    const listed = chunks.find((c) => c.chunk_id === chunkId);
    if (listed) listed.fields.push(field);
    else chunks.push({ chunk_id: chunkId, organization_id: organizationId, fields: [field] });
  }
  chunks.sort((a, b) => (a.chunk_id < b.chunk_id ? -1 : a.chunk_id > b.chunk_id ? 1 : 0));

  const sourceById = new Map(sources.map((s) => [s.source_id, s]));
  const chunkById = new Map(chunks.map((c) => [c.chunk_id, c]));
  for (const row of tierRows) {
    const plan = sourceById.get(row.source_id);
    const tier = plan?.fields.find((f) => f.field === 'authority_tier');
    if (!tier) {
      problems.push(`SET_TIER_SOURCE_NOT_PLANNED:${row.source_id}`);
      continue;
    }
    if (tier.after !== canonicalJson(Number(row.tier_to))) problems.push(`SET_TIER_DISAGREES_WITH_SEED:${row.source_id}`);
    if (tier.before !== canonicalJson(Number(row.tier_before_1008))) {
      problems.push(`SET_TIER_DISAGREES_WITH_PRE_REPAIR_VALUE:${row.source_id}`);
    }
  }
  for (const row of clearRows) {
    const title = sourceById.get(row.source_id)?.fields.find((f) => f.field === 'metadata.verified_title');
    if (!title) {
      problems.push(`CLEARED_SOURCE_NOT_PLANNED:${row.source_id}`);
      continue;
    }
    if (title.before !== canonicalJson(row.verified_title_from) || title.after !== null) {
      problems.push(`CLEARED_TITLE_DISAGREES:${row.source_id}`);
    }
  }
  for (const key of before.keys()) {
    const [table, id, field] = key.split('|');
    const owner = table === 'source' ? sourceById.get(id) : chunkById.get(id);
    const planned = owner?.fields.find((f) => f.field === field);
    if (planned && planned.before === planned.after) problems.push(`PRE_REPAIR_VALUE_EQUALS_SEED:${key}`);
  }

  if (problems.length > 0) {
    const error = new Error(`PLAN_INVALID: ${problems.slice(0, 20).join('; ')}${problems.length > 20 ? ` (+${problems.length - 20} more)` : ''}`);
    error.problems = problems;
    throw error;
  }

  const expected = Object.fromEntries(ACTIONS.map((action) => [action, { fields: 0, sources: 0, chunks: 0 }]));
  for (const [table, rows] of [['source', sources], ['chunk', chunks]]) {
    for (const row of rows) {
      const touched = new Set();
      for (const f of row.fields) {
        if (f.before === f.after) continue;
        const action = actionOf(table, f.field);
        expected[action].fields += 1;
        touched.add(action);
      }
      for (const action of touched) expected[action][table === 'source' ? 'sources' : 'chunks'] += 1;
    }
  }

  return {
    organizationId: PLATFORM_ORGANIZATION_ID,
    sources,
    chunks,
    retireIds: sources.filter((s) => s.retire).map((s) => s.source_id),
    liveSources: [...liveSources].sort(),
    textChunkIds: [...textChunks.keys()].sort(),
    expected,
  };
}

async function readCsvFile(file) {
  const bytes = await fs.readFile(file);
  return {
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    rows: parse(bytes.toString('utf8'), { bom: true, columns: true, skip_empty_lines: true }),
  };
}

/** Reads the committed files and builds the plan. */
export async function loadRepairPlan({ seedDir = DEFAULT_SEED_DIR, repairDir } = {}) {
  const dir = repairDir ?? path.join(seedDir, 'repairs');
  const seed = await loadSeedPackage({
    seedDir,
    organizationId: PLATFORM_ORGANIZATION_ID,
    // Only fills the seed's created_by placeholder, which this tool never writes.
    accountId: 'research-repair-plan',
    scope: 'platform_baseline',
  });
  // The gym's shelf, for text corrections that name it. Same files, other scope.
  const policySeed = await loadSeedPackage({
    seedDir,
    organizationId: GYM_ORGANIZATION_ID,
    accountId: 'research-repair-plan',
    scope: 'ppbf_policy',
  });
  const logs = [];
  const files = {};
  for (const name of REPAIR_LOG_FILES) {
    const { sha256, rows } = await readCsvFile(path.join(dir, name));
    logs.push({ name, rows });
    files[name] = { sha256, rows: rows.length };
  }
  const values = await readCsvFile(path.join(dir, PRE_REPAIR_VALUES_FILE));
  files[PRE_REPAIR_VALUES_FILE] = { sha256: values.sha256, rows: values.rows.length };
  for (const name of ['seed_shadow_library_sources.csv', 'seed_shadow_library_chunks.csv']) {
    const bytes = await fs.readFile(path.join(seedDir, name));
    files[name] = { sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
  }
  const plan = buildRepairPlan({
    seedSources: seed.sources, seedChunks: seed.chunks, logs, preRepairValues: values.rows,
    policySeedChunks: policySeed.chunks,
  });
  return { ...plan, files };
}

/**
 * Pure input checks. Returns null when the options are usable, otherwise
 * `{ reason }`. Runs before any database statement.
 */
export function validateRepairOptions(options) {
  const { apply, confirm, expectFingerprint } = options ?? {};
  // Only a real boolean decides the mode. A truthy string would otherwise skip
  // the phrase check below and still open a writing transaction.
  if (apply !== undefined && typeof apply !== 'boolean') return { reason: 'INVALID_APPLY' };
  if (apply === true && confirm !== CONFIRM_PHRASE) return { reason: 'APPLY_WITHOUT_CONFIRM_PHRASE' };
  if (apply === true && !expectFingerprint) return { reason: 'APPLY_WITHOUT_EXPECTED_FINGERPRINT' };
  if (apply === true && !FINGERPRINT_PATTERN.test(String(expectFingerprint))) {
    return { reason: 'INVALID_EXPECTED_FINGERPRINT' };
  }
  return null;
}

/** Reads the PPBF_RESEARCH_REPAIR_* environment into options, then validates them. */
export function parseRepairOptions(env = process.env) {
  const options = {
    // Exactly 'true'. Anything else, including 'TRUE' or '1', is a dry run.
    apply: env.PPBF_RESEARCH_REPAIR_APPLY === 'true',
    confirm: env.PPBF_RESEARCH_REPAIR_CONFIRM ?? '',
    // The plan_fingerprint of the dry run that was reviewed. Required for apply.
    expectFingerprint: (env.PPBF_RESEARCH_REPAIR_EXPECT_FINGERPRINT ?? '').trim(),
  };
  const refusal = validateRepairOptions(options);
  return refusal ? { ok: false, refusal } : { ok: true, options };
}

function isLive(row) {
  return row.organization_id === PLATFORM_ORGANIZATION_ID
    && row.status === LIVE_STATUS
    && row.approval_state === 'approved'
    && row.verification_state === 'verified'
    && row.retrieval_suppressed !== true;
}

/**
 * Reads every listed row and decides the state. `lock` adds FOR UPDATE (apply
 * only -- a read-only transaction cannot take row locks). Locking the sources
 * a run retires also blocks a new chunk from referencing one of them until
 * the transaction ends (an insert takes a key-share lock on the parent row).
 */
export async function readRepairState(client, plan, { lock = false } = {}) {
  const forUpdate = lock ? ' for update' : '';
  const sourceIds = [...new Set([...plan.sources.map((s) => s.source_id), ...plan.liveSources])].sort();
  const chunkIds = plan.chunks.map((c) => c.chunk_id);

  const sourceRows = (await client.query(
    `select source_id, organization_id, title, status, authority_tier, metadata, retrieval_suppressed,
            approval_state, verification_state, approved_by_account_id, approved_at::text as approved_at,
            verified_by_account_id, verified_at::text as verified_at
       from pilot.shadow_library_sources
      where source_id = any($1::text[])
      order by source_id${forUpdate}`,
    [sourceIds],
  )).rows;
  const chunkRows = (await client.query(
    `select chunk_id, organization_id, document_id, source_id, metadata, text_content
       from pilot.shadow_library_chunks
      where chunk_id = any($1::text[])
      order by chunk_id${forUpdate}`,
    [chunkIds],
  )).rows;
  // Any organization, on purpose: a chunk anywhere that still points at a
  // source this run retires is a claim that would sit on an archived row.
  const unplannedChunks = (await client.query(
    `select chunk_id, organization_id, source_id
       from pilot.shadow_library_chunks
      where source_id = any($1::text[]) and not (chunk_id = any($2::text[]))
      order by chunk_id${forUpdate}`,
    [plan.retireIds, chunkIds],
  )).rows;
  const retiringDocuments = (await client.query(
    `select document_id, organization_id, source_id
       from pilot.shadow_library_documents
      where source_id = any($1::text[])
      order by document_id`,
    [plan.retireIds],
  )).rows;
  // History about retired sources stays where it is: past answers cited them,
  // and the check tables record what was resolved. Reported, not blocking.
  const history = (await client.query(
    `select
       (select count(*)::int from pilot.shadow_evidence_items where source_id = any($1::text[])) as evidence_items,
       (select count(*)::int from pilot.source_citation_checks where source_id = any($1::text[])) as citation_checks,
       (select count(*)::int from pilot.source_retraction_checks where source_id = any($1::text[])) as retraction_checks`,
    [plan.retireIds],
  )).rows[0] ?? {};
  const spotCheck = (await client.query(
    `select c.chunk_id, c.source_id, s.title as source_title, s.status as source_status
       from pilot.shadow_library_chunks c
       join pilot.shadow_library_sources s on s.source_id = c.source_id
      where c.organization_id = $1 and c.metadata->>'claim_id' = $2
      order by c.chunk_id`,
    [PLATFORM_ORGANIZATION_ID, SPOT_CHECK_CLAIM_ID],
  )).rows;
  // What the full-text rights trigger will check when a corrected chunk's
  // text is written: its kind, and the rights of its DOCUMENT's source. Not
  // locked (FOR SHARE cannot take the nullable side of an outer join); the
  // trigger checks again, under its own locks, at the write.
  const textChunkIds = plan.textChunkIds ?? [];
  const textRights = textChunkIds.length === 0 ? [] : (await client.query(
    `select c.chunk_id, c.text_kind, d.source_id as document_source_id, s.rights_status
       from pilot.shadow_library_chunks c
       left join pilot.shadow_library_documents d on d.document_id = c.document_id
       left join pilot.shadow_library_sources s on s.source_id = d.source_id
      where c.chunk_id = any($1::text[])
      order by c.chunk_id`,
    [textChunkIds],
  )).rows;

  const sourceById = new Map(sourceRows.map((row) => [row.source_id, row]));
  const chunkById = new Map(chunkRows.map((row) => [row.chunk_id, row]));
  const blockers = [];
  const missing = [];
  const outside = [];
  const drifted = [];
  const fields = [];

  function evaluate(table, id, row, plannedFields, expectedOrganization = PLATFORM_ORGANIZATION_ID) {
    if (!row) {
      missing.push({ table, id });
      return;
    }
    if (row.organization_id !== expectedOrganization) {
      outside.push({ table, id, organization_id: row.organization_id, expected_organization_id: expectedOrganization });
      return;
    }
    for (const f of plannedFields) {
      const current = fieldValue(row, f.field);
      let state;
      if (f.before === f.after) state = current === f.after ? 'unchanged' : 'drifted';
      else if (current === f.after) state = 'done';
      else if (current === f.before) state = 'pending';
      else state = 'drifted';
      const entry = { table, id, field: f.field, action: actionOf(table, f.field), before: f.before, after: f.after, current, state };
      fields.push(entry);
      if (state === 'drifted') drifted.push(entry);
    }
  }
  for (const s of plan.sources) evaluate('source', s.source_id, sourceById.get(s.source_id), s.fields);
  for (const c of plan.chunks) evaluate('chunk', c.chunk_id, chunkById.get(c.chunk_id), c.fields, c.organization_id);

  const notLive = plan.liveSources
    .map((id) => sourceById.get(id) ?? { source_id: id, missing: true })
    .filter((row) => row.missing || !isLive(row))
    .map((row) => ({
      source_id: row.source_id,
      ...(row.missing ? { missing: true } : {
        organization_id: row.organization_id,
        status: row.status,
        approval_state: row.approval_state,
        verification_state: row.verification_state,
        retrieval_suppressed: row.retrieval_suppressed === true,
      }),
    }));

  if (missing.length > 0) blockers.push({ code: 'LISTED_ROW_MISSING', count: missing.length, rows: missing.slice(0, SAMPLE_LIMIT) });
  if (outside.length > 0) blockers.push({ code: 'LISTED_ROW_OUTSIDE_PLATFORM', count: outside.length, rows: outside.slice(0, SAMPLE_LIMIT) });
  if (drifted.length > 0) blockers.push({ code: 'FIELD_DRIFTED', count: drifted.length, fields: drifted.slice(0, SAMPLE_LIMIT) });
  if (notLive.length > 0) blockers.push({ code: 'TARGET_NOT_LIVE', count: notLive.length, sources: notLive.slice(0, SAMPLE_LIMIT) });
  if (unplannedChunks.length > 0) {
    blockers.push({ code: 'UNPLANNED_CHUNKS_ON_RETIRING_SOURCES', count: unplannedChunks.length, chunks: unplannedChunks.slice(0, SAMPLE_LIMIT) });
  }
  if (retiringDocuments.length > 0) {
    blockers.push({ code: 'DOCUMENTS_ON_RETIRING_SOURCES', count: retiringDocuments.length, documents: retiringDocuments.slice(0, SAMPLE_LIMIT) });
  }
  // Only a correction still to be written can be refused by the trigger.
  const pendingText = new Set(fields.filter((e) => e.action === 'text' && e.state === 'pending').map((e) => e.id));
  const notPermitted = textRights.filter((row) => pendingText.has(row.chunk_id)
    && row.text_kind !== 'excerpt' && !FULL_TEXT_RIGHTS.includes(row.rights_status));
  if (notPermitted.length > 0) {
    blockers.push({ code: 'TEXT_NOT_PERMITTED', count: notPermitted.length, chunks: notPermitted.slice(0, SAMPLE_LIMIT) });
  }

  const counts = Object.fromEntries(ACTIONS.map((action) => [action, {
    planned: plan.expected[action].fields, pending: 0, done: 0, unchanged: 0, drifted: 0,
  }]));
  for (const entry of fields) counts[entry.action][entry.state] += 1;

  const changes = fields.filter((entry) => entry.before !== entry.after);
  const pending = changes.filter((entry) => entry.state === 'pending').length;
  const done = changes.filter((entry) => entry.state === 'done').length;
  let state;
  if (blockers.length > 0) state = 'DRIFTED';
  else if (pending === 0) state = 'REPAIRED';
  else if (done === 0) state = 'PRE_REPAIR';
  else state = 'PARTIAL';

  const fingerprintMaterial = JSON.stringify({
    organization: PLATFORM_ORGANIZATION_ID,
    sources: plan.sources.map((s) => {
      const row = sourceById.get(s.source_id);
      return [s.source_id, row?.organization_id ?? null, s.fields.map((f) => [f.field, f.before, f.after, row ? fieldValue(row, f.field) : null])];
    }),
    chunks: plan.chunks.map((c) => {
      const row = chunkById.get(c.chunk_id);
      return [c.chunk_id, row?.organization_id ?? null, c.fields.map((f) => [f.field, f.before, f.after, row ? fieldValue(row, f.field) : null])];
    }),
    live: plan.liveSources.map((id) => {
      const row = sourceById.get(id);
      return [id, row?.status ?? null, row?.approval_state ?? null, row?.verification_state ?? null, row?.retrieval_suppressed === true];
    }),
    unplanned_chunks_on_retiring_sources: unplannedChunks.map((row) => [row.chunk_id, row.organization_id, row.source_id]),
    documents_on_retiring_sources: retiringDocuments.map((row) => [row.document_id, row.organization_id, row.source_id]),
    text_rights: textRights.map((row) => [row.chunk_id, row.text_kind ?? null, row.document_source_id ?? null, row.rights_status ?? null]),
  });
  const fingerprint = `sha256:${crypto.createHash('sha256').update(fingerprintMaterial).digest('hex')}`;

  const reviewColumns = Object.fromEntries(sourceRows.map((row) => [
    row.source_id, REVIEW_COLUMNS.map((column) => row[column] ?? null),
  ]));

  return {
    state,
    fingerprint,
    counts,
    blockers,
    fields,
    sourceById,
    reviewColumns,
    history: {
      evidence_items_citing_retiring_sources: Number(history.evidence_items ?? 0),
      citation_checks_on_retiring_sources: Number(history.citation_checks ?? 0),
      retraction_checks_on_retiring_sources: Number(history.retraction_checks ?? 0),
    },
    spotCheck: spotCheck.map((row) => ({ claim_id: SPOT_CHECK_CLAIM_ID, ...row })),
    textRights,
  };
}

/** What a reviewer reads: every repoint, retire and tier change by id, metadata by key. */
function describeChanges(fields) {
  const changes = fields.filter((entry) => entry.before !== entry.after);
  const line = (entry) => `${entry.id}: ${entry.before ?? '(absent)'} -> ${entry.after ?? '(absent)'} [${entry.state}]`;
  const metadataByKey = {};
  for (const entry of changes.filter((e) => e.action === 'metadata')) {
    const key = `${entry.table} ${entry.field}`;
    metadataByKey[key] ??= { pending: 0, done: 0, drifted: 0 };
    metadataByKey[key][entry.state] += 1;
  }
  return {
    repoint: changes.filter((e) => e.action === 'repoint').map(line),
    retire: changes.filter((e) => e.action === 'retire').map((e) => `${e.id} [${e.state}]`),
    retier: changes.filter((e) => e.action === 'retier').map((e) => `${e.table} ${e.field} ${line(e)}`),
    metadata_by_key: metadataByKey,
    // The whole text, before and after: the reviewer approves these words.
    text: changes.filter((e) => e.action === 'text').map((e) => ({
      chunk_id: e.id,
      state: e.state,
      before: e.before === null ? null : JSON.parse(e.before),
      after: e.after === null ? null : JSON.parse(e.after),
    })),
  };
}

/**
 * The repair. `client` is anything with pg's `query(text, values)` shape; the
 * caller owns connecting and ending it. `plan` defaults to the committed files.
 *
 * Returns one of:
 *   { status: 'refused', reason, ... }            nothing written
 *   { status: 'dry-run', state, ... }             nothing written
 *   { status: 'already-repaired', ... }           apply found nothing to do; nothing written
 *   { status: 'applied', ... }                    committed
 * and throws (after rolling back) on an unexpected database error.
 */
export async function repairResearchBaseline(client, options, { log = defaultLog, plan: givenPlan } = {}) {
  const refusal = validateRepairOptions(options);
  if (refusal) {
    log('refused', refusal);
    return { status: 'refused', ...refusal };
  }
  const apply = options.apply === true;
  const plan = givenPlan ?? await loadRepairPlan();
  let open = false;

  async function refuseInside(reason, detail = {}) {
    await client.query('rollback');
    open = false;
    log('refused', { reason, ...detail });
    return { status: 'refused', reason, ...detail };
  }

  try {
    await client.query(apply ? 'begin' : 'begin transaction read only');
    open = true;
    if (apply) {
      await client.query("set local lock_timeout = '10s'");
      await client.query("set local statement_timeout = '5min'");
    }

    const organization = (await client.query(
      'select organization_id from pilot.organizations where organization_id = $1',
      [PLATFORM_ORGANIZATION_ID],
    )).rows;
    if (organization.length !== 1) return await refuseInside('PLATFORM_ORGANIZATION_NOT_FOUND');

    const current = await readRepairState(client, plan, { lock: apply });
    const report = {
      mode: apply ? 'apply' : 'dry-run',
      organization_id: PLATFORM_ORGANIZATION_ID,
      state: current.state,
      plan_fingerprint: current.fingerprint,
      counts: current.counts,
      expected: plan.expected,
      blockers: current.blockers,
      history: current.history,
      spot_check: current.spotCheck,
      text_rights: current.textRights,
      files: plan.files ?? null,
      changes: describeChanges(current.fields),
    };
    log('plan', report);

    if (!apply) {
      await client.query('rollback');
      open = false;
      const result = {
        status: 'dry-run',
        state: current.state,
        would_apply: current.state === 'PRE_REPAIR' || current.state === 'PARTIAL',
        plan_fingerprint: current.fingerprint,
        counts: current.counts,
        expected: plan.expected,
        blockers: current.blockers.map((b) => b.code),
        spot_check: current.spotCheck,
      };
      log('dry-run', {
        state: result.state,
        would_apply: result.would_apply,
        blockers: result.blockers,
        plan_fingerprint: result.plan_fingerprint,
        note: {
          PRE_REPAIR: `apply needs mode=apply, the phrase ${CONFIRM_PHRASE}, and expected_fingerprint set to this plan_fingerprint`,
          PARTIAL: 'some of the repair is already in place; apply resumes it (same phrase and fingerprint rule)',
          REPAIRED: 'nothing to do: every planned field already holds the seed value',
          DRIFTED: 'apply would refuse; see blockers',
        }[result.state],
      });
      return result;
    }

    // The reviewed dry run is the plan Jason approves. Anything that changed
    // since then changes the fingerprint and stops here, before any update.
    if (current.fingerprint !== options.expectFingerprint) {
      return await refuseInside('PLAN_FINGERPRINT_MISMATCH', {
        expected: options.expectFingerprint, actual: current.fingerprint,
      });
    }
    if (current.state === 'DRIFTED') {
      return await refuseInside('PLAN_DRIFTED', { blockers: current.blockers });
    }
    if (current.state === 'REPAIRED') {
      await client.query('rollback');
      open = false;
      log('already-repaired', { plan_fingerprint: current.fingerprint });
      return { status: 'already-repaired', state: 'REPAIRED', plan_fingerprint: current.fingerprint };
    }

    const pending = current.fields.filter((entry) => entry.state === 'pending');
    const written = {};

    async function checkedUpdate(key, sql, values, planned) {
      if (planned === 0) {
        written[key] = 0;
        return null;
      }
      const result = await client.query(sql, values);
      written[key] = result.rowCount ?? result.rows?.length ?? 0;
      if (written[key] !== planned) {
        return refuseInside('PLAN_APPLY_COUNT_MISMATCH', { update: key, planned, updated: written[key] });
      }
      return null;
    }

    function metadataEdits(table) {
      const byId = new Map();
      for (const entry of pending.filter((e) => e.table === table && e.field.startsWith('metadata.'))) {
        const edit = byId.get(entry.id) ?? { set_keys: {}, remove_keys: [] };
        const key = entry.field.slice('metadata.'.length);
        if (entry.after === null) edit.remove_keys.push(key);
        else edit.set_keys[key] = JSON.parse(entry.after);
        byId.set(entry.id, edit);
      }
      return byId;
    }

    // 1. Repoint FIRST. Scoped to the platform, the planned chunk AND its
    //    pre-repair source, so a chunk that moved since the plan is not touched
    //    -- and the count check below catches it.
    const repoints = pending.filter((e) => e.action === 'repoint').map((e) => ({
      chunk_id: e.id, from_source_id: JSON.parse(e.before), to_source_id: JSON.parse(e.after),
    }));
    let stop = await checkedUpdate('chunks_repointed',
      `update pilot.shadow_library_chunks c
          set source_id = x.to_source_id, updated_at = now()
         from jsonb_to_recordset($2::jsonb) as x(chunk_id text, from_source_id text, to_source_id text)
        where c.organization_id = $1 and c.chunk_id = x.chunk_id and c.source_id = x.from_source_id
        returning c.chunk_id`,
      [PLATFORM_ORGANIZATION_ID, JSON.stringify(repoints)], repoints.length);
    if (stop) return stop;

    // 2. Chunk tiers and citation metadata: only the managed keys change.
    const chunkEdits = [...metadataEdits('chunk')].map(([chunk_id, edit]) => ({ chunk_id, ...edit }));
    stop = await checkedUpdate('chunks_metadata',
      `update pilot.shadow_library_chunks c
          set metadata = (c.metadata - x.remove_keys) || x.set_keys, updated_at = now()
         from jsonb_to_recordset($2::jsonb) as x(chunk_id text, set_keys jsonb, remove_keys text[])
        where c.organization_id = $1 and c.chunk_id = x.chunk_id
        returning c.chunk_id`,
      [PLATFORM_ORGANIZATION_ID, JSON.stringify(chunkEdits)], chunkEdits.length);
    if (stop) return stop;

    // 2b. Corrected chunk text. Only the pending rows, and only where the row
    //     still holds the reviewed before-text; the rights trigger fires on
    //     these rows alone. The embedding is not touched (see the header).
    //     Each row is scoped to the organization its log row names, which
    //     must be one of TEXT_ORGANIZATIONS.
    const chunkOrganization = new Map(plan.chunks.map((c) => [c.chunk_id, c.organization_id ?? PLATFORM_ORGANIZATION_ID]));
    const textEdits = pending.filter((e) => e.action === 'text').map((e) => ({
      chunk_id: e.id,
      organization_id: chunkOrganization.get(e.id),
      before_text: JSON.parse(e.before),
      after_text: JSON.parse(e.after),
    }));
    stop = await checkedUpdate('chunks_text',
      `update pilot.shadow_library_chunks c
          set text_content = x.after_text, updated_at = now()
         from jsonb_to_recordset($2::jsonb) as x(chunk_id text, organization_id text, before_text text, after_text text)
        where c.organization_id = x.organization_id and x.organization_id = any($1::text[])
          and c.chunk_id = x.chunk_id and c.text_content = x.before_text
        returning c.chunk_id`,
      [[...TEXT_ORGANIZATIONS], JSON.stringify(textEdits)], textEdits.length);
    if (stop) return stop;

    // 3. Source tiers and metadata.
    const sourceMetadata = metadataEdits('source');
    const sourceTiers = new Map(pending
      .filter((e) => e.table === 'source' && e.field === 'authority_tier')
      .map((e) => [e.id, JSON.parse(e.after)]));
    const sourceEdits = [...new Set([...sourceMetadata.keys(), ...sourceTiers.keys()])].sort().map((source_id) => ({
      source_id,
      authority_tier: sourceTiers.get(source_id) ?? null,
      set_keys: sourceMetadata.get(source_id)?.set_keys ?? {},
      remove_keys: sourceMetadata.get(source_id)?.remove_keys ?? [],
    }));
    stop = await checkedUpdate('sources_tier_and_metadata',
      `update pilot.shadow_library_sources s
          set authority_tier = coalesce(x.authority_tier, s.authority_tier),
              metadata = (s.metadata - x.remove_keys) || x.set_keys,
              updated_at = now()
         from jsonb_to_recordset($2::jsonb) as x(source_id text, authority_tier smallint, set_keys jsonb, remove_keys text[])
        where s.organization_id = $1 and s.source_id = x.source_id
        returning s.source_id`,
      [PLATFORM_ORGANIZATION_ID, JSON.stringify(sourceEdits)], sourceEdits.length);
    if (stop) return stop;

    // 4. Retire LAST, and only status: approval_state, verification_state and
    //    the stamps stay as they are (review_pair_check holds untouched).
    const retiring = pending.filter((e) => e.action === 'retire').map((e) => e.id);
    stop = await checkedUpdate('sources_archived',
      `update pilot.shadow_library_sources
          set status = 'archived', updated_at = now()
        where organization_id = $1 and source_id = any($2::text[]) and status = 'active'
        returning source_id`,
      [PLATFORM_ORGANIZATION_ID, retiring], retiring.length);
    if (stop) return stop;

    // Verify before commit: the same reading that decided the plan must now
    // say REPAIRED, and the postconditions are asserted again in plain SQL.
    const after = await readRepairState(client, plan, { lock: false });
    const verify = (await client.query(
      `select
         (select count(*)::int from pilot.shadow_library_chunks where source_id = any($2::text[])) as chunks_on_retired_sources,
         (select count(*)::int from pilot.shadow_library_sources
           where organization_id = $1 and source_id = any($2::text[]) and status = 'archived') as sources_archived`,
      [PLATFORM_ORGANIZATION_ID, plan.retireIds],
    )).rows[0] ?? {};
    const mismatches = [];
    if (after.state !== 'REPAIRED') mismatches.push(`state=${after.state}`);
    if (Number(verify.chunks_on_retired_sources) !== 0) mismatches.push(`chunks_on_retired_sources=${verify.chunks_on_retired_sources}`);
    if (Number(verify.sources_archived) !== plan.retireIds.length) {
      mismatches.push(`sources_archived=${verify.sources_archived}!=${plan.retireIds.length}`);
    }
    for (const [sourceId, columns] of Object.entries(current.reviewColumns)) {
      if (JSON.stringify(after.reviewColumns[sourceId]) !== JSON.stringify(columns)) mismatches.push(`review_columns_changed=${sourceId}`);
    }
    if (mismatches.length > 0) {
      return await refuseInside('END_STATE_MISMATCH', { mismatches: mismatches.slice(0, SAMPLE_LIMIT), blockers: after.blockers });
    }

    await client.query(
      `insert into pilot.audit_events
         (event_type, organization_id, entity_type, entity_id, details)
       values ('update', $1, 'shadow_library_research_repair', $1, $2::jsonb)`,
      [PLATFORM_ORGANIZATION_ID, JSON.stringify({
        plan_fingerprint: current.fingerprint,
        state_before: current.state,
        written,
        counts_before: current.counts,
        text_corrections: textEdits.map(({ chunk_id, organization_id }) => ({ chunk_id, organization_id })),
        files: plan.files ?? null,
        rulings: 'Jason 2026-09-29 Q1 (tool, logs as the pinned plan), Q2 (retire as archived), Q3 (tiers by the spec), Q4 (tiers on source row and chunk metadata); Jason 2026-11-05 "Yes, build it" (corrected chunk text, 2026-11-05_text_correction_log.csv)',
      })],
    );

    await client.query('commit');
    open = false;

    log('completed', { plan_fingerprint: current.fingerprint, state_before: current.state, written, spot_check: after.spotCheck });
    return {
      status: 'applied',
      state_before: current.state,
      state_after: after.state,
      plan_fingerprint: current.fingerprint,
      written,
      spot_check: after.spotCheck,
    };
  } catch (error) {
    if (open) await client.query('rollback').catch(() => {});
    throw error;
  }
}

function defaultCreateClient(connectionString) {
  return new pg.Client({ connectionString });
}

/**
 * Command-line entry. Every refusal that can be decided without the database
 * -- options, connection target, an inconsistent plan -- is decided before a
 * client is even created.
 */
export async function run(env = process.env, { createClient = defaultCreateClient, log = defaultLog, loadPlan = loadRepairPlan } = {}) {
  const parsed = parseRepairOptions(env);
  if (!parsed.ok) {
    log('refused', parsed.refusal);
    return { status: 'refused', ...parsed.refusal };
  }

  const connectionString = env.AZURE_POSTGRES_CONNECTION_STRING;
  if (!connectionString) {
    log('refused', { reason: 'MISSING_CONNECTION_STRING' });
    return { status: 'refused', reason: 'MISSING_CONNECTION_STRING' };
  }
  try {
    assertDeclaredWriteTargetFromEnv(connectionString, env);
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'UNKNOWN_TARGET_ERROR';
    log('refused', { reason });
    return { status: 'refused', reason };
  }

  let plan;
  try {
    plan = await loadPlan();
  } catch (error) {
    const detail = { reason: 'PLAN_INVALID', message: error instanceof Error ? error.message : String(error) };
    log('refused', detail);
    return { status: 'refused', ...detail };
  }

  const client = createClient(connectionString);
  await client.connect();
  try {
    return await repairResearchBaseline(client, parsed.options, { log, plan });
  } catch (error) {
    const failure = {
      reason: error instanceof Error ? error.name : 'UnknownError',
      message: error instanceof Error ? error.message : undefined,
      code: error && typeof error === 'object' && 'code' in error ? String(error.code) : undefined,
      constraint: error && typeof error === 'object' && 'constraint' in error ? String(error.constraint) : undefined,
    };
    log('failed', failure);
    return { status: 'failed', ...failure };
  } finally {
    await client.end();
  }
}

/**
 * Exit status: 0 for a dry run that is not DRIFTED, a committed apply, or an
 * apply that found the repair already in place; 1 for everything else.
 */
export function exitCodeFor(result) {
  if (result.status === 'applied' || result.status === 'already-repaired') return 0;
  if (result.status === 'dry-run' && result.state !== 'DRIFTED') return 0;
  return 1;
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  try {
    const result = await run();
    process.exitCode = exitCodeFor(result);
  } catch (error) {
    defaultLog('failed', { reason: error instanceof Error ? error.message : String(error) });
    process.exitCode = 1;
  }
}
