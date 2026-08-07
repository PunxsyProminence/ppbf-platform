// Real PostgreSQL-backed contract test for the guardian-media-consent
// migration (pilot.waivers gains parent_id / covers_video /
// public_use_allowed) and for the REAL guardianConsent.ts module behavior on
// top of it: './db' is mocked to route into the embedded server, so
// checkGuardianMediaConsent, grantMediaConsent, withdrawMediaConsent, and
// assertGuardianMediaConsent below are the actual production functions
// executing their actual SQL against actual rows.
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

import { Client } from 'pg';

let activeClient: Client | null = null;

jest.mock('./db', () => ({
  query: jest.fn(async (text: string, params: unknown[] = []) => {
    if (!activeClient) throw new Error('test bug: no active embedded client');
    const result = await activeClient.query(text, params);
    return result.rows;
  }),
  queryOne: jest.fn(async (text: string, params: unknown[] = []) => {
    if (!activeClient) throw new Error('test bug: no active embedded client');
    const result = await activeClient.query(text, params);
    return result.rows[0] ?? null;
  }),
}));

import {
  assertGuardianMediaConsent,
  checkGuardianMediaConsent,
  GuardianConsentMissingError,
  grantMediaConsent,
  listOrganizationConsentStatus,
  withdrawMediaConsent,
} from './guardianConsent';

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-guardian-consent-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const MIGRATION_FILE = 'pilot_slice_postgres_guardian_media_consent_migration.sql';

const ORG_ID = 'org-consent';
const ATHLETE_ID = 'ATH-CONSENT-1';
const COACH_ID = 'acct-consent-coach';
const PARENT_ACCOUNT_ID = 'acct-consent-parent-1';
const PARENT_ID = 'parent-consent-1';
const SECOND_PARENT_ACCOUNT_ID = 'acct-consent-parent-2';
const SECOND_PARENT_ID = 'parent-consent-2';

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let migrationSql: string;
let baseSchemaSql: string;

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

/** Fresh database with the base schema, migration applied, and the org/athlete/guardian rows the FKs need. */
async function freshDatabase(name: string, options: { withSecondGuardian?: boolean } = {}): Promise<Client> {
  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  await admin.query(`drop database if exists ${name}`);
  await admin.query(`create database ${name}`);
  await admin.end();

  const client = new Client({ connectionString: connectionStringFor(name) });
  await client.connect();
  await client.query(baseSchemaSql);
  await client.query(migrationSql);

  await client.query(
    `insert into pilot.organizations (organization_id, organization_name, status)
     values ($1, $1, 'active') on conflict do nothing`,
    [ORG_ID],
  );
  await client.query(
    `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
     values ($1, 'coach', $2, 'microsoft') on conflict do nothing`,
    [COACH_ID, ORG_ID],
  );
  await client.query(
    `insert into pilot.athletes (organization_id, athlete_id, full_name, dob, weight_class, gym_status, emergency_contact, active_flag, coach_id, created_at, updated_at)
     values ($1, $2, 'Consent Athlete', '2012-03-04', 'fly', 'active', 'contact', true, $3, now(), now())
     on conflict do nothing`,
    [ORG_ID, ATHLETE_ID, COACH_ID],
  );
  await client.query(
    `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
     values ($1, 'parent', $2, 'microsoft') on conflict do nothing`,
    [PARENT_ACCOUNT_ID, ORG_ID],
  );
  await client.query(
    `insert into pilot.parents (organization_id, parent_id, account_id, full_name)
     values ($1, $2, $3, 'Jane Guardian') on conflict do nothing`,
    [ORG_ID, PARENT_ID, PARENT_ACCOUNT_ID],
  );
  await client.query(
    `insert into pilot.guardian_links (organization_id, parent_id, athlete_id, relationship_to_athlete)
     values ($1, $2, $3, 'mother') on conflict do nothing`,
    [ORG_ID, PARENT_ID, ATHLETE_ID],
  );

  if (options.withSecondGuardian) {
    await client.query(
      `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
       values ($1, 'parent', $2, 'microsoft') on conflict do nothing`,
      [SECOND_PARENT_ACCOUNT_ID, ORG_ID],
    );
    await client.query(
      `insert into pilot.parents (organization_id, parent_id, account_id, full_name)
       values ($1, $2, $3, 'John Guardian') on conflict do nothing`,
      [ORG_ID, SECOND_PARENT_ID, SECOND_PARENT_ACCOUNT_ID],
    );
    await client.query(
      `insert into pilot.guardian_links (organization_id, parent_id, athlete_id, relationship_to_athlete)
       values ($1, $2, $3, 'father') on conflict do nothing`,
      [ORG_ID, SECOND_PARENT_ID, ATHLETE_ID],
    );
  }

  return client;
}

beforeAll(async () => {
  PG_PORT = await findFreePort();

  serverProcess = spawn(process.execPath, [SERVER_SCRIPT_PATH, DATA_DIR, String(PG_PORT)], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stderrOutput = '';
  serverProcess.stderr.on('data', (chunk) => {
    stderrOutput += chunk.toString();
  });

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

  baseSchemaSql = await fs.readFile(path.join(INFRA_DIR, 'pilot_slice_postgres.sql'), 'utf8');
  migrationSql = await fs.readFile(path.join(INFRA_DIR, MIGRATION_FILE), 'utf8');
});

afterAll(async () => {
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

describe('guardian media consent migration DDL', () => {
  test('the gap is real: before the migration, pilot.waivers has no parent_id column', async () => {
    const admin = new Client({ connectionString: connectionStringFor('postgres') });
    await admin.connect();
    await admin.query('drop database if exists ppbf_test_consent_absent');
    await admin.query('create database ppbf_test_consent_absent');
    await admin.end();

    const client = new Client({ connectionString: connectionStringFor('ppbf_test_consent_absent') });
    await client.connect();
    try {
      await client.query(baseSchemaSql);
      const row = await client.query(
        `select column_name from information_schema.columns where table_schema = 'pilot' and table_name = 'waivers' and column_name = 'parent_id'`,
      );
      expect(row.rows).toHaveLength(0);
    } finally {
      await client.end();
    }
  });

  test('after the migration, pilot.waivers has the three new columns with correct nullability and defaults', async () => {
    const client = await freshDatabase('ppbf_test_consent_columns');
    try {
      const columns = await client.query(
        `select column_name, is_nullable, column_default
         from information_schema.columns
         where table_schema = 'pilot' and table_name = 'waivers' and column_name in ('parent_id', 'covers_video', 'public_use_allowed')`,
      );
      const byName = Object.fromEntries(columns.rows.map((r: { column_name: string; is_nullable: string; column_default: string }) => [r.column_name, r]));
      expect(byName.parent_id.is_nullable).toBe('YES');
      expect(byName.covers_video.is_nullable).toBe('NO');
      expect(byName.covers_video.column_default).toContain('true');
      expect(byName.public_use_allowed.is_nullable).toBe('NO');
      expect(byName.public_use_allowed.column_default).toContain('false');
    } finally {
      await client.end();
    }
  });

  test('the parent_id foreign key is real: an unknown parent_id is refused', async () => {
    const client = await freshDatabase('ppbf_test_consent_fk');
    try {
      await expect(
        client.query(
          `insert into pilot.waivers (organization_id, waiver_id, athlete_id, waiver_type, signed_by_name, signed_by_role, signed_at, consent_version, status, parent_id)
           values ($1, gen_random_uuid(), $2, 'photo_media', 'Nobody', 'parent', now(), 'v1', 'signed', 'parent-does-not-exist')`,
          [ORG_ID, ATHLETE_ID],
        ),
      ).rejects.toThrow(/pilot_waivers_parent_fk|foreign key/);
    } finally {
      await client.end();
    }
  });

  test('existing rows (other waiver types, no parent_id) are untouched by the migration', async () => {
    const client = await freshDatabase('ppbf_test_consent_existing_rows');
    try {
      await client.query(
        `insert into pilot.waivers (organization_id, waiver_id, athlete_id, waiver_type, signed_by_name, signed_by_role, signed_at, consent_version, status)
         values ($1, gen_random_uuid(), $2, 'general', 'A Parent', 'parent', now(), 'v1', 'signed')`,
        [ORG_ID, ATHLETE_ID],
      );

      await client.query(migrationSql);

      const row = await client.query(
        `select waiver_type, status, parent_id, covers_video, public_use_allowed from pilot.waivers where waiver_type = 'general'`,
      );
      expect(row.rows).toHaveLength(1);
      expect(row.rows[0].status).toBe('signed');
      expect(row.rows[0].parent_id).toBeNull();
      expect(row.rows[0].covers_video).toBe(true);
      expect(row.rows[0].public_use_allowed).toBe(false);
    } finally {
      await client.end();
    }
  });

  test('re-running the migration is a no-op and does not disturb stored rows', async () => {
    const client = await freshDatabase('ppbf_test_consent_idempotent');
    try {
      await client.query(
        `insert into pilot.waivers (organization_id, waiver_id, athlete_id, waiver_type, signed_by_name, signed_by_role, signed_at, consent_version, status, parent_id, covers_video, public_use_allowed)
         values ($1, gen_random_uuid(), $2, 'photo_media', 'Jane Guardian', 'parent', now(), 'v1', 'signed', $3, true, false)`,
        [ORG_ID, ATHLETE_ID, PARENT_ID],
      );

      await client.query(migrationSql);
      await client.query(migrationSql);

      const row = await client.query(`select count(*)::int as n from pilot.waivers where waiver_type = 'photo_media'`);
      expect(row.rows[0].n).toBe(1);
    } finally {
      await client.end();
    }
  });
});

describe('guardianConsent.ts against real Postgres', () => {
  test('an athlete with no guardian_links rows is missing consent, not vacuously ok', async () => {
    const client = await freshDatabase('ppbf_test_consent_no_guardians');
    activeClient = client;
    try {
      await client.query(`delete from pilot.guardian_links where organization_id = $1 and athlete_id = $2`, [ORG_ID, ATHLETE_ID]);

      const result = await checkGuardianMediaConsent(ORG_ID, ATHLETE_ID);

      expect(result.ok).toBe(false);
      expect(result.guardianIds).toEqual([]);
    } finally {
      activeClient = null;
      await client.end();
    }
  });

  test('grant then check: consent is ok', async () => {
    const client = await freshDatabase('ppbf_test_consent_grant');
    activeClient = client;
    try {
      await grantMediaConsent({
        organizationId: ORG_ID,
        athleteId: ATHLETE_ID,
        parentId: PARENT_ID,
        signedByName: 'Jane Guardian',
        coversVideo: true,
        publicUseAllowed: false,
      });

      const result = await checkGuardianMediaConsent(ORG_ID, ATHLETE_ID);

      expect(result.ok).toBe(true);
      // signedAt: real Postgres (unlike the mocked-db unit tests) returns
      // timestamptz as a Date, not a string -- db.ts only string-patches
      // OID 1082 (date), not 1184 (timestamptz), matching every other
      // "created_at: string"-typed interface in this codebase (true only
      // after the API boundary's JSON serialization, not before it).
      expect(result.perGuardian).toEqual([
        { parentId: PARENT_ID, status: 'signed', coversVideo: true, publicUseAllowed: false, signedAt: expect.anything() },
      ]);
      await expect(assertGuardianMediaConsent(ORG_ID, ATHLETE_ID)).resolves.toBeUndefined();
    } finally {
      activeClient = null;
      await client.end();
    }
  });

  test('grant then withdraw: consent reverts to missing (append-only -- the withdrawn row is a NEW row, not an update)', async () => {
    const client = await freshDatabase('ppbf_test_consent_withdraw');
    activeClient = client;
    try {
      await grantMediaConsent({
        organizationId: ORG_ID,
        athleteId: ATHLETE_ID,
        parentId: PARENT_ID,
        signedByName: 'Jane Guardian',
        coversVideo: true,
        publicUseAllowed: false,
      });
      await withdrawMediaConsent({
        organizationId: ORG_ID,
        athleteId: ATHLETE_ID,
        parentId: PARENT_ID,
        signedByName: 'Jane Guardian',
      });

      const result = await checkGuardianMediaConsent(ORG_ID, ATHLETE_ID);

      expect(result.ok).toBe(false);
      expect(result.missingParentIds).toEqual([PARENT_ID]);

      // Append-only: two rows exist now, not one updated row.
      const rows = await client.query(
        `select status from pilot.waivers where organization_id = $1 and athlete_id = $2 and waiver_type = 'photo_media' order by created_at asc`,
        [ORG_ID, ATHLETE_ID],
      );
      expect(rows.rows.map((r: { status: string }) => r.status)).toEqual(['signed', 'withdrawn']);

      await expect(assertGuardianMediaConsent(ORG_ID, ATHLETE_ID)).rejects.toThrow(GuardianConsentMissingError);
    } finally {
      activeClient = null;
      await client.end();
    }
  });

  test('two guardians: only one has signed -- consent is not ok, and the missing one is named', async () => {
    const client = await freshDatabase('ppbf_test_consent_two_guardians', { withSecondGuardian: true });
    activeClient = client;
    try {
      await grantMediaConsent({
        organizationId: ORG_ID,
        athleteId: ATHLETE_ID,
        parentId: PARENT_ID,
        signedByName: 'Jane Guardian',
        coversVideo: true,
        publicUseAllowed: false,
      });
      // SECOND_PARENT_ID never signs.

      const result = await checkGuardianMediaConsent(ORG_ID, ATHLETE_ID);

      expect(result.ok).toBe(false);
      expect(result.missingParentIds).toEqual([SECOND_PARENT_ID]);
    } finally {
      activeClient = null;
      await client.end();
    }
  });

  test('two guardians: both sign -- consent is ok', async () => {
    const client = await freshDatabase('ppbf_test_consent_two_guardians_both', { withSecondGuardian: true });
    activeClient = client;
    try {
      await grantMediaConsent({ organizationId: ORG_ID, athleteId: ATHLETE_ID, parentId: PARENT_ID, signedByName: 'Jane Guardian', coversVideo: true, publicUseAllowed: false });
      await grantMediaConsent({ organizationId: ORG_ID, athleteId: ATHLETE_ID, parentId: SECOND_PARENT_ID, signedByName: 'John Guardian', coversVideo: false, publicUseAllowed: false });

      const result = await checkGuardianMediaConsent(ORG_ID, ATHLETE_ID);

      expect(result.ok).toBe(true);
      expect(result.perGuardian).toHaveLength(2);
    } finally {
      activeClient = null;
      await client.end();
    }
  });

  test('listOrganizationConsentStatus surfaces an athlete with zero guardians as missing, not cleared', async () => {
    const client = await freshDatabase('ppbf_test_consent_org_audit');
    activeClient = client;
    try {
      await client.query(`delete from pilot.guardian_links where organization_id = $1 and athlete_id = $2`, [ORG_ID, ATHLETE_ID]);

      const rows = await listOrganizationConsentStatus(ORG_ID);

      expect(rows).toEqual([
        { athleteId: ATHLETE_ID, athleteName: 'Consent Athlete', consent: { ok: false, guardianIds: [], missingParentIds: [], perGuardian: [] } },
      ]);
    } finally {
      activeClient = null;
      await client.end();
    }
  });

  // Round-8 review finding: no test proved organization scoping actually
  // held. pilot.athletes' primary key is (organization_id, athlete_id) --
  // athlete_id alone is NOT globally unique -- so two different gyms can
  // genuinely collide on the same athlete_id. If any query in
  // guardianConsent.ts ever dropped its organization_id predicate, this
  // collision is exactly the shape that would let one org's consent state
  // (or lack of it) leak into another org's read.
  test('two organizations sharing the same athlete_id do not leak consent state across the boundary', async () => {
    const client = await freshDatabase('ppbf_test_consent_cross_org');
    activeClient = client;
    const ORG_ID_2 = 'org-consent-2';
    const PARENT_ID_ORG2 = 'parent-consent-org2';
    try {
      await client.query(
        `insert into pilot.organizations (organization_id, organization_name, status) values ($1, $1, 'active') on conflict do nothing`,
        [ORG_ID_2],
      );
      await client.query(
        `insert into pilot.accounts (account_id, role, organization_id, auth_provider) values ($1, 'coach', $2, 'microsoft') on conflict do nothing`,
        ['acct-consent-coach-2', ORG_ID_2],
      );
      await client.query(
        `insert into pilot.athletes (organization_id, athlete_id, full_name, dob, weight_class, gym_status, emergency_contact, active_flag, coach_id, created_at, updated_at)
         values ($1, $2, 'Other Org Athlete', '2013-05-06', 'bantam', 'active', 'contact', true, $3, now(), now())
         on conflict do nothing`,
        [ORG_ID_2, ATHLETE_ID, 'acct-consent-coach-2'],
      );
      await client.query(
        `insert into pilot.accounts (account_id, role, organization_id, auth_provider) values ($1, 'parent', $2, 'microsoft') on conflict do nothing`,
        ['acct-consent-parent-org2', ORG_ID_2],
      );
      await client.query(
        `insert into pilot.parents (organization_id, parent_id, account_id, full_name) values ($1, $2, $3, 'Org2 Guardian') on conflict do nothing`,
        [ORG_ID_2, PARENT_ID_ORG2, 'acct-consent-parent-org2'],
      );
      await client.query(
        `insert into pilot.guardian_links (organization_id, parent_id, athlete_id, relationship_to_athlete) values ($1, $2, $3, 'mother') on conflict do nothing`,
        [ORG_ID_2, PARENT_ID_ORG2, ATHLETE_ID],
      );

      // Org 1's guardian signs; org 2's guardian (for the SAME athlete_id
      // string) never does.
      await grantMediaConsent({
        organizationId: ORG_ID,
        athleteId: ATHLETE_ID,
        parentId: PARENT_ID,
        signedByName: 'Jane Guardian',
        coversVideo: true,
        publicUseAllowed: false,
      });

      const org1Result = await checkGuardianMediaConsent(ORG_ID, ATHLETE_ID);
      const org2Result = await checkGuardianMediaConsent(ORG_ID_2, ATHLETE_ID);

      expect(org1Result.ok).toBe(true);
      expect(org1Result.guardianIds).toEqual([PARENT_ID]);
      expect(org2Result.ok).toBe(false);
      expect(org2Result.guardianIds).toEqual([PARENT_ID_ORG2]);
      expect(org2Result.missingParentIds).toEqual([PARENT_ID_ORG2]);

      const org1Status = await listOrganizationConsentStatus(ORG_ID);
      const org2Status = await listOrganizationConsentStatus(ORG_ID_2);
      expect(org1Status).toHaveLength(1);
      expect(org1Status[0].consent.ok).toBe(true);
      expect(org2Status).toHaveLength(1);
      expect(org2Status[0].athleteId).toBe(ATHLETE_ID);
      expect(org2Status[0].consent.ok).toBe(false);
    } finally {
      activeClient = null;
      await client.end();
    }
  });
});
