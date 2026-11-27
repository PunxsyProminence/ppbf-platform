#!/usr/bin/env node

/**
 * Finds and reports the audit test records left in a gym, by explicit, named
 * markers only (pilot blocker B6; Jason "2A", OD-2026-10-11-009 item 2; "hiit
 * fit" OD-2026-10-13-012 H-2 A; App Overwatch's GO on #2227). A dry run by
 * default. The apply (B6-3) needs PPBF_AUDIT_TEST_CLEANUP_APPLY=true exactly,
 * --kinds, the phrase in PPBF_AUDIT_TEST_CLEANUP_CONFIRM and the reviewed dry
 * run's plan_fingerprint in PPBF_AUDIT_TEST_CLEANUP_EXPECT_FINGERPRINT. It runs
 * in one transaction: lock the planned rows, recompute the fingerprint, refuse
 * on any difference, write (classes deleted with their sign-ups and
 * attendance, Q1 A; STRICT TVs disconnected, Q5 A; a named test gym or "hiit
 * fit" set inactive with its sessions revoked, Q3 B and Q4 A), check every
 * count and the end state, write one audit row per organization, commit.
 *
 * MARKERS, exact:
 *   STRICT  text starting with exactly 'ZZ-AUDIT' or 'AUDIT TEST' (case as
 *           written, no trimming), then the end or a character that is not a
 *           letter or digit (QS A, #2227): "AUDIT TESTING day" is NEAR. Only
 *           STRICT records are ever planned.
 *   NEAR    'zz-audit' anywhere, or 'audit test' first after any whitespace,
 *           any case, not STRICT. Reported, never planned, in every mode.
 *   K3      organizations whose name starts 'audit test gym' (any case).
 *   K4      organization_id 'danielles' AND name 'hiit fit' (any case).
 * Kinds: K1 classes (and their sign-ups, attendance, tied runs and register
 * marks), K2 gym TVs, K3, K4, and K5, a sweep of every text column of every
 * pilot table read from pg_catalog (keys only).
 *
 * IT NEVER PRINTS free text or a raw person id. Keys print through
 * printableKey (an allow-list); a person's id prints as personRef, an
 * HMAC-SHA256 under PPBF_AUDIT_TEST_CLEANUP_REF_KEY, or under a random key for
 * this run alone when that is unset (QR A, #2227). The fingerprint is over the
 * raw values, so it does not depend on the key.
 *
 * Target guard as RR-1 (scripts/lib/postgres-write-target.mjs), before a
 * client exists. K1 to K4 read one repeatable-read, read-only snapshot; with a
 * test gym in scope it counts that gym's rows in every pilot table, so it holds
 * read locks on them for the seconds that snapshot lasts. Each sweep table is
 * read in its own short read-only transaction, and one that fails is listed,
 * not fatal. Every transaction is rolled back. Scope is --organization <id> or
 * --all-organizations, never a default.
 *
 *   npm run pilot:cleanup-audit-test-records -- --organization <id>
 */

import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

import { assertDeclaredWriteTargetFromEnv } from './lib/postgres-write-target.mjs';

export const STRICT_MARKERS = Object.freeze(['ZZ-AUDIT', 'AUDIT TEST']);
export const STRICT_RULE = 'a marker first, exact case, then the end or a character that is not a letter or digit';
export const NEAR_RULE = "'zz-audit' anywhere, or 'audit test' first after any whitespace, any case, and not STRICT";
export const TEST_ORGANIZATION_NAME_PREFIX = 'audit test gym';
export const HIIT_FIT = Object.freeze({ organization_id: 'danielles', name: 'hiit fit' });
// Column names that can hold a person's id or name: the GO's list, plus
// parent, person, participant, contact, profile, child, minor, student,
// coach, staff, volunteer, login and subject.
export const PERSON_COLUMN = /athlete|account|guardian|member|user|email|parent|person|participant|contact|profile|child|minor|student|coach|staff|volunteer|login|subject/i;
// Keys that print raw: the GO's class, run, TV and organization ids, and uuid
// row keys whose column is not a person's. Everything else, integer keys
// included, is hashed. A key nobody thought about is hashed.
export const RAW_KEY_COLUMNS = Object.freeze(['organization_id', 'class_id', 'run_id', 'tv_id']);
const UUID_VALUE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Every foreign key into the class tables, as the class delete (B6-3) expects
// it: columns and ON DELETE action (c cascade, n set null (columns)). Any
// other refuses an apply (UNKNOWN_FOREIGN_KEY), and so does any of these
// missing (KNOWN_FOREIGN_KEY_MISSING): a delete would then leave rows
// pointing at nothing.
export const KNOWN_CLASS_FOREIGN_KEYS = Object.freeze([
  'pilot.scheduler_attendance(organization_id,class_id)->pilot.scheduler_classes(organization_id,class_id) c()',
  'pilot.scheduler_registrations(organization_id,class_id)->pilot.scheduler_classes(organization_id,class_id) c()',
  'pilot.session_run_athletes(organization_id,register_class_id,athlete_id)->pilot.scheduler_attendance(organization_id,class_id,athlete_id) n(register_class_id)',
  'pilot.session_script_runs(organization_id,class_id)->pilot.scheduler_classes(organization_id,class_id) n(class_id)',
]);
// The columns K1 to K4 read directly. A missing one refuses, naming it.
const REQUIRED_COLUMNS = Object.freeze({
  scheduler_classes: ['title', 'status', 'start_at', 'end_at'],
  scheduler_registrations: ['class_id', 'athlete_id', 'status'],
  scheduler_attendance: ['class_id', 'athlete_id', 'status'],
  session_script_runs: ['class_id', 'run_state'],
  session_run_athletes: ['register_class_id', 'athlete_id'],
  activity_log: ['class_id'],
  floor_plans_daily: ['class_id'],
  gym_tvs: ['tv_name', 'paired_at', 'last_seen_at', 'revoked_at', 'current_run_id', 'pair_code_hash'],
  organizations: ['organization_name', 'status'],
  organization_memberships: ['role'],
  audit_events: ['entity_type', 'entity_id'],
});
// Rows that do not stop "hiit fit" being empty (H-2 A): its own row and the
// audit history about it.
export const EMPTY_EXCEPT = Object.freeze(['organizations', 'audit_events']);
export const SWEEP_ROW_LIMIT = 500;
// The apply. K5 (the sweep) is report only in every mode (Q2 A): no kind names it.
export const KINDS = Object.freeze(['classes', 'tvs', 'test-organizations', 'hiit-fit']);
// Act only on the organization named by --organization (the GO: "only ids named at dispatch").
export const ORGANIZATION_KINDS = Object.freeze(['test-organizations', 'hiit-fit']);
export const CONFIRM_PHRASE = 'DELETE AUDIT TEST RECORDS';
export const FINGERPRINT_PATTERN = /^sha256:[0-9a-f]{64}$/;
// Every table an apply writes, directly or through a foreign key's SET NULL.
// A trigger on one that is not listed in KNOWN_TRIGGERS refuses the apply:
// the full schema has none on these tables (pg_trigger, 2026-11-27).
export const APPLY_TABLES = Object.freeze(['scheduler_classes', 'scheduler_registrations', 'scheduler_attendance',
  'session_script_runs', 'session_run_athletes', 'gym_tvs', 'organizations', 'session_tokens', 'audit_events']);
export const KNOWN_TRIGGERS = Object.freeze([]);
export const AUDIT_ENTITY_TYPE = 'audit_test_record_cleanup';
const RULINGS = Object.freeze([
  'OD-2026-10-11-009 item 2: remove the audit test records (2A)',
  '#2227 GO 7206238259: Q1 A delete STRICT classes; Q3 B named test gym inactive; Q4 A hiit fit only when empty; Q5 A disconnect STRICT TVs',
  'OD-2026-10-13-012 H-2 A: hiit fit closed only as an empty duplicate',
]);
const UTC = (column) => `to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`;
const ident = (name) => `"${String(name).replace(/"/g, '""')}"`;
// "audit test" first after any whitespace, Unicode spaces included.
const LEADING_AUDIT_TEST = "E'^[[:space:]\\u0085\\u00a0\\u1680\\u2000-\\u200b\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff]*audit test'";
const hitSql = (e) => `(${e} ilike '%zz-audit%' or ${e} ~* ${LEADING_AUDIT_TEST})`;
// The marker, then the end or a character that is not a letter or digit. A
// character outside ASCII counts as a letter here, so this only ever narrows.
const markerAt = (e, marker) => `(left(${e}, ${marker.length}) = '${marker}' and (length(${e}) = ${marker.length}
  or (ascii(substr(${e}, ${marker.length + 1}, 1)) < 128 and substr(${e}, ${marker.length + 1}, 1) !~ '[A-Za-z0-9]')))`;
const strictSql = (e) => `(${markerAt(e, 'ZZ-AUDIT')} or ${markerAt(e, 'AUDIT TEST')})`;
const markerSql = (e) => `case when ${markerAt(e, 'ZZ-AUDIT')} then 'ZZ-AUDIT'
  when ${markerAt(e, 'AUDIT TEST')} then 'AUDIT TEST' when ${hitSql(e)} then 'NEAR' end`;

function defaultLog(event, payload) {
  const line = JSON.stringify({ event: `audit_test_cleanup.${event}`, ...payload }, null, event === 'plan' ? 2 : 0);
  if (event === 'refused' || event === 'failed') console.error(line);
  else console.log(line);
}

/** A person's id as printed: HMAC-SHA256 under `key`, first 12 hex characters. Never the id. */
export function personRef(value, key) {
  if (value === null || value === undefined) return null;
  return crypto.createHmac('sha256', key).update(String(value)).digest('hex').slice(0, 12);
}

/** A key value as printed: raw only on the allow-list above, otherwise personRef. */
export function printableKey(column, type, value, key) {
  if (value === null || value === undefined) return null;
  const text = String(value);
  if (RAW_KEY_COLUMNS.includes(column)) return text;
  if (PERSON_COLUMN.test(column)) return personRef(text, key);
  return type === 'uuid' || UUID_VALUE.test(text) ? text : personRef(text, key);
}

const refused = (reason) => ({ ok: false, refusal: { reason } });

/** Pure checks on the options, before any database statement. Null when usable, else the refusal code. */
export function validateOptions(options) {
  const { apply, confirm, expectFingerprint, kinds, organizationId, allOrganizations } = options ?? {};
  if (apply !== undefined && typeof apply !== 'boolean') return 'INVALID_APPLY';
  const single = typeof organizationId === 'string' && organizationId !== '';
  if (single === (allOrganizations === true)) return 'ORGANIZATION_SCOPE_REQUIRED';
  if (apply === true && kinds === undefined) return 'APPLY_WITHOUT_KINDS';
  // A dry run may name kinds too (they are bound into its fingerprint); an apply must.
  if (kinds !== undefined && (!Array.isArray(kinds) || kinds.length === 0
    || kinds.some((kind) => !KINDS.includes(kind)) || new Set(kinds).size !== kinds.length)) return 'INVALID_KINDS';
  if (apply !== true) return null;
  if (confirm !== CONFIRM_PHRASE) return 'APPLY_WITHOUT_CONFIRM_PHRASE';
  if (!expectFingerprint) return 'APPLY_WITHOUT_EXPECTED_FINGERPRINT';
  if (!FINGERPRINT_PATTERN.test(String(expectFingerprint))) return 'INVALID_EXPECTED_FINGERPRINT';
  if (!single && kinds.some((kind) => ORGANIZATION_KINDS.includes(kind))) return 'ORGANIZATION_KIND_NEEDS_ONE_ORGANIZATION';
  return null;
}

/** Reads the scope and kinds from the command line, the mode from the environment. Refuses rather than guesses. */
export function parseOptions(env = process.env, argv = process.argv.slice(2)) {
  let organizationId;
  let allOrganizations = false;
  let kinds;
  const args = [...argv];
  while (args.length > 0) {
    const arg = args.shift();
    if (arg === '--all-organizations' && !allOrganizations) {
      allOrganizations = true;
    } else if (arg === '--organization' && organizationId === undefined) {
      const value = args.shift();
      if (value === undefined || value.startsWith('--') || value.trim() === '' || value !== value.trim()) {
        return refused('INVALID_ORGANIZATION');
      }
      organizationId = value;
    } else if (arg === '--all-organizations' || arg === '--organization') {
      return refused('ORGANIZATION_SCOPE_AMBIGUOUS');
    } else if (arg === '--kinds' && kinds === undefined) {
      const value = args.shift();
      if (value === undefined || value.startsWith('--')) return refused('INVALID_KINDS');
      kinds = value.split(',');
    } else {
      return refused(arg === '--kinds' ? 'INVALID_KINDS' : 'UNKNOWN_ARGUMENT'); // not echoed: operator input
    }
  }
  if (organizationId !== undefined && allOrganizations) return refused('ORGANIZATION_SCOPE_AMBIGUOUS');
  if (organizationId === undefined && !allOrganizations) return refused('ORGANIZATION_SCOPE_REQUIRED');
  const scope = allOrganizations ? { allOrganizations: true } : { organizationId };
  // Exactly 'true'. 'TRUE' or '1' is a dry run, as in RR-1; its --kinds only shape the report.
  const options = env.PPBF_AUDIT_TEST_CLEANUP_APPLY === 'true'
    ? {
      ...scope, apply: true, kinds, confirm: env.PPBF_AUDIT_TEST_CLEANUP_CONFIRM ?? '',
      expectFingerprint: (env.PPBF_AUDIT_TEST_CLEANUP_EXPECT_FINGERPRINT ?? '').trim(),
    }
    : { ...scope, ...(kinds === undefined ? {} : { kinds }) };
  const invalid = validateOptions(options);
  return invalid ? refused(invalid) : { ok: true, options };
}

const keyOf = (organizationId, id) => `${organizationId}\u0000${id}`;
function groupBy(rows, key) {
  const grouped = new Map();
  for (const row of rows) grouped.set(key(row), [...(grouped.get(key(row)) ?? []), row]);
  return grouped;
}

/** Every ordinary pilot table: its columns, text columns, primary key and columns the sweep cannot read. */
async function readCatalog(client) {
  const rows = (await client.query(
    `select c.relname as t, a.attname as col, ty.typname as typ,
            (ty.oid in ('text'::regtype, 'varchar'::regtype, 'bpchar'::regtype)
              or ty.typbasetype in ('text'::regtype, 'varchar'::regtype, 'bpchar'::regtype)) as is_text,
            (ty.typname in ('json', 'jsonb') or ty.typcategory = 'A') as unswept,
            (select k.ord from pg_catalog.pg_index i, unnest(i.indkey::int2[]) with ordinality as k(attnum, ord)
              where i.indrelid = c.oid and i.indisprimary and k.attnum = a.attnum) as pk_ord
       from pg_catalog.pg_class c
       join pg_catalog.pg_namespace n on n.oid = c.relnamespace
       join pg_catalog.pg_attribute a on a.attrelid = c.oid
       join pg_catalog.pg_type ty on ty.oid = a.atttypid
      where n.nspname = 'pilot' and c.relkind = 'r' and a.attnum > 0 and not a.attisdropped
      order by c.relname, a.attnum`,
  )).rows;
  const tables = new Map();
  const unswept = {};
  for (const row of rows) {
    const entry = tables.get(row.t) ?? { columns: new Set(), text: [], key: [] };
    entry.columns.add(row.col);
    if (row.is_text) entry.text.push(row.col);
    if (row.unswept) unswept[row.typ] = (unswept[row.typ] ?? 0) + 1;
    if (row.pk_ord !== null) entry.key[Number(row.pk_ord) - 1] = { name: row.col, type: row.typ };
    tables.set(row.t, entry);
  }
  const missing = Object.entries(REQUIRED_COLUMNS).flatMap(([table, columns]) =>
    columns.filter((column) => !tables.get(table)?.columns.has(column)).map((column) => `${table}.${column}`));
  return { tables, unswept, missing };
}

/** Rows of `table` naming one of the planned classes in `column`, with `select` per row. */
async function perClass(client, keys, table, column, select) {
  return (await client.query(
    `select t.organization_id, t.${ident(column)} as class_id, ${select}
       from pilot.${ident(table)} t
       join jsonb_to_recordset($1::jsonb) as k(o text, c text) on t.organization_id = k.o and t.${ident(column)} = k.c
      ${select.includes('count(') ? 'group by 1, 2' : 'order by 1, 2, 3, 4'}`,
    [keys],
  )).rows;
}

const fkColumns = (relation, attnums) => `(select string_agg(a.attname, ',' order by k.o)
  from unnest(${attnums}) with ordinality as k(n, o) join pg_catalog.pg_attribute a on a.attrelid = ${relation} and a.attnum = k.n)`;

/** K1: STRICT-titled classes, what hangs off them, and what an apply would refuse on. */
async function readClasses(client, organizationId, refKey) {
  const ref = (value) => personRef(value, refKey);
  const classes = (await client.query(
    `select organization_id, class_id, title, ${markerSql('title')} as marker, status,
            ${UTC('start_at')} as start_at, ${UTC('end_at')} as end_at, (start_at <= now() and now() < end_at) as running_now,
            extract(epoch from start_at)::text as start_raw, extract(epoch from end_at)::text as end_raw
       from pilot.scheduler_classes
      where ${strictSql('title')} and ($1::text is null or organization_id = $1)
      order by organization_id, class_id`,
    [organizationId],
  )).rows;
  const keys = JSON.stringify(classes.map((row) => ({ o: row.organization_id, c: row.class_id })));
  const registrations = await perClass(client, keys, 'scheduler_registrations', 'class_id', 't.registration_id, t.athlete_id, t.status');
  const attendance = await perClass(client, keys, 'scheduler_attendance', 'class_id', 't.attendance_id, t.athlete_id, t.status');
  const runs = await perClass(client, keys, 'session_script_runs', 'class_id', "t.run_id, coalesce(t.run_state, 'none') as run_state");
  const registerMarks = await perClass(client, keys, 'session_run_athletes', 'register_class_id', 't.run_id, t.athlete_id');
  const counts = {};
  for (const [name, table] of [['activity_log', 'activity_log'], ['floor_plans_daily', 'floor_plans_daily']]) {
    const rows = await perClass(client, keys, table, 'class_id', 'count(*)::int as n');
    counts[name] = new Map(rows.map((row) => [keyOf(row.organization_id, row.class_id), row.n]));
  }
  // History, kept and counted: the class's own audit rows, and rows keyed "<class>:<athlete>".
  counts.audit_rows = new Map((await client.query(
    `select k.o as organization_id, k.c as class_id, count(*)::int as n
       from pilot.audit_events t join jsonb_to_recordset($1::jsonb) as k(o text, c text) on t.organization_id = k.o
        and ((t.entity_type = 'scheduler_class' and t.entity_id = k.c) or left(t.entity_id, length(k.c) + 1) = k.c || ':')
      group by 1, 2`,
    [keys],
  )).rows.map((row) => [keyOf(row.organization_id, row.class_id), row.n]));
  const observedForeignKeys = (await client.query(
    `select fn.nspname || '.' || fc.relname || '(' || ${fkColumns('c.conrelid', 'c.conkey')} || ')->'
            || tn.nspname || '.' || tc.relname || '(' || ${fkColumns('c.confrelid', 'c.confkey')} || ') '
            || c.confdeltype::text || '(' || coalesce(${fkColumns('c.conrelid', 'c.confdelsetcols')}, '') || ')' as fk
       from pg_catalog.pg_constraint c
       join pg_catalog.pg_class fc on fc.oid = c.conrelid join pg_catalog.pg_namespace fn on fn.oid = fc.relnamespace
       join pg_catalog.pg_class tc on tc.oid = c.confrelid join pg_catalog.pg_namespace tn on tn.oid = tc.relnamespace
      where c.contype = 'f' and tn.nspname = 'pilot'
        and tc.relname in ('scheduler_classes', 'scheduler_registrations', 'scheduler_attendance')`,
  )).rows.map((row) => row.fk);
  const unknownForeignKeys = observedForeignKeys.filter((fk) => !KNOWN_CLASS_FOREIGN_KEYS.includes(fk)).sort();
  const missingForeignKeys = KNOWN_CLASS_FOREIGN_KEYS.filter((fk) => !observedForeignKeys.includes(fk));

  const byClass = (rows) => groupBy(rows, (row) => keyOf(row.organization_id, row.class_id));
  const [regs, marks, tied, pointers] = [byClass(registrations), byClass(attendance), byClass(runs), byClass(registerMarks)];
  const report = classes.map((row) => {
    const key = keyOf(row.organization_id, row.class_id);
    const count = (name) => counts[name].get(key) ?? 0;
    const tiedRuns = (tied.get(key) ?? []).map((run) => ({ run_id: run.run_id, run_state: run.run_state }));
    const wouldRefuse = [];
    if (tiedRuns.some((run) => run.run_state === 'in_progress')) wouldRefuse.push('TIED_RUN_LIVE');
    if (row.running_now) wouldRefuse.push('CLASS_RUNNING_NOW');
    if (count('activity_log') + count('floor_plans_daily') > 0) wouldRefuse.push('UNTRACKED_REFERENCE');
    if (unknownForeignKeys.length > 0) wouldRefuse.push('UNKNOWN_FOREIGN_KEY');
    if (missingForeignKeys.length > 0) wouldRefuse.push('KNOWN_FOREIGN_KEY_MISSING');
    const athletes = [...(regs.get(key) ?? []), ...(marks.get(key) ?? []), ...(pointers.get(key) ?? [])].map((r) => r.athlete_id);
    return {
      organization_id: row.organization_id, class_id: row.class_id, marker: row.marker, status: row.status,
      start_at: row.start_at, end_at: row.end_at, distinct_athletes: new Set(athletes).size,
      registrations: (regs.get(key) ?? []).map((r) => ({
        registration_id: printableKey('registration_id', 'text', r.registration_id, refKey), athlete_ref: ref(r.athlete_id), status: r.status,
      })),
      attendance: (marks.get(key) ?? []).map((a) => ({
        attendance_id: printableKey('attendance_id', 'text', a.attendance_id, refKey), athlete_ref: ref(a.athlete_id), status: a.status,
      })),
      tied_runs: tiedRuns,
      register_marks: (pointers.get(key) ?? []).map((m) => ({ run_id: m.run_id, athlete_ref: ref(m.athlete_id) })),
      untracked_references: { activity_log: count('activity_log'), floor_plans_daily: count('floor_plans_daily') },
      audit_rows_about_it: count('audit_rows'),
      apply_would_refuse: wouldRefuse,
    };
  });
  const material = {
    classes: classes.map((row) => {
      const key = keyOf(row.organization_id, row.class_id);
      // Every input to a refusal: running now, and whether (not how often) a row names it without a key.
      return [row.organization_id, row.class_id, row.title, row.status, row.start_raw, row.end_raw, row.running_now,
        (counts.activity_log.get(key) ?? 0) > 0, (counts.floor_plans_daily.get(key) ?? 0) > 0];
    }),
    registrations: registrations.map((r) => [r.organization_id, r.class_id, r.registration_id, r.athlete_id, r.status]),
    attendance: attendance.map((a) => [a.organization_id, a.class_id, a.attendance_id, a.athlete_id, a.status]),
    tied_runs: runs.map((run) => [run.organization_id, run.class_id, run.run_id, run.run_state]),
    register_marks: registerMarks.map((m) => [m.organization_id, m.class_id, m.run_id, m.athlete_id]),
    unknown_foreign_keys: unknownForeignKeys,
    missing_foreign_keys: missingForeignKeys,
  };
  return { report, material, unknownForeignKeys, missingForeignKeys };
}

/** K2: every TV in scope; the STRICT-named ones are the planned ones. */
async function readTvs(client, organizationId) {
  const rows = (await client.query(
    `select organization_id, tv_id, ${markerSql('tv_name')} as marker, ${UTC('created_at')} as created_at,
            ${UTC('paired_at')} as paired_at, ${UTC('last_seen_at')} as last_seen_at, ${UTC('revoked_at')} as revoked_at,
            current_run_id is not null as showing_a_session, pair_code_hash is not null as pair_code_pending,
            extract(epoch from paired_at)::text as paired_raw, extract(epoch from revoked_at)::text as revoked_raw,
            current_run_id as run_raw
       from pilot.gym_tvs where ($1::text is null or organization_id = $1)
      order by organization_id, tv_id`,
    [organizationId],
  )).rows;
  const marked = rows.filter((row) => STRICT_MARKERS.includes(row.marker));
  // The *_raw fields are for the fingerprint only, never printed.
  const printed = (row) => Object.fromEntries(Object.entries(row).filter(([name]) => !name.endsWith('_raw')));
  return {
    report: { marked: marked.map(printed), others: rows.filter((row) => !STRICT_MARKERS.includes(row.marker)).map(printed) },
    // Not last_seen_at: a working TV moves it every few seconds.
    material: marked.map((row) => [row.organization_id, row.tv_id, row.marker, row.paired_raw, row.revoked_raw,
      row.showing_a_session, row.pair_code_pending, row.run_raw]),
  };
}

/** K3 (Audit Test Gyms) and K4 ("hiit fit"): status, members by role, rows per table. */
async function readOrganizations(client, organizationId, tables) {
  const rows = (await client.query(
    `select organization_id, status, lower(left(organization_name, length($2))) = $2 as test_name,
            organization_id = $3 as hiit_fit_id, lower(organization_name) = $4 as hiit_fit_name
       from pilot.organizations
      where ($1::text is null or organization_id = $1)
        and (lower(left(organization_name, length($2))) = $2 or organization_id = $3)
      order by organization_id`,
    [organizationId, TEST_ORGANIZATION_NAME_PREFIX, HIIT_FIT.organization_id, HIIT_FIT.name],
  )).rows;
  const ids = rows.map((row) => row.organization_id);
  const held = new Map(ids.map((id) => [id, {}]));
  for (const [table, entry] of ids.length === 0 ? [] : tables) {
    if (!entry.columns.has('organization_id')) continue;
    const counts = (await client.query(
      `select organization_id::text as id, count(*)::int as n from pilot.${ident(table)}
        where organization_id::text = any($1::text[]) group by 1`,
      [ids],
    )).rows;
    for (const row of counts) held.get(row.id)[table] = row.n;
  }
  const members = (await client.query(
    `select organization_id, role, count(*)::int as n from pilot.organization_memberships
      where organization_id = any($1::text[]) group by 1, 2 order by 1, 2`,
    [ids],
  )).rows;
  const testOrganizations = rows.filter((row) => row.test_name && !row.hiit_fit_id).map((row) => ({
    organization_id: row.organization_id,
    status: row.status,
    members_by_role: Object.fromEntries(members.filter((m) => m.organization_id === row.organization_id).map((m) => [m.role, m.n])),
    rows_by_table: held.get(row.organization_id),
  }));
  const hiit = rows.find((row) => row.hiit_fit_id);
  let hiitFit = { found_id: false };
  let holding = [];
  if (hiit) {
    holding = Object.entries(held.get(hiit.organization_id)).filter(([t]) => !EMPTY_EXCEPT.includes(t)).sort();
    hiitFit = {
      found_id: true,
      name_matches: hiit.hiit_fit_name,
      ...(hiit.hiit_fit_name ? {} : { note: 'id found, name differs' }),
      status: hiit.status,
      rows_by_table: held.get(hiit.organization_id),
      holding_tables: holding.map(([t]) => t),
      apply_would_refuse: [...(hiit.hiit_fit_name ? [] : ['NAME_DIFFERS']), ...(holding.length > 0 ? ['NOT_EMPTY'] : [])],
    };
  }
  // Only what the K3/K4 apply acts on or refuses on: status, the matches, and
  // what "hiit fit" holds. Not audit history, members or tokens, which move
  // with every audit login and would make a reviewed plan go stale.
  const material = {
    organizations: rows.map((row) => [row.organization_id, row.status, row.test_name, row.hiit_fit_id, row.hiit_fit_name]),
    hiit_fit_holding: holding.map(([table]) => table),
  };
  return { testOrganizations, hiitFit, material };
}

/** One statement in its own read-only transaction, rolled back. */
async function readOnly(client, sql, values) {
  await client.query('begin transaction read only');
  try {
    await client.query("set local lock_timeout = '10s'");
    await client.query("set local statement_timeout = '5min'");
    return (await client.query(sql, values)).rows;
  } finally {
    await client.query('rollback');
  }
}

/** K5: every text column of every pilot table. Keys only; report only, in every mode. */
async function sweep(client, options, { tables, unswept }, refKey) {
  const single = options.allOrganizations !== true;
  const out = {
    tables_scanned: 0, columns_scanned: 0, columns_not_swept_by_type: unswept,
    tables_skipped_no_organization_column: [], truncated_tables: [], tables_failed: [], strict: [], near: [],
  };
  for (const [table, { columns, text, key }] of tables) {
    if (text.length === 0) continue;
    if (single && !columns.has('organization_id')) {
      out.tables_skipped_no_organization_column.push(table);
      continue;
    }
    let found;
    try {
      found = await readOnly(client,
        `select ${key.map((k, i) => `${ident(k.name)}::text as k${i}, `).join('')}
                ${columns.has('organization_id') ? 'organization_id::text' : 'null::text'} as organization_id,
                array[${text.map((c) => markerSql(ident(c))).join(', ')}]::text[] as markers
           from pilot.${ident(table)}
          where (${text.map((c) => hitSql(ident(c))).join(' or ')}) ${single ? 'and organization_id = $1' : ''}
          order by coalesce(${text.map((c) => strictSql(ident(c))).join(' or ')}, false) desc${key.map((_, i) => `, k${i}`).join('')}
          limit ${SWEEP_ROW_LIMIT + 1}`,
        single ? [options.organizationId] : []);
    } catch (error) {
      // Listed, not fatal: K1 to K4 are already read. The code only, never the message.
      out.tables_failed.push({ table, code: error && typeof error === 'object' && 'code' in error ? String(error.code) : 'unknown' });
      continue;
    }
    out.tables_scanned += 1;
    out.columns_scanned += text.length;
    if (found.length > SWEEP_ROW_LIMIT) out.truncated_tables.push(table);
    for (const row of found.slice(0, SWEEP_ROW_LIMIT)) {
      const rowKey = Object.fromEntries(key.map((k, i) => [k.name, printableKey(k.name, k.type, row[`k${i}`], refKey)]));
      row.markers.forEach((marker, i) => {
        if (marker === null) return;
        const hit = { table, column: text[i], key: rowKey, organization_id: row.organization_id };
        if (marker === 'NEAR') out.near.push(hit);
        else out.strict.push({ ...hit, marker });
      });
    }
  }
  return out;
}

const refusal = (log, reason, detail = {}) => {
  log('refused', { reason, ...detail });
  return { status: 'refused', reason, ...detail };
};

/**
 * The fingerprint: sha256 over the markers, the scope, the kinds when the run
 * names them (sorted), and the raw rows an apply acts on or refuses on. With no
 * kinds it is B6-1's value byte for byte; an apply always names kinds, so it
 * matches only a dry run made with the same kinds (the plan's "sha256 over the
 * scope, the kinds, the markers ...").
 */
export function planFingerprint(scope, kinds, material) {
  return `sha256:${crypto.createHash('sha256').update(JSON.stringify({
    markers: STRICT_MARKERS, strict_rule: STRICT_RULE, scope, ...(kinds === undefined ? {} : { kinds: [...kinds].sort() }), ...material,
  })).digest('hex')}`;
}

/** K1 to K4 and the fingerprint over them: the same reads for the dry run and the apply. */
async function readPlan(client, organizationId, scope, kinds, catalog, key) {
  const classes = await readClasses(client, organizationId, key);
  const tvs = await readTvs(client, organizationId);
  const organizations = await readOrganizations(client, organizationId, catalog.tables);
  const fingerprint = planFingerprint(scope, kinds, { ...classes.material, tvs: tvs.material, ...organizations.material });
  return { classes, tvs, organizations, fingerprint };
}

/**
 * The dry run. `client` has pg's `query(text, values)` shape; the caller owns
 * connecting and ending it. Returns { status: 'dry-run', ... } or
 * { status: 'refused', reason }; throws, after rolling back, on a database
 * error. It never writes.
 */
export async function reportAuditTestRecords(client, options, { log = defaultLog, refKey } = {}) {
  // Never printed. Without one, a random key for this run alone: references
  // group a person's rows within this report and cannot be tied to an id.
  const key = typeof refKey === 'string' && refKey !== '' ? refKey : crypto.randomBytes(32);
  const personRefKey = Buffer.isBuffer(key) ? 'per-run key' : 'environment key';
  // Exactly one scope (a call with neither must not read as "every organization"), and valid kinds if named.
  const invalid = validateOptions({ ...options, apply: false });
  if (invalid) return refusal(log, invalid);
  const single = options.allOrganizations !== true;
  const scope = single ? { organization_id: options.organizationId } : { all_organizations: true };
  const organizationId = single ? options.organizationId : null;
  const kinds = options.kinds;
  let open = false;
  try {
    await client.query('begin transaction isolation level repeatable read read only');
    open = true;
    await client.query("set local lock_timeout = '10s'");
    await client.query("set local statement_timeout = '5min'");
    const close = async () => { open = false; await client.query('rollback'); };
    if (single && (await client.query('select 1 from pilot.organizations where organization_id = $1', [organizationId])).rows.length !== 1) {
      await close();
      return refusal(log, 'ORGANIZATION_NOT_FOUND');
    }
    const catalog = await readCatalog(client);
    if (catalog.missing.length > 0) {
      await close();
      return refusal(log, 'SCHEMA_MISSING', { missing: catalog.missing });
    }
    const { classes, tvs, organizations, fingerprint } = await readPlan(client, organizationId, scope, kinds, catalog, key);
    await close();
    const swept = await sweep(client, options, catalog, key);

    const counts = {
      classes: classes.report.length,
      registrations: classes.report.reduce((n, c) => n + c.registrations.length, 0),
      attendance: classes.report.reduce((n, c) => n + c.attendance.length, 0),
      tvs_marked: tvs.report.marked.length,
      test_organizations: organizations.testOrganizations.length,
      hiit_fit_found: organizations.hiitFit.found_id,
      sweep_strict: swept.strict.length,
      sweep_near: swept.near.length,
      sweep_tables_failed: swept.tables_failed.length,
    };
    const report = {
      mode: 'dry-run', scope, kinds: kinds === undefined ? null : [...kinds].sort(), markers: { strict: STRICT_MARKERS, strict_rule: STRICT_RULE, near: NEAR_RULE }, person_ref: personRefKey, plan_fingerprint: fingerprint, counts,
      unknown_foreign_keys: classes.unknownForeignKeys, missing_foreign_keys: classes.missingForeignKeys,
      classes: classes.report, tvs: tvs.report,
      test_organizations: organizations.testOrganizations, hiit_fit: organizations.hiitFit, sweep: swept,
    };
    log('plan', report);
    log('dry-run', {
      plan_fingerprint: fingerprint, kinds: report.kinds, person_ref: personRefKey, counts,
      note: kinds === undefined
        ? 'nothing written; an apply needs a dry run of the same scope that names its kinds'
        : `nothing written; an apply of exactly these kinds needs mode apply, the phrase ${CONFIRM_PHRASE}, the same scope and expected_fingerprint set to this plan_fingerprint`,
    });
    return { status: 'dry-run', ...report };
  } catch (error) {
    if (open) await client.query('rollback').catch(() => {});
    throw error;
  }
}

// The planned classes, restated on every lock, delete and check: STRICT title, in scope.
const PLANNED_CLASSES = `select c.organization_id, c.class_id from pilot.scheduler_classes c
  where ${strictSql('c.title')} and ($1::text is null or c.organization_id = $1)`;
// What hangs off a class: [table, the column naming the class].
const CLASS_CHILDREN = Object.freeze([['scheduler_registrations', 'class_id'], ['scheduler_attendance', 'class_id'],
  ['session_script_runs', 'class_id'], ['session_run_athletes', 'register_class_id']]);
const ORGANIZATION_NAME_MATCH = {
  'test-organizations': ['lower(left(organization_name, length($2))) = $2 and organization_id <> $3', TEST_ORGANIZATION_NAME_PREFIX],
  'hiit-fit': ['organization_id = $3 and lower(organization_name) = $2', HIIT_FIT.name],
};

// Organization tables a new row could join with no lock on the organization row: no foreign key
// on organization_id whose columns are all NOT NULL, is not deferrable, and references a pilot
// table's organization_id (pilot.organizations itself, or a table that in turn needs a row of this
// organization). A row there takes no FOR KEY SHARE on the organization (MATCH SIMPLE skips a key
// with a null column), so for "hiit fit" these tables are held whole, read on, writes wait.
const ORGANIZATION_TABLES_NO_KEY_HOLDS = `select c.relname as t from pg_catalog.pg_class c
   join pg_catalog.pg_namespace n on n.oid = c.relnamespace
   join pg_catalog.pg_attribute a on a.attrelid = c.oid and a.attname = 'organization_id' and not a.attisdropped
  where n.nspname = 'pilot' and c.relkind = 'r' and c.relname <> 'organizations' and c.relname <> all($1::text[])
    and not exists (select 1 from pg_catalog.pg_constraint k
      join pg_catalog.pg_class rc on rc.oid = k.confrelid join pg_catalog.pg_namespace rn on rn.oid = rc.relnamespace
     where k.contype = 'f' and k.conrelid = c.oid and rn.nspname = 'pilot' and not k.condeferrable
       and exists (select 1 from unnest(k.conkey, k.confkey) as u(col, refcol) join pg_catalog.pg_attribute ra
                     on ra.attrelid = k.confrelid and ra.attnum = u.refcol where u.col = a.attnum and ra.attname = 'organization_id')
       and not exists (select 1 from unnest(k.conkey) as u(col) join pg_catalog.pg_attribute fa
                         on fa.attrelid = c.oid and fa.attnum = u.col where not fa.attnotnull))
  order by 1`;

/** Locks what the kinds write, before the plan is read. Returns the live session count of a named organization. */
async function lockPlanned(client, kinds, organizationId) {
  if (kinds.includes('classes')) {
    // activity_log and floor_plans_daily name a class with no foreign key, so no row lock holds
    // them back: held whole (reads go on, writes wait) until the commit, so none can come to name
    // a planned class between the plan and the commit.
    await client.query('lock table pilot.activity_log, pilot.floor_plans_daily in share mode');
    await client.query(`${PLANNED_CLASSES} for update`, [organizationId]);
    for (const [table, column] of CLASS_CHILDREN) {
      await client.query(`select 1 from pilot.${table} t where (t.organization_id, t.${column}) in (${PLANNED_CLASSES}) for update of t`,
        [organizationId]);
    }
  }
  if (kinds.includes('tvs')) {
    await client.query(`select 1 from pilot.gym_tvs t where ${strictSql('t.tv_name')} and ($1::text is null or t.organization_id = $1)
      for update`, [organizationId]);
  }
  if (!kinds.some((kind) => ORGANIZATION_KINDS.includes(kind))) return 0;
  // FOR UPDATE, not FOR NO KEY UPDATE: it also holds back every insert whose
  // foreign key on organization_id names this organization (those take FOR KEY
  // SHARE on it). Not a row whose key has a null column or no key at all:
  // for "hiit fit", the tables such rows go in are held whole below.
  await client.query('select 1 from pilot.organizations where organization_id = $1 for update', [organizationId]);
  if (kinds.includes('hiit-fit')) {
    const unheld = (await client.query(ORGANIZATION_TABLES_NO_KEY_HOLDS, [EMPTY_EXCEPT])).rows.map((row) => row.t);
    if (unheld.length > 0) await client.query(`lock table ${unheld.map((t) => `pilot.${ident(t)}`).join(', ')} in share mode`);
  }
  return (await client.query('select 1 from pilot.session_tokens where organization_id = $1 and revoked_at is null for update',
    [organizationId])).rowCount ?? 0;
}

/**
 * Counts, after the writes, of what must now be gone or changed. Every value
 * must be 0. Not the class children: their foreign keys (checked by the plan,
 * KNOWN_FOREIGN_KEY_MISSING) cascade or set null, so none can still name a
 * deleted class. activity_log and floor_plans_daily are held whole by
 * lockPlanned, and so are the "hiit fit" tables no key holds back; these
 * re-reads are the check that the locks held.
 */
async function endState(client, planned, m, tvKeys, organizationId, { hiitFit, tables }) {
  const classKeys = JSON.stringify(m.classes.map(([o, c]) => ({ o, c })));
  const naming = (table) => `(select count(*)::int from pilot.${table} t join k on t.organization_id = k.o and t.class_id = k.c)`;
  const checks = planned.classes === 0 ? {} : (await client.query(
    `with k as (select * from jsonb_to_recordset($1::jsonb) as k(o text, c text))
     select ${['scheduler_classes', 'activity_log', 'floor_plans_daily'].map((table) => `${naming(table)} as ${table}_left`).join(', ')}`,
    [classKeys],
  )).rows[0];
  if (planned.tvs > 0) {
    checks.tvs_not_disconnected = (await client.query(
      `select count(*)::int as n from pilot.gym_tvs t join jsonb_to_recordset($1::jsonb) as k(o text, v text)
          on t.organization_id = k.o and t.tv_id = k.v
        where t.revoked_at is null or t.current_run_id is not null or t.pair_code_hash is not null`, [tvKeys])).rows[0].n;
  }
  if (planned.organization) {
    checks.organization_not_inactive = (await client.query(
      "select count(*)::int as n from pilot.organizations where organization_id = $1 and status <> 'inactive'", [organizationId])).rows[0].n;
    checks.sessions_left = (await client.query(
      'select count(*)::int as n from pilot.session_tokens where organization_id = $1 and revoked_at is null', [organizationId])).rows[0].n;
  }
  if (hiitFit) {
    // H-2 A: closed only while empty. Re-counted here, after the writes, in every table, with or without a foreign key.
    const held = [...tables].filter(([table, entry]) => entry.columns.has('organization_id') && !EMPTY_EXCEPT.includes(table));
    for (const row of (await client.query(
      `select t, n from (${held.map(([table]) => `select '${table.replace(/'/g, "''")}' as t, count(*)::int as n from pilot.${ident(table)}
        where organization_id::text = $1`).join(' union all ')}) x where n > 0 order by t`,
      [organizationId],
    )).rows) checks[`hiit_fit_rows:${row.t}`] = row.n;
  }
  return Object.entries(checks).filter(([, n]) => Number(n) !== 0).map(([name, n]) => `${name}=${n}`);
}

/**
 * The apply. One transaction: lock, re-plan, compare with the reviewed
 * fingerprint, refuse on any difference or any planned refusal, write, check
 * every count and the end state, audit, commit. Returns { status: 'applied' },
 * 'nothing-to-apply' or 'refused' (nothing written); throws, after rolling
 * back, on a database error. NEAR rows and K5 are never written: every write
 * restates the STRICT marker and the scope.
 */
export async function applyAuditTestRecords(client, options, { log = defaultLog, refKey } = {}) {
  const invalid = validateOptions(options) ?? (options.apply === true ? null : 'APPLY_NOT_REQUESTED');
  if (invalid) return refusal(log, invalid);
  const kinds = options.kinds;
  const single = options.allOrganizations !== true;
  const scope = single ? { organization_id: options.organizationId } : { all_organizations: true };
  const organizationId = single ? options.organizationId : null;
  const key = typeof refKey === 'string' && refKey !== '' ? refKey : crypto.randomBytes(32);
  let open = false;
  const refuseInside = async (reason, detail = {}) => {
    open = false;
    await client.query('rollback');
    return refusal(log, reason, detail);
  };
  try {
    await client.query('begin');
    open = true;
    await client.query("set local lock_timeout = '10s'");
    await client.query("set local statement_timeout = '5min'");
    if (single && (await client.query('select 1 from pilot.organizations where organization_id = $1', [organizationId])).rows.length !== 1) {
      return await refuseInside('ORGANIZATION_NOT_FOUND');
    }
    const catalog = await readCatalog(client);
    if (catalog.missing.length > 0) return await refuseInside('SCHEMA_MISSING', { missing: catalog.missing });
    const triggers = (await client.query(
      `select c.relname || '.' || t.tgname as name from pg_catalog.pg_trigger t
         join pg_catalog.pg_class c on c.oid = t.tgrelid join pg_catalog.pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'pilot' and not t.tgisinternal and c.relname = any($1::text[]) order by 1`,
      [APPLY_TABLES],
    )).rows.map((row) => row.name).filter((name) => !KNOWN_TRIGGERS.includes(name));
    if (triggers.length > 0) return await refuseInside('UNKNOWN_TRIGGER', { triggers });

    const sessionsLocked = await lockPlanned(client, kinds, organizationId);
    const plan = await readPlan(client, organizationId, scope, kinds, catalog, key);
    // The reviewed dry run (of the same scope and kinds) is the plan Jason approved. Anything
    // changed since stops here, before any write. The new value is not printed: it is a plan
    // nobody has reviewed, and pasting it would apply it.
    if (plan.fingerprint !== options.expectFingerprint) {
      return await refuseInside('PLAN_FINGERPRINT_MISMATCH', {
        expected: options.expectFingerprint, note: 'run a fresh dry run of the same scope and kinds, and have it reviewed',
      });
    }
    const m = plan.classes.material;
    if (kinds.includes('classes')) {
      const blocked = plan.classes.report.filter((c) => c.apply_would_refuse.length > 0)
        .map((c) => ({ organization_id: c.organization_id, class_id: c.class_id, reasons: c.apply_would_refuse }));
      if (blocked.length > 0) return await refuseInside('CLASS_APPLY_REFUSED', { classes: blocked });
    }
    const organizationKind = kinds.find((kind) => ORGANIZATION_KINDS.includes(kind));
    if (kinds.includes('test-organizations')
      && !plan.organizations.testOrganizations.some((o) => o.organization_id === organizationId)) {
      return await refuseInside('TEST_ORGANIZATION_NOT_NAMED');
    }
    if (kinds.includes('hiit-fit')) {
      const hiit = plan.organizations.hiitFit;
      if (organizationId !== HIIT_FIT.organization_id || !hiit.found_id) return await refuseInside('HIIT_FIT_NOT_NAMED');
      if (hiit.apply_would_refuse.length > 0) return await refuseInside('HIIT_FIT_APPLY_REFUSED', { reasons: hiit.apply_would_refuse });
    }
    // A STRICT TV already disconnected (revoked, no session, no pair code) is left as it is: the
    // Disconnect would change nothing. It is reported apart and does not make its gym "affected".
    const connected = ([, , , , revoked, showing, pending]) => revoked === null || showing === true || pending === true;
    const markedTvs = kinds.includes('tvs') ? plan.tvs.material : [];
    const tvsToDisconnect = markedTvs.filter(connected);
    const tvsAlready = markedTvs.filter((row) => !connected(row)).map(([o, v]) => ({ organization_id: o, tv_id: v }));
    const planned = {
      classes: kinds.includes('classes') ? m.classes.length : 0,
      tvs: tvsToDisconnect.length,
      organization: organizationKind !== undefined,
    };
    if (planned.classes === 0 && planned.tvs === 0 && !planned.organization) {
      open = false;
      await client.query('rollback');
      log('nothing-to-apply', { scope, kinds, plan_fingerprint: plan.fingerprint, tvs_already_disconnected: tvsAlready });
      return { status: 'nothing-to-apply', scope, kinds, plan_fingerprint: plan.fingerprint, tvs_already_disconnected: tvsAlready };
    }

    const done = {
      classes: 0, registrations: 0, attendance: 0, tied_runs_untied: 0, register_marks_untied: 0, tvs: 0,
      tvs_already_disconnected: tvsAlready.length, sessions_revoked: 0,
    };
    const mismatch = (table, plannedCount, written) => refuseInside('WRITE_COUNT_MISMATCH', { table, planned: plannedCount, written });
    if (planned.classes > 0) {
      const values = [JSON.stringify(m.classes.map(([o, c]) => ({ o, c }))), organizationId];
      const still = `join pilot.scheduler_classes c on c.organization_id = k.o and c.class_id = k.c
        and ${strictSql('c.title')} and ($2::text is null or c.organization_id = $2)`;
      for (const [table, name, plannedRows] of [['scheduler_attendance', 'attendance', m.attendance],
        ['scheduler_registrations', 'registrations', m.registrations]]) {
        done[name] = (await client.query(`delete from pilot.${table} t using jsonb_to_recordset($1::jsonb) as k(o text, c text) ${still}
          where t.organization_id = k.o and t.class_id = k.c`, values)).rowCount ?? 0;
        if (done[name] !== plannedRows.length) return await mismatch(table, plannedRows.length, done[name]);
      }
      done.classes = (await client.query(`delete from pilot.scheduler_classes c using jsonb_to_recordset($1::jsonb) as k(o text, c text)
        where c.organization_id = k.o and c.class_id = k.c and ${strictSql('c.title')} and ($2::text is null or c.organization_id = $2)`,
      values)).rowCount ?? 0;
      if (done.classes !== m.classes.length) return await mismatch('scheduler_classes', m.classes.length, done.classes);
      // The foreign keys' SET NULL: each planned tied run and register mark kept, its tie cleared.
      done.tied_runs_untied = (await client.query(`select count(*)::int as n from pilot.session_script_runs t
        join jsonb_to_recordset($1::jsonb) as k(o text, r text) on t.organization_id = k.o and t.run_id = k.r where t.class_id is null`,
      [JSON.stringify(m.tied_runs.map(([o, , r]) => ({ o, r })))])).rows[0].n;
      if (done.tied_runs_untied !== m.tied_runs.length) return await mismatch('session_script_runs', m.tied_runs.length, done.tied_runs_untied);
      done.register_marks_untied = (await client.query(`select count(*)::int as n from pilot.session_run_athletes t
        join jsonb_to_recordset($1::jsonb) as k(o text, r text, a text) on t.organization_id = k.o and t.run_id = k.r
         and t.athlete_id = k.a where t.register_class_id is null`,
      [JSON.stringify(m.register_marks.map(([o, , r, a]) => ({ o, r, a })))])).rows[0].n;
      if (done.register_marks_untied !== m.register_marks.length) {
        return await mismatch('session_run_athletes', m.register_marks.length, done.register_marks_untied);
      }
    }
    const tvKeys = JSON.stringify(tvsToDisconnect.map(([o, v]) => ({ o, v })));
    if (planned.tvs > 0) {
      // The app's own Disconnect (gymTvs.ts disconnectGymTv), on STRICT TVs only.
      done.tvs = (await client.query(
        `update pilot.gym_tvs t set revoked_at = coalesce(t.revoked_at, now()), current_run_id = null,
                current_run_set_by_account_id = null, pair_code_hash = null, pair_code_expires_at = null
           from jsonb_to_recordset($1::jsonb) as k(o text, v text)
          where t.organization_id = k.o and t.tv_id = k.v and ${strictSql('t.tv_name')} and ($2::text is null or t.organization_id = $2)
            and (t.revoked_at is null or t.current_run_id is not null or t.pair_code_hash is not null)`,
        [tvKeys, organizationId],
      )).rowCount ?? 0;
      if (done.tvs !== planned.tvs) return await mismatch('gym_tvs', planned.tvs, done.tvs);
    }
    if (planned.organization) {
      // setOrganizationStatus (auth.ts) to inactive, with the name restated. Never a delete.
      const [match, name] = ORGANIZATION_NAME_MATCH[organizationKind];
      const updated = (await client.query(`update pilot.organizations set status = 'inactive', updated_at = now()
        where organization_id = $1 and ${match}`, [organizationId, name, HIIT_FIT.organization_id])).rowCount ?? 0;
      if (updated !== 1) return await mismatch('organizations', 1, updated);
      done.sessions_revoked = (await client.query(
        'update pilot.session_tokens set revoked_at = now() where organization_id = $1 and revoked_at is null', [organizationId],
      )).rowCount ?? 0;
      if (done.sessions_revoked !== sessionsLocked) return await mismatch('session_tokens', sessionsLocked, done.sessions_revoked);
    }
    const mismatches = await endState(client, planned, m, tvKeys, organizationId,
      { hiitFit: organizationKind === 'hiit-fit', tables: catalog.tables });
    if (mismatches.length > 0) return await refuseInside('END_STATE_MISMATCH', { mismatches });

    const classIds = planned.classes > 0 ? m.classes : [];
    const tvIds = tvsToDisconnect;
    const affected = [...new Set([...classIds.map(([o]) => o), ...tvIds.map(([o]) => o),
      ...(planned.organization ? [organizationId] : [])])].sort();
    for (const org of affected) {
      const own = (rows) => rows.filter(([o]) => o === org);
      const ids = { class_ids: own(classIds).map(([, c]) => c), tv_ids: own(tvIds).map(([, v]) => v) };
      const named = planned.organization && org === organizationId;
      await client.query(
        `insert into pilot.audit_events (event_type, organization_id, entity_type, entity_id, details)
         values ($1, $2, $3, $2, $4::jsonb)`,
        [ids.class_ids.length > 0 ? 'data_purged' : 'update', org, AUDIT_ENTITY_TYPE, JSON.stringify({
          plan_fingerprint: plan.fingerprint, scope, kinds, ...ids, organization_set_inactive: named ? organizationKind : null,
          counts: {
            classes_deleted: ids.class_ids.length,
            registrations_deleted: planned.classes > 0 ? own(m.registrations).length : 0,
            attendance_deleted: planned.classes > 0 ? own(m.attendance).length : 0,
            tied_runs_untied: planned.classes > 0 ? own(m.tied_runs).length : 0,
            register_marks_untied: planned.classes > 0 ? own(m.register_marks).length : 0,
            tvs_disconnected: ids.tv_ids.length,
            sessions_revoked: named ? done.sessions_revoked : 0,
          },
          rulings: RULINGS,
        })],
      );
    }
    await client.query('commit');
    open = false;
    const result = {
      status: 'applied', scope, kinds, plan_fingerprint: plan.fingerprint, counts: done, audit_rows: affected.length,
      class_ids: classIds.map(([o, c]) => ({ organization_id: o, class_id: c })),
      tv_ids: tvIds.map(([o, v]) => ({ organization_id: o, tv_id: v })), tvs_already_disconnected: tvsAlready,
      organization_set_inactive: planned.organization ? organizationId : null,
    };
    log('applied', result);
    return result;
  } catch (error) {
    if (open) await client.query('rollback').catch(() => {});
    throw error;
  }
}

/** Command line. Every refusal that needs no database is decided before a client exists. */
export async function run(env = process.env, argv = process.argv.slice(2), {
  createClient = (connectionString) => new pg.Client({ connectionString }), log = defaultLog,
} = {}) {
  const parsed = parseOptions(env, argv);
  if (!parsed.ok) return refusal(log, parsed.refusal.reason);
  const connectionString = env.AZURE_POSTGRES_CONNECTION_STRING;
  if (!connectionString) return refusal(log, 'MISSING_CONNECTION_STRING');
  try {
    assertDeclaredWriteTargetFromEnv(connectionString, env);
  } catch (error) {
    return refusal(log, error instanceof Error ? error.message : 'UNKNOWN_TARGET_ERROR');
  }
  const client = createClient(connectionString);
  // A dropped idle connection emits 'error'; the catch below reports it instead.
  client.on?.('error', () => {});
  try {
    await client.connect();
    const act = parsed.options.apply === true ? applyAuditTestRecords : reportAuditTestRecords;
    return await act(client, parsed.options, { log, refKey: env.PPBF_AUDIT_TEST_CLEANUP_REF_KEY });
  } catch (error) {
    // Name, code and constraint only: a database error's message or detail can quote a row.
    const failure = {
      reason: error && typeof error === 'object' && error.code != null ? 'DATABASE_ERROR' : error instanceof Error ? error.name : 'UnknownError',
      code: error && typeof error === 'object' && 'code' in error ? String(error.code) : undefined,
      constraint: error && typeof error === 'object' && error.constraint != null ? String(error.constraint) : undefined,
    };
    log('failed', failure);
    return { status: 'failed', ...failure };
  } finally {
    await client.end();
  }
}

export const exitCodeFor = (result) => (['dry-run', 'applied', 'nothing-to-apply'].includes(result.status) ? 0 : 1);

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = exitCodeFor(await run());
  } catch (error) {
    defaultLog('failed', { reason: error instanceof Error ? error.name : 'UnknownError' });
    process.exitCode = 1;
  }
}
