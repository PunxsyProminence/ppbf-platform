// Real PostgreSQL proof of the privacy-leftovers counts
// (scripts/pilot-check-privacy-leftovers.mjs):
// - F-099: a stored SHADOW citation of a Library document filed against an
//   athlete other than the conversation's own is counted, by the asking
//   account's role; one of the conversation's own athlete's document, or of a
//   gym-wide document, is not. A deleted conversation is counted, apart.
// - F-098: a login with an athlete record behind it and a role other than
//   athlete is counted, and so is a membership other than athlete held by an
//   athlete login; an athlete's own athlete membership and a coach's coach
//   membership are not.
//
// Real Postgres because the counts are joins across real tables.
//
// Spins up the disposable local-only embedded Postgres the other suites use.
// It NEVER connects to production or staging.

import { type ChildProcessByStdio, spawn } from 'node:child_process';
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
const DATA_DIR = path.join(os.tmpdir(), `ppbf-privacy-leftovers-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const CHECK_SCRIPT = path.resolve(__dirname, '../../../scripts/pilot-check-privacy-leftovers.mjs');
const FULL_SCHEMA_HELPER_PATH = path.resolve(__dirname, '../../../scripts/lib/full-schema.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const TEST_DB_NAME = 'ppbf_test_privacy_leftovers';

/* ts-jest compiles a plain `await import()` down to require(), which cannot
   load an ES module here. Building it through Function keeps a real dynamic
   import in the emitted code, honored under --experimental-vm-modules. */
const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

const ORG = 'org-xs-1';
const ATHLETE_X = 'ath-xs-x';
const ATHLETE_Y = 'ath-xs-y';
const COACH = 'acct-xs-coach';
const PARENT = 'acct-xs-parent';
const LOGIN_X = 'acct-xs-athlete-x';
const PROMOTED = 'acct-xs-promoted';
const ATHLETE_ONLY = 'acct-xs-athlete-only';

interface Report {
  cross_subject_citations: { total: number; by_asker_role: Array<Record<string, unknown>> };
  athlete_logins_with_staff_roles: {
    total: number;
    logins_by_role: Array<Record<string, unknown>>;
    memberships_by_role: Array<Record<string, unknown>>;
  };
}

interface CheckModule {
  countPrivacyLeftovers: (client: Client) => Promise<Report>;
  run: () => Promise<number>;
}

const NO_STAFF_ROLES = { total: 0, logins_by_role: [], memberships_by_role: [] };

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let db: Client;
let check: CheckModule;

function connectionStringFor(database: string): string {
  return `postgres://${PG_USER}:${PG_PASSWORD}@localhost:${PG_PORT}/${database}`;
}

async function freePort(): Promise<number> {
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

const uuid = async () => (await db.query<{ id: string }>('select gen_random_uuid()::text as id')).rows[0].id;

/** One conversation with one SHADOW answer that cites one Library document. */
async function cite(
  accountId: string,
  athleteId: string | null,
  documentId: string,
  options: { deleted?: boolean } = {},
): Promise<void> {
  const conversationId = await uuid();
  const assistantMessageId = await uuid();
  const bundleId = await uuid();
  const evidenceId = await uuid();
  await db.query(
    `insert into pilot.shadow_chat_sessions (conversation_id, organization_id, account_id, athlete_id, title, deleted_at)
     values ($1, $2, $3, $4, 'title', case when $5 then now() else null end)`,
    [conversationId, ORG, accountId, athleteId, options.deleted ?? false],
  );
  await db.query(
    `insert into pilot.shadow_chat_messages (message_id, conversation_id, organization_id, account_id, role, content, response_state)
     values ($1, $2, $3, $4, 'assistant', 'An answer.', 'ok')`,
    [assistantMessageId, conversationId, ORG, accountId],
  );
  await db.query(
    `insert into pilot.shadow_evidence_bundles (bundle_id, organization_id, account_id, query_sha256, availability, item_count)
     values ($1, $2, $3, repeat('a', 64), 'available', 1)`,
    [bundleId, ORG, accountId],
  );
  await db.query(
    `insert into pilot.shadow_evidence_items
       (evidence_id, bundle_id, organization_id, account_id, source_id, document_id, chunk_id, ordinal, excerpt_sha256, library_organization_id)
     values ($1, $2, $3, $4, 'src-xs', $5, 'chunk-' || $5, 1, repeat('b', 64), $3)`,
    [evidenceId, bundleId, ORG, accountId, documentId],
  );
  await db.query(
    `insert into pilot.shadow_message_citations (assistant_message_id, evidence_id, bundle_id, organization_id, account_id, ordinal)
     values ($1, $2, $3, $4, $5, 1)`,
    [assistantMessageId, evidenceId, bundleId, ORG, accountId],
  );
}

beforeAll(async () => {
  PG_PORT = await freePort();
  serverProcess = spawn(process.execPath, [SERVER_SCRIPT_PATH, DATA_DIR, String(PG_PORT)], {
    stdio: ['ignore', 'pipe', 'pipe'],
  }) as ChildProcessByStdio<null, Readable, Readable>;
  let stderrOutput = '';
  serverProcess.stderr.on('data', (chunk) => {
    stderrOutput += String(chunk);
  });
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      rl.close();
      reject(new Error(`Embedded Postgres did not become ready in time. stderr:\n${stderrOutput}`));
    }, 150_000);
    const rl = readline.createInterface({ input: serverProcess.stdout });
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

  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  await admin.query(`drop database if exists ${TEST_DB_NAME}`);
  await admin.query(`create database ${TEST_DB_NAME}`);
  await admin.end();

  db = new Client({ connectionString: connectionStringFor(TEST_DB_NAME) });
  await db.connect();
  const helper = await nativeDynamicImport(pathToFileURL(FULL_SCHEMA_HELPER_PATH).href);
  await (helper.applyFullSchema as (client: Client, opts?: { infraDir?: string }) => Promise<unknown>)(db, {
    infraDir: INFRA_DIR,
  });

  await db.query(
    `insert into pilot.organizations (organization_id, organization_name, status) values ($1, 'Gym', 'active')`,
    [ORG],
  );
  // The athlete login is linked to its record once the record exists.
  for (const [accountId, role] of [[COACH, 'coach'], [PARENT, 'parent'], [LOGIN_X, 'athlete']]) {
    await db.query(
      `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
       values ($1, $2, $3, 'microsoft')`,
      [accountId, role, ORG],
    );
  }
  await db.query(
    `insert into pilot.athletes
       (organization_id, athlete_id, full_name, dob, weight_class, gym_status,
        emergency_contact, active_flag, coach_id, created_at, updated_at)
     values
       ($1, $2, 'Athlete X', '2012-04-03', 'youth-60', 'active', 'Guardian', true, $4, now(), now()),
       ($1, $3, 'Athlete Y', '2011-02-09', 'youth-65', 'active', 'Guardian', true, $4, now(), now())`,
    [ORG, ATHLETE_X, ATHLETE_Y, COACH],
  );
  await db.query(`update pilot.accounts set athlete_id = $2 where account_id = $1`, [LOGIN_X, ATHLETE_X]);
  // Not leftovers: the athlete's own athlete membership, the coach's coach one.
  await db.query(
    `insert into pilot.organization_memberships (account_id, organization_id, role, active_flag)
     values ($1, $3, 'athlete', true), ($2, $3, 'coach', true)`,
    [LOGIN_X, COACH, ORG],
  );
  await db.query(
    `insert into pilot.shadow_library_sources (source_id, organization_id, title, source_type, authority_tier, rights_status)
     values ('src-xs', $1, 'Source', 'book', 1, 'ppbf_owned')`,
    [ORG],
  );
  // One document gym-wide, one filed against each athlete.
  for (const [documentId, subjectId] of [['doc-gym', null], ['doc-x', ATHLETE_X], ['doc-y', ATHLETE_Y]]) {
    await db.query(
      `insert into pilot.shadow_library_documents (document_id, source_id, organization_id, subject_id, document_name)
       values ($1, 'src-xs', $2, $3, 'DOCNAME-' || $1)`,
      [documentId, ORG, subjectId],
    );
    await db.query(
      `insert into pilot.shadow_library_chunks (chunk_id, document_id, source_id, organization_id, subject_id, ordinal, text_content)
       values ('chunk-' || $1, $1, 'src-xs', $2, $3, 1, 'text')`,
      [documentId, ORG, subjectId],
    );
  }

  check = (await nativeDynamicImport(pathToFileURL(CHECK_SCRIPT).href)) as unknown as CheckModule;
});

afterAll(async () => {
  await db?.end().catch(() => {});
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

async function runCheck(): Promise<number> {
  process.env.AZURE_POSTGRES_CONNECTION_STRING = connectionStringFor(TEST_DB_NAME);
  process.env.PPBF_POSTGRES_DISABLE_SSL = 'true';
  const log = jest.spyOn(console, 'log').mockImplementation(() => {});
  try {
    return await check.run();
  } finally {
    log.mockRestore();
  }
}

describe('the privacy leftovers check', () => {
  test('with only own-athlete and gym-wide citations and ordinary memberships it finds nothing and exits 0', async () => {
    await cite(LOGIN_X, ATHLETE_X, 'doc-x');
    await cite(PARENT, ATHLETE_X, 'doc-gym');
    await cite(COACH, ATHLETE_Y, 'doc-y');

    expect(await check.countPrivacyLeftovers(db)).toEqual({
      cross_subject_citations: { total: 0, by_asker_role: [] },
      athlete_logins_with_staff_roles: NO_STAFF_ROLES,
    });
    expect(await runCheck()).toBe(0);
  });

  test('F-099: a citation of another athlete\'s document is counted by the asker\'s role; a deleted conversation apart', async () => {
    // The parent's conversation about X cites Y's document; so does a deleted
    // one of theirs. The coach's conversation names no athlete and cites Y's.
    await cite(PARENT, ATHLETE_X, 'doc-y');
    await cite(PARENT, ATHLETE_X, 'doc-y', { deleted: true });
    await cite(COACH, null, 'doc-y');

    expect(await check.countPrivacyLeftovers(db)).toEqual({
      cross_subject_citations: {
        total: 3,
        by_asker_role: [
          { asker_role: 'coach', citations: 1, answers: 1, conversations: 1, citations_in_open_conversations: 1 },
          { asker_role: 'parent', citations: 2, answers: 2, conversations: 2, citations_in_open_conversations: 1 },
        ],
      },
      athlete_logins_with_staff_roles: NO_STAFF_ROLES,
    });
    expect(await runCheck()).toBe(2);
  });

  test('F-098: an athlete login holding a staff role or membership is counted, live ones apart', async () => {
    // What the old assign-admin left: Y's login made the gym's admin with its
    // athlete record kept. And an athlete login with no record behind it that
    // holds a coach membership, switched off.
    await db.query(
      `insert into pilot.accounts (account_id, role, organization_id, athlete_id, auth_provider)
       values ($1, 'organization_admin', $3, $4, 'ppbf_local'), ($2, 'athlete', $3, null, 'ppbf_local')`,
      [PROMOTED, ATHLETE_ONLY, ORG, ATHLETE_Y],
    );
    await db.query(
      `insert into pilot.organization_memberships (account_id, organization_id, role, active_flag)
       values ($1, $3, 'organization_admin', true), ($2, $3, 'coach', false)`,
      [PROMOTED, ATHLETE_ONLY, ORG],
    );

    const report = await check.countPrivacyLeftovers(db);
    expect(report.athlete_logins_with_staff_roles).toEqual({
      total: 3,
      logins_by_role: [{ role: 'organization_admin', logins: 1, live: 1 }],
      memberships_by_role: [
        { role: 'coach', memberships: 1, live: 0 },
        { role: 'organization_admin', memberships: 1, live: 1 },
      ],
    });
    expect(report.cross_subject_citations.total).toBe(3);
    expect(await runCheck()).toBe(2);
  });

  test('it prints counts only: no document name, account id or athlete id', async () => {
    process.env.AZURE_POSTGRES_CONNECTION_STRING = connectionStringFor(TEST_DB_NAME);
    process.env.PPBF_POSTGRES_DISABLE_SSL = 'true';
    const lines: string[] = [];
    const log = jest.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    });
    try {
      await check.run();
    } finally {
      log.mockRestore();
    }
    const text = lines.join('\n');
    expect(text).toContain('"event":"privacy_leftovers.checked"');
    for (const secret of [PARENT, COACH, LOGIN_X, PROMOTED, ATHLETE_ONLY, ATHLETE_X, ATHLETE_Y, 'doc-y', 'DOCNAME-', 'Athlete X']) {
      expect(text).not.toContain(secret);
    }
  });
});
