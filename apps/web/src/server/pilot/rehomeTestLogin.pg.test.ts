// Real PostgreSQL proof for the one-off re-home of a test-organization login
// (scripts/rehome-test-login-sql.cjs; Jason 2026-10-05, option "B": move the
// login out of the test organization `danielles` and into `punxsy_prominence`
// as a parent).
//
// WHAT IT PROVES
//
//   1. Dry run changes nothing: every pilot table hashes the same before and
//      after, and the parent screen still refuses the login.
//   2. Apply produces the intended state: one punxsy_prominence parent login
//      on magic link with its PIN, password and athlete link cleared; its only
//      membership a punxsy_prominence parent row; no live session, magic link
//      or activation token; danielles' seat, labeller PIN, profile and
//      rate-limit rows gone; history rows untouched; one audit row.
//   3. assertGuardianLoginProvisionable then accepts the login for
//      punxsy_prominence, and createOrUpdateMicrosoftStaffAccount -- the parent
//      screen's write -- links it to a punxsy_prominence athlete.
//   4. Every refusal writes nothing: a danielles athlete, an unhandled row
//      (named in the report), a second login sharing the address in another
//      casing, a second membership, a switched-off login, a profile photo, and
//      a re-run after apply.
//   5. A failure inside the transaction leaves nothing: an injected error on
//      the audit insert rolls the whole move back.
//   6. The report never carries the email or the account id.
//
// Builds the full schema in deploy order (scripts/lib/full-schema.mjs), so the
// catalog scan sees every account column production has. Spins up the same
// disposable, local-only embedded Postgres the other .pg suites use. It NEVER
// connects to production or staging.

import { type ChildProcessByStdio, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import type { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';

import { Client } from 'pg';

jest.setTimeout(240_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const PG_DATABASE = 'ppbf_test_rehome_test_login';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-rehome-test-login-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const FULL_SCHEMA_HELPER_PATH = path.resolve(__dirname, '../../../scripts/lib/full-schema.mjs');
const REHOME_MODULE_PATH = path.resolve(__dirname, '../../../scripts/rehome-test-login-sql.cjs');

const FROM_ORG = 'danielles';
const TO_ORG = 'punxsy_prominence';
const TARGET = 'test.parent@example.test';
const EMAIL_AS_TYPED = '  Test.Parent@Example.TEST ';
const OTHER_DANIELLES = 'acct-rtl-danielles-inactive';
const PUNXSY_ADMIN = 'acct-rtl-punxsy-admin';
const PUNXSY_COACH = 'acct-rtl-punxsy-coach';
const ATHLETE = 'ath-rtl-1';

// ts-jest downlevels a plain dynamic import into require(), which cannot load
// an ESM-only .mjs file. Hiding the call inside `new Function` keeps a real
// dynamic import in the emitted code. Same trick the other .pg suites use.
const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

interface Check { name: string; ok: boolean }
interface Report {
  mode: string;
  database: string | null;
  preconditions: Check[];
  flags: Record<string, boolean>;
  columns: Array<{ column: string; rows: number; disposition: string }>;
  blocking: Array<{ column: string; rows: number; disposition: string }>;
  statements: Record<string, number>;
  postconditions: Check[];
  status: string;
  outcome: string;
  error: string | null;
}
type Rehome = (client: Client, options: { email: string; apply?: boolean }) => Promise<Report>;

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let client: Client;
let rehome: Rehome;
let auditAction: string;
type StaffModule = typeof import('./staffProvisioning');
let staff: StaffModule;
let closePool: () => Promise<void>;

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

async function addLogin(accountId: string, role: string, organizationId: string, active = true) {
  await client.query(
    `insert into pilot.accounts (account_id, login_email, role, organization_id, auth_provider, active_flag)
     values ($1, $1, $2, $3, 'microsoft', $4)`,
    [accountId, role, organizationId, active],
  );
  await client.query(
    `insert into pilot.organization_memberships (account_id, organization_id, role, active_flag)
     values ($1, $2, $3, $4)`,
    [accountId, organizationId, role, active],
  );
}

// Every pilot base table, hashed row by row. Equal before and after means the
// run left the database exactly as it found it.
async function snapshot(): Promise<Record<string, string>> {
  const tables = await client.query<{ table_name: string }>(
    `select table_name from information_schema.tables
      where table_schema = 'pilot' and table_type = 'BASE TABLE' order by 1`,
  );
  const out: Record<string, string> = {};
  for (const { table_name: table } of tables.rows) {
    const result = await client.query<{ h: string | null }>(
      `select md5(coalesce(string_agg(t::text, '|' order by t::text), '')) as h from pilot."${table}" t`,
    );
    out[table] = result.rows[0].h ?? '';
  }
  return out;
}

async function accountRow() {
  const result = await client.query(
    `select organization_id, role, auth_provider, active_flag, pin_hash, password_hash, password_set_at,
            athlete_id, must_change_pin, has_master_shadow_access, deleted_at
       from pilot.accounts where account_id = $1`,
    [TARGET],
  );
  return result.rows[0];
}

function expectNoIdentifiers(report: Report) {
  const text = JSON.stringify(report).toLowerCase();
  expect(text).not.toContain(TARGET);
  expect(text).not.toContain('example.test');
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

  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  await admin.query(`drop database if exists ${PG_DATABASE}`);
  await admin.query(`create database ${PG_DATABASE}`);
  await admin.end();

  client = new Client({ connectionString: connectionStringFor(PG_DATABASE) });
  await client.connect();
  const fullSchema = await nativeDynamicImport(pathToFileURL(FULL_SCHEMA_HELPER_PATH).href);
  const applyFullSchema = fullSchema.applyFullSchema as (c: Client, o?: { infraDir?: string }) => Promise<unknown>;
  await applyFullSchema(client, { infraDir: INFRA_DIR });

  const rehomeModule = await nativeDynamicImport(pathToFileURL(REHOME_MODULE_PATH).href);
  const exported = (rehomeModule.default ?? rehomeModule) as { rehomeTestLogin: Rehome; AUDIT_ACTION: string };
  rehome = exported.rehomeTestLogin;
  auditAction = exported.AUDIT_ACTION;

  // Env before import: db.ts reads the connection string when its pool is
  // first built, so the dynamic imports have to come after this.
  process.env.AZURE_POSTGRES_CONNECTION_STRING = connectionStringFor(PG_DATABASE);
  process.env.PPBF_POSTGRES_DISABLE_SSL = 'true';
  staff = await import('./staffProvisioning');
  ({ closePool } = await import('./db'));
});

afterAll(async () => {
  await closePool?.();
  await client?.end();
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
  await fs.rm(DATA_DIR, { recursive: true, force: true }).catch(() => {});
});

beforeEach(async () => {
  await client.query('drop trigger if exists rtl_fail_audit on pilot.audit_events');
  await client.query(
    `truncate pilot.organizations, pilot.accounts, pilot.audit_events, pilot.labeller_credentials,
              pilot.shadow_rate_limit_buckets, pilot.account_profiles cascade`,
  );
  for (const org of [FROM_ORG, TO_ORG]) {
    await client.query(
      `insert into pilot.organizations (organization_id, organization_name, status) values ($1, $1, 'active')`,
      [org],
    );
  }

  // The test-org admin login, as production holds it, with one of each thing
  // that keys on it.
  await addLogin(TARGET, 'organization_admin', FROM_ORG);
  await client.query(
    `update pilot.accounts set password_hash = 'scrypt$x', password_set_at = now(), pin_hash = 'scrypt$y'
      where account_id = $1`,
    [TARGET],
  );
  await client.query(
    `insert into pilot.session_tokens (token_hash, account_id, organization_id, expires_at, revoked_at)
     values ('st-live', $1, $2, now() + interval '1 day', null),
            ('st-old', $1, $2, now() + interval '1 day', now() - interval '1 hour')`,
    [TARGET, FROM_ORG],
  );
  await client.query(
    `insert into pilot.magic_link_tokens (token_hash, account_id, organization_id, sent_to_email, expires_at)
     values ('ml-live', $1, $2, $1, now() + interval '15 minutes')`,
    [TARGET, FROM_ORG],
  );
  await client.query(
    `insert into pilot.account_activation_tokens
       (token_hash, account_id, organization_id, issued_by_account_id, issued_by_role, expires_at)
     values ('act-live', $1, $2, 'someone-else', 'platform_owner', now() + interval '1 day')`,
    [TARGET, FROM_ORG],
  );
  await client.query(
    `insert into pilot.board_seats (organization_id, seat, account_id) values ($1, 'at-large', $2)`,
    [FROM_ORG, TARGET],
  );
  await client.query(
    `insert into pilot.labeller_credentials (organization_id, account_id, display_name, pin_hash)
     values ($1, $2, 'Tester', 'scrypt$z')`,
    [FROM_ORG, TARGET],
  );
  await client.query(
    `insert into pilot.account_profiles (organization_id, account_id) values ($1, $2)`,
    [FROM_ORG, TARGET],
  );
  await client.query(
    `insert into pilot.shadow_rate_limit_buckets (organization_id, account_id, endpoint_key, window_started_at, window_seconds)
     values ($1, $2, 'chat', now(), 60)`,
    [FROM_ORG, TARGET],
  );
  await client.query(
    `insert into pilot.audit_events (event_type, actor_account_id, actor_role, organization_id, entity_type, entity_id)
     values ('login', $1, 'organization_admin', $2, 'account', $1)`,
    [TARGET, FROM_ORG],
  );

  // danielles' other data: a switched-off login with its own old session.
  await addLogin(OTHER_DANIELLES, 'coach', FROM_ORG, false);
  await client.query(
    `insert into pilot.session_tokens (token_hash, account_id, organization_id, expires_at)
     values ('st-other', $1, $2, now() + interval '1 day')`,
    [OTHER_DANIELLES, FROM_ORG],
  );

  // The gym the login moves to, with the athlete it will guard.
  await addLogin(PUNXSY_ADMIN, 'organization_admin', TO_ORG);
  await addLogin(PUNXSY_COACH, 'coach', TO_ORG);
  await client.query(
    `insert into pilot.athletes
     (organization_id, athlete_id, full_name, dob, weight_class, gym_status, emergency_contact,
      active_flag, coach_id, created_at, updated_at)
     values ($1, $2, $2, '2014-01-01', '80', 'active', 'n/a', true, $3, now(), now())`,
    [TO_ORG, ATHLETE, PUNXSY_COACH],
  );
});

const ANOTHER_ORG_REFUSAL = 'Forbidden: account already exists in another organization';

function provisionable() {
  return staff.assertGuardianLoginProvisionable({
    loginEmail: EMAIL_AS_TYPED,
    organizationId: TO_ORG,
    accountIdHint: TARGET,
  });
}

describe('rehomeTestLogin', () => {
  test('the parent screen refuses the login before the move', async () => {
    await expect(provisionable()).rejects.toThrow(ANOTHER_ORG_REFUSAL);
  });

  test('dry run runs every statement, reports PASS, and changes nothing', async () => {
    const before = await snapshot();
    const report = await rehome(client, { email: EMAIL_AS_TYPED });

    expect(report.error).toBeNull();
    expect(report.preconditions.filter((c) => !c.ok)).toEqual([]);
    expect(report.blocking).toEqual([]);
    expect(report.postconditions.filter((c) => !c.ok)).toEqual([]);
    expect(report).toMatchObject({ mode: 'dry_run', status: 'PASS', outcome: 'rolled_back', database: PG_DATABASE });
    expect(report.flags).toEqual({ account_id_is_lowercase_email: true });
    expect(report.statements).toEqual({
      session_tokens_revoked: 1,
      magic_link_tokens_invalidated: 1,
      activation_tokens_superseded: 1,
      rate_limit_buckets_deleted: 1,
      labeller_credentials_deleted: 1,
      board_seats_deleted: 1,
      account_profiles_deleted: 1,
      danielles_memberships_deleted: 1,
      accounts_moved: 1,
      punxsy_memberships_inserted: 1,
      audit_events_written: 1,
    });
    // The scan found the catalog, not a short list.
    expect(report.columns.length).toBeGreaterThan(150);
    expect(report.columns).toContainEqual({ column: 'audit_events.actor_account_id', rows: 1, disposition: 'history' });
    expectNoIdentifiers(report);

    expect(await snapshot()).toEqual(before);
    await expect(provisionable()).rejects.toThrow(ANOTHER_ORG_REFUSAL);
  });

  test('apply moves the login, closes every way in, and the parent screen then accepts it', async () => {
    const otherBefore = await client.query(
      `select a.*, (select revoked_at from pilot.session_tokens where token_hash = 'st-other') as other_session
         from pilot.accounts a where account_id = $1`,
      [OTHER_DANIELLES],
    );
    const orgBefore = await client.query(`select * from pilot.organizations where organization_id = $1`, [FROM_ORG]);

    const report = await rehome(client, { email: EMAIL_AS_TYPED, apply: true });
    expect(report.error).toBeNull();
    expect(report).toMatchObject({ mode: 'apply', status: 'PASS', outcome: 'committed' });
    expectNoIdentifiers(report);

    expect(await accountRow()).toMatchObject({
      organization_id: TO_ORG,
      role: 'parent',
      auth_provider: 'magic_link',
      active_flag: true,
      pin_hash: null,
      password_hash: null,
      password_set_at: null,
      athlete_id: null,
      must_change_pin: false,
      has_master_shadow_access: false,
      deleted_at: null,
    });
    const memberships = await client.query(
      'select organization_id, role, active_flag from pilot.organization_memberships where account_id = $1',
      [TARGET],
    );
    expect(memberships.rows).toEqual([{ organization_id: TO_ORG, role: 'parent', active_flag: true }]);

    const live = await client.query(
      `select
         (select count(*) from pilot.session_tokens where account_id = $1 and revoked_at is null)::int as sessions,
         (select count(*) from pilot.magic_link_tokens
           where account_id = $1 and consumed_at is null and invalidated_at is null)::int as magic,
         (select count(*) from pilot.account_activation_tokens
           where account_id = $1 and consumed_at is null and superseded_at is null)::int as activation,
         (select count(*) from pilot.session_tokens where account_id = $1)::int as session_rows,
         (select count(*) from pilot.board_seats where account_id = $1)::int as seats,
         (select count(*) from pilot.labeller_credentials where account_id = $1)::int as labeller,
         (select count(*) from pilot.account_profiles where account_id = $1)::int as profiles,
         (select count(*) from pilot.shadow_rate_limit_buckets where account_id = $1)::int as buckets`,
      [TARGET],
    );
    // Revoked rows stay as history; nothing live survives.
    expect(live.rows[0]).toEqual({
      sessions: 0, magic: 0, activation: 0, session_rows: 2, seats: 0, labeller: 0, profiles: 0, buckets: 0,
    });

    // History left exactly as it was, plus the one new audit row.
    const audits = await client.query(
      `select event_type, actor_account_id, organization_id, entity_type, entity_id, details->>'action' as action
         from pilot.audit_events order by audit_id`,
    );
    expect(audits.rows).toEqual([
      { event_type: 'login', actor_account_id: TARGET, organization_id: FROM_ORG, entity_type: 'account', entity_id: TARGET, action: null },
      { event_type: 'update', actor_account_id: null, organization_id: TO_ORG, entity_type: 'account', entity_id: TARGET, action: auditAction },
    ]);

    // danielles' other data untouched.
    const otherAfter = await client.query(
      `select a.*, (select revoked_at from pilot.session_tokens where token_hash = 'st-other') as other_session
         from pilot.accounts a where account_id = $1`,
      [OTHER_DANIELLES],
    );
    expect(otherAfter.rows).toEqual(otherBefore.rows);
    expect((await client.query(`select * from pilot.organizations where organization_id = $1`, [FROM_ORG])).rows)
      .toEqual(orgBefore.rows);

    // The parent screen: its pre-check now accepts the login, and its write
    // links it to the punxsy_prominence athlete.
    await expect(provisionable()).resolves.toBeUndefined();
    await staff.createOrUpdateMicrosoftStaffAccount({
      loginEmail: EMAIL_AS_TYPED,
      organizationId: TO_ORG,
      role: 'parent',
      accountIdHint: TARGET,
      guardian: { athleteId: ATHLETE, fullName: 'Guardian One', relationshipToAthlete: 'parent' },
      refuseRoleChange: true,
      refuseDeactivatedLogin: true,
    });
    const linked = await client.query(
      `select gl.organization_id, gl.athlete_id from pilot.guardian_links gl
         join pilot.parents p on p.organization_id = gl.organization_id and p.parent_id = gl.parent_id
        where p.account_id = $1`,
      [TARGET],
    );
    expect(linked.rows).toEqual([{ organization_id: TO_ORG, athlete_id: ATHLETE }]);
  });

  test('a second run after apply is refused and changes nothing', async () => {
    await rehome(client, { email: EMAIL_AS_TYPED, apply: true });
    const before = await snapshot();
    const report = await rehome(client, { email: EMAIL_AS_TYPED, apply: true });
    expect(report).toMatchObject({ status: 'REFUSED', outcome: 'rolled_back' });
    expect(report.preconditions).toContainEqual({ name: 'organization_is_danielles', ok: false });
    expect(await snapshot()).toEqual(before);
  });

  const refusals: Array<[string, () => Promise<void>, string]> = [
    [
      'danielles holds an athlete',
      async () => {
        await client.query(
          `insert into pilot.athletes
           (organization_id, athlete_id, full_name, dob, weight_class, gym_status, emergency_contact,
            active_flag, coach_id, created_at, updated_at)
           values ($1, 'ath-rtl-d', 'x', '2014-01-01', '80', 'active', 'n/a', false, $2, now(), now())`,
          [FROM_ORG, OTHER_DANIELLES],
        );
      },
      'danielles_has_no_athletes',
    ],
    [
      'an unhandled table holds a row for the login',
      async () => {
        await client.query(
          `insert into pilot.parents (organization_id, parent_id, account_id, full_name)
           values ($1, 'par-rtl', $2, 'x')`,
          [TO_ORG, TARGET],
        );
      },
      'no_unhandled_table_has_rows',
    ],
    [
      'a second login shares the address in another casing',
      async () => {
        await client.query(
          `insert into pilot.accounts (account_id, login_email, role, organization_id, auth_provider)
           values ('Test.Parent@example.test', 'other@example.test', 'parent', $1, 'magic_link')`,
          [TO_ORG],
        );
      },
      'exactly_one_account_matches',
    ],
    [
      'the login holds a second membership',
      async () => {
        await client.query(
          `insert into pilot.organization_memberships (account_id, organization_id, role, active_flag)
           values ($1, $2, 'parent', false)`,
          [TARGET, TO_ORG],
        );
      },
      'only_membership_is_danielles_organization_admin',
    ],
    [
      'an admin switched the login off',
      async () => {
        await client.query('update pilot.accounts set active_flag = false where account_id = $1', [TARGET]);
      },
      'active',
    ],
    [
      'the profile holds a photo',
      async () => {
        await client.query(
          `update pilot.account_profiles set photo_blob_path = 'p/x.jpg' where account_id = $1`,
          [TARGET],
        );
      },
      'account_profile_has_no_photo',
    ],
  ];

  test.each(refusals)('refuses and writes nothing when %s', async (_label, arrange, failing) => {
    await arrange();
    const before = await snapshot();
    const report = await rehome(client, { email: EMAIL_AS_TYPED, apply: true });
    expect(report).toMatchObject({ status: 'REFUSED', outcome: 'rolled_back' });
    expect(report.preconditions).toContainEqual({ name: failing, ok: false });
    expect(report.statements).toEqual({});
    expectNoIdentifiers(report);
    expect(await snapshot()).toEqual(before);
  });

  test('the unhandled row is named in the report', async () => {
    await client.query(
      `insert into pilot.parents (organization_id, parent_id, account_id, full_name)
       values ($1, 'par-rtl', $2, 'x')`,
      [TO_ORG, TARGET],
    );
    const report = await rehome(client, { email: EMAIL_AS_TYPED });
    expect(report.blocking).toEqual([{ column: 'parents.account_id', rows: 1, disposition: 'unhandled' }]);
  });

  test('a failure inside the transaction leaves nothing behind', async () => {
    await client.query(`
      create or replace function pilot.rtl_fail_audit() returns trigger as $$
      begin raise exception 'injected audit failure'; end $$ language plpgsql`);
    await client.query(
      `create trigger rtl_fail_audit before insert on pilot.audit_events
       for each row execute function pilot.rtl_fail_audit()`,
    );
    const before = await snapshot();
    const report = await rehome(client, { email: EMAIL_AS_TYPED, apply: true });
    expect(report).toMatchObject({ status: 'FAIL', outcome: 'rolled_back' });
    expect(report.error).toContain('injected audit failure');
    expect(await snapshot()).toEqual(before);
    await expect(provisionable()).rejects.toThrow(ANOTHER_ORG_REFUSAL);
  });

  test('no email writes nothing and opens no transaction', async () => {
    const before = await snapshot();
    const report = await rehome(client, { email: '   ', apply: true });
    expect(report).toMatchObject({ status: 'FAIL', outcome: 'rolled_back', error: 'no email given' });
    expect(await snapshot()).toEqual(before);
  });
});
