// Real PostgreSQL proof of two rules magicLink.test.ts can only state with
// injected stand-ins, because both live partly in SQL:
//
//   1. THE LINK ALREADY IN THE INBOX OUTLIVES A FAILED SEND. Requesting a new
//      link used to invalidate the old one first, then store, then send -- so
//      a send that failed left the person with no working link at all. The
//      store's "retire the others" statement now excludes the link just sent
//      (`token_hash <> $2`), and runs only after the send succeeded. If that
//      clause were wrong the new link would retire itself and nobody would
//      notice until a real parent clicked a real link.
//
//   2. A SITE ADDRESS THAT CANNOT CARRY A LINK STOPS EVERYTHING. Production
//      once held `punxsyprominence.org` (no scheme). The real store must
//      refuse it before any row is written or any mail attempted.
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

import { issueMagicLink } from './magicLink';
import { magicLinkDependencies, redeemMagicLink } from './magicLinkStore';
import { hashToken } from './security';

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-magic-link-reissue-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const TEST_DB_NAME = 'ppbf_test_magic_link_reissue';
const MIGRATIONS = [
  'pilot_slice_postgres.sql',
  // pilot.board_seats: resolvePrincipal's membership lookup joins it.
  'pilot_slice_postgres_board_seats_migration.sql',
  // pilot.magic_link_tokens.
  'pilot_slice_postgres_magic_link_migration.sql',
  // pilot.accounts.deleted_at.
  'pilot_slice_postgres_data_retention_deletion_migration.sql',
  // pilot.accounts.password_hash and session_tokens.sign_in_method.
  'pilot_slice_postgres_parent_password_migration.sql',
];

const ORG = 'org-mlr';
const ORIGIN = 'https://app.ppbf.test';

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let client: Client;
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

/** A parent who signs in by emailed link, homed in ORG with a matching membership. */
async function seedParent(accountId: string, loginEmail: string): Promise<void> {
  await client.query(
    `insert into pilot.accounts (account_id, role, organization_id, auth_provider, login_email, active_flag)
     values ($1, 'parent', $2, 'magic_link', $3, true)`,
    [accountId, ORG, loginEmail],
  );
  await client.query(
    `insert into pilot.organization_memberships (account_id, organization_id, role, active_flag)
     values ($1, $2, 'parent', true)`,
    [accountId, ORG],
  );
}

/** The real store, with the mailer replaced: `outcome` decides whether the send lands or throws. */
function dependenciesWith(sent: string[], outcome: 'delivers' | 'fails') {
  return {
    ...magicLinkDependencies(),
    sendMail: async (message: { body: string }) => {
      if (outcome === 'fails') throw new Error('GRAPH_SEND_FAILED');
      sent.push(message.body);
    },
  };
}

function linkTokenFrom(body: string): string {
  const match = /token=([A-Za-z0-9_-]+)/.exec(body);
  if (!match) throw new Error(`test bug: no token in the mailed link: ${body}`);
  return decodeURIComponent(match[1]);
}

async function tokenRows(accountId: string) {
  const result = await client.query<{ consumed_at: Date | null; invalidated_at: Date | null }>(
    `select consumed_at, invalidated_at from pilot.magic_link_tokens where account_id = $1 order by created_at`,
    [accountId],
  );
  return result.rows;
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
  await client.query(
    `insert into pilot.organizations (organization_id, organization_name, status) values ($1, $1, 'active')`,
    [ORG],
  );
  activeClient = client;
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
  process.env.PPBF_APP_ORIGIN = ORIGIN;
});

describe('asking for a second link', () => {
  test('when the second send fails, the first link still signs the parent in', async () => {
    await seedParent('mlr-parent-fail', 'parent.fail@mlr.test');
    const sent: string[] = [];
    await issueMagicLink('parent.fail@mlr.test', dependenciesWith(sent, 'delivers'));
    const firstToken = linkTokenFrom(sent[0]);

    await expect(
      issueMagicLink('parent.fail@mlr.test', dependenciesWith(sent, 'fails')),
    ).rejects.toThrow('GRAPH_SEND_FAILED');

    // The first link is untouched; the second, which nobody received, is retired.
    const rows = await tokenRows('mlr-parent-fail');
    expect(rows).toHaveLength(2);
    expect(rows[0].invalidated_at).toBeNull();
    expect(rows[1].invalidated_at).not.toBeNull();

    const redeemed = await redeemMagicLink(firstToken);
    expect(redeemed.ok).toBe(true);
    expect(redeemed.principal).toMatchObject({ accountId: 'mlr-parent-fail', organizationId: ORG, role: 'parent' });
  });

  test('when the second send lands, only the second link signs the parent in', async () => {
    await seedParent('mlr-parent-ok', 'parent.ok@mlr.test');
    const sent: string[] = [];
    await issueMagicLink('parent.ok@mlr.test', dependenciesWith(sent, 'delivers'));
    await issueMagicLink('parent.ok@mlr.test', dependenciesWith(sent, 'delivers'));
    expect(sent).toHaveLength(2);
    const firstToken = linkTokenFrom(sent[0]);
    const secondToken = linkTokenFrom(sent[1]);
    expect(secondToken).not.toBe(firstToken);

    // The retire statement must spare the link just sent: `token_hash <> $2`.
    const rows = await tokenRows('mlr-parent-ok');
    expect(rows.map((row) => row.invalidated_at !== null)).toEqual([true, false]);

    expect(await redeemMagicLink(firstToken)).toEqual({ ok: false, reason: 'TOKEN_INVALIDATED' });
    const redeemed = await redeemMagicLink(secondToken);
    expect(redeemed.ok).toBe(true);
    expect(redeemed.principal).toMatchObject({ accountId: 'mlr-parent-ok' });
  });

  test('two requests whose sends overlap: the newer link survives, whichever send finishes first', async () => {
    // A phone and the gym tablet, or a reload while the first request is
    // slow. Driven deterministically: the first request's send asks for the
    // second link before it returns, so the SECOND request finishes first
    // and retires the first link; then the first request's own retire step
    // runs and must not touch the newer link. Retiring "every other link"
    // instead of "every older link" left both dead here.
    await seedParent('mlr-parent-overlap', 'parent.overlap@mlr.test');
    const sent: string[] = [];
    const inner = dependenciesWith(sent, 'delivers');
    const outer = {
      ...magicLinkDependencies(),
      sendMail: async (message: { body: string }) => {
        await issueMagicLink('parent.overlap@mlr.test', inner);
        sent.push(message.body);
      },
    };

    await issueMagicLink('parent.overlap@mlr.test', outer);

    // sent[0] is the inner (newer) link, sent[1] the outer (older) one.
    expect(sent).toHaveLength(2);
    const live = await client.query(
      `select 1 from pilot.magic_link_tokens where account_id = 'mlr-parent-overlap' and invalidated_at is null`,
    );
    expect(live.rowCount).toBe(1);
    expect(await redeemMagicLink(linkTokenFrom(sent[1]))).toEqual({ ok: false, reason: 'TOKEN_INVALIDATED' });
    expect((await redeemMagicLink(linkTokenFrom(sent[0]))).ok).toBe(true);
  });

  test('two overlapping requests the other way round: the first to finish is the older, and still loses', async () => {
    // Store both before either sends, then let the OLDER request finish
    // first. Its retire step must find nothing older; the newer one's must
    // retire it.
    await seedParent('mlr-parent-overlap2', 'parent.overlap2@mlr.test');
    const base = magicLinkDependencies();
    let releaseSecondStore!: () => void;
    const secondStored = new Promise<void>((resolve) => { releaseSecondStore = resolve; });
    let releaseFirstSend!: () => void;
    const firstMaySend = new Promise<void>((resolve) => { releaseFirstSend = resolve; });
    const sent: string[] = [];

    const first = issueMagicLink('parent.overlap2@mlr.test', {
      ...base,
      sendMail: async (message: { body: string }) => {
        // Wait until the second request has stored its (newer) row.
        await secondStored;
        sent.push(message.body);
      },
    });
    const second = issueMagicLink('parent.overlap2@mlr.test', {
      ...base,
      storeToken: async (row) => {
        await base.storeToken(row);
        releaseSecondStore();
      },
      sendMail: async (message: { body: string }) => {
        // Do not finish until the first request has completed entirely.
        await firstMaySend;
        sent.push(message.body);
      },
    });
    await first;
    releaseFirstSend();
    await second;

    // sent[0] is the first (older) link, sent[1] the second (newer).
    expect(sent).toHaveLength(2);
    expect(await redeemMagicLink(linkTokenFrom(sent[0]))).toEqual({ ok: false, reason: 'TOKEN_INVALIDATED' });
    expect((await redeemMagicLink(linkTokenFrom(sent[1]))).ok).toBe(true);
  });

  test('a failed third send leaves the second link, the one in the inbox, working', async () => {
    // First sent, second sent (retires the first), third fails: the second
    // link, the one in the inbox, is the one that must still work.
    await seedParent('mlr-parent-three', 'parent.three@mlr.test');
    const sent: string[] = [];
    await issueMagicLink('parent.three@mlr.test', dependenciesWith(sent, 'delivers'));
    await issueMagicLink('parent.three@mlr.test', dependenciesWith(sent, 'delivers'));
    await expect(
      issueMagicLink('parent.three@mlr.test', dependenciesWith(sent, 'fails')),
    ).rejects.toThrow('GRAPH_SEND_FAILED');

    const rows = await tokenRows('mlr-parent-three');
    expect(rows.map((row) => row.invalidated_at !== null)).toEqual([true, false, true]);
    expect(await redeemMagicLink(linkTokenFrom(sent[0]))).toEqual({ ok: false, reason: 'TOKEN_INVALIDATED' });
    expect((await redeemMagicLink(linkTokenFrom(sent[1]))).ok).toBe(true);
  });

  test('the retired link and the unsent link are cancelled, never "used": the audit split holds', async () => {
    await seedParent('mlr-parent-audit', 'parent.audit@mlr.test');
    const sent: string[] = [];
    await issueMagicLink('parent.audit@mlr.test', dependenciesWith(sent, 'delivers'));
    await issueMagicLink('parent.audit@mlr.test', dependenciesWith(sent, 'delivers'));
    await expect(
      issueMagicLink('parent.audit@mlr.test', dependenciesWith(sent, 'fails')),
    ).rejects.toThrow('GRAPH_SEND_FAILED');

    const rows = await tokenRows('mlr-parent-audit');
    expect(rows.map((row) => row.invalidated_at !== null)).toEqual([true, false, true]);
    expect(rows.every((row) => row.consumed_at === null)).toBe(true);
  });
});

describe('a site address that cannot carry a link', () => {
  test.each([
    ['no scheme, as production once had', 'punxsyprominence.org'],
    ['http on a public host', 'http://www.punxsyprominence.org'],
    ['a path after the host', 'https://www.punxsyprominence.org/app'],
    ['whitespace only', '   '],
  ])('%s: the real store refuses at construction', async (_label, value) => {
    process.env.PPBF_APP_ORIGIN = value;

    // The request route builds its dependencies before reading the body
    // (route.ts) and answers 503 on this throw, for every caller alike.
    expect(() => magicLinkDependencies()).toThrow(
      value.trim() ? /^INVALID_PPBF_APP_ORIGIN:/ : /^MISSING_PPBF_APP_ORIGIN$/,
    );
  });

  test('a bad address injected past the store check: no row is written and nothing is mailed', async () => {
    await seedParent('mlr-parent-dead', 'parent.dead@mlr.test');
    const sent: string[] = [];
    // A bad address injected past the store's own check: issueMagicLink
    // re-checks it before the lookup.
    await expect(
      issueMagicLink('parent.dead@mlr.test', {
        ...dependenciesWith(sent, 'delivers'),
        appOrigin: 'punxsyprominence.org',
      }),
    ).rejects.toThrow('INVALID_PPBF_APP_ORIGIN:not_absolute_url');

    expect(sent).toEqual([]);
    expect(await tokenRows('mlr-parent-dead')).toEqual([]);
  });

  test('control: the production shape builds a link the store redeems', async () => {
    await seedParent('mlr-parent-live', 'parent.live@mlr.test');
    process.env.PPBF_APP_ORIGIN = 'https://www.punxsyprominence.org/';
    const sent: string[] = [];
    await issueMagicLink('parent.live@mlr.test', dependenciesWith(sent, 'delivers'));

    expect(sent[0]).toContain('\nhttps://www.punxsyprominence.org/auth/link?token=');
    expect((await redeemMagicLink(linkTokenFrom(sent[0]))).ok).toBe(true);
    expect(hashToken(linkTokenFrom(sent[0]))).toHaveLength(64);
  });
});
