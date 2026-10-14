// Real PostgreSQL proof of what a family reader receives from the two SHADOW
// research reads (#1475 Part F, audit finding F-036).
//
// GET /api/pilot/shadow/research-requirements and
// GET /api/pilot/shadow/research-submissions are driven end to end: the real
// route handlers, the real relationship gate, the real rows. Only
// requirePrincipal is stubbed, the same seam the other route-driving .pg
// suites use.
//
// Two gyms, two families in the first one, and the platform shelf. Spins up the same disposable,
// local-only embedded Postgres the other suites use. It NEVER connects to
// production or staging.

import { type ChildProcessByStdio, spawn } from 'node:child_process';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { pathToFileURL } from 'node:url';
import type { Readable } from 'node:stream';

import { NextRequest } from 'next/server';
import { Client } from 'pg';

import { requirePrincipal } from './http';
import type { PilotPrincipal } from './auth';

jest.mock('./http', () => {
  const actual = jest.requireActual('./http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-research-family-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');

const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

const FULL_SCHEMA_HELPER_PATH = path.resolve(__dirname, '../../../scripts/lib/full-schema.mjs');
const TEST_DB_NAME = 'ppbf_test_research_family';

const ORG = 'org-1';
const OTHER_ORG = 'org-2';
const ATHLETE = 'ath-1';
const SECOND_ATHLETE = 'ath-2';
const OTHER_ORG_ATHLETE = 'ath-9';

/* Staff sign-in ids are email-shaped in production (staffProvisioning.ts), so
   the fixture's are too. */
const COACH_ID = 'coach.one@gym.example.test';
const ADMIN_ID = 'admin.one@gym.example.test';
const OTHER_ORG_COACH_ID = 'coach.two@othergym.example.test';
const OTHER_ORG_ADMIN_ID = 'admin.two@othergym.example.test';
const STAFF_IDS = [COACH_ID, ADMIN_ID] as const;
const PLATFORM_ORG = '__platform__';
// An account cannot live in the reserved shelf organization; the owner has its own.
const OWNER_ORG = 'org-owner';
const OWNER_ID = 'owner@platform.example.test';

const REVIEW_NOTE = 'Reviewer note: weak design, do not rely on it for this child.';
const SUBMISSION_NOTE = 'Curator note: pulled from the Penn State library on request.';
const CLOSING_NOTE = 'Closed after the coach meeting.';
const INTAKE_REVIEWER_NOTE = 'Intake reviewer: family situation discussed with the welfare lead.';

/* Every field a reader outside research staff receives, and no other. */
const FAMILY_REQUIREMENT_KEYS = [
  'created_at', 'is_mine', 'knowledge_gap', 'metadata', 'research_requirement', 'research_requirement_id',
  'resolved_at', 'source_confidence_tier', 'source_event_name', 'source_status', 'source_verification_state', 'status',
];
const FAMILY_SUBMISSION_KEYS = ['applicability_state', 'created_at', 'research_requirement_id', 'reviewed_at', 'submission_id'];

const mockRequirePrincipal = requirePrincipal as jest.MockedFunction<typeof requirePrincipal>;

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let db: Client;
let requirementsGet: typeof import('@/app/api/pilot/shadow/research-requirements/route').GET;
let submissionsGet: typeof import('@/app/api/pilot/shadow/research-submissions/route').GET;
let requirementAboutAthlete: number;
let requirementAboutSecondAthlete: number;
let askedByAthlete: number;
let askedByGuardianA: number;
let askedByGuardianB: number;
let gymBacklogRow: number;
let askedByVolunteer: number;
let intakeReviewRow: number;
let platformShelfRow: number;
let askedByOwner: number;

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
  admin: () => principal({ accountId: ADMIN_ID, role: 'organization_admin' }),
  coach: () => principal({ accountId: COACH_ID, role: 'coach' }),
  athlete: () => principal({ accountId: 'acct-athlete', role: 'athlete', athleteId: ATHLETE }),
  guardianA: () => principal({ accountId: 'acct-guardian-a', role: 'parent' }),
  guardianB: () => principal({ accountId: 'acct-guardian-b', role: 'parent' }),
  otherOrgCoach: () => principal({ accountId: OTHER_ORG_COACH_ID, role: 'coach', organizationId: OTHER_ORG }),
  otherOrgAdmin: () => principal({ accountId: OTHER_ORG_ADMIN_ID, role: 'organization_admin', organizationId: OTHER_ORG }),
  volunteer: () => principal({ accountId: 'acct-volunteer', role: 'volunteer' }),
  // The platform owner signed into the gym, and on its own shelf.
  ownerInGym: () => principal({ accountId: OWNER_ID, role: 'platform_owner' }),
  ownerAtHome: () => principal({ accountId: OWNER_ID, role: 'platform_owner', organizationId: OWNER_ORG }),
} as const;

async function readRequirements(actor: PilotPrincipal): Promise<{ status: number; text: string; items: Record<string, unknown>[] }> {
  mockRequirePrincipal.mockResolvedValue(actor);
  const response = await requirementsGet(new NextRequest('http://localhost/api/pilot/shadow/research-requirements'));
  const text = await response.text();
  const body = JSON.parse(text) as { items?: Record<string, unknown>[] };
  return { status: response.status, text, items: body.items ?? [] };
}

async function readSubmissions(
  actor: PilotPrincipal,
  requirementId: number,
  shelf = '',
): Promise<{ status: number; text: string; items: Record<string, unknown>[]; answerState: unknown }> {
  mockRequirePrincipal.mockResolvedValue(actor);
  const response = await submissionsGet(new NextRequest(
    `http://localhost/api/pilot/shadow/research-submissions?research_requirement_id=${requirementId}${shelf}`,
  ));
  const text = await response.text();
  const body = JSON.parse(text) as { items?: Record<string, unknown>[]; answer_state?: unknown };
  return { status: response.status, text, items: body.items ?? [], answerState: body.answer_state };
}

function idsOf(items: Record<string, unknown>[]): number[] {
  return items.map((item) => Number(item.research_requirement_id));
}

function rowFor(items: Record<string, unknown>[], requirementId: number): Record<string, unknown> {
  const row = items.find((item) => Number(item.research_requirement_id) === requirementId);
  if (!row) throw new Error(`requirement ${requirementId} is not in the answer`);
  return row;
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
  const applyFullSchema = helper.applyFullSchema as (client: Client, opts?: { infraDir?: string }) => Promise<unknown>;
  await applyFullSchema(db, { infraDir: INFRA_DIR });

  await db.query(
    `insert into pilot.organizations (organization_id, organization_name, status)
     values ($1, 'Punxsy Prominence', 'active'), ($2, 'Another Gym', 'active')`,
    [ORG, OTHER_ORG],
  );
  await db.query(
    `insert into pilot.organizations (organization_id, organization_name, status)
     values ($1, 'Platform shelf', 'active'), ($2, 'Platform owner', 'active')
     on conflict (organization_id) do nothing`,
    [PLATFORM_ORG, OWNER_ORG],
  );

  const accounts: Array<[string, string, string, string | null]> = [
    [ADMIN_ID, 'organization_admin', ORG, null],
    [COACH_ID, 'coach', ORG, null],
    ['acct-athlete', 'athlete', ORG, ATHLETE],
    ['acct-guardian-a', 'parent', ORG, null],
    ['acct-guardian-b', 'parent', ORG, null],
    [OTHER_ORG_COACH_ID, 'coach', OTHER_ORG, null],
    [OTHER_ORG_ADMIN_ID, 'organization_admin', OTHER_ORG, null],
    ['acct-volunteer', 'volunteer', ORG, null],
    [OWNER_ID, 'platform_owner', OWNER_ORG, null],
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
       ($1, $2, 'Rosa Ortiz', '2012-04-03', 'youth-60', 'active', 'Guardian A', true, $5, now(), now()),
       ($1, $3, 'Sam Reyes', '2013-02-01', 'youth-55', 'active', 'Guardian B', true, $5, now(), now()),
       ($4, $6, 'Someone Else', '2011-01-01', 'youth-65', 'active', 'Nobody', true, $7, now(), now())`,
    [ORG, ATHLETE, SECOND_ATHLETE, OTHER_ORG, COACH_ID, OTHER_ORG_ATHLETE, OTHER_ORG_COACH_ID],
  );

  // TWO FAMILIES IN ONE GYM: Guardian A has Rosa, Guardian B has Sam.
  await db.query(
    `insert into pilot.parents (organization_id, parent_id, account_id, full_name, phone, email)
     values
       ($1, 'par-a', 'acct-guardian-a', 'Guardian A', '555-0100', 'guardian.a@example.test'),
       ($1, 'par-b', 'acct-guardian-b', 'Guardian B', '555-0200', 'guardian.b@example.test')`,
    [ORG],
  );
  await db.query(
    `insert into pilot.guardian_links (organization_id, parent_id, athlete_id, relationship_to_athlete)
     values ($1, 'par-a', $2, 'mother'), ($1, 'par-b', $3, 'father')`,
    [ORG, ATHLETE, SECOND_ATHLETE],
  );

  await db.query(
    `insert into pilot.shadow_library_sources
       (source_id, organization_id, title, source_type, authority_tier, created_by_account_id, created_by_role)
     values
       ('src-1', $1, 'Youth training load review', 'peer_reviewed', 2, $2, 'organization_admin'),
       ('src-platform', $3, 'Platform reference', 'governing_body', 1, $4, 'platform_owner')`,
    [ORG, ADMIN_ID, PLATFORM_ORG, OWNER_ID],
  );

  process.env.AZURE_POSTGRES_CONNECTION_STRING = connectionStringFor(TEST_DB_NAME);
  process.env.PPBF_POSTGRES_DISABLE_SSL = 'true';

  // The rows are written by the same server functions the routes call, so
  // they carry exactly what production rows carry.
  const research = await import('./shadowResearch');
  const submissions = await import('./shadowResearchSubmissions');

  const create = (organizationId: string, entityId: string, subjectId: string, createdBy: string) =>
    research.createShadowResearchRequirement({
      organizationId,
      sourceEventName: 'MANUAL_RESEARCH_NOTE',
      sourceEntityType: 'manual_note',
      sourceEntityId: entityId,
      researchRequirement: 'Find guidance on training load for this athlete',
      knowledgeGap: 'No source on weekly load for a 12 year old',
      evidenceLabel: null,
      sourceStatus: 'observed',
      sourceConfidenceTier: 'SUFFICIENT_FOR_REVIEW',
      sourceVerificationState: 'unknown',
      createdByAccountId: createdBy,
      createdByRole: 'coach',
      metadata: { created_from: 'research_page' },
      subjectId,
    });

  requirementAboutAthlete = Number(await create(ORG, 'note-1', ATHLETE, COACH_ID));
  requirementAboutSecondAthlete = Number(await create(ORG, 'note-2', SECOND_ATHLETE, COACH_ID));
  await create(OTHER_ORG, 'note-9', OTHER_ORG_ATHLETE, OTHER_ORG_COACH_ID);

  // Rows that name NO athlete: a member's own Library question (CL-A3).
  const ask = (entityId: string, askedBy: string, role: string, organizationId = ORG) =>
    research.createShadowResearchRequirement({
      organizationId,
      sourceEventName: 'SHADOW_LIBRARY_CLAIM_GAP_DETECTED',
      sourceEntityType: 'shadow_library_claim',
      sourceEntityId: entityId,
      researchRequirement: 'Strengthen SHADOW Library evidence for general claim',
      knowledgeGap: `Question lacks sufficient SHADOW Library evidence: ${entityId}`,
      evidenceLabel: null,
      sourceStatus: 'missing',
      sourceConfidenceTier: 'INSUFFICIENT',
      sourceVerificationState: 'unknown',
      createdByAccountId: askedBy,
      createdByRole: role,
      metadata: { question: entityId, scope: 'general', subject_id: null },
      subjectId: null,
    });
  askedByAthlete = Number(await ask('general:global:athlete-question', 'acct-athlete', 'athlete'));
  askedByGuardianA = Number(await ask('general:global:guardian-a-question', 'acct-guardian-a', 'parent'));
  askedByGuardianB = Number(await ask('general:global:guardian-b-question', 'acct-guardian-b', 'parent'));
  gymBacklogRow = Number(await ask('general:global:coach-question', COACH_ID, 'coach'));
  askedByVolunteer = Number(await ask('general:global:volunteer-question', 'acct-volunteer', 'volunteer'));
  platformShelfRow = Number(await ask('general:global:platform-question', OWNER_ID, 'platform_owner', PLATFORM_ORG));
  askedByOwner = Number(await ask('general:global:owner-question', OWNER_ID, 'platform_owner', OWNER_ORG));

  // The shape intake/review-action writes: the reviewer's free-text note
  // rides in metadata, on a row about the child.
  intakeReviewRow = Number(await research.createShadowResearchRequirement({
    organizationId: ORG,
    sourceEventName: 'SHADOW_INTAKE_CASE_APPROVED',
    sourceEntityType: 'intake_case',
    sourceEntityId: '11111111-2222-4333-8444-555555555555',
    researchRequirement: 'Review approved intake case',
    knowledgeGap: 'Confirm the approved intake against Library evidence',
    evidenceLabel: null,
    sourceStatus: 'observed',
    sourceConfidenceTier: 'SUFFICIENT_FOR_REVIEW',
    sourceVerificationState: 'unknown',
    createdByAccountId: ADMIN_ID,
    createdByRole: 'organization_admin',
    metadata: { action: 'approve', notes: INTAKE_REVIEWER_NOTE, athlete_id: ATHLETE },
    subjectId: ATHLETE,
  }));

  const platformSubmission = await submissions.createResearchSubmission({
    organizationId: PLATFORM_ORG,
    researchRequirementId: platformShelfRow,
    sourceId: 'src-platform',
    submissionNote: SUBMISSION_NOTE,
    submittedByAccountId: OWNER_ID,
  });
  await submissions.reviewResearchSubmission({
    organizationId: PLATFORM_ORG,
    submissionId: platformSubmission.submission_id,
    applicabilityState: 'partially_responsive',
    reviewNote: REVIEW_NOTE,
    reviewedByAccountId: OWNER_ID,
  });

  const submission = await submissions.createResearchSubmission({
    organizationId: ORG,
    researchRequirementId: requirementAboutAthlete,
    sourceId: 'src-1',
    provenance: { provider: 'Penn State library' },
    submissionNote: SUBMISSION_NOTE,
    submittedByAccountId: ADMIN_ID,
  });
  await submissions.reviewResearchSubmission({
    organizationId: ORG,
    submissionId: submission.submission_id,
    applicabilityState: 'responsive',
    reviewNote: REVIEW_NOTE,
    reviewedByAccountId: ADMIN_ID,
  });
  await research.resolveShadowResearchRequirement({
    organizationId: ORG,
    researchRequirementId: requirementAboutAthlete,
    resolvedByAccountId: ADMIN_ID,
    resolvedByRole: 'organization_admin',
    metadata: { resolved_from: 'research_page' },
    expectedSubjectAthleteId: ATHLETE,
    closing: { note: CLOSING_NOTE, submissionId: null },
  });

  requirementsGet = (await import('@/app/api/pilot/shadow/research-requirements/route')).GET;
  submissionsGet = (await import('@/app/api/pilot/shadow/research-submissions/route')).GET;
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
  it('stores the staff ids and the staff notes the reads could leak', async () => {
    const requirement = await db.query<{ created_by_account_id: string; metadata: Record<string, unknown> }>(
      'select created_by_account_id, metadata from pilot.shadow_research_requirements where research_requirement_id = $1',
      [requirementAboutAthlete],
    );
    expect(requirement.rows[0].created_by_account_id).toBe(COACH_ID);
    expect(requirement.rows[0].metadata.resolved_by_account_id).toBe(ADMIN_ID);

    const intake = await db.query<{ metadata: Record<string, unknown> }>(
      'select metadata from pilot.shadow_research_requirements where research_requirement_id = $1',
      [intakeReviewRow],
    );
    expect(intake.rows[0].metadata.notes).toBe(INTAKE_REVIEWER_NOTE);

    const submission = await db.query<Record<string, unknown>>(
      'select reviewed_by_account_id, submitted_by_account_id, review_note, submission_note from pilot.shadow_research_submissions where research_requirement_id = $1',
      [requirementAboutAthlete],
    );
    expect(submission.rows).toEqual([{
      reviewed_by_account_id: ADMIN_ID,
      submitted_by_account_id: ADMIN_ID,
      review_note: REVIEW_NOTE,
      submission_note: SUBMISSION_NOTE,
    }]);
  });
});

describe.each([
  ['the athlete', AS.athlete],
  ['the parent', AS.guardianA],
] as const)('GET research-requirements as %s', (_label, actor) => {
  it("reads the requirements about their own athlete and no other family's", async () => {
    const { status, items } = await readRequirements(actor());
    expect(status).toBe(200);
    const ids = idsOf(items);
    expect(ids).toEqual(expect.arrayContaining([requirementAboutAthlete, intakeReviewRow]));
    expect(ids).not.toContain(requirementAboutSecondAthlete);
    expect(ids).not.toContain(gymBacklogRow);
    expect(ids).not.toContain(askedByGuardianB);
  });

  it('receives no staff account id, no email-shaped value and no guardian record id', async () => {
    const { text } = await readRequirements(actor());
    for (const staffId of STAFF_IDS) {
      expect(text).not.toContain(staffId);
    }
    expect(text).not.toContain('@');
    expect(text).not.toContain('par-');
    expect(text).not.toContain('acct-');
  });

  it('receives the named family fields on every row and nothing else', async () => {
    const { items } = await readRequirements(actor());
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(Object.keys(item).sort()).toEqual(FAMILY_REQUIREMENT_KEYS);
      expect(Object.keys(item.metadata as object)).toEqual(['closing_note']);
    }
  });

  it('keeps the text a coach wrote on a question about their child, closing note included', async () => {
    const row = rowFor((await readRequirements(actor())).items, requirementAboutAthlete);
    expect(row).toMatchObject({
      research_requirement: 'Find guidance on training load for this athlete',
      knowledge_gap: 'No source on weekly load for a 12 year old',
      status: 'resolved',
      is_mine: false,
      metadata: { closing_note: CLOSING_NOTE },
    });
  });

  it("does not receive the intake reviewer's note", async () => {
    const { text, items } = await readRequirements(actor());
    expect(text).not.toContain(INTAKE_REVIEWER_NOTE);
    expect(rowFor(items, intakeReviewRow).metadata).toEqual({ closing_note: null });
  });
});

describe.each([
  ['the athlete', AS.athlete],
  ['the parent', AS.guardianA],
] as const)('GET research-submissions as %s', (_label, actor) => {
  it('receives the named family fields, no staff account id and no staff note', async () => {
    const { status, text, items, answerState } = await readSubmissions(actor(), requirementAboutAthlete);
    expect(status).toBe(200);
    expect(items).toHaveLength(1);
    expect(Object.keys(items[0]).sort()).toEqual(FAMILY_SUBMISSION_KEYS);
    expect(items[0].applicability_state).toBe('responsive');
    for (const staffId of STAFF_IDS) {
      expect(text).not.toContain(staffId);
    }
    expect(text).not.toContain('@');
    expect(text).not.toContain(REVIEW_NOTE);
    expect(text).not.toContain(SUBMISSION_NOTE);
    expect(text).not.toContain('Penn State');
    expect(text).not.toContain('src-1');
    // The ladder is still computed from the stored rows.
    expect(answerState).toBe('resolved');
  });
});

describe('a question that names no athlete (CL-A3: members see only their own)', () => {
  it('the athlete who asked reads their own, marked as theirs, and no other member question', async () => {
    const { items } = await readRequirements(AS.athlete());
    const ids = idsOf(items);
    expect(ids).toContain(askedByAthlete);
    expect(ids).not.toContain(askedByGuardianA);
    expect(ids).not.toContain(askedByVolunteer);
    expect(ids).not.toContain(gymBacklogRow);
    expect(rowFor(items, askedByAthlete).is_mine).toBe(true);
  });

  it('a parent never reads another member question', async () => {
    const ids = idsOf((await readRequirements(AS.guardianA())).items);
    expect(ids).not.toContain(askedByGuardianB);
    expect(ids).not.toContain(askedByAthlete);
    expect(ids).not.toContain(gymBacklogRow);
    expect((await readSubmissions(AS.guardianA(), askedByGuardianB)).status).toBe(404);
  });

  it('a volunteer reads only the one they asked, in the family fields', async () => {
    const { text, items } = await readRequirements(AS.volunteer());
    expect(idsOf(items)).toEqual([askedByVolunteer]);
    expect(Object.keys(items[0]).sort()).toEqual(FAMILY_REQUIREMENT_KEYS);
    expect(items[0].is_mine).toBe(true);
    expect(text).not.toContain('acct-volunteer');
  });

  it('a coach reads the whole gym backlog', async () => {
    const ids = idsOf((await readRequirements(AS.coach())).items);
    expect(ids).toEqual(expect.arrayContaining([askedByAthlete, askedByGuardianA, askedByGuardianB, askedByVolunteer, gymBacklogRow]));
  });
});

describe('the platform owner', () => {
  it("gets no row and no field from a gym's requirement about an athlete", async () => {
    const list = await readRequirements(AS.ownerInGym());
    expect(list.status).toBe(200);
    expect(list.items).toEqual([]);
    expect(list.text).not.toContain('training load');
    for (const staffId of STAFF_IDS) {
      expect(list.text).not.toContain(staffId);
    }

    const detail = await readSubmissions(AS.ownerInGym(), requirementAboutAthlete);
    expect(detail.status).toBe(404);
    expect(detail.text).not.toContain(REVIEW_NOTE);
  });

  it('reads the question it filed itself in the family fields', async () => {
    const { text, items } = await readRequirements(AS.ownerAtHome());
    expect(idsOf(items)).toEqual([askedByOwner]);
    expect(Object.keys(items[0]).sort()).toEqual(FAMILY_REQUIREMENT_KEYS);
    expect(items[0].is_mine).toBe(true);
    expect(text).not.toContain(OWNER_ID);
  });

  it("reads the platform shelf's submissions whole, as that shelf's curator", async () => {
    const detail = await readSubmissions(AS.ownerAtHome(), platformShelfRow, '&shelf=platform');
    expect(detail.status).toBe(200);
    expect(detail.items[0]).toMatchObject({
      submitted_by_account_id: OWNER_ID,
      reviewed_by_account_id: OWNER_ID,
      review_note: REVIEW_NOTE,
      submission_note: SUBMISSION_NOTE,
    });
  });
});

describe('gym isolation and staff', () => {
  it("a parent cannot read another family's requirement or its submissions", async () => {
    const list = await readRequirements(AS.guardianB());
    const ids = idsOf(list.items);
    expect(ids).toContain(requirementAboutSecondAthlete);
    expect(ids).not.toContain(requirementAboutAthlete);
    expect(ids).not.toContain(intakeReviewRow);
    expect(list.text).not.toContain(CLOSING_NOTE);
    expect((await readSubmissions(AS.guardianB(), requirementAboutAthlete)).status).toBe(404);
  });

  it.each([
    ['coach', AS.otherOrgCoach],
    ['organization admin', AS.otherOrgAdmin],
  ] as const)("another gym's %s reads none of this gym's rows", async (_label, actor) => {
    const list = await readRequirements(actor());
    expect(list.items).toHaveLength(1);
    expect(list.items[0].created_by_account_id).toBe(OTHER_ORG_COACH_ID);
    for (const staffId of STAFF_IDS) {
      expect(list.text).not.toContain(staffId);
    }
    for (const requirementId of [requirementAboutAthlete, gymBacklogRow]) {
      const detail = await readSubmissions(actor(), requirementId);
      expect(detail.status).toBe(404);
      expect(detail.items).toEqual([]);
    }
  });

  it('a coach and an organization admin receive the stored rows whole', async () => {
    for (const actor of [AS.coach, AS.admin]) {
      const list = await readRequirements(actor());
      const stored = await db.query<Record<string, unknown>>(
        'select * from pilot.shadow_research_requirements where research_requirement_id = $1',
        [requirementAboutAthlete],
      );
      const row = rowFor(list.items, requirementAboutAthlete);
      expect(Object.keys(row).sort()).toEqual(Object.keys(stored.rows[0]).sort());
      expect(row).toMatchObject({
        organization_id: ORG,
        created_by_account_id: COACH_ID,
        created_by_role: 'coach',
        subject_id: ATHLETE,
        metadata: {
          created_from: 'research_page',
          resolved_from: 'research_page',
          resolved_by_account_id: ADMIN_ID,
          resolved_by_role: 'organization_admin',
          closing_note: CLOSING_NOTE,
          closing_submission_id: null,
        },
      });
      expect(rowFor(list.items, intakeReviewRow).metadata).toMatchObject({ notes: INTAKE_REVIEWER_NOTE });

      const detail = await readSubmissions(actor(), requirementAboutAthlete);
      const storedSubmission = await db.query<Record<string, unknown>>(
        'select * from pilot.shadow_research_submissions where research_requirement_id = $1',
        [requirementAboutAthlete],
      );
      expect(Object.keys(detail.items[0]).sort()).toEqual(Object.keys(storedSubmission.rows[0]).sort());
      expect(detail.items[0]).toMatchObject({
        source_id: 'src-1',
        provenance: { provider: 'Penn State library' },
        reviewed_by_account_id: ADMIN_ID,
        submitted_by_account_id: ADMIN_ID,
        review_note: REVIEW_NOTE,
        submission_note: SUBMISSION_NOTE,
      });
    }
  });
});
