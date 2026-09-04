// Builds the schema PRODUCTION ACTUALLY RUNS: the base file plus every
// migration in infra/azure, applied to a fresh database, strictly in the
// order production actually deploys them in.
//
// WHY THIS EXISTS. Every .pg.test.ts hand-picks the migrations it thinks it
// needs -- a MIGRATION_FILE constant, or a SCHEMA_FILES array, or a couple of
// inline readFile calls. That was fine while each suite only touched its own
// tables. It stops being fine the moment shared code reads a column from a
// migration a suite did not pick, because then the suite is not testing a
// smaller production: it is testing a database that has never existed
// anywhere.
//
// That is not hypothetical. Adding `deleted_at is null` to the authorization
// queries in access.ts (#706) broke FOURTEEN suites at once, none of which had
// anything to do with deletion -- they simply built databases without the
// data-retention migration and then called code that assumed production's
// schema. Each was patched by hand. The next change to touch an unpicked
// column will break a different arbitrary fourteen.
//
// THE ORDER IS AUTHORITATIVE, NOT DISCOVERED. This module previously applied
// migrations by fixpoint -- try them all, keep the ones that succeed, repeat
// with what is left -- reasoning that there was no recoverable historical
// order to copy. That reasoning was wrong: a fixpoint retry can silently
// commit two migrations in the opposite of their real deploy order whenever
// one fails its first attempt and a later, independent one does not (see
// migration-apply-order.mjs's own drill-library-check-drop/v3 precedent,
// where BOTH orders "succeed" and only one matches what production actually
// has). `migrationApplyOrder()` already exists, already parses the one true
// order out of `.github/workflows/apply-migrations.yml`'s `all` list, and is
// already relied on by migrationDispatchCoverage.test.ts and
// pilot-verify-schema.mjs. Reusing it here -- instead of re-deriving order by
// trial and error -- is what actually reproduces the schema production runs.
//
// A synthetic test universe (a handful of throwaway files with no relation to
// the real 123-file corpus) is not obligated to mirror the real workflow: it
// may pass its own small, matched `workflowPath` alongside its own `infraDir`,
// parsed by this exact same function. Real callers never do -- they rely on
// the default, which is the one true workflow file -- so production behavior
// never depends on alphabetical sort or on any second, hand-maintained order.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { migrationApplyOrder } from '../migration-apply-order.mjs';

/** The base schema. Not a migration -- it is applied first, unconditionally. */
export const BASE_SCHEMA_FILE = 'pilot_slice_postgres.sql';

export const DEFAULT_INFRA_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../infra/azure',
);

/**
 * Every migration file, base schema excluded, in authoritative deploy order.
 *
 * `workflowPath`, when given, points at a small disposable workflow-shaped
 * file instead of the real `.github/workflows/apply-migrations.yml` -- for a
 * synthetic `infraDir` whose files have no relationship to the real corpus.
 * Real callers never pass it, so real runtime and every real-corpus test
 * always validates against the one true workflow.
 */
export async function listMigrationFiles(infraDir = DEFAULT_INFRA_DIR, workflowPath = undefined) {
  const order = migrationApplyOrder({ infraDir, workflowPath });
  // order[0] is the base schema's own absolute path; migrationApplyOrder()
  // always puts it first (see that module's own contract).
  return order.slice(1).map((file) => path.basename(file));
}

/**
 * Applies the base schema and then every migration, to an already-connected
 * client pointing at an EMPTY database, strictly in authoritative order.
 *
 * Each migration runs in its own transaction. The first one that fails stops
 * the whole run immediately -- a failure here cannot silently reorder later
 * migrations ahead of an earlier one that has not yet succeeded, which is
 * exactly the property authoritative order exists to guarantee. Naming the
 * failed migration and its position is what makes the failure diagnosable;
 * committing later migrations around it would not be a smaller success, it
 * would be a schema production never produces.
 *
 * Returns { order, rounds } -- rounds is always 1 on success, kept only so
 * existing callers asserting `rounds > 0` do not need to change.
 */
export async function applyFullSchema(client, { infraDir = DEFAULT_INFRA_DIR, workflowPath = undefined } = {}) {
  const trace = process.env.PPBF_FULL_SCHEMA_TRACE === '1';
  const statementTimeoutMs = Number(process.env.PPBF_FULL_SCHEMA_STATEMENT_TIMEOUT_MS ?? 0);
  if (!Number.isInteger(statementTimeoutMs) || statementTimeoutMs < 0) {
    throw new Error('PPBF_FULL_SCHEMA_STATEMENT_TIMEOUT_MS must be a non-negative integer.');
  }
  // BASE02_BASE_SCHEMA_DIAGNOSTIC: env-gated diagnostic only.
  if (statementTimeoutMs > 0) {
    await client.query(`SET statement_timeout = ${statementTimeoutMs}`);
  }
  if (trace) console.error(`[full-schema] base-attempt file=${BASE_SCHEMA_FILE}`);
  try {
    await client.query(await fs.readFile(path.join(infraDir, BASE_SCHEMA_FILE), 'utf8'));
    if (trace) console.error(`[full-schema] base-applied file=${BASE_SCHEMA_FILE}`);
  } catch (error) {
    const message = error instanceof Error ? error.message.split('\n')[0] : String(error);
    if (trace) console.error(`[full-schema] base-failed file=${BASE_SCHEMA_FILE} error=${message}`);
    throw error;
  }

  const files = await listMigrationFiles(infraDir, workflowPath);
  const sql = new Map();
  for (const file of files) {
    sql.set(file, await fs.readFile(path.join(infraDir, file), 'utf8'));
  }

  const order = [];
  for (const file of files) {
    if (trace) console.error(`[full-schema] attempt migration=${file}`);
    try {
      await client.query('BEGIN');
      if (statementTimeoutMs > 0) {
        await client.query(`SET LOCAL statement_timeout = ${statementTimeoutMs}`);
      }
      await client.query(sql.get(file));
      await client.query('COMMIT');
      if (trace) console.error(`[full-schema] applied migration=${file}`);
      order.push(file);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      const message = error instanceof Error ? error.message.split('\n')[0] : String(error);
      if (trace) console.error(`[full-schema] failed migration=${file} error=${message}`);
      throw new Error(
        `applyFullSchema stopped at ${file} (authoritative position ${order.length + 1}/${files.length}): ${message}`,
      );
    }
  }

  return { order, rounds: 1 };
}
