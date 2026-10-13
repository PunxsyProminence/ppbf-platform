// Real PostgreSQL-backed contract test for getOrganizationWaiverStatus (#151).
//
// Round 9 adversarial review flagged this function's "latest waiver per
// type" logic (DISTINCT ON (waiver_type) ... ORDER BY waiver_type,
// created_at desc) as having zero real-database coverage -- every existing
// unit test mocks query() with fixtures that are already reduced to one row
// per type, so the ORDER BY direction (newest vs. oldest) and the org/
// athlete correlation inside the LATERAL join were never actually run.
// pilot.waivers is append-only, so picking the wrong row here would show a
// withdrawn waiver as still signed to an admin auditing compliance.
//
// Spins up the same disposable, local-only embedded Postgres the other
// migration/contract suites use. It NEVER connects to production or staging.

import { type ChildProcessByStdio, spawn } from 'node:child_process';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import type { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';

import { pathToFileURL } from 'node:url';

import { Client } from 'pg';

/* ts-jest compiles a plain `await import()` down to require(), which cannot
   load an ES module here. Building it through Function keeps a real dynamic
   import in the emitted code, honored under --experimental-vm-modules. */
const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

const FULL_SCHEMA_HELPER_PATH = path.resolve(__dirname, '../../../scripts/lib/full-schema.mjs');

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

import { getOrganizationClearedTonight } from './clearedTonight';
import { findContactEventBlockingHold, findRegistrationBlockingHold } from './trainingHolds';
import { getAthleteWaiverStatus, getOrganizationWaiverStatus } from './waiverCompliance';
import { upsertWaiver } from './intake';

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-waiver-compliance-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');

const ORG_A = 'org-waiver-compliance-a';
const ORG_B = 'org-waiver-compliance-b';
const COACH_ID = 'acct-waiver-compliance-coach';
const ATHLETE_ID = 'ATH-WAIVER-COMPLIANCE-1';

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let applyFullSchema: (client: Client, opts?: { infraDir?: string }) => Promise<unknown>;

function connectionStringFor(database: string): string {
  return `postgres://${PG_USER}:${PG_PASSWORD}@localhost:${PG_PORT}/${database}`;
}

async function freshDatabase(name: string): Promise<Client> {
  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  await admin.query(`drop database if exists ${name}`);
  await admin.query(`create database ${name}`);
  await admin.end();

  const client = new Client({ connectionString: connectionStringFor(name) });
  await client.connect();
  /* THE WHOLE SCHEMA, not the base file alone. This suite drives feature
     code, so it has no business deciding which migrations exist -- and the
     column it was missing (athletes.deleted_at) belongs to a migration it
     never picked. See scripts/lib/full-schema.mjs. */
  await applyFullSchema(client, { infraDir: INFRA_DIR });
  for (const organizationId of [ORG_A, ORG_B]) {
    await client.query(
      `insert into pilot.organizations (organization_id, organization_name, status)
       values ($1, $1, 'active') on conflict do nothing`,
      [organizationId],
    );
  }
  await client.query(
    `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
     values ($1, 'coach', $2, 'microsoft') on conflict do nothing`,
    [COACH_ID, ORG_A],
  );
  return client;
}

async function insertAthlete(client: Client, organizationId: string, athleteId: string, fullName: string, activeFlag = true): Promise<void> {
  await client.query(
    `insert into pilot.athletes (organization_id, athlete_id, full_name, dob, weight_class, gym_status, emergency_contact, active_flag, coach_id, created_at, updated_at)
     values ($1, $2, $3, '2011-05-06', 'fly', 'active', 'contact', $4, $5, now(), now())`,
    [organizationId, athleteId, fullName, activeFlag, COACH_ID],
  );
}

async function insertWaiver(
  client: Client,
  params: { organizationId: string; athleteId: string; waiverType: string; status: string; signedAt: string; createdAt: string },
): Promise<void> {
  await client.query(
    `insert into pilot.waivers (
       organization_id, waiver_id, athlete_id, waiver_type, signed_by_name, signed_by_role,
       signed_at, consent_version, status, created_at, updated_at
     ) values ($1, $2, $3, $4, 'Parent Name', 'parent', $5, 'v1', $6, $7, $7)`,
    [params.organizationId, randomUUID(), params.athleteId, params.waiverType, params.signedAt, params.status, params.createdAt],
  );
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

  const fullSchema = await nativeDynamicImport(pathToFileURL(FULL_SCHEMA_HELPER_PATH).href);
  applyFullSchema = fullSchema.applyFullSchema as typeof applyFullSchema;
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

describe('getOrganizationWaiverStatus against real Postgres', () => {
  afterEach(() => {
    activeClient = null;
  });

  test('picks the newest waiver per type, not an arbitrary one', async () => {
    const client = await freshDatabase('ppbf_test_waiver_compliance_latest');
    activeClient = client;
    try {
      await insertAthlete(client, ORG_A, ATHLETE_ID, 'Compliance Athlete');
      // Inserted out of chronological order on purpose -- if the ORDER BY
      // were missing, reversed, or keyed on the wrong column, insertion
      // order (not created_at) would silently determine which row "wins."
      // A withdrawn waiver is the append-only record of a decision that
      // supersedes an earlier signed one; picking the older row would show
      // a parent's withdrawal as if it never happened.
      //
      // travel, not photo_media: photo_media is no longer read from these
      // rows at all (see MEDIA_CONSENT_TRACKED_TYPE and the case below).
      await insertWaiver(client, {
        organizationId: ORG_A,
        athleteId: ATHLETE_ID,
        waiverType: 'travel',
        status: 'withdrawn',
        signedAt: '2026-08-05T00:00:00Z',
        createdAt: '2026-08-05T00:00:00Z',
      });
      await insertWaiver(client, {
        organizationId: ORG_A,
        athleteId: ATHLETE_ID,
        waiverType: 'travel',
        status: 'signed',
        signedAt: '2026-08-01T00:00:00Z',
        createdAt: '2026-08-01T00:00:00Z',
      });

      const statuses = await getOrganizationWaiverStatus(ORG_A);
      expect(statuses).toHaveLength(1);
      expect(statuses[0].waivers.travel).toBe('withdrawn');
    } finally {
      activeClient = null;
      await client.end();
    }
  });

  /* THE REGISTER ROW THAT USED TO READ AS SIGNED (OD-2026-10-07-009). A
     photo_media row with no parent_id -- what /admin/consent filed before the
     type left its dropdown -- is not consent to any media gate, and this
     rollup now agrees: with no guardian linked it is missing, and with a
     guardian linked it is that guardian's own answer that counts. The full
     paper-only flow is paperOnlyGuardian.pg.test.ts. */
  test('photo_media ignores a register row with no guardian and reads the linked guardian instead', async () => {
    const client = await freshDatabase('ppbf_test_waiver_compliance_media');
    activeClient = client;
    try {
      await insertAthlete(client, ORG_A, ATHLETE_ID, 'Compliance Athlete');
      await insertWaiver(client, {
        organizationId: ORG_A,
        athleteId: ATHLETE_ID,
        waiverType: 'photo_media',
        status: 'signed',
        signedAt: '2026-08-01T00:00:00Z',
        createdAt: '2026-08-01T00:00:00Z',
      });

      expect((await getOrganizationWaiverStatus(ORG_A))[0].waivers.photo_media).toBe('missing');

      await client.query(
        `insert into pilot.parents (organization_id, parent_id, full_name) values ($1, 'par-paper-1', 'Lee Paper')`,
        [ORG_A],
      );
      await client.query(
        `insert into pilot.guardian_links (organization_id, parent_id, athlete_id, relationship_to_athlete)
         values ($1, 'par-paper-1', $2, 'mother')`,
        [ORG_A, ATHLETE_ID],
      );
      // Still missing: the register row names no guardian, and the one
      // guardian on file has not answered.
      expect((await getOrganizationWaiverStatus(ORG_A))[0].waivers.photo_media).toBe('missing');

      await client.query(
        `insert into pilot.waivers (organization_id, waiver_id, athlete_id, parent_id, waiver_type, signed_by_name,
           signed_by_role, signed_at, consent_version, status, covers_video, created_at, updated_at)
         values ($1, $2, $3, 'par-paper-1', 'photo_media', 'Lee Paper', 'parent', now(), 'v1', 'withdrawn', false, now(), now())`,
        [ORG_A, randomUUID(), ATHLETE_ID],
      );
      expect((await getOrganizationWaiverStatus(ORG_A))[0].waivers.photo_media).toBe('withdrawn');

      await client.query(
        `insert into pilot.waivers (organization_id, waiver_id, athlete_id, parent_id, waiver_type, signed_by_name,
           signed_by_role, signed_at, consent_version, status, covers_video, created_at, updated_at)
         values ($1, $2, $3, 'par-paper-1', 'photo_media', 'Lee Paper', 'parent', now(), 'v1', 'signed', true,
                 now() + interval '1 second', now() + interval '1 second')`,
        [ORG_A, randomUUID(), ATHLETE_ID],
      );
      expect((await getOrganizationWaiverStatus(ORG_A))[0].waivers.photo_media).toBe('signed');
    } finally {
      activeClient = null;
      await client.end();
    }
  });

  test('an athlete with zero waivers reads as missing across every tracked type, not fabricated as signed', async () => {
    const client = await freshDatabase('ppbf_test_waiver_compliance_missing');
    activeClient = client;
    try {
      await insertAthlete(client, ORG_A, ATHLETE_ID, 'No Waivers Yet');

      const statuses = await getOrganizationWaiverStatus(ORG_A);
      expect(statuses).toHaveLength(1);
      expect(statuses[0].waivers).toEqual({
        general: 'missing',
        medical_release: 'missing',
        photo_media: 'missing',
        travel: 'missing',
      });
    } finally {
      activeClient = null;
      await client.end();
    }
  });

  test('an untracked waiver_type (e.g. a legacy value) never surfaces as one of the four tracked columns', async () => {
    const client = await freshDatabase('ppbf_test_waiver_compliance_untracked_type');
    activeClient = client;
    try {
      await insertAthlete(client, ORG_A, ATHLETE_ID, 'Legacy Waiver Athlete');
      await insertWaiver(client, {
        organizationId: ORG_A,
        athleteId: ATHLETE_ID,
        waiverType: 'liability_legacy',
        status: 'signed',
        signedAt: '2026-08-01T00:00:00Z',
        createdAt: '2026-08-01T00:00:00Z',
      });

      const statuses = await getOrganizationWaiverStatus(ORG_A);
      expect(statuses[0].waivers).toEqual({
        general: 'missing',
        medical_release: 'missing',
        photo_media: 'missing',
        travel: 'missing',
      });
    } finally {
      activeClient = null;
      await client.end();
    }
  });

  test('a waiver on a different athlete never leaks into this one\'s status', async () => {
    const client = await freshDatabase('ppbf_test_waiver_compliance_athlete_scope');
    activeClient = client;
    try {
      await insertAthlete(client, ORG_A, ATHLETE_ID, 'Athlete One');
      await insertAthlete(client, ORG_A, 'ATH-WAIVER-COMPLIANCE-OTHER', 'Athlete Two');
      await insertWaiver(client, {
        organizationId: ORG_A,
        athleteId: 'ATH-WAIVER-COMPLIANCE-OTHER',
        waiverType: 'general',
        status: 'signed',
        signedAt: '2026-08-01T00:00:00Z',
        createdAt: '2026-08-01T00:00:00Z',
      });

      const statuses = await getOrganizationWaiverStatus(ORG_A);
      const athleteOne = statuses.find((row) => row.athleteId === ATHLETE_ID);
      expect(athleteOne?.waivers.general).toBe('missing');
    } finally {
      activeClient = null;
      await client.end();
    }
  });

  test('a waiver in a different organization never leaks into this one\'s status', async () => {
    const client = await freshDatabase('ppbf_test_waiver_compliance_org_scope');
    activeClient = client;
    try {
      await insertAthlete(client, ORG_A, ATHLETE_ID, 'Org A Athlete');
      await insertAthlete(client, ORG_B, ATHLETE_ID, 'Org B Athlete');
      await insertWaiver(client, {
        organizationId: ORG_B,
        athleteId: ATHLETE_ID,
        waiverType: 'general',
        status: 'signed',
        signedAt: '2026-08-01T00:00:00Z',
        createdAt: '2026-08-01T00:00:00Z',
      });

      const statuses = await getOrganizationWaiverStatus(ORG_A);
      expect(statuses).toHaveLength(1);
      expect(statuses[0].waivers.general).toBe('missing');
    } finally {
      activeClient = null;
      await client.end();
    }
  });

  test('activeFlag passes through from pilot.athletes, real value not a default', async () => {
    const client = await freshDatabase('ppbf_test_waiver_compliance_active_flag');
    activeClient = client;
    try {
      await insertAthlete(client, ORG_A, ATHLETE_ID, 'Retired Athlete', false);

      const statuses = await getOrganizationWaiverStatus(ORG_A);
      expect(statuses[0].activeFlag).toBe(false);
    } finally {
      activeClient = null;
      await client.end();
    }
  });
});

// LANE N4-01 (OD-2026-10-08-006 A-Q19, "Build one answer"). The unit suite
// mocks every read; this runs the composed read against the real tables, where
// the things a mock cannot show live: which hold row counts as active, which
// medical row is the latest, and whether another gym's rows can reach this one.
async function insertHold(
  client: Client,
  params: { organizationId: string; athleteId: string; scope: string; status?: string; placedAt?: string; expiresAt?: string | null },
): Promise<void> {
  await client.query(
    `insert into pilot.training_holds (
       organization_id, hold_id, athlete_id, scope, reason_category, reason_text, athlete_explanation,
       lift_condition_text, placed_by_account_id, placed_by_role, placed_at, expires_at, status
     ) values ($1, $2, $3, $4, 'medical', 'STAFF-ONLY reason', 'Rest this week.', 'A note from your doctor.',
               $5, 'coach', coalesce($6::timestamptz, now()), $7::timestamptz, $8)`,
    [
      params.organizationId,
      randomUUID(),
      params.athleteId,
      params.scope,
      COACH_ID,
      params.placedAt ?? null,
      params.expiresAt ?? null,
      params.status ?? 'active',
    ],
  );
}

async function insertMedical(
  client: Client,
  params: { organizationId: string; athleteId: string; status: string; effectiveAt: string; expiresAt?: string | null },
): Promise<void> {
  await client.query(
    `insert into pilot.shadow_medical_administrative_status (
       organization_id, athlete_id, status, restriction_flags, source_reference, set_by_account_id, set_by_role,
       effective_at, expires_at
     ) values ($1, $2, $3, '{"detail":"STAFF-ONLY flags"}'::jsonb, 'STAFF-ONLY source', $4, 'coach', $5::timestamptz, $6::timestamptz)`,
    [params.organizationId, params.athleteId, params.status, COACH_ID, params.effectiveAt, params.expiresAt ?? null],
  );
}

async function insertViolation(
  client: Client,
  params: { organizationId: string; ruleId: string; athleteId: string; status: string },
): Promise<void> {
  await client.query(
    `insert into pilot.compliance_violations (
       violation_id, organization_id, rule_id, athlete_id, detected_by_account_id, violation_timestamp, severity, status
     ) values ($1, $2, $3, $4, $5, now(), 'high', $6)`,
    [`violation-${randomUUID()}`, params.organizationId, params.ruleId, params.athleteId, COACH_ID, params.status],
  );
}

async function insertRule(client: Client, organizationId: string, ruleId: string, ruleName: string): Promise<void> {
  await client.query(
    `insert into pilot.compliance_rules (rule_id, organization_id, rule_name, rule_category, description, detection_logic)
     values ($1, $2, $3, 'safety', 'description', 'manual')`,
    [ruleId, organizationId, ruleName],
  );
}

describe('cleared tonight against real Postgres', () => {
  afterEach(() => {
    activeClient = null;
  });

  test('one answer per athlete from the real hold, medical, waiver and violation rows of this gym only', async () => {
    const client = await freshDatabase('ppbf_test_cleared_tonight_roster');
    activeClient = client;
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const CLEARED = 'ATH-TONIGHT-1-CLEARED';
      const HELD = 'ATH-TONIGHT-2-HELD';
      const LAPSED = 'ATH-TONIGHT-3-LAPSED-HOLD';
      const RECLEARED = 'ATH-TONIGHT-4-RECLEARED';
      const NO_RECORD = 'ATH-TONIGHT-5-NO-MEDICAL';
      const ADULT = 'ATH-TONIGHT-6-ADULT';
      const RESTRICTED = 'ATH-TONIGHT-7-RESTRICTED';
      const NOT_CLEARED = 'ATH-TONIGHT-8-NOT-CLEARED';
      for (const [athleteId, name] of [
        [CLEARED, 'Avery Cleared'], [HELD, 'Blake Held'], [LAPSED, 'Casey Lapsed'],
        [RECLEARED, 'Devon Recleared'], [NO_RECORD, 'Emery Norecord'], [ADULT, 'Finley Adult'],
        [RESTRICTED, 'Gray Restricted'], [NOT_CLEARED, 'Harper Notcleared'],
      ]) {
        await insertAthlete(client, ORG_A, athleteId, name);
      }
      await client.query(`update pilot.athletes set dob = '2000-01-15' where organization_id = $1 and athlete_id = $2`, [ORG_A, ADULT]);
      // The other gym issues the SAME athlete id, held, with an open violation.
      await insertAthlete(client, ORG_B, CLEARED, 'Other Gym Child');
      await insertHold(client, { organizationId: ORG_B, athleteId: CLEARED, scope: 'all_training' });
      await insertMedical(client, { organizationId: ORG_B, athleteId: CLEARED, status: 'not_cleared', effectiveAt: '2026-10-01T00:00:00Z' });
      await insertRule(client, ORG_B, 'rule-tonight-b', 'Other gym rule');
      await insertViolation(client, { organizationId: ORG_B, ruleId: 'rule-tonight-b', athleteId: CLEARED, status: 'new' });

      for (const athleteId of [CLEARED, HELD, LAPSED, ADULT]) {
        await insertMedical(client, { organizationId: ORG_A, athleteId, status: 'cleared', effectiveAt: '2026-09-01T00:00:00Z' });
      }
      // Two records a person entered, and no hold on either athlete.
      await insertMedical(client, { organizationId: ORG_A, athleteId: RESTRICTED, status: 'restricted', effectiveAt: '2026-09-01T00:00:00Z' });
      await insertMedical(client, { organizationId: ORG_A, athleteId: NOT_CLEARED, status: 'not_cleared', effectiveAt: '2026-09-01T00:00:00Z' });
      // The latest medical row decides, not the first or the strictest.
      await insertMedical(client, { organizationId: ORG_A, athleteId: RECLEARED, status: 'not_cleared', effectiveAt: '2026-08-01T00:00:00Z' });
      await insertMedical(client, { organizationId: ORG_A, athleteId: RECLEARED, status: 'cleared', effectiveAt: '2026-09-15T00:00:00Z' });

      await insertHold(client, { organizationId: ORG_A, athleteId: HELD, scope: 'all_training' });
      // Still stored 'active', but its clock ran out yesterday.
      await insertHold(client, {
        organizationId: ORG_A, athleteId: LAPSED, scope: 'contact_only',
        placedAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
        expiresAt: new Date(Date.now() - 86_400_000).toISOString(),
      });
      // A hold somebody lifted is history.
      await insertHold(client, { organizationId: ORG_A, athleteId: RECLEARED, scope: 'all_training', status: 'lifted' });

      await insertWaiver(client, {
        organizationId: ORG_A, athleteId: CLEARED, waiverType: 'general', status: 'signed',
        signedAt: '2026-09-02T12:00:00Z', createdAt: '2026-09-02T15:00:00Z',
      });
      await insertRule(client, ORG_A, 'rule-tonight-a', 'Headgear worn');
      for (const status of ['new', 'escalated', 'dismissed', 'resolved']) {
        await insertViolation(client, { organizationId: ORG_A, ruleId: 'rule-tonight-a', athleteId: CLEARED, status });
      }

      const rows = await getOrganizationClearedTonight(ORG_A);
      const byId = new Map(rows.map((row) => [row.athleteId, row]));

      expect(rows).toHaveLength(8);
      expect(Object.fromEntries(rows.map((row) => [row.athleteId, row.tonight.answer]))).toEqual({
        [CLEARED]: 'cleared',
        [HELD]: 'not_cleared',
        [LAPSED]: 'cleared',
        [RECLEARED]: 'cleared',
        [NO_RECORD]: 'cleared_to_train',
        [ADULT]: 'cleared',
        [RESTRICTED]: 'cleared_no_contact',
        // A not_cleared record with no hold never reads cleared.
        [NOT_CLEARED]: 'not_cleared',
      });

      const cleared = byId.get(CLEARED)!;
      expect(cleared.tonight.hold).toBeNull();
      expect(cleared.tonight.medical).toEqual({ status: 'cleared', current: true, expires_at: null });
      expect(cleared.tonight.waivers).toEqual([
        { type: 'general', status: 'signed', recorded_on: '2026-09-02' },
        { type: 'medical_release', status: 'missing', recorded_on: null },
        { type: 'travel', status: 'missing', recorded_on: null },
      ]);
      // Open by compliance.ts's own definition: new and escalated, not the two closed ones.
      expect(cleared.tonight.open_violations).toBe(2);
      // No guardian linked: the existing consent check's "missing".
      expect(cleared.tonight.media_consent).toEqual({ basis: 'guardian', status: 'missing' });

      expect(byId.get(HELD)!.tonight.hold).toEqual({
        scope: 'all_training',
        athlete_explanation: 'Rest this week.',
        lift_condition_text: 'A note from your doctor.',
        expires_at: null,
      });
      expect(byId.get(LAPSED)!.tonight.hold).toBeNull();
      expect(byId.get(RECLEARED)!.tonight.hold).toBeNull();
      expect(byId.get(NO_RECORD)!.tonight.medical).toEqual({ status: 'no_record', current: false, expires_at: null });
      expect(byId.get(NO_RECORD)!.tonight.open_violations).toBe(0);
      expect(byId.get(ADULT)!.tonight.media_consent).toEqual({ basis: 'adult_own_consent' });

      const sent = JSON.stringify(rows);
      expect(sent).not.toContain('STAFF-ONLY');
      expect(sent).not.toContain('Other Gym Child');
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
      activeClient = null;
      await client.end();
    }
  });

  // NOT A SECOND RULE. For every hold scope the answer must say exactly what
  // the two enforcement reads say: the registration stop
  // (findRegistrationBlockingHold) and the contact stop
  // (findContactEventBlockingHold). Medical is cleared throughout, so the
  // hold alone decides here.
  test.each([
    ['all_training', 'not_cleared'],
    ['contact_only', 'cleared_no_contact'],
    ['conditioning_only', 'cleared'],
    [null, 'cleared'],
  ])('a %s hold reads as the enforcement reads say it does', async (scope, expected) => {
    const client = await freshDatabase(`ppbf_test_cleared_tonight_${scope ?? 'no_hold'}`);
    activeClient = client;
    try {
      await insertAthlete(client, ORG_A, ATHLETE_ID, 'Compliance Athlete');
      await insertMedical(client, { organizationId: ORG_A, athleteId: ATHLETE_ID, status: 'cleared', effectiveAt: '2026-09-01T00:00:00Z' });
      if (scope) {
        await insertHold(client, { organizationId: ORG_A, athleteId: ATHLETE_ID, scope });
      }

      const [row] = await getOrganizationClearedTonight(ORG_A);
      const stopsRegistration = (await findRegistrationBlockingHold(ORG_A, ATHLETE_ID)) !== null;
      const stopsContact = (await findContactEventBlockingHold(ORG_A, ATHLETE_ID)) !== null;

      expect(row.tonight.answer).toBe(expected);
      expect(row.tonight.answer === 'not_cleared').toBe(stopsRegistration);
      expect(row.tonight.answer !== 'cleared').toBe(stopsContact);
    } finally {
      activeClient = null;
      await client.end();
    }
  });

  // The medical time bound is the stored row's, read by isClearanceCurrent.
  test('a clearance whose stated expiry has passed is not a clearance tonight', async () => {
    const client = await freshDatabase('ppbf_test_cleared_tonight_expired_medical');
    activeClient = client;
    try {
      await insertAthlete(client, ORG_A, ATHLETE_ID, 'Compliance Athlete');
      await insertMedical(client, {
        organizationId: ORG_A, athleteId: ATHLETE_ID, status: 'cleared',
        effectiveAt: '2026-01-01T00:00:00Z', expiresAt: '2026-02-01T00:00:00Z',
      });

      const [row] = await getOrganizationClearedTonight(ORG_A);

      // The expiry leaves as ISO, read from the real timestamptz column.
      expect(row.tonight.medical).toEqual({ status: 'cleared_expired', current: false, expires_at: '2026-02-01T00:00:00.000Z' });
      expect(row.tonight.answer).toBe('cleared_to_train');
    } finally {
      activeClient = null;
      await client.end();
    }
  });
});

/*
 * THE OFFICE RECORDS, THEN WITHDRAWS, A PAPER WAIVER (Jason 2026-10-12,
 * OD-2026-10-12-009; #1526). Through the production writer
 * /admin/waiver-status posts to: the grid's reader and the parent Safety
 * page's reader both say Signed, then Withdrawn; the signed row stays as
 * history with who recorded it; and the other gym's athlete with the same id
 * never sees either.
 */
describe('a waiver recorded and withdrawn from Waiver Compliance (#1526)', () => {
  afterEach(() => {
    activeClient = null;
  });

  test('both readers follow it, history is kept, and the other gym sees nothing', async () => {
    const client = await freshDatabase('ppbf_test_waiver_office_record');
    activeClient = client;
    try {
      await insertAthlete(client, ORG_A, ATHLETE_ID, 'Org A Athlete');
      await insertAthlete(client, ORG_B, ATHLETE_ID, 'Org B Athlete');
      const record = (status: 'signed' | 'withdrawn') => upsertWaiver({
        organizationId: ORG_A,
        athleteId: ATHLETE_ID,
        waiverType: 'medical_release',
        signedByName: 'Pat T.',
        signedByRole: 'guardian',
        signedAt: '2026-10-01T12:00:00.000Z',
        consentVersion: 'v1',
        status,
        notes: '',
        recordedByAccountId: COACH_ID,
      });

      await record('signed');
      expect((await getOrganizationWaiverStatus(ORG_A))[0].waivers.medical_release).toBe('signed');
      expect(await getAthleteWaiverStatus(ORG_A, ATHLETE_ID, 'medical_release')).toBe('signed');

      await record('withdrawn');
      expect((await getOrganizationWaiverStatus(ORG_A))[0].waivers.medical_release).toBe('withdrawn');
      expect(await getAthleteWaiverStatus(ORG_A, ATHLETE_ID, 'medical_release')).toBe('withdrawn');

      const rows = await client.query(
        `select status, recorded_by_account_id from pilot.waivers
         where organization_id = $1 and athlete_id = $2 and waiver_type = 'medical_release'
         order by created_at`,
        [ORG_A, ATHLETE_ID],
      );
      expect(rows.rows).toEqual([
        { status: 'signed', recorded_by_account_id: COACH_ID },
        { status: 'withdrawn', recorded_by_account_id: COACH_ID },
      ]);

      expect((await getOrganizationWaiverStatus(ORG_B))[0].waivers.medical_release).toBe('missing');
      expect(await getAthleteWaiverStatus(ORG_B, ATHLETE_ID, 'medical_release')).toBe('missing');
    } finally {
      activeClient = null;
      await client.end();
    }
  });
});
