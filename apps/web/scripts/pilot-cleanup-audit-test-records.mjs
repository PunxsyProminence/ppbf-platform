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
 *   NEAR    'zz-audit' anywhere, or 'audit test' first after whitespace, any
 *           case, not STRICT. Reported, never planned, in every mode.
 *   K3      organizations whose name starts 'audit test gym' (any case).
 *   K4      organization_id 'danielles' AND name 'hiit fit' (any case).
 * Kinds: K1 classes (and their sign-ups, attendance and tied runs), K2 gym TVs,
 * K3, K4, and K5, a sweep of every text column of every pilot table read from
 * pg_catalog (keys only). No account, athlete or membership text is matched.
 *
 * IT NEVER PRINTS free text or a raw person id. An athlete id, and any key
 * column PERSON_COLUMN matches, prints as personRef: the first 12 hex
 * characters of its sha256. The fingerprint is over the raw values.
 *
 * Target guard as RR-1 (scripts/lib/postgres-write-target.mjs), before a
 * client exists; `begin transaction read only`, then rollback, every time;
 * scope is --organization <id> or --all-organizations, never a default.
 *
 *   npm run pilot:cleanup-audit-test-records -- --organization <id>
 */

import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

import { assertDeclaredWriteTargetFromEnv } from './lib/postgres-write-target.mjs';

export const STRICT_MARKERS = Object.freeze(['ZZ-AUDIT', 'AUDIT TEST']);
export const NEAR_RULE = "'zz-audit' anywhere, or 'audit test' first after whitespace, any case, and not STRICT";
export const TEST_ORGANIZATION_NAME_PREFIX = 'audit test gym';
export const HIIT_FIT = Object.freeze({ organization_id: 'danielles', name: 'hiit fit' });
// The GO's list, plus parent, person, coach, staff, volunteer, login and
// subject: each names a column that can hold a person's id or name.
export const PERSON_COLUMN = /athlete|account|guardian|member|user|email|parent|person|coach|staff|volunteer|login|subject/i;
// The foreign keys into the class tables that the class delete (B6-3)
// accounts for. Any other refuses an apply (UNKNOWN_FOREIGN_KEY).
export const KNOWN_CLASS_FOREIGN_KEYS = Object.freeze([
  'scheduler_attendance->scheduler_classes',
  'scheduler_registrations->scheduler_classes',
  'session_run_athletes->scheduler_attendance',
  'session_script_runs->scheduler_classes',
]);
// Rows that do not stop "hiit fit" being empty (H-2 A): its own row and the
// audit history about it.
export const EMPTY_EXCEPT = Object.freeze(['organizations', 'audit_events']);
export const SWEEP_ROW_LIMIT = 500;
const UTC = (column) => `to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`;
const ident = (name) => `"${String(name).replace(/"/g, '""')}"`;
const markerSql = (e) => `case when left(${e}, 8) = 'ZZ-AUDIT' then 'ZZ-AUDIT'
  when left(${e}, 10) = 'AUDIT TEST' then 'AUDIT TEST'
  when ${e} ilike '%zz-audit%' or lower(ltrim(${e}, E' \\t\\r\\n')) like 'audit test%' then 'NEAR' end`;
const strictSql = (e) => `(left(${e}, 8) = 'ZZ-AUDIT' or left(${e}, 10) = 'AUDIT TEST')`;

function defaultLog(event, payload) {
  const line = JSON.stringify({ event: `audit_test_cleanup.${event}`, ...payload }, null, event === 'plan' ? 2 : 0);
  if (event === 'refused' || event === 'failed') console.error(line);
  else console.log(line);
}

/** A person's id as printed: the first 12 hex characters of its sha256. */
export function personRef(value) {
  if (value === null || value === undefined) return null;
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 12);
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

/** Every ordinary pilot table: its text columns, primary key, and whether it has organization_id. */
async function readCatalog(client) {
  const rows = (await client.query(
    `select c.relname as t, a.attname as col,
            (ty.oid in ('text'::regtype, 'varchar'::regtype, 'bpchar'::regtype)
              or ty.typbasetype in ('text'::regtype, 'varchar'::regtype, 'bpchar'::regtype)) as is_text,
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
  for (const row of rows) {
    const entry = tables.get(row.t) ?? { text: [], key: [], hasOrganization: false };
    if (row.is_text) entry.text.push(row.col);
    if (row.pk_ord !== null) entry.key[Number(row.pk_ord) - 1] = row.col;
    if (row.col === 'organization_id') entry.hasOrganization = true;
    tables.set(row.t, entry);
  }
  return tables;
}

/** Rows of `table` naming one of the planned classes in `column`, with `select` per row. */
async function perClass(client, keys, table, column, select) {
  return (await client.query(
    `select t.organization_id, t.${ident(column)} as class_id, ${select}
       from pilot.${ident(table)} t
       join jsonb_to_recordset($1::jsonb) as k(o text, c text) on t.organization_id = k.o and t.${ident(column)} = k.c
      ${select.includes('count(') ? 'group by 1, 2' : 'order by 1, 2, 3'}`,
    [keys],
  )).rows;
}

/** K1: STRICT-titled classes, what hangs off them, and what an apply would refuse on. */
async function readClasses(client, organizationId) {
  const classes = (await client.query(
    `select organization_id, class_id, ${markerSql('title')} as marker, status,
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
  const counts = {};
  for (const [name, table, column] of [['register_marks', 'session_run_athletes', 'register_class_id'],
    ['activity_log', 'activity_log', 'class_id'], ['floor_plans_daily', 'floor_plans_daily', 'class_id'],
    ['audit_rows', 'audit_events', 'entity_id']]) {
    const rows = await perClass(client, keys, table, column, 'count(*)::int as n');
    counts[name] = new Map(rows.map((row) => [keyOf(row.organization_id, row.class_id), row.n]));
  }
  const unknownForeignKeys = [...new Set((await client.query(
    `select regexp_replace(conrelid::regclass::text, '^pilot\\.', '') || '->' || regexp_replace(confrelid::regclass::text, '^pilot\\.', '') as fk
       from pg_catalog.pg_constraint
      where contype = 'f' and confrelid in ('pilot.scheduler_classes'::regclass,
            'pilot.scheduler_registrations'::regclass, 'pilot.scheduler_attendance'::regclass)`,
  )).rows.map((row) => row.fk).filter((fk) => !KNOWN_CLASS_FOREIGN_KEYS.includes(fk)))].sort();

  const byClass = (rows) => groupBy(rows, (row) => keyOf(row.organization_id, row.class_id));
  const [regs, marks, tied] = [byClass(registrations), byClass(attendance), byClass(runs)];
  const report = classes.map((row) => {
    const key = keyOf(row.organization_id, row.class_id);
    const count = (name) => counts[name].get(key) ?? 0;
    const tiedRuns = (tied.get(key) ?? []).map((run) => ({ run_id: run.run_id, run_state: run.run_state }));
    const wouldRefuse = [];
    if (tiedRuns.some((run) => run.run_state === 'in_progress')) wouldRefuse.push('TIED_RUN_LIVE');
    if (row.running_now) wouldRefuse.push('CLASS_RUNNING_NOW');
    if (count('activity_log') + count('floor_plans_daily') > 0) wouldRefuse.push('UNTRACKED_REFERENCE');
    if (unknownForeignKeys.length > 0) wouldRefuse.push('UNKNOWN_FOREIGN_KEY');
    return {
      organization_id: row.organization_id, class_id: row.class_id, marker: row.marker, status: row.status,
      start_at: row.start_at, end_at: row.end_at,
      registrations: (regs.get(key) ?? []).map((r) => ({ registration_id: r.registration_id, athlete_ref: personRef(r.athlete_id), status: r.status })),
      attendance: (marks.get(key) ?? []).map((a) => ({ attendance_id: a.attendance_id, athlete_ref: personRef(a.athlete_id), status: a.status })),
      tied_runs: tiedRuns,
      register_marks_pointing_here: count('register_marks'),
      untracked_references: { activity_log: count('activity_log'), floor_plans_daily: count('floor_plans_daily') },
      audit_rows_naming_it: count('audit_rows'),
      apply_would_refuse: wouldRefuse,
    };
  });
  const material = {
    classes: classes.map((row) => [row.organization_id, row.class_id, row.status, row.marker]),
    registrations: registrations.map((r) => [r.organization_id, r.class_id, r.registration_id, r.athlete_id, r.status]),
    attendance: attendance.map((a) => [a.organization_id, a.class_id, a.attendance_id, a.athlete_id, a.status]),
    tied_runs: runs.map((run) => [run.organization_id, run.class_id, run.run_id, run.run_state]),
    unknown_foreign_keys: unknownForeignKeys,
  };
  return { report, material, unknownForeignKeys };
}

/** K2: every TV in scope; the STRICT-named ones are the planned ones. */
async function readTvs(client, organizationId) {
  const rows = (await client.query(
    `select organization_id, tv_id, ${markerSql('tv_name')} as marker, ${UTC('created_at')} as created_at,
            ${UTC('paired_at')} as paired_at, ${UTC('last_seen_at')} as last_seen_at, ${UTC('revoked_at')} as revoked_at
       from pilot.gym_tvs where ($1::text is null or organization_id = $1)
      order by organization_id, tv_id`,
    [organizationId],
  )).rows;
  const marked = rows.filter((row) => STRICT_MARKERS.includes(row.marker));
  return {
    report: { marked, others: rows.filter((row) => !STRICT_MARKERS.includes(row.marker)) },
    material: marked.map((row) => [row.organization_id, row.tv_id, row.marker, row.revoked_at]),
  };
}

/** K3 (Audit Test Gyms) and K4 ("hiit fit"): status, members by role, rows per table. */
async function readOrganizations(client, organizationId, catalog) {
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
  for (const [table, entry] of ids.length === 0 ? [] : catalog) {
    if (!entry.hasOrganization) continue;
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
  if (hiit) {
    const holding = Object.keys(held.get(hiit.organization_id)).filter((t) => !EMPTY_EXCEPT.includes(t)).sort();
    hiitFit = {
      found_id: true,
      name_matches: hiit.hiit_fit_name,
      ...(hiit.hiit_fit_name ? {} : { note: 'id found, name differs' }),
      status: hiit.status,
      rows_by_table: held.get(hiit.organization_id),
      holding_tables: holding,
      apply_would_refuse: [...(hiit.hiit_fit_name ? [] : ['NAME_DIFFERS']), ...(holding.length > 0 ? ['NOT_EMPTY'] : [])],
    };
  }
  const material = {
    organizations: rows.map((row) => [row.organization_id, row.status, row.test_name, row.hiit_fit_id, row.hiit_fit_name]),
    rows_by_table: ids.map((id) => [id, Object.entries(held.get(id)).sort()]),
  };
  return { testOrganizations, hiitFit, material };
}

/** K5: every text column of every pilot table. Keys only; report only, in every mode. */
async function sweep(client, options, catalog) {
  const single = options.allOrganizations !== true;
  const out = { tables_scanned: 0, columns_scanned: 0, tables_skipped_no_organization_column: [], truncated_tables: [], strict: [], near: [] };
  for (const [table, { text, key, hasOrganization }] of catalog) {
    if (text.length === 0) continue;
    if (single && !hasOrganization) {
      out.tables_skipped_no_organization_column.push(table);
      continue;
    }
    const found = (await client.query(
      `select ${key.map((k, i) => `${ident(k)}::text as k${i}, `).join('')}
              ${hasOrganization ? 'organization_id::text' : 'null::text'} as organization_id,
              array[${text.map((c) => markerSql(ident(c))).join(', ')}]::text[] as markers
         from pilot.${ident(table)}
        where (${text.map((c) => `${ident(c)} ilike '%zz-audit%' or ${ident(c)} ilike '%audit test%'`).join(' or ')})
          ${single ? 'and organization_id = $1' : ''}
        ${key.length > 0 ? `order by ${key.map((_, i) => `k${i}`).join(', ')}` : ''}
        limit ${SWEEP_ROW_LIMIT + 1}`,
      single ? [options.organizationId] : [],
    )).rows;
    out.tables_scanned += 1;
    out.columns_scanned += text.length;
    if (found.length > SWEEP_ROW_LIMIT) out.truncated_tables.push(table);
    for (const row of found.slice(0, SWEEP_ROW_LIMIT)) {
      const rowKey = Object.fromEntries(key.map((k, i) => [k, PERSON_COLUMN.test(k) ? personRef(row[`k${i}`]) : row[`k${i}`]]));
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

/**
 * The dry run. `client` has pg's `query(text, values)` shape; the caller owns
 * connecting and ending it. Returns { status: 'dry-run', ... } or
 * { status: 'refused', reason }; throws, after rolling back, on a database
 * error. It never writes.
 */
export async function reportAuditTestRecords(client, options, { log = defaultLog } = {}) {
  // Exactly one scope: a call with neither must not read as "every organization".
  const single = typeof options?.organizationId === 'string' && options.organizationId !== '';
  if (single === (options?.allOrganizations === true)) {
    log('refused', { reason: 'ORGANIZATION_SCOPE_REQUIRED' });
    return { status: 'refused', reason: 'ORGANIZATION_SCOPE_REQUIRED' };
  }
  const scope = single ? { organization_id: options.organizationId } : { all_organizations: true };
  const organizationId = single ? options.organizationId : null;
  let open = false;
  try {
    await client.query('begin transaction read only');
    open = true;
    await client.query("set local lock_timeout = '10s'");
    await client.query("set local statement_timeout = '5min'");
    if (single && (await client.query('select 1 from pilot.organizations where organization_id = $1', [organizationId])).rows.length !== 1) {
      await client.query('rollback');
      open = false;
      log('refused', { reason: 'ORGANIZATION_NOT_FOUND' });
      return { status: 'refused', reason: 'ORGANIZATION_NOT_FOUND' };
    }
    const catalog = await readCatalog(client);
    const classes = await readClasses(client, organizationId);
    const tvs = await readTvs(client, organizationId);
    const organizations = await readOrganizations(client, organizationId, catalog);
    const swept = await sweep(client, options, catalog);
    await client.query('rollback');
    open = false;

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
      mode: 'dry-run', scope, markers: { strict: STRICT_MARKERS, near: NEAR_RULE }, plan_fingerprint: fingerprint, counts,
      unknown_foreign_keys: classes.unknownForeignKeys, classes: classes.report, tvs: tvs.report,
      test_organizations: organizations.testOrganizations, hiit_fit: organizations.hiitFit, sweep: swept,
    };
    log('plan', report);
    log('dry-run', { plan_fingerprint: fingerprint, counts, note: 'report only: this version has no write path' });
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
  const client = createClient(connectionString);
  // A dropped idle connection emits 'error'; the catch below reports it instead.
  client.on?.('error', () => {});
  try {
    await client.connect();
    return await reportAuditTestRecords(client, parsed.options, { log });
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
