import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// Guards on the bootstrap CLI's refusal order.
//
// WHY THIS FILE EXISTS. The write-target guard is the only thing standing
// between an operator shell that happens to hold a production connection
// string and real rows in production -- and a guard nothing executes is a
// guard that can be deleted in a refactor without a single test going red.
// seedDataWriteTarget.test.ts records exactly that: "delete the call from
// runCli() and every one of them still passes". This runs the real script
// through the real loader so that cannot be true here.
//
// HOW IT RUNS. The script is TypeScript consumed through tsx, which is the
// loader `npm run calibration:bootstrap` itself uses, so each case exercises
// the file as the command line consumes it rather than a transpiled copy.
//
// Nothing here reaches a database. Every case is refused before the pool is
// ever constructed, and the connection string below points at a hostname
// reserved by RFC 2606 to be unresolvable.

jest.setTimeout(120_000);

const REPO_ROOT = path.resolve(__dirname, '../../..');
const TSX_BIN = path.join(REPO_ROOT, 'node_modules/.bin/tsx');
const SCRIPT = path.join(__dirname, 'pilot-bootstrap-calibration-clip.ts');

const UNREACHABLE = 'postgres://user:secret@db.invalid:5432/ppbf_nowhere';

const VALID_ARGS = [
  '--organization-id', 'org-calib',
  '--video-session-id', 'vs-calib-ready',
  '--project-name', 'Calibration round 1',
  '--clip-code', 'C-01',
  '--start-ms', '91337',
  '--end-ms', '97004',
  '--sampling-reason', 'simultaneous_exchange',
  '--created-by-account-id', 'acct-calib-coach',
];

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

/** Runs the CLI with a deliberately minimal environment. */
function run(args: string[], env: Record<string, string> = {}): RunResult {
  try {
    const stdout = execFileSync(TSX_BIN, [SCRIPT, ...args], {
      encoding: 'utf8',
      // PATH and NODE_ENV only: nothing from this machine's environment can
      // supply a connection string or an expected target by accident.
      env: { PATH: process.env.PATH ?? '', NODE_ENV: 'test', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: 0, stdout, stderr: '' };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return {
      status: failure.status ?? 1,
      stdout: failure.stdout ?? '',
      stderr: failure.stderr ?? '',
    };
  }
}

test('the script and the loader it is registered against both exist', () => {
  // If either moves, every other case in this file would pass vacuously by
  // failing for the wrong reason.
  expect(fs.existsSync(SCRIPT)).toBe(true);
  expect(fs.existsSync(TSX_BIN)).toBe(true);
});

describe('what it refuses, and in what order', () => {
  test('REFUSES a bad argument list before it looks for a database at all', () => {
    // Ordering matters: an operator who mistyped a flag should be told that,
    // not sent to find an environment variable they do not need yet.
    const result = run(['--organization-id', 'org-calib']);

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/Missing required argument/);
    expect(result.stderr).not.toMatch(/AZURE_POSTGRES_CONNECTION_STRING/);
  });

  test('REFUSES an unrecognised flag, naming it', () => {
    const result = run([...VALID_ARGS, '--athlete-id', 'ATH-SOMEONE-ELSE']);

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/Unrecognised argument: --athlete-id/);
  });

  test('REFUSES a valid request with no connection string', () => {
    const result = run(VALID_ARGS);

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/AZURE_POSTGRES_CONNECTION_STRING/);
  });

  test('REFUSES to write when the operator declared no expected target', () => {
    // THE CASE THIS FILE IS FOR. Fails closed: an unset guard is an error,
    // not a skip, or it would protect only the environments that remembered
    // to configure it.
    const result = run(VALID_ARGS, { AZURE_POSTGRES_CONNECTION_STRING: UNREACHABLE });

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/MISSING_PPBF_EXPECTED_POSTGRES_HOSTNAME/);
    expect(result.stderr).toMatch(/PILOT CALIBRATION BOOTSTRAP FAIL/);
  });

  test('REFUSES to write when the declared target is not the one connected to', () => {
    const result = run(VALID_ARGS, {
      AZURE_POSTGRES_CONNECTION_STRING: UNREACHABLE,
      PPBF_EXPECTED_POSTGRES_HOSTNAME: 'some-other-host.postgres.database.azure.com',
      PPBF_EXPECTED_POSTGRES_DATABASE: 'ppbf_nowhere',
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/POSTGRES_TARGET_MISMATCH/);
  });

  test('never prints the connection string or its credentials', () => {
    // The guard's refusals are bare machine tokens by design, because a
    // connection string carries a password.
    const result = run(VALID_ARGS, {
      AZURE_POSTGRES_CONNECTION_STRING: UNREACHABLE,
      PPBF_EXPECTED_POSTGRES_HOSTNAME: 'some-other-host.postgres.database.azure.com',
      PPBF_EXPECTED_POSTGRES_DATABASE: 'ppbf_nowhere',
    });

    const printed = `${result.stdout}${result.stderr}`;
    expect(printed).not.toContain('secret');
    expect(printed).not.toContain(UNREACHABLE);
  });
});
