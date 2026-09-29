// Real PostgreSQL-backed test for filing a compliance violation from a Film
// Study proposal (Escalate to Compliance on app/coach/video-analysis).
//
// Two things here are database behaviour a mock cannot prove:
//
// 1. The duplicate check reads jsonb: details->>'source' and
//    details->>'proposal_id' against what createComplianceViolation itself
//    wrote. A wrong key or a wrong operator would pass every mocked test and
//    let every reload file the same observation again -- a second register row
//    AND a second escalation on the ladder each time.
//
// 2. Two filings of the same proposal racing each other. The proposal row is
//    locked `for update` inside the create transaction, so the second filing
//    waits for the first and then sees its committed violation.
//
// Spins up the same disposable, local-only embedded Postgres the other
// migration suites use. It NEVER connects to production or staging.

import { type ChildProcessByStdio, spawn } from 'node:child_process';
import crypto from 'node:crypto';
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
const DATA_DIR = path.join(os.tmpdir(), `ppbf-compliance-film-filing-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const TEST_DB_NAME = 'ppbf_test_compliance_film_filing';

const ORG_ID = 'org-comp-film';
const OTHER_ORG_ID = 'org-comp-film-other';
const COACH_ID = 'acct-comp-film-coach';
const ATHLETE_ID = 'ATH-COMP-FILM-1';
const VIDEO_ID = 'vs-comp-film-1';
// escalation_level 'admin' and 'coach' both auto-file an escalation, so each
// filing below puts a row on the ladder as well as the register.
const RULE_INJURY = 'rule-comp-film-injury';
const RULE_FORM = 'rule-comp-film-form';

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let compliance: typeof import('./compliance');
let proposals: typeof import('./shadowFilmStudyProposals');
let db: typeof import('./db');

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

function newProposal() {
  return proposals.createFilmStudyProposal({
    organizationId: ORG_ID,
    athleteId: ATHLETE_ID,
    videoSessionId: VIDEO_ID,
    jobId: crypto.randomUUID(),
    observationText: 'Chin comes up on the exit after the right hand in round two.',
    modelDeployment: 'gpt-5-vision-shadow',
    framesAnalyzed: 6,
  });
}

function fileFromProposal(proposalId: string, ruleId: string, severity = 'critical') {
  return compliance.createComplianceViolation({
    organizationId: ORG_ID,
    ruleId,
    videoSessionId: VIDEO_ID,
    athleteId: ATHLETE_ID,
    detectedByAccountId: COACH_ID,
    severity,
    filmStudyProposalId: proposalId,
  });
}

async function violationsFor(proposalId: string, ruleId?: string): Promise<Array<{ violation_id: string; details: unknown }>> {
  return db.query<{ violation_id: string; details: unknown }>(
    `select violation_id, details from pilot.compliance_violations
     where details->>'proposal_id' = $1 and ($2::text is null or rule_id = $2)
     order by created_at asc`,
    [proposalId, ruleId ?? null],
  );
}

async function escalationsFor(violationIds: string[]): Promise<number> {
  const row = await db.queryOne<{ n: number }>(
    `select count(*)::int as n from pilot.safety_escalations
     where source_type = 'compliance_violation' and source_id = any($1::text[])`,
    [violationIds],
  );
  return row?.n ?? 0;
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
  await admin.query(`drop database if exists ${TEST_DB_NAME}`);
  await admin.query(`create database ${TEST_DB_NAME}`);
  await admin.end();

  const migrateClient = new Client({ connectionString: connectionStringFor(TEST_DB_NAME) });
  await migrateClient.connect();
  // compliance_violations references pilot.video_sessions, so video sessions
  // go ahead of the compliance migration (the `all` order does the same).
  for (const file of [
    'pilot_slice_postgres.sql',
    'pilot_slice_postgres_video_sessions_migration.sql',
    'pilot_slice_postgres_film_study_proposals_migration.sql',
    'pilot_slice_postgres_film_study_coach_reported_migration.sql',
    'pilot_slice_postgres_film_study_revisions_migration.sql',
    'pilot_slice_postgres_compliance_migration.sql',
  ]) {
    await migrateClient.query(await fs.readFile(path.join(INFRA_DIR, file), 'utf8'));
  }
  for (const orgId of [ORG_ID, OTHER_ORG_ID]) {
    await migrateClient.query(
      `insert into pilot.organizations (organization_id, organization_name, status)
       values ($1, $1, 'active') on conflict do nothing`,
      [orgId],
    );
  }
  await migrateClient.query(
    `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
     values ($1, 'coach', $2, 'microsoft') on conflict do nothing`,
    [COACH_ID, ORG_ID],
  );
  // pilot.athletes declares created_at/updated_at NOT NULL with no defaults.
  await migrateClient.query(
    `insert into pilot.athletes (organization_id, athlete_id, full_name, dob, weight_class, gym_status, emergency_contact, active_flag, coach_id, created_at, updated_at)
     values ($1, $2, 'Filing Athlete', '2011-05-06', 'fly', 'active', 'contact', true, $3, now(), now())`,
    [ORG_ID, ATHLETE_ID, COACH_ID],
  );
  await migrateClient.query(
    `insert into pilot.video_sessions
       (video_session_id, organization_id, uploaded_by_account_id, athlete_id, title, notes,
        blob_path, file_name, file_size_bytes, mime_type, status, created_at, updated_at)
     values ($1, $2, $3, $4, 'Sparring', '', $5, 'tape.mp4', 2048, 'video/mp4', 'ready', now(), now())`,
    [VIDEO_ID, ORG_ID, COACH_ID, ATHLETE_ID, `${ORG_ID}/${VIDEO_ID}.mp4`],
  );
  await migrateClient.query(
    `insert into pilot.compliance_rules
       (rule_id, organization_id, rule_name, rule_category, description, detection_logic, severity, escalation_level)
     values
       ($1, $3, 'Physical Injury Prevention', 'safety', 'Injury prevention', 'coach review', 'critical', 'admin'),
       ($2, $3, 'Proper Technique & Form', 'technique', 'Form standards', 'coach review', 'high', 'coach')`,
    [RULE_INJURY, RULE_FORM, ORG_ID],
  );
  await migrateClient.end();

  process.env.AZURE_POSTGRES_CONNECTION_STRING = connectionStringFor(TEST_DB_NAME);
  // db.ts only honors this when NODE_ENV is exactly 'test' (Jest sets it), so
  // production and staging can never take this path.
  process.env.PPBF_POSTGRES_DISABLE_SSL = 'true';

  db = await import('./db');
  compliance = await import('./compliance');
  proposals = await import('./shadowFilmStudyProposals');
});

afterAll(async () => {
  const { closePool } = await import('./db');
  await closePool();

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

describe('filing a compliance violation from a Film Study proposal, against the real schema', () => {
  test('the stored details are exactly the citation, and the lookup finds the filing by them', async () => {
    const proposal = await newProposal();

    const filed = await fileFromProposal(proposal.proposal_id, RULE_INJURY);

    const rows = await violationsFor(proposal.proposal_id);
    expect(rows).toEqual([{
      violation_id: filed.violation_id,
      details: { source: 'film_study_proposal', proposal_id: proposal.proposal_id },
    }]);
    await expect(
      compliance.findFilmStudyProposalViolation(ORG_ID, RULE_INJURY, proposal.proposal_id),
    ).resolves.toEqual({ violation_id: filed.violation_id });
    // Organization-scoped: another gym never sees this gym's filing.
    await expect(
      compliance.findFilmStudyProposalViolation(OTHER_ORG_ID, RULE_INJURY, proposal.proposal_id),
    ).resolves.toBeNull();
    // Rule-scoped: the same proposal under another rule is not a duplicate.
    await expect(
      compliance.findFilmStudyProposalViolation(ORG_ID, RULE_FORM, proposal.proposal_id),
    ).resolves.toBeNull();
  });

  test('filing the same proposal again under the same rule is refused, naming the first, with no second row and no second escalation', async () => {
    const proposal = await newProposal();
    const first = await fileFromProposal(proposal.proposal_id, RULE_INJURY);
    expect(await escalationsFor([first.violation_id])).toBe(1);

    const second = await fileFromProposal(proposal.proposal_id, RULE_INJURY).catch((error: unknown) => error);

    expect(second).toBeInstanceOf(compliance.ComplianceViolationAlreadyFiledError);
    expect((second as InstanceType<typeof compliance.ComplianceViolationAlreadyFiledError>).violationId)
      .toBe(first.violation_id);
    const rows = await violationsFor(proposal.proposal_id, RULE_INJURY);
    expect(rows.map((row) => row.violation_id)).toEqual([first.violation_id]);
    const ladder = await db.queryOne<{ n: number }>(
      `select count(*)::int as n from pilot.safety_escalations
       where source_type = 'compliance_violation' and metadata->>'rule_id' = $1
         and source_id in (select violation_id from pilot.compliance_violations where details->>'proposal_id' = $2)`,
      [RULE_INJURY, proposal.proposal_id],
    );
    expect(ladder?.n).toBe(1);
  });

  test('the same proposal under a different rule is still filed', async () => {
    const proposal = await newProposal();
    const underInjury = await fileFromProposal(proposal.proposal_id, RULE_INJURY);

    const underForm = await fileFromProposal(proposal.proposal_id, RULE_FORM, 'high');

    expect(underForm.violation_id).not.toBe(underInjury.violation_id);
    expect((await violationsFor(proposal.proposal_id)).map((row) => row.violation_id).sort())
      .toEqual([underInjury.violation_id, underForm.violation_id].sort());
    expect(await escalationsFor([underInjury.violation_id, underForm.violation_id])).toBe(2);
  });

  test('two filings racing on the same proposal and rule leave exactly one violation and one escalation', async () => {
    const proposal = await newProposal();

    const outcomes = await Promise.allSettled([
      fileFromProposal(proposal.proposal_id, RULE_INJURY),
      fileFromProposal(proposal.proposal_id, RULE_INJURY),
    ]);

    const fulfilled = outcomes.filter((outcome) => outcome.status === 'fulfilled');
    const rejected = outcomes.filter((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBeInstanceOf(compliance.ComplianceViolationAlreadyFiledError);
    const rows = await violationsFor(proposal.proposal_id, RULE_INJURY);
    expect(rows).toHaveLength(1);
    expect(await escalationsFor(rows.map((row) => row.violation_id))).toBe(1);
  });

  test('a proposal that is not in this organization is refused inside the transaction, and nothing is written', async () => {
    const missingProposalId = crypto.randomUUID();

    await expect(fileFromProposal(missingProposalId, RULE_INJURY)).rejects.toThrow(/^Not found$/);
    expect(await violationsFor(missingProposalId)).toEqual([]);
  });
});
