// CL-C10 (2026-10-05 audit): a SHADOW memory "forget" or "replace" request was
// stored as `pending` and nothing ever acted on it -- no caller of
// forgetRememberedFact, no reader of the correction rows, no reviewer -- so
// the fact kept feeding the person's prompts (shadowContextBuilder.ts). For an
// account that may belong to a child that is a privacy defect, not a missing
// feature.
//
// Fixed per overwatch's ruling (lane relay 2026-10-05, option A): both
// actions remove the named fact from the requester's OWN profile at once, in
// the same transaction as the correction row, which is written `applied`. A
// replace's corrected value stays on the correction row only and is never
// written into remembered_facts, because the prompt header calls those facts
// "observations, not settings this person chose".
//
// Against real Postgres because the removal is a jsonb statement; a mock
// would prove only that some SQL was sent.

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
}));

import { submitMemoryCorrection } from './shadowConversations';

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-memory-correction-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');

const ORG = 'org-memory';
const OTHER_ORG = 'org-memory-other';
const ACCOUNT = 'acct-memory';
const OTHER_ACCOUNT = 'acct-memory-other';

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
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

const fact = (key: string, value: string) => ({
  key, value, confidence: 0.7, observationCount: 1, updatedAt: '2026-10-01T00:00:00.000Z',
});

async function freshDatabase(name: string): Promise<Client> {
  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  await admin.query(`drop database if exists ${name}`);
  await admin.query(`create database ${name}`);
  await admin.end();

  const client = new Client({ connectionString: connectionStringFor(name) });
  await client.connect();
  await client.query(baseSchemaSql);
  for (const organization of [ORG, OTHER_ORG]) {
    await client.query(
      `insert into pilot.organizations (organization_id, organization_name, status)
       values ($1, $1, 'active') on conflict do nothing`,
      [organization],
    );
  }
  for (const account of [ACCOUNT, OTHER_ACCOUNT]) {
    await client.query(
      `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
       values ($1, 'athlete', $2, 'microsoft') on conflict do nothing`,
      [account, ORG],
    );
  }
  // The same two facts on three profiles: the requester's, another account in
  // the same gym, and the requester's account id under another gym (a profile
  // is keyed by both). Only the first may change.
  const facts = JSON.stringify([fact('stance', 'orthodox'), fact('prefers_concise_answers', 'true')]);
  for (const [account, organization] of [[ACCOUNT, ORG], [OTHER_ACCOUNT, ORG], [ACCOUNT, OTHER_ORG]]) {
    await client.query(
      `insert into pilot.shadow_user_profiles (account_id, organization_id, role, remembered_facts)
       values ($1, $2, 'athlete', $3::jsonb)`,
      [account, organization, facts],
    );
  }
  activeClient = client;
  return client;
}

async function factKeys(client: Client, account: string, organization: string): Promise<string[]> {
  const result = await client.query(
    `select remembered_facts from pilot.shadow_user_profiles where account_id = $1 and organization_id = $2`,
    [account, organization],
  );
  return (result.rows[0].remembered_facts as Array<{ key: string }>).map((f) => f.key);
}

async function corrections(client: Client) {
  const result = await client.query(
    `select account_id, fact_key, corrected_value, action, status from pilot.shadow_chat_memory_corrections`,
  );
  return result.rows;
}

const actor = { accountId: ACCOUNT, organizationId: ORG, athleteId: null, role: 'athlete' as const };

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

describe('SHADOW memory corrections are applied, against real Postgres', () => {
  const withDatabase = async (name: string, body: (client: Client) => Promise<void>) => {
    const client = await freshDatabase(name);
    try {
      await body(client);
    } finally {
      activeClient = null;
      await client.end();
    }
  };

  test('forget removes the named fact from the requester\'s own profile, and only there', async () => {
    await withDatabase('ppbf_test_memory_forget', async (client) => {
      const result = await submitMemoryCorrection({ actor, factKey: 'stance', action: 'forget' });

      expect(result).toEqual({ correctionId: expect.any(String), status: 'applied', factRemoved: true });
      expect(await factKeys(client, ACCOUNT, ORG)).toEqual(['prefers_concise_answers']);
      expect(await factKeys(client, OTHER_ACCOUNT, ORG)).toEqual(['stance', 'prefers_concise_answers']);
      expect(await factKeys(client, ACCOUNT, OTHER_ORG)).toEqual(['stance', 'prefers_concise_answers']);
      expect(await corrections(client)).toEqual([
        { account_id: ACCOUNT, fact_key: 'stance', corrected_value: null, action: 'forget', status: 'applied' },
      ]);
    });
  });

  test('replace removes the wrong fact and keeps the corrected value on the correction row only', async () => {
    await withDatabase('ppbf_test_memory_replace', async (client) => {
      const result = await submitMemoryCorrection({
        actor, factKey: 'stance', correctedValue: 'southpaw', action: 'replace',
      });

      expect(result).toEqual({ correctionId: expect.any(String), status: 'applied', factRemoved: true });
      expect(await factKeys(client, ACCOUNT, ORG)).toEqual(['prefers_concise_answers']);
      const stored = await client.query(
        `select remembered_facts::text as facts from pilot.shadow_user_profiles
          where account_id = $1 and organization_id = $2`,
        [ACCOUNT, ORG],
      );
      expect(stored.rows[0].facts).not.toContain('southpaw');
      expect(await corrections(client)).toEqual([
        { account_id: ACCOUNT, fact_key: 'stance', corrected_value: 'southpaw', action: 'replace', status: 'applied' },
      ]);
    });
  });

  test('a key that is not remembered removes nothing and says so', async () => {
    await withDatabase('ppbf_test_memory_absent', async (client) => {
      const result = await submitMemoryCorrection({ actor, factKey: 'weight_class', action: 'forget' });

      expect(result).toEqual({ correctionId: expect.any(String), status: 'applied', factRemoved: false });
      expect(await factKeys(client, ACCOUNT, ORG)).toEqual(['stance', 'prefers_concise_answers']);
      expect(await corrections(client)).toHaveLength(1);
    });
  });

  test('an account with no profile row yet records the request and removes nothing', async () => {
    await withDatabase('ppbf_test_memory_no_profile', async (client) => {
      await client.query(
        `delete from pilot.shadow_user_profiles where account_id = $1 and organization_id = $2`,
        [ACCOUNT, ORG],
      );
      const result = await submitMemoryCorrection({ actor, factKey: 'stance', action: 'forget' });

      expect(result).toEqual({ correctionId: expect.any(String), status: 'applied', factRemoved: false });
      expect(await corrections(client)).toHaveLength(1);
    });
  });
});
