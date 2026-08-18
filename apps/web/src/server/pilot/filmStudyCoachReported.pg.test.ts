// Real PostgreSQL-backed test for the two gaps the coach-reported migration
// closes: the queue could not record what the model MISSED, and a coach who
// was nearly in agreement had only rejection available.
//
// These invariants are database behavior and cannot be proven by a mock:
//
//   * provenance matches origin in both directions, so a coach-entered
//     observation cannot carry an invented model_deployment and a model
//     proposal cannot claim a human reporter
//   * `origin` has no default after backfill, so an insert that omits it
//     fails rather than silently claiming to be a model proposal
//   * a 'corrected' row must carry replacement wording, and nothing else may
//   * every terminal state stays reachable from pending_review for BOTH
//     origins (audit C1/C2, #122)
//
// A second database is built with the PRE-migration schema so the gap is
// demonstrated rather than asserted, and the legacy backfill is exercised
// against a row that genuinely predates the new column.
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
const DATA_DIR = path.join(os.tmpdir(), `ppbf-film-coach-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const TEST_DB_NAME = 'ppbf_test_film_coach';
const LEGACY_DB_NAME = 'ppbf_test_film_coach_legacy';

const ORG_ID = 'org-film';
const OTHER_ORG_ID = 'org-film-other';
const COACH_ID = 'acct-film-coach';
const OTHER_COACH_ID = 'acct-film-coach-2';
const ATHLETE_ID = 'ATH-FILM-1';
const VIDEO_ID = 'vs-film-1';

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let proposals: typeof import('./shadowFilmStudyProposals');

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

async function readMigration(name: string): Promise<string> {
  return fs.readFile(path.join(INFRA_DIR, name), 'utf8');
}

const BASE_SQL = 'pilot_slice_postgres.sql';
const PROPOSALS_SQL = 'pilot_slice_postgres_film_study_proposals_migration.sql';
const COACH_REPORTED_SQL = 'pilot_slice_postgres_film_study_coach_reported_migration.sql';
// The module appends a revision on every correction, so the table it writes to
// must exist in any suite that corrects a proposal.
const REVISIONS_SQL = 'pilot_slice_postgres_film_study_revisions_migration.sql';

/** Seeds the org/account/athlete rows the proposal foreign keys require. */
async function seedTenancy(client: Client): Promise<void> {
  for (const orgId of [ORG_ID, OTHER_ORG_ID]) {
    await client.query(
      `insert into pilot.organizations (organization_id, organization_name, status)
       values ($1, $1, 'active') on conflict do nothing`,
      [orgId],
    );
  }
  for (const accountId of [COACH_ID, OTHER_COACH_ID]) {
    await client.query(
      `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
       values ($1, 'coach', $2, 'microsoft') on conflict do nothing`,
      [accountId, ORG_ID],
    );
  }
  // pilot.athletes declares created_at/updated_at NOT NULL with no defaults.
  await client.query(
    `insert into pilot.athletes (organization_id, athlete_id, full_name, dob, weight_class, gym_status, emergency_contact, active_flag, coach_id, created_at, updated_at)
     values ($1, $2, 'Film Athlete', '2011-05-06', 'fly', 'active', 'contact', true, $3, now(), now())
     on conflict do nothing`,
    [ORG_ID, ATHLETE_ID, COACH_ID],
  );
}

function newModelProposal(
  overrides: Partial<Parameters<typeof proposals.createFilmStudyProposal>[0]> = {},
) {
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

function newCoachReport(
  overrides: Partial<Parameters<typeof proposals.createCoachReportedObservation>[0]> = {},
) {
  return proposals.createCoachReportedObservation({
    organizationId: ORG_ID,
    athleteId: ATHLETE_ID,
    videoSessionId: VIDEO_ID,
    observationText: 'Model said nothing about the head staying still on the slip.',
    reportedByAccountId: COACH_ID,
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
  for (const name of [TEST_DB_NAME, LEGACY_DB_NAME]) {
    await admin.query(`drop database if exists ${name}`);
    await admin.query(`create database ${name}`);
  }
  await admin.end();

  // The working database: fully migrated, used by the module under test.
  const migrateClient = new Client({ connectionString: connectionStringFor(TEST_DB_NAME) });
  await migrateClient.connect();
  await migrateClient.query(await readMigration(BASE_SQL));
  await migrateClient.query(await readMigration(PROPOSALS_SQL));
  await migrateClient.query(await readMigration(COACH_REPORTED_SQL));
  await migrateClient.query(await readMigration(REVISIONS_SQL));
  await seedTenancy(migrateClient);
  await migrateClient.end();

  // The legacy database: PRE-migration, so the gap can be demonstrated and the
  // backfill exercised against a row that really predates the column.
  const legacyClient = new Client({ connectionString: connectionStringFor(LEGACY_DB_NAME) });
  await legacyClient.connect();
  await legacyClient.query(await readMigration(BASE_SQL));
  await legacyClient.query(await readMigration(PROPOSALS_SQL));
  await seedTenancy(legacyClient);
  await legacyClient.end();

  process.env.AZURE_POSTGRES_CONNECTION_STRING = connectionStringFor(TEST_DB_NAME);
  // db.ts only honors this when NODE_ENV is exactly 'test' (Jest sets it), so
  // production and staging can never take this path.
  process.env.PPBF_POSTGRES_DISABLE_SSL = 'true';

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

describe('the gap is real, and the migration closes it', () => {
  test('before the migration there is nowhere to record a missed detection', async () => {
    const legacy = new Client({ connectionString: connectionStringFor(LEGACY_DB_NAME) });
    await legacy.connect();
    try {
      const columns = await legacy.query(
        `select column_name from information_schema.columns
         where table_schema = 'pilot' and table_name = 'shadow_film_study_proposals'`,
      );
      const names = columns.rows.map((row) => row.column_name as string);
      expect(names).not.toContain('origin');
      expect(names).not.toContain('reported_by_account_id');
      expect(names).not.toContain('corrected_observation_text');

      // And the verdict vocabulary genuinely had no correction in it.
      const verdicts = await legacy.query(
        `select pg_get_constraintdef(oid) as def from pg_constraint
         where conrelid = 'pilot.shadow_film_study_proposals'::regclass
           and pg_get_constraintdef(oid) like '%review_state%'
           and contype = 'c'`,
      );
      expect(verdicts.rows.map((row) => row.def as string).join(' ')).not.toContain('corrected');
    } finally {
      await legacy.end();
    }
  });

  test('a legacy row backfills to model_proposed -- the true answer, not a guess', async () => {
    const legacy = new Client({ connectionString: connectionStringFor(LEGACY_DB_NAME) });
    await legacy.connect();
    try {
      const legacyId = crypto.randomUUID();
      await legacy.query(
        `insert into pilot.shadow_film_study_proposals
           (proposal_id, organization_id, athlete_id, video_session_id,
            observation_text, evidence_id, model_deployment, frames_analyzed)
         values ($1, $2, $3, $4, 'Legacy observation.', $5, 'legacy-vision', 4)`,
        [legacyId, ORG_ID, ATHLETE_ID, VIDEO_ID, `film:${VIDEO_ID}`],
      );

      await legacy.query(await readMigration(COACH_REPORTED_SQL));

      const after = await legacy.query(
        'select origin, reported_by_account_id from pilot.shadow_film_study_proposals where proposal_id = $1',
        [legacyId],
      );
      // Before this migration the table could hold nothing but vision output,
      // so 'model_proposed' is what the row actually was -- this is recovered
      // provenance, not an invented label.
      expect(after.rows[0].origin).toBe('model_proposed');
      expect(after.rows[0].reported_by_account_id).toBeNull();
    } finally {
      await legacy.end();
    }
  });

  test('re-running the migration is a no-op and does not reopen the hole', async () => {
    const legacy = new Client({ connectionString: connectionStringFor(LEGACY_DB_NAME) });
    await legacy.connect();
    try {
      await legacy.query(await readMigration(COACH_REPORTED_SQL));
      await legacy.query(await readMigration(COACH_REPORTED_SQL));

      const defaults = await legacy.query(
        `select column_default, is_nullable from information_schema.columns
         where table_schema = 'pilot' and table_name = 'shadow_film_study_proposals'
           and column_name = 'origin'`,
      );
      // Still no default after repeated application: a re-run must not quietly
      // restore the thing the migration deliberately removed.
      expect(defaults.rows[0].column_default).toBeNull();
      expect(defaults.rows[0].is_nullable).toBe('NO');
    } finally {
      await legacy.end();
    }
  });

  test('an insert that omits origin fails rather than assuming model_proposed', async () => {
    const client = new Client({ connectionString: connectionStringFor(TEST_DB_NAME) });
    await client.connect();
    try {
      await expect(
        client.query(
          `insert into pilot.shadow_film_study_proposals
             (proposal_id, organization_id, athlete_id, video_session_id,
              observation_text, evidence_id, model_deployment, frames_analyzed)
           values ($1, $2, $3, $4, 'No origin stated.', $5, 'some-vision', 3)`,
          [crypto.randomUUID(), ORG_ID, ATHLETE_ID, VIDEO_ID, `film:${VIDEO_ID}`],
        ),
      ).rejects.toThrow(/not-null|null value/i);
    } finally {
      await client.end();
    }
  });
});

describe('the missed detection', () => {
  test('a coach can record what the model never proposed', async () => {
    const reported = await newCoachReport();

    expect(reported.origin).toBe('coach_reported');
    expect(reported.reported_by_account_id).toBe(COACH_ID);
    expect(reported.observation_text).toContain('head staying still');
    // Citable to the video and nothing else, exactly as a model proposal is.
    expect(reported.evidence_id).toBe(`film:${VIDEO_ID}`);
  });

  test('it carries no inference provenance, because there was no inference', async () => {
    const reported = await newCoachReport();

    expect(reported.model_deployment).toBeNull();
    expect(reported.frames_analyzed).toBeNull();
  });

  test('the database refuses a coach row that claims a model deployment', async () => {
    const client = new Client({ connectionString: connectionStringFor(TEST_DB_NAME) });
    await client.connect();
    try {
      // This is the fabricated-provenance case: filling the model columns in
      // to satisfy a NOT NULL would make a coach's note look like a measured
      // inference run.
      await expect(
        client.query(
          `insert into pilot.shadow_film_study_proposals
             (proposal_id, organization_id, athlete_id, video_session_id, origin,
              observation_text, evidence_id, model_deployment, frames_analyzed,
              reported_by_account_id)
           values ($1, $2, $3, $4, 'coach_reported', 'Invented provenance.', $5, 'none', 1, $6)`,
          [crypto.randomUUID(), ORG_ID, ATHLETE_ID, VIDEO_ID, `film:${VIDEO_ID}`, COACH_ID],
        ),
      ).rejects.toThrow(/pilot_film_study_proposals_provenance/);
    } finally {
      await client.end();
    }
  });

  test('the database refuses a model row that claims a human reporter', async () => {
    const client = new Client({ connectionString: connectionStringFor(TEST_DB_NAME) });
    await client.connect();
    try {
      await expect(
        client.query(
          `insert into pilot.shadow_film_study_proposals
             (proposal_id, organization_id, athlete_id, video_session_id, origin,
              observation_text, evidence_id, model_deployment, frames_analyzed,
              reported_by_account_id)
           values ($1, $2, $3, $4, 'model_proposed', 'Borrowed authorship.', $5, 'vision', 5, $6)`,
          [crypto.randomUUID(), ORG_ID, ATHLETE_ID, VIDEO_ID, `film:${VIDEO_ID}`, COACH_ID],
        ),
      ).rejects.toThrow(/pilot_film_study_proposals_provenance/);
    } finally {
      await client.end();
    }
  });

  test('it lands pending_review, so a mis-entered observation can still be retracted', async () => {
    const reported = await newCoachReport();

    // Deliberately NOT pre-accepted. A row created already-settled would have
    // no exit, which is the C1/C2 failure (#122) rebuilt in a new place.
    expect(reported.review_state).toBe('pending_review');
    expect(reported.reviewed_by_account_id).toBeNull();
    expect(reported.reviewed_at).toBeNull();
  });

  test('an empty observation is refused before it reaches the database', async () => {
    await expect(newCoachReport({ observationText: '   ' })).rejects.toThrow(
      /Missing observation_text/,
    );
  });
});

describe('the correction verdict', () => {
  test('all three verdicts are reachable from pending -- the queue always has an exit', async () => {
    const [toAccept, toReject, toCorrect] = await Promise.all([
      newModelProposal(),
      newModelProposal(),
      newModelProposal(),
    ]);

    const accepted = await proposals.resolveFilmStudyProposal({
      organizationId: ORG_ID,
      proposalId: toAccept.proposal_id,
      verdict: 'accepted',
      reviewerAccountId: COACH_ID,
      reviewerRole: 'coach',
    });
    const rejected = await proposals.resolveFilmStudyProposal({
      organizationId: ORG_ID,
      proposalId: toReject.proposal_id,
      verdict: 'rejected',
      reviewerAccountId: COACH_ID,
      reviewerRole: 'coach',
    });
    const corrected = await proposals.resolveFilmStudyProposal({
      organizationId: ORG_ID,
      proposalId: toCorrect.proposal_id,
      verdict: 'corrected',
      reviewerAccountId: COACH_ID,
      reviewerRole: 'coach',
      correctedObservationText: 'Lead hand drops only in round three, not round two.',
    });

    expect(accepted?.review_state).toBe('accepted');
    expect(rejected?.review_state).toBe('rejected');
    expect(corrected?.review_state).toBe('corrected');
  });

  test('a correction keeps BOTH readings -- the model is never overwritten', async () => {
    const proposal = await newModelProposal();

    const corrected = await proposals.resolveFilmStudyProposal({
      organizationId: ORG_ID,
      proposalId: proposal.proposal_id,
      verdict: 'corrected',
      reviewerAccountId: COACH_ID,
      reviewerRole: 'coach',
      correctedObservationText: 'Lead hand drops only in round three.',
    });

    expect(corrected?.observation_text).toBe(proposal.observation_text);
    expect(corrected?.corrected_observation_text).toBe('Lead hand drops only in round three.');
    // The attestation the safety design requires, on a correction as much as
    // on an acceptance.
    expect(corrected?.reviewed_by_account_id).toBe(COACH_ID);
    expect(corrected?.reviewed_at).not.toBeNull();
  });

  test('a correction with no replacement wording is refused by name', async () => {
    const proposal = await newModelProposal();

    // An empty rewrite would settle as 'corrected' while reading, to anything
    // downstream, as agreement.
    await expect(
      proposals.resolveFilmStudyProposal({
        organizationId: ORG_ID,
        proposalId: proposal.proposal_id,
        verdict: 'corrected',
        reviewerAccountId: COACH_ID,
        reviewerRole: 'coach',
        correctedObservationText: '   ',
      }),
    ).rejects.toThrow(/Missing corrected_observation_text/);
  });

  test('replacement wording cannot ride along on an acceptance or a rejection', async () => {
    const proposal = await newModelProposal();

    await expect(
      proposals.resolveFilmStudyProposal({
        organizationId: ORG_ID,
        proposalId: proposal.proposal_id,
        verdict: 'rejected',
        reviewerAccountId: COACH_ID,
        reviewerRole: 'coach',
        correctedObservationText: 'Text nobody would ever read.',
      }),
    ).rejects.toThrow(/only valid with a corrected verdict/);
  });

  test('the database refuses a corrected row with no corrected text', async () => {
    const client = new Client({ connectionString: connectionStringFor(TEST_DB_NAME) });
    await client.connect();
    try {
      const proposal = await newModelProposal();
      await expect(
        client.query(
          `update pilot.shadow_film_study_proposals
           set review_state = 'corrected', reviewed_by_account_id = $2,
               reviewed_by_role = 'coach', reviewed_at = now()
           where proposal_id = $1`,
          [proposal.proposal_id, COACH_ID],
        ),
      ).rejects.toThrow(/pilot_film_study_proposals_correction_check/);
    } finally {
      await client.end();
    }
  });

  test('a corrected row still cannot exist without naming who corrected it', async () => {
    const client = new Client({ connectionString: connectionStringFor(TEST_DB_NAME) });
    await client.connect();
    try {
      const proposal = await newModelProposal();
      await expect(
        client.query(
          `update pilot.shadow_film_study_proposals
           set review_state = 'corrected', corrected_observation_text = 'Rewritten.'
           where proposal_id = $1`,
          [proposal.proposal_id],
        ),
      ).rejects.toThrow(/pilot_film_study_proposals_attested_v2/);
    } finally {
      await client.end();
    }
  });
});

describe('what this means for an accept-rate measurement', () => {
  test('an accepted coach report is excluded from the model accept rate', async () => {
    const client = new Client({ connectionString: connectionStringFor(TEST_DB_NAME) });
    await client.connect();
    try {
      const deployment = `scoped-vision-${crypto.randomUUID().slice(0, 8)}`;
      const modelProposal = await newModelProposal({ modelDeployment: deployment });
      await proposals.resolveFilmStudyProposal({
        organizationId: ORG_ID,
        proposalId: modelProposal.proposal_id,
        verdict: 'rejected',
        reviewerAccountId: COACH_ID,
        reviewerRole: 'coach',
      });

      const coachReport = await newCoachReport();
      await proposals.resolveFilmStudyProposal({
        organizationId: ORG_ID,
        proposalId: coachReport.proposal_id,
        verdict: 'accepted',
        reviewerAccountId: OTHER_COACH_ID,
        reviewerRole: 'coach',
      });

      // Scoped by the exported predicate, the model's one settled proposal was
      // rejected: 0 accepted of 1. The coach's accepted report is evidence the
      // model MISSED something, so counting it as an acceptance would invert
      // its meaning and inflate the number it exists to make honest.
      const scoped = await client.query(
        `select
           count(*) filter (where review_state = 'accepted') as accepted,
           count(*) as settled
         from pilot.shadow_film_study_proposals
         where organization_id = $1
           and model_deployment = $2
           and review_state <> 'pending_review'
           and ${proposals.MODEL_PROPOSAL_SCOPE_SQL}`,
        [ORG_ID, deployment],
      );
      expect(Number(scoped.rows[0].accepted)).toBe(0);
      expect(Number(scoped.rows[0].settled)).toBe(1);

      // Unscoped, the same window would read as 1 of 2 -- the contamination
      // this predicate exists to prevent.
      const unscoped = await client.query(
        `select count(*) filter (where review_state = 'accepted') as accepted, count(*) as settled
         from pilot.shadow_film_study_proposals
         where organization_id = $1
           and review_state <> 'pending_review'
           and proposal_id = any($2::uuid[])`,
        [ORG_ID, [modelProposal.proposal_id, coachReport.proposal_id]],
      );
      expect(Number(unscoped.rows[0].accepted)).toBe(1);
      expect(Number(unscoped.rows[0].settled)).toBe(2);
    } finally {
      await client.end();
    }
  });

  test('coach reports are scoped to their organization like everything else', async () => {
    const reported = await newCoachReport();

    const wrongOrg = await proposals.getFilmStudyProposal(OTHER_ORG_ID, reported.proposal_id);
    expect(wrongOrg).toBeNull();

    const rightOrg = await proposals.getFilmStudyProposal(ORG_ID, reported.proposal_id);
    expect(rightOrg?.proposal_id).toBe(reported.proposal_id);
  });
});
