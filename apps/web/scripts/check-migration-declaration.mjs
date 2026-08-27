#!/usr/bin/env node
//
// Fails a pull request whose MIGRATIONS declaration does not match its diff.
//
// WHY THIS EXISTS. deploy-production.yml takes `migrations_complete` as an
// ATTESTATION, not a check -- nothing inspects the database before believing
// it. The release lane sizes and sequences a release from the MIGRATIONS line
// in the PR body, so a missing or wrong value produces a code deploy against a
// schema that does not have the tables. The failure surfaces at runtime, on a
// live system, rather than at deploy time.
//
// A convention document cannot stop that. AGENT_KERNEL.md asks every lane to
// write the line; a lane that does not read the kernel, or reads it and
// forgets, is not stopped by prose. This is the enforceable half.
//
// WHAT IT DOES NOT DO. It does not verify that a migration is correct, safe,
// or applied. It verifies one thing: that the PR body tells the release lane
// the truth about whether this diff carries schema work, in terms the release
// lane can act on.
//
// SLUG NAMING IS NOT DERIVABLE, which is why this compares against
// package.json rather than against filenames. 100 of the 102 migrations on
// main map `pilot_slice_postgres_<slug>_migration.sql` -> `pilot:apply-<slug>`
// by replacing underscores with hyphens. Two do not:
//
//   scheduler_registration_race  -> pilot:apply-scheduler-race
//   sparring_exposure_and_load   -> pilot:apply-sparring-exposure
//
// A check that derived the registration slug from the filename would be wrong
// about those two and would teach future readers a rule the repository does
// not follow. So the filename pattern is used only to DETECT that schema work
// is present; whether a declared slug is real is answered by package.json.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** `infra/azure/pilot_slice_postgres_<slug>_migration.sql`, repo-relative. */
const MIGRATION_PATH = /^infra\/azure\/pilot_slice_postgres_(.+)_migration\.sql$/;

/**
 * Split `git diff --name-status base...head` output into the migrations it
 * adds, modifies and removes.
 *
 * Rename statuses (`R100`) carry two paths; both are examined, so a migration
 * renamed into or out of existence is seen rather than skipped.
 */
export function detectMigrationChanges(nameStatusText) {
  const added = [];
  const modified = [];
  const removed = [];

  for (const line of nameStatusText.split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    const status = parts[0];
    const paths = parts.slice(1).filter(Boolean);

    for (const [index, filePath] of paths.entries()) {
      const match = MIGRATION_PATH.exec(filePath.trim());
      if (!match) continue;
      const slug = match[1];

      if (status.startsWith('A')) added.push(slug);
      else if (status.startsWith('M')) modified.push(slug);
      else if (status.startsWith('D')) removed.push(slug);
      else if (status.startsWith('R')) {
        // Source path is the old name, destination the new one.
        if (index === 0) removed.push(slug);
        else added.push(slug);
      } else modified.push(slug);
    }
  }

  const uniq = (list) => [...new Set(list)].sort();
  return { added: uniq(added), modified: uniq(modified), removed: uniq(removed) };
}

/**
 * Read the MIGRATIONS line out of a pull request body.
 *
 * FIRST match wins. A body may legitimately quote the header template further
 * down -- the kernel PR does exactly that -- and the real declaration is the
 * one at the top, by convention. Taking the last match would read the example.
 */
export function parseDeclaration(body) {
  const text = String(body ?? '').replace(/\r\n/g, '\n');
  const match = /^[ \t>*_`-]*MIGRATIONS:[ \t]*(.*)$/m.exec(text);
  if (!match) return { present: false, none: false, slugs: [], raw: null };

  const raw = match[1].trim().replace(/`/g, '');
  if (!raw) return { present: true, none: false, slugs: [], raw: '' };

  // The kernel's own template carries an arrow annotation on this line.
  const cleaned = raw.split('<--')[0].trim();
  if (/^none$/i.test(cleaned)) return { present: true, none: true, slugs: [], raw };

  const slugs = cleaned
    .split(/[,\s]+/)
    .map((token) => token.trim())
    .filter((token) => token && token !== '|')
    .map((token) => token.replace(/^pilot:apply-/, ''));

  return { present: true, none: false, slugs: [...new Set(slugs)].sort(), raw };
}

/** Every `pilot:apply-<slug>` registration defined in package.json. */
export function applyTargetsFrom(scripts) {
  return new Set(
    Object.keys(scripts ?? {})
      .filter((name) => name.startsWith('pilot:apply-'))
      .map((name) => name.slice('pilot:apply-'.length)),
  );
}

/**
 * Decide whether a declaration matches its diff.
 *
 * Under-declaring is a hard failure: the release lane does not learn that
 * schema work is in the release, which is the failure this check exists for.
 *
 * OVER-declaring is allowed, deliberately. A stacked pull request legitimately
 * inherits its parent's migration and should name it, and applying an
 * already-applied migration is a no-op -- every migration in this repository
 * is idempotent and catalog-guarded. Failing that case would push lanes toward
 * declaring less, which is the wrong direction to be wrong in.
 */
export function evaluate({ changes, declaration, applyTargets }) {
  const failures = [];
  const notes = [];
  const needsApplying = [...new Set([...changes.added, ...changes.modified])].sort();

  if (needsApplying.length > 0) {
    if (!declaration.present) {
      failures.push(
        `This diff changes ${needsApplying.length} migration file(s) and the body has no MIGRATIONS: line. `
        + `Add one naming what the release lane must apply.`,
      );
    } else if (declaration.none) {
      failures.push(
        `MIGRATIONS declares NONE, but this diff changes ${needsApplying.length} migration file(s): `
        + `${needsApplying.join(', ')}.`,
      );
    } else if (declaration.slugs.length === 0) {
      failures.push('MIGRATIONS is present but empty. Write NONE or name the slugs.');
    }
  }

  for (const slug of declaration.slugs) {
    if (!applyTargets.has(slug)) {
      failures.push(
        `MIGRATIONS names "${slug}", but package.json has no "pilot:apply-${slug}" script. `
        + `The release lane would have nothing to run.`,
      );
    }
  }

  if (changes.removed.length > 0 && needsApplying.length === 0) {
    notes.push(
      `Removes ${changes.removed.length} migration file(s) and adds none. `
      + `NONE is the correct declaration: there is nothing to apply.`,
    );
  }

  if (needsApplying.length === 0 && declaration.slugs.length > 0) {
    notes.push(
      `Declares ${declaration.slugs.join(', ')} without changing a migration file. `
      + `Allowed -- a stacked PR inherits its parent's migration -- but confirm STACKED ON says so.`,
    );
  }

  return { ok: failures.length === 0, failures, notes, needsApplying };
}

function main() {
  const nameStatusFile = process.argv[2];
  if (!nameStatusFile) {
    console.error('usage: check-migration-declaration.mjs <name-status-file>');
    console.error('reads the pull request body from PR_BODY');
    process.exit(2);
  }

  const changes = detectMigrationChanges(fs.readFileSync(nameStatusFile, 'utf8'));
  const declaration = parseDeclaration(process.env.PR_BODY);
  const { scripts } = JSON.parse(fs.readFileSync(path.join(WEB_DIR, 'package.json'), 'utf8'));
  const result = evaluate({ changes, declaration, applyTargets: applyTargetsFrom(scripts) });

  console.log('Migration files added:    ', changes.added.join(', ') || '(none)');
  console.log('Migration files modified: ', changes.modified.join(', ') || '(none)');
  console.log('Migration files removed:  ', changes.removed.join(', ') || '(none)');
  console.log('MIGRATIONS declared:      ', declaration.present ? (declaration.raw || '(empty)') : '(no MIGRATIONS line)');
  console.log('');

  for (const note of result.notes) console.log(`note: ${note}`);
  for (const failure of result.failures) console.error(`FAIL: ${failure}`);

  if (!result.ok) {
    console.error('');
    console.error('The release lane sizes a release from the MIGRATIONS line. A wrong or');
    console.error('missing value produces a code deploy against a schema without the tables.');
    process.exit(1);
  }

  console.log('MIGRATIONS declaration matches the diff.');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main();
}
