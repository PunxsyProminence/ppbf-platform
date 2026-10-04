// Real PostgreSQL-backed test for athleteMentalSkills.ts and its migration.
//
// Proves, against base schema + the athlete-mental-skills migration: writes
// are self-only; reads admit exactly self, linked guardian, assigned coach and
// own-org admin and refuse everyone else; organization scoping; the table's
// shape constraints; the readiness gate; and an idempotent re-run. Uses the
// same disposable local embedded Postgres as the other migration suites. It
// NEVER connects to production or staging.

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
const DATA_DIR = path.join(os.tmpdir(), `ppbf-mentalskills-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const MIGRATION_FILE = 'pilot_slice_postgres_athlete_mental_skills_migration.sql';
const REMOVE_MIGRATION_FILE = 'pilot_slice_postgres_athlete_mental_skills_remove_migration.sql';
const TEST_DB_NAME = 'ppbf_test_mental_skills';

const ORG = 'org-mental-a';
const OTHER_ORG = 'org-mental-b';
const ATHLETE = 'ath-mental-1';
const SECOND_ATHLETE = 'ath-mental-2';
// Deliberately the SAME id as ATHLETE, in the other gym.
const OTHER_ATHLETE = 'ath-mental-1';
const COACH = 'acct-mental-coach';
const UNASSIGNED_COACH = 'acct-mental-coach-unassigned';
const OTHER_COACH = 'acct-mental-coach-other';
const ADMIN = 'acct-mental-admin';
const OTHER_ADMIN = 'acct-mental-admin-other';
const ATHLETE_ACCOUNT = 'acct-mental-athlete';
const SECOND_ATHLETE_ACCOUNT = 'acct-mental-athlete-2';
const PARENT = 'acct-mental-parent';
const UNLINKED_PARENT = 'acct-mental-parent-unlinked';

const FULL_SCHEMA_HELPER_PATH = path.resolve(__dirname, '../../../scripts/lib/full-schema.mjs');
const MIGRATION_RUNNER_PATH = path.resolve(
  __dirname,
  '../../../scripts/pilot-apply-athlete-mental-skills-migration.mjs',
);
const REMOVE_RUNNER_PATH = path.resolve(
  __dirname,
  '../../../scripts/pilot-apply-athlete-mental-skills-remove-migration.mjs',
);

// Jest's CJS transform rewrites a bare `import()` into `require()`, which
// cannot load an ESM .mjs runner. Building the import through `new Function`
// keeps a real dynamic import in the emitted code, which Node honors under
// --experimental-vm-modules. Same pattern as announcementsPersistence.pg.test.ts.
const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let mental: typeof import('./athleteMentalSkills');
let applyMigrationTransaction: (client: Client, sql: string) => Promise<void>;
let applyFullSchema: (client: Client, opts?: { infraDir?: string }) => Promise<unknown>;
let migrationSql: string;
let applyRemoveMigration: (client: Client, sql: string) => Promise<void>;
let removeMigrationSql: string;

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

async function freshDatabase(name: string, orgs: string[]): Promise<Client> {
  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  await admin.query(`drop database if exists ${name}`);
  await admin.query(`create database ${name}`);
  await admin.end();

  const client = new Client({ connectionString: connectionStringFor(name) });
  await client.connect();
  // The whole production schema (scripts/lib/full-schema.mjs, #706): the
  // access gate reads pilot.athletes.deleted_at, which the base file lacks.
  // This slice's own table is then dropped so each case applies it itself.
  await applyFullSchema(client, { infraDir: INFRA_DIR });
  await client.query('drop table if exists pilot.athlete_mental_skill_entries');
  for (const org of orgs) {
    await client.query(
      `insert into pilot.organizations (organization_id, organization_name, status)
       values ($1, $1, 'active') on conflict do nothing`,
      [org],
    );
  }
  return client;
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

  const fullSchema = await nativeDynamicImport(pathToFileURL(FULL_SCHEMA_HELPER_PATH).href);
  applyFullSchema = fullSchema.applyFullSchema as typeof applyFullSchema;
  migrationSql = await fs.readFile(path.join(INFRA_DIR, MIGRATION_FILE), 'utf8');
  const runnerModule = await nativeDynamicImport(pathToFileURL(MIGRATION_RUNNER_PATH).href);
  applyMigrationTransaction = runnerModule.applyMigrationTransaction as (
    client: Client,
    sql: string,
  ) => Promise<void>;
  removeMigrationSql = await fs.readFile(path.join(INFRA_DIR, REMOVE_MIGRATION_FILE), 'utf8');
  const removeRunnerModule = await nativeDynamicImport(pathToFileURL(REMOVE_RUNNER_PATH).href);
  applyRemoveMigration = removeRunnerModule.applyMigrationTransaction as typeof applyRemoveMigration;
});

afterAll(async () => {
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

type Actor = import('./access').ActorIdentity;
const actor = (accountId: string, role: Actor['role'], organizationId = ORG, athleteId: string | null = null): Actor =>
  ({ accountId, role, organizationId, athleteId });

const athlete = actor(ATHLETE_ACCOUNT, 'athlete', ORG, ATHLETE);
const secondAthlete = actor(SECOND_ATHLETE_ACCOUNT, 'athlete', ORG, SECOND_ATHLETE);
const coach = actor(COACH, 'coach');
const unassignedCoach = actor(UNASSIGNED_COACH, 'coach');
const otherOrgCoach = actor(OTHER_COACH, 'coach', OTHER_ORG);
const admin = actor(ADMIN, 'organization_admin');
const otherOrgAdmin = actor(OTHER_ADMIN, 'organization_admin', OTHER_ORG);
const parent = actor(PARENT, 'parent');
const unlinkedParent = actor(UNLINKED_PARENT, 'parent');
const platformOwner = actor('acct-mental-platform', 'platform_owner');
const board = actor('acct-mental-board', 'board');

async function seedPeople(client: Client): Promise<void> {
  await client.query(
    `insert into pilot.accounts (account_id, role, organization_id, auth_provider, athlete_id)
     values ($1, 'coach', $10, 'microsoft', null),
            ($2, 'coach', $10, 'microsoft', null),
            ($3, 'coach', $11, 'microsoft', null),
            ($4, 'organization_admin', $10, 'microsoft', null),
            ($5, 'organization_admin', $11, 'microsoft', null),
            ($6, 'athlete', $10, 'microsoft', $12),
            ($7, 'athlete', $10, 'microsoft', $13),
            ($8, 'parent', $10, 'microsoft', null),
            ($9, 'parent', $10, 'microsoft', null)
     on conflict do nothing`,
    [COACH, UNASSIGNED_COACH, OTHER_COACH, ADMIN, OTHER_ADMIN, ATHLETE_ACCOUNT, SECOND_ATHLETE_ACCOUNT,
      PARENT, UNLINKED_PARENT, ORG, OTHER_ORG, ATHLETE, SECOND_ATHLETE],
  );
  for (const [org, athleteId, coachId, deleted] of [
    [ORG, ATHLETE, COACH, false],
    [ORG, SECOND_ATHLETE, COACH, false],
    [OTHER_ORG, OTHER_ATHLETE, OTHER_COACH, false],
    [ORG, 'ath-mental-deleted', COACH, true],
  ] as const) {
    await client.query(
      `insert into pilot.athletes
         (organization_id, athlete_id, full_name, dob, weight_class, gym_status,
          emergency_contact, active_flag, coach_id, created_at, updated_at, deleted_at)
       values ($1, $2, 'Mental Skills Athlete', '2012-01-01', '100', 'active', 'contact', true, $3, now(), now(),
               case when $4 then now() else null end)
       on conflict do nothing`,
      [org, athleteId, coachId, deleted],
    );
  }
  // One guardian LINKED to ATHLETE and one of the same gym linked to nobody:
  // without the second, the guardian assertions would also pass for an
  // implementation that let any parent read any athlete.
  await client.query(
    `insert into pilot.parents (organization_id, parent_id, account_id, full_name)
     values ($1, 'par-mental-linked', $2, 'Linked Guardian'), ($1, 'par-mental-unlinked', $3, 'Unlinked Guardian')
     on conflict do nothing`,
    [ORG, PARENT, UNLINKED_PARENT],
  );
  await client.query(
    `insert into pilot.guardian_links (organization_id, parent_id, athlete_id, relationship_to_athlete)
     values ($1, 'par-mental-linked', $2, 'parent') on conflict do nothing`,
    [ORG, ATHLETE],
  );
}

describe('athlete_mental_skill_entries migration and athleteMentalSkills.ts against the real schema', () => {
  let main: Client;

  beforeAll(async () => {
    main = await freshDatabase(TEST_DB_NAME, [ORG, OTHER_ORG]);
    await seedPeople(main);
    await applyMigrationTransaction(main, migrationSql);
    await applyRemoveMigration(main, removeMigrationSql);

    process.env.AZURE_POSTGRES_CONNECTION_STRING = connectionStringFor(TEST_DB_NAME);
    // db.ts only honors this when NODE_ENV is exactly 'test' (Jest sets it).
    process.env.PPBF_POSTGRES_DISABLE_SSL = 'true';
    mental = await import('./athleteMentalSkills');
  });

  afterAll(async () => {
    await main.end();
    const { closePool } = await import('./db');
    await closePool();
  });

  test('re-running the migration is a no-op that keeps existing rows', async () => {
    await mental.logImagerySession(secondAthlete, { minutes: 5 });
    await applyMigrationTransaction(main, migrationSql);
    await applyRemoveMigration(main, removeMigrationSql);
    const view = await mental.readMentalSkills(secondAthlete, SECOND_ATHLETE);
    expect(view.imagery_sessions).toHaveLength(1);
  });

  test('an athlete sets a cue and logs a session for themselves; the newest cue is current', async () => {
    await mental.setSelfTalkCue(athlete, { cueText: 'hands home', cueKind: 'instructional' });
    const cue = await mental.setSelfTalkCue(athlete, { cueText: '  keep working  ', cueKind: 'motivational' });
    expect(cue.cue_text).toBe('keep working');

    const session = await mental.logImagerySession(athlete, { minutes: 8, contentKey: 'imagery-rehearsal' });
    expect(session).toEqual({
      entry_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      minutes: 8,
      content_key: 'imagery-rehearsal',
      logged_on: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
    });

    const view = await mental.readMentalSkills(athlete, ATHLETE);
    expect(view.current_cue).toMatchObject({ cue_text: 'keep working', cue_kind: 'motivational' });
    expect(Object.keys(view.current_cue ?? {}).sort()).toEqual(['cue_kind', 'cue_text', 'entry_id', 'logged_on']);
    expect(view.imagery_sessions.map((s) => s.entry_id)).toEqual([session.entry_id]);
  });

  test('the athlete, their linked guardian, their assigned coach and their own-org admin can read', async () => {
    for (const reader of [athlete, parent, coach, admin]) {
      const view = await mental.readMentalSkills(reader, ATHLETE);
      expect(view.current_cue?.cue_text).toBe('keep working');
    }
  });

  test('everyone else is refused', async () => {
    for (const reader of [secondAthlete, unlinkedParent, unassignedCoach, platformOwner, board]) {
      await expect(mental.readMentalSkills(reader, ATHLETE)).rejects.toThrow(/Forbidden/);
    }
    // The other gym's staff, on an athlete id that exists only in this gym.
    for (const reader of [otherOrgCoach, otherOrgAdmin]) {
      await expect(mental.readMentalSkills(reader, SECOND_ATHLETE)).rejects.toThrow(/Forbidden/);
    }
  });

  test('the same athlete id in another gym reads none of this gym\'s rows', async () => {
    expect(OTHER_ATHLETE).toBe(ATHLETE);
    const otherView = await mental.readMentalSkills(otherOrgAdmin, OTHER_ATHLETE);
    expect(otherView).toEqual({ current_cue: null, imagery_sessions: [] });
  });

  test('the current cue is the newest by created_at, not by id or day', async () => {
    await main.query(
      `insert into pilot.athlete_mental_skill_entries
         (organization_id, entry_id, athlete_id, kind, cue_text, cue_kind, logged_on, created_at)
       values ($1, 'ffffffff-ffff-4fff-bfff-ffffffffffff', $2, 'self_talk_cue', 'old cue', 'instructional',
               '2099-01-01', now() - interval '30 days')`,
      [ORG, SECOND_ATHLETE],
    );
    await mental.setSelfTalkCue(secondAthlete, { cueText: 'new cue', cueKind: 'motivational' });
    expect((await mental.readMentalSkills(secondAthlete, SECOND_ATHLETE)).current_cue?.cue_text).toBe('new cue');
  });

  test('an entry is dated by the gym\'s day, not the UTC day', async () => {
    // 2026-10-05T02:30Z is still the evening of 2026-10-04 in Punxsutawney.
    const entry = await mental.logImagerySession(secondAthlete, { minutes: 3, now: '2026-10-05T02:30:00Z' });
    expect(entry.logged_on).toBe('2026-10-04');
  });

  test('a write waits for another in-flight write on the same athlete and day, so the limit holds', async () => {
    // Deterministic race: 19 committed rows, then a second connection takes the
    // same lock the module takes and inserts the 20th WITHOUT committing. With
    // the lock, the module waits, then counts 20 and refuses. Without it, the
    // module counts 19, inserts, and the day ends with 21.
    const day = '2026-07-01';
    const now = '2026-07-01T15:00:00Z';
    for (let i = 0; i < mental.DAILY_ENTRY_LIMIT - 1; i += 1) {
      await mental.logImagerySession(secondAthlete, { minutes: 2, now });
    }
    const other = new Client({ connectionString: connectionStringFor(TEST_DB_NAME) });
    await other.connect();
    try {
      await other.query('begin');
      await other.query(
        `select pg_advisory_xact_lock(hashtext('ppbf.mental-skills:' || $1::text || ':' || $2::text || ':' || $3::text))`,
        [ORG, SECOND_ATHLETE, day],
      );
      await other.query(
        `insert into pilot.athlete_mental_skill_entries
           (organization_id, entry_id, athlete_id, kind, minutes, logged_on)
         values ($1, '11111111-1111-4111-8111-111111111111', $2, 'imagery_session', 2, $3::date)`,
        [ORG, SECOND_ATHLETE, day],
      );
      const racing = mental.logImagerySession(secondAthlete, { minutes: 2, now }).then(
        () => 'inserted',
        (error: Error) => error.message,
      );
      await new Promise((resolve) => setTimeout(resolve, 500));
      await other.query('commit');
      expect(await racing).toMatch(/a day/);
    } finally {
      await other.end();
    }
    const stored = await main.query(
      `select count(*)::int as n from pilot.athlete_mental_skill_entries
       where organization_id = $1 and athlete_id = $2 and logged_on = $3::date`,
      [ORG, SECOND_ATHLETE, day],
    );
    expect(stored.rows[0].n).toBe(mental.DAILY_ENTRY_LIMIT);
  });

  test('every entry has exactly one audit record, which never carries the cue text', async () => {
    const cue = await mental.setSelfTalkCue(secondAthlete, { cueText: 'private words', cueKind: 'motivational' });
    const audit = await main.query(
      `select details::text as details from pilot.audit_events
       where entity_type = 'athlete_mental_skill_entry' and entity_id = $1`,
      [cue.entry_id],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].details).toContain(SECOND_ATHLETE);
    expect(audit.rows[0].details).not.toContain('private words');
  });

  test('a day holds at most DAILY_ENTRY_LIMIT entries per athlete', async () => {
    const now = '2026-06-01T15:00:00Z';
    for (let i = 0; i < mental.DAILY_ENTRY_LIMIT; i += 1) {
      await mental.logImagerySession(secondAthlete, { minutes: 1, now });
    }
    await expect(mental.logImagerySession(secondAthlete, { minutes: 1, now })).rejects.toThrow(/a day/);
    await expect(mental.setSelfTalkCue(secondAthlete, { cueText: 'one more', cueKind: 'motivational', now }))
      .rejects.toThrow(/a day/);
    // Another day is unaffected.
    await mental.logImagerySession(secondAthlete, { minutes: 1, now: '2026-06-02T15:00:00Z' });
  });

  test('writes are self-only: guardian, coach and admin cannot write an athlete\'s entries', async () => {
    for (const writer of [parent, coach, admin, platformOwner]) {
      await expect(mental.setSelfTalkCue(writer, { cueText: 'words in their mouth', cueKind: 'motivational' }))
        .rejects.toThrow(/Only the athlete/);
      await expect(mental.logImagerySession(writer, { minutes: 5 })).rejects.toThrow(/Only the athlete/);
    }
    const unlinked = actor('acct-mental-athlete-nolink', 'athlete', ORG, null);
    await expect(mental.logImagerySession(unlinked, { minutes: 5 })).rejects.toThrow(/not linked/);
  });

  test('an athlete session naming a deleted athlete record cannot write or read', async () => {
    const ghost = actor('acct-mental-ghost', 'athlete', ORG, 'ath-mental-deleted');
    await expect(mental.logImagerySession(ghost, { minutes: 5 })).rejects.toThrow(/Forbidden/);
    await expect(mental.readMentalSkills(ghost, 'ath-mental-deleted')).rejects.toThrow(/Forbidden/);
  });

  test('module validation refuses bad input before the database sees it', async () => {
    const bad: Array<[unknown, unknown]> = [['', 'instructional'], ['x'.repeat(61), 'motivational'], ['ok', 'calm']];
    for (const [cueText, cueKind] of bad) {
      await expect(mental.setSelfTalkCue(athlete, { cueText, cueKind })).rejects.toThrow(/cue_/);
    }
    for (const minutes of [0, 61, 2.5, '5', null]) {
      await expect(mental.logImagerySession(athlete, { minutes })).rejects.toThrow(/minutes/);
    }
    for (const contentKey of ['Not A Key', 'i-hate-my-coach', '']) {
      await expect(mental.logImagerySession(athlete, { minutes: 5, contentKey })).rejects.toThrow(/content_key/);
    }
    for (const cueText of ['tab\there', 'line\nbreak', '\u0000']) {
      await expect(mental.setSelfTalkCue(athlete, { cueText, cueKind: 'motivational' })).rejects.toThrow(/cue_text/);
    }
    // Sixty emoji are sixty characters, as Postgres counts them.
    const sixtyEmoji = '\u{1F94A}'.repeat(60);
    expect((await mental.setSelfTalkCue(athlete, { cueText: sixtyEmoji, cueKind: 'motivational' })).cue_text)
      .toBe(sixtyEmoji);
    await mental.setSelfTalkCue(athlete, { cueText: 'keep working', cueKind: 'motivational' });
  });

  test('the table itself refuses a row that mixes the two kinds or breaks a bound', async () => {
    let n = 0;
    const insert = (
      kind: string, cueText: string | null, cueKind: string | null, minutes: number | null, contentKey: string | null = null,
    ) =>
      main.query(
        `insert into pilot.athlete_mental_skill_entries
           (organization_id, entry_id, athlete_id, kind, cue_text, cue_kind, minutes, content_key, logged_on)
         values ($1, $2::uuid, $3, $4, $5, $6, $7, $8, current_date)`,
        [ORG, `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`, ATHLETE, kind, cueText, cueKind, minutes,
          contentKey],
      );
    await expect(insert('self_talk_cue', 'hands up', 'instructional', 5)).rejects.toThrow(/shape_check/);
    await expect(insert('imagery_session', 'hands up', null, 5)).rejects.toThrow(/shape_check/);
    await expect(insert('imagery_session', null, null, null)).rejects.toThrow(/shape_check/);
    await expect(insert('imagery_session', null, null, 61)).rejects.toThrow(/minutes_check/);
    await expect(insert('self_talk_cue', 'x'.repeat(61), 'instructional', null)).rejects.toThrow(/cue_text_check/);
    await expect(insert('self_talk_cue', 'ok', 'calm', null)).rejects.toThrow(/cue_kind_check/);
    await expect(insert('journal', null, null, null)).rejects.toThrow(/kind_check/);
    await expect(insert('imagery_session', null, null, 0)).rejects.toThrow(/minutes_check/);
    await expect(insert('imagery_session', null, null, 5, 'Bad Key')).rejects.toThrow(/content_key_check/);
    await expect(insert('self_talk_cue', '   ', 'instructional', null)).rejects.toThrow(/cue_text_check/);
    await expect(insert('self_talk_cue', '\t\n', 'instructional', null)).rejects.toThrow(/cue_text_check/);
    await expect(insert('self_talk_cue', 'ok', 'instructional', null, 'imagery-rehearsal')).rejects.toThrow(/shape_check/);
    await expect(insert('imagery_session', null, 'motivational', 5)).rejects.toThrow(/shape_check/);
    // The two valid shapes are accepted, so the refusals above are not a blanket refusal.
    await insert('self_talk_cue', 'ok', 'instructional', null);
    await insert('imagery_session', null, null, 5, 'imagery-rehearsal');
  });

  test('the readiness gate refuses a table missing its shape constraint', async () => {
    const probe = await freshDatabase('ppbf_test_mental_skills_probe', [ORG]);
    try {
      const withoutShape = migrationSql.replace(
        /\n {2}constraint pilot_athlete_mental_skill_entries_shape_check check \([\s\S]*?\n {2}\),/,
        '',
      );
      expect(withoutShape).not.toBe(migrationSql);
      await expect(applyMigrationTransaction(probe, withoutShape)).rejects.toThrow('ATHLETE_MENTAL_SKILLS_TABLE_NOT_READY');
      const table = await probe.query(`select to_regclass('pilot.athlete_mental_skill_entries') as t`);
      expect(table.rows[0].t).toBeNull();
    } finally {
      await probe.end();
    }
  });

  describe('remove (OD-2026-10-04-023): self-only soft remove', () => {
    const storedRow = async (entryId: string) => (
      await main.query(
        `select removed_at, removed_by, cue_text, minutes from pilot.athlete_mental_skill_entries
         where organization_id = $1 and entry_id = $2::uuid`,
        [ORG, entryId],
      )
    ).rows[0];
    const auditRows = async (entryId: string) => (
      await main.query(
        `select event_type, actor_account_id, details from pilot.audit_events
         where entity_type = 'athlete_mental_skill_entry' and entity_id = $1 order by created_at`,
        [entryId],
      )
    ).rows;

    test('the athlete removes their own entry: hidden from the athlete, guardian, coach and admin; row and audit remain', async () => {
      const earlier = await mental.setSelfTalkCue(athlete, { cueText: 'chin down', cueKind: 'instructional' });
      const later = await mental.setSelfTalkCue(athlete, { cueText: 'secret words', cueKind: 'motivational' });
      const session = await mental.logImagerySession(athlete, { minutes: 9 });

      expect(await mental.removeMentalSkillsEntry(athlete, later.entry_id)).toEqual({ entry_id: later.entry_id });
      expect(await mental.removeMentalSkillsEntry(athlete, session.entry_id)).toEqual({ entry_id: session.entry_id });

      for (const reader of [athlete, parent, coach, admin]) {
        const view = await mental.readMentalSkills(reader, ATHLETE);
        // The earlier cue is current again; the removed one is gone.
        expect(view.current_cue?.entry_id).toBe(earlier.entry_id);
        expect(view.imagery_sessions.map((s) => s.entry_id)).not.toContain(session.entry_id);
        expect(JSON.stringify(view)).not.toContain('secret words');
      }

      for (const entryId of [later.entry_id, session.entry_id]) {
        const row = await storedRow(entryId);
        expect(row.removed_at).toBeInstanceOf(Date);
        expect(row.removed_by).toBe(ATHLETE_ACCOUNT);
        const audit = await auditRows(entryId);
        expect(audit.map((a) => a.event_type)).toEqual(['create', 'update']);
        expect(audit[1].actor_account_id).toBe(ATHLETE_ACCOUNT);
        expect(audit[1].details).toMatchObject({ athlete_id: ATHLETE, action: 'removed' });
        expect(JSON.stringify(audit[1].details)).not.toContain('secret words');
      }
      expect((await storedRow(later.entry_id)).cue_text).toBe('secret words');
    });

    test('nobody else can remove: another athlete gets not-found; guardian, coach, admin and platform owner are refused', async () => {
      const cue = await mental.setSelfTalkCue(athlete, { cueText: 'stay long', cueKind: 'instructional' });

      await expect(mental.removeMentalSkillsEntry(secondAthlete, cue.entry_id)).rejects.toThrow(/not found/);
      for (const writer of [parent, coach, admin, otherOrgAdmin, platformOwner, board]) {
        await expect(mental.removeMentalSkillsEntry(writer, cue.entry_id)).rejects.toThrow(/Only the athlete/);
      }
      // The same athlete id in the other gym is not this athlete.
      const sameIdOtherGym = actor('acct-mental-athlete-other', 'athlete', OTHER_ORG, OTHER_ATHLETE);
      await expect(mental.removeMentalSkillsEntry(sameIdOtherGym, cue.entry_id)).rejects.toThrow();

      expect((await storedRow(cue.entry_id)).removed_at).toBeNull();
      expect((await auditRows(cue.entry_id)).map((a) => a.event_type)).toEqual(['create']);
      expect((await mental.readMentalSkills(coach, ATHLETE)).current_cue?.entry_id).toBe(cue.entry_id);
    });

    test('removing twice, an unknown id or a malformed id changes nothing and writes no audit', async () => {
      const session = await mental.logImagerySession(athlete, { minutes: 3 });
      await mental.removeMentalSkillsEntry(athlete, session.entry_id);
      const firstRemovedAt = (await storedRow(session.entry_id)).removed_at;

      await expect(mental.removeMentalSkillsEntry(athlete, session.entry_id)).rejects.toThrow(/not found/);
      await expect(mental.removeMentalSkillsEntry(athlete, '22222222-2222-4222-8222-222222222222')).rejects.toThrow(/not found/);
      for (const bad of ['not-a-uuid', '', null, 42]) {
        await expect(mental.removeMentalSkillsEntry(athlete, bad)).rejects.toThrow(/entry_id/);
      }
      expect((await storedRow(session.entry_id)).removed_at).toEqual(firstRemovedAt);
      expect((await auditRows(session.entry_id)).map((a) => a.event_type)).toEqual(['create', 'update']);
    });

    test('removed entries still count toward the daily limit', async () => {
      const now = '2026-05-01T15:00:00Z';
      const ids: string[] = [];
      for (let i = 0; i < mental.DAILY_ENTRY_LIMIT; i += 1) {
        ids.push((await mental.logImagerySession(secondAthlete, { minutes: 1, now })).entry_id);
      }
      for (const id of ids) await mental.removeMentalSkillsEntry(secondAthlete, id);
      await expect(mental.logImagerySession(secondAthlete, { minutes: 1, now })).rejects.toThrow(/a day/);
    });

    test('the table refuses a half-removed row, and the remove readiness gate refuses a missing pair check', async () => {
      const cue = await mental.setSelfTalkCue(athlete, { cueText: 'breathe', cueKind: 'motivational' });
      await expect(main.query(
        `update pilot.athlete_mental_skill_entries set removed_at = now() where organization_id = $1 and entry_id = $2::uuid`,
        [ORG, cue.entry_id],
      )).rejects.toThrow(/removed_pair_check/);
      await expect(main.query(
        `update pilot.athlete_mental_skill_entries set removed_by = 'x' where organization_id = $1 and entry_id = $2::uuid`,
        [ORG, cue.entry_id],
      )).rejects.toThrow(/removed_pair_check/);

      const probe = await freshDatabase('ppbf_test_mental_skills_remove_probe', [ORG]);
      try {
        await applyMigrationTransaction(probe, migrationSql);
        const withoutPair = removeMigrationSql.replace(
          /\nalter table pilot\.athlete_mental_skill_entries\n {2}add constraint pilot_athlete_mental_skill_entries_removed_pair_check\n[^;]*;/,
          '',
        );
        expect(withoutPair).not.toBe(removeMigrationSql);
        await expect(applyRemoveMigration(probe, withoutPair)).rejects.toThrow('ATHLETE_MENTAL_SKILLS_REMOVE_NOT_READY');
        const column = await probe.query(
          `select 1 from information_schema.columns
           where table_schema = 'pilot' and table_name = 'athlete_mental_skill_entries' and column_name = 'removed_at'`,
        );
        expect(column.rows).toHaveLength(0);
      } finally {
        await probe.end();
      }
    });
  });
});
