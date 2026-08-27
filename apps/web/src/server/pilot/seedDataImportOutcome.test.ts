// A roster row that did not import is a failed run.
//
// WHAT WAS WRONG
//   scripts/seed-data.ts collected every per-row failure into result.errors,
//   printed the total, and then exited 0 anyway -- in BOTH modes. Reproduced
//   before the fix, with four rows that all fail validation:
//
//     athletes  | Inserted: 0 | Skipped: 4 | Errors: 4
//     Total: Inserted 0 | Skipped 4 | Errors 4
//     EXIT_CODE=0
//
//   A real run's last line was "✅ Seed complete!". So a roster where 30 of 40
//   children failed their coach_id ended on success, and CI, a runbook step
//   and an operator all read a half-loaded table of MINORS as finished. This
//   is the only loader in the repository that writes children's names, dates
//   of birth and emergency contacts.
//
//   The dry run is the half that matters most: SEED_GUIDE.md tells the
//   operator to preview first, and a preview that finds four bad rows and
//   exits 0 is exactly the reassurance it exists to withhold.
//
// AND THE DATE THAT WAS NEVER CHECKED
//   validateAthleteRow tested `dob` for PRESENCE while its own message
//   promised "(format: YYYY-MM-DD)". `NOT-A-DATE` validated clean and failed
//   later against the date column -- attributed to Postgres rather than to the
//   cell the operator typed. 2011-02-29 is the case that matters more: a regex
//   admits it, and Date rolls it forward, so a child's date of birth would
//   have silently become the 1st of March.
//
// WHY A SUBPROCESS
//   seed-data.ts is a tsx module with an isMainModule guard, and the exit code
//   IS the contract under test -- there is nothing to assert about it from
//   inside the same process. Same approach as seedDataWriteTarget.test.ts,
//   which drives the same entry point for the write-target guard.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const REPO_ROOT = path.resolve(__dirname, '../../../../..');
const MODULE_URL = pathToFileURL(path.join(REPO_ROOT, 'scripts/seed-data.ts')).href;
const TSX_BIN = path.join(REPO_ROOT, 'node_modules/.bin/tsx');

const HEADER = 'athlete_id,full_name,dob,weight_class,gym_status,emergency_contact,active_flag,coach_id';
const GOOD = 'EXAMPLE-001,EXAMPLE Athlete One,2010-01-01,fly,active,EX contact,true,EXAMPLE-COACH-1';
const BAD_DATE = 'EXAMPLE-002,EXAMPLE Athlete Two,NOT-A-DATE,fly,active,EX contact,true,EXAMPLE-COACH-1';
const IMPOSSIBLE_DATE = 'EXAMPLE-003,EXAMPLE Athlete Three,2011-02-29,fly,active,EX contact,true,EXAMPLE-COACH-1';

let workDir: string;

/** A dry run over one CSV, returning the exit status and combined output. */
function runSeed(rows: string[], extraArgs: string[] = []): { status: number; output: string } {
  const dir = fs.mkdtempSync(path.join(workDir, 'case-'));
  fs.writeFileSync(path.join(dir, 'athletes.csv'), `${HEADER}\n${rows.join('\n')}\n`);
  const configPath = path.join(dir, 'config.ts');
  fs.writeFileSync(
    configPath,
    'export default '
    + JSON.stringify({
      organizationId: 'ppbf-import-outcome-test-org',
      dataDir: dir,
      files: { athletes: 'athletes.csv' },
      options: { dryRun: true, skipValidation: false, batchSize: 1000, continueOnError: true },
    }, null, 2)
    + ';\n',
  );

  // The environment is built explicitly rather than inherited: a real
  // AZURE_POSTGRES_CONNECTION_STRING on the machine would make this reach a
  // database, and a dry run must not. Without it the coach-existence check is
  // skipped and the script says so, which is the behaviour under test.
  const clean = { ...process.env };
  delete clean.AZURE_POSTGRES_CONNECTION_STRING;
  delete clean.PPBF_EXPECTED_POSTGRES_HOSTNAME;
  delete clean.PPBF_EXPECTED_POSTGRES_DATABASE;

  try {
    const stdout = execFileSync(
      TSX_BIN,
      ['scripts/seed-data.ts', '--dry-run', '--config', configPath, ...extraArgs],
      { cwd: REPO_ROOT, encoding: 'utf8', env: clean, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    return { status: 0, output: stdout };
  } catch (error) {
    const failure = error as { status?: number | null; stdout?: string; stderr?: string };
    return {
      status: failure.status ?? -1,
      output: `${failure.stdout ?? ''}${failure.stderr ?? ''}`,
    };
  }
}

beforeAll(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ppbf-seed-outcome-'));
});

afterAll(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

describe('the exit code tells the operator whether the roster imported', () => {
  it('exits 0 when every row imports', () => {
    const { status, output } = runSeed([GOOD]);
    expect(status).toBe(0);
    expect(output).toContain('Errors:      0');
  });

  it('exits NON-ZERO when a row does not import', () => {
    const { status, output } = runSeed([GOOD, BAD_DATE]);
    expect(status).toBe(1);
    expect(output).toContain('1 row(s) did not import');
  });

  it('names the count, so the operator knows how many children are missing', () => {
    const { status, output } = runSeed([GOOD, BAD_DATE, IMPOSSIBLE_DATE]);
    expect(status).toBe(1);
    expect(output).toContain('2 row(s) did not import');
  });

  it('still fails on a DRY RUN, which is the preview the guide tells you to trust', () => {
    // The whole point of previewing is to learn whether the roster will
    // import. A preview that finds bad rows and returns success is worse than
    // no preview, because the operator then has a reason to believe it.
    const { status } = runSeed([BAD_DATE]);
    expect(status).toBe(1);
  });

  it('accepts a partial load only when the operator asks for one explicitly', () => {
    const { status, output } = runSeed([GOOD, BAD_DATE], ['--allow-partial-import']);
    expect(status).toBe(0);
    // The errors are still reported. The flag changes the exit code, never
    // what the operator is told.
    expect(output).toContain('Invalid dob');
  });

  it('does not claim the seed is complete when rows failed', () => {
    const { output } = runSeed([GOOD, BAD_DATE]);
    expect(output).not.toContain('✅ Seed complete!');
  });
});

// The default jest runner has no ESM loader, so `await import()` of a tsx
// module fails with the "trying to use ECMAScript Modules" error -- the trap
// AGENT_KERNEL.md names. seedDataWriteTarget.test.ts solves it by doing the
// importing inside ONE tsx child process and handing back JSON; same here, so
// the calendar cases run against the real exported function rather than a
// re-implementation of it in the test.
const CALENDAR_CASES: Record<string, unknown> = {
  real_day: '2010-01-01',
  real_leap_day: '2012-02-29',
  impossible_leap_day: '2011-02-29',
  month_thirteen: '2010-13-01',
  month_zero: '2010-00-10',
  day_thirty_two: '2010-01-32',
  year_only: '2010',
  english_date: 'Jan 1 2010',
  unpadded: '2010-1-1',
  slashes: '01/01/2010',
  with_time: '2010-01-01T00:00:00Z',
  empty: '',
  whitespace: '   ',
  number: 20100101,
  null_value: null,
  undefined_value: undefined,
};

function calendarVerdicts(): Record<string, boolean> {
  // A temp .mts FILE, not `tsx --eval`. --eval compiles to CJS, where a
  // top-level await is a build error ("Top-level await is currently not
  // supported with the cjs output format") -- so the probe fails on the
  // import line and never reaches a single case. seedDataWriteTarget.test.ts
  // writes a probe.mts for exactly this reason; same here.
  const probe = path.join(workDir, 'calendar-probe.mts');
  fs.writeFileSync(
    probe,
    `import { isCalendarDate } from ${JSON.stringify(MODULE_URL)};\n`
    + `const cases: Record<string, unknown> = ${JSON.stringify(CALENDAR_CASES)};\n`
    + 'const out: Record<string, boolean> = {};\n'
    + 'for (const [name, value] of Object.entries(cases)) out[name] = isCalendarDate(value);\n'
    // undefined does not survive JSON, so it is restored here rather than
    // silently becoming a missing key that would read as a passing case.
    + 'out.undefined_value = isCalendarDate(undefined);\n'
    + 'process.stdout.write(JSON.stringify(out));\n',
  );
  const stdout = execFileSync(TSX_BIN, [probe], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return JSON.parse(stdout);
}

describe('a date of birth is checked against the calendar, not a regex', () => {
  let verdict: Record<string, boolean>;

  beforeAll(() => {
    verdict = calendarVerdicts();
  });

  it('accepts a real calendar day', () => {
    expect(verdict.real_day).toBe(true);
    expect(verdict.real_leap_day).toBe(true);
  });

  it('rejects a day that does not exist, which a regex would admit', () => {
    // This is the case that matters. A pattern match passes 2011-02-29, and
    // `new Date` rolls it forward to March 1st -- so a child's date of birth
    // would change on the way into the database, silently.
    expect(verdict.impossible_leap_day).toBe(false);
    expect(verdict.month_thirteen).toBe(false);
    expect(verdict.month_zero).toBe(false);
    expect(verdict.day_thirty_two).toBe(false);
  });

  it('rejects the shapes Date.parse would have accepted and normalised', () => {
    expect(verdict.year_only).toBe(false);
    expect(verdict.english_date).toBe(false);
    expect(verdict.unpadded).toBe(false);
    expect(verdict.slashes).toBe(false);
    expect(verdict.with_time).toBe(false);
  });

  it('rejects what is not a string at all', () => {
    expect(verdict.null_value).toBe(false);
    expect(verdict.undefined_value).toBe(false);
    expect(verdict.number).toBe(false);
    expect(verdict.empty).toBe(false);
    expect(verdict.whitespace).toBe(false);
  });

  it('reports the offending value back to the operator who typed it', () => {
    const { output } = runSeed([BAD_DATE]);
    expect(output).toContain('Invalid dob "NOT-A-DATE" (format: YYYY-MM-DD)');
  });
});
