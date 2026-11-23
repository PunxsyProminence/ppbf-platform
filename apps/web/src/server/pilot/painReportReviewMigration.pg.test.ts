// Real PostgreSQL contract test for pilot_slice_postgres_pain_report_review_migration.sql
// (DR-25: the athlete's note on a pain report, and the coach's "Mark reviewed"; Jason
// 2026-11-23, DR-25 A, to be recorded; Overwatch GO on PR #2133).
//
// What needs a real database to prove: that every pain report written before the file reads
// no note, not admin-only and not reviewed; that a note is refused empty, padded or over 500
// characters (characters, not bytes) and kept as sent at 1 and at 500; that a reviewer is never
// recorded without a time, must be a real account, and is cleared (the time kept) when that
// account is deleted; that re-applying the file is a no-op; that the file holds nothing
// destructive; and that the runner's readiness assertion refuses a result it did not produce,
// including a database with no pilot.shadow_near_misses at all. Spins up the disposable local
// embedded Postgres the other migration suites use. It never connects to production or staging.

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
const DATA_DIR = path.join(os.tmpdir(), `ppbf-pain-report-review-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const RUNNER_PATH = path.resolve(__dirname, '../../../scripts/pilot-apply-pain-report-review-migration.mjs');
const FULL_SCHEMA_HELPER_PATH = path.resolve(__dirname, '../../../scripts/lib/full-schema.mjs');
const MIGRATION_FILE = 'pilot_slice_postgres_pain_report_review_migration.sql';
const NOTE_CHECK = 'pilot_shadow_near_misses_athlete_note_check';
const REVIEWED_CHECK = 'pilot_shadow_near_misses_reviewed_check';
const REVIEWED_FK = 'pilot_shadow_near_misses_reviewed_by_fk';
const NEW_COLUMNS = ['athlete_note', 'athlete_note_admin_only', 'reviewed_by_account_id', 'reviewed_at'];

const ORG = 'org-prr';
const COACH = 'acct-prr-coach';
const REVIEWER = 'acct-prr-reviewer';
const ATHLETE = 'ath-prr-1';

type Apply = (client: Client, sql: string) => Promise<void>;

const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let applyFullSchema: (client: Client, opts?: { infraDir?: string }) => Promise<unknown>;
let applyRunner: Apply;
let migrationSql: string;

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
      if (address === null || typeof address === 'string') {
        reject(new Error('Could not determine a free port'));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

async function freshDatabase(name: string, schema: 'full' | 'none' = 'full'): Promise<Client> {
  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  await admin.query(`drop database if exists ${name} with (force)`);
  await admin.query(`create database ${name}`);
  await admin.end();
  const client = new Client({ connectionString: connectionStringFor(name) });
  await client.connect();
  if (schema === 'none') return client;

  // The whole schema in the `all` order, which now includes this migration.
  await applyFullSchema(client, { infraDir: INFRA_DIR });
  await client.query(
    `insert into pilot.organizations (organization_id, organization_name, status) values ($1, $1, 'active')`,
    [ORG],
  );
  await client.query(
    `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
     values ($1, 'coach', $2, 'microsoft')`,
    [COACH, ORG],
  );
  await client.query(
    `insert into pilot.athletes (organization_id, athlete_id, full_name, dob, weight_class, gym_status,
       emergency_contact, active_flag, coach_id, created_at, updated_at)
     values ($1, $2, $2, '2011-05-06', 'fly', 'active', 'contact', true, $3, now(), now())`,
    [ORG, ATHLETE, COACH],
  );
  return client;
}

/** A pain report's near miss, shaped the way painReportAlert.ts writes one. */
async function insertPainReport(client: Client): Promise<string> {
  const result = await client.query<{ near_miss_id: string }>(
    `insert into pilot.shadow_near_misses
       (organization_id, athlete_id, description, severity, detected_by, detected_by_account_id, metadata)
     values ($1, $2, 'Athlete reported pain.', 'moderate', 'system', null,
             '{"trigger":"athlete_pain_report","severity_1_10":3}'::jsonb)
     returning near_miss_id::text`,
    [ORG, ATHLETE],
  );
  return result.rows[0].near_miss_id;
}

async function setNote(client: Client, id: string, note: string | null): Promise<void> {
  await client.query('update pilot.shadow_near_misses set athlete_note = $2 where near_miss_id = $1::uuid', [id, note]);
}

async function row(client: Client, id: string): Promise<Record<string, unknown>> {
  const result = await client.query(
    `select athlete_note, athlete_note_admin_only, reviewed_by_account_id, reviewed_at is not null as has_reviewed_at
       from pilot.shadow_near_misses where near_miss_id = $1::uuid`,
    [id],
  );
  return result.rows[0];
}

async function refusal(promise: Promise<unknown>): Promise<{ code?: string; constraint?: string }> {
  try {
    await promise;
  } catch (error) {
    return error as { code?: string; constraint?: string };
  }
  throw new Error('expected the write to be refused');
}

async function dropNewColumns(client: Client): Promise<void> {
  for (const columnName of NEW_COLUMNS) {
    await client.query(`alter table pilot.shadow_near_misses drop column ${columnName}`);
  }
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
  applyRunner = (await nativeDynamicImport(pathToFileURL(RUNNER_PATH).href)).applyMigrationTransaction as Apply;
  migrationSql = await fs.readFile(path.join(INFRA_DIR, MIGRATION_FILE), 'utf8');
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

describe('pain report review migration (DR-25)', () => {
  test('a pain report written before the file reads no note, not admin-only, not reviewed', async () => {
    const client = await freshDatabase('prr_before');
    try {
      // The schema as it stood before this file.
      await dropNewColumns(client);
      const id = await insertPainReport(client);

      await applyRunner(client, migrationSql);

      expect(await row(client, id)).toEqual({
        athlete_note: null,
        athlete_note_admin_only: false,
        reviewed_by_account_id: null,
        has_reviewed_at: false,
      });
    } finally {
      await client.end();
    }
  });

  test('a note is refused empty, padded or over 500 characters; 1 and 500 are kept as sent', async () => {
    const client = await freshDatabase('prr_note_limits');
    try {
      const id = await insertPainReport(client);
      for (const bad of ['', ' ', ' sore', 'sore ', 'x'.repeat(501), 'é'.repeat(501)]) {
        const refused = await refusal(setNote(client, id, bad));
        expect(refused.code).toBe('23514');
        expect(refused.constraint).toBe(NOTE_CHECK);
      }

      await setNote(client, id, 'x');
      expect((await row(client, id)).athlete_note).toBe('x');
      await setNote(client, id, 'x'.repeat(500));
      expect((await row(client, id)).athlete_note).toBe('x'.repeat(500));

      // 500 characters, not 500 bytes: an accented note is not cut short.
      const accented = 'é'.repeat(500);
      await setNote(client, id, accented);
      expect((await row(client, id)).athlete_note).toBe(accented);

      // A line break inside a note is the athlete's own writing and is kept.
      await setNote(client, id, 'left wrist\nhurts when I jab');
      expect((await row(client, id)).athlete_note).toBe('left wrist\nhurts when I jab');

      await setNote(client, id, null);
      expect((await row(client, id)).athlete_note).toBeNull();
    } finally {
      await client.end();
    }
  });

  test('a reviewer needs a time and a real account; deleting the account clears the reviewer and keeps the time', async () => {
    const client = await freshDatabase('prr_reviewed');
    try {
      const id = await insertPainReport(client);

      const noTime = await refusal(client.query(
        'update pilot.shadow_near_misses set reviewed_by_account_id = $2 where near_miss_id = $1::uuid',
        [id, COACH],
      ));
      expect(noTime.code).toBe('23514');
      expect(noTime.constraint).toBe(REVIEWED_CHECK);

      const ghost = await refusal(client.query(
        'update pilot.shadow_near_misses set reviewed_by_account_id = $2, reviewed_at = now() where near_miss_id = $1::uuid',
        [id, 'acct-prr-nobody'],
      ));
      expect(ghost.code).toBe('23503');
      expect(ghost.constraint).toBe(REVIEWED_FK);

      // A second coach, not the athlete's coach of record, so the account can be deleted alone.
      await client.query(
        `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
         values ($1, 'coach', $2, 'microsoft')`,
        [REVIEWER, ORG],
      );
      await client.query(
        'update pilot.shadow_near_misses set reviewed_by_account_id = $2, reviewed_at = now() where near_miss_id = $1::uuid',
        [id, REVIEWER],
      );
      expect(await row(client, id)).toMatchObject({ reviewed_by_account_id: REVIEWER, has_reviewed_at: true });

      await client.query('delete from pilot.accounts where account_id = $1', [REVIEWER]);
      expect(await row(client, id)).toMatchObject({ reviewed_by_account_id: null, has_reviewed_at: true });
    } finally {
      await client.end();
    }
  });

  test('the file holds nothing destructive, and adds each constraint only when the table has none of that name', async () => {
    const sql = migrationSql.toLowerCase().replace(/--.*$/gm, '');
    expect(sql).not.toMatch(/\bdrop\b/);
    expect(sql).not.toMatch(/\btruncate\b/);
    expect(sql).not.toMatch(/\bdelete\s+from\b/);
    expect(sql).not.toMatch(/\bupdate\s+pilot\./);
    expect(sql).not.toMatch(/\bbegin\s*;|\bcommit\s*;/);
    for (const name of [NOTE_CHECK, REVIEWED_CHECK, REVIEWED_FK]) {
      expect(sql).toMatch(new RegExp(`if not exists \\(\\s*select 1 from pg_constraint\\s+where conname = '${name}'`));
    }
    // The only default is the admin-only flag's false.
    expect(sql.match(/\bdefault\b/g)).toHaveLength(1);
    expect(sql).toMatch(/athlete_note_admin_only boolean not null default false/);
  });

  test('a re-run leaves the constraints and the data as they are', async () => {
    const client = await freshDatabase('prr_rerun');
    try {
      const id = await insertPainReport(client);
      await setNote(client, id, 'knee');
      await client.query(
        `update pilot.shadow_near_misses
            set athlete_note_admin_only = true, reviewed_by_account_id = $2, reviewed_at = now()
          where near_miss_id = $1::uuid`,
        [id, COACH],
      );
      const constraintOids = () => client.query(
        `select conname, oid from pg_constraint
          where conrelid = to_regclass('pilot.shadow_near_misses') and conname = any($1::text[]) order by conname`,
        [[NOTE_CHECK, REVIEWED_CHECK, REVIEWED_FK]],
      );
      const before = await constraintOids();
      expect(before.rows).toHaveLength(3);
      const rowBefore = await row(client, id);

      await applyRunner(client, migrationSql);
      await applyRunner(client, migrationSql);

      expect((await constraintOids()).rows).toEqual(before.rows);
      expect(await row(client, id)).toEqual(rowBefore);
    } finally {
      await client.end();
    }
  });

  test('the runner refuses a same-named note check with a wider limit', async () => {
    const client = await freshDatabase('prr_note_wide');
    try {
      await client.query(`alter table pilot.shadow_near_misses drop constraint ${NOTE_CHECK}`);
      await client.query(
        `alter table pilot.shadow_near_misses add constraint ${NOTE_CHECK} check (athlete_note is null or char_length(athlete_note) <= 4000)`,
      );
      await expect(applyRunner(client, migrationSql)).rejects.toThrow('PAIN_REPORT_REVIEW_NOT_READY: note_check_ready');
    } finally {
      await client.end();
    }
  });

  test('the runner refuses a same-named reviewer foreign key that cascades', async () => {
    const client = await freshDatabase('prr_fk_cascade');
    try {
      await client.query(`alter table pilot.shadow_near_misses drop constraint ${REVIEWED_FK}`);
      await client.query(
        `alter table pilot.shadow_near_misses add constraint ${REVIEWED_FK}
           foreign key (reviewed_by_account_id) references pilot.accounts(account_id) on delete cascade`,
      );
      await expect(applyRunner(client, migrationSql)).rejects.toThrow('PAIN_REPORT_REVIEW_NOT_READY: reviewed_by_fk_ready');
    } finally {
      await client.end();
    }
  });

  test('the runner refuses a pre-existing admin-only column that defaults to true or allows NULL', async () => {
    for (const [name, definition] of [
      ['prr_flag_true', 'boolean not null default true'],
      ['prr_flag_nullable', 'boolean null default false'],
    ] as const) {
      const client = await freshDatabase(name);
      try {
        await client.query('alter table pilot.shadow_near_misses drop column athlete_note_admin_only');
        await client.query(`alter table pilot.shadow_near_misses add column athlete_note_admin_only ${definition}`);
        await expect(applyRunner(client, migrationSql)).rejects.toThrow(
          'PAIN_REPORT_REVIEW_NOT_READY: athlete_note_admin_only_ready',
        );
      } finally {
        await client.end();
      }
    }
  });

  test('the runner refuses a database without pilot.shadow_near_misses, by name, before running the file', async () => {
    const client = await freshDatabase('prr_no_table', 'none');
    try {
      await expect(applyRunner(client, migrationSql)).rejects.toThrow(
        'PAIN_REPORT_REVIEW_NOT_READY: table_ready (pilot.shadow_near_misses is missing; apply shadow-decision-loop first)',
      );
    } finally {
      await client.end();
    }
  });

  test('the runner refuses a result it did not produce, and commits nothing', async () => {
    const client = await freshDatabase('prr_not_ready');
    try {
      await dropNewColumns(client);
      await expect(applyRunner(client, 'select 1')).rejects.toThrow(
        'PAIN_REPORT_REVIEW_NOT_READY: athlete_note_ready, athlete_note_admin_only_ready, reviewed_by_account_id_ready, '
        + 'reviewed_at_ready, note_check_ready, reviewed_check_ready, reviewed_by_fk_ready',
      );
      const columns = await client.query(
        `select column_name from information_schema.columns
          where table_schema = 'pilot' and table_name = 'shadow_near_misses' and column_name = any($1::text[])`,
        [NEW_COLUMNS],
      );
      expect(columns.rows).toEqual([]);
    } finally {
      await client.end();
    }
  });
});
