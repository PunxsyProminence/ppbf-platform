// Real PostgreSQL proof of who reads an athlete's or parent's auto-filed,
// unanswered SHADOW question (F-054; Jason 2026-10-13 "A: Office + asker
// (Recommended)", on OD-2026-10-07-009 ruling 4: a child's words are not for
// the whole coaching staff).
//
// The rows are filed by the REAL fileUnansweredShadowQuestion against the real
// table, and read back through the REAL route handlers with the real access
// gates; only requirePrincipal is stubbed. Rules under test:
//   - the organization admin reads the words;
//   - the asker reads their own;
//   - a coach receives the row (it exists, it is open) with a fixed sentence
//     in place of the words, and no asker id and no key;
//   - another athlete, the asker's guardians, another guardian of the same
//     child, and the other gym read nothing of it;
//   - the free text staff write on the row (its closing note, a submission's
//     note, review note and provenance) reaches the organization admin whole,
//     and a coach as one fixed sentence (lane L52).
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
const DATA_DIR = path.join(os.tmpdir(), `ppbf-asker-question-reads-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const FULL_SCHEMA_HELPER_PATH = path.resolve(__dirname, '../../../scripts/lib/full-schema.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const TEST_DB_NAME = 'ppbf_test_asker_question_reads';

/* ts-jest compiles a plain `await import()` down to require(), which cannot
   load an ES module here. Building it through Function keeps a real dynamic
   import in the emitted code, honored under --experimental-vm-modules. */
const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

const ORG = 'org-aq-1';
const OTHER_ORG = 'org-aq-2';
const ATHLETE_A = 'ath-aq-a';
const ATHLETE_B = 'ath-aq-b';

/** Distinctive words, so a leak anywhere in a serialized body is a string match. */
const ATHLETE_WORDS = 'ZEBRA-ATHLETE-7731 my coach hits me and I am scared to go to the gym';
const PARENT_WORDS = 'QUOKKA-PARENT-4419 my son says an adult at the gym touched him';
const ATHLETE_FRAGMENT = 'ZEBRA-ATHLETE-7731';
const PARENT_FRAGMENT = 'QUOKKA-PARENT-4419';
const COACH_SENTENCE = 'A question from an athlete or parent that SHADOW could not answer. The gym administrator can read it.';
const NOTE_SENTENCE = 'The gym administrator can read this note.';
/* Staff free text on the athlete's row, each findable by its tag. */
const CLOSING_NOTE = 'OKAPI-CLOSING-5521 answered with the family about her coach.';
const STAFF_TEXT = {
  submission_note: 'OKAPI-SUBMISSION-5522 what to do when a coach hits a kid',
  review_note: 'OKAPI-REVIEW-5523 covers what she asked',
  provenance: 'OKAPI-PROVENANCE-5524 searched for coach hitting',
};
const STAFF_TAG = 'OKAPI-';

const mockRequirePrincipal = requirePrincipal as jest.MockedFunction<typeof requirePrincipal>;

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let db: Client;
let listGet: (request: NextRequest) => Promise<Response>;
let requirementsPost: (request: NextRequest) => Promise<Response>;
let submissionsGet: (request: NextRequest) => Promise<Response>;
let fileQuestion: typeof import('./shadowResearchFiling').fileUnansweredShadowQuestion;
const ids: { athleteRow?: number; parentRow?: number } = {};

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

const AS = {
  admin: () => principal({ accountId: 'acct-aq-admin', role: 'organization_admin' }),
  coach: () => principal({ accountId: 'acct-aq-coach', role: 'coach' }),
  athleteA: () => principal({ accountId: 'acct-aq-athlete-a', role: 'athlete', athleteId: ATHLETE_A }),
  athleteB: () => principal({ accountId: 'acct-aq-athlete-b', role: 'athlete', athleteId: ATHLETE_B }),
  guardianOfA: () => principal({ accountId: 'acct-aq-guardian-a', role: 'parent' }),
  guardianB1: () => principal({ accountId: 'acct-aq-guardian-b1', role: 'parent' }),
  guardianB2: () => principal({ accountId: 'acct-aq-guardian-b2', role: 'parent' }),
  otherOrgCoach: () => principal({ accountId: 'acct-aq-coach-org2', role: 'coach', organizationId: OTHER_ORG }),
  otherOrgAdmin: () => principal({ accountId: 'acct-aq-admin-org2', role: 'organization_admin', organizationId: OTHER_ORG }),
} as const;

interface Listed {
  status: number;
  /** The WHOLE response body as the reader receives it. */
  text: string;
  items: Array<Record<string, unknown>>;
}

async function listAs(actor: PilotPrincipal): Promise<Listed> {
  mockRequirePrincipal.mockResolvedValue(actor);
  const response = await listGet(new NextRequest('http://localhost/api/pilot/shadow/research-requirements'));
  const text = await response.text();
  let items: Array<Record<string, unknown>> = [];
  try {
    items = (JSON.parse(text) as { items?: Array<Record<string, unknown>> }).items ?? [];
  } catch {
    items = [];
  }
  return { status: response.status, text, items };
}

const idsOf = (listed: Listed): number[] => listed.items.map((item) => Number(item.research_requirement_id));

async function submissionsAs(actor: PilotPrincipal, requirementId: number): Promise<Listed> {
  mockRequirePrincipal.mockResolvedValue(actor);
  const response = await submissionsGet(new NextRequest(
    `http://localhost/api/pilot/shadow/research-submissions?research_requirement_id=${requirementId}`,
  ));
  const text = await response.text();
  let items: Array<Record<string, unknown>> = [];
  try {
    items = (JSON.parse(text) as { items?: Array<Record<string, unknown>> }).items ?? [];
  } catch {
    items = [];
  }
  return { status: response.status, text, items };
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
    `insert into pilot.organizations (organization_id, organization_name, status)
     values ($1, 'Punxsy Prominence', 'active'), ($2, 'Another Gym', 'active')`,
    [ORG, OTHER_ORG],
  );

  const accounts: Array<[string, string, string, string | null]> = [
    ['acct-aq-admin', 'organization_admin', ORG, null],
    ['acct-aq-coach', 'coach', ORG, null],
    ['acct-aq-athlete-a', 'athlete', ORG, ATHLETE_A],
    ['acct-aq-athlete-b', 'athlete', ORG, ATHLETE_B],
    ['acct-aq-guardian-a', 'parent', ORG, null],
    ['acct-aq-guardian-b1', 'parent', ORG, null],
    ['acct-aq-guardian-b2', 'parent', ORG, null],
    ['acct-aq-coach-org2', 'coach', OTHER_ORG, null],
    ['acct-aq-admin-org2', 'organization_admin', OTHER_ORG, null],
  ];
  for (const [accountId, role, organizationId, athleteId] of accounts) {
    await db.query(
      `insert into pilot.accounts (account_id, role, organization_id, athlete_id, auth_provider)
       values ($1, $2, $3, $4, 'microsoft')`,
      [accountId, role, organizationId, athleteId],
    );
  }

  await db.query(
    `insert into pilot.athletes
       (organization_id, athlete_id, full_name, dob, weight_class, gym_status,
        emergency_contact, active_flag, coach_id, created_at, updated_at)
     values
       ($1, $2, 'Rosa Ortiz', '2012-04-03', 'youth-60', 'active', 'Guardian', true, 'acct-aq-coach', now(), now()),
       ($1, $3, 'Sam Rivera', '2011-02-09', 'youth-65', 'active', 'Guardian', true, 'acct-aq-coach', now(), now())`,
    [ORG, ATHLETE_A, ATHLETE_B],
  );
  await db.query(
    `insert into pilot.parents (organization_id, parent_id, account_id, full_name, phone, email)
     values
       ($1, 'par-aq-a', 'acct-aq-guardian-a', 'Guardian of A', '555-0100', 'a@example.test'),
       ($1, 'par-aq-b1', 'acct-aq-guardian-b1', 'Guardian B1', '555-0200', 'b1@example.test'),
       ($1, 'par-aq-b2', 'acct-aq-guardian-b2', 'Guardian B2', '555-0300', 'b2@example.test')`,
    [ORG],
  );
  await db.query(
    `insert into pilot.guardian_links (organization_id, parent_id, athlete_id, relationship_to_athlete)
     values ($1, 'par-aq-a', $2, 'mother'), ($1, 'par-aq-b1', $3, 'father'), ($1, 'par-aq-b2', $3, 'mother')`,
    [ORG, ATHLETE_A, ATHLETE_B],
  );

  process.env.AZURE_POSTGRES_CONNECTION_STRING = connectionStringFor(TEST_DB_NAME);
  process.env.PPBF_POSTGRES_DISABLE_SSL = 'true';

  listGet = (await import('@/app/api/pilot/shadow/research-requirements/route')).GET;
  requirementsPost = (await import('@/app/api/pilot/shadow/research-requirements/route')).POST;
  submissionsGet = (await import('@/app/api/pilot/shadow/research-submissions/route')).GET;
  fileQuestion = (await import('./shadowResearchFiling')).fileUnansweredShadowQuestion;

  // Filed by the real function, as the chat route calls it. The athlete is
  // talking about themselves (athleteId passed), the parent about their son.
  expect(await fileQuestion({
    organizationId: ORG, accountId: 'acct-aq-athlete-a', role: 'athlete', question: ATHLETE_WORDS, athleteId: ATHLETE_A,
  })).toBe(true);
  expect(await fileQuestion({
    organizationId: ORG, accountId: 'acct-aq-guardian-b1', role: 'parent', question: PARENT_WORDS, athleteId: ATHLETE_B,
  })).toBe(true);

  const rows = await db.query<{ research_requirement_id: number; created_by_account_id: string }>(
    `select research_requirement_id, created_by_account_id from pilot.shadow_research_requirements
      where organization_id = $1 order by research_requirement_id`,
    [ORG],
  );
  ids.athleteRow = Number(rows.rows.find((row) => row.created_by_account_id === 'acct-aq-athlete-a')?.research_requirement_id);
  ids.parentRow = Number(rows.rows.find((row) => row.created_by_account_id === 'acct-aq-guardian-b1')?.research_requirement_id);

  // A source a coach submitted against the athlete's question and the
  // organization admin reviewed, with staff free text in every note.
  await db.query(
    `insert into pilot.shadow_library_sources (source_id, organization_id, title, source_type, authority_tier)
     values ('src-aq-1', $1, 'Coach conduct guidance', 'peer_reviewed', 2)`,
    [ORG],
  );
  await db.query(
    `insert into pilot.shadow_research_submissions
       (organization_id, submission_id, research_requirement_id, source_id, provenance, submission_note,
        applicability_state, reviewed_by_account_id, reviewed_at, review_note, submitted_by_account_id)
     values ($1, 'sub-aq-1', $2, 'src-aq-1', $3::jsonb, $4, 'responsive', 'acct-aq-admin', now(), $5, 'acct-aq-coach')`,
    [ORG, ids.athleteRow, JSON.stringify({ found_via: STAFF_TEXT.provenance }), STAFF_TEXT.submission_note, STAFF_TEXT.review_note],
  );
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

describe('the fixture', () => {
  test('two subject-less rows exist, filed by the asking accounts, carrying the words', async () => {
    const rows = await db.query<{ subject_id: string | null; research_requirement: string; created_by_role: string }>(
      `select subject_id, research_requirement, created_by_role from pilot.shadow_research_requirements
        where organization_id = $1 and source_event_name = 'shadow_unanswered_question' order by research_requirement_id`,
      [ORG],
    );
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows.every((row) => row.subject_id === null)).toBe(true);
    expect(rows.rows.map((row) => row.created_by_role).sort()).toEqual(['athlete', 'parent']);
    expect(rows.rows.map((row) => row.research_requirement).join(' ')).toContain(ATHLETE_FRAGMENT);
    expect(ids.athleteRow).toBeGreaterThan(0);
    expect(ids.parentRow).toBeGreaterThan(0);
  });
});

describe('who reads an athlete\'s or parent\'s unanswered question', () => {
  test('the organization admin reads both, words and all', async () => {
    const listed = await listAs(AS.admin());
    expect(listed.status).toBe(200);
    expect(idsOf(listed)).toEqual(expect.arrayContaining([ids.athleteRow, ids.parentRow]));
    expect(listed.text).toContain(ATHLETE_FRAGMENT);
    expect(listed.text).toContain(PARENT_FRAGMENT);
  });

  test('a coach sees that both exist and are open, and none of the words, keys or asker ids', async () => {
    const listed = await listAs(AS.coach());
    expect(listed.status).toBe(200);
    expect(idsOf(listed)).toEqual(expect.arrayContaining([ids.athleteRow, ids.parentRow]));
    for (const item of listed.items) {
      if (item.source_event_name !== 'shadow_unanswered_question') continue;
      expect(item.status).toBe('open');
      expect(item.research_requirement).toBe(COACH_SENTENCE);
      expect(item.knowledge_gap).toBe(COACH_SENTENCE);
    }
    for (const leak of [ATHLETE_FRAGMENT, PARENT_FRAGMENT, 'scared', 'touched him', 'acct-aq-athlete-a', 'acct-aq-guardian-b1', 'acct:']) {
      expect(listed.text).not.toContain(leak);
    }
  });

  test('a coach closing one gets no row back, so no words', async () => {
    mockRequirePrincipal.mockResolvedValue(AS.coach());
    const response = await requirementsPost(new NextRequest('http://localhost/api/pilot/shadow/research-requirements', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        action: 'resolve',
        research_requirement_id: ids.athleteRow,
        closing_note: CLOSING_NOTE,
      }),
    }));
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(JSON.parse(text)).toEqual({ ok: true, resolved: true });
    for (const leak of [ATHLETE_FRAGMENT, 'scared', 'acct-aq-athlete-a', 'acct:']) {
      expect(text).not.toContain(leak);
    }
  });

  test('the asker reads their own words and not the other asker\'s', async () => {
    const athlete = await listAs(AS.athleteA());
    expect(athlete.status).toBe(200);
    expect(idsOf(athlete)).toEqual([ids.athleteRow]);
    expect(athlete.text).toContain(ATHLETE_FRAGMENT);
    expect(athlete.text).not.toContain(PARENT_FRAGMENT);

    const parent = await listAs(AS.guardianB1());
    expect(parent.status).toBe(200);
    expect(idsOf(parent)).toEqual([ids.parentRow]);
    expect(parent.text).toContain(PARENT_FRAGMENT);
    expect(parent.text).not.toContain(ATHLETE_FRAGMENT);
  });

  test.each([
    ['another athlete', AS.athleteB],
    ['the asking athlete\'s guardian', AS.guardianOfA],
    ['the other guardian of the asking parent\'s child', AS.guardianB2],
  ])('%s reads neither row nor any of the words', async (_label, actor) => {
    const listed = await listAs(actor());
    expect(listed.status).toBe(200);
    expect(idsOf(listed)).toEqual([]);
    for (const leak of [ATHLETE_FRAGMENT, PARENT_FRAGMENT, 'scared', 'touched him']) {
      expect(listed.text).not.toContain(leak);
    }
  });

  test('the other gym\'s coach and organization admin read neither row', async () => {
    for (const actor of [AS.otherOrgCoach(), AS.otherOrgAdmin()]) {
      const listed = await listAs(actor);
      expect(idsOf(listed)).toEqual([]);
      expect(listed.text).not.toContain(ATHLETE_FRAGMENT);
      expect(listed.text).not.toContain(PARENT_FRAGMENT);
    }
  });
});

describe('after a coach closes one, and the other ways in', () => {
  test('the coach list shows it resolved with the sentence, and the asker sees the closing note', async () => {
    // Closed in the "a coach closing one gets no row back" test above.
    const coach = await listAs(AS.coach());
    const row = coach.items.find((item) => Number(item.research_requirement_id) === ids.athleteRow);
    expect(row).toMatchObject({ status: 'resolved', research_requirement: COACH_SENTENCE });
    expect(coach.text).not.toContain(ATHLETE_FRAGMENT);

    const asker = await listAs(AS.athleteA());
    const own = asker.items.find((item) => Number(item.research_requirement_id) === ids.athleteRow);
    expect(own).toMatchObject({ status: 'resolved', is_mine: true });
    expect((own?.metadata as { closing_note?: string }).closing_note).toBe(CLOSING_NOTE);
  });

  // Lane L52: the closing note is staff free text about the question.
  test('the coach list carries the note sentence in place of the closing note; the organization admin reads it', async () => {
    const coach = await listAs(AS.coach());
    const row = coach.items.find((item) => Number(item.research_requirement_id) === ids.athleteRow);
    expect((row?.metadata as { closing_note?: string }).closing_note).toBe(NOTE_SENTENCE);
    expect(coach.text).not.toContain(STAFF_TAG);

    const admin = await listAs(AS.admin());
    const whole = admin.items.find((item) => Number(item.research_requirement_id) === ids.athleteRow);
    expect((whole?.metadata as { closing_note?: string }).closing_note).toBe(CLOSING_NOTE);
  });

  test('asking the same words again reaches the same row; another asker of them gets their own', async () => {
    const before = await db.query(
      `select count(*)::int as n from pilot.shadow_research_requirements where organization_id = $1`,
      [ORG],
    );
    await fileQuestion({
      organizationId: ORG, accountId: 'acct-aq-guardian-b1', role: 'parent', question: PARENT_WORDS, athleteId: ATHLETE_B,
    });
    const same = await db.query(
      `select count(*)::int as n from pilot.shadow_research_requirements where organization_id = $1`,
      [ORG],
    );
    expect(same.rows[0].n).toBe(before.rows[0].n);

    await fileQuestion({
      organizationId: ORG, accountId: 'acct-aq-guardian-b2', role: 'parent', question: PARENT_WORDS, athleteId: ATHLETE_B,
    });
    const other = await db.query(
      `select count(*)::int as n from pilot.shadow_research_requirements where organization_id = $1`,
      [ORG],
    );
    expect(other.rows[0].n).toBe(before.rows[0].n + 1);

    // And that second asker reads theirs, not the first asker's.
    const listed = await listAs(AS.guardianB2());
    expect(listed.items).toHaveLength(1);
    expect(listed.text).toContain(PARENT_FRAGMENT);
  });

  test('a coach cannot create a row under the asker entity type, so no key can be pre-claimed', async () => {
    mockRequirePrincipal.mockResolvedValue(AS.coach());
    const response = await requirementsPost(new NextRequest('http://localhost/api/pilot/shadow/research-requirements', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        action: 'create',
        source_event_name: 'shadow_unanswered_question',
        source_entity_type: 'shadow_asker_question',
        source_entity_id: 'acct:acct-aq-athlete-a:whatever',
        research_requirement: 'pre-claim',
        knowledge_gap: 'pre-claim',
      }),
    }));
    expect(response.status).toBe(400);
  });

  test('a row a coach filed themselves stays whole to another coach', async () => {
    mockRequirePrincipal.mockResolvedValue(AS.coach());
    const created = await requirementsPost(new NextRequest('http://localhost/api/pilot/shadow/research-requirements', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        action: 'create',
        source_event_name: 'shadow_unanswered_question',
        source_entity_type: 'shadow_question',
        source_entity_id: 'how long should a round be',
        research_requirement: 'COACHFILED-5521 how long should a round be',
        knowledge_gap: 'No verified Library evidence matched this question in SHADOW.',
      }),
    }));
    expect(created.status).toBe(200);
    await db.query(
      `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
       values ('acct-aq-coach-2', 'coach', $1, 'microsoft') on conflict do nothing`,
      [ORG],
    );
    const listed = await listAs(principal({ accountId: 'acct-aq-coach-2', role: 'coach' }));
    expect(listed.text).toContain('COACHFILED-5521');
  });

  test('a resolver cannot rewrite the tie that keeps the row on its asker athlete deletion', async () => {
    mockRequirePrincipal.mockResolvedValue(AS.coach());
    const response = await requirementsPost(new NextRequest('http://localhost/api/pilot/shadow/research-requirements', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        action: 'resolve',
        research_requirement_id: ids.parentRow,
        closing_note: 'Done.',
        metadata: { asker_athlete_id: 'ath-somebody-else' },
      }),
    }));
    expect(response.status).toBe(400);
    const row = await db.query(
      `select metadata->>'asker_athlete_id' as a, status from pilot.shadow_research_requirements where research_requirement_id = $1`,
      [ids.parentRow],
    );
    expect(row.rows[0].a).toBe(ATHLETE_B);
    expect(row.rows[0].status).toBe('open');
  });
});

// Lane L52: GET research-submissions?research_requirement_id= through the real
// route, scope gate and table.
describe('the submissions on the question, read by id', () => {
  test('a coach reads the source and the verdict, the note sentence and none of the staff text', async () => {
    const coach = await submissionsAs(AS.coach(), ids.athleteRow as number);
    expect(coach.status).toBe(200);
    expect(coach.items).toHaveLength(1);
    expect(coach.items[0]).toMatchObject({
      submission_id: 'sub-aq-1',
      source_id: 'src-aq-1',
      applicability_state: 'responsive',
      submission_note: NOTE_SENTENCE,
      review_note: NOTE_SENTENCE,
      provenance: {},
    });
    for (const leak of [STAFF_TAG, ATHLETE_FRAGMENT, 'acct-aq-athlete-a', 'acct:']) {
      expect(coach.text).not.toContain(leak);
    }
  });

  test('the organization admin reads every note whole', async () => {
    const admin = await submissionsAs(AS.admin(), ids.athleteRow as number);
    expect(admin.status).toBe(200);
    for (const text of Object.values(STAFF_TEXT)) {
      expect(admin.text).toContain(text);
    }
  });

  test('the asker reads the family fields and no staff text', async () => {
    const asker = await submissionsAs(AS.athleteA(), ids.athleteRow as number);
    expect(asker.status).toBe(200);
    expect(asker.items.map((item) => item.submission_id)).toEqual(['sub-aq-1']);
    expect(asker.text).not.toContain(STAFF_TAG);
  });

  test('another athlete and the other gym get the not-found', async () => {
    for (const actor of [AS.athleteB(), AS.otherOrgCoach()]) {
      const read = await submissionsAs(actor, ids.athleteRow as number);
      expect(read.status).toBe(404);
      expect(read.text).not.toContain(STAFF_TAG);
    }
  });
});

describe('staff keys (Codex, #1575)', () => {
  test('two coach questions sharing their first 500 characters are two rows', async () => {
    const prefix = 'd'.repeat(600);
    const one = await fileQuestion({ organizationId: ORG, accountId: 'acct-aq-coach', role: 'coach', question: `${prefix} first ending` });
    const two = await fileQuestion({ organizationId: ORG, accountId: 'acct-aq-coach', role: 'coach', question: `${prefix} second ending` });
    expect(one).toBe(true);
    expect(two).toBe(true);
    const rows = await db.query(
      `select count(*)::int as n from pilot.shadow_research_requirements
        where organization_id = $1 and research_requirement like $2`,
      [ORG, `${prefix}%`],
    );
    expect(rows.rows[0].n).toBe(2);
  });
});
