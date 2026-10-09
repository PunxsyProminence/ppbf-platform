// The guards of scripts/pilot-close-inactive-sessions.ts, run as the workflow
// runs it: a real tsx child process, with the environment it would see. None
// of these cases reaches a database -- each stops at a guard -- so the test
// needs no Postgres; what it proves is that the script refuses before it
// could connect, and says why in one JSON line.
//
// The rule the script runs is covered by sessionAutoClose.pg.test.ts.

import { spawnSync } from 'node:child_process';
import path from 'node:path';

const SCRIPT = path.resolve(__dirname, 'pilot-close-inactive-sessions.ts');
const TSX_CLI = path.resolve(__dirname, '../../../node_modules/tsx/dist/cli.mjs');

// A loopback string that is syntactically valid and points nowhere this test
// will ever connect: every case below is refused before a socket is opened.
const LOOPBACK = 'postgres://user:secret@localhost:1/some_db';

function run(env: Record<string, string>) {
  const result = spawnSync(process.execPath, [TSX_CLI, SCRIPT], {
    encoding: 'utf8',
    // A minimal environment: only what node needs to start on either OS, plus
    // the case's own variables -- so nothing from this shell (a .env.local
    // connection string, say) can leak into the child and satisfy a guard.
    env: {
      NODE_ENV: process.env.NODE_ENV,
      PATH: process.env.PATH ?? '',
      SYSTEMROOT: process.env.SYSTEMROOT ?? '',
      ...env,
    },
    timeout: 60_000,
  });
  const lastLine = (stream: string) => stream.trim().split('\n').filter(Boolean).pop() ?? '';
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    stderrLine: JSON.parse(lastLine(result.stderr) || 'null') as Record<string, unknown> | null,
  };
}

jest.setTimeout(90_000);

describe('pilot-close-inactive-sessions refuses before it connects', () => {
  test('no connection string', () => {
    const result = run({});
    expect(result.status).toBe(1);
    expect(result.stderrLine).toEqual({ event: 'session.autoclose.failed', reason: 'MISSING_CONNECTION_STRING' });
    expect(result.stdout).toBe('');
  });

  test('a connection string with no declared target', () => {
    const result = run({ AZURE_POSTGRES_CONNECTION_STRING: LOOPBACK, PPBF_SESSION_AUTOCLOSE_APPLY: 'true' });
    expect(result.status).toBe(1);
    expect(result.stderrLine).toEqual({ event: 'session.autoclose.refused', reason: 'MISSING_PPBF_EXPECTED_POSTGRES_HOSTNAME' });
    expect(result.stdout).toBe('');
  });

  test('a declared target that does not match the connection string', () => {
    const result = run({
      AZURE_POSTGRES_CONNECTION_STRING: LOOPBACK,
      PPBF_EXPECTED_POSTGRES_HOSTNAME: 'ppbf-pg-staging.example',
      PPBF_EXPECTED_POSTGRES_DATABASE: 'some_db',
      PPBF_SESSION_AUTOCLOSE_APPLY: 'true',
    });
    expect(result.status).toBe(1);
    expect(result.stderrLine).toEqual({ event: 'session.autoclose.refused', reason: 'POSTGRES_TARGET_MISMATCH' });
    // The refusal never echoes the connection string or its credentials.
    expect(result.stderr).not.toContain('secret');
    expect(result.stdout).toBe('');
  });
});
