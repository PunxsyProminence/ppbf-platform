/**
 * The consent-set phantom, against real PostgreSQL.
 *
 * Every consent reader locks the athlete's EXISTING pilot.guardian_links rows
 * FOR SHARE (guardianConsent.ts lockGuardianLinksForAthlete). A row lock cannot
 * cover a row that does not exist yet, so a guardian linked by a concurrent
 * transaction -- staffProvisioning's guardian invite, intake's
 * linkGuardianAthlete -- was never evaluated: the publish claim read the old
 * set, passed, and committed while a photo-only or withdrawn guardian was
 * being added beside it (ChatGPT post-merge review of #1261).
 *
 * The fix is one lock on the whole consent set (guardianConsent.ts
 * lockConsentSet): readers and consent writers take it shared, every link
 * insert takes it exclusive. These tests drive the SHIPPED link insert
 * (intake.ts linkGuardianAthlete) and the SHIPPED publish claim
 * (publishToResearchLibrary with the route's own verifyBeforeCommit checks)
 * and prove the claim either waits for the new guardian and reads them, or
 * the insert waits for the claim.
 *
 * Local disposable embedded Postgres only; never production or staging.
 */

import { type ChildProcessByStdio, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import type { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';

import { Client, type PoolClient } from 'pg';

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const PG_DATABASE = 'ppbf_test_consent_phantom';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-consent-phantom-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const FULL_SCHEMA_HELPER_PATH = path.resolve(__dirname, '../../../scripts/lib/full-schema.mjs');

const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

const ORG_ID = 'org-consent-phantom';
const COACH_ID = 'acct-phantom-coach';
const PARENT_ID = 'parent-phantom-first';
const NEW_PARENT_ID = 'parent-phantom-second';
const ATHLETE_ID = 'ath-phantom';
const OTHER_ATHLETE_ID = 'ath-phantom-other';
const VIDEO_SESSION_ID = 'vs-phantom';

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let client: Client;

let publication: typeof import('./publication');
let consent: typeof import('./guardianConsent');
let intake: typeof import('./intake');
let playback: typeof import('./videoPlaybackConsent');
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

async function writeConsent(
  executor: { query: Client['query'] },
  parentId: string,
  coversVideo: boolean,
): Promise<void> {
  await executor.query(
    `insert into pilot.waivers
       (organization_id, waiver_id, athlete_id, parent_id, waiver_type, signed_by_name,
        signed_by_role, signed_at, consent_version, status, covers_video)
     values ($1, gen_random_uuid(), $2, $3, 'photo_media', 'Phantom Guardian',
             'parent', now(), 'v1', 'signed', $4)`,
    [ORG_ID, ATHLETE_ID, parentId, coversVideo],
  );
}

async function seedApprovedPublication(): Promise<string> {
  const publicationId = `pub_${randomUUID().split('-')[0]}`;
  await client.query(
    `insert into pilot.video_publications
       (publication_id, organization_id, video_session_id, athlete_id, submitted_by_account_id,
        publication_type, title, description, status, compliance_check_status)
     values ($1, $2, $3, $4, $5, 'research_library', 'Jab mechanics', 'Six rounds.',
             'approved', 'passed')`,
    [publicationId, ORG_ID, VIDEO_SESSION_ID, ATHLETE_ID, COACH_ID],
  );
  return publicationId;
}

async function publicationStatus(publicationId: string): Promise<string> {
  const row = await client.query<{ status: string }>(
    'select status from pilot.video_publications where publication_id = $1',
    [publicationId],
  );
  return row.rows[0].status;
}

/** The publish route's claim, with its own in-transaction consent checks (publish/route.ts verifyBeforeCommit). */
function publish(publicationId: string, afterChecks?: (c: PoolClient) => Promise<void>) {
  return publication.publishToResearchLibrary({
    organizationId: ORG_ID,
    publicationId,
    videoSessionId: VIDEO_SESSION_ID,
    title: 'Jab mechanics',
    description: 'Six rounds.',
    verifyBeforeCommit: async (c) => {
      await consent.assertGuardianMediaConsentWithClient(c, ORG_ID, ATHLETE_ID);
      await playback.assertConsentCoversVideo(ORG_ID, ATHLETE_ID, c);
      if (afterChecks) await afterChecks(c as PoolClient);
    },
  });
}

/**
 * A second session that links NEW_PARENT_ID to athleteId through the shipped
 * linkGuardianAthlete, records that guardian's photo-only consent in the same
 * transaction, and leaves it open until the caller commits or rolls back.
 */
async function openLinkTransaction(athleteId: string) {
  const linker = new Client({ connectionString: connectionStringFor(PG_DATABASE) });
  await linker.connect();
  await linker.query('begin');
  const pidRow = await linker.query<{ pid: number }>('select pg_backend_pid() as pid');
  const linking = (async () => {
    await linker.query(
      `insert into pilot.parents (organization_id, parent_id, full_name)
       values ($1, $2, 'Second Guardian') on conflict do nothing`,
      [ORG_ID, NEW_PARENT_ID],
    );
    await intake.linkGuardianAthlete({
      organizationId: ORG_ID,
      parentId: NEW_PARENT_ID,
      athleteId,
      relationshipToAthlete: 'father',
    }, linker as unknown as PoolClient);
    if (athleteId === ATHLETE_ID) await writeConsent(linker, NEW_PARENT_ID, false);
  })();
  return {
    pid: pidRow.rows[0].pid,
    linking,
    async finish(outcome: 'commit' | 'rollback') {
      await linking.catch(() => undefined);
      await linker.query(outcome).catch(() => {});
      await linker.end().catch(() => {});
    },
  };
}

/** True once a backend other than this test's own (and `except`) is waiting on a lock, advisory included. */
async function someoneWaitsOnALock(except: number[] = [], attempts = 200): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const waiting = await client.query(
      `select 1 from pg_stat_activity
        where datname = current_database() and pid <> pg_backend_pid()
          and not (pid = any($1::int[])) and wait_event_type = 'Lock'`,
      [except],
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
     values ($1, 'coach', $2, 'microsoft') on conflict do nothing`,
    [COACH_ID, ORG_ID],
  );
  await client.query(
    `insert into pilot.athletes (organization_id, athlete_id, full_name, dob, weight_class, gym_status, emergency_contact, active_flag, coach_id, created_at, updated_at)
     values ($1, $2, 'Phantom Athlete', '2012-03-04', 'fly', 'active', 'contact', true, $4, now(), now()),
            ($1, $3, 'Other Athlete', '2012-03-04', 'fly', 'active', 'contact', true, $4, now(), now())`,
    [ORG_ID, ATHLETE_ID, OTHER_ATHLETE_ID, COACH_ID],
  );
  await client.query(
    `insert into pilot.parents (organization_id, parent_id, full_name) values ($1, $2, 'First Guardian')`,
    [ORG_ID, PARENT_ID],
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

  process.env.AZURE_POSTGRES_CONNECTION_STRING = connectionStringFor(PG_DATABASE);
  process.env.PPBF_POSTGRES_DISABLE_SSL = 'true';
  publication = await import('./publication');
  consent = await import('./guardianConsent');
  intake = await import('./intake');
  playback = await import('./videoPlaybackConsent');
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
  await client.query('delete from pilot.research_library');
  await client.query('delete from pilot.video_publications');
  await client.query('delete from pilot.waivers');
  await client.query('delete from pilot.guardian_links where parent_id = $1', [NEW_PARENT_ID]);
  await writeConsent(client, PARENT_ID, true);
});

function refusalCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : 'rejected';
}

/*
 * Nothing is asserted while a transaction is held open: an assertion that
 * throws there leaves a pool connection mid-transaction and the suite hangs at
 * teardown instead of failing (consentWithdrawalRace.pg.test.ts records the
 * same lesson). Values are captured, everything is released in a finally, and
 * the assertions run afterwards.
 */
describe('a guardian linked mid-publish is never skipped', () => {
  test('CONTROL: with only the video-consenting guardian, the publish lands', async () => {
    const publicationId = await seedApprovedPublication();
    expect(await publish(publicationId)).not.toBeNull();
    expect(await publicationStatus(publicationId)).toBe('published');
  });

  test('link first: the claim waits for the new guardian, reads their photo-only consent, and refuses', async () => {
    const publicationId = await seedApprovedPublication();
    const link = await openLinkTransaction(ATHLETE_ID);
    let claimWaited = false;
    let publishing: Promise<string | null> | null = null;
    try {
      await link.linking;
      publishing = publish(publicationId);
      claimWaited = await someoneWaitsOnALock([link.pid], 80);
    } finally {
      await link.finish('commit');
    }
    const outcome = await publishing!.then(() => 'published').catch(refusalCode);

    expect(claimWaited).toBe(true);
    expect(outcome).toBe('GUARDIAN_CONSENT_EXCLUDES_VIDEO');
    expect(await publicationStatus(publicationId)).toBe('approved');
  });

  test('claim first: the link insert waits until the claim has committed', async () => {
    const publicationId = await seedApprovedPublication();
    let release: () => void = () => {};
    const released = new Promise<void>((resolve) => { release = resolve; });
    let checked: (pid: number) => void = () => {};
    const claimHoldsLock = new Promise<number>((resolve) => { checked = resolve; });

    const publishing = publish(publicationId, async (c) => {
      const pid = await c.query<{ pid: number }>('select pg_backend_pid() as pid');
      checked(pid.rows[0].pid);
      await released;
    });
    const claimPid = await claimHoldsLock;

    let link: Awaited<ReturnType<typeof openLinkTransaction>> | null = null;
    let insertWaited = false;
    try {
      link = await openLinkTransaction(ATHLETE_ID);
      insertWaited = await someoneWaitsOnALock([claimPid], 80);
    } finally {
      release();
    }
    const outcome = await publishing.then(() => 'published').catch(refusalCode);
    await link?.finish('commit');

    expect(insertWaited).toBe(true);
    expect(outcome).toBe('published');
  });

  test('CONTROL: linking a guardian to a different athlete does not wait on the claim', async () => {
    const publicationId = await seedApprovedPublication();
    let release: () => void = () => {};
    const released = new Promise<void>((resolve) => { release = resolve; });
    let checked: (pid: number) => void = () => {};
    const claimHoldsLock = new Promise<number>((resolve) => { checked = resolve; });

    const publishing = publish(publicationId, async (c) => {
      const pid = await c.query<{ pid: number }>('select pg_backend_pid() as pid');
      checked(pid.rows[0].pid);
      await released;
    });
    const claimPid = await claimHoldsLock;

    let insertWaited = true;
    let link: Awaited<ReturnType<typeof openLinkTransaction>> | null = null;
    try {
      link = await openLinkTransaction(OTHER_ATHLETE_ID);
      await link.linking;
      insertWaited = await someoneWaitsOnALock([claimPid], 20);
    } finally {
      release();
      await link?.finish('rollback');
    }
    await publishing.catch(() => undefined);

    expect(insertWaited).toBe(false);
  });
});
