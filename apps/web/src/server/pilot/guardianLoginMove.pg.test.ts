// Real PostgreSQL contract test for moveGuardianToLogin (OD-2026-09-29-004 R4):
// the organization-admin action that moves a guardian record to another login
// on purpose.
//
// What reading the SQL cannot prove: that the move carries the children and
// the record's own waivers to the new login and takes them from the old one;
// that every refusal writes nothing; that the audit row and the move commit or
// roll back together; and how the move meets the parent-deletion trigger,
// which finds a guardian's children through pilot.parents.account_id.
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

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const PG_DATABASE = 'ppbf_test_guardian_login_move';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-guardian-login-move-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const MIGRATIONS = [
  'pilot_slice_postgres.sql',
  'pilot_slice_postgres_board_seats_migration.sql',
  'pilot_slice_postgres_magic_link_migration.sql',
  // pilot.accounts.deleted_at and the parent-deletion cascade trigger.
  'pilot_slice_postgres_data_retention_deletion_migration.sql',
];

const ORG = 'org-glm';
const OTHER_ORG = 'org-glm-elsewhere';
const ADMIN = 'acct-glm-admin';
const COACH = 'acct-glm-coach';
const OLD_LOGIN = 'acct-glm-parent-old';
const NEW_LOGIN = 'acct-glm-parent-new';
const ELSEWHERE_PARENT = 'acct-glm-parent-elsewhere';
const PARENT_ID = 'par-glm-1';
const KID_A = 'ath-glm-a';
const KID_B = 'ath-glm-b';
const ACTOR = { accountId: ADMIN, role: 'organization_admin' as const };

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let client: Client;

type MoveModule = typeof import('./guardianLoginMove');
type AccessModule = typeof import('./guardianAccess');
let move: MoveModule;
let access: AccessModule;
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

async function addLogin(accountId: string, role: string, organizationId = ORG, isPlatformOwner = false) {
  await client.query(
    `insert into pilot.accounts (account_id, role, organization_id, auth_provider, is_platform_owner)
     values ($1, $2, $3, 'microsoft', $4)`,
    [accountId, role, organizationId, isPlatformOwner],
  );
  await client.query(
    `insert into pilot.organization_memberships (account_id, organization_id, role, active_flag)
     values ($1, $2, $3, true)`,
    [accountId, organizationId, role],
  );
}

async function addAthlete(athleteId: string) {
  await client.query(
    `insert into pilot.athletes
     (organization_id, athlete_id, full_name, dob, weight_class, gym_status, emergency_contact,
      active_flag, coach_id, created_at, updated_at)
     values ($1, $2, $2, '2012-01-01', '80', 'active', 'n/a', true, $3, now(), now())`,
    [ORG, athleteId, COACH],
  );
}

async function parentLogin(): Promise<string | null> {
  const result = await client.query(
    'select account_id from pilot.parents where organization_id = $1 and parent_id = $2',
    [ORG, PARENT_ID],
  );
  return result.rows[0]?.account_id ?? null;
}

async function moveAudits(): Promise<Array<Record<string, unknown>>> {
  const result = await client.query(
    `select actor_account_id, actor_role, entity_type, entity_id, details
     from pilot.audit_events
     where details->>'action' = 'organization_admin_move_guardian_login'`,
  );
  return result.rows;
}

function request(overrides: Partial<Parameters<MoveModule['moveGuardianToLogin']>[0]> = {}) {
  return {
    organizationId: ORG,
    parentId: PARENT_ID,
    fromAccountId: OLD_LOGIN,
    toAccountId: NEW_LOGIN,
    actor: ACTOR,
    ...overrides,
  };
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
  for (const file of MIGRATIONS) {
    await client.query(await fs.readFile(path.join(INFRA_DIR, file), 'utf8'));
  }

  // Env before import: db.ts reads the connection string when its pool is
  // first built, so the dynamic imports have to come after this.
  process.env.AZURE_POSTGRES_CONNECTION_STRING = connectionStringFor(PG_DATABASE);
  process.env.PPBF_POSTGRES_DISABLE_SSL = 'true';
  move = await import('./guardianLoginMove');
  access = await import('./guardianAccess');
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
  await client.query(`truncate pilot.organizations, pilot.accounts, pilot.audit_events cascade`);
  for (const org of [ORG, OTHER_ORG]) {
    await client.query(
      `insert into pilot.organizations (organization_id, organization_name, status) values ($1, $1, 'active')`,
      [org],
    );
  }
  await addLogin(ADMIN, 'organization_admin');
  await addLogin(COACH, 'coach');
  await addLogin(OLD_LOGIN, 'parent');
  await addLogin(NEW_LOGIN, 'parent');
  await addLogin(ELSEWHERE_PARENT, 'parent', OTHER_ORG);
  await addAthlete(KID_A);
  await addAthlete(KID_B);
  await client.query(
    `insert into pilot.parents (organization_id, parent_id, account_id, full_name, email)
     values ($1, $2, $3, 'Guardian One', 'old@example.test')`,
    [ORG, PARENT_ID, OLD_LOGIN],
  );
  for (const kid of [KID_A, KID_B]) {
    await client.query(
      `insert into pilot.guardian_links (organization_id, parent_id, athlete_id, relationship_to_athlete)
       values ($1, $2, $3, 'parent')`,
      [ORG, PARENT_ID, kid],
    );
  }
});

describe('moveGuardianToLogin', () => {
  test('moves the record: the new login sees both children and the old login sees none', async () => {
    const result = await move.moveGuardianToLogin(request());

    expect(result).toEqual({
      parentId: PARENT_ID,
      fromAccountId: OLD_LOGIN,
      toAccountId: NEW_LOGIN,
      athleteIds: [KID_A, KID_B],
    });
    expect(await parentLogin()).toBe(NEW_LOGIN);
    expect((await access.guardianAthleteIds(ORG, NEW_LOGIN)).sort()).toEqual([KID_A, KID_B]);
    expect(await access.guardianAthleteIds(ORG, OLD_LOGIN)).toEqual([]);
    // The record keeps its parent_id, so waivers keyed by it (media consent)
    // now belong to the new login.
    expect(await access.guardianParentIds(ORG, NEW_LOGIN)).toEqual([PARENT_ID]);
    expect(await access.guardianParentIds(ORG, OLD_LOGIN)).toEqual([]);
  });

  test('writes one audit row naming the admin, both logins and the children', async () => {
    await move.moveGuardianToLogin(request());

    expect(await moveAudits()).toEqual([{
      actor_account_id: ADMIN,
      actor_role: 'organization_admin',
      entity_type: 'guardian',
      entity_id: PARENT_ID,
      details: {
        action: 'organization_admin_move_guardian_login',
        from_account_id: OLD_LOGIN,
        to_account_id: NEW_LOGIN,
        athlete_ids: [KID_A, KID_B],
      },
    }]);
  });

  test('a failing audit write undoes the move', async () => {
    await client.query(
      `alter table pilot.audit_events add constraint glm_refuse_guardian check (entity_type <> 'guardian')`,
    );
    try {
      await expect(move.moveGuardianToLogin(request())).rejects.toThrow();
      expect(await parentLogin()).toBe(OLD_LOGIN);
    } finally {
      await client.query('alter table pilot.audit_events drop constraint glm_refuse_guardian');
    }
  });

  test('a move that fails at commit leaves no audit row claiming it happened', async () => {
    // A deferred trigger refuses the record's update only at COMMIT, after the
    // audit row was written. On the move's transaction the audit row goes with
    // it; written anywhere else it would survive and record a move that never
    // happened.
    await client.query(`create or replace function pilot.glm_refuse_commit() returns trigger language plpgsql as $$
      begin raise exception 'glm: commit refused'; end $$`);
    await client.query(`create constraint trigger glm_refuse_commit after update on pilot.parents
      deferrable initially deferred for each row execute function pilot.glm_refuse_commit()`);
    try {
      await expect(move.moveGuardianToLogin(request())).rejects.toThrow('glm: commit refused');
      expect(await parentLogin()).toBe(OLD_LOGIN);
      expect(await moveAudits()).toEqual([]);
    } finally {
      await client.query('drop trigger glm_refuse_commit on pilot.parents');
      await client.query('drop function pilot.glm_refuse_commit()');
    }
  });

  const refusals: Array<[string, () => Promise<void>, Partial<Parameters<MoveModule['moveGuardianToLogin']>[0]>, number, string]> = [
    ['the same login', async () => {}, { toAccountId: OLD_LOGIN }, 400, 'GUARDIAN_MOVE_SAME_LOGIN'],
    ['an unknown guardian record', async () => {}, { parentId: 'par-nope' }, 404, 'GUARDIAN_RECORD_NOT_FOUND'],
    ['a stale from-login', async () => {}, { fromAccountId: NEW_LOGIN, toAccountId: ELSEWHERE_PARENT }, 409, 'GUARDIAN_LOGIN_CHANGED'],
    ['a record with no login', async () => {
      await client.query('update pilot.parents set account_id = null where parent_id = $1', [PARENT_ID]);
    }, {}, 409, 'GUARDIAN_LOGIN_CHANGED'],
    ['a login in another organization', async () => {}, { toAccountId: ELSEWHERE_PARENT }, 404, 'GUARDIAN_MOVE_TARGET_NOT_FOUND'],
    ['a login that does not exist', async () => {}, { toAccountId: 'acct-nobody' }, 404, 'GUARDIAN_MOVE_TARGET_NOT_FOUND'],
    ['a coach login', async () => {}, { toAccountId: COACH }, 409, 'GUARDIAN_MOVE_TARGET_NOT_PARENT'],
    ['an organization admin login', async () => {}, { toAccountId: ADMIN }, 409, 'GUARDIAN_MOVE_TARGET_NOT_PARENT'],
    ['a parent login flagged platform owner', async () => {
      await client.query('update pilot.accounts set is_platform_owner = true where account_id = $1', [NEW_LOGIN]);
    }, {}, 409, 'GUARDIAN_MOVE_TARGET_NOT_PARENT'],
    ['a parent login whose membership here is not parent', async () => {
      await client.query(`update pilot.organization_memberships set role = 'coach' where account_id = $1`, [NEW_LOGIN]);
    }, {}, 409, 'GUARDIAN_MOVE_TARGET_NOT_PARENT'],
    ['a deleted target login', async () => {
      await client.query('update pilot.accounts set deleted_at = now() where account_id = $1', [NEW_LOGIN]);
    }, {}, 409, 'DELETED_LOGIN'],
    ['a switched-off target login', async () => {
      await client.query('update pilot.accounts set active_flag = false where account_id = $1', [NEW_LOGIN]);
    }, {}, 409, 'GUARDIAN_MOVE_TARGET_INACTIVE'],
    ['a target whose membership is switched off', async () => {
      await client.query('update pilot.organization_memberships set active_flag = false where account_id = $1', [NEW_LOGIN]);
    }, {}, 409, 'GUARDIAN_MOVE_TARGET_INACTIVE'],
    ['a record on a deleted login', async () => {
      // A co-guardian keeps the children enrolled, so the cascade leaves
      // them alone and only the login is marked.
      await client.query(
        `insert into pilot.parents (organization_id, parent_id, account_id, full_name) values ($1, 'par-co', null, 'Co')`,
        [ORG],
      );
      await client.query(
        `insert into pilot.guardian_links (organization_id, parent_id, athlete_id, relationship_to_athlete)
         values ($1, 'par-co', $2, 'parent'), ($1, 'par-co', $3, 'parent')`,
        [ORG, KID_A, KID_B],
      );
      await client.query('update pilot.accounts set deleted_at = now() where account_id = $1', [OLD_LOGIN]);
    }, {}, 409, 'GUARDIAN_LOGIN_DELETED'],
    ['a target that already guards one of the same children', async () => {
      await client.query(
        `insert into pilot.parents (organization_id, parent_id, account_id, full_name) values ($1, 'par-dup', $2, 'Dup')`,
        [ORG, NEW_LOGIN],
      );
      await client.query(
        `insert into pilot.guardian_links (organization_id, parent_id, athlete_id, relationship_to_athlete)
         values ($1, 'par-dup', $2, 'parent')`,
        [ORG, KID_B],
      );
    }, {}, 409, 'GUARDIAN_MOVE_TARGET_ALREADY_GUARDIAN'],
    ['a PIN parent login', async () => {
      await client.query(`update pilot.accounts set auth_provider = 'ppbf_local' where account_id = $1`, [NEW_LOGIN]);
    }, {}, 409, 'GUARDIAN_MOVE_TARGET_PIN_LOGIN'],
    ['a record whose login is outside this organization', async () => {
      await client.query('update pilot.parents set account_id = $1 where parent_id = $2', [ELSEWHERE_PARENT, PARENT_ID]);
    }, { fromAccountId: ELSEWHERE_PARENT }, 409, 'GUARDIAN_LOGIN_OUTSIDE_ORGANIZATION'],
  ];

  test.each(refusals)('refuses %s and writes nothing', async (_name, arrange, overrides, status, code) => {
    await arrange();
    const before = await parentLogin();

    await expect(move.moveGuardianToLogin(request(overrides))).rejects.toMatchObject({ status, code });

    expect(await parentLogin()).toBe(before);
    expect(await moveAudits()).toEqual([]);
  });

  test('a target that guards other children only still receives the record', async () => {
    await addAthlete('ath-glm-c');
    await client.query(
      `insert into pilot.parents (organization_id, parent_id, account_id, full_name) values ($1, 'par-other', $2, 'Other')`,
      [ORG, NEW_LOGIN],
    );
    await client.query(
      `insert into pilot.guardian_links (organization_id, parent_id, athlete_id, relationship_to_athlete)
       values ($1, 'par-other', 'ath-glm-c', 'parent')`,
      [ORG],
    );

    await move.moveGuardianToLogin(request());

    expect((await access.guardianAthleteIds(ORG, NEW_LOGIN)).sort()).toEqual([KID_A, KID_B, 'ath-glm-c']);
  });

  test('another organization cannot move this organization\'s record', async () => {
    await expect(move.moveGuardianToLogin(request({ organizationId: OTHER_ORG, toAccountId: ELSEWHERE_PARENT })))
      .rejects.toMatchObject({ status: 404, code: 'GUARDIAN_RECORD_NOT_FOUND' });
    expect(await parentLogin()).toBe(OLD_LOGIN);
  });

  test('after the move, deleting the old login no longer withdraws the children; deleting the new one does', async () => {
    await move.moveGuardianToLogin(request());

    await client.query('update pilot.accounts set deleted_at = now() where account_id = $1', [OLD_LOGIN]);
    const afterOld = await client.query(
      'select count(*)::int as n from pilot.athletes where organization_id = $1 and deleted_at is not null',
      [ORG],
    );
    expect(afterOld.rows[0].n).toBe(0);

    await client.query('update pilot.accounts set deleted_at = now() where account_id = $1', [NEW_LOGIN]);
    const afterNew = await client.query(
      'select count(*)::int as n from pilot.athletes where organization_id = $1 and deleted_at is not null',
      [ORG],
    );
    expect(afterNew.rows[0].n).toBe(2);
  });

  test('a move waits for an open deletion of the old login, then refuses it', async () => {
    // The move's FOR SHARE lock on the old login is what orders the two. The
    // deletion's trigger has already withdrawn the children through the
    // record's current login; a move that did not wait would commit the
    // record onto the new login with its children already withdrawn.
    const deleter = new Client({ connectionString: connectionStringFor(PG_DATABASE) });
    await deleter.connect();
    try {
      await deleter.query('begin');
      await deleter.query('update pilot.accounts set deleted_at = now() where account_id = $1', [OLD_LOGIN]);

      let settled = false;
      const moving = move.moveGuardianToLogin(request()).finally(() => { settled = true; });
      moving.catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(settled).toBe(false);

      await deleter.query('commit');
      await expect(moving).rejects.toMatchObject({ status: 409, code: 'GUARDIAN_LOGIN_DELETED' });
      expect(await parentLogin()).toBe(OLD_LOGIN);
      expect(await moveAudits()).toEqual([]);
    } finally {
      await deleter.end();
    }
  });
});
