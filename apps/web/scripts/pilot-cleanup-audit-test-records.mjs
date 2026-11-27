#!/usr/bin/env node

/**
 * Finds and reports the audit test records left in a gym, by explicit, named
 * markers only (pilot blocker B6; Jason "2A", OD-2026-10-11-009 item 2; "hiit
 * fit" OD-2026-10-13-012 H-2 A; App Overwatch's GO on #2227). THIS VERSION ONLY
 * REPORTS: it has no write path. The apply comes in lane W5-B6's B6-3.
 *
 * MARKERS, exact:
 *   STRICT  text starting with exactly 'ZZ-AUDIT' or 'AUDIT TEST' (case as
 *           written, no trimming). Only STRICT records are ever planned.
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
 * client exists. K1 to K4 read one repeatable-read, read-only snapshot; each
 * sweep table is read in its own short read-only transaction, so no lock is
 * held across the whole schema. Every transaction is rolled back. Scope is
 * --organization <id> or --all-organizations, never a default.
 *
 *   npm run pilot:cleanup-audit-test-records -- --organization <id>
 */

import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

import { assertDeclaredWriteTargetFromEnv } from './lib/postgres-write-target.mjs';

export const STRICT_MARKERS = Object.freeze(['ZZ-AUDIT', 'AUDIT TEST']);
export const NEAR_RULE = "'zz-audit' anywhere, or 'audit test' first after any whitespace, any case, and not STRICT";
export const TEST_ORGANIZATION_NAME_PREFIX = 'audit test gym';
export const HIIT_FIT = Object.freeze({ organization_id: 'danielles', name: 'hiit fit' });
// Column names that can hold a person's id or name: the GO's list, plus
// parent, person, participant, coach, staff, volunteer, login and subject.
export const PERSON_COLUMN = /athlete|account|guardian|member|user|email|parent|person|participant|coach|staff|volunteer|login|subject/i;
// Keys that print raw: the GO's class, run, TV and organization ids. Any other
// key prints raw only when it is a uuid or an integer and its column is not a
// person's; everything else is hashed. A key nobody thought about is hashed.
export const RAW_KEY_COLUMNS = Object.freeze(['organization_id', 'class_id', 'run_id', 'tv_id']);
const UUID_VALUE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Every foreign key into the class tables, as the class delete (B6-3) expects
// it: columns and ON DELETE action (c cascade, n set null (columns)). Any
// other refuses an apply (UNKNOWN_FOREIGN_KEY).
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
const UTC = (column) => `to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`;
const ident = (name) => `"${String(name).replace(/"/g, '""')}"`;
// "audit test" first after any whitespace, Unicode spaces included.
const LEADING_AUDIT_TEST = "E'^[[:space:]\\u00a0\\u1680\\u2000-\\u200b\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff]*audit test'";
const hitSql = (e) => `(${e} ilike '%zz-audit%' or ${e} ~* ${LEADING_AUDIT_TEST})`;
const strictSql = (e) => `(left(${e}, 8) = 'ZZ-AUDIT' or left(${e}, 10) = 'AUDIT TEST')`;
const markerSql = (e) => `case when left(${e}, 8) = 'ZZ-AUDIT' then 'ZZ-AUDIT'
  when left(${e}, 10) = 'AUDIT TEST' then 'AUDIT TEST' when ${hitSql(e)} then 'NEAR' end`;

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
  return ['int2', 'int4', 'int8', 'uuid'].includes(type) || UUID_VALUE.test(text) ? text : personRef(text, key);
}

const refused = (reason) => ({ ok: false, refusal: { reason } });

/** Reads the scope from the command line. Refuses rather than guesses. */
export function parseOptions(env = process.env, argv = process.argv.slice(2)) {
  // No write path exists yet: an apply request is refused, not run as a dry
  // run, so nobody reads a report as a deletion.
  if (env.PPBF_AUDIT_TEST_CLEANUP_APPLY === 'true') return refused('APPLY_NOT_AVAILABLE');
  let organizationId;
  let allOrganizations = false;
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
    } else {
      return refused('UNKNOWN_ARGUMENT'); // not echoed: operator input
    }
  }
  if (organizationId !== undefined && allOrganizations) return refused('ORGANIZATION_SCOPE_AMBIGUOUS');
  if (organizationId === undefined && !allOrganizations) return refused('ORGANIZATION_SCOPE_REQUIRED');
  return { ok: true, options: allOrganizations ? { allOrganizations: true } : { organizationId } };
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
            ${UTC('start_at')} as start_at, ${UTC('end_at')} as end_at, (start_at <= now() and now() < end_at) as running_now
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
  const unknownForeignKeys = (await client.query(
    `select fn.nspname || '.' || fc.relname || '(' || ${fkColumns('c.conrelid', 'c.conkey')} || ')->'
            || tn.nspname || '.' || tc.relname || '(' || ${fkColumns('c.confrelid', 'c.confkey')} || ') '
            || c.confdeltype::text || '(' || coalesce(${fkColumns('c.conrelid', 'c.confdelsetcols')}, '') || ')' as fk
       from pg_catalog.pg_constraint c
       join pg_catalog.pg_class fc on fc.oid = c.conrelid join pg_catalog.pg_namespace fn on fn.oid = fc.relnamespace
       join pg_catalog.pg_class tc on tc.oid = c.confrelid join pg_catalog.pg_namespace tn on tn.oid = tc.relnamespace
      where c.contype = 'f' and tn.nspname = 'pilot'
        and tc.relname in ('scheduler_classes', 'scheduler_registrations', 'scheduler_attendance')`,
  )).rows.map((row) => row.fk).filter((fk) => !KNOWN_CLASS_FOREIGN_KEYS.includes(fk)).sort();

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
      return [row.organization_id, row.class_id, row.title, row.status, row.start_at, row.end_at,
        counts.activity_log.get(key) ?? 0, counts.floor_plans_daily.get(key) ?? 0];
    }),
    registrations: registrations.map((r) => [r.organization_id, r.class_id, r.registration_id, r.athlete_id, r.status]),
    attendance: attendance.map((a) => [a.organization_id, a.class_id, a.attendance_id, a.athlete_id, a.status]),
    tied_runs: runs.map((run) => [run.organization_id, run.class_id, run.run_id, run.run_state]),
    register_marks: registerMarks.map((m) => [m.organization_id, m.class_id, m.run_id, m.athlete_id]),
    unknown_foreign_keys: unknownForeignKeys,
  };
  return { report, material, unknownForeignKeys };
}

/** K2: every TV in scope; the STRICT-named ones are the planned ones. */
async function readTvs(client, organizationId) {
  const rows = (await client.query(
    `select organization_id, tv_id, ${markerSql('tv_name')} as marker, ${UTC('created_at')} as created_at,
            ${UTC('paired_at')} as paired_at, ${UTC('last_seen_at')} as last_seen_at, ${UTC('revoked_at')} as revoked_at,
            current_run_id is not null as showing_a_session, pair_code_hash is not null as pair_code_pending
       from pilot.gym_tvs where ($1::text is null or organization_id = $1)
      order by organization_id, tv_id`,
    [organizationId],
  )).rows;
  const marked = rows.filter((row) => STRICT_MARKERS.includes(row.marker));
  return {
    report: { marked, others: rows.filter((row) => !STRICT_MARKERS.includes(row.marker)) },
    // Not last_seen_at: a working TV moves it every few seconds.
    material: marked.map((row) => [row.organization_id, row.tv_id, row.marker, row.paired_at, row.revoked_at,
      row.showing_a_session, row.pair_code_pending]),
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
    hiit_fit_holding: holding,
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
    tables_skipped_no_organization_column: [], truncated_tables: [], strict: [], near: [],
  };
  for (const [table, { columns, text, key }] of tables) {
    if (text.length === 0) continue;
    if (single && !columns.has('organization_id')) {
      out.tables_skipped_no_organization_column.push(table);
      continue;
    }
    const found = await readOnly(client,
      `select ${key.map((k, i) => `${ident(k.name)}::text as k${i}, `).join('')}
              ${columns.has('organization_id') ? 'organization_id::text' : 'null::text'} as organization_id,
              array[${text.map((c) => markerSql(ident(c))).join(', ')}]::text[] as markers
         from pilot.${ident(table)}
        where (${text.map((c) => hitSql(ident(c))).join(' or ')}) ${single ? 'and organization_id = $1' : ''}
        ${key.length > 0 ? `order by ${key.map((_, i) => `k${i}`).join(', ')}` : ''}
        limit ${SWEEP_ROW_LIMIT + 1}`,
      single ? [options.organizationId] : []);
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
  // Exactly one scope: a call with neither must not read as "every organization".
  const single = typeof options?.organizationId === 'string' && options.organizationId !== '';
  if (single === (options?.allOrganizations === true)) return refusal(log, 'ORGANIZATION_SCOPE_REQUIRED');
  const scope = single ? { organization_id: options.organizationId } : { all_organizations: true };
  const organizationId = single ? options.organizationId : null;
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
    const classes = await readClasses(client, organizationId, key);
    const tvs = await readTvs(client, organizationId);
    const organizations = await readOrganizations(client, organizationId, catalog.tables);
    await close();
    const swept = await sweep(client, options, catalog, key);

    const fingerprint = `sha256:${crypto.createHash('sha256').update(JSON.stringify({
      markers: STRICT_MARKERS, scope, ...classes.material, tvs: tvs.material, ...organizations.material,
    })).digest('hex')}`;
    const counts = {
      classes: classes.report.length,
      registrations: classes.report.reduce((n, c) => n + c.registrations.length, 0),
      attendance: classes.report.reduce((n, c) => n + c.attendance.length, 0),
      tvs_marked: tvs.report.marked.length,
      test_organizations: organizations.testOrganizations.length,
      hiit_fit_found: organizations.hiitFit.found_id,
      sweep_strict: swept.strict.length,
      sweep_near: swept.near.length,
    };
    const report = {
      mode: 'dry-run', scope, markers: { strict: STRICT_MARKERS, near: NEAR_RULE }, person_ref: personRefKey, plan_fingerprint: fingerprint, counts,
      unknown_foreign_keys: classes.unknownForeignKeys, classes: classes.report, tvs: tvs.report,
      test_organizations: organizations.testOrganizations, hiit_fit: organizations.hiitFit, sweep: swept,
    };
    log('plan', report);
    log('dry-run', { plan_fingerprint: fingerprint, person_ref: personRefKey, counts, note: 'report only: this version has no write path' });
    return { status: 'dry-run', ...report };
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
    return await reportAuditTestRecords(client, parsed.options, { log, refKey: env.PPBF_AUDIT_TEST_CLEANUP_REF_KEY });
  } catch (error) {
    // Name, code and constraint only: a database error's message or detail can quote a row.
    const failure = {
      reason: error instanceof Error ? error.name : 'UnknownError',
      code: error && typeof error === 'object' && 'code' in error ? String(error.code) : undefined,
      constraint: error && typeof error === 'object' && 'constraint' in error ? String(error.constraint) : undefined,
    };
    log('failed', failure);
    return { status: 'failed', ...failure };
  } finally {
    await client.end();
  }
}

export const exitCodeFor = (result) => (result.status === 'dry-run' ? 0 : 1);

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = exitCodeFor(await run());
  } catch (error) {
    defaultLog('failed', { reason: error instanceof Error ? error.name : 'UnknownError' });
    process.exitCode = 1;
  }
}
