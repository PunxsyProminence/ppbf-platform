// Real PostgreSQL proof that a session carries the role its account holds IN
// THE SESSION'S ORGANIZATION -- the active pilot.organization_memberships row
// for that organization -- and not the account's home role
// (pilot.accounts.role).
//
// THE DEFECT. resolvePrincipal took the organization from the session row
// (coalesce(st.organization_id, a.organization_id)) and the role from
// pilot.accounts, so the two came from different rows. An account that is
// organization_admin at home and coach in gym B was organization_admin in a
// session scoped to gym B, and every caller that branches on principal.role
// (requireRole, assertActorCanAccessAthlete) inherited it.
//
// HOW A NON-HOME SESSION ARISES. Every sign-in stamps the account's home
// organization at the moment it mints. A magic link stamps the organization it
// was ISSUED for, and moving the account to another gym
// (upsertOrganizationMembership) revoked its sessions but not its unused links,
// and left the old gym's membership active. So: a parent at gym A asks for a
// link, the platform owner makes them a coach at gym B, and the link -- still
// inside its fifteen minutes -- minted a session in gym A that resolved as
// coach. The 'magic link after a move' block proves that path end to end.
//
// Spins up the same disposable, local-only embedded Postgres the other .pg
// suites use. It NEVER connects to production or staging.

import { type ChildProcessByStdio, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import type { Readable } from 'node:stream';

import { NextRequest } from 'next/server';
import { Client } from 'pg';

// Routes db.ts into this suite's embedded database. withTransaction runs the
// callback on the SAME client, as the other .pg suites do.
let activeClient: Client | null = null;

jest.mock('./db', () => ({
  query: jest.fn(async (text: string, params: unknown[] = []) => {
    if (!activeClient) throw new Error('test bug: no active embedded client');
    return (await activeClient.query(text, params)).rows;
  }),
  queryOne: jest.fn(async (text: string, params: unknown[] = []) => {
    if (!activeClient) throw new Error('test bug: no active embedded client');
    return (await activeClient.query(text, params)).rows[0] ?? null;
  }),
  withTransaction: jest.fn(async (fn: (client: unknown) => Promise<unknown>) => {
    if (!activeClient) throw new Error('test bug: no active embedded client');
    await activeClient.query('BEGIN');
    try {
      const result = await fn(activeClient);
      await activeClient.query('COMMIT');
      return result;
    } catch (error) {
      await activeClient.query('ROLLBACK');
      throw error;
    }
  }),
  isLoopbackPostgresConnectionString: jest.requireActual('./db').isLoopbackPostgresConnectionString,
}));

import {
  loginWithAccountIdAndPin,
  loginWithMicrosoftEmail,
  resolvePrincipal,
  upsertOrganizationMembership,
} from './auth';
import type { PilotRole } from './contracts';
import { issueMagicLink } from './magicLink';
import { magicLinkDependencies, redeemMagicLink } from './magicLinkStore';
import { loginWithEmailAndPassword } from './parentPasswordSignIn';
import { hashPassword, hashPin, hashToken } from './security';
import { loadCurrentJobActor } from './shadowJobProcessor';

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-session-role-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const TEST_DB_NAME = 'ppbf_test_session_role';
const MIGRATIONS = [
  'pilot_slice_postgres.sql',
  // pilot.board_seats: PIN sign-in and resolvePrincipal ask it about every account.
  'pilot_slice_postgres_board_seats_migration.sql',
  // pilot.magic_link_tokens.
  'pilot_slice_postgres_magic_link_migration.sql',
  // pilot.accounts.deleted_at.
  'pilot_slice_postgres_data_retention_deletion_migration.sql',
  // pilot.accounts.password_hash and session_tokens.sign_in_method.
  'pilot_slice_postgres_parent_password_migration.sql',
];

const HOME_ORG = 'org-srm-home';
const OTHER_ORG = 'org-srm-other';
const PIN = '481902';
const PASSWORD = 'three small boats';

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let client: Client;
let warn: jest.SpyInstance;
const previousAppOrigin = process.env.PPBF_APP_ORIGIN;

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

function connectionStringFor(database: string): string {
  return `postgres://${PG_USER}:${PG_PASSWORD}@localhost:${PG_PORT}/${database}`;
}

function requestWithSession(token: string): NextRequest {
  // 'ppbf_pilot_session' is PILOT_SESSION_COOKIE, hardcoded as the other .pg suites do.
  return new NextRequest('http://localhost/api/pilot/whatever', {
    headers: { cookie: `ppbf_pilot_session=${token}` },
  });
}

/** An account homed in HOME_ORG with `homeRole`, and the home membership `homeMembershipRole`. */
async function seedAccount(input: {
  accountId: string;
  homeRole: PilotRole;
  homeMembershipRole?: PilotRole;
  authProvider: 'ppbf_local' | 'microsoft' | 'magic_link';
  loginEmail?: string;
  pinHash?: string;
  passwordHash?: string;
  athleteId?: string;
}): Promise<void> {
  await client.query(
    `insert into pilot.accounts (account_id, role, organization_id, auth_provider, login_email,
       athlete_id, pin_hash, password_hash, password_set_at, active_flag)
     values ($1, $2, $3, $4, $5, $6, $7, $8, case when $8::text is null then null else now() end, true)`,
    [
      input.accountId,
      input.homeRole,
      HOME_ORG,
      input.authProvider,
      input.loginEmail ?? null,
      input.athleteId ?? null,
      input.pinHash ?? null,
      input.passwordHash ?? null,
    ],
  );
  await addMembership(input.accountId, HOME_ORG, input.homeMembershipRole ?? input.homeRole);
}

async function addMembership(accountId: string, organizationId: string, role: PilotRole): Promise<void> {
  await client.query(
    `insert into pilot.organization_memberships (account_id, organization_id, role, active_flag)
     values ($1, $2, $3, true)`,
    [accountId, organizationId, role],
  );
}

/** A live session scoped to `organizationId`, written as a sign-in path writes one. */
async function seedSession(accountId: string, organizationId: string): Promise<string> {
  const token = `srm-session-${accountId}-${organizationId}`;
  await client.query(
    `insert into pilot.session_tokens (token_hash, account_id, organization_id, expires_at)
     values ($1, $2, $3, now() + interval '1 hour')`,
    [hashToken(token), accountId, organizationId],
  );
  return token;
}

function driftWarnings(): unknown[] {
  return warn.mock.calls
    .filter(([message]) => message === 'pilot-auth session role differs from home role')
    .map(([, detail]) => detail);
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
      reject(new Error(`Embedded Postgres exited early (code ${code}). stderr:\n${stderrOutput}`));
    });
  });

  const adminClient = new Client({ connectionString: connectionStringFor('postgres') });
  await adminClient.connect();
  await adminClient.query(`drop database if exists ${TEST_DB_NAME}`);
  await adminClient.query(`create database ${TEST_DB_NAME}`);
  await adminClient.end();

  client = new Client({ connectionString: connectionStringFor(TEST_DB_NAME) });
  await client.connect();
  for (const file of MIGRATIONS) {
    await client.query(await fs.readFile(path.join(INFRA_DIR, file), 'utf8'));
  }
  for (const organizationId of [HOME_ORG, OTHER_ORG]) {
    await client.query(
      `insert into pilot.organizations (organization_id, organization_name, status)
       values ($1, $1, 'active')`,
      [organizationId],
    );
  }
  activeClient = client;

  // magicLinkDependencies refuses to build a link without an origin.
  process.env.PPBF_APP_ORIGIN = 'https://app.ppbf.test';
});

afterAll(async () => {
  activeClient = null;
  if (previousAppOrigin === undefined) delete process.env.PPBF_APP_ORIGIN;
  else process.env.PPBF_APP_ORIGIN = previousAppOrigin;
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
  // On Windows the killed server can still hold the folder (EBUSY), and
  // test-embedded-pg-server.mjs sweeps leftovers.
  await fs.rm(DATA_DIR, { recursive: true, force: true }).catch(() => {});
});

beforeEach(() => {
  warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  warn.mockRestore();
});

describe('a session scoped to another organization', () => {
  test('organization_admin at home, coach in the other gym: the session there is coach', async () => {
    await seedAccount({
      accountId: 'srm-admin-visiting',
      homeRole: 'organization_admin',
      authProvider: 'microsoft',
      loginEmail: 'admin.visiting@srm.test',
    });
    await addMembership('srm-admin-visiting', OTHER_ORG, 'coach');

    const visiting = await resolvePrincipal(requestWithSession(await seedSession('srm-admin-visiting', OTHER_ORG)));
    expect(visiting).toMatchObject({ organizationId: OTHER_ORG, role: 'coach' });

    // Control: the same account at home is still its home role.
    const home = await resolvePrincipal(requestWithSession(await seedSession('srm-admin-visiting', HOME_ORG)));
    expect(home).toMatchObject({ organizationId: HOME_ORG, role: 'organization_admin' });
    // Not a home session, so not drift: nothing to warn about.
    expect(driftWarnings()).toEqual([]);
  });

  test('coach at home, parent in the other gym: the session there is parent, not coach', async () => {
    await seedAccount({
      accountId: 'srm-coach-visiting',
      homeRole: 'coach',
      authProvider: 'microsoft',
      loginEmail: 'coach.visiting@srm.test',
    });
    await addMembership('srm-coach-visiting', OTHER_ORG, 'parent');

    const visiting = await resolvePrincipal(requestWithSession(await seedSession('srm-coach-visiting', OTHER_ORG)));
    expect(visiting).toMatchObject({ organizationId: OTHER_ORG, role: 'parent' });
  });

  test('a membership switched off in the other gym resolves to nobody there, as before', async () => {
    await seedAccount({
      accountId: 'srm-inactive-visit',
      homeRole: 'coach',
      authProvider: 'microsoft',
      loginEmail: 'inactive.visit@srm.test',
    });
    await addMembership('srm-inactive-visit', OTHER_ORG, 'coach');
    const token = await seedSession('srm-inactive-visit', OTHER_ORG);
    await client.query(
      `update pilot.organization_memberships set active_flag = false
        where account_id = 'srm-inactive-visit' and organization_id = $1`,
      [OTHER_ORG],
    );

    expect(await resolvePrincipal(requestWithSession(token))).toBeNull();
  });
});

describe('a local (PIN) session is judged on both roles', () => {
  test('a PIN account homed as coach, an athlete in the session gym, is still refused and its session revoked', async () => {
    // Reading the role from the membership must not open the PIN door: the
    // home role the credential belongs to is asked as well, as it was before.
    await seedAccount({
      accountId: 'srm-local-coach',
      homeRole: 'coach',
      authProvider: 'ppbf_local',
      pinHash: await hashPin(PIN),
    });
    await addMembership('srm-local-coach', OTHER_ORG, 'athlete');
    const token = await seedSession('srm-local-coach', OTHER_ORG);

    expect(await resolvePrincipal(requestWithSession(token))).toBeNull();
    const revoked = await client.query<{ revoked_at: Date | null }>(
      'select revoked_at from pilot.session_tokens where token_hash = $1',
      [hashToken(token)],
    );
    expect(revoked.rows[0].revoked_at).not.toBeNull();
  });
});

describe('every sign-in path: the session resolves to the membership role', () => {
  test('PIN: an athlete signs in and resolves as athlete', async () => {
    await seedAccount({
      accountId: 'srm-ath-pin',
      homeRole: 'athlete',
      authProvider: 'ppbf_local',
      athleteId: 'ATH-SRM-1',
      pinHash: await hashPin(PIN),
    });

    const login = await loginWithAccountIdAndPin('srm-ath-pin', PIN);
    expect(login?.principal).toMatchObject({ organizationId: HOME_ORG, role: 'athlete' });
    expect(await resolvePrincipal(requestWithSession(login!.token)))
      .toMatchObject({ organizationId: HOME_ORG, role: 'athlete' });
  });

  test('Microsoft: when the home membership says coach and the account row says organization_admin, sign-in and every request say coach', async () => {
    // Drift between the two rows for the HOME organization. No app writer
    // produces it (each writes both), so this is the shape of a hand edit or
    // a half-applied change. The membership row is the organization's grant
    // and wins; the disagreement is logged, without secrets.
    await seedAccount({
      accountId: 'srm-ms-drift',
      homeRole: 'organization_admin',
      homeMembershipRole: 'coach',
      authProvider: 'microsoft',
      loginEmail: 'ms.drift@srm.test',
    });

    const login = await loginWithMicrosoftEmail('ms.drift@srm.test');
    expect(login?.principal).toMatchObject({ organizationId: HOME_ORG, role: 'coach' });
    expect(await resolvePrincipal(requestWithSession(login!.token)))
      .toMatchObject({ organizationId: HOME_ORG, role: 'coach' });
    expect(driftWarnings()).toContainEqual({
      accountId: 'srm-ms-drift',
      organizationId: HOME_ORG,
      homeRole: 'organization_admin',
      membershipRole: 'coach',
    });
  });

  test('Microsoft: rows that agree resolve to that role, with no warning', async () => {
    await seedAccount({
      accountId: 'srm-ms-agree',
      homeRole: 'organization_admin',
      authProvider: 'microsoft',
      loginEmail: 'ms.agree@srm.test',
    });

    const login = await loginWithMicrosoftEmail('ms.agree@srm.test');
    expect(login?.principal.role).toBe('organization_admin');
    expect((await resolvePrincipal(requestWithSession(login!.token)))?.role).toBe('organization_admin');
    expect(driftWarnings()).toEqual([]);
  });

  test('password: a parent signs in and resolves as parent', async () => {
    await seedAccount({
      accountId: 'srm-parent-pw',
      homeRole: 'parent',
      authProvider: 'magic_link',
      loginEmail: 'parent.pw@srm.test',
      passwordHash: await hashPassword(PASSWORD),
    });

    const login = await loginWithEmailAndPassword('parent.pw@srm.test', PASSWORD);
    expect(login?.principal).toMatchObject({ organizationId: HOME_ORG, role: 'parent' });
    expect((await resolvePrincipal(requestWithSession(login!.token)))?.role).toBe('parent');
  });

  test('magic link: a parent whose home membership says volunteer redeems a link and resolves as volunteer', async () => {
    await seedAccount({
      accountId: 'srm-parent-link',
      homeRole: 'parent',
      homeMembershipRole: 'volunteer',
      authProvider: 'magic_link',
      loginEmail: 'parent.link@srm.test',
    });
    const linkToken = 'srm-link-parent';
    await client.query(
      `insert into pilot.magic_link_tokens (token_hash, account_id, organization_id, sent_to_email, expires_at)
       values ($1, $2, $3, $4, now() + interval '15 minutes')`,
      [hashToken(linkToken), 'srm-parent-link', HOME_ORG, 'parent.link@srm.test'],
    );

    const redeemed = await redeemMagicLink(linkToken);
    expect(redeemed.ok).toBe(true);
    expect(redeemed.principal).toMatchObject({ organizationId: HOME_ORG, role: 'volunteer' });
    expect((await resolvePrincipal(requestWithSession(redeemed.session!.token)))?.role).toBe('volunteer');
  });
});

describe('a credential must fit the membership role as well as the home role', () => {
  // Every sign-in asks credentialPolicy about the HOME role. The session acts
  // with the membership role, so a membership that needs a stronger credential
  // than the one presented is refused -- on the sign-in, and on any session
  // already held. Without this, a hand-edited membership turned a parent's
  // password or magic link into an organization_admin session with no
  // Microsoft sign-in.

  test('password: a parent whose home membership says organization_admin is refused and no session is written', async () => {
    await seedAccount({
      accountId: 'srm-pw-admin',
      homeRole: 'parent',
      homeMembershipRole: 'organization_admin',
      authProvider: 'magic_link',
      loginEmail: 'pw.admin@srm.test',
      passwordHash: await hashPassword(PASSWORD),
    });

    expect(await loginWithEmailAndPassword('pw.admin@srm.test', PASSWORD)).toBeNull();
    expect(warn.mock.calls).toContainEqual([
      'pilot-auth password login rejected',
      { reason: 'membership_role_credential_mismatch' },
    ]);
    const sessions = await client.query(`select 1 from pilot.session_tokens where account_id = 'srm-pw-admin'`);
    expect(sessions.rowCount).toBe(0);
  });

  test('password: a parent whose home membership says volunteer is refused (a password is a parent credential only)', async () => {
    await seedAccount({
      accountId: 'srm-pw-volunteer',
      homeRole: 'parent',
      homeMembershipRole: 'volunteer',
      authProvider: 'magic_link',
      loginEmail: 'pw.volunteer@srm.test',
      passwordHash: await hashPassword(PASSWORD),
    });

    expect(await loginWithEmailAndPassword('pw.volunteer@srm.test', PASSWORD)).toBeNull();
  });

  test('magic link: a parent whose home membership says organization_admin is refused and the link is not used up', async () => {
    await seedAccount({
      accountId: 'srm-link-admin',
      homeRole: 'parent',
      homeMembershipRole: 'organization_admin',
      authProvider: 'magic_link',
      loginEmail: 'link.admin@srm.test',
    });
    const linkToken = 'srm-link-admin-token';
    await client.query(
      `insert into pilot.magic_link_tokens (token_hash, account_id, organization_id, sent_to_email, expires_at)
       values ($1, $2, $3, $4, now() + interval '15 minutes')`,
      [hashToken(linkToken), 'srm-link-admin', HOME_ORG, 'link.admin@srm.test'],
    );

    expect(await redeemMagicLink(linkToken)).toEqual({ ok: false, reason: 'ACCOUNT_NOT_MAGIC_LINK' });
    const link = await client.query<{ consumed_at: Date | null }>(
      'select consumed_at from pilot.magic_link_tokens where token_hash = $1',
      [hashToken(linkToken)],
    );
    expect(link.rows[0].consumed_at).toBeNull();
  });

  test('PIN: an athlete whose home membership says coach is refused before any session is written', async () => {
    await seedAccount({
      accountId: 'srm-pin-coach',
      homeRole: 'athlete',
      homeMembershipRole: 'coach',
      authProvider: 'ppbf_local',
      athleteId: 'ATH-SRM-2',
      pinHash: await hashPin(PIN),
    });

    expect(await loginWithAccountIdAndPin('srm-pin-coach', PIN)).toBeNull();
    expect(warn.mock.calls).toContainEqual([
      'pilot-auth login rejected',
      { accountId: 'srm-pin-coach', reason: 'membership_role_credential_mismatch' },
    ]);
    const sessions = await client.query(`select 1 from pilot.session_tokens where account_id = 'srm-pin-coach'`);
    expect(sessions.rowCount).toBe(0);
  });

  test('Microsoft: a membership naming platform_owner on an account that is not the platform owner is refused', async () => {
    await seedAccount({
      accountId: 'srm-ms-owner',
      homeRole: 'organization_admin',
      homeMembershipRole: 'platform_owner',
      authProvider: 'microsoft',
      loginEmail: 'ms.owner@srm.test',
    });

    await expect(loginWithMicrosoftEmail('ms.owner@srm.test'))
      .rejects.toThrow('Forbidden: membership role does not fit this sign-in');
    const sessions = await client.query(`select 1 from pilot.session_tokens where account_id = 'srm-ms-owner'`);
    expect(sessions.rowCount).toBe(0);
  });

  test('an existing session: a parent with an organization_admin membership in another gym resolves to nobody there', async () => {
    await seedAccount({
      accountId: 'srm-session-admin',
      homeRole: 'parent',
      authProvider: 'magic_link',
      loginEmail: 'session.admin@srm.test',
    });
    await addMembership('srm-session-admin', OTHER_ORG, 'organization_admin');

    expect(await resolvePrincipal(requestWithSession(await seedSession('srm-session-admin', OTHER_ORG)))).toBeNull();
    expect(warn.mock.calls).toContainEqual([
      'pilot-auth session refused: membership role does not fit its sign-in',
      {
        accountId: 'srm-session-admin',
        organizationId: OTHER_ORG,
        homeRole: 'parent',
        membershipRole: 'organization_admin',
      },
    ]);
    // Control: at home, where the membership is parent, the same account resolves.
    expect((await resolvePrincipal(requestWithSession(await seedSession('srm-session-admin', HOME_ORG))))?.role)
      .toBe('parent');
  });

  test('an existing session: a platform_owner membership without is_platform_owner resolves to nobody', async () => {
    await seedAccount({
      accountId: 'srm-session-owner',
      homeRole: 'organization_admin',
      authProvider: 'microsoft',
      loginEmail: 'session.owner@srm.test',
    });
    await addMembership('srm-session-owner', OTHER_ORG, 'platform_owner');

    const token = await seedSession('srm-session-owner', OTHER_ORG);
    expect(await resolvePrincipal(requestWithSession(token))).toBeNull();

    // Control: the same membership on the platform owner's own account row resolves.
    await client.query(`update pilot.accounts set is_platform_owner = true where account_id = 'srm-session-owner'`);
    expect((await resolvePrincipal(requestWithSession(token)))?.role).toBe('platform_owner');
  });
});

describe('magic link after a move to another gym', () => {
  function capturingDependencies(sent: Array<{ to: string; body: string }>) {
    return {
      ...magicLinkDependencies(),
      sendMail: async (message: { to: string; body: string }) => {
        sent.push(message);
      },
    };
  }

  function linkTokenFrom(body: string): string {
    const match = /token=([A-Za-z0-9_-]+)/.exec(body);
    if (!match) throw new Error(`test bug: no token in the mailed link: ${body}`);
    return decodeURIComponent(match[1]);
  }

  test('a link issued at the old gym mints no session once the platform owner has moved the account', async () => {
    await seedAccount({
      accountId: 'srm-parent-moved',
      homeRole: 'parent',
      authProvider: 'magic_link',
      loginEmail: 'parent.moved@srm.test',
    });
    const sent: Array<{ to: string; body: string }> = [];
    await issueMagicLink('parent.moved@srm.test', capturingDependencies(sent));
    expect(sent).toHaveLength(1);
    const linkToken = linkTokenFrom(sent[0].body);

    // The platform owner makes them a coach at the other gym. This leaves the
    // old gym's parent membership active and the emailed link unspent.
    await upsertOrganizationMembership('srm-parent-moved', OTHER_ORG, 'coach', true);

    const redeemed = await redeemMagicLink(linkToken);

    expect(redeemed).toEqual({ ok: false, reason: 'ACCOUNT_INACTIVE' });
    const sessions = await client.query(
      `select 1 from pilot.session_tokens where account_id = 'srm-parent-moved' and revoked_at is null`,
    );
    expect(sessions.rowCount).toBe(0);
    // Refused before the claim: the link is not used up.
    const link = await client.query<{ consumed_at: Date | null }>(
      'select consumed_at from pilot.magic_link_tokens where token_hash = $1',
      [hashToken(linkToken)],
    );
    expect(link.rows[0].consumed_at).toBeNull();
  });

  test('control: the same sequence without the move signs the parent in as parent', async () => {
    await seedAccount({
      accountId: 'srm-parent-stays',
      homeRole: 'parent',
      authProvider: 'magic_link',
      loginEmail: 'parent.stays@srm.test',
    });
    const sent: Array<{ to: string; body: string }> = [];
    await issueMagicLink('parent.stays@srm.test', capturingDependencies(sent));

    const redeemed = await redeemMagicLink(linkTokenFrom(sent[0].body));

    expect(redeemed.ok).toBe(true);
    expect(redeemed.principal).toMatchObject({ organizationId: HOME_ORG, role: 'parent' });
  });
});

describe('a queued SHADOW job re-reads its actor in the job organization', () => {
  test('organization_admin at home, coach in the job organization: the job runs as coach', async () => {
    await seedAccount({
      accountId: 'srm-job-actor',
      homeRole: 'organization_admin',
      authProvider: 'microsoft',
      loginEmail: 'job.actor@srm.test',
    });
    await addMembership('srm-job-actor', OTHER_ORG, 'coach');

    await expect(loadCurrentJobActor({ organizationId: OTHER_ORG, accountId: 'srm-job-actor' }))
      .resolves.toMatchObject({ organizationId: OTHER_ORG, role: 'coach' });
    await expect(loadCurrentJobActor({ organizationId: HOME_ORG, accountId: 'srm-job-actor' }))
      .resolves.toMatchObject({ organizationId: HOME_ORG, role: 'organization_admin' });
  });
});
