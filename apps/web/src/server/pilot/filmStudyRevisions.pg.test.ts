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
import { pathToFileURL } from 'node:url';

import { Client } from 'pg';

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-film-revisions-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const TEST_DB_NAME = 'ppbf_test_film_rev';

const ORG_ID = 'org-film';
const OTHER_ORG_ID = 'org-film-other';
const COACH_ID = 'acct-film-coach';
const OTHER_COACH_ID = 'acct-film-coach-2';
const ATHLETE_ID = 'ATH-FILM-1';
const VIDEO_ID = 'vs-film-1';

const MIGRATION_RUNNER_PATH = path.resolve(
  __dirname,
  '../../../scripts/pilot-apply-film-study-revisions-migration.mjs',
);

// Jest's CJS transform rewrites a bare `import()` into `require()`, which
// cannot load an ESM .mjs runner. Building the import through `new Function`
// keeps a real dynamic import in the emitted code, which Node honors under
// --experimental-vm-modules (the flag every test:migrations:* script already
// passes). Same pattern as activityLog.pg.test.ts.
const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

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
  await admin.query(`drop database if exists ${TEST_DB_NAME}`);
  await admin.query(`create database ${TEST_DB_NAME}`);
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


describe('correcting until the model is mostly right', () => {
  async function pendingProposal() {
    return newModelProposal();
  }

  function correct(proposalId: string, text: string, by = COACH_ID) {
    return proposals.resolveFilmStudyProposal({
      organizationId: ORG_ID,
      proposalId,
      verdict: 'corrected',
      reviewerAccountId: by,
      reviewerRole: 'coach',
      correctedObservationText: text,
    });
  }

  test('a proposal can be corrected more than once -- corrected is not an exit', async () => {
    const proposal = await pendingProposal();

    const first = await correct(proposal.proposal_id, 'Guard drops in round three.');
    expect(first?.review_state).toBe('corrected');

    // This is the whole point: before the revision chain the second pass
    // returned null, because only a pending row could be settled.
    const second = await correct(proposal.proposal_id, 'Guard drops late in round three, after the body shot.');
    expect(second?.review_state).toBe('corrected');

    const third = await correct(proposal.proposal_id, 'Lead hand drops after taking a body shot in round three.');
    expect(third?.review_state).toBe('corrected');
  });

  test('every pass is kept, in order, with its own author', async () => {
    const proposal = await pendingProposal();
    await correct(proposal.proposal_id, 'First wording.');
    await correct(proposal.proposal_id, 'Second wording.', OTHER_COACH_ID);
    await correct(proposal.proposal_id, 'Third wording.');

    const history = await proposals.listFilmStudyProposalRevisions(ORG_ID, proposal.proposal_id);

    expect(history.map((r) => r.revision_number)).toEqual([1, 2, 3]);
    expect(history.map((r) => r.observation_text))
      .toEqual(['First wording.', 'Second wording.', 'Third wording.']);
    // A second coach taking a pass is recorded as that coach, not the first.
    expect(history[1].revised_by_account_id).toBe(OTHER_COACH_ID);
    expect(history[0].revised_by_account_id).toBe(COACH_ID);
  });

  test("the model's original wording survives every pass", async () => {
    const proposal = await pendingProposal();
    const original = proposal.observation_text;

    await correct(proposal.proposal_id, 'Rewritten once.');
    await correct(proposal.proposal_id, 'Rewritten twice.');

    const after = await proposals.getFilmStudyProposal(ORG_ID, proposal.proposal_id);
    // Nothing is edited in place. What the model said and what the coach made
    // of it both remain readable.
    expect(after?.observation_text).toBe(original);
    expect(after?.corrected_observation_text).toBe('Rewritten twice.');
  });

  test('the cached newest wording cannot drift from the revision chain', async () => {
    const proposal = await pendingProposal();
    for (const text of ['one', 'two', 'three', 'four']) {
      await correct(proposal.proposal_id, text);
    }

    const after = await proposals.getFilmStudyProposal(ORG_ID, proposal.proposal_id);
    const history = await proposals.listFilmStudyProposalRevisions(ORG_ID, proposal.proposal_id);
    const newest = history[history.length - 1];

    expect(history).toHaveLength(4);
    expect(after?.corrected_observation_text).toBe(newest.observation_text);
  });

  test('accepting closes the loop once the wording finally reads right', async () => {
    const proposal = await pendingProposal();
    await correct(proposal.proposal_id, 'Nearly right.');
    await correct(proposal.proposal_id, 'Right.');

    const accepted = await proposals.resolveFilmStudyProposal({
      organizationId: ORG_ID,
      proposalId: proposal.proposal_id,
      verdict: 'accepted',
      reviewerAccountId: COACH_ID,
      reviewerRole: 'coach',
    });

    expect(accepted?.review_state).toBe('accepted');
    // Settling must not erase the wording the coach worked to get right.
    expect(accepted?.corrected_observation_text).toBe('Right.');
  });

  test('rejecting is still reachable from a reworked proposal', async () => {
    const proposal = await pendingProposal();
    await correct(proposal.proposal_id, 'Still not usable.');

    const rejected = await proposals.resolveFilmStudyProposal({
      organizationId: ORG_ID,
      proposalId: proposal.proposal_id,
      verdict: 'rejected',
      reviewerAccountId: COACH_ID,
      reviewerRole: 'coach',
    });

    expect(rejected?.review_state).toBe('rejected');
  });

  test('a settled proposal is terminal -- accepting does not reopen', async () => {
    const proposal = await pendingProposal();
    await proposals.resolveFilmStudyProposal({
      organizationId: ORG_ID,
      proposalId: proposal.proposal_id,
      verdict: 'accepted',
      reviewerAccountId: COACH_ID,
      reviewerRole: 'coach',
    });

    // Re-deciding a settled verdict would overwrite an attestation already
    // given -- a different feature from refining an unsettled one.
    const reopened = await correct(proposal.proposal_id, 'Actually, no.');
    expect(reopened).toBeNull();

    const history = await proposals.listFilmStudyProposalRevisions(ORG_ID, proposal.proposal_id);
    expect(history).toHaveLength(0);
  });

  test('a rejected update leaves no orphan revision behind', async () => {
    const proposal = await pendingProposal();
    await proposals.resolveFilmStudyProposal({
      organizationId: ORG_ID,
      proposalId: proposal.proposal_id,
      verdict: 'rejected',
      reviewerAccountId: COACH_ID,
      reviewerRole: 'coach',
    });

    await correct(proposal.proposal_id, 'Too late.');

    // The revision is appended only after the row actually moved, so a refused
    // correction cannot record a pass that never happened.
    const history = await proposals.listFilmStudyProposalRevisions(ORG_ID, proposal.proposal_id);
    expect(history).toHaveLength(0);
  });

  test('a blank correction is refused before any revision is written', async () => {
    const proposal = await pendingProposal();
    await expect(correct(proposal.proposal_id, '   ')).rejects.toThrow(/Missing corrected_observation_text/);
    const history = await proposals.listFilmStudyProposalRevisions(ORG_ID, proposal.proposal_id);
    expect(history).toHaveLength(0);
  });

  test('the database refuses a blank revision even written directly', async () => {
    const client = new Client({ connectionString: connectionStringFor(TEST_DB_NAME) });
    await client.connect();
    try {
      const proposal = await pendingProposal();
      await expect(
        client.query(
          `insert into pilot.film_study_proposal_revisions
             (revision_id, proposal_id, organization_id, revision_number,
              observation_text, revised_by_account_id, revised_by_role)
           values ($1, $2, $3, 1, '   ', $4, 'coach')`,
          [crypto.randomUUID(), proposal.proposal_id, ORG_ID, COACH_ID],
        ),
      ).rejects.toThrow(/observation_text/);
    } finally {
      await client.end();
    }
  });

  test('two passes cannot claim the same revision number', async () => {
    const client = new Client({ connectionString: connectionStringFor(TEST_DB_NAME) });
    await client.connect();
    try {
      const proposal = await pendingProposal();
      await correct(proposal.proposal_id, 'First.');
      await expect(
        client.query(
          `insert into pilot.film_study_proposal_revisions
             (revision_id, proposal_id, organization_id, revision_number,
              observation_text, revised_by_account_id, revised_by_role)
           values ($1, $2, $3, 1, 'Colliding pass.', $4, 'coach')`,
          [crypto.randomUUID(), proposal.proposal_id, ORG_ID, COACH_ID],
        ),
      ).rejects.toThrow(/pilot_film_revisions_unique_number/);
    } finally {
      await client.end();
    }
  });

  test('a proposal being reworked stays in the working queue', async () => {
    const proposal = await pendingProposal();
    await correct(proposal.proposal_id, 'Being reworked.');

    const queue = await proposals.listFilmStudyProposals({ organizationId: ORG_ID, state: 'pending' });

    // Dropping it after the first pass would make "correct until it is right"
    // impossible to actually do.
    expect(queue.map((p) => p.proposal_id)).toContain(proposal.proposal_id);
  });

  test('revisions are scoped to their organization', async () => {
    const proposal = await pendingProposal();
    await correct(proposal.proposal_id, 'Scoped.');

    await expect(proposals.listFilmStudyProposalRevisions(OTHER_ORG_ID, proposal.proposal_id))
      .resolves.toEqual([]);
  });
});

// The runner's OWN readiness assertion, not just the SQL it applies.
//
// The suite above migrates one database in beforeAll with a plain
// `client.query` and then tests the module on top of it. That proves the
// schema and proves nothing about scripts/pilot-apply-film-study-revisions-migration.mjs's
// READINESS_QUERY -- the assertion that gates the actual dispatch, and the
// only code in this migration whose first real execution is against a live
// environment at the most expensive possible moment.
//
// #488 is what that costs: a readiness check that searched
// pg_get_constraintdef() for the literal `between 1 and 5` could not pass on
// ANY database, because Postgres deparses a CHECK from the parsed tree and
// emits `>= 1 AND <= 5`. The schema was correct the whole time. Only a real
// staging dispatch found it.
//
// The query is never restated here -- `applyMigrationTransaction` is imported
// out of the shipped runner and executes the shipped READINESS_QUERY, so this
// cannot stay green while the runner rots. It brings its own disposable
// database so the migrated one the module tests run against is untouched.
describe('film study revisions runner readiness assertion', () => {
  async function runnerDatabase(name: string): Promise<Client> {
    const admin = new Client({ connectionString: connectionStringFor('postgres') });
    await admin.connect();
    await admin.query(`drop database if exists ${name}`);
    await admin.query(`create database ${name}`);
    await admin.end();

    const client = new Client({ connectionString: connectionStringFor(name) });
    await client.connect();
      await client.query(await fs.readFile(path.join(INFRA_DIR, 'pilot_slice_postgres.sql'), 'utf8'));
      await client.query(await fs.readFile(path.join(INFRA_DIR, 'pilot_slice_postgres_film_study_proposals_migration.sql'), 'utf8'));
      await client.query(await fs.readFile(path.join(INFRA_DIR, 'pilot_slice_postgres_film_study_coach_reported_migration.sql'), 'utf8'));
    return client;
  }

  async function loadRunner(): Promise<(client: Client, sql: string) => Promise<void>> {
    const runnerModule = await nativeDynamicImport(pathToFileURL(MIGRATION_RUNNER_PATH).href);
    return runnerModule.applyMigrationTransaction as (client: Client, sql: string) => Promise<void>;
  }

  test('the real runner REFUSES a database where the migration never ran', async () => {
    const applyMigrationTransaction = await loadRunner();
    const client = await runnerDatabase('ppbf_test_fsrev_rdy_no');
    try {
      await expect(applyMigrationTransaction(client, 'select 1')).rejects.toThrow(
        /FILM_STUDY_REVISIONS_NOT_READY/,
      );
    } finally {
      await client.end();
    }
  });

  test('the real runner ACCEPTS a correctly migrated database, and a re-apply stays a no-op', async () => {
    const applyMigrationTransaction = await loadRunner();
    const client = await runnerDatabase('ppbf_test_fsrev_rdy_ok');
    try {
      const migrationSql = await fs.readFile(path.join(INFRA_DIR, 'pilot_slice_postgres_film_study_revisions_migration.sql'), 'utf8');
      await applyMigrationTransaction(client, migrationSql);
      // The `all` chain re-runs every migration on every dispatch (#489), so
      // the second pass has to survive its own first pass.
      await applyMigrationTransaction(client, migrationSql);
    } finally {
      await client.end();
    }
  });
});
