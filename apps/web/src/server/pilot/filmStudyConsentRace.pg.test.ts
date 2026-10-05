/**
 * Film Study's last consent check and its proposal write, against a
 * consent withdrawal, on real PostgreSQL.
 *
 * #1212 made the worker re-read consent just before persisting a proposal,
 * but as two pooled statements: a withdrawal committing between the read and
 * the insert still left a pending proposal about a child whose guardian had
 * just said no. The worker now does both in one transaction
 * (writeUnderFilmStudyConsent) whose consent read holds the guardian links
 * FOR SHARE -- the row withdrawMediaConsent takes FOR UPDATE before it
 * writes (consentWithdrawalRace.pg.test.ts proves that half).
 *
 * Two interleavings, both driven by locks rather than timing:
 *   - a withdrawal already in flight when the check runs: the check waits,
 *     then reads it as withdrawn, and nothing is written;
 *   - a withdrawal starting after the check: it waits until the proposal has
 *     committed, so it is recorded after it, never between.
 * Without the FOR SHARE, the first writes a proposal and the second does not
 * wait at all; each test fails on that.
 *
 * Spins up the same disposable, local-only embedded Postgres the other
 * migration suites use. It NEVER connects to production or staging.
 */

import { type ChildProcessByStdio, spawn } from 'node:child_process';
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
const PG_DATABASE = 'ppbf_test_film_consent_race';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-film-consent-race-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const FULL_SCHEMA_HELPER_PATH = path.resolve(__dirname, '../../../scripts/lib/full-schema.mjs');

const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

const ORG_ID = 'org-film-race';
const COACH_ID = 'acct-film-race-coach';
const GUARDIAN_ACCOUNT_ID = 'acct-film-race-guardian';
const PARENT_ID = 'parent-film-race';
const ATHLETE_ID = 'ath-film-race';
const VIDEO_SESSION_ID = 'vs-film-race';

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let client: Client;

type FilmStudyConsentModule = typeof import('./filmStudyConsent');
type ProposalsModule = typeof import('./shadowFilmStudyProposals');
type ConsentModule = typeof import('./guardianConsent');
let filmConsent: FilmStudyConsentModule;
let proposals: ProposalsModule;
let consent: ConsentModule;
let closePool: () => Promise<void>;

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

async function writeSignedVideoConsent(): Promise<void> {
  await client.query(
    `insert into pilot.waivers
       (organization_id, waiver_id, athlete_id, parent_id, waiver_type, signed_by_name,
        signed_by_role, signed_at, consent_version, status, covers_video)
     values ($1, gen_random_uuid(), $2, $3, 'photo_media', 'Race Guardian',
             'parent', now(), 'v1', 'signed', true)`,
    [ORG_ID, ATHLETE_ID, PARENT_ID],
  );
}

/** The worker's last step, through the shipped functions. */
function writeProposal(beforeInsert: () => Promise<void> = async () => {}) {
  return filmConsent.writeUnderFilmStudyConsent(ORG_ID, VIDEO_SESSION_ID, ATHLETE_ID, async (tx) => {
    await beforeInsert();
    return proposals.createFilmStudyProposal({
      organizationId: ORG_ID,
      athleteId: ATHLETE_ID,
      videoSessionId: VIDEO_SESSION_ID,
      jobId: null,
      observationText: 'The lead hand returns below the chin after the jab.',
      modelDeployment: 'race-test',
      framesAnalyzed: 3,
    }, tx);
  });
}

async function proposalCount(): Promise<number> {
  const row = await client.query<{ n: string }>(
    'select count(*) as n from pilot.shadow_film_study_proposals where organization_id = $1',
    [ORG_ID],
  );
  return Number(row.rows[0].n);
}

async function someBackendIsWaitingOnALock(): Promise<boolean> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const waiting = await client.query<{ pid: number }>(
      `select pid from pg_stat_activity
        where datname = current_database()
          and pid <> pg_backend_pid()
          and wait_event_type = 'Lock'`,
    );
    if ((waiting.rowCount ?? 0) > 0) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
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
  await admin.query(`drop database if exists ${PG_DATABASE}`);
  await admin.query(`create database ${PG_DATABASE}`);
  await admin.end();

  client = new Client({ connectionString: connectionStringFor(PG_DATABASE) });
  await client.connect();

  const { applyFullSchema } = (await nativeDynamicImport(
    pathToFileURL(FULL_SCHEMA_HELPER_PATH).href,
  )) as { applyFullSchema: (c: Client) => Promise<void> };
  await applyFullSchema(client);

  await client.query(
    `insert into pilot.organizations (organization_id, organization_name, status)
     values ($1, $1, 'active') on conflict do nothing`,
    [ORG_ID],
  );
  await client.query(
    `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
     values ($1, 'coach', $3, 'microsoft'), ($2, 'parent', $3, 'microsoft')
     on conflict do nothing`,
    [COACH_ID, GUARDIAN_ACCOUNT_ID, ORG_ID],
  );
  await client.query(
    `insert into pilot.athletes (organization_id, athlete_id, full_name, dob, weight_class, gym_status, emergency_contact, active_flag, coach_id, created_at, updated_at)
     values ($1, $2, 'Race Athlete', '2012-03-04', 'fly', 'active', 'contact', true, $3, now(), now())`,
    [ORG_ID, ATHLETE_ID, COACH_ID],
  );
  await client.query(
    `insert into pilot.parents (organization_id, parent_id, account_id, full_name)
     values ($1, $2, $3, 'Race Guardian')`,
    [ORG_ID, PARENT_ID, GUARDIAN_ACCOUNT_ID],
  );
  await client.query(
    `insert into pilot.guardian_links (organization_id, parent_id, athlete_id, relationship_to_athlete)
     values ($1, $2, $3, 'mother')`,
    [ORG_ID, PARENT_ID, ATHLETE_ID],
  );
  await client.query(
    `insert into pilot.video_sessions
       (video_session_id, organization_id, uploaded_by_account_id, athlete_id, title, notes,
        blob_path, file_name, file_size_bytes, mime_type, status, created_at, updated_at)
     values ($1, $2, $3, $4, 'Session tape', '', $2 || '/tape.mp4', 'tape.mp4', 1024, 'video/mp4', 'ready', now(), now())`,
    [VIDEO_SESSION_ID, ORG_ID, COACH_ID, ATHLETE_ID],
  );

  // Env before import: db.ts builds its pool on first use.
  process.env.AZURE_POSTGRES_CONNECTION_STRING = connectionStringFor(PG_DATABASE);
  process.env.PPBF_POSTGRES_DISABLE_SSL = 'true';
  filmConsent = await import('./filmStudyConsent');
  proposals = await import('./shadowFilmStudyProposals');
  consent = await import('./guardianConsent');
  ({ closePool } = await import('./db'));
});

afterAll(async () => {
  await closePool?.();
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
  await fs.rm(DATA_DIR, { recursive: true, force: true }).catch(() => {});
});

beforeEach(async () => {
  await client.query('delete from pilot.shadow_film_study_proposals');
  await client.query('delete from pilot.waivers');
  await writeSignedVideoConsent();
});

describe("Film Study's last consent check and its write cannot straddle a withdrawal", () => {
  test('CONTROL: with video consent signed and nobody holding the link, the proposal is written', async () => {
    // Without this the refusal below proves nothing, and if this waited, the
    // waits below could be on something incidental rather than the link.
    const before = Date.now();
    await writeProposal();

    expect(Date.now() - before).toBeLessThan(2000);
    expect(await proposalCount()).toBe(1);
  });

  test('a withdrawal in flight is waited for, read as withdrawn, and nothing is written', async () => {
    /* The holder is a withdrawal stopped halfway: withdrawMediaConsent's own
       two statements (writeMediaConsentUnderLock), link locked FOR UPDATE and
       the withdrawn row inserted, not yet committed. Nothing is asserted
       while it is held -- a throw there leaves the blocked transaction on its
       pool connection and the run hangs at teardown instead of failing. */
    const holder = new Client({ connectionString: connectionStringFor(PG_DATABASE) });
    await holder.connect();
    let observedBlocked = false;
    let writing: Promise<unknown> | null = null;
    try {
      await holder.query('begin');
      await holder.query(
        `select 1 from pilot.guardian_links
          where organization_id = $1 and parent_id = $2 and athlete_id = $3
          for update`,
        [ORG_ID, PARENT_ID, ATHLETE_ID],
      );
      await holder.query(
        `insert into pilot.waivers
           (organization_id, waiver_id, athlete_id, parent_id, waiver_type, signed_by_name,
            signed_by_role, signed_at, consent_version, status, covers_video)
         values ($1, gen_random_uuid(), $2, $3, 'photo_media', 'Race Guardian',
                 'parent', now(), 'v1', 'withdrawn', false)`,
        [ORG_ID, ATHLETE_ID, PARENT_ID],
      );

      writing = writeProposal().then(
        () => 'written',
        (error: unknown) => error,
      );
      observedBlocked = await someBackendIsWaitingOnALock();
      await holder.query('commit');
    } finally {
      await holder.query('rollback').catch(() => {});
      await holder.end().catch(() => {});
    }

    const outcome = await writing;

    // Without the FOR SHARE the check reads the committed 'signed' row
    // straight past the uncommitted withdrawal: no wait, and a proposal.
    expect(observedBlocked).toBe(true);
    expect(outcome).toMatchObject({ code: 'GUARDIAN_CONSENT_WITHDRAWN' });
    expect(filmConsent.filmStudyConsentFailureCode(outcome)).toBe('SHADOW_FILM_CONSENT_WITHDRAWN');
    expect(await proposalCount()).toBe(0);
  });

  test('a withdrawal arriving after the check waits until the proposal has committed', async () => {
    /* The real withdrawMediaConsent this time. The write is paused between
       its consent check and its insert -- the exact gap #1212 left open --
       while the withdrawal is issued. */
    let releaseInsert: () => void = () => {};
    const insertGate = new Promise<void>((resolve) => {
      releaseInsert = resolve;
    });
    let checked: () => void = () => {};
    const checkDone = new Promise<void>((resolve) => {
      checked = resolve;
    });

    const writing = writeProposal(async () => {
      checked();
      await insertGate;
    });
    await checkDone;

    let withdrawalSettled = false;
    const withdrawing = consent.withdrawMediaConsent({
      organizationId: ORG_ID,
      athleteId: ATHLETE_ID,
      parentId: PARENT_ID,
      signedByName: 'Race Guardian',
      recordedByAccountId: GUARDIAN_ACCOUNT_ID,
    }).finally(() => {
      withdrawalSettled = true;
    });
    const observedBlocked = await someBackendIsWaitingOnALock();
    const settledWhileHeld = withdrawalSettled;

    releaseInsert();
    await writing;
    await withdrawing;

    // Without the FOR SHARE the withdrawal commits at once, inside the gap.
    expect(observedBlocked).toBe(true);
    expect(settledWhileHeld).toBe(false);
    expect(await proposalCount()).toBe(1);
  });
});
