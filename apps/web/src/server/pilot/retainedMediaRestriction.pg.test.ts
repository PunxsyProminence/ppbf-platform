/**
 * A purged guardian's media choice still restricts the child's video, on real
 * PostgreSQL, through both retention purge paths.
 *
 * Owner ruling, Jason 2026-10-05 ("Keep the 'no' (Recommended)"): a
 * guardian's withdrawal or photo-only media choice outlives the guardian's
 * account deletion; the child's media stays restricted until a remaining
 * guardian grants it.
 *
 * Audit finding CL-B2: the purge deletes the guardian's pilot.parents row,
 * which cascades their guardian_links, after nulling waivers.parent_id, so
 * the consent gate (which asks linked guardians, by parent_id) stopped
 * hearing them. With a second, consenting guardian every gate opened; with
 * none, playback read the empty set as "nobody excluded video".
 *
 * The gates exercised are the ones the media paths call:
 *   - publish and the compliance queue: assertConsentCoversVideo +
 *     assertGuardianMediaConsent, and assertGuardianMediaConsentWithClient
 *     inside their transaction;
 *   - playback: mintUnderPlaybackConsent (assertConsentCoversVideo);
 *   - the content scan: assertGuardianMediaConsent (videoScanSweep.ts).
 *
 * Spins up the same disposable, local-only embedded Postgres the other
 * migration suites use. It NEVER connects to production or staging.
 */

import { type ChildProcessByStdio, execFile, spawn } from 'node:child_process';
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
const PG_DATABASE = 'ppbf_test_retained_media_restriction';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-retained-media-restriction-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const FULL_SCHEMA_HELPER_PATH = path.resolve(__dirname, '../../../scripts/lib/full-schema.mjs');
const CLEANUP_SCRIPT = path.resolve(__dirname, '../../../scripts/pilot-cleanup-deleted-data.mjs');

const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

const ORG_ID = 'org-retained';
const COACH_ID = 'acct-retained-coach';

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let client: Client;

let consent: typeof import('./guardianConsent');
let playback: typeof import('./videoPlaybackConsent');
let withTransaction: typeof import('./db').withTransaction;
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

/* The retention purge: scripts/pilot-cleanup-deleted-data.mjs, as the scheduled
   job runs it. (dataDeletion.ts's copy, purgeExpiredDeletedData, had no caller
   and was removed.) */

async function purge(): Promise<void> {
  const output = await new Promise<string>((resolve, reject) => {
    execFile(
      process.execPath,
      [CLEANUP_SCRIPT],
      {
        env: {
          ...process.env,
          AZURE_POSTGRES_CONNECTION_STRING: connectionStringFor(PG_DATABASE),
          PPBF_EXPECTED_POSTGRES_HOSTNAME: 'localhost',
          PPBF_EXPECTED_POSTGRES_DATABASE: PG_DATABASE,
          PPBF_POSTGRES_DISABLE_SSL: 'true',
          PPBF_RETENTION_APPLY: 'true',
        },
      },
      (error, stdout, stderr) => (error ? reject(new Error(`${stdout}${stderr}`)) : resolve(`${stdout}${stderr}`)),
    );
  });
  const line = output.split('\n').find((entry) => entry.trim().startsWith('{'));
  const event = JSON.parse(line ?? '{}') as { blocked_by?: Record<string, number> };
  // A purge that was refused for this guardian proves nothing below.
  expect(event.blocked_by ?? {}).toEqual({});
}

let seq = 0;

interface Family {
  athleteId: string;
  purgedParentId: string;
  purgedAccountId: string;
  remainingParentId: string | null;
}

/*
 * One child, a guardian whose account was deleted 18 months ago (so both
 * purge paths take them) with `purgedChoice` as their current media waiver,
 * and optionally a second guardian, live, with a signed video consent
 * recorded BEFORE the purge.
 */
async function seedFamily(
  purgedChoice: 'withdrawn' | 'photo-only' | 'signed-video',
  withRemainingGuardian: boolean,
): Promise<Family> {
  seq += 1;
  const athleteId = `ath-ret-${seq}`;
  const purgedParentId = `parent-ret-gone-${seq}`;
  const purgedAccountId = `acct-ret-gone-${seq}`;
  const remainingParentId = withRemainingGuardian ? `parent-ret-stay-${seq}` : null;

  await client.query(
    `insert into pilot.athletes (organization_id, athlete_id, full_name, dob, weight_class, gym_status, emergency_contact, active_flag, coach_id, created_at, updated_at)
     values ($1, $2, 'Retained Athlete', '2013-05-06', 'fly', 'active', 'contact', true, $3, now(), now())`,
    [ORG_ID, athleteId, COACH_ID],
  );
  await client.query(
    `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
     values ($1, 'parent', $2, 'microsoft')`,
    [purgedAccountId, ORG_ID],
  );
  await client.query(
    `insert into pilot.parents (organization_id, parent_id, account_id, full_name)
     values ($1, $2, $3, 'Gone Guardian')`,
    [ORG_ID, purgedParentId, purgedAccountId],
  );
  await client.query(
    `insert into pilot.guardian_links (organization_id, parent_id, athlete_id, relationship_to_athlete)
     values ($1, $2, $3, 'father')`,
    [ORG_ID, purgedParentId, athleteId],
  );
  // A signed video consent first, then the choice that supersedes it: the
  // retained pointer must be the CURRENT waiver, not any of them.
  await writeWaiver(athleteId, purgedParentId, 'signed', true, "now() - interval '2 days'");
  if (purgedChoice === 'withdrawn') {
    await writeWaiver(athleteId, purgedParentId, 'withdrawn', false, "now() - interval '1 day'");
  } else if (purgedChoice === 'photo-only') {
    await writeWaiver(athleteId, purgedParentId, 'signed', false, "now() - interval '1 day'");
  }

  if (remainingParentId) {
    await client.query(
      `insert into pilot.parents (organization_id, parent_id, full_name)
       values ($1, $2, 'Staying Guardian')`,
      [ORG_ID, remainingParentId],
    );
    await client.query(
      `insert into pilot.guardian_links (organization_id, parent_id, athlete_id, relationship_to_athlete)
       values ($1, $2, $3, 'mother')`,
      [ORG_ID, remainingParentId, athleteId],
    );
    await writeWaiver(athleteId, remainingParentId, 'signed', true, "now() - interval '1 hour'");
  }

  // Past the purge's one-year guardian window and short of the two-year
  // athlete window: deleting a child's last guardian soft-deletes the child too
  // (pilot.cascade_parent_deletion), and that child must still be here to ask.
  await client.query(
    `update pilot.accounts set deleted_at = now() - interval '18 months', active_flag = false
      where account_id = $1`,
    [purgedAccountId],
  );
  return { athleteId, purgedParentId, purgedAccountId, remainingParentId };
}

async function writeWaiver(
  athleteId: string,
  parentId: string,
  status: string,
  coversVideo: boolean,
  createdAtSql = 'now()',
): Promise<void> {
  await client.query(
    `insert into pilot.waivers
       (organization_id, waiver_id, athlete_id, parent_id, waiver_type, signed_by_name,
        signed_by_role, signed_at, consent_version, status, covers_video, created_at)
     values ($1, gen_random_uuid(), $2, $3, 'photo_media', 'Guardian',
             'parent', ${createdAtSql}, 'v1', $4, $5, ${createdAtSql})`,
    [ORG_ID, athleteId, parentId, status, coversVideo],
  );
}

async function guardianRecordGone(family: Family): Promise<void> {
  const parents = await client.query('select 1 from pilot.parents where parent_id = $1', [family.purgedParentId]);
  const links = await client.query('select 1 from pilot.guardian_links where parent_id = $1', [family.purgedParentId]);
  expect(parents.rowCount).toBe(0);
  expect(links.rowCount).toBe(0);
}

/** The video gate, as playback, publish and the compliance queue call it. Resolves to the refusal code or 'allowed'. */
async function videoGate(athleteId: string): Promise<string> {
  try {
    await playback.mintUnderPlaybackConsent(ORG_ID, [athleteId], async () => 'https://blob.example/sas');
    await playback.assertConsentCoversVideo(ORG_ID, athleteId);
    return 'allowed';
  } catch (error) {
    return (error as { code?: string }).code ?? String(error);
  }
}

/** The consent gate, as the scan sweep and publish call it, pooled and in-transaction; both must agree. */
async function consentGate(athleteId: string): Promise<string> {
  const outcomes: string[] = [];
  for (const run of [
    () => consent.assertGuardianMediaConsent(ORG_ID, athleteId),
    () => withTransaction((tx) => consent.assertGuardianMediaConsentWithClient(tx, ORG_ID, athleteId)),
  ]) {
    try {
      await run();
      outcomes.push('allowed');
    } catch (error) {
      outcomes.push((error as { code?: string }).code ?? String(error));
    }
  }
  expect(outcomes[0]).toBe(outcomes[1]);
  return outcomes[0];
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

  // Env before import: db.ts builds its pool on first use.
  process.env.AZURE_POSTGRES_CONNECTION_STRING = connectionStringFor(PG_DATABASE);
  process.env.PPBF_POSTGRES_DISABLE_SSL = 'true';
  consent = await import('./guardianConsent');
  playback = await import('./videoPlaybackConsent');
  ({ withTransaction, closePool } = await import('./db'));
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

describe('after the script purge removes a guardian', () => {
  test('a withdrawal still refuses publish, playback and the scan, though a second guardian consented', async () => {
    const family = await seedFamily('withdrawn', true);
    // CONTROL: before the purge the withdrawal is what refuses.
    expect(await videoGate(family.athleteId)).toBe('GUARDIAN_CONSENT_WITHDRAWN');
    expect(await consentGate(family.athleteId)).toBe('GUARDIAN_CONSENT_MISSING');

    await purge();
    await guardianRecordGone(family);

    expect(await videoGate(family.athleteId)).toBe('GUARDIAN_CONSENT_WITHDRAWN');
    expect(await consentGate(family.athleteId)).toBe('GUARDIAN_CONSENT_MISSING');
  });

  test("a withdrawal still refuses playback when the purged guardian was the child's only one", async () => {
    const family = await seedFamily('withdrawn', false);
    await purge();
    await guardianRecordGone(family);

    // On the empty guardian set the video gate used to find nobody excluding video.
    expect(await videoGate(family.athleteId)).toBe('GUARDIAN_CONSENT_WITHDRAWN');
    expect(await consentGate(family.athleteId)).toBe('GUARDIAN_CONSENT_MISSING');
  });

  test('a photo-only choice still refuses video, and still leaves the photo consent standing', async () => {
    const family = await seedFamily('photo-only', true);
    expect(await videoGate(family.athleteId)).toBe('GUARDIAN_CONSENT_EXCLUDES_VIDEO');
    expect(await consentGate(family.athleteId)).toBe('allowed');

    await purge();
    await guardianRecordGone(family);

    expect(await videoGate(family.athleteId)).toBe('GUARDIAN_CONSENT_EXCLUDES_VIDEO');
    // Unchanged from before the purge: photo-only is a signed consent.
    expect(await consentGate(family.athleteId)).toBe('allowed');
  });

  test('a remaining guardian granting video after the purge lifts it', async () => {
    const family = await seedFamily('withdrawn', true);
    await purge();
    // Their grant from before the purge did not (first test); a new one does.
    await writeWaiver(family.athleteId, family.remainingParentId!, 'signed', true);

    expect(await videoGate(family.athleteId)).toBe('allowed');
    expect(await consentGate(family.athleteId)).toBe('allowed');
  });

  test('a guardian unlinked before the purge leaves no restriction behind', async () => {
    const family = await seedFamily('photo-only', true);
    // Unlinking a photo-only guardian is allowed (only a withdrawal refuses it),
    // and it already drops their choice from the gate.
    await client.query('delete from pilot.guardian_links where parent_id = $1', [family.purgedParentId]);
    expect(await videoGate(family.athleteId)).toBe('allowed');

    await purge();

    expect(await videoGate(family.athleteId)).toBe('allowed');
  });

  test('a guardian id purged a second time carries its newer choice, not the first one', async () => {
    // An invited guardian's parent_id is derived from their login, so a
    // re-invite after a purge gets the same id back.
    const family = await seedFamily('signed-video', true);
    await purge();
    expect(await videoGate(family.athleteId)).toBe('allowed');

    await client.query(
      `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
       values ($1, 'parent', $2, 'microsoft')`,
      [family.purgedAccountId, ORG_ID],
    );
    await client.query(
      `insert into pilot.parents (organization_id, parent_id, account_id, full_name)
       values ($1, $2, $3, 'Returning Guardian')`,
      [ORG_ID, family.purgedParentId, family.purgedAccountId],
    );
    await client.query(
      `insert into pilot.guardian_links (organization_id, parent_id, athlete_id, relationship_to_athlete)
       values ($1, $2, $3, 'father')`,
      [ORG_ID, family.purgedParentId, family.athleteId],
    );
    await writeWaiver(family.athleteId, family.purgedParentId, 'withdrawn', false);
    await client.query(
      `update pilot.accounts set deleted_at = now() - interval '18 months', active_flag = false
        where account_id = $1`,
      [family.purgedAccountId],
    );
    await purge();
    await guardianRecordGone(family);

    expect(await videoGate(family.athleteId)).toBe('GUARDIAN_CONSENT_WITHDRAWN');
  });

  test('CONTROL: a purged guardian who had consented to video restricts nothing', async () => {
    const family = await seedFamily('signed-video', true);
    await purge();
    await guardianRecordGone(family);

    expect(await videoGate(family.athleteId)).toBe('allowed');
    expect(await consentGate(family.athleteId)).toBe('allowed');
  });
});

test("the retained restriction goes with the child: deleting the athlete is not refused by it", async () => {
  const family = await seedFamily('withdrawn', false);
  await purge();
  const before = await client.query(
    'select 1 from pilot.retained_media_consent_restrictions where athlete_id = $1',
    [family.athleteId],
  );
  expect(before.rowCount).toBe(1);
  // Keyed by a hash, never the parent_id itself (an invited guardian's is their email).
  const key = await client.query<{ former_parent_key: string }>(
    'select former_parent_key from pilot.retained_media_consent_restrictions where athlete_id = $1',
    [family.athleteId],
  );
  expect(key.rows[0].former_parent_key).not.toContain(family.purgedParentId);
  expect(key.rows[0].former_parent_key).toMatch(/^[0-9a-f]{64}$/);

  await client.query('delete from pilot.athletes where organization_id = $1 and athlete_id = $2', [ORG_ID, family.athleteId]);

  const after = await client.query(
    'select 1 from pilot.retained_media_consent_restrictions where athlete_id = $1',
    [family.athleteId],
  );
  expect(after.rowCount).toBe(0);
});
