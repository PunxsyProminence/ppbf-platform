// Real PostgreSQL proof that an athlete's or parent's auto-filed, unanswered
// SHADOW question does not outlive its asker's deletion (F-054, Codex P1 on
// #1575): the mark (deleteAthleteRecord / deleteGuardianAccount) hides it from
// every reader and the retention purge (scripts/pilot-cleanup-deleted-data.mjs)
// deletes it.
//
// Spins up the disposable local-only embedded Postgres the other suites use.
// It NEVER connects to production or staging.

import { type ChildProcessByStdio, execFile, spawn } from 'node:child_process';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import type { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';

import { NextRequest } from 'next/server';
import { Client } from 'pg';

import type { PilotPrincipal } from './auth';
import { requirePrincipal } from './http';

jest.mock('./http', () => {
  const actual = jest.requireActual('./http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.setTimeout(240_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-asker-question-deletion-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const CLEANUP_SCRIPT = path.resolve(__dirname, '../../../scripts/pilot-cleanup-deleted-data.mjs');
const FULL_SCHEMA_HELPER_PATH = path.resolve(__dirname, '../../../scripts/lib/full-schema.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const TEST_DB_NAME = 'ppbf_test_asker_question_deletion';

/* ts-jest compiles a plain `await import()` down to require(), which cannot
   load an ES module here. Building it through Function keeps a real dynamic
   import in the emitted code, honored under --experimental-vm-modules. */
const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

const ORG = 'org-ad-1';
const ATHLETE_A = 'ath-ad-a';
const ATHLETE_C = 'ath-ad-c';
const CHILD_D = 'ath-ad-d';
const A_WORDS = 'ZEBRA-ATHLETE-7731 my coach hits me and I am scared to go to the gym';
const C_WORDS = 'OTTER-CONTROL-2208 how long should I rest between rounds';
const P_WORDS = 'QUOKKA-PARENT-4419 my son says an adult at the gym touched him';
const P2_WORDS = 'LLAMA-PARENT-8812 who do I talk to about a worry I have';

const mockRequirePrincipal = requirePrincipal as jest.MockedFunction<typeof requirePrincipal>;

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let db: Client;
let listGet: (request: NextRequest) => Promise<Response>;
let requirementsPost: (request: NextRequest) => Promise<Response>;
let submissionsGet: (request: NextRequest) => Promise<Response>;
let fileQuestion: typeof import('./shadowResearchFiling').fileUnansweredShadowQuestion;
let deleteAthleteRecord: typeof import('./dataDeletion').deleteAthleteRecord;
let deleteGuardianAccount: typeof import('./dataDeletion').deleteGuardianAccount;

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
        return;
      }
      server.close(() => reject(new Error('Could not determine a free port')));
    });
  });
}

function principal(overrides: Partial<PilotPrincipal> & Pick<PilotPrincipal, 'accountId' | 'role'>): PilotPrincipal {
  return {
    organizationId: ORG,
    athleteId: null,
    sessionToken: 'token',
    authProvider: 'microsoft',
    ...overrides,
  } as PilotPrincipal;
}

const ADMIN = { accountId: 'acct-ad-admin', role: 'organization_admin' as const, organizationId: ORG };
const AS = {
  admin: () => principal({ accountId: 'acct-ad-admin', role: 'organization_admin' }),
  coach: () => principal({ accountId: 'acct-ad-coach', role: 'coach' }),
  athleteC: () => principal({ accountId: 'acct-ad-athlete-c', role: 'athlete', athleteId: ATHLETE_C }),
  parent: () => principal({ accountId: 'acct-ad-parent', role: 'parent' }),
} as const;

async function listText(actor: PilotPrincipal): Promise<string> {
  mockRequirePrincipal.mockResolvedValue(actor);
  const response = await listGet(new NextRequest('http://localhost/api/pilot/shadow/research-requirements'));
  return response.text();
}

const rowCount = async (where: string) =>
  Number((await db.query(
    `select count(*)::int as n from pilot.shadow_research_requirements where organization_id = $1 and ${where}`,
    [ORG],
  )).rows[0].n);

function runCleanupScript(extraEnv: Record<string, string>) {
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    execFile(
      process.execPath,
      [CLEANUP_SCRIPT],
      {
        env: {
          ...process.env,
          AZURE_POSTGRES_CONNECTION_STRING: connectionStringFor(TEST_DB_NAME),
          PPBF_EXPECTED_POSTGRES_HOSTNAME: 'localhost',
          PPBF_EXPECTED_POSTGRES_DATABASE: TEST_DB_NAME,
          PPBF_POSTGRES_DISABLE_SSL: 'true',
          ...extraEnv,
        },
      },
      (_error, stdout, stderr) => {
        const line = `${stdout}${stderr}`.split('\n').find((entry) => entry.trim().startsWith('{'));
        if (!line) {
          reject(new Error(`No JSON output. stdout=${stdout} stderr=${stderr}`));
          return;
        }
        resolve(JSON.parse(line) as Record<string, unknown>);
      },
    );
  });
}

beforeAll(async () => {
  PG_PORT = await freePort();

  serverProcess = spawn(
    process.execPath,
    [SERVER_SCRIPT_PATH, DATA_DIR, String(PG_PORT)],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  ) as ChildProcessByStdio<null, Readable, Readable>;
  let stderrOutput = '';
  serverProcess.stderr.on('data', (chunk) => {
    stderrOutput += String(chunk);
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
    `insert into pilot.organizations (organization_id, organization_name, status) values ($1, 'Punxsy Prominence', 'active')`,
    [ORG],
  );
  const accounts: Array<[string, string, string | null]> = [
    ['acct-ad-admin', 'organization_admin', null],
    ['acct-ad-coach', 'coach', null],
    ['acct-ad-athlete-a', 'athlete', ATHLETE_A],
    ['acct-ad-athlete-c', 'athlete', ATHLETE_C],
    ['acct-ad-parent', 'parent', null],
    ['acct-ad-parent-2', 'parent', null],
  ];
  for (const [accountId, role, athleteId] of accounts) {
    await db.query(
      `insert into pilot.accounts (account_id, role, organization_id, athlete_id, auth_provider)
       values ($1, $2, $3, $4, 'microsoft')`,
      [accountId, role, ORG, athleteId],
    );
  }
  await db.query(
    `insert into pilot.athletes
       (organization_id, athlete_id, full_name, dob, weight_class, gym_status,
        emergency_contact, active_flag, coach_id, created_at, updated_at)
     values
       ($1, $2, 'Rosa Ortiz', '2012-04-03', 'youth-60', 'active', 'Guardian', true, 'acct-ad-coach', now(), now()),
       ($1, $3, 'Sam Rivera', '2011-02-09', 'youth-65', 'active', 'Guardian', true, 'acct-ad-coach', now(), now()),
       ($1, $4, 'Dee Park', '2013-06-01', 'youth-55', 'active', 'Guardian', true, 'acct-ad-coach', now(), now())`,
    [ORG, ATHLETE_A, ATHLETE_C, CHILD_D],
  );
  await db.query(
    `insert into pilot.parents (organization_id, parent_id, account_id, full_name, phone, email)
     values ($1, 'par-ad-p', 'acct-ad-parent', 'Dana Park', '555-0100', 'p@example.test'),
            ($1, 'par-ad-p2', 'acct-ad-parent-2', 'Robin Hale', '555-0200', 'p2@example.test')`,
    [ORG],
  );
  await db.query(
    `insert into pilot.guardian_links (organization_id, parent_id, athlete_id, relationship_to_athlete)
     values ($1, 'par-ad-p', $2, 'mother')`,
    [ORG, CHILD_D],
  );

  process.env.AZURE_POSTGRES_CONNECTION_STRING = connectionStringFor(TEST_DB_NAME);
  process.env.PPBF_POSTGRES_DISABLE_SSL = 'true';

  listGet = (await import('@/app/api/pilot/shadow/research-requirements/route')).GET;
  requirementsPost = (await import('@/app/api/pilot/shadow/research-requirements/route')).POST;
  submissionsGet = (await import('@/app/api/pilot/shadow/research-submissions/route')).GET;
  fileQuestion = (await import('./shadowResearchFiling')).fileUnansweredShadowQuestion;
  const deletion = await import('./dataDeletion');
  deleteAthleteRecord = deletion.deleteAthleteRecord;
  deleteGuardianAccount = deletion.deleteGuardianAccount;

  // Filed by the real function, as the chat route calls it.
  await fileQuestion({ organizationId: ORG, accountId: 'acct-ad-athlete-a', role: 'athlete', question: A_WORDS, askerAthleteId: ATHLETE_A });
  await fileQuestion({ organizationId: ORG, accountId: 'acct-ad-athlete-c', role: 'athlete', question: C_WORDS, askerAthleteId: ATHLETE_C });
  await fileQuestion({ organizationId: ORG, accountId: 'acct-ad-parent', role: 'parent', question: P_WORDS, athleteId: CHILD_D });
  // A parent asking with no child named: tied to the account alone.
  await fileQuestion({ organizationId: ORG, accountId: 'acct-ad-parent-2', role: 'parent', question: P2_WORDS });
  // A coach's own research filing about athlete A: research work, not A's words.
  await fileQuestion({ organizationId: ORG, accountId: 'acct-ad-coach', role: 'coach', question: 'COACHFILED-5521 rest between rounds', athleteId: ATHLETE_A });
});

afterAll(async () => {
  const { closePool } = await import('./db');
  await closePool().catch(() => {});
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

describe('an asker question and its asker deletion', () => {
  test('before any deletion the organization admin reads all three, each asker row tied to its athlete', async () => {
    const text = await listText(AS.admin());
    for (const words of ['ZEBRA-ATHLETE-7731', 'OTTER-CONTROL-2208', 'QUOKKA-PARENT-4419', 'LLAMA-PARENT-8812']) {
      expect(text).toContain(words);
    }
    const tied = await db.query(
      `select metadata->>'asker_athlete_id' as a from pilot.shadow_research_requirements
        where organization_id = $1 and source_entity_type = 'shadow_asker_question' order by research_requirement_id`,
      [ORG],
    );
    expect(tied.rows.map((row) => row.a)).toEqual([ATHLETE_A, ATHLETE_C, CHILD_D, null]);
  });

  test('deleting the athlete hides the row from every reader at once, and leaves the others', async () => {
    await deleteAthleteRecord(ADMIN, ATHLETE_A, 'Left the gym');
    for (const actor of [AS.admin(), AS.coach(), AS.athleteC(), AS.parent()]) {
      const text = await listText(actor);
      expect(text).not.toContain('ZEBRA-ATHLETE-7731');
    }
    const admin = await listText(AS.admin());
    expect(admin).toContain('OTTER-CONTROL-2208');
    expect(admin).toContain('QUOKKA-PARENT-4419');
    // The mark hides; it does not erase before retention.
    expect(await rowCount(`research_requirement like '%ZEBRA-ATHLETE-7731%'`)).toBe(1);
  });

  test('a marked-deleted asker row is unreachable by id too: resolve and the submissions read answer as for a missing row', async () => {
    const found = await db.query(
      `select research_requirement_id from pilot.shadow_research_requirements
        where organization_id = $1 and research_requirement like '%ZEBRA-ATHLETE-7731%'`,
      [ORG],
    );
    const id = Number(found.rows[0].research_requirement_id);

    for (const actor of [AS.admin(), AS.coach()]) {
      mockRequirePrincipal.mockResolvedValue(actor);
      const resolved = await requirementsPost(new NextRequest('http://localhost/api/pilot/shadow/research-requirements', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'resolve', research_requirement_id: id, closing_note: 'Done.' }),
      }));
      expect(resolved.status).toBe(404);
    }
    mockRequirePrincipal.mockResolvedValue(AS.admin());
    const submissions = await submissionsGet(new NextRequest(
      `http://localhost/api/pilot/shadow/research-submissions?research_requirement_id=${id}`,
    ));
    expect(submissions.status).toBe(404);
    const batch = await submissionsGet(new NextRequest(
      `http://localhost/api/pilot/shadow/research-submissions?research_requirement_ids=${id}`,
    ));
    expect(await batch.text()).not.toContain(`"${id}"`);

    // Still open in the table: the mark hides it, the purge is what deletes.
    const still = await db.query(
      `select status from pilot.shadow_research_requirements where research_requirement_id = $1`,
      [id],
    );
    expect(still.rows[0].status).toBe('open');
  });

  test('the retention purge deletes the athlete asker row, and no other asker row', async () => {
    await db.query(
      `update pilot.athletes set deleted_at = now() - interval '3 years' where organization_id = $1 and athlete_id = $2`,
      [ORG, ATHLETE_A],
    );
    const event = await runCleanupScript({ PPBF_RETENTION_APPLY: 'true' });
    expect(event.event).toBe('retention.cleanup.completed');
    expect(event.blocked_by ?? {}).toEqual({});
    expect(event.asker_research_questions_deleted).toBe(1);

    expect(await rowCount(`research_requirement like '%ZEBRA-ATHLETE-7731%'`)).toBe(0);
    expect(await rowCount(`research_requirement like '%OTTER-CONTROL-2208%'`)).toBe(1);
    expect(await rowCount(`research_requirement like '%QUOKKA-PARENT-4419%'`)).toBe(1);
    // The coach's own filing ABOUT A (subject_id = A) goes with A (F-079,
    // subjectResearchPurge.pg.test.ts), counted as a subject row, not an asker
    // question.
    expect(event.subject_research_requirements_deleted).toBe(1);
    expect(await rowCount(`research_requirement like '%COACHFILED-5521%'`)).toBe(0);
  });

  test('deleting the guardian hides the parent row, and the purge deletes it with the account', async () => {
    await deleteGuardianAccount(ADMIN, 'acct-ad-parent', 'Family left');
    const hidden = await listText(AS.admin());
    expect(hidden).not.toContain('QUOKKA-PARENT-4419');
    expect(hidden).toContain('OTTER-CONTROL-2208');

    await db.query(`update pilot.accounts set deleted_at = now() - interval '3 years' where account_id = 'acct-ad-parent'`);
    await db.query(
      `update pilot.athletes set deleted_at = now() - interval '3 years' where organization_id = $1 and athlete_id = $2`,
      [ORG, CHILD_D],
    );
    const event = await runCleanupScript({ PPBF_RETENTION_APPLY: 'true' });
    expect(event.event).toBe('retention.cleanup.completed');
    expect(event.asker_research_questions_deleted).toBe(1);
    expect(await rowCount(`research_requirement like '%QUOKKA-PARENT-4419%'`)).toBe(0);
    expect(await rowCount(`research_requirement like '%OTTER-CONTROL-2208%'`)).toBe(1);
  });

  test('a parent who named no child is tied to the account alone: hidden at the mark, deleted with the account', async () => {
    expect(await rowCount(`research_requirement like '%LLAMA-PARENT-8812%'`)).toBe(1);
    await deleteGuardianAccount(ADMIN, 'acct-ad-parent-2', 'Family left');
    expect(await listText(AS.admin())).not.toContain('LLAMA-PARENT-8812');
    expect(await rowCount(`research_requirement like '%LLAMA-PARENT-8812%'`)).toBe(1);

    await db.query(`update pilot.accounts set deleted_at = now() - interval '3 years' where account_id = 'acct-ad-parent-2'`);
    const event = await runCleanupScript({ PPBF_RETENTION_APPLY: 'true' });
    expect(event.event).toBe('retention.cleanup.completed');
    expect(event.asker_research_questions_deleted).toBe(1);
    expect(await rowCount(`research_requirement like '%LLAMA-PARENT-8812%'`)).toBe(0);
  });

  test('a dry run reports what it would delete and deletes nothing', async () => {
    await fileQuestion({
      organizationId: ORG, accountId: 'acct-ad-athlete-c', role: 'athlete',
      question: 'OTTER-CONTROL-9999 second question', askerAthleteId: ATHLETE_C,
    });
    await deleteAthleteRecord(ADMIN, ATHLETE_C, 'Left the gym');
    await db.query(
      `update pilot.athletes set deleted_at = now() - interval '3 years' where organization_id = $1 and athlete_id = $2`,
      [ORG, ATHLETE_C],
    );
    const dry = await runCleanupScript({ PPBF_RETENTION_APPLY: 'false' });
    expect(dry.would_delete_asker_research_questions).toBe(2);
    expect(await rowCount(`source_entity_type = 'shadow_asker_question'`)).toBe(2);
    const applied = await runCleanupScript({ PPBF_RETENTION_APPLY: 'true' });
    expect(applied.asker_research_questions_deleted).toBe(2);
    expect(await rowCount(`source_entity_type = 'shadow_asker_question'`)).toBe(0);
  });
});
