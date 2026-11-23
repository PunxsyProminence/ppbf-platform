// Real PostgreSQL contract test for pilot_slice_postgres_pain_report_review_migration.sql
// (DR-25: the athlete's note on a pain report, and the coach's "Mark reviewed"; Jason
// 2026-11-23, DR-25 A, to be recorded; Overwatch GO on PR #2133).
//
// What needs a real database to prove: that every pain report written before the file reads no
// note, no verdict and not reviewed; that a note is refused empty, padded (space, tab, carriage
// return, line feed) or over 500 characters (characters, not bytes) and kept as sent at 1 and at
// 500; that a note cannot be stored without its safety-scan verdict, nor a verdict without a note
// (the verdict fails closed); that a reviewer is never recorded without a time, must be a real
// account, and is cleared (the time kept) when that account is deleted; that re-applying the file
// is a no-op; that the file holds nothing destructive; and that the runner's readiness assertion
// refuses a result it did not produce, including a database with no pilot.shadow_near_misses at
// all. Spins up the disposable local embedded Postgres the other migration suites use. It never
// connects to production or staging.

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
const TEMPLATE_DB = 'prr_template';
const NOTE_CHECK = 'pilot_shadow_near_misses_athlete_note_check';
const ADMIN_ONLY_CHECK = 'pilot_shadow_near_misses_athlete_note_admin_only_check';
const REVIEWED_CHECK = 'pilot_shadow_near_misses_reviewed_check';
const REVIEWED_FK = 'pilot_shadow_near_misses_reviewed_by_fk';
const CONSTRAINTS = [ADMIN_ONLY_CHECK, NOTE_CHECK, REVIEWED_FK, REVIEWED_CHECK];
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

async function adminQuery(sql: string): Promise<void> {
  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  try {
    await admin.query(sql);
  } finally {
    await admin.end();
  }
}

/**
 * A clone of the template (the whole schema in the `all` order, which includes this migration,
 * plus one gym, its coach and one athlete), or an empty database. The schema is built once.
 */
async function freshDatabase(name: string, schema: 'full' | 'none' = 'full'): Promise<Client> {
  await adminQuery(`drop database if exists ${name} with (force)`);
  await adminQuery(schema === 'full' ? `create database ${name} template ${TEMPLATE_DB}` : `create database ${name}`);
  const client = new Client({ connectionString: connectionStringFor(name) });
  await client.connect();
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

/** Sets the note with a coach-readable verdict, or clears both, the way the writer must. */
async function setNote(client: Client, id: string, note: string | null): Promise<void> {
  await client.query(
    `update pilot.shadow_near_misses
        set athlete_note = $2::text,
            athlete_note_admin_only = case when $2::text is null then null else false end
      where near_miss_id = $1::uuid`,
    [id, note],
  );
}

async function setNoteAndVerdict(client: Client, id: string, note: string | null, adminOnly: boolean | null): Promise<void> {
  await client.query(
    'update pilot.shadow_near_misses set athlete_note = $2, athlete_note_admin_only = $3 where near_miss_id = $1::uuid',
    [id, note, adminOnly],
  );
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
  const applyFullSchema = fullSchema.applyFullSchema as (client: Client, opts?: { infraDir?: string }) => Promise<unknown>;
  applyRunner = (await nativeDynamicImport(pathToFileURL(RUNNER_PATH).href)).applyMigrationTransaction as Apply;
  migrationSql = await fs.readFile(path.join(INFRA_DIR, MIGRATION_FILE), 'utf8');

  await adminQuery(`drop database if exists ${TEMPLATE_DB} with (force)`);
  await adminQuery(`create database ${TEMPLATE_DB}`);
  const template = new Client({ connectionString: connectionStringFor(TEMPLATE_DB) });
  await template.connect();
  try {
    await applyFullSchema(template, { infraDir: INFRA_DIR });
    await template.query(
      `insert into pilot.organizations (organization_id, organization_name, status) values ($1, $1, 'active')`,
      [ORG],
    );
    for (const account of [COACH, REVIEWER]) {
      await template.query(
        `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
         values ($1, 'coach', $2, 'microsoft')`,
        [account, ORG],
      );
    }
    await template.query(
      `insert into pilot.athletes (organization_id, athlete_id, full_name, dob, weight_class, gym_status,
         emergency_contact, active_flag, coach_id, created_at, updated_at)
       values ($1, $2, $2, '2011-05-06', 'fly', 'active', 'contact', true, $3, now(), now())`,
      [ORG, ATHLETE, COACH],
    );
  } finally {
    await template.end();
  }
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
  test('a pain report written before the file reads no note, no verdict, not reviewed', async () => {
    const client = await freshDatabase('prr_before');
    try {
      // The schema as it stood before this file.
      await dropNewColumns(client);
      const id = await insertPainReport(client);

      await applyRunner(client, migrationSql);

      expect(await row(client, id)).toEqual({
        athlete_note: null,
        athlete_note_admin_only: null,
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
      for (const bad of ['', ' ', ' sore', 'sore ', '\tsore', 'sore\n', '\r\nsore', 'x'.repeat(501), 'é'.repeat(501)]) {
        const refused = await refusal(setNote(client, id, bad));
        expect([JSON.stringify(bad).slice(0, 12), refused.code, refused.constraint])
          .toEqual([JSON.stringify(bad).slice(0, 12), '23514', NOTE_CHECK]);
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

  test('a note needs its safety-scan verdict and a verdict needs a note; both verdicts are kept', async () => {
    const client = await freshDatabase('prr_verdict');
    try {
      const id = await insertPainReport(client);

      // A writer that skips the scan is refused: the verdict has no default to fall back on.
      const noVerdict = await refusal(client.query(
        'update pilot.shadow_near_misses set athlete_note = $2 where near_miss_id = $1::uuid',
        [id, 'my coach hit me'],
      ));
      expect(noVerdict.code).toBe('23514');
      expect(noVerdict.constraint).toBe(ADMIN_ONLY_CHECK);

      for (const verdict of [true, false]) {
        const orphan = await refusal(setNoteAndVerdict(client, id, null, verdict));
        expect(orphan.code).toBe('23514');
        expect(orphan.constraint).toBe(ADMIN_ONLY_CHECK);
      }

      await setNoteAndVerdict(client, id, 'my coach hit me', true);
      expect(await row(client, id)).toMatchObject({ athlete_note: 'my coach hit me', athlete_note_admin_only: true });
      await setNoteAndVerdict(client, id, 'knee hurts on stairs', false);
      expect(await row(client, id)).toMatchObject({ athlete_note: 'knee hurts on stairs', athlete_note_admin_only: false });

      // An insert that names a note without a verdict is refused the same way.
      const insertNoVerdict = await refusal(client.query(
        `insert into pilot.shadow_near_misses
           (organization_id, athlete_id, description, severity, detected_by, metadata, athlete_note)
         values ($1, $2, 'Athlete reported pain.', 'moderate', 'system', '{}'::jsonb, 'sore')`,
        [ORG, ATHLETE],
      ));
      expect(insertNoVerdict.constraint).toBe(ADMIN_ONLY_CHECK);
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
        [id, REVIEWER],
      ));
      expect(noTime.code).toBe('23514');
      expect(noTime.constraint).toBe(REVIEWED_CHECK);

      const ghost = await refusal(client.query(
        'update pilot.shadow_near_misses set reviewed_by_account_id = $2, reviewed_at = now() where near_miss_id = $1::uuid',
        [id, 'acct-prr-nobody'],
      ));
      expect(ghost.code).toBe('23503');
      expect(ghost.constraint).toBe(REVIEWED_FK);

      // REVIEWER is not the athlete's coach of record, so the account can be deleted alone.
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

  test('the file holds nothing destructive, sets no default, and adds each constraint only when the table has none of that name', async () => {
    const sql = migrationSql.toLowerCase().replace(/--.*$/gm, '');
    expect(sql).not.toMatch(/\bdrop\b/);
    expect(sql).not.toMatch(/\btruncate\b/);
    expect(sql).not.toMatch(/\bdelete\s+from\b/);
    expect(sql).not.toMatch(/\bupdate\s+pilot\./);
    expect(sql).not.toMatch(/\bbegin\s*;|\bcommit\s*;/);
    // No default anywhere: the admin-only verdict fails closed.
    expect(sql).not.toMatch(/\bdefault\b/);
    for (const name of CONSTRAINTS) {
      expect(sql).toMatch(new RegExp(`if not exists \\(\\s*select 1 from pg_constraint\\s+where conname = '${name}'`));
    }
  });

  test('a re-run leaves the constraints and the data as they are', async () => {
    const client = await freshDatabase('prr_rerun');
    try {
      const id = await insertPainReport(client);
      await setNoteAndVerdict(client, id, 'knee', true);
      await client.query(
        'update pilot.shadow_near_misses set reviewed_by_account_id = $2, reviewed_at = now() where near_miss_id = $1::uuid',
        [id, REVIEWER],
      );
      const constraintOids = () => client.query(
        `select conname, oid from pg_constraint
          where conrelid = to_regclass('pilot.shadow_near_misses') and conname = any($1::text[]) order by conname`,
        [CONSTRAINTS],
      );
      const before = await constraintOids();
      expect(before.rows).toHaveLength(4);
      const rowBefore = await row(client, id);

      await applyRunner(client, migrationSql);
      await applyRunner(client, migrationSql);

      expect((await constraintOids()).rows).toEqual(before.rows);
      expect(await row(client, id)).toEqual(rowBefore);
    } finally {
      await client.end();
    }
  });

  test('the runner refuses a same-named note check with a wider limit, and a same-named verdict check that allows a note without one', async () => {
    for (const [name, constraint, definition, flag] of [
      ['prr_note_wide', NOTE_CHECK, 'athlete_note is null or char_length(athlete_note) <= 4000', 'note_check_ready'],
      ['prr_verdict_wide', ADMIN_ONLY_CHECK, 'athlete_note_admin_only is null or athlete_note is not null', 'admin_only_check_ready'],
    ] as const) {
      const client = await freshDatabase(name);
      try {
        await client.query(`alter table pilot.shadow_near_misses drop constraint ${constraint}`);
        await client.query(`alter table pilot.shadow_near_misses add constraint ${constraint} check (${definition})`);
        await expect(applyRunner(client, migrationSql)).rejects.toThrow(`PAIN_REPORT_REVIEW_NOT_READY: ${flag}`);
      } finally {
        await client.end();
      }
    }
  });

  test('the runner refuses a same-named reviewer foreign key that cascades on delete or on update, or is deferrable', async () => {
    for (const [name, clause] of [
      ['prr_fk_cascade', 'on delete cascade'],
      ['prr_fk_update', 'on delete set null on update cascade'],
      ['prr_fk_deferrable', 'on delete set null deferrable'],
    ] as const) {
      const client = await freshDatabase(name);
      try {
        await client.query(`alter table pilot.shadow_near_misses drop constraint ${REVIEWED_FK}`);
        await client.query(
          `alter table pilot.shadow_near_misses add constraint ${REVIEWED_FK}
             foreign key (reviewed_by_account_id) references pilot.accounts(account_id) ${clause}`,
        );
        await expect(applyRunner(client, migrationSql)).rejects.toThrow('PAIN_REPORT_REVIEW_NOT_READY: reviewed_by_fk_ready');
      } finally {
        await client.end();
      }
    }
  });

  test('the runner refuses a pre-existing verdict column that defaults to false (fails open) or is NOT NULL', async () => {
    for (const [name, definition] of [
      ['prr_flag_default', 'boolean null default false'],
      ['prr_flag_not_null', 'boolean not null default false'],
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
        + 'reviewed_at_ready, note_check_ready, admin_only_check_ready, reviewed_check_ready, reviewed_by_fk_ready',
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
