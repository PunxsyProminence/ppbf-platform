/**
 * The consent-withdrawal race, against real PostgreSQL.
 *
 * publication.ts and guardianConsent.ts BOTH carry the same guarantee, in
 * prose, in their own comments:
 *
 *   "In no interleaving does a publish survive a withdrawal unsuppressed."
 *
 * The mechanism is a lock pair on pilot.guardian_links -- the publish path's
 * consent re-check holds FOR SHARE (guardianConsent.ts
 * assertGuardianMediaConsentWithClient), the withdrawal sweep holds FOR UPDATE
 * (publication.ts suppressPublishedMediaForAthlete) -- and nothing executed it.
 * The consent suite proves the gate FUNCTION exhaustively and stops at the
 * gate; the downstream consumers are covered with the gate MOCKED. The join
 * between the two halves, which is where the guarantee actually lives, was
 * unmeasured.
 *
 * What is at stake if the lock is not doing what the comment says: the sweep's
 * `where status = 'published'` runs before an in-flight publish commits, finds
 * nothing to retract, and the publish then lands. A video of a minor stays on
 * the research shelf after their guardian withdrew consent, and every
 * per-component test still passes.
 *
 * The interleaving is driven deterministically rather than by timing, and
 * through the SHIPPED functions rather than restated SQL:
 * publishToResearchLibrary takes verifyBeforeCommit as a parameter, so a test
 * can run the real consent re-check and then hold that transaction open at
 * exactly the moment the lock is held.
 *
 * Spins up the same disposable, local-only embedded Postgres the other
 * migration suites use. It NEVER connects to production or staging.
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

import { Client } from 'pg';

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const PG_DATABASE = 'ppbf_test_consent_race';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-consent-race-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const FULL_SCHEMA_HELPER_PATH = path.resolve(__dirname, '../../../scripts/lib/full-schema.mjs');

const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

const ORG_ID = 'org-consent-race';
const COACH_ID = 'acct-consent-race-coach';
const GUARDIAN_ACCOUNT_ID = 'acct-consent-race-guardian';
const PARENT_ID = 'parent-consent-race';
const ATHLETE_ID = 'ath-consent-race';
const VIDEO_SESSION_ID = 'vs-consent-race';

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let client: Client;

type PublicationModule = typeof import('./publication');
type ConsentModule = typeof import('./guardianConsent');
let publication: PublicationModule;
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

/** Append-only, exactly as the consent path writes it: a new row supersedes. */
async function writeConsent(status: 'signed' | 'withdrawn'): Promise<void> {
  await client.query(
    `insert into pilot.waivers
       (organization_id, waiver_id, athlete_id, parent_id, waiver_type, signed_by_name,
        signed_by_role, signed_at, consent_version, status, covers_video)
     values ($1, gen_random_uuid(), $2, $3, 'photo_media', 'Race Guardian',
             'parent', now(), 'v1', $4, true)`,
    [ORG_ID, ATHLETE_ID, PARENT_ID, status],
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

  // Base schema plus every migration in dependency order: this suite needs
  // publications, video sessions AND the guardian-media-consent columns on
  // pilot.waivers, and hand-picking that set is how a suite silently drifts
  // from what a migrated environment actually has.
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
  publication = await import('./publication');
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
  await client.query('delete from pilot.research_library');
  await client.query('delete from pilot.video_publications');
  await client.query('delete from pilot.waivers');
});

describe('a publish cannot outlive a consent withdrawal', () => {
  test('CONTROL: with consent granted, the publish lands on the shelf', async () => {
    // Without this the two refusal cases below prove nothing -- a publish that
    // can never succeed refuses for free.
    await writeConsent('signed');
    const publicationId = await seedApprovedPublication();

    const libraryId = await publication.publishToResearchLibrary({
      organizationId: ORG_ID,
      publicationId,
      videoSessionId: VIDEO_SESSION_ID,
      title: 'Jab mechanics',
      description: 'Six rounds.',
      verifyBeforeCommit: (c) => consent.assertGuardianMediaConsentWithClient(c, ORG_ID, ATHLETE_ID),
    });

    expect(libraryId).not.toBeNull();
    expect(await publicationStatus(publicationId)).toBe('published');
  });

  test('a withdrawal already committed refuses the publish outright', async () => {
    await writeConsent('signed');
    await writeConsent('withdrawn');
    const publicationId = await seedApprovedPublication();

    await expect(
      publication.publishToResearchLibrary({
        organizationId: ORG_ID,
        publicationId,
        videoSessionId: VIDEO_SESSION_ID,
        title: 'Jab mechanics',
        description: 'Six rounds.',
        verifyBeforeCommit: (c) => consent.assertGuardianMediaConsentWithClient(c, ORG_ID, ATHLETE_ID),
      }),
    ).rejects.toBeInstanceOf(consent.GuardianConsentMissingError);

    // The transaction rolled back: nothing on the shelf, status untouched.
    expect(await publicationStatus(publicationId)).toBe('approved');
    const shelf = await client.query('select 1 from pilot.research_library');
    expect(shelf.rowCount).toBe(0);
  });

  test('THE RACE: a publish in flight when the withdrawal sweeps ends retracted, not published', async () => {
    await writeConsent('signed');
    const publicationId = await seedApprovedPublication();

    let releasePublish: () => void = () => {};
    const publishReleased = new Promise<void>((resolve) => {
      releasePublish = resolve;
    });
    let lockHeld: (pid: number) => void = () => {};
    const publishHoldsLock = new Promise<number>((resolve) => {
      lockHeld = resolve;
    });

    // The publish runs the REAL consent re-check -- which is what takes FOR
    // SHARE on guardian_links -- and then holds its transaction open at
    // exactly that point, so the sweep below meets a lock that is genuinely
    // held rather than one this test simulated.
    const publishing = publication.publishToResearchLibrary({
      organizationId: ORG_ID,
      publicationId,
      videoSessionId: VIDEO_SESSION_ID,
      title: 'Jab mechanics',
      description: 'Six rounds.',
      verifyBeforeCommit: async (c) => {
        await consent.assertGuardianMediaConsentWithClient(c, ORG_ID, ATHLETE_ID);
        const pid = await c.query<{ pid: number }>('select pg_backend_pid() as pid');
        lockHeld(pid.rows[0].pid);
        await publishReleased;
      },
    });

    const publishPid = await publishHoldsLock;

    // The guardian withdraws. The waiver commits first and the sweep runs
    // after it, which is the order the consent route uses.
    await writeConsent('withdrawn');
    const sweeping = publication.suppressPublishedMediaForAthlete({
      organizationId: ORG_ID,
      athleteId: ATHLETE_ID,
      suppressedByAccountId: GUARDIAN_ACCOUNT_ID,
      reason: 'guardian_consent_withdrawn',
    });

    // NEGATIVE CONTROL. If the sweep were NOT blocked it would run past the
    // in-flight publish, find no published row to retract, and this test could
    // pass for the wrong reason. Observing the block is what makes the
    // assertion below mean what it says.
    //
    // The release is in a finally, and both promises are drained before any
    // assertion runs, because the first draft asserted inside this block: when
    // the lock was mutated away the assertion threw, releasePublish() never
    // fired, the publish transaction held its pool connection open, and the
    // suite HUNG at closePool instead of failing. A test that cannot fail
    // cannot be watched to fail.
    let sweepBlocked = false;
    try {
      for (let attempt = 0; attempt < 200 && !sweepBlocked; attempt += 1) {
        const backends = await client.query<{ pid: number }>(
          `select pid from pg_stat_activity
            where datname = current_database() and pid <> pg_backend_pid() and pid <> $1
              and wait_event_type = 'Lock'`,
          [publishPid],
        );
        sweepBlocked = (backends.rowCount ?? 0) > 0;
        if (!sweepBlocked) await new Promise((resolve) => setTimeout(resolve, 25));
      }
    } finally {
      releasePublish();
    }

    // Drained, not asserted on: if the lock is gone these still settle, and the
    // assertions below are what report it.
    const publishOutcome = await publishing.then(() => 'resolved').catch(() => 'rejected');
    await sweeping.catch(() => undefined);

    expect(sweepBlocked).toBe(true);
    expect(publishOutcome).toBe('resolved');

    // The publish committed -- and the sweep, which had to wait for it, then
    // caught it. A shelf row for a withdrawn consent is the harm this whole
    // lock pair exists to prevent.
    expect(await publicationStatus(publicationId)).toBe('retracted');
  });
});

/**
 * THE OTHER HALF OF THE LOCK PAIR. Owner decision D-2, 2026-08-28.
 *
 * The suite above proves the READ side: a publish holding FOR SHARE on
 * pilot.guardian_links makes the withdrawal's sweep wait, so no publish
 * outlives a withdrawal unsuppressed.
 *
 * It could not prove anything about the WRITE, because the write took no lock
 * at all. withdrawMediaConsent was a bare pooled insert that committed on its
 * own the moment it returned, so nothing any reader held could order itself
 * against it -- and the readers are the ones making safety decisions. A
 * withdrawal committing between a reader's check and its action was simply
 * missed; on staffProvisioning.removeGuardianLink's path it was missed
 * PERMANENTLY, the withdrawal recorded and the link deleted, leaving the
 * guardian who withdrew out of the consent answer entirely.
 *
 * These prove the write now participates: it waits for a reader's lock, and
 * it records the decision on the far side of that wait.
 */
describe('the consent write takes the lock the readers take', () => {
  /** Holds FOR UPDATE on the guardian link row, as a reader would. */
  async function holdingTheLink<T>(body: () => Promise<T>): Promise<T> {
    const holder = new Client({ connectionString: connectionStringFor(PG_DATABASE) });
    await holder.connect();
    try {
      await holder.query('begin');
      await holder.query(
        `select 1 from pilot.guardian_links
          where organization_id = $1 and parent_id = $2 and athlete_id = $3
          for update`,
        [ORG_ID, PARENT_ID, ATHLETE_ID],
      );
      return await body();
    } finally {
      await holder.query('rollback').catch(() => {});
      await holder.end().catch(() => {});
    }
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

  async function currentStatus(): Promise<string | null> {
    const row = await client.query<{ status: string }>(
      `select status from pilot.waivers
        where organization_id = $1 and athlete_id = $2 and parent_id = $3
        order by created_at desc limit 1`,
      [ORG_ID, ATHLETE_ID, PARENT_ID],
    );
    return row.rows[0]?.status ?? null;
  }

  test('a withdrawal waits for a reader holding the link, then records', async () => {
    /* NOTHING IS ASSERTED INSIDE THE HELD BLOCK. The suite above records why
       in its own words: an assertion that throws while the lock is held leaves
       the blocked transaction holding its pool connection, and the run hangs
       at teardown instead of failing. Both values are captured, the lock is
       released in a finally, and the assertions run afterwards. */
    let observedBlocked = false;
    let withdrawing: Promise<string> | null = null;

    await holdingTheLink(async () => {
      withdrawing = consent.withdrawMediaConsent({
        organizationId: ORG_ID,
        athleteId: ATHLETE_ID,
        parentId: PARENT_ID,
        signedByName: 'Race Guardian',
        recordedByAccountId: GUARDIAN_ACCOUNT_ID,
      });
      observedBlocked = await someBackendIsWaitingOnALock();
    });

    await withdrawing;

    // The negative control, and the assertion that actually distinguishes
    // this change from the code it replaces: without the lock in the writer
    // the insert would have committed immediately and this is false.
    expect(observedBlocked).toBe(true);
    expect(await currentStatus()).toBe('withdrawn');
  });

  test('a grant waits on the same lock -- both writers, or they drift', async () => {
    let observedBlocked = false;
    let granting: Promise<string> | null = null;

    await holdingTheLink(async () => {
      granting = consent.grantMediaConsent({
        organizationId: ORG_ID,
        athleteId: ATHLETE_ID,
        parentId: PARENT_ID,
        signedByName: 'Race Guardian',
        recordedByAccountId: GUARDIAN_ACCOUNT_ID,
        coversVideo: true,
        publicUseAllowed: false,
      });
      observedBlocked = await someBackendIsWaitingOnALock();
    });

    await granting;

    expect(observedBlocked).toBe(true);
    expect(await currentStatus()).toBe('signed');
  });

  test('with nobody holding the link, a withdrawal does not wait', async () => {
    /* The control that keeps the two above from passing for the wrong reason.
       If they were blocking on something incidental -- the pool, a connection
       limit, an unrelated lock -- this would block too. It must not. */
    const before = Date.now();
    await consent.withdrawMediaConsent({
      organizationId: ORG_ID,
      athleteId: ATHLETE_ID,
      parentId: PARENT_ID,
      signedByName: 'Race Guardian',
      recordedByAccountId: GUARDIAN_ACCOUNT_ID,
    });

    expect(Date.now() - before).toBeLessThan(2000);
    expect(await currentStatus()).toBe('withdrawn');
  });
});
