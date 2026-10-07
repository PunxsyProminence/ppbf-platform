/**
 * A purged person's SHADOW rows go or lose the person, on real PostgreSQL,
 * through both retention purge paths.
 *
 * Owner ruling, Jason 2026-10-06: "delete any thing that personally Identifys
 * the person but we keep data that [makes] the Ai and ML better"; Q1 "Delete
 * theirs, keep AI replies"; 2026-10-07 "Scrub the child's name, keep".
 * shadow_user_profiles, shadow_jobs, shadow_rate_limit_buckets and
 * shadow_feature_unlock_snapshots are deleted. shadow_chat_audit keeps its
 * rows with one anonymous token per person in place of every key naming them,
 * the person's own typed words emptied, SHADOW's replies and a coach's turns
 * about them kept with the person's known names scrubbed; rows about a
 * person with no usable name on record are deleted.
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
const PG_DATABASE = 'ppbf_test_shadow_deidentify_purge';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-shadow-deidentify-purge-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const FULL_SCHEMA_HELPER_PATH = path.resolve(__dirname, '../../../scripts/lib/full-schema.mjs');
const CLEANUP_SCRIPT = path.resolve(__dirname, '../../../scripts/pilot-cleanup-deleted-data.mjs');

const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

const ORG_ID = 'org-deidentify-purge';
const COACH_ID = 'acct-deidentify-purge-coach';

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let client: Client;

let dataDeletion: typeof import('./dataDeletion');
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

type PurgePath = 'script' | 'dataDeletion';

interface ShadowCounts {
  profiles: number;
  jobs: number;
  buckets: number;
  snapshots: number;
  mentions: number;
  deidentified: number;
  deleted: number;
  scrubbed: number;
}

async function purgeAuditRows(): Promise<Array<{ details: Record<string, number> }>> {
  const rows = await client.query<{ details: Record<string, number> }>(
    `select details from pilot.audit_events
      where event_type = 'data_purged' and entity_type = 'retention_cleanup'
      order by created_at`,
  );
  return rows.rows;
}

/** Runs one purge path and returns the SHADOW counts it reports. */
async function purge(via: PurgePath, apply = true): Promise<ShadowCounts> {
  let event: Record<string, number>;
  if (via === 'dataDeletion') {
    // Exactly one new audit row, read as that row: never an earlier run's.
    const before = (await purgeAuditRows()).length;
    await dataDeletion.purgeExpiredDeletedData();
    const after = await purgeAuditRows();
    expect(after).toHaveLength(before + 1);
    event = after[after.length - 1].details;
  } else {
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
            ...(apply ? { PPBF_RETENTION_APPLY: 'true' } : {}),
          },
        },
        (error, stdout, stderr) => (error ? reject(new Error(`${stdout}${stderr}`)) : resolve(`${stdout}${stderr}`)),
      );
    });
    const line = output.split('\n').find((entry) => entry.trim().startsWith('{'));
    event = JSON.parse(line ?? '{}') as Record<string, number>;
    // A purge that was refused proves nothing below.
    expect((event as unknown as { blocked_by?: Record<string, number> }).blocked_by ?? {}).toEqual({});
  }
  const prefix = apply ? '' : 'would_delete_';
  const suffix = apply ? '_deleted' : '';
  return {
    profiles: event[`${prefix}shadow_profiles${suffix}`] ?? -1,
    jobs: event[`${prefix}shadow_jobs${suffix}`] ?? -1,
    buckets: event[`${prefix}shadow_rate_limit_buckets${suffix}`] ?? -1,
    snapshots: event[`${prefix}shadow_unlock_snapshots${suffix}`] ?? -1,
    mentions: event[apply ? 'shadow_profile_mentions_cleared' : 'would_clear_shadow_profile_mentions'] ?? -1,
    deidentified: event[apply ? 'shadow_chat_audit_deidentified' : 'would_deidentify_shadow_chat_audit'] ?? -1,
    deleted: event[`${prefix}shadow_chat_audit${suffix}`] ?? -1,
    scrubbed: event[apply ? 'shadow_chat_audit_names_scrubbed' : 'would_scrub_shadow_chat_audit_names'] ?? -1,
  };
}

let seq = 0;

interface Seeded {
  purged: string;
  sibling: string;
  siblingLogin: string;
  nameless: string;
  live: string;
  athleteLogin: string;
  coachNowLogin: string;
  guardian: string;
  liveAthleteLogin: string;
}

async function addOperationalRows(accountId: string): Promise<void> {
  await client.query(
    `insert into pilot.shadow_user_profiles (account_id, organization_id, role, shadow_notes)
     values ($1, $2, 'athlete', 'remembers everything about this person')`,
    [accountId, ORG_ID],
  );
  await client.query(
    `insert into pilot.shadow_jobs (job_type, organization_id, account_id, role) values ('scout_report', $1, $2, 'athlete')`,
    [ORG_ID, accountId],
  );
  await client.query(
    `insert into pilot.shadow_rate_limit_buckets
       (organization_id, account_id, endpoint_key, window_started_at, window_seconds, request_count)
     values ($1, $2, 'chat', now(), 60, 1)`,
    [ORG_ID, accountId],
  );
  await client.query(
    `insert into pilot.shadow_feature_unlock_snapshots
       (organization_id, account_id, feature_key, metric_key, unlocked, activation_mode, satisfied)
     values ($1, $2, 'film_study', 'sessions', false, 'automatic', false)`,
    [ORG_ID, accountId],
  );
}

async function operationalRowsOf(accountId: string): Promise<number[]> {
  const counts = await client.query<{ profiles: number; jobs: number; buckets: number; snapshots: number }>(
    `select (select count(*)::int from pilot.shadow_user_profiles where account_id = $1) as profiles,
            (select count(*)::int from pilot.shadow_jobs where account_id = $1) as jobs,
            (select count(*)::int from pilot.shadow_rate_limit_buckets where account_id = $1) as buckets,
            (select count(*)::int from pilot.shadow_feature_unlock_snapshots where account_id = $1) as snapshots`,
    [accountId],
  );
  const row = counts.rows[0];
  return [row.profiles, row.jobs, row.buckets, row.snapshots];
}

async function addTurn(userId: string, role: string, athleteId: string | null, userMessage: string, response: string): Promise<void> {
  await client.query(
    `insert into pilot.shadow_chat_audit (organization_id, user_id, user_role, athlete_id, user_message, shadow_response)
     values ($1, $2, $3, $4, $5, $6)`,
    [ORG_ID, userId, role, athleteId, userMessage, response],
  );
}

interface Turn {
  user_id: string;
  athlete_id: string | null;
  user_message: string;
  shadow_response: string;
}

async function turnsWhere(sql: string, params: unknown[]): Promise<Turn[]> {
  const rows = await client.query<Turn>(
    `select user_id, athlete_id, user_message, shadow_response from pilot.shadow_chat_audit where ${sql} order by chat_audit_id`,
    params,
  );
  return rows.rows;
}

/*
 * An athlete named Jordan Pike, deleted three years ago (past the two-year
 * window), with a ring name, a linked guardian Casey Pike (deleted eighteen
 * months ago, past the one-year window), and a login that typed to SHADOW; a
 * coach who typed about Jordan, naming Jordan and Casey; a second purged
 * athlete whose only name on record is one letter, so nothing can be
 * scrubbed; Jordan's sibling Riley, purged in the same run, who typed to
 * SHADOW about Jordan; a purged athlete whose login has since become a
 * coach's; and a live athlete, not due, as a control, whom Casey is also
 * linked to (the guardian is purged a year before a child, so the guardian's
 * name must leave the turns about a child who stays).
 */
async function seed(): Promise<Seeded> {
  seq += 1;
  // A clean chat log: the previous path's de-identified rows carry no key this one could filter on.
  await client.query('delete from pilot.shadow_chat_audit where organization_id = $1', [ORG_ID]);
  const purged = `ath-deid-gone-${seq}`;
  const sibling = `ath-deid-sibling-${seq}`;
  const siblingLogin = `acct-deid-sibling-${seq}`;
  const nameless = `ath-deid-nameless-${seq}`;
  const purgedStaffNow = `ath-deid-staff-now-${seq}`;
  const live = `ath-deid-live-${seq}`;
  const athleteLogin = `acct-deid-ath-${seq}`;
  const coachNowLogin = `acct-deid-coach-now-${seq}`;
  const guardian = `acct-deid-guardian-${seq}`;
  const liveAthleteLogin = `acct-deid-live-${seq}`;
  const parentId = `par-deid-${seq}`;

  for (const [athleteId, fullName] of [[purged, 'Jordan Pike'], [sibling, 'Riley Pike'], [nameless, 'X'], [purgedStaffNow, 'Staff Now'], [live, 'Live Kid']]) {
    await client.query(
      `insert into pilot.athletes (organization_id, athlete_id, full_name, dob, weight_class, gym_status, emergency_contact, active_flag, coach_id, created_at, updated_at)
       values ($1, $2, $3, '2013-05-06', 'fly', 'active', 'contact', true, $4, now(), now())`,
      [ORG_ID, athleteId, fullName, COACH_ID],
    );
  }
  for (const [accountId, role, athleteId, deleted, email] of [
    [athleteLogin, 'athlete', purged, "now() - interval '3 years'", `jordan.pike.${seq}@example.test`],
    [siblingLogin, 'athlete', sibling, "now() - interval '3 years'", null],
    [coachNowLogin, 'coach', purgedStaffNow, 'null', null],
    [guardian, 'parent', null, "now() - interval '18 months'", `casey.${seq}@example.test`],
    [liveAthleteLogin, 'athlete', live, 'null', null],
  ] as const) {
    await client.query(
      `insert into pilot.accounts (account_id, role, organization_id, athlete_id, auth_provider, active_flag, deleted_at, login_email)
       values ($1, $2, $3, $4, 'ppbf_local', ${deleted} is null, ${deleted}, $5)`,
      [accountId, role, ORG_ID, athleteId, email],
    );
  }
  await client.query(
    `insert into pilot.account_profiles (organization_id, account_id, display_nickname) values ($1, $2, 'JoJo')`,
    [ORG_ID, athleteLogin],
  );
  await client.query(
    `insert into pilot.parents (organization_id, parent_id, account_id, full_name, phone, email, created_at, updated_at)
     values ($1, $2, $3, 'Casey Pike', '555-0100', 'casey@example.test', now(), now())`,
    [ORG_ID, parentId, guardian],
  );
  await client.query(
    `insert into pilot.guardian_links (organization_id, parent_id, athlete_id, relationship_to_athlete)
     values ($1, $2, $3, 'parent'), ($1, $2, $4, 'parent')`,
    [ORG_ID, parentId, purged, live],
  );
  for (const accountId of [athleteLogin, coachNowLogin, guardian, liveAthleteLogin]) {
    await addOperationalRows(accountId);
  }
  // The coach's own SHADOW memory lists the children they asked about.
  await client.query(
    `insert into pilot.shadow_user_profiles (account_id, organization_id, role, athlete_ids_discussed)
     values ($1, $2, 'coach', $3::text[])
     on conflict (account_id, organization_id) do update set athlete_ids_discussed = excluded.athlete_ids_discussed`,
    [COACH_ID, ORG_ID, [purged, live]],
  );
  await addTurn(athleteLogin, 'athlete', purged, "I'm Jordan and my left hook is my best punch", 'Hi Jordan, a good left hook starts at the feet');
  await addTurn(COACH_ID, 'coach', purged, 'How is Jordan Pike doing with the jab? Casey Pike says JoJo is tired', "Jordan's jab is improving; ask Casey about sleep");
  await addTurn(siblingLogin, 'athlete', purged, 'Jordan is my brother', "Riley, Jordan's drills differ from yours");
  await addTurn(COACH_ID, 'coach', nameless, 'How is X doing', 'X is doing fine');
  await addTurn(COACH_ID, 'coach', live, 'Casey Pike asked about Live Kid', 'Tell Casey the plan');
  // Keyed to nobody and to the live child: the purged names must leave these too (gym-wide).
  await addTurn(COACH_ID, 'coach', null, 'Pair Jordan Pike with Live Kid on Saturday', 'Jordan and Live Kid are a fair match');
  await addTurn(COACH_ID, 'coach', live, 'Riley keeps copying Live Kid', 'Riley will settle');
  await addTurn(guardian, 'parent', purged, 'This is Casey, is my son Jordan safe to spar?', 'Casey, sparring readiness is the coach’s call');
  await addTurn(coachNowLogin, 'coach', null, 'Plan for Tuesday', 'Tuesday looks light');
  await addTurn(liveAthleteLogin, 'athlete', live, 'My jab feels slow', 'Slow is fine while learning');
  await addTurn(COACH_ID, 'coach', live, 'How is Live Kid doing', 'Live Kid is doing fine');
  await client.query(
    `update pilot.athletes set deleted_at = now() - interval '3 years'
      where organization_id = $1 and athlete_id = any($2::text[])`,
    [ORG_ID, [purged, sibling, nameless, purgedStaffNow]],
  );
  return { purged, sibling, siblingLogin, nameless, live, athleteLogin, coachNowLogin, guardian, liveAthleteLogin };
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
  dataDeletion = await import('./dataDeletion');
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

// deidentified counts a turn once per purged person whose pass touched it:
// Jordan's pass, 4 (his own turn, the coach's, the guardian's, Riley's);
// Riley's, 1 (Riley's own); the guardian's, 1 (their own turn: the coach's
// turn about the live child naming them was already scrubbed gym-wide by
// Jordan's pass, whose names include the linked guardian's). scrubbed,
// gym-wide: Jordan's pass, 2 (the unkeyed turn, and the guardian-named turn
// about the live child); Riley's, 1 (the turn keyed to the live child); the
// guardian's, 0. mentions: the coach's profile listed Jordan.
const EXPECTED: ShadowCounts = { profiles: 2, jobs: 2, buckets: 2, snapshots: 2, mentions: 1, deidentified: 6, deleted: 1, scrubbed: 3 };

describe.each<PurgePath>(['script', 'dataDeletion'])('the %s purge', (via) => {
  test("deletes a purged athlete's and guardian's SHADOW rows, and leaves their chat turns with no one in them", async () => {
    const people = await seed();
    // CONTROL: everything is there before the purge.
    for (const accountId of [people.athleteLogin, people.guardian, people.coachNowLogin, people.liveAthleteLogin]) {
      expect(await operationalRowsOf(accountId)).toEqual([1, 1, 1, 1]);
    }
    expect(await turnsWhere('user_id = $1', [people.athleteLogin])).toHaveLength(1);

    if (via === 'script') {
      // The dry run counts them and changes nothing.
      expect(await purge(via, false)).toEqual(EXPECTED);
      expect(await operationalRowsOf(people.athleteLogin)).toEqual([1, 1, 1, 1]);
      expect(await turnsWhere('user_id = $1', [people.athleteLogin])).toHaveLength(1);
      expect(await turnsWhere('athlete_id = $1', [people.nameless])).toHaveLength(1);
    }

    expect(await purge(via)).toEqual(EXPECTED);

    // The person's rows are gone; the adult who now holds the athlete's old login, and a live athlete, keep theirs.
    expect(await operationalRowsOf(people.athleteLogin)).toEqual([0, 0, 0, 0]);
    expect(await operationalRowsOf(people.guardian)).toEqual([0, 0, 0, 0]);
    expect(await operationalRowsOf(people.coachNowLogin)).toEqual([1, 1, 1, 1]);
    expect(await operationalRowsOf(people.liveAthleteLogin)).toEqual([1, 1, 1, 1]);

    // No turn names the child's login or record any more; the turns are still there.
    expect(await turnsWhere('user_id = $1 or athlete_id = $2', [people.athleteLogin, people.purged])).toHaveLength(0);
    const childTurns = await turnsWhere("athlete_id like 'anon_%' and user_role <> 'parent'", []);
    expect(childTurns).toHaveLength(3);
    const [own, coachAbout, siblingTurn] = childTurns;
    // One token for the person: the child's own login and the coach's turn about them agree.
    expect(own.user_id).toMatch(/^anon_[0-9a-f-]{36}$/);
    expect(own.athlete_id).toBe(own.user_id);
    expect(coachAbout.athlete_id).toBe(own.user_id);
    // The child's own words go; SHADOW's reply stays, without the name (Q1).
    expect(own.user_message).toBe('');
    expect(own.shadow_response).toBe('Hi [name], a good left hook starts at the feet');
    // The coach's turn keeps the coach and the text, with every known name scrubbed:
    // full name, ring name, and the linked guardian's name.
    expect(coachAbout.user_id).toBe(COACH_ID);
    expect(coachAbout.user_message).toBe('How is [name] doing with the jab? [name] says [name] is tired');
    expect(coachAbout.shadow_response).toBe("[name]'s jab is improving; ask [name] about sleep");
    // Riley's turn about Jordan: two purged people on one row, both names gone, each key its own token.
    expect(siblingTurn.athlete_id).toBe(own.user_id);
    expect(siblingTurn.user_id).toMatch(/^anon_/);
    expect(siblingTurn.user_id).not.toBe(own.user_id);
    expect(siblingTurn.user_message).toBe('');
    expect(siblingTurn.shadow_response).toBe("[name], [name]'s drills differ from yours");
    // The coach's memory no longer lists the purged child; the live child stays.
    const coachProfile = await client.query<{ athlete_ids_discussed: string[] }>(
      'select athlete_ids_discussed from pilot.shadow_user_profiles where account_id = $1 and organization_id = $2',
      [COACH_ID, ORG_ID],
    );
    expect(coachProfile.rows[0].athlete_ids_discussed).toEqual([people.live]);

    // The guardian's own turn: tokened, words emptied, reply scrubbed of their name.
    expect(await turnsWhere('user_id = $1', [people.guardian])).toHaveLength(0);
    const [guardianTurn] = await turnsWhere("user_role = 'parent'", []);
    expect(guardianTurn.user_id).toMatch(/^anon_/);
    expect(guardianTurn.user_id).not.toBe(own.user_id);
    expect(guardianTurn.user_message).toBe('');
    expect(guardianTurn.shadow_response).toBe('[name], sparring readiness is the coach’s call');

    // A person with no usable name on record cannot be scrubbed: the turn about them is deleted.
    expect(await turnsWhere('athlete_id = $1', [people.nameless])).toHaveLength(0);

    // Untouched: the coach-now login's turn, the live athlete's, and the coach's turn about the live athlete.
    expect(await turnsWhere('user_id = $1', [people.coachNowLogin])).toEqual([
      expect.objectContaining({ user_message: 'Plan for Tuesday', shadow_response: 'Tuesday looks light' }),
    ]);
    expect(await turnsWhere('athlete_id = $1', [people.live])).toEqual([
      // The purged guardian's name leaves the turn about their live child; the child's key stays.
      expect.objectContaining({ user_id: COACH_ID, user_message: '[name] asked about Live Kid', shadow_response: 'Tell [name] the plan' }),
      // Gym-wide: the purged sibling's name leaves a turn keyed to the live child; the live child's name stays.
      expect.objectContaining({ user_id: COACH_ID, user_message: '[name] keeps copying Live Kid', shadow_response: '[name] will settle' }),
      expect.objectContaining({ user_id: people.liveAthleteLogin, user_message: 'My jab feels slow' }),
      expect.objectContaining({ user_id: COACH_ID, user_message: 'How is Live Kid doing', shadow_response: 'Live Kid is doing fine' }),
    ]);
    // Gym-wide: a turn keyed to nobody loses the purged child's name and keeps the live child's.
    expect(await turnsWhere('athlete_id is null and user_id = $1', [COACH_ID])).toEqual([
      expect.objectContaining({ user_message: 'Pair [name] with Live Kid on Saturday', shadow_response: '[name] and Live Kid are a fair match' }),
    ]);

    // No row anywhere still holds the child's or the guardian's name, login or words.
    for (const needle of ['Jordan', 'Pike', 'JoJo', 'Casey', 'Riley', 'my best punch', 'my brother', people.athleteLogin, people.siblingLogin, `jordan.pike.${seq}@example.test`]) {
      const rows = await client.query(
        `select 1 from pilot.shadow_chat_audit
          where user_message ilike $1 or shadow_response ilike $1 or user_id = $2 or athlete_id = $2`,
        [`%${needle}%`, needle],
      );
      expect({ needle, rows: rows.rowCount }).toEqual({ needle, rows: 0 });
    }
  });
});
