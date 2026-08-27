// Contract tests for the roster seeder's write-target guard.
//
// WHY THIS SUITE EXISTS AT ALL
//
// scripts/seed-data.ts writes pilot.athletes, pilot.parents and
// pilot.guardian_links -- children's records -- and until this change nothing
// tested it, because nothing COULD: the file had zero exports and ran its CLI
// at module top level, so importing it read argv, could call process.exit(2),
// and tried to import a config the repository deliberately does not contain.
//
// Every loader under apps/web/scripts asserts its write target before writing.
// postgres-write-target.mjs records what happened without one: a run from a
// laptop or agent shell holding a production connection string put 361
// orphaned rows into production. This script had no such assertion, while
// holding the most sensitive rows of any seeder in the repository.
//
// HOW IT RUNS. The module under test is TypeScript consumed through tsx, and
// the default jest runner has no ESM loader (`npm test` does not pass
// --experimental-vm-modules). So each case is evaluated in one real tsx child
// process, which is the loader `npm run seed:data` itself uses -- these
// exercise the module as the CLI consumes it, not a transpiled copy.
//
// tsx's `-e` mode is deliberately NOT used: it transpiles the target as CJS,
// so a named import fails with "does not provide an export named ...". A real
// ESM entry file is what the CLI path uses and what works.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const REPO_ROOT = path.resolve(__dirname, '../../../../..');
// A file:// URL, not a bare path: on Windows an absolute path is not a legal
// ESM specifier, which is the trap postgresWriteTarget.test.ts records.
const MODULE_URL = pathToFileURL(path.join(REPO_ROOT, 'scripts/seed-data.ts')).href;
// The JS guard seed-data.ts imports. It has a hand-written .d.mts beside it,
// because tsconfig.scripts.json sets allowJs: false on purpose -- so the
// declaration can drift from the module without any compiler noticing.
const GUARD_URL = pathToFileURL(
  path.join(REPO_ROOT, 'apps/web/scripts/lib/postgres-write-target.mjs'),
).href;
const TSX_BIN = path.join(REPO_ROOT, 'node_modules/.bin/tsx');

const STAGING = 'postgres://u:sekrit@ppbf-pg-staging.postgres.database.azure.com:5432/postgres';
const PRODUCTION = 'postgres://u:sekrit@ppbf-pg-prod.postgres.database.azure.com:5432/postgres';
const STAGING_HOST = 'ppbf-pg-staging.postgres.database.azure.com';

function env(connectionString?: string, hostname?: string, database?: string) {
  return {
    ...(connectionString ? { AZURE_POSTGRES_CONNECTION_STRING: connectionString } : {}),
    ...(hostname ? { PPBF_EXPECTED_POSTGRES_HOSTNAME: hostname } : {}),
    ...(database ? { PPBF_EXPECTED_POSTGRES_DATABASE: database } : {}),
  };
}

type Outcome = { ok: true } | { ok: false; message: string };

// [dryRun, env] pairs. Returning structured outcomes rather than letting the
// child exit non-zero keeps one spawn for the whole suite.
const CASES: Record<string, [boolean, Record<string, string>]> = {
  // A dry run writes nothing, so it is exempt -- the same reasoning
  // resolveCoachCheck already records for the database connection itself.
  dry_run_with_nothing_declared: [true, env()],
  dry_run_even_when_the_target_disagrees: [true, env(PRODUCTION, STAGING_HOST, 'postgres')],

  real_run_with_no_connection_string: [false, env()],
  real_run_with_no_expected_hostname: [false, env(STAGING)],
  real_run_with_no_expected_database: [false, env(STAGING, STAGING_HOST)],
  real_run_pointing_elsewhere_than_declared: [false, env(PRODUCTION, STAGING_HOST, 'postgres')],
  real_run_with_a_different_database: [false, env(STAGING, STAGING_HOST, 'some_other_db')],
  real_run_with_an_unparseable_url: [false, env('not a url at all', STAGING_HOST, 'postgres')],
  real_run_with_the_wrong_protocol: [false, env('mysql://u:p@host/db', STAGING_HOST, 'postgres')],

  real_run_matching_the_declared_target: [false, env(STAGING, STAGING_HOST, 'postgres')],
};

let outcomes: Record<string, Outcome>;
let guardExports: string[];

beforeAll(() => {
  const body = Object.entries(CASES)
    .map(([name, [dryRun, caseEnv]]) =>
      `try { g.assertDeclaredWriteTarget(${dryRun}, ${JSON.stringify(caseEnv)}); `
      + `out[${JSON.stringify(name)}] = {ok: true}; } `
      + `catch (e) { out[${JSON.stringify(name)}] = {ok: false, message: e.message}; }`)
    .join('\n');

  const probe = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'ppbf-seed-target-')),
    'probe.mts',
  );
  fs.writeFileSync(
    probe,
    `import * as g from ${JSON.stringify(MODULE_URL)};\n`
    + `import * as guard from ${JSON.stringify(GUARD_URL)};\n`
    + 'const out: Record<string, unknown> = {};\n'
    + `${body}\n`
    + "process.stdout.write(JSON.stringify({ out, guardExports: Object.keys(guard).sort() }));\n",
  );

  try {
    const parsed = JSON.parse(
      execFileSync(TSX_BIN, [probe], { encoding: 'utf8', cwd: REPO_ROOT }),
    );
    outcomes = parsed.out;
    guardExports = parsed.guardExports;
  } finally {
    fs.rmSync(path.dirname(probe), { recursive: true, force: true });
  }
}, 60_000);

function refusal(name: string): string {
  const outcome = outcomes[name];
  if (outcome.ok) {
    throw new Error(`${name} was ALLOWED; it must be refused`);
  }
  return outcome.message;
}

function expectAllowed(name: string) {
  const outcome = outcomes[name];
  if (!outcome.ok) {
    throw new Error(`${name} was refused unexpectedly: ${outcome.message}`);
  }
}

describe('roster seeder write-target guard', () => {
  // Importing the module must not run the CLI. If it did, this whole suite
  // would be reporting on a process that had already exited or tried to load
  // a config that does not exist.
  it('can be imported without the CLI running', () => {
    expect(Object.keys(outcomes).sort()).toEqual(Object.keys(CASES).sort());
  });

  // The declaration file is hand-written and nothing compiles the module it
  // describes, so a renamed or removed export would leave TypeScript happily
  // checking against a shape that no longer exists. This compares the declared
  // names to what the module really exports at runtime.
  it('has a declaration file naming the module real exports', () => {
    expect(guardExports).toEqual([
      'assertDeclaredWriteTarget',
      'assertDeclaredWriteTargetFromEnv',
      'parseConnectionTarget',
    ]);
  });

  describe('a dry run is exempt, because it writes nothing', () => {
    it('is allowed with nothing declared at all', () => {
      expectAllowed('dry_run_with_nothing_declared');
    });

    it('is allowed even when the connection string and the declared target disagree', () => {
      expectAllowed('dry_run_even_when_the_target_disagrees');
    });
  });

  describe('a real run is refused unless the target is declared and agrees', () => {
    it('refuses when there is no connection string to check', () => {
      expect(refusal('real_run_with_no_connection_string')).toContain(
        'AZURE_POSTGRES_CONNECTION_STRING is not set',
      );
    });

    // Unconfigured is refused, not skipped. A guard that does nothing when
    // unconfigured protects only the environments that remembered it, which
    // is the same as no guard on the ad-hoc run this exists to stop.
    it('refuses when no expected hostname is declared', () => {
      expect(refusal('real_run_with_no_expected_hostname')).toContain(
        'PPBF_EXPECTED_POSTGRES_HOSTNAME is not set',
      );
    });

    it('refuses when no expected database is declared', () => {
      expect(refusal('real_run_with_no_expected_database')).toContain(
        'PPBF_EXPECTED_POSTGRES_DATABASE is not set',
      );
    });

    it('refuses a connection string pointing at a different host than declared', () => {
      expect(refusal('real_run_pointing_elsewhere_than_declared')).toContain(
        'points at a different host or database',
      );
    });

    it('refuses a connection string naming a different database than declared', () => {
      expect(refusal('real_run_with_a_different_database')).toContain(
        'points at a different host or database',
      );
    });

    it('refuses an unparseable connection string', () => {
      expect(refusal('real_run_with_an_unparseable_url')).toContain('not a parseable URL');
    });

    it('refuses a non-postgres protocol', () => {
      expect(refusal('real_run_with_the_wrong_protocol')).toContain('postgres://');
    });

    it('allows the run when the declared target matches', () => {
      expectAllowed('real_run_matching_the_declared_target');
    });
  });

  // The unit cases above prove the guard REFUSES. They do not prove the CLI
  // calls it -- delete the call from runCli() and every one of them still
  // passes, which is exactly the shape of bug seedWorkflowContract.test.ts was
  // written for and did not cover. So this drives the real entry point.
  //
  // It is safe and fast: the destructive opt-in gets past the first guard, the
  // target guard then refuses BEFORE the config is imported and before any
  // database connection is attempted, so nothing is read and nothing is
  // written. The environment is built explicitly rather than inherited, so a
  // real AZURE_POSTGRES_CONNECTION_STRING on the machine cannot mask the case.
  it('refuses from the CLI entry point, not only when called directly', () => {
    const clean = { ...process.env };
    delete clean.AZURE_POSTGRES_CONNECTION_STRING;
    delete clean.PPBF_EXPECTED_POSTGRES_HOSTNAME;
    delete clean.PPBF_EXPECTED_POSTGRES_DATABASE;

    let status: number | null = null;
    let stderr = '';
    try {
      execFileSync(TSX_BIN, ['scripts/seed-data.ts'], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        env: { ...clean, PPBF_ALLOW_DESTRUCTIVE_SEED: 'true' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      const failure = error as { status?: number | null; stderr?: string };
      status = failure.status ?? null;
      stderr = failure.stderr ?? '';
    }

    expect(status).toBe(2);
    expect(stderr).toContain('AZURE_POSTGRES_CONNECTION_STRING is not set');
    // It must stop at the target check, not wander on to the config loader.
    expect(stderr).not.toContain('Failed to load config');
  }, 60_000);

  // A connection string carries credentials, which is why the shared guard
  // throws bare machine tokens and leaves the wording to callers. A refusal
  // that helpfully printed the string would put a password in a CI log.
  it('never puts the connection string or its password in a refusal', () => {
    for (const name of Object.keys(CASES)) {
      const outcome = outcomes[name];
      if (outcome.ok) continue;
      // The password, the host, and the string itself. NOT the bare scheme:
      // one refusal legitimately says "is not a postgres:// or postgresql://
      // URL", which is advice about the format, not the value -- an assertion
      // that cannot tell those apart fails on correct code, as this one did
      // before it was narrowed.
      expect(outcome.message).not.toContain('sekrit');
      expect(outcome.message).not.toContain('ppbf-pg-prod');
      expect(outcome.message).not.toContain('ppbf-pg-staging');
      expect(outcome.message).not.toContain('@');
      expect(outcome.message).not.toContain(STAGING);
      expect(outcome.message).not.toContain(PRODUCTION);
    }
  });
});
