// Real PostgreSQL-backed test for the per-organization video release policy.
//
// The invariants worth proving here are database behaviour and a ceiling:
//
//   * absence of a row reads as the STRICT posture, so a tenant that was never
//     configured can never read as permission
//   * a loosened policy cannot exist without naming who loosened it
//   * no policy value, present or future, reaches 'infected' or 'blocked' --
//     the dial widens "nothing judged it", never "something refused it"
//
// Also pins the sweep fix: 'unconfigured' was unreachable, so a no-scanner
// environment left every upload at 'pending' with no exit for machine or coach.
//
// Spins up the same disposable, local-only embedded Postgres the other
// migration suites use. It NEVER connects to production or staging.

import { type ChildProcessByStdio, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import type { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';

import { Client } from 'pg';

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-org-video-policy-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const TEST_DB_NAME = 'ppbf_test_org_video_policy';

const ORG_ID = 'org-video';
const OTHER_ORG_ID = 'org-video-other';
const ADMIN_ID = 'acct-video-admin';

const MIGRATION_RUNNER_PATH = path.resolve(
  __dirname,
  '../../../scripts/pilot-apply-organization-video-policy-migration.mjs',
);

// Jest's CJS transform rewrites a bare `import()` into `require()`, which
// cannot load an ESM .mjs runner. Building the import through `new Function`
// keeps a real dynamic import in the emitted code, which Node honors under
// --experimental-vm-modules (the flag every test:migrations:* script already
// passes). Same pattern as activityLog.pg.test.ts.
const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let policy: typeof import('./videoReleasePolicy');

function connectionStringFor(database: string): string {
  return `postgres://${PG_USER}:${PG_PASSWORD}@localhost:${PG_PORT}/${database}`;
}

async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address && typeof address === 'object') {
        const { port } = address;
        server.close(() => resolve(port));
      } else {
        server.close(() => reject(new Error('Could not determine a free port')));
      }
    });
  });
}

beforeAll(async () => {
  PG_PORT = await findFreePort();
  serverProcess = spawn(process.execPath, [SERVER_SCRIPT_PATH, DATA_DIR, String(PG_PORT)], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stderrOutput = '';
  serverProcess.stderr.on('data', (chunk) => { stderrOutput += chunk.toString(); });

  await new Promise<void>((resolve, reject) => {
    const rl = readline.createInterface({ input: serverProcess.stdout });
    const timeout = setTimeout(() => {
      rl.close();
      reject(new Error(`Embedded Postgres did not become ready in time. stderr:\n${stderrOutput}`));
    }, 120_000);
    rl.on('line', (line) => {
      if (line.includes('EMBEDDED_PG_READY')) {
        clearTimeout(timeout);
        rl.close();
        resolve();
      }
    });
    serverProcess.once('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`Embedded Postgres process exited early (code ${code}). stderr:\n${stderrOutput}`));
    });
  });

  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  await admin.query(`drop database if exists ${TEST_DB_NAME}`);
  await admin.query(`create database ${TEST_DB_NAME}`);
  await admin.end();

  const migrate = new Client({ connectionString: connectionStringFor(TEST_DB_NAME) });
  await migrate.connect();
  await migrate.query(await fs.readFile(path.join(INFRA_DIR, 'pilot_slice_postgres.sql'), 'utf8'));
  await migrate.query(
    await fs.readFile(path.join(INFRA_DIR, 'pilot_slice_postgres_organization_video_policy_migration.sql'), 'utf8'),
  );
  for (const orgId of [ORG_ID, OTHER_ORG_ID]) {
    await migrate.query(
      `insert into pilot.organizations (organization_id, organization_name, status)
       values ($1, $1, 'active') on conflict do nothing`,
      [orgId],
    );
  }
  await migrate.query(
    `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
     values ($1, 'organization_admin', $2, 'microsoft') on conflict do nothing`,
    [ADMIN_ID, ORG_ID],
  );
  await migrate.end();

  process.env.AZURE_POSTGRES_CONNECTION_STRING = connectionStringFor(TEST_DB_NAME);
  process.env.PPBF_POSTGRES_DISABLE_SSL = 'true';
  policy = await import('./videoReleasePolicy');
});

afterAll(async () => {
  const { closePool } = await import('./db');
  await closePool();
  await new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(safetyTimer);
      resolve();
    };
    const safetyTimer = setTimeout(finish, 15_000);
    safetyTimer.unref();
    serverProcess.once('exit', finish);
    serverProcess.kill('SIGTERM');
  });
});

describe('absence means strict', () => {
  test('an organization with no row reads scan_required', async () => {
    // Deploying the migration must change nothing for anybody. A tenant nobody
    // configured cannot read as permission.
    await expect(policy.getVideoReleasePolicy(OTHER_ORG_ID)).resolves.toBe('scan_required');
  });

  test('an unknown organization also reads strict rather than throwing', async () => {
    await expect(policy.getVideoReleasePolicy('org-does-not-exist')).resolves.toBe('scan_required');
  });
});

describe('recording a policy', () => {
  test('an administrator can loosen it, and the change is attributed', async () => {
    await policy.setVideoReleasePolicy({
      organizationId: ORG_ID,
      policy: 'coach_attested',
      setByAccountId: ADMIN_ID,
    });

    await expect(policy.getVideoReleasePolicy(ORG_ID)).resolves.toBe('coach_attested');

    const client = new Client({ connectionString: connectionStringFor(TEST_DB_NAME) });
    await client.connect();
    try {
      const row = await client.query(
        'select set_by_account_id from pilot.organization_video_policy where organization_id = $1',
        [ORG_ID],
      );
      expect(row.rows[0].set_by_account_id).toBe(ADMIN_ID);
    } finally {
      await client.end();
    }
  });

  test('setting it again updates in place rather than duplicating', async () => {
    await policy.setVideoReleasePolicy({
      organizationId: ORG_ID, policy: 'coach_attested', setByAccountId: ADMIN_ID,
    });
    await policy.setVideoReleasePolicy({
      organizationId: ORG_ID, policy: 'scan_required', setByAccountId: ADMIN_ID,
    });
    await expect(policy.getVideoReleasePolicy(ORG_ID)).resolves.toBe('scan_required');
  });

  test('one organization loosening it does not loosen another', async () => {
    await policy.setVideoReleasePolicy({
      organizationId: ORG_ID, policy: 'coach_attested', setByAccountId: ADMIN_ID,
    });
    await expect(policy.getVideoReleasePolicy(OTHER_ORG_ID)).resolves.toBe('scan_required');
  });

  test('the database refuses a loosened policy with nobody named', async () => {
    const client = new Client({ connectionString: connectionStringFor(TEST_DB_NAME) });
    await client.connect();
    try {
      await expect(
        client.query(
          `insert into pilot.organization_video_policy (organization_id, release_policy)
           values ($1, 'coach_attested')`,
          [OTHER_ORG_ID],
        ),
      ).rejects.toThrow(/pilot_org_video_policy_attributed/);
    } finally {
      await client.end();
    }
  });

  test('the database refuses a policy outside the vocabulary', async () => {
    const client = new Client({ connectionString: connectionStringFor(TEST_DB_NAME) });
    await client.connect();
    try {
      await expect(
        client.query(
          `insert into pilot.organization_video_policy
             (organization_id, release_policy, set_by_account_id)
           values ($1, 'anything_goes', $2)`,
          [OTHER_ORG_ID, ADMIN_ID],
        ),
      ).rejects.toThrow(/release_policy/);
    } finally {
      await client.end();
    }
  });
});

describe('the ceiling is not configurable', () => {
  test.each(['scan_required', 'coach_attested'] as const)(
    'under %s a coach still cannot release blocked, infected or error',
    (setting) => {
      const releasable = policy.releasableScanStates(setting);
      for (const refused of policy.NEVER_COACH_RELEASABLE_STATES) {
        expect(releasable).not.toContain(refused);
      }
    },
  );

  test('the strict posture allows only what the scanner deferred', () => {
    expect(policy.releasableScanStates('scan_required').sort())
      .toEqual(['needs_human_review', 'unconfigured']);
  });

  test('the loosened posture adds in-flight verdicts and nothing else', () => {
    expect(policy.releasableScanStates('coach_attested').sort())
      .toEqual(['needs_human_review', 'pending', 'scanning', 'unconfigured']);
  });
});

// The runner's OWN readiness assertion, not just the SQL it applies.
//
// The suite above migrates one database in beforeAll with a plain
// `client.query` and then tests the module on top of it. That proves the
// schema and proves nothing about scripts/pilot-apply-organization-video-policy-migration.mjs's
// READINESS_QUERY -- the assertion that gates the actual dispatch, and the
// only code in this migration whose first real execution is against a live
// environment at the most expensive possible moment.
//
// #488 is what that costs: a readiness check that searched
// pg_get_constraintdef() for the literal `between 1 and 5` could not pass on
// ANY database, because Postgres deparses a CHECK from the parsed tree and
// emits `>= 1 AND <= 5`. The schema was correct the whole time. Only a real
// staging dispatch found it.
//
// The query is never restated here -- `applyMigrationTransaction` is imported
// out of the shipped runner and executes the shipped READINESS_QUERY, so this
// cannot stay green while the runner rots. It brings its own disposable
// database so the migrated one the module tests run against is untouched.
describe('organization video policy runner readiness assertion', () => {
  async function runnerDatabase(name: string): Promise<Client> {
    const admin = new Client({ connectionString: connectionStringFor('postgres') });
    await admin.connect();
    await admin.query(`drop database if exists ${name}`);
    await admin.query(`create database ${name}`);
    await admin.end();

    const client = new Client({ connectionString: connectionStringFor(name) });
    await client.connect();
      await client.query(await fs.readFile(path.join(INFRA_DIR, 'pilot_slice_postgres.sql'), 'utf8'));
    return client;
  }

  async function loadRunner(): Promise<(client: Client, sql: string) => Promise<void>> {
    const runnerModule = await nativeDynamicImport(pathToFileURL(MIGRATION_RUNNER_PATH).href);
    return runnerModule.applyMigrationTransaction as (client: Client, sql: string) => Promise<void>;
  }

  test('the real runner REFUSES a database where the migration never ran', async () => {
    const applyMigrationTransaction = await loadRunner();
    const client = await runnerDatabase('ppbf_test_org_vp_rdy_no');
    try {
      await expect(applyMigrationTransaction(client, 'select 1')).rejects.toThrow(
        /ORGANIZATION_VIDEO_POLICY_NOT_READY/,
      );
    } finally {
      await client.end();
    }
  });

  test('the real runner ACCEPTS a correctly migrated database, and a re-apply stays a no-op', async () => {
    const applyMigrationTransaction = await loadRunner();
    const client = await runnerDatabase('ppbf_test_org_vp_rdy_ok');
    try {
      const migrationSql = await fs.readFile(path.join(INFRA_DIR, 'pilot_slice_postgres_organization_video_policy_migration.sql'), 'utf8');
      await applyMigrationTransaction(client, migrationSql);
      // The `all` chain re-runs every migration on every dispatch (#489), so
      // the second pass has to survive its own first pass.
      await applyMigrationTransaction(client, migrationSql);
    } finally {
      await client.end();
    }
  });
});
