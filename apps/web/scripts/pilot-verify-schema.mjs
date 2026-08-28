#!/usr/bin/env node

/**
 * Checks that the database actually has the schema this commit expects.
 *
 * WHY THIS EXISTS
 *
 * deploy-staging.yml and deploy-production.yml both gate on an input called
 * `migrations_complete` / `schema_migrations_complete`, and both say plainly in
 * their own comments that it "is an attestation from the operator dispatching
 * it, not a check against the database". That is the only step in the pipeline
 * nothing verifies, and it has now been attested ahead of the migration twice
 * in two days:
 *
 *   2026-08-06  deploy-production dispatched with CONFIRMED while the
 *               data-retention migration had not run. The SHA gate happened to
 *               refuse the run first, for an unrelated reason.
 *   2026-08-07  deploy-production dispatched and SUCCEEDED with CONFIRMED while
 *               apply-migrations for audit-event-vocabulary sat unapproved. The
 *               deploy went out; the constraint it needed did not exist. The
 *               only reason nothing broke is that the endpoint depending on it
 *               was already failing.
 *
 * Neither was carelessness so much as the gate's design: a human is asked to
 * remember something a machine can read directly. So read it directly. This
 * derives the expected objects from the migration SQL in the commit being
 * deployed and asserts each one exists in the target database.
 *
 * WHAT IT CANNOT SEE
 *
 * Objects created by dynamic SQL inside a DO block, and any semantic change
 * that does not add a named object (a widened check constraint keeps its name,
 * so this proves the constraint exists, not that it admits a new value). It is
 * a floor, not a proof: it catches "the migration never ran", which is the
 * failure that has actually happened here, and it does not pretend to catch
 * every possible drift.
 *
 * Views were in that list until 2026-08-07, when the research-triage migration
 * became the first one here to create a view -- and the gate reported the same
 * 99/100/136/72 it reported before the migration existed. It would have passed
 * just as happily against a database where the view was absent, which is the
 * exact failure this file was written to stop. Views are checked now.
 *
 * ORDER MATTERS, AND IT IS NOT ALPHABETICAL. A migration may drop a constraint
 * an earlier one added, so the expected set depends on the sequence the files
 * are read in. That sequence comes from migration-apply-order.mjs, which reads
 * the `all` list out of .github/workflows/apply-migrations.yml -- the list a
 * rebuild actually executes. If it cannot be read, this refuses to run rather
 * than verifying a smaller schema; see that module's docblock.
 *
 * READ ONLY. It issues no DDL and writes no row.
 *
 * Usage:
 *   AZURE_POSTGRES_CONNECTION_STRING=... node scripts/pilot-verify-schema.mjs
 */

import fs from 'node:fs';

import { Client } from 'pg';

import { migrationApplyOrder } from './migration-apply-order.mjs';

/**
 * Strips line comments and splits into statements.
 *
 * The CRLF normalisation is load-bearing, not tidiness. These files check out
 * with CRLF on Windows, and `--.*$` does not match a line ending in \r: `.`
 * excludes carriage returns and `$` without the m flag means end of string. So
 * on a developer machine no comment was stripped, every `^`-anchored match
 * failed, and the verifier silently found almost nothing -- while passing on
 * Linux CI. A verifier that quietly checks nothing is worse than no verifier.
 */
function statementsIn(sql) {
  return sql
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n')
    .split(';')
    .map((statement) => statement.replace(/\s+/g, ' ').trim().toLowerCase())
    .filter(Boolean);
}

export function expectedObjectsFrom(sqlFiles) {
  const tables = new Set();
  const columns = new Set();
  const indexes = new Set();
  const constraints = new Set();
  const views = new Set();

  for (const file of sqlFiles) {
    for (const statement of statementsIn(fs.readFileSync(file, 'utf8'))) {
      const createTable = statement.match(/^create table (?:if not exists )?pilot\.(\w+)/);
      if (createTable) tables.add(createTable[1]);

      // `or replace` and `materialized` are both optional and independent; a
      // migration may use either. Matching the name is all that is needed --
      // the actual side queries pg_class for both relkinds.
      const createView = statement.match(
        /^create (?:or replace )?(?:materialized )?view (?:if not exists )?pilot\.(\w+)/,
      );
      if (createView) views.add(createView[1]);

      const alterTable = statement.match(/^alter table (?:if exists )?pilot\.(\w+)/);
      if (alterTable) {
        for (const match of statement.matchAll(/add column (?:if not exists )?(\w+)/g)) {
          columns.add(`${alterTable[1]}.${match[1]}`);
        }
      }

      const createIndex = statement.match(/^create (?:unique )?index (?:if not exists )?(\w+)/);
      if (createIndex) indexes.add(createIndex[1]);

      for (const match of statement.matchAll(/add constraint (\w+)/g)) {
        constraints.add(match[1]);
      }

      // A constraint a later migration SUPERSEDES is not expected to exist.
      //
      // Widening a vocabulary by dropping a constraint and adding it back
      // under a new name is this repository's sanctioned pattern -- it is how
      // the readiness `method` check, the film-study review_state check and
      // the correction check were each widened, in their own migrations, so
      // the decision is recorded rather than edited into an existing file.
      //
      // Without this the verifier expected every name ever added, including
      // the ones deliberately replaced, and reported the superseded name as a
      // missing object. That is a false failure on a correctly migrated
      // database -- and because this gate runs before a deploy, it would have
      // blocked every deploy after the next widening rather than catching
      // anything real.
      //
      // Files are walked in the order a rebuild APPLIES them -- see
      // migration-apply-order.mjs, which reads the `all` list out of
      // apply-migrations.yml -- so add-then-drop resolves to dropped and
      // drop-then-re-add resolves to present.
      //
      // That order used to be inferred from filenames, and this comment used to
      // argue that reading the workflow's list would be "a second copy" of it.
      // It is the opposite: the `all` list is the authority on what a rebuild
      // runs, so reading it removes the inference rather than duplicating it.
      // The inference was already wrong. drill-library-check-drop drops
      // pilot_drill_library_discipline_check, and its filename sorts BEFORE the
      // drill-library-v3 file that adds it, so a filename walk saw the drop
      // first as a no-op, then the add, and expected a constraint that a
      // correctly migrated database does not have -- a false failure on a gate
      // that runs before a deploy.
      for (const match of statement.matchAll(/drop constraint (?:if exists )?(\w+)/g)) {
        constraints.delete(match[1]);
      }
    }
  }

  return { tables, columns, indexes, constraints, views };
}

async function main() {
  const connectionString = process.env.AZURE_POSTGRES_CONNECTION_STRING;
  if (!connectionString) {
    console.error(JSON.stringify({ event: 'schema.verify.failed', reason: 'MISSING_CONNECTION_STRING' }));
    process.exit(1);
  }

  // A gate that cannot establish the apply order REFUSES, and says so in the
  // same shape as every other failure here. It does not fall back to a
  // filename walk and it does not verify a subset: an expected set built from
  // a partial order is smaller than the schema, so it would report green
  // against a database missing everything it failed to read about. Silent
  // shrinkage is the one failure worse than the false failure this replaced.
  let files;
  try {
    files = migrationApplyOrder();
  } catch (error) {
    console.error(JSON.stringify({
      event: 'schema.verify.failed',
      reason: 'MIGRATION_ORDER_UNREADABLE',
      detail: error instanceof Error ? error.message : String(error),
    }, null, 2));
    process.exit(1);
  }

  const expected = expectedObjectsFrom(files);
  const client = new Client({
    connectionString,
    ssl: process.env.PPBF_POSTGRES_DISABLE_SSL === 'true' ? undefined : { rejectUnauthorized: false },
  });
  await client.connect();

  try {
    const actualTables = new Set(
      (await client.query(`select table_name from information_schema.tables where table_schema='pilot'`))
        .rows.map((row) => row.table_name),
    );
    const actualColumns = new Set(
      (await client.query(`select table_name, column_name from information_schema.columns where table_schema='pilot'`))
        .rows.map((row) => `${row.table_name}.${row.column_name}`),
    );
    const actualIndexes = new Set(
      (await client.query(`select indexname from pg_indexes where schemaname='pilot'`))
        .rows.map((row) => row.indexname),
    );
    const actualConstraints = new Set(
      (await client.query(
        `select c.conname from pg_constraint c
           join pg_namespace n on n.oid = c.connamespace
          where n.nspname = 'pilot'`,
      )).rows.map((row) => row.conname),
    );
    // pg_class rather than information_schema.views: the latter omits
    // materialized views entirely, so a migration that created one would go
    // unchecked for the same reason plain views did.
    const actualViews = new Set(
      (await client.query(
        `select c.relname from pg_class c
           join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'pilot' and c.relkind in ('v', 'm')`,
      )).rows.map((row) => row.relname),
    );

    const missing = {
      tables: [...expected.tables].filter((name) => !actualTables.has(name)),
      columns: [...expected.columns].filter((name) => !actualColumns.has(name)),
      indexes: [...expected.indexes].filter((name) => !actualIndexes.has(name)),
      constraints: [...expected.constraints].filter((name) => !actualConstraints.has(name)),
      views: [...expected.views].filter((name) => !actualViews.has(name)),
    };

    const missingCount = Object.values(missing).reduce((total, list) => total + list.length, 0);

    // `sqlFiles` is reported so the size of the run is visible, not just its
    // verdict. Every count below is derived from that many files; if the order
    // ever came back short, this is the number that says so, and
    // schemaVerification.pg.test.ts asserts it against the files on disk.
    const checked = {
      sqlFiles: files.length,
      tables: expected.tables.size,
      columns: expected.columns.size,
      indexes: expected.indexes.size,
      constraints: expected.constraints.size,
      views: expected.views.size,
    };

    if (missingCount > 0) {
      // Names of schema objects only -- never a row, never a value.
      console.error(JSON.stringify({
        event: 'schema.verify.failed',
        reason: 'MIGRATIONS_NOT_APPLIED',
        missing,
        checked,
      }, null, 2));
      process.exitCode = 1;
      return;
    }

    console.log(JSON.stringify({ event: 'schema.verify.ok', checked }));
  } finally {
    await client.end();
  }
}

// Importable for tests without running a verification.
if (process.env.PPBF_SCHEMA_VERIFY_SKIP_MAIN !== 'true') {
  await main();
}
