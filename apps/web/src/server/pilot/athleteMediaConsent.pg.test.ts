/**
 * The adult athlete's own media consent (OD-2026-10-08-015), against real
 * PostgreSQL: the writer (athleteMediaConsent.ts), the new-publication gate
 * (guardianConsent.ts assertNewPublicationConsentPath) driven through the
 * SHIPPED publish claim in the route's own in-transaction order, the
 * withdrawal sweep, and the lock that orders a withdrawal against a publish
 * even when the adult has no guardian link row to lock.
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
const PG_DATABASE = 'ppbf_test_athlete_media_consent';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-athlete-media-consent-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const FULL_SCHEMA_HELPER_PATH = path.resolve(__dirname, '../../../scripts/lib/full-schema.mjs');

const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

const ORG_ID = 'org-self-consent';
const COACH_ID = 'acct-self-consent-coach';
const ADULT_ID = 'ath-adult';
const ADULT_LOGIN = 'acct-ath-adult';
const MINOR_ID = 'ath-minor';
const MINOR_LOGIN = 'acct-ath-minor';
const GUARDIAN_ID = 'parent-adult-era';
const VIDEO_SESSION_ID = 'vs-adult';

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let client: Client;

let publication: typeof import('./publication');
let consent: typeof import('./guardianConsent');
let own: typeof import('./athleteMediaConsent');
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

async function seedApprovedPublication(): Promise<string> {
  const publicationId = `pub_${randomUUID().split('-')[0]}`;
  await client.query(
    `insert into pilot.video_publications
       (publication_id, organization_id, video_session_id, athlete_id, submitted_by_account_id,
        publication_type, title, description, status, compliance_check_status)
     values ($1, $2, $3, $4, $5, 'research_library', 'Jab mechanics', 'Six rounds.', 'approved', 'passed')`,
    [publicationId, ORG_ID, VIDEO_SESSION_ID, ADULT_ID, COACH_ID],
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

/** The publish route's claim, with its in-transaction checks in the route's order (publish/route.ts). */
function publish(publicationId: string) {
  return publication.publishToResearchLibrary({
    organizationId: ORG_ID,
    publicationId,
    videoSessionId: VIDEO_SESSION_ID,
    title: 'Jab mechanics',
    description: 'Six rounds.',
    verifyBeforeCommit: async (c) => {
      if (await consent.assertNewPublicationConsentPath(ORG_ID, ADULT_ID, c) === 'guardian_consent') {
        await consent.assertGuardianMediaConsentWithClient(c, ORG_ID, ADULT_ID);
        await playback.assertConsentCoversVideo(ORG_ID, ADULT_ID, c);
      }
    },
  });
}

function outcomeOf(promise: Promise<unknown>): Promise<string> {
  return promise.then(() => 'ok').catch((error: unknown) => {
    const e = error as { code?: unknown; athleteIsAdult?: boolean };
    if (e?.athleteIsAdult) return 'adult_refused';
    return typeof e?.code === 'string' ? e.code : `rejected: ${(error as Error)?.message}`;
  });
}

async function selfRowCount(athleteId: string): Promise<number> {
  const row = await client.query<{ n: string }>(
    'select count(*) as n from pilot.waivers where organization_id = $1 and athlete_id = $2 and parent_id is null',
    [ORG_ID, athleteId],
  );
  return Number(row.rows[0].n);
}

/** True once a backend other than this test's own (and `except`) is waiting on an advisory lock -- the consent-set lock. */
async function someoneWaitsOnALock(except: number[] = [], attempts = 200): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const waiting = await client.query(
      `select 1 from pg_stat_activity
        where datname = current_database() and pid <> pg_backend_pid()
          and not (pid = any($1::int[])) and wait_event_type = 'Lock' and wait_event = 'advisory'`,
      [except],
    );
    if ((waiting.rowCount ?? 0) > 0) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

async function seed(): Promise<void> {
  await client.query(
    `insert into pilot.organizations (organization_id, organization_name, status)
     values ($1, $1, 'active') on conflict do nothing`,
    [ORG_ID],
  );
  await client.query(
    `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
     values ($1, 'coach', $2, 'microsoft')`,
    [COACH_ID, ORG_ID],
  );
  await client.query(
    `insert into pilot.athletes (organization_id, athlete_id, full_name, dob, weight_class, gym_status, emergency_contact, active_flag, coach_id, created_at, updated_at)
     values ($1, $2, 'Adult Athlete', '2000-03-04', 'fly', 'active', 'contact', true, $4, now(), now()),
            ($1, $3, 'Minor Athlete', (current_date - interval '15 years')::date, 'fly', 'active', 'contact', true, $4, now(), now())`,
    [ORG_ID, ADULT_ID, MINOR_ID, COACH_ID],
  );
  await client.query(
    `insert into pilot.accounts (account_id, role, organization_id, athlete_id)
     values ($1, 'athlete', $3, $2), ($4, 'athlete', $3, $5)`,
    [ADULT_LOGIN, ADULT_ID, ORG_ID, MINOR_LOGIN, MINOR_ID],
  );
  // The guardian from before 18, still linked (dormant); their row no longer counts.
  await client.query(
    `insert into pilot.parents (organization_id, parent_id, full_name) values ($1, $2, 'Era Guardian')`,
    [ORG_ID, GUARDIAN_ID],
  );
  await client.query(
    `insert into pilot.guardian_links (organization_id, parent_id, athlete_id, relationship_to_athlete)
     values ($1, $2, $3, 'mother')`,
    [ORG_ID, GUARDIAN_ID, ADULT_ID],
  );
  await client.query(
    `insert into pilot.video_sessions
       (video_session_id, organization_id, uploaded_by_account_id, athlete_id, title, notes,
        blob_path, file_name, file_size_bytes, mime_type, status, created_at, updated_at)
     values ($1, $2, $3, $4, 'Session tape', '', $2 || '/tape.mp4', 'tape.mp4', 1024, 'video/mp4', 'ready', now(), now())`,
    [VIDEO_SESSION_ID, ORG_ID, COACH_ID, ADULT_ID],
  );
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

  await seed();

  process.env.AZURE_POSTGRES_CONNECTION_STRING = connectionStringFor(PG_DATABASE);
  process.env.PPBF_POSTGRES_DISABLE_SSL = 'true';
  publication = await import('./publication');
  consent = await import('./guardianConsent');
  own = await import('./athleteMediaConsent');
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
  // The guardian era ended withdrawn: as built before this lane, that blocked forever.
  await client.query(
    `insert into pilot.waivers
       (organization_id, waiver_id, athlete_id, parent_id, waiver_type, signed_by_name,
        signed_by_role, signed_at, consent_version, status, covers_video)
     values ($1, gen_random_uuid(), $2, $3, 'photo_media', 'Era Guardian', 'parent', now(), 'v1', 'withdrawn', false)`,
    [ORG_ID, ADULT_ID, GUARDIAN_ID],
  );
});

const adult = { organizationId: ORG_ID, athleteId: ADULT_ID, recordedByAccountId: ADULT_LOGIN };

describe('the adult records their own consent, and only they can', () => {
  test('CONTROL: an adult with no consent of their own is refused at publish', async () => {
    const publicationId = await seedApprovedPublication();
    expect(await outcomeOf(publish(publicationId))).toBe('adult_refused');
    expect(await publicationStatus(publicationId)).toBe('approved');
  });

  test("an adult's own video consent publishes, though the guardian-era row is withdrawn", async () => {
    await own.grantOwnMediaConsent({ ...adult, coversVideo: true, publicUseAllowed: false });
    const publicationId = await seedApprovedPublication();
    expect(await outcomeOf(publish(publicationId))).toBe('ok');
    expect(await publicationStatus(publicationId)).toBe('published');
    const row = await client.query(
      `select signed_by_role, signed_by_name, parent_id, recorded_by_account_id, status, covers_video
         from pilot.waivers where athlete_id = $1 and parent_id is null`,
      [ADULT_ID],
    );
    expect(row.rows).toEqual([{
      signed_by_role: 'athlete_self',
      signed_by_name: 'Adult Athlete',
      parent_id: null,
      recorded_by_account_id: ADULT_LOGIN,
      status: 'signed',
      covers_video: true,
    }]);
  });

  test('photo only is refused at publish', async () => {
    await own.grantOwnMediaConsent({ ...adult, coversVideo: false, publicUseAllowed: false });
    expect(await outcomeOf(publish(await seedApprovedPublication()))).toBe('adult_refused');
  });

  test('a later withdrawal wins over an earlier grant', async () => {
    await own.grantOwnMediaConsent({ ...adult, coversVideo: true, publicUseAllowed: true });
    await own.withdrawOwnMediaConsent(adult);
    expect(await outcomeOf(publish(await seedApprovedPublication()))).toBe('adult_refused');
  });

  test('a minor cannot record their own consent; nothing is written', async () => {
    const outcome = await outcomeOf(own.grantOwnMediaConsent({
      organizationId: ORG_ID, athleteId: MINOR_ID, recordedByAccountId: MINOR_LOGIN, coversVideo: true, publicUseAllowed: false,
    }));
    expect(outcome).toBe('ATHLETE_NOT_ADULT');
    expect(await selfRowCount(MINOR_ID)).toBe(0);
  });

  test.each([
    ['a coach', COACH_ID],
    ["another athlete's login", MINOR_LOGIN],
    ['an account that does not exist', 'acct-nobody'],
  ])('%s cannot record it for the adult; nothing is written', async (_label, accountId) => {
    const outcome = await outcomeOf(own.grantOwnMediaConsent({ ...adult, recordedByAccountId: accountId, coversVideo: true, publicUseAllowed: false }));
    expect(outcome).toBe('NOT_OWN_LOGIN');
    expect(await selfRowCount(ADULT_ID)).toBe(0);
  });

  test('a deleted login cannot record it', async () => {
    await client.query('update pilot.accounts set deleted_at = now() where account_id = $1', [ADULT_LOGIN]);
    let outcome = '';
    try {
      outcome = await outcomeOf(own.grantOwnMediaConsent({ ...adult, coversVideo: true, publicUseAllowed: false }));
    } finally {
      await client.query('update pilot.accounts set deleted_at = null where account_id = $1', [ADULT_LOGIN]);
    }
    expect(outcome).toBe('NOT_OWN_LOGIN');
  });

  test("a staff register row filed as 'athlete' with no guardian is not the adult's own consent", async () => {
    await client.query(
      `insert into pilot.waivers
         (organization_id, waiver_id, athlete_id, parent_id, waiver_type, signed_by_name,
          signed_by_role, signed_at, consent_version, status, covers_video, recorded_by_account_id)
       values ($1, gen_random_uuid(), $2, null, 'photo_media', 'Adult Athlete', 'athlete', now(), 'v1', 'signed', true, $3)`,
      [ORG_ID, ADULT_ID, COACH_ID],
    );
    expect(await outcomeOf(publish(await seedApprovedPublication()))).toBe('adult_refused');
  });

  test("a row carrying the self marker that the adult's login did not record can refuse but never authorise", async () => {
    const insertMarked = (status: string) => client.query(
      `insert into pilot.waivers
         (organization_id, waiver_id, athlete_id, parent_id, waiver_type, signed_by_name,
          signed_by_role, signed_at, consent_version, status, covers_video, recorded_by_account_id, created_at)
       values ($1, gen_random_uuid(), $2, null, 'photo_media', 'Adult Athlete', 'athlete_self', now(), 'v1', $3, true, $4, clock_timestamp())`,
      [ORG_ID, ADULT_ID, status, COACH_ID],
    );
    await insertMarked('signed');
    expect(await outcomeOf(publish(await seedApprovedPublication()))).toBe('adult_refused');

    await client.query('delete from pilot.video_publications');
    await own.grantOwnMediaConsent({ ...adult, coversVideo: true, publicUseAllowed: false });
    await insertMarked('withdrawn');
    expect(await outcomeOf(publish(await seedApprovedPublication()))).toBe('adult_refused');
  });
});

describe("the adult's withdrawal takes published video down, and is never outrun by a publish", () => {
  test('withdrawal retracts the published publication and suppresses its shelf row, in one transaction', async () => {
    await own.grantOwnMediaConsent({ ...adult, coversVideo: true, publicUseAllowed: false });
    const publicationId = await seedApprovedPublication();
    expect(await outcomeOf(publish(publicationId))).toBe('ok');

    const result = await publication.recordMediaConsentAndSuppress({
      organizationId: ORG_ID,
      athleteId: ADULT_ID,
      suppressedByAccountId: ADULT_LOGIN,
      reason: 'athlete_consent_withdrawn',
      write: (tx) => own.withdrawOwnMediaConsent(adult, tx),
      exclusiveConsentSet: true,
    });

    expect(result.publicationIds).toEqual([publicationId]);
    expect(await publicationStatus(publicationId)).toBe('retracted');
    const shelf = await client.query(
      'select suppressed_reason from pilot.research_library where publication_id = $1',
      [publicationId],
    );
    expect(shelf.rows[0].suppressed_reason).toBe('athlete_consent_withdrawn');
  });

  test("a minor's refused write inside the sweep rolls the whole transaction back", async () => {
    const outcome = await outcomeOf(publication.recordMediaConsentAndSuppress({
      organizationId: ORG_ID,
      athleteId: MINOR_ID,
      suppressedByAccountId: MINOR_LOGIN,
      reason: 'athlete_consent_withdrawn',
      write: (tx) => own.withdrawOwnMediaConsent({ organizationId: ORG_ID, athleteId: MINOR_ID, recordedByAccountId: MINOR_LOGIN }, tx),
      exclusiveConsentSet: true,
    }));
    expect(outcome).toBe('ATHLETE_NOT_ADULT');
    expect(await selfRowCount(MINOR_ID)).toBe(0);
  });

  /*
   * THE SWEEP TAKES THE EXCLUSIVE LOCK BEFORE ITS LINK LOCKS. A publish that
   * already holds the consent-set lock shared (its age gate ran) and is about
   * to read the guardian links must not deadlock against a withdrawal sweep:
   * if the sweep locked the links FOR UPDATE first and only then asked for the
   * exclusive lock, each would wait on the other (40P01). With the exclusive
   * lock first, the sweep simply waits for the publish to commit, then
   * retracts what it published.
   */
  test('a publish holding the shared lock and a withdrawal sweep do not deadlock; the sweep retracts what the publish committed', async () => {
    await own.grantOwnMediaConsent({ ...adult, coversVideo: true, publicUseAllowed: false });
    const publicationId = await seedApprovedPublication();

    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let reachedGate!: () => void;
    const atGate = new Promise<void>((resolve) => { reachedGate = resolve; });
    // A minor-shaped claim order, forced: the age gate (shared lock), then a
    // pause, then the guardian link read -- the read a sweep holding the links
    // FOR UPDATE would block.
    const publishing = outcomeOf(publication.publishToResearchLibrary({
      organizationId: ORG_ID,
      publicationId,
      videoSessionId: VIDEO_SESSION_ID,
      title: 'Jab mechanics',
      description: 'Six rounds.',
      verifyBeforeCommit: async (c) => {
        await consent.assertNewPublicationConsentPath(ORG_ID, ADULT_ID, c);
        reachedGate();
        await gate;
        await consent.checkGuardianMediaConsent(ORG_ID, ADULT_ID, c);
      },
    }));
    await atGate;

    const sweeping = outcomeOf(publication.recordMediaConsentAndSuppress({
      organizationId: ORG_ID,
      athleteId: ADULT_ID,
      suppressedByAccountId: ADULT_LOGIN,
      reason: 'athlete_consent_withdrawn',
      write: (tx) => own.withdrawOwnMediaConsent(adult, tx),
      exclusiveConsentSet: true,
    }));
    const sweepWaited = await someoneWaitsOnALock([], 80);
    release();

    const [published, swept] = await Promise.all([publishing, sweeping]);
    expect(sweepWaited).toBe(true);
    expect(published).toBe('ok');
    expect(swept).toBe('ok');
    expect(await publicationStatus(publicationId)).toBe('retracted');
  });

  /*
   * Nothing is asserted while a transaction is held open (consentSetPhantom's
   * lesson): values are captured, everything released in a finally, then
   * asserted.
   */
  test.each([
    ['with the dormant guardian link on file', true],
    ['with no guardian link row at all', false],
  ])('withdrawal first, %s: the publish waits on the consent-set lock, reads the withdrawal, and refuses', async (_label, keepLink) => {
    if (!keepLink) {
      await client.query('delete from pilot.guardian_links where athlete_id = $1', [ADULT_ID]);
    }
    await own.grantOwnMediaConsent({ ...adult, coversVideo: true, publicUseAllowed: false });
    const publicationId = await seedApprovedPublication();

    const writer = new Client({ connectionString: connectionStringFor(PG_DATABASE) });
    await writer.connect();
    let waited = false;
    let publishing: Promise<string> | null = null;
    try {
      await writer.query('begin');
      const pid = (await writer.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0].pid;
      await own.withdrawOwnMediaConsent(adult, writer as unknown as PoolClient);
      publishing = outcomeOf(publish(publicationId));
      waited = await someoneWaitsOnALock([pid], 80);
      await writer.query('commit');
    } finally {
      await writer.query('rollback').catch(() => {});
      await writer.end().catch(() => {});
      if (!keepLink) {
        await client.query(
          `insert into pilot.guardian_links (organization_id, parent_id, athlete_id, relationship_to_athlete)
           values ($1, $2, $3, 'mother') on conflict do nothing`,
          [ORG_ID, GUARDIAN_ID, ADULT_ID],
        );
      }
    }
    expect(waited).toBe(true);
    expect(await publishing).toBe('adult_refused');
    expect(await publicationStatus(publicationId)).toBe('approved');
  });
});
