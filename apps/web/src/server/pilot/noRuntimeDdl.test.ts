/**
 * Application code must not issue DDL.
 *
 * This defect has now been removed six separate times, one module at a time,
 * and each removal left its own comment explaining why -- which is how you can
 * still read the history:
 *
 *   #111                   an anonymous HTTP route that ran DDL against production
 *   volunteers.ts          ensureVolunteerTable()
 *   announcements.ts       CREATE TABLE from inside the read/write helpers
 *   drills.ts              same pattern
 *   achievements.ts        same pattern
 *   rateLimit.ts           auth_rate_limit_buckets, created on the LOGIN path
 *
 * Six removals and no guard is not six fixes. It is one defect that keeps being
 * reintroduced, because nothing in CI has ever objected to the seventh. The
 * rateLimit.ts instance is the proof: #111 removed exactly this pattern from
 * the surface that made it obvious, and it survived untouched on the one path
 * an attacker reaches without credentials, for months afterwards.
 *
 * Two distinct harms, both real here:
 *
 *   PRIVILEGE -- DDL from a request handler means the application role needs
 *   `create table` rights at runtime. rateLimit.ts needed them on the
 *   unauthenticated login path.
 *
 *   SILENT SCHEMA DRIFT -- `create table if not exists` is a no-op against an
 *   existing table, so it agrees with whatever is already there. volunteers.ts
 *   declared a bigserial single-column key against a table with a composite
 *   text key, passed every startup, and failed every insert on five columns
 *   that did not exist.
 *
 * Schema belongs to infra/azure/*.sql, applied through the apply-migrations
 * workflow, which is gated, targeted, and verified. Migration runners in
 * apps/web/scripts are exactly the code that is SUPPOSED to run DDL and are not
 * scanned.
 */
import fs from 'node:fs';
import path from 'node:path';

const repositoryRoot = path.resolve(__dirname, '../../../../..');

// Everything that serves a request or is imported by something that does.
//
// Not apps/web/scripts: migration runners are exactly the code that is SUPPOSED
// to issue DDL, and they do it through the gated apply-migrations workflow.
// Not apps/web/e2e: Playwright specs, which never run in a served request.
const SCANNED_ROOTS = [
  'apps/web/src',
  'apps/web/app',
  'apps/web/components',
  'apps/web/lib',
  'packages',
];

const DDL_PATTERN = /\b(create|alter|drop|truncate)\s+(?:or\s+replace\s+)?(?:unique\s+)?(?:materialized\s+)?(table|index|schema|view|sequence|type|extension)\b/i;

/**
 * Strips comments so the history above -- which necessarily quotes the very
 * statements being banned -- does not trip the check it documents.
 *
 * URLs go first and deliberately. `https://` contains `//`, so stripping line
 * comments before removing them would cut the rest of that line, and a DDL
 * string sharing a line with a link would go unseen. That is a false NEGATIVE,
 * the only kind of failure that matters in a guard like this one.
 */
export function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\w+:\/\/\S*/g, ' ')
    .replace(/\/\/.*$/gm, ' ');
}

function sourceFilesUnder(root: string): string[] {
  const absoluteRoot = path.join(repositoryRoot, root);
  if (!fs.existsSync(absoluteRoot)) return [];

  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '__tests__' || entry.name === '.next') {
          continue;
        }
        walk(full);
        continue;
      }
      if (!/\.tsx?$/.test(entry.name)) continue;
      // Tests build and tear down their own schema against a disposable
      // embedded Postgres. That is the correct place for DDL and is never
      // reachable from a request.
      if (/\.test\.tsx?$/.test(entry.name)) continue;
      found.push(full);
    }
  };
  walk(absoluteRoot);
  return found;
}

const scannedFiles = SCANNED_ROOTS.flatMap(sourceFilesUnder);

describe('application code issues no DDL', () => {
  test('the scan actually reaches the modules that had this defect', () => {
    // Guards the guard. A path change or a broken walk would make the
    // assertion below vacuously true, which is the failure mode of every
    // check written as "find nothing" -- it passes hardest when it is broken.
    expect(scannedFiles.length).toBeGreaterThan(200);

    for (const previouslyAffected of [
      'apps/web/src/server/pilot/rateLimit.ts',
      'apps/web/src/server/pilot/volunteers.ts',
      'apps/web/src/server/pilot/announcements.ts',
      'apps/web/src/server/pilot/drills.ts',
      'apps/web/src/server/pilot/achievements.ts',
    ]) {
      expect(scannedFiles).toContain(path.join(repositoryRoot, previouslyAffected));
    }
  });

  test('the detector recognises DDL that survives comment stripping', () => {
    // The other half of guarding the guard: a detector that cannot detect is
    // worse than no detector, because it reads as a control. Each of these is
    // a shape one of the six real instances actually took.
    const violations = [
      "await query('create table if not exists pilot.widgets (id text primary key)');",
      'await client.query(`CREATE TABLE IF NOT EXISTS pilot.widgets (id text)`);',
      "await query('alter table pilot.widgets add column if not exists label text');",
      "await query('create unique index if not exists idx_widgets on pilot.widgets(id)');",
      "await query('drop table pilot.widgets');",
    ];
    for (const violation of violations) {
      expect(DDL_PATTERN.test(stripComments(violation))).toBe(true);
    }

    // And does not fire on the comments that document the removals, nor on
    // ordinary DML, which is what application code is supposed to contain.
    const allowed = [
      '// There used to be an `ensureVolunteerTable()` here issuing CREATE TABLE.',
      '/* pilot.auth_rate_limit_buckets used to be created HERE by create table if not exists */',
      "await query('insert into pilot.widgets (id) values ($1)', [id]);",
      "await query('select 1 from pilot.widgets where id = $1', [id]);",
      "await query('update pilot.widgets set label = $1 where id = $2', [label, id]);",
      // A line where a link precedes real prose -- the case that made URL
      // stripping have to come first.
      'const docs = "https://example.invalid/a//b"; // see the create table note',
    ];
    for (const line of allowed) {
      expect(DDL_PATTERN.test(stripComments(line))).toBe(false);
    }
  });

  test('no scanned file contains a DDL statement', () => {
    const offenders: string[] = [];

    for (const file of scannedFiles) {
      const stripped = stripComments(fs.readFileSync(file, 'utf8'));
      for (const [index, line] of stripped.split('\n').entries()) {
        if (DDL_PATTERN.test(line)) {
          offenders.push(`${path.relative(repositoryRoot, file)}:${index + 1}: ${line.trim()}`);
        }
      }
    }

    // Listed rather than counted, so a failure names the file and line instead
    // of reporting that a number went up.
    expect(offenders).toEqual([]);
  });
});
