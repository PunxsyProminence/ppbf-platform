#!/usr/bin/env node

/**
 * The order the migrations are ACTUALLY applied in, read from the workflow
 * that applies them.
 *
 * WHY THIS EXISTS
 *
 * Anything that reasons about the cumulative effect of the migration set has
 * to walk the files in the order they run. Sorting filenames is not that
 * order, and the difference is not theoretical:
 *
 *   pilot_slice_postgres_drill_library_check_drop_migration.sql   <- the DROP
 *   pilot_slice_postgres_drill_library_discipline_fk_migration.sql
 *   pilot_slice_postgres_drill_library_v3_migration.sql           <- the ADD
 *
 * By filename the drop sorts FIRST. Walked that way, the drop is a no-op
 * against a constraint nothing has added yet, v3 then adds it, and the reader
 * concludes `pilot_drill_library_discipline_check` should exist on a correctly
 * migrated database. It does not. That produced a false failure in
 * pilot-verify-schema.mjs, which is a PRE-DEPLOY gate.
 *
 * The real order lives in the `all` arm of `.github/workflows/apply-migrations.yml`
 * -- "Dependency order, matching the sequence these were introduced in" -- where
 * drill-library-v3 sits mid-list and drill-library-check-drop is last. That
 * list is the authority: it is what a rebuild executes. Reading it is the
 * opposite of duplicating it.
 *
 * THE FAILURE MODE THIS MODULE IS BUILT AGAINST
 *
 * A parse that silently returns an empty or partial list would shrink or empty
 * the caller's expectations, and a pre-deploy gate whose expectations are empty
 * PASSES EVERYTHING while reporting green. That is worse than the false failure
 * this replaces. So every inconsistency below throws rather than degrades:
 *
 *   - the workflow, the infra directory or the base schema cannot be read;
 *   - the `all` list is absent or empty;
 *   - a name in `all` has no SQL file on disk;
 *   - a SQL file on disk is not named in `all`;
 *   - a `pilot_slice_postgres*.sql` file is neither the base schema nor a
 *     `_migration.sql` file, so nothing here accounts for it.
 *
 * The last two are hard errors ON PURPOSE. Quietly skipping an unlisted file
 * drops every object that file creates out of the caller's expectations, which
 * is the vacuous-gate failure arriving by a side door. It should also be
 * unreachable: `migrationDispatchCoverage.test.ts` already asserts, per file,
 * that `all` names it ("%s has a runner, a script, and is in `all`"), and
 * asserts the converse in "every `all` entry is a real migration file". If this
 * throws, that guard is already red and the tree is broken -- refusing to
 * verify is the correct answer, not verifying a smaller schema.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** `infra/azure`, from `apps/web/scripts`. Three levels up, same as every runner. */
export const INFRA_DIR = path.resolve(HERE, '../../../infra/azure');
export const WORKFLOW_PATH = path.resolve(HERE, '../../../.github/workflows/apply-migrations.yml');

/**
 * The base schema. It is deliberately NOT in `all` -- it is applied to a new
 * environment (`base-schema-new-environment-only` -> `run_one schema`), not
 * re-run across every existing one, which `migrationDispatchCoverage.test.ts`
 * records as the only permitted difference between `all` and the allowlist.
 * Everything in `all` alters what it creates, so it comes first.
 */
export const BASE_SCHEMA_FILE = 'pilot_slice_postgres.sql';

/** Any file the old filename walk would have picked up. */
const ANY_MIGRATION_SQL = /^pilot_slice_postgres.*\.sql$/;
/** An increment: `pilot_slice_postgres_<stem>_migration.sql`. */
const INCREMENT_SQL = /^pilot_slice_postgres_(.+)_migration\.sql$/;

/**
 * Migration slugs whose SQL filename does not mechanically produce the name the
 * workflow uses. Kept as an explicit map rather than a looser derivation, so a
 * new mismatch is a decision someone records here rather than a silent miss.
 *
 * This is the single copy. `migrationDispatchCoverage.test.ts` held it before
 * and now reads it from here; a third mismatch added to only one of two copies
 * is exactly the class of silent divergence this module exists to refuse.
 */
export const SLUG_OVERRIDES = {
  scheduler_registration_race: 'scheduler-race',
  sparring_exposure_and_load: 'sparring-exposure',
};

/** `pilot_slice_postgres_<stem>_migration.sql` -> the slug `all` uses. */
export function slugFor(sqlFileName) {
  const stem = sqlFileName
    .replace(/^pilot_slice_postgres_/, '')
    .replace(/_migration\.sql$/, '');
  return SLUG_OVERRIDES[stem] ?? stem.replace(/_/g, '-');
}

/**
 * The `all` list, in order, out of the workflow text.
 *
 * Throws rather than returning `[]`. A caller that treats "no list" as "no
 * migrations" is the vacuous gate described above.
 */
export function parseAllList(workflowText) {
  const matches = [...String(workflowText ?? '').matchAll(/for m in ([a-z0-9 -]+); do/g)];
  if (matches.length === 0) {
    throw new Error(
      'migration-apply-order: could not find the `all` list in apply-migrations.yml. '
      + 'Expected a line of the form `for m in <slug> <slug> ...; do` in the `all` arm of '
      + 'the `case "$MIGRATION"` block. Refusing to guess an apply order.',
    );
  }

  /*
   * More than one is not "pick the first". Three landed at once on 2026-08-28:
   * three lanes each appended their migration to this line, and the merge kept
   * all three lines instead of merging them. Every reader here -- this parser
   * and migrationDispatchCoverage.test.ts -- took the FIRST match, so each
   * reported the other lanes' migrations as simply unregistered, which is a
   * true statement about a file that had a much worse problem: three
   * consecutive `for ... ; do` with one `done` is a bash SYNTAX ERROR, so the
   * apply step could not run at all and NO migration was dispatchable by any
   * path, `all` included. First-match is how a guard describes the wrong
   * defect with total confidence.
   */
  if (matches.length > 1) {
    throw new Error(
      `migration-apply-order: found ${matches.length} \`all\` lists in apply-migrations.yml, `
      + 'and there is exactly one apply order. This is the shape a merge leaves behind when two '
      + 'lanes both append a migration to that line: the lists are siblings, not a sequence, so '
      + 'the surviving shell is `for ...; do` repeated with a single `done` -- a syntax error '
      + 'that stops every migration from running. Merge them into one line rather than deleting '
      + `either. Tails: ${matches.map((m) => m[1].trim().split(' ').slice(-3).join(' ')).join(' | ')}`,
    );
  }

  const list = matches[0][1].split(' ').filter(Boolean);
  if (list.length === 0) {
    throw new Error(
      'migration-apply-order: the `all` list in apply-migrations.yml parsed as empty. '
      + 'Refusing to proceed -- an empty order means an empty expected schema.',
    );
  }

  return list;
}

/** Every `pilot_slice_postgres*.sql` in `infraDir`, split into base / increments / unknown. */
function readMigrationDirectory(infraDir) {
  let entries;
  try {
    entries = fs.readdirSync(infraDir);
  } catch (cause) {
    throw new Error(
      `migration-apply-order: cannot read the migration directory ${infraDir}: ${cause.message}`,
      { cause },
    );
  }

  const sqlFiles = entries.filter((name) => ANY_MIGRATION_SQL.test(name)).sort();
  const increments = sqlFiles.filter((name) => INCREMENT_SQL.test(name));
  const unaccounted = sqlFiles.filter(
    (name) => name !== BASE_SCHEMA_FILE && !INCREMENT_SQL.test(name),
  );

  if (!sqlFiles.includes(BASE_SCHEMA_FILE)) {
    throw new Error(
      `migration-apply-order: the base schema ${BASE_SCHEMA_FILE} is missing from ${infraDir}. `
      + 'Every increment alters what it creates; there is no apply order without it.',
    );
  }

  if (increments.length === 0) {
    throw new Error(
      `migration-apply-order: found no *_migration.sql files in ${infraDir}. `
      + 'Refusing to proceed -- that would report an empty schema as fully applied.',
    );
  }

  if (unaccounted.length > 0) {
    throw new Error(
      `migration-apply-order: ${unaccounted.length} file(s) in ${infraDir} match `
      + 'pilot_slice_postgres*.sql but are neither the base schema nor a *_migration.sql '
      + `increment, so nothing here knows when they run: ${unaccounted.join(', ')}. `
      + 'The filename walk this replaced would have included them.',
    );
  }

  return { increments };
}

/**
 * Every migration SQL file, as absolute paths, in the order a rebuild applies
 * them: the base schema, then the `all` list.
 *
 * Duplicates in `all` are kept rather than collapsed -- the workflow loop would
 * run them twice, and this models what runs.
 *
 * `pilot-apply-shadow-runtime-migration.mjs` additionally applies six files
 * that each also appear at their own position in `all`. Only the named file is
 * modelled here, and that is equivalent for the resulting object set: a file
 * applied early AND at its own position ends in the state its own position
 * leaves it in, which is the position modelled.
 */
export function migrationApplyOrder({
  infraDir = INFRA_DIR,
  workflowPath = WORKFLOW_PATH,
} = {}) {
  let workflowText;
  try {
    workflowText = fs.readFileSync(workflowPath, 'utf8');
  } catch (cause) {
    throw new Error(
      `migration-apply-order: cannot read ${workflowPath}: ${cause.message}. `
      + 'The apply order is not derivable without it.',
      { cause },
    );
  }

  const allList = parseAllList(workflowText);
  const { increments } = readMigrationDirectory(infraDir);

  const fileForSlug = new Map();
  for (const fileName of increments) {
    const slug = slugFor(fileName);
    const existing = fileForSlug.get(slug);
    if (existing) {
      throw new Error(
        `migration-apply-order: two migration files claim the slug "${slug}" `
        + `(${existing} and ${fileName}). One of them is unreachable through the workflow.`,
      );
    }
    fileForSlug.set(slug, fileName);
  }

  const unknownSlugs = allList.filter((slug) => !fileForSlug.has(slug));
  if (unknownSlugs.length > 0) {
    throw new Error(
      `migration-apply-order: the \`all\` list names ${unknownSlugs.length} migration(s) with `
      + `no SQL file in ${infraDir}: ${unknownSlugs.join(', ')}. `
      + 'Either the file was removed without updating the workflow, or a slug is misspelt.',
    );
  }

  const listed = new Set(allList);
  const unlisted = [...fileForSlug.entries()]
    .filter(([slug]) => !listed.has(slug))
    .map(([slug, fileName]) => `${fileName} (${slug})`);
  if (unlisted.length > 0) {
    throw new Error(
      `migration-apply-order: ${unlisted.length} migration file(s) are not named in the \`all\` `
      + `list, so nothing here knows when they run: ${unlisted.join(', ')}. `
      + 'Excluding them would silently drop every object they create from the expected schema, '
      + 'which is how a pre-deploy gate stops checking while still reporting green. '
      + 'migrationDispatchCoverage.test.ts already forbids this state; fix the workflow list.',
    );
  }

  return [
    path.join(infraDir, BASE_SCHEMA_FILE),
    ...allList.map((slug) => path.join(infraDir, fileForSlug.get(slug))),
  ];
}
