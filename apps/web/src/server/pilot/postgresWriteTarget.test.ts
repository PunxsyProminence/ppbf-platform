// Contract tests for the fixture write-target guard.
//
// The guard's whole value is that it FAILS. A suite that only asserted the happy
// path would pass equally against a guard that never throws -- which is the state
// that let production accumulate 361 orphaned rows. So most of what is asserted
// here is refusal.
//
// The module under test is real ESM (.mjs), and the default jest runner has no
// ESM loader (`npm test` does not pass --experimental-vm-modules; only the
// .pg.test.ts scripts do). Rather than convert the module or exclude it from the
// default suite, every case is evaluated in one real `node` child process, whose
// loader is the same one the migration workflows use. That also means these
// tests exercise the module exactly as the scripts consume it, not a transpiled
// copy of it.

import { execFileSync } from 'node:child_process';
import path from 'node:path';

const MODULE_PATH = path.resolve(__dirname, '../../../scripts/lib/postgres-write-target.mjs');

const STAGING = 'postgres://u:p@ppbf-pg-staging.postgres.database.azure.com:5432/postgres';
const PRODUCTION = 'postgres://u:p@ppbf-pg-195892.postgres.database.azure.com:5432/postgres';
const STAGING_HOST = 'ppbf-pg-staging.postgres.database.azure.com';
const PRODUCTION_HOST = 'ppbf-pg-195892.postgres.database.azure.com';

type Outcome = { ok: true; value: unknown } | { ok: false; message: string };

// Each case is a snippet evaluated against the imported module. Returning
// structured outcomes (rather than letting the child exit non-zero) keeps one
// spawn for the whole suite while still reporting per-case results.
const CASES: Record<string, string> = {
  parse_staging: 'g.parseConnectionTarget(C.STAGING)',
  parse_mixed_case:
    'g.parseConnectionTarget("postgres://u:p@PPBF-PG-STAGING.Postgres.Database.Azure.Com/postgres")',
  parse_not_a_url: 'g.parseConnectionTarget("not a url at all")',
  parse_wrong_protocol: 'g.parseConnectionTarget("mysql://u:p@host/db")',
  parse_no_database: 'g.parseConnectionTarget("postgres://u:p@host/")',
  parse_leaks_secret: 'g.parseConnectionTarget("mysql://user:sekrit@host/db")',

  assert_match: 'g.assertDeclaredWriteTarget(C.STAGING, {hostname: C.STAGING_HOST, database: "postgres"})',
  assert_production_when_staging_declared:
    'g.assertDeclaredWriteTarget(C.PRODUCTION, {hostname: C.STAGING_HOST, database: "postgres"})',
  assert_database_differs:
    'g.assertDeclaredWriteTarget(C.STAGING, {hostname: C.STAGING_HOST, database: "some_other_db"})',
  assert_no_expected_at_all: 'g.assertDeclaredWriteTarget(C.PRODUCTION)',
  assert_host_only: 'g.assertDeclaredWriteTarget(C.PRODUCTION, {hostname: C.PRODUCTION_HOST})',
  assert_whitespace_host:
    'g.assertDeclaredWriteTarget(C.PRODUCTION, {hostname: "   ", database: "postgres"})',
  assert_production_explicitly_declared:
    'g.assertDeclaredWriteTarget(C.PRODUCTION, {hostname: C.PRODUCTION_HOST, database: "postgres"})',

  env_match:
    'g.assertDeclaredWriteTargetFromEnv(C.STAGING, {PPBF_EXPECTED_POSTGRES_HOSTNAME: C.STAGING_HOST, PPBF_EXPECTED_POSTGRES_DATABASE: "postgres"})',
  env_mismatch:
    'g.assertDeclaredWriteTargetFromEnv(C.PRODUCTION, {PPBF_EXPECTED_POSTGRES_HOSTNAME: C.STAGING_HOST, PPBF_EXPECTED_POSTGRES_DATABASE: "postgres"})',
  env_empty: 'g.assertDeclaredWriteTargetFromEnv(C.PRODUCTION, {})',
};

let outcomes: Record<string, Outcome>;

beforeAll(() => {
  const constants = JSON.stringify({
    STAGING,
    PRODUCTION,
    STAGING_HOST,
    PRODUCTION_HOST,
  });
  const body = Object.entries(CASES)
    .map(
      ([name, expr]) =>
        `try { out[${JSON.stringify(name)}] = {ok: true, value: ${expr}}; }`
        + ` catch (e) { out[${JSON.stringify(name)}] = {ok: false, message: e.message}; }`,
    )
    .join('\n');

  const script = `
    import * as g from ${JSON.stringify(MODULE_PATH)};
    const C = ${constants};
    const out = {};
    ${body}
    process.stdout.write(JSON.stringify(out));
  `;

  const stdout = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
  });
  outcomes = JSON.parse(stdout);
});

function expectThrew(name: string, token: string) {
  const outcome = outcomes[name];
  expect(outcome.ok).toBe(false);
  expect((outcome as { ok: false; message: string }).message).toBe(token);
}

function expectResolved(name: string, value: unknown) {
  const outcome = outcomes[name];
  if (outcome.ok !== true) {
    throw new Error(`${name} threw unexpectedly: ${(outcome as { message: string }).message}`);
  }
  expect(outcome.value).toEqual(value);
}

describe('parseConnectionTarget', () => {
  test('extracts a lowercased hostname and the database name', () => {
    expectResolved('parse_staging', { hostname: STAGING_HOST, database: 'postgres' });
  });

  test('lowercases a mixed-case hostname so comparison is case-insensitive', () => {
    expectResolved('parse_mixed_case', { hostname: STAGING_HOST, database: 'postgres' });
  });

  test('rejects a string that is not a URL', () => {
    expectThrew('parse_not_a_url', 'INVALID_POSTGRES_CONNECTION_STRING');
  });

  test('rejects a non-postgres protocol', () => {
    expectThrew('parse_wrong_protocol', 'INVALID_POSTGRES_PROTOCOL');
  });

  test('rejects a URL with no database in the path', () => {
    expectThrew('parse_no_database', 'INCOMPLETE_POSTGRES_TARGET');
  });

  test('never includes the connection string in the error message', () => {
    // These messages get printed by callers, and a connection string carries
    // credentials.
    const outcome = outcomes.parse_leaks_secret;
    expect(outcome.ok).toBe(false);
    const { message } = outcome as { ok: false; message: string };
    expect(message).toBe('INVALID_POSTGRES_PROTOCOL');
    expect(message).not.toContain('sekrit');
    expect(message).not.toContain('user');
  });
});

describe('assertDeclaredWriteTarget', () => {
  test('accepts a connection string matching the declared target', () => {
    expectResolved('assert_match', { hostname: STAGING_HOST, database: 'postgres' });
  });

  test('THE POINT: refuses production when staging was declared', () => {
    // The 2026-07-18 scenario -- a gate run holding a production connection
    // string. Before this guard existed it provisioned fixtures there without
    // complaint, which is how 361 orphaned rows got in.
    expectThrew('assert_production_when_staging_declared', 'POSTGRES_TARGET_MISMATCH');
  });

  test('refuses a matching host when the database differs', () => {
    expectThrew('assert_database_differs', 'POSTGRES_TARGET_MISMATCH');
  });

  test('fails closed when no expected target is given, rather than skipping', () => {
    // A guard that no-ops when unconfigured is no guard at all for the ad-hoc
    // run it exists to stop.
    expectThrew('assert_no_expected_at_all', 'MISSING_PPBF_EXPECTED_POSTGRES_HOSTNAME');
  });

  test('fails closed when only the hostname is given', () => {
    expectThrew('assert_host_only', 'MISSING_PPBF_EXPECTED_POSTGRES_DATABASE');
  });

  test('treats a whitespace-only expected hostname as absent', () => {
    expectThrew('assert_whitespace_host', 'MISSING_PPBF_EXPECTED_POSTGRES_HOSTNAME');
  });

  test('allows production when production is what was explicitly declared', () => {
    // The guard enforces intent, not an environment blocklist -- a deliberate
    // production fixture run stays possible, but only by naming it.
    expectResolved('assert_production_explicitly_declared', {
      hostname: PRODUCTION_HOST,
      database: 'postgres',
    });
  });
});

describe('assertDeclaredWriteTargetFromEnv', () => {
  test('reads the same variable names the migration runners use', () => {
    expectResolved('env_match', { hostname: STAGING_HOST, database: 'postgres' });
  });

  test('refuses a mismatch sourced from the environment', () => {
    expectThrew('env_mismatch', 'POSTGRES_TARGET_MISMATCH');
  });

  test('refuses an empty environment', () => {
    expectThrew('env_empty', 'MISSING_PPBF_EXPECTED_POSTGRES_HOSTNAME');
  });
});
