import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from 'pg';

/**
 * Read-only report on four tables that exist in a deployed database with no DDL
 * anywhere in this repository: pilot.athlete_chat_audit, board_chat_audit,
 * coach_chat_audit, and individual_chat_audit.
 *
 * Their only DDL was `migrations/003_create_chat_audit_tables.sql`, applied by
 * the DDL-over-HTTP route removed in #111. That directory is now gone, so the
 * tables exist in an environment and in no source file. A rebuilt environment
 * will not have them, and nothing in the tree reads them -- a repo-wide search
 * for all four names returns only prose in two audit documents.
 *
 * That leaves one question source cannot answer: do they hold rows? The names
 * say chat audit, and if the removed route ever wrote through them they may
 * hold minors' conversation history, which is a retention obligation rather
 * than dead weight. Empty means dead and droppable; non-empty means the
 * contents have to be read and dispositioned before anyone drops anything.
 *
 * NOT to be confused with pilot.shadow_chat_audit (singular), which is SHADOW's
 * own live, correctly-migrated table. This script never names it.
 *
 * Every statement is a SELECT inside an explicit READ ONLY transaction, so
 * Postgres itself refuses any write this file could attempt -- it is safe to
 * run against production. Dropping is deliberately not automated here: the drop
 * belongs in a migration, after someone has looked at what is being dropped.
 */

// Hardcoded, and validated below before ever reaching a query string. These are
// constants in this file rather than input, but identifiers cannot be
// parameterized, so the guard is what keeps that true if the list is ever
// edited carelessly.
const ORPHAN_TABLES = [
  'athlete_chat_audit',
  'board_chat_audit',
  'coach_chat_audit',
  'individual_chat_audit',
];

const SAFE_IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

async function loadEnvLocal() {
  const envPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.env.local');

  let contents;
  try {
    contents = await fs.readFile(envPath, 'utf8');
  } catch {
    return; // No .env.local (CI, or a container). The env var must be set.
  }

  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const separator = line.indexOf('=');
    if (separator <= 0) continue;

    const key = line.slice(0, separator).trim();
    if (process.env[key] !== undefined) continue;

    let value = line.slice(separator + 1).trim();
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

function required(name) {
  const value = process.env[name];
  if (!value?.trim()) {
    throw new Error(
      `Missing required environment variable: ${name}. `
      + 'Set it in apps/web/.env.local, or export it before running this script.',
    );
  }
  return value;
}

function resolveSslConfig() {
  if (process.env.NODE_ENV === 'test' && process.env.PPBF_POSTGRES_DISABLE_SSL === 'true') {
    return false;
  }
  return { rejectUnauthorized: true };
}

export async function checkOrphanChatAudit(client) {
  for (const table of ORPHAN_TABLES) {
    if (!SAFE_IDENTIFIER.test(table)) {
      throw new Error(`Refusing to query unsafe identifier: ${JSON.stringify(table)}`);
    }
  }

  await client.query('BEGIN TRANSACTION READ ONLY');
  try {
    const database = (await client.query('select current_database() as db')).rows[0].db;

    const tables = [];
    for (const table of ORPHAN_TABLES) {
      const presence = await client.query('select to_regclass($1) is not null as present', [
        `pilot.${table}`,
      ]);

      if (!presence.rows[0].present) {
        tables.push({ table, present: false, rowCount: 0, columns: [], span: null });
        continue;
      }

      const columnsResult = await client.query(
        `select column_name, data_type
           from information_schema.columns
          where table_schema = 'pilot' and table_name = $1
          order by ordinal_position`,
        [table],
      );
      const columns = columnsResult.rows.map((row) => ({
        name: row.column_name,
        type: row.data_type,
      }));

      const countResult = await client.query(`select count(*)::int as n from pilot.${table}`);
      const rowCount = countResult.rows[0].n;

      // If the table carries a timestamp, the span says whether this is
      // abandoned-on-arrival or something that was written to for a while.
      // Reported as dates only -- this script exists to decide a drop, and
      // never needs to print a row's contents to do that.
      const timestampColumn = columns.find(
        (column) => /^(created_at|logged_at|occurred_at|timestamp)$/.test(column.name),
      );
      let span = null;
      if (timestampColumn && rowCount > 0) {
        const spanResult = await client.query(
          `select min(${timestampColumn.name})::date::text as first,
                  max(${timestampColumn.name})::date::text as last
             from pilot.${table}`,
        );
        span = { column: timestampColumn.name, ...spanResult.rows[0] };
      }

      tables.push({ table, present: true, rowCount, columns, span });
    }

    // Absent from `pilot` is not absent from the database. The DDL that created
    // these ran over HTTP against whatever search_path that request had, and the
    // file is deleted, so nothing proves it targeted `pilot` at all. Sweep every
    // schema for the same four names before concluding anything is dead.
    const elsewhereResult = await client.query(
      `select table_schema, table_name
         from information_schema.tables
        where table_name = any($1::text[])
          and table_schema <> 'pilot'
        order by table_schema, table_name`,
      [ORPHAN_TABLES],
    );

    // Anything ending in _chat_audit that this script does not already know
    // about. Catches a fifth orphan the audit never named, and catches the four
    // under a name that drifted. shadow_chat_audit is SHADOW's own live table
    // and is expected in this list -- it is reported, not flagged.
    const chatAuditFamilyResult = await client.query(
      `select table_schema, table_name
         from information_schema.tables
        where table_name like '%chat_audit%'
        order by table_schema, table_name`,
    );

    // Anything with a foreign key pointing at these tables would make a drop a
    // schema change rather than a cleanup. Source says nothing references them;
    // this asks the database the same question.
    const dependenciesResult = await client.query(
      `select cl.relname as referencing_table, con.conname as constraint_name,
              ref.relname as referenced_table
         from pg_constraint con
         join pg_class cl on cl.oid = con.conrelid
         join pg_class ref on ref.oid = con.confrelid
         join pg_namespace ns on ns.oid = ref.relnamespace
        where con.contype = 'f'
          and ns.nspname = 'pilot'
          and ref.relname = any($1::text[])`,
      [ORPHAN_TABLES],
    );

    await client.query('COMMIT');
    return {
      database,
      tables,
      dependencies: dependenciesResult.rows,
      elsewhere: elsewhereResult.rows,
      chatAuditFamily: chatAuditFamilyResult.rows,
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
}

export async function run() {
  await loadEnvLocal();
  const connectionString = required('AZURE_POSTGRES_CONNECTION_STRING');

  const client = new Client({ connectionString, ssl: resolveSslConfig() });

  await client.connect();
  let report;
  try {
    report = await checkOrphanChatAudit(client);
  } finally {
    await client.end();
  }

  const { database, tables, dependencies, elsewhere, chatAuditFamily } = report;

  console.log('Orphan chat-audit table check (tables with no DDL in this repository)');
  console.log('====================================================================');
  console.log(`database: ${database}`);
  console.log('');

  for (const entry of tables) {
    if (!entry.present) {
      console.log(`pilot.${entry.table}: ABSENT (nothing to drop here)`);
      continue;
    }
    const span = entry.span ? ` | ${entry.span.column} ${entry.span.first} .. ${entry.span.last}` : '';
    console.log(`pilot.${entry.table}: ${entry.rowCount} row(s)${span}`);
    console.log(`    columns: ${entry.columns.map((column) => column.name).join(', ')}`);
  }

  console.log('');
  if (elsewhere.length === 0) {
    console.log('same four names in any other schema: none');
  } else {
    console.log(`same four names in another schema: ${elsewhere.length}`);
    for (const row of elsewhere) {
      console.log(`    ${row.table_schema}.${row.table_name}`);
    }
  }

  console.log(`every table matching %chat_audit%: ${chatAuditFamily.length}`);
  for (const row of chatAuditFamily) {
    console.log(`    ${row.table_schema}.${row.table_name}`);
  }

  console.log('');
  if (dependencies.length === 0) {
    console.log('foreign keys referencing these tables: none');
  } else {
    console.log(`foreign keys referencing these tables: ${dependencies.length}`);
    for (const dependency of dependencies) {
      console.log(`    ${dependency.referencing_table} -> ${dependency.referenced_table} (${dependency.constraint_name})`);
    }
  }
  console.log('====================================================================');

  const present = tables.filter((entry) => entry.present);
  const populated = present.filter((entry) => entry.rowCount > 0);

  if (present.length === 0 && elsewhere.length === 0) {
    console.log('ORPHAN CHAT AUDIT CHECK: NOTHING PRESENT');
    console.log(
      'None of the four tables exist in this database, in pilot or in any other schema. '
      + 'There is nothing here to drop and no migration to write -- the claim that they '
      + 'exist in production is false for this database.',
    );
  } else if (present.length === 0 && elsewhere.length > 0) {
    console.log(`ORPHAN CHAT AUDIT CHECK: PRESENT IN ANOTHER SCHEMA (${elsewhere.length})`);
    console.log(
      'Not in pilot, but the same names exist elsewhere in this database. Whatever created '
      + 'them did not target the schema the rest of the platform uses, which is worth '
      + 'understanding before deciding anything.',
    );
  } else if (populated.length === 0 && dependencies.length === 0) {
    console.log('ORPHAN CHAT AUDIT CHECK: DEAD');
    console.log(
      `${present.length} table(s) exist, all empty, nothing references them, and no source file `
      + 'names them. They are safe to drop -- as a migration, so a rebuilt environment and this '
      + 'one end up in the same state.',
    );
  } else {
    console.log(`ORPHAN CHAT AUDIT CHECK: HOLDS DATA (${populated.length} populated table(s))`);
    console.log(
      'Do not drop these yet. Given the names, the rows may be conversation history belonging '
      + 'to minors, which is a retention and disclosure question before it is a cleanup one. '
      + 'Read what is there, decide the obligation, then write the migration.',
    );
  }

  return report;
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  try {
    const { tables, dependencies, elsewhere } = await run();
    const populated = tables.filter((entry) => entry.present && entry.rowCount > 0);
    // Non-zero means "a human still has to decide", matching the other pilot
    // check scripts: clean is the only silent pass.
    const needsDecision = populated.length > 0 || dependencies.length > 0 || elsewhere.length > 0;
    process.exit(needsDecision ? 1 : 0);
  } catch (error) {
    console.error('ORPHAN CHAT AUDIT CHECK FAILED TO RUN');
    console.error(String(error));
    process.exit(1);
  }
}
