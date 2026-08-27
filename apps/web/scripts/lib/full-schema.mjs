// Builds the schema PRODUCTION ACTUALLY RUNS: the base file plus every
// migration in infra/azure, applied to a fresh database.
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
// THE ORDER IS DISCOVERED, NOT DECLARED. There is no recoverable historical
// order to copy: 96 of the 99 files entered the repository in one squashed
// import on 2026-08-19 and share a single timestamp. So this applies the
// migrations by fixpoint -- try them all, keep the ones that succeed, repeat
// with what is left until a round places nothing new.
//
// A hand-maintained order list was the obvious alternative and is the wrong
// one, for the reason #700 documents at length: a hand-maintained list is a
// list somebody has to remember to update, and the failure mode is silence.
// The CI Playwright-install step and the seed-loader guard both failed exactly
// that way. Discovery means a migration added tomorrow is placed tomorrow, by
// nobody.
//
// Verified: all 98 migrations place in 3 rounds, 0 unplaceable.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The base schema. Not a migration -- it is applied first, unconditionally. */
export const BASE_SCHEMA_FILE = 'pilot_slice_postgres.sql';

export const DEFAULT_INFRA_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../infra/azure',
);

/** Every migration file, base schema excluded, in a stable order. Sorted so a
    run is reproducible; the sort is a starting point, not the apply order. */
export async function listMigrationFiles(infraDir = DEFAULT_INFRA_DIR) {
  const entries = await fs.readdir(infraDir);
  return entries.filter((name) => name.endsWith('.sql') && name !== BASE_SCHEMA_FILE).sort();
}

/**
 * Applies the base schema and then every migration, to an already-connected
 * client pointing at an EMPTY database.
 *
 * Each migration runs in its own transaction: one that fails rolls back
 * cleanly and is retried in a later round, rather than poisoning the
 * connection for everything after it.
 *
 * Returns { order, rounds } -- the sequence that worked and how many passes it
 * took. Throws if any migration cannot be placed at all, naming the file and
 * the error, because a migration that never applies is a broken migration and
 * silence about it would defeat the point of this file.
 */
export async function applyFullSchema(client, { infraDir = DEFAULT_INFRA_DIR } = {}) {
  await client.query(await fs.readFile(path.join(infraDir, BASE_SCHEMA_FILE), 'utf8'));

  const files = await listMigrationFiles(infraDir);
  const sql = new Map();
  for (const file of files) {
    sql.set(file, await fs.readFile(path.join(infraDir, file), 'utf8'));
  }

  let pending = files;
  const order = [];
  const lastError = new Map();
  let rounds = 0;

  while (pending.length > 0) {
    rounds += 1;
    const stillPending = [];
    let placedThisRound = 0;

    for (const file of pending) {
      try {
        await client.query('BEGIN');
        await client.query(sql.get(file));
        await client.query('COMMIT');
        order.push(file);
        placedThisRound += 1;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        lastError.set(file, error instanceof Error ? error.message.split('\n')[0] : String(error));
        stillPending.push(file);
      }
    }

    pending = stillPending;

    // A round that places nothing will place nothing next time either: the
    // database did not change, so neither will the outcome. Stop and report
    // rather than loop.
    if (placedThisRound === 0) {
      const detail = pending
        .map((file) => `  ${file}\n      ${lastError.get(file)}`)
        .join('\n');
      throw new Error(
        `applyFullSchema could not place ${pending.length} migration(s) after ${rounds} round(s).\n`
        + 'Each of these failed against a database holding every other migration, so this is a\n'
        + 'problem with the migration itself rather than with ordering:\n'
        + detail,
      );
    }
  }

  return { order, rounds };
}
