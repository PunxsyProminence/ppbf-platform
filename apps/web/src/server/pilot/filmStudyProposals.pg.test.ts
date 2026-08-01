// Real PostgreSQL-backed test for the Film Study proposal lifecycle.
//
// This is the human acceptance gate #103's safety design requires, and its
// invariants live in the schema: the attestation CHECK, the per-job unique
// index, and the three-state review vocabulary. None of those can be proven
// by a mock -- the defect classes they prevent (a proposal reaching
// 'accepted' with nobody named, a re-claimed job duplicating an observation
// into the coach's queue) are database behavior.
//
// The queue-with-no-exit case is asserted explicitly, because that is the
// failure this whole ordering exists to avoid (audit C1/C2, fixed in #122):
// BOTH verdicts must always be reachable from pending_review.
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
const DATA_DIR = path.join(os.tmpdir(), `ppbf-film-proposals-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const TEST_DB_NAME = 'ppbf_test_film_proposals';

const ORG_ID = 'org-film';
const OTHER_ORG_ID = 'org-film-other';
const COACH_ID = 'acct-film-coach';
const ATHLETE_ID = 'ATH-FILM-1';
const VIDEO_ID = 'vs-film-1';

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let proposals: typeof import('./shadowFilmStudyProposals');
let videoSessions: typeof import('./videoSessions');
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

function newProposal(overrides: Partial<Parameters<typeof proposals.createFilmStudyProposal>[0]> = {}) {
  return proposals.createFilmStudyProposal({
    organizationId: ORG_ID,
    athleteId: ATHLETE_ID,
    videoSessionId: VIDEO_ID,
    jobId: crypto.randomUUID(),
    observationText: 'Lead hand returns low after the jab in rounds two and three.',
    modelDeployment: 'gpt-5-vision-shadow',
    framesAnalyzed: 6,
    ...overrides,
  });
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
  await migrateClient.query(await fs.readFile(path.join(INFRA_DIR, 'pilot_slice_postgres.sql'), 'utf8'));
  await migrateClient.query(
    await fs.readFile(path.join(INFRA_DIR, 'pilot_slice_postgres_film_study_proposals_migration.sql'), 'utf8'),
  );
  await migrateClient.query(
    await fs.readFile(path.join(INFRA_DIR, 'pilot_slice_postgres_video_sessions_migration.sql'), 'utf8'),
  );
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
     values ($1, $2, 'Film Athlete', '2011-05-06', 'fly', 'active', 'contact', true, $3, now(), now())`,
    [ORG_ID, ATHLETE_ID, COACH_ID],
  );
  await migrateClient.end();

  process.env.AZURE_POSTGRES_CONNECTION_STRING = connectionStringFor(TEST_DB_NAME);
  // db.ts only honors this when NODE_ENV is exactly 'test' (Jest sets it), so
  // production and staging can never take this path.
  process.env.PPBF_POSTGRES_DISABLE_SSL = 'true';

  db = await import('./db');
  proposals = await import('./shadowFilmStudyProposals');
  videoSessions = await import('./videoSessions');
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

describe('film study proposals against the real schema', () => {
  test('a proposal is born pending with a server-derived evidence id', async () => {
    const created = await newProposal();

    expect(created.review_state).toBe('pending_review');
    expect(created.reviewed_by_account_id).toBeNull();
    expect(created.reviewed_at).toBeNull();
    // Citable to the video and nothing else -- never model-supplied (#100).
    expect(created.evidence_id).toBe(`film:${VIDEO_ID}`);
    expect(created.model_deployment).toBe('gpt-5-vision-shadow');
    expect(created.frames_analyzed).toBe(6);
  });

  test('BOTH verdicts are reachable from pending -- the queue always has an exit', async () => {
    // The C1/C2 lesson (#122) as a schema-level rule: nothing about a
    // proposal's content may block either terminal state.
    const toAccept = await newProposal();
    const toReject = await newProposal();

    const accepted = await proposals.resolveFilmStudyProposal({
      organizationId: ORG_ID,
      proposalId: toAccept.proposal_id,
      verdict: 'accepted',
      reviewerAccountId: COACH_ID,
      reviewerRole: 'coach',
      notes: 'Matches what I saw live.',
    });
    const rejected = await proposals.resolveFilmStudyProposal({
      organizationId: ORG_ID,
      proposalId: toReject.proposal_id,
      verdict: 'rejected',
      reviewerAccountId: COACH_ID,
      reviewerRole: 'coach',
      notes: 'Camera angle makes this unreadable.',
    });

    expect(accepted?.review_state).toBe('accepted');
    expect(rejected?.review_state).toBe('rejected');
    for (const settled of [accepted, rejected]) {
      expect(settled?.reviewed_by_account_id).toBe(COACH_ID);
      expect(settled?.reviewed_by_role).toBe('coach');
      expect(settled?.reviewed_at).not.toBeNull();
    }
  });

  test('a settled proposal cannot be re-decided', async () => {
    const created = await newProposal();
    await proposals.resolveFilmStudyProposal({
      organizationId: ORG_ID,
      proposalId: created.proposal_id,
      verdict: 'accepted',
      reviewerAccountId: COACH_ID,
      reviewerRole: 'coach',
    });

    const reversal = await proposals.resolveFilmStudyProposal({
      organizationId: ORG_ID,
      proposalId: created.proposal_id,
      verdict: 'rejected',
      reviewerAccountId: COACH_ID,
      reviewerRole: 'coach',
    });

    expect(reversal).toBeNull();
    const after = await proposals.getFilmStudyProposal(ORG_ID, created.proposal_id);
    expect(after?.review_state).toBe('accepted');
  });

  test('the schema refuses an accepted proposal with no attestation', async () => {
    // The auto-pass the safety design forbids: a row must not be able to
    // reach a terminal state without naming who put it there.
    const created = await newProposal();
    await expect(
      db.query(
        `update pilot.shadow_film_study_proposals
         set review_state = 'accepted'
         where proposal_id = $1`,
        [created.proposal_id],
      ),
    ).rejects.toThrow(/pilot_film_study_proposals_attested/);
  });

  test('a re-claimed job cannot duplicate an observation into the queue', async () => {
    // Job leases expire; the worker re-claims and re-executes. Without the
    // per-job unique index the coach would see the same observation twice.
    const jobId = crypto.randomUUID();
    const first = await newProposal({ jobId });
    const second = await newProposal({ jobId });

    expect(second.proposal_id).toBe(first.proposal_id);

    const rows = await db.query<{ n: string }>(
      'select count(*)::text as n from pilot.shadow_film_study_proposals where job_id = $1',
      [jobId],
    );
    expect(rows[0].n).toBe('1');
  });

  test('the pending queue is organization-scoped and oldest-first', async () => {
    const before = await proposals.listFilmStudyProposals({ organizationId: ORG_ID, state: 'pending' });
    const olderFirst = before.map((p) => p.created_at);
    expect([...olderFirst].sort()).toEqual(olderFirst);

    expect(
      await proposals.listFilmStudyProposals({ organizationId: OTHER_ORG_ID, state: 'pending' }),
    ).toEqual([]);
  });

  test('cross-organization settlement finds nothing and changes nothing', async () => {
    const created = await newProposal();

    const settled = await proposals.resolveFilmStudyProposal({
      organizationId: OTHER_ORG_ID,
      proposalId: created.proposal_id,
      verdict: 'accepted',
      reviewerAccountId: COACH_ID,
      reviewerRole: 'coach',
    });

    expect(settled).toBeNull();
    const after = await proposals.getFilmStudyProposal(ORG_ID, created.proposal_id);
    expect(after?.review_state).toBe('pending_review');
  });

  test('an unknown review state is rejected outright', async () => {
    const created = await newProposal();
    await expect(
      db.query(
        `update pilot.shadow_film_study_proposals
         set review_state = 'sort-of-accepted',
             reviewed_by_account_id = $2,
             reviewed_by_role = 'coach',
             reviewed_at = now()
         where proposal_id = $1`,
        [created.proposal_id, COACH_ID],
      ),
    ).rejects.toThrow(/review_state_check|violates check constraint/);
  });

  test('the athlete foreign key is real: an unknown athlete cannot be proposed about', async () => {
    await expect(
      newProposal({ athleteId: 'ATH-DOES-NOT-EXIST' }),
    ).rejects.toThrow(/pilot_film_study_proposals_athlete_fk|foreign key/);
  });
});

// The executor's source-of-truth read. pilot.video_sessions has TWO competing
// definitions -- the migration (#125) and the DDL that
// /api/pilot/admin/migrate-multiorg creates over HTTP -- so a column this
// query names could exist in one and not the other, and the mocked route test
// would still pass. These run the real function against the migrated schema.
describe('the Film Study video read path against the real schema', () => {
  const VIDEO_ID = 'vs-read-1';

  beforeAll(async () => {
    await db.query(
      `insert into pilot.video_sessions
         (video_session_id, organization_id, uploaded_by_account_id, athlete_id, title, notes,
          blob_path, file_name, file_size_bytes, mime_type, status, created_at, updated_at)
       values ($1, $2, $3, $4, 'Mitt work', '', $5, 'tape.mp4', 2048, 'video/mp4', 'ready', now(), now())`,
      [VIDEO_ID, ORG_ID, COACH_ID, ATHLETE_ID, `${ORG_ID}/${VIDEO_ID}.mp4`],
    );
  });

  test('returns the blob path and status the executor depends on', async () => {
    const row = await videoSessions.getVideoSessionById(ORG_ID, VIDEO_ID);

    expect(row).toMatchObject({
      video_session_id: VIDEO_ID,
      organization_id: ORG_ID,
      athlete_id: ATHLETE_ID,
      blob_path: `${ORG_ID}/${VIDEO_ID}.mp4`,
      status: 'ready',
    });
  });

  test('another organization cannot read the row', async () => {
    // The route turns a null into a hidden 404, so this predicate is the only
    // thing standing between a cross-org id guess and someone else's video.
    await expect(videoSessions.getVideoSessionById(OTHER_ORG_ID, VIDEO_ID)).resolves.toBeNull();
  });
});
