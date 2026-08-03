// Real PostgreSQL-backed contract test for the feedback submissions migration.
//
// The comment box has no storage. pilot.shadow_feedback is a rating bound to a
// SHADOW conversation message and cannot hold a sentence about the app, so
// there is nowhere for "this page is broken" or "someone is hurting me" to go.
//
// The second of those is why this suite exists. On a platform whose users
// include children, a free-text box is a disclosure channel, and the schema
// carries the routing decision rather than trusting a caller to re-derive it.
// Four things need proving, and none can be proven by reading SQL:
//
// 1. Route is stored, never inferred. The column is NOT NULL with no default,
//    so a writer that has not decided cannot insert -- it cannot quietly land
//    in 'product'.
//
// 2. A stored route cannot be rewritten. Detection rules change; a child's
//    disclosure does not get reclassified out of the safeguarding queue
//    afterwards. The database refuses the UPDATE, because every backfill and
//    cleanup script is a writer that application code never sees.
//
// 3. A disclosure outlives its author's account, and stays legible without it:
//    the frozen submitted_by_role still says an athlete wrote it. Deleting the
//    account must still work, which is the reverse hazard -- a freeze that also
//    covered the account reference would make deletion impossible.
//
// 4. The runner's readiness check actually fails when the migration did not
//    land. An all-green suite whose readiness passes on an unmigrated database
//    proves nothing, so that case -- and the cases where only the safeguarding
//    index or only the freeze trigger is missing -- are asserted directly
//    against the real runner.
//
// Spins up the same disposable, local-only embedded Postgres the other
// migration suites use. It NEVER connects to production or staging.

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
const DATA_DIR = path.join(os.tmpdir(), `ppbf-feedback-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const MIGRATION_FILE = 'pilot_slice_postgres_feedback_migration.sql';
const MIGRATION_RUNNER_PATH = path.resolve(
  __dirname,
  '../../../scripts/pilot-apply-feedback-migration.mjs',
);

const ORG_A = 'org-feedback-a';
const ORG_B = 'org-feedback-b';
const ADMIN_ID = 'acct-feedback-admin';
const COACH_ID = 'acct-feedback-coach';
const PARENT_ID = 'acct-feedback-parent';
const ATHLETE_ID = 'acct-feedback-athlete';
const BOARD_ID = 'acct-feedback-board';
const ORG_B_ATHLETE_ID = 'acct-feedback-b-athlete';

// The queue read the safeguarding index exists to serve: this gym, the
// safeguarding lane, the ones nobody has picked up, newest first.
const QUEUE_SQL = `
  select submission_id, submitted_by_account_id, submitted_by_role, kind, body
  from pilot.feedback_submissions
  where organization_id = $1 and route = $2 and triage_status = $3
  order by created_at desc`;

const MY_SUBMISSIONS_SQL = `
  select kind, route, triage_status
  from pilot.feedback_submissions
  where organization_id = $1 and submitted_by_account_id = $2
  order by created_at desc`;

// ts-jest downlevels a plain `await import(...)` into require(), which cannot
// load an ESM-only .mjs file. Building the import() call inside `new Function`
// hides it from that transform, so Node's own ESM loader executes it.
const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let migrationSql: string;
let baseSchemaSql: string;
let boardRoleSql: string;
let applyMigrationTransaction: (client: Client, sql: string) => Promise<void>;

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

/**
 * Fresh database with the base schema, the board role vocabulary, two
 * organizations and one account per role the submissions reference. This
 * migration is NOT applied here -- each test decides when to apply it.
 */
async function freshDatabase(name: string): Promise<Client> {
  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  await admin.query(`drop database if exists ${name}`);
  await admin.query(`create database ${name}`);
  await admin.end();

  const client = new Client({ connectionString: connectionStringFor(name) });
  await client.connect();
  await client.query(baseSchemaSql);
  // Without this, role = 'board' violates the base schema's role CHECK and no
  // board member can exist to file anything.
  await client.query(boardRoleSql);

  for (const organizationId of [ORG_A, ORG_B]) {
    await client.query(
      `insert into pilot.organizations (organization_id, organization_name, status)
       values ($1, $1, 'active') on conflict do nothing`,
      [organizationId],
    );
  }
  const accounts: Array<[string, string, string]> = [
    [ADMIN_ID, 'organization_admin', ORG_A],
    [COACH_ID, 'coach', ORG_A],
    [PARENT_ID, 'parent', ORG_A],
    [ATHLETE_ID, 'athlete', ORG_A],
    [BOARD_ID, 'board', ORG_A],
    [ORG_B_ATHLETE_ID, 'athlete', ORG_B],
  ];
  for (const [accountId, role, organizationId] of accounts) {
    await client.query(
      `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
       values ($1, $2, $3, 'ppbf_local') on conflict do nothing`,
      [accountId, role, organizationId],
    );
  }
  return client;
}

type SubmissionValues = {
  organizationId?: string;
  accountId?: string;
  role?: string;
  kind?: string;
  body?: string;
  route?: string;
  triageStatus?: string;
};

/**
 * Inserts the way the app would: the caller states the route. `route` and
 * `triage_status` are omitted from the statement entirely when the test omits
 * them, so the column defaults -- or the absence of one -- are what is measured.
 */
async function submit(client: Client, values: SubmissionValues = {}): Promise<string> {
  const columns = [
    'organization_id',
    'submitted_by_account_id',
    'submitted_by_role',
    'kind',
    'body',
  ];
  const params: Array<string | null> = [
    values.organizationId ?? ORG_A,
    values.accountId ?? COACH_ID,
    values.role ?? 'coach',
    values.kind ?? 'bug',
    values.body ?? 'The attendance page loses my selection when I scroll.',
  ];
  if ('route' in values) {
    columns.push('route');
    params.push(values.route as string);
  }
  if ('triageStatus' in values) {
    columns.push('triage_status');
    params.push(values.triageStatus as string);
  }

  const placeholders = params.map((_, index) => `$${index + 1}`).join(', ');
  const { rows } = await client.query(
    `insert into pilot.feedback_submissions (${columns.join(', ')})
     values (${placeholders})
     returning submission_id`,
    params,
  );
  return rows[0].submission_id as string;
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

  baseSchemaSql = await fs.readFile(path.join(INFRA_DIR, 'pilot_slice_postgres.sql'), 'utf8');
  boardRoleSql = await fs.readFile(
    path.join(INFRA_DIR, 'pilot_slice_postgres_board_role_migration.sql'), 'utf8');
  // Like the announcements and board-seats runners, this runner opens the
  // transaction itself, so the file applies here as plain statements exactly as
  // the runner sends it.
  migrationSql = await fs.readFile(path.join(INFRA_DIR, MIGRATION_FILE), 'utf8');

  const runnerModule = await nativeDynamicImport(pathToFileURL(MIGRATION_RUNNER_PATH).href);
  applyMigrationTransaction = runnerModule.applyMigrationTransaction as (
    client: Client,
    sql: string,
  ) => Promise<void>;
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
});

describe('feedback submissions migration against real Postgres', () => {
  test('the gap is real: without the migration nothing can be reported or read', async () => {
    const client = await freshDatabase('ppbf_test_feedback_absent');
    try {
      const table = await client.query(`select to_regclass('pilot.feedback_submissions') as t`);
      expect(table.rows[0].t).toBeNull();

      await expect(client.query(QUEUE_SQL, [ORG_A, 'safeguarding', 'new'])).rejects.toThrow(
        /feedback_submissions|does not exist/,
      );
    } finally {
      await client.end();
    }
  });

  // NEGATIVE CONTROL. If readiness passed here, every other assertion in this
  // file would be worthless: the runner would commit an environment where the
  // migration silently did nothing.
  test('the readiness check REFUSES a database where the migration never ran', async () => {
    const client = await freshDatabase('ppbf_test_feedback_readiness_negative');
    try {
      await expect(applyMigrationTransaction(client, 'select 1')).rejects.toThrow(
        /FEEDBACK_SUBMISSIONS_NOT_READY/,
      );

      const table = await client.query(`select to_regclass('pilot.feedback_submissions') as t`);
      expect(table.rows[0].t).toBeNull();
    } finally {
      await client.end();
    }
  });

  // A child's disclosure behind a sequential scan of every suggestion the gym
  // ever received is a response-time problem, so readiness measures the index
  // rather than the table alone.
  test('the readiness check REFUSES a database whose safeguarding index is missing', async () => {
    const client = await freshDatabase('ppbf_test_feedback_readiness_index');
    try {
      await applyMigrationTransaction(client, migrationSql);
      await client.query('drop index pilot.idx_pilot_feedback_submissions_route_queue');

      await expect(applyMigrationTransaction(client, 'select 1')).rejects.toThrow(
        /FEEDBACK_SUBMISSIONS_NOT_READY/,
      );

      // Re-running restores it, so a damaged environment is repaired rather
      // than left needing hand surgery.
      await applyMigrationTransaction(client, migrationSql);
      const { rows } = await client.query(
        `select indexdef from pg_indexes
         where schemaname = 'pilot'
           and indexname = 'idx_pilot_feedback_submissions_route_queue'`,
      );
      expect(rows[0].indexdef).toContain(
        '(organization_id, route, triage_status, created_at DESC)',
      );
    } finally {
      await client.end();
    }
  });

  // Without the trigger the table still accepts every insert this suite makes,
  // so only readiness stands between a silent reclassification and production.
  test('the readiness check REFUSES a database whose freeze trigger is missing', async () => {
    const client = await freshDatabase('ppbf_test_feedback_readiness_trigger');
    try {
      await applyMigrationTransaction(client, migrationSql);
      await client.query(
        `drop trigger pilot_feedback_submissions_freeze_disclosure
         on pilot.feedback_submissions`,
      );

      await expect(applyMigrationTransaction(client, 'select 1')).rejects.toThrow(
        /FEEDBACK_SUBMISSIONS_NOT_READY/,
      );

      await applyMigrationTransaction(client, migrationSql);
      const { rows } = await client.query(
        `select count(*)::int as n from pg_trigger
         where tgrelid = 'pilot.feedback_submissions'::regclass and not tgisinternal`,
      );
      expect(rows[0].n).toBe(1);
    } finally {
      await client.end();
    }
  });

  test('a submission is written and read back with its route and status', async () => {
    const client = await freshDatabase('ppbf_test_feedback_roundtrip');
    try {
      await applyMigrationTransaction(client, migrationSql);

      const submissionId = await submit(client, {
        accountId: PARENT_ID,
        role: 'parent',
        kind: 'idea',
        body: 'Let guardians see the practice schedule a week ahead.',
        route: 'product',
      });

      const { rows } = await client.query(
        `select organization_id, submitted_by_account_id, submitted_by_role, kind, body,
                route, triage_status, triage_note, triaged_by_account_id, triaged_at,
                created_at is not null as created, updated_at is not null as updated
         from pilot.feedback_submissions
         where submission_id = $1`,
        [submissionId],
      );
      expect(rows).toEqual([
        {
          organization_id: ORG_A,
          submitted_by_account_id: PARENT_ID,
          submitted_by_role: 'parent',
          kind: 'idea',
          body: 'Let guardians see the practice schedule a week ahead.',
          route: 'product',
          // Nobody has picked it up yet, and the row says so rather than
          // presenting an empty triage as a decision.
          triage_status: 'new',
          triage_note: null,
          triaged_by_account_id: null,
          triaged_at: null,
          created: true,
          updated: true,
        },
      ]);
    } finally {
      await client.end();
    }
  });

  test('an invalid kind, route, status or submitter role is refused', async () => {
    const client = await freshDatabase('ppbf_test_feedback_vocabulary');
    try {
      await applyMigrationTransaction(client, migrationSql);

      for (const kind of ['bug', 'idea', 'frustration', 'other']) {
        await submit(client, { kind, route: 'product' });
      }
      await expect(submit(client, { kind: 'feature-request', route: 'product' })).rejects.toThrow(
        /pilot_feedback_submissions_kind_check/,
      );

      await submit(client, { route: 'safeguarding', accountId: ATHLETE_ID, role: 'athlete' });
      await expect(submit(client, { route: 'backlog' })).rejects.toThrow(
        /pilot_feedback_submissions_route_check/,
      );

      for (const triageStatus of ['new', 'triaged', 'planned', 'declined', 'done']) {
        await submit(client, { route: 'product', triageStatus });
      }
      await expect(submit(client, { route: 'product', triageStatus: 'wontfix' })).rejects.toThrow(
        /pilot_feedback_submissions_triage_status_check/,
      );

      // The frozen role is what makes a safeguarding row legible; a value
      // nobody could have held would make it a guess.
      await submit(client, { route: 'product', accountId: BOARD_ID, role: 'board' });
      await expect(
        submit(client, { route: 'product', accountId: BOARD_ID, role: 'mascot' }),
      ).rejects.toThrow(/pilot_feedback_submissions_role_check/);

      // A blank body is a queue entry that would render as nothing.
      await expect(submit(client, { route: 'product', body: '   \n  ' })).rejects.toThrow(
        /pilot_feedback_submissions_body_present_check/,
      );
    } finally {
      await client.end();
    }
  });

  test('a submission with no route is refused rather than defaulted into the backlog', async () => {
    const client = await freshDatabase('ppbf_test_feedback_route_required');
    try {
      await applyMigrationTransaction(client, migrationSql);

      // The insert omits `route` entirely -- the shape a caller that forgot to
      // decide would produce.
      await expect(submit(client)).rejects.toThrow(/route/);

      const { rows } = await client.query(
        `select is_nullable, column_default
         from information_schema.columns
         where table_schema = 'pilot'
           and table_name = 'feedback_submissions'
           and column_name = 'route'`,
      );
      expect(rows).toEqual([{ is_nullable: 'NO', column_default: null }]);

      const stored = await client.query(
        `select count(*)::int as n from pilot.feedback_submissions`,
      );
      expect(stored.rows[0].n).toBe(0);
    } finally {
      await client.end();
    }
  });

  test('a stored route cannot be rewritten, and neither can the body or the role', async () => {
    const client = await freshDatabase('ppbf_test_feedback_frozen');
    try {
      await applyMigrationTransaction(client, migrationSql);
      const submissionId = await submit(client, {
        accountId: ATHLETE_ID,
        role: 'athlete',
        kind: 'other',
        body: 'someone at the gym keeps hurting me and I am scared to come back',
        route: 'safeguarding',
      });

      // The reclassification a later edit of the detection rules would perform.
      await expect(
        client.query(
          `update pilot.feedback_submissions set route = 'product' where submission_id = $1`,
          [submissionId],
        ),
      ).rejects.toThrow(/FEEDBACK_SUBMISSION_IMMUTABLE/);

      await expect(
        client.query(
          `update pilot.feedback_submissions set body = 'never mind' where submission_id = $1`,
          [submissionId],
        ),
      ).rejects.toThrow(/FEEDBACK_SUBMISSION_IMMUTABLE/);

      await expect(
        client.query(
          `update pilot.feedback_submissions set submitted_by_role = 'volunteer'
           where submission_id = $1`,
          [submissionId],
        ),
      ).rejects.toThrow(/FEEDBACK_SUBMISSION_IMMUTABLE/);

      // Triage is the part that moves, and it moves freely.
      await client.query(
        `update pilot.feedback_submissions
         set triage_status = 'triaged',
             triage_note = 'Safeguarding lead contacted the same day.',
             triaged_by_account_id = $2,
             triaged_at = now(),
             updated_at = now()
         where submission_id = $1`,
        [submissionId, ADMIN_ID],
      );

      const { rows } = await client.query(
        `select route, body, submitted_by_role, triage_status, triaged_by_account_id,
                triaged_at is not null as triaged
         from pilot.feedback_submissions where submission_id = $1`,
        [submissionId],
      );
      expect(rows).toEqual([
        {
          route: 'safeguarding',
          body: 'someone at the gym keeps hurting me and I am scared to come back',
          submitted_by_role: 'athlete',
          triage_status: 'triaged',
          triaged_by_account_id: ADMIN_ID,
          triaged: true,
        },
      ]);
    } finally {
      await client.end();
    }
  });

  test('the safeguarding queue is org-scoped and separate from the product backlog', async () => {
    const client = await freshDatabase('ppbf_test_feedback_scoping');
    try {
      await applyMigrationTransaction(client, migrationSql);

      const disclosure = await submit(client, {
        accountId: ATHLETE_ID,
        role: 'athlete',
        kind: 'other',
        body: 'my ribs hurt after practice and I did not want to say it out loud',
        route: 'safeguarding',
      });
      await submit(client, { accountId: COACH_ID, role: 'coach', route: 'product' });
      const otherGym = await submit(client, {
        organizationId: ORG_B,
        accountId: ORG_B_ATHLETE_ID,
        role: 'athlete',
        kind: 'other',
        body: 'someone is hurting me',
        route: 'safeguarding',
      });

      const orgA = await client.query(QUEUE_SQL, [ORG_A, 'safeguarding', 'new']);
      expect(orgA.rows.map((row: { submission_id: string }) => row.submission_id))
        .toEqual([disclosure]);

      const orgB = await client.query(QUEUE_SQL, [ORG_B, 'safeguarding', 'new']);
      expect(orgB.rows.map((row: { submission_id: string }) => row.submission_id))
        .toEqual([otherGym]);

      // The coach's bug report is nowhere near the safeguarding lane.
      const backlog = await client.query(QUEUE_SQL, [ORG_A, 'product', 'new']);
      expect(backlog.rows).toHaveLength(1);
      expect(backlog.rows[0].submitted_by_account_id).toBe(COACH_ID);

      const mine = await client.query(MY_SUBMISSIONS_SQL, [ORG_A, COACH_ID]);
      expect(mine.rows).toEqual([{ kind: 'bug', route: 'product', triage_status: 'new' }]);
    } finally {
      await client.end();
    }
  });

  test('a disclosure outlives its author and stays legible without the account', async () => {
    const client = await freshDatabase('ppbf_test_feedback_author_deleted');
    try {
      await applyMigrationTransaction(client, migrationSql);
      const submissionId = await submit(client, {
        accountId: ATHLETE_ID,
        role: 'athlete',
        kind: 'other',
        body: 'I am afraid of what happens if I show up on Thursday',
        route: 'safeguarding',
      });
      await client.query(
        `update pilot.feedback_submissions
         set triage_status = 'triaged', triaged_by_account_id = $2, triaged_at = now()
         where submission_id = $1`,
        [submissionId, ADMIN_ID],
      );

      // Closing the account is one of the things that can FOLLOW a disclosure.
      // The delete must succeed -- the freeze does not cover the account
      // references, whose on-delete-set-null arrives here as an update.
      await client.query(`delete from pilot.accounts where account_id = $1`, [ATHLETE_ID]);
      await client.query(`delete from pilot.accounts where account_id = $1`, [ADMIN_ID]);

      const { rows } = await client.query(
        `select submitted_by_account_id, submitted_by_role, route, body,
                triage_status, triaged_by_account_id
         from pilot.feedback_submissions where submission_id = $1`,
        [submissionId],
      );
      expect(rows).toEqual([
        {
          submitted_by_account_id: null,
          // The record still says a child wrote it, which is the whole basis
          // for it being in this queue.
          submitted_by_role: 'athlete',
          route: 'safeguarding',
          body: 'I am afraid of what happens if I show up on Thursday',
          triage_status: 'triaged',
          triaged_by_account_id: null,
        },
      ]);
    } finally {
      await client.end();
    }
  });

  test('the migration creates the read-path indexes it claims', async () => {
    const client = await freshDatabase('ppbf_test_feedback_indexes');
    try {
      await applyMigrationTransaction(client, migrationSql);

      const indexes = await client.query(
        `select indexname, indexdef from pg_indexes
         where schemaname = 'pilot' and tablename = 'feedback_submissions'`,
      );
      const byName = new Map<string, string>(
        indexes.rows.map((row: { indexname: string; indexdef: string }) => [
          row.indexname,
          row.indexdef,
        ]),
      );
      expect(byName.get('idx_pilot_feedback_submissions_route_queue')).toContain(
        '(organization_id, route, triage_status, created_at DESC)',
      );
      expect(byName.has('idx_pilot_feedback_submissions_submitter')).toBe(true);
      expect(byName.has('feedback_submissions_pkey')).toBe(true);
    } finally {
      await client.end();
    }
  });

  test('re-running is a no-op and keeps every submission', async () => {
    const client = await freshDatabase('ppbf_test_feedback_idempotent');
    try {
      await applyMigrationTransaction(client, migrationSql);
      const disclosure = await submit(client, {
        accountId: ATHLETE_ID,
        role: 'athlete',
        kind: 'other',
        body: 'it hurts when I spar with him and he knows',
        route: 'safeguarding',
      });
      const report = await submit(client, { route: 'product' });

      await applyMigrationTransaction(client, migrationSql);
      await applyMigrationTransaction(client, migrationSql);

      const safeguarding = await client.query(QUEUE_SQL, [ORG_A, 'safeguarding', 'new']);
      expect(safeguarding.rows.map((row: { submission_id: string }) => row.submission_id))
        .toEqual([disclosure]);
      const product = await client.query(QUEUE_SQL, [ORG_A, 'product', 'new']);
      expect(product.rows.map((row: { submission_id: string }) => row.submission_id))
        .toEqual([report]);

      // Re-running must not multiply the constraints, the indexes or the
      // trigger either.
      const constraints = await client.query(
        `select count(*)::int as n from pg_constraint
         where conrelid = 'pilot.feedback_submissions'::regclass and contype = 'c'`,
      );
      expect(constraints.rows[0].n).toBe(5);
      const indexes = await client.query(
        `select count(*)::int as n from pg_indexes
         where schemaname = 'pilot' and tablename = 'feedback_submissions'`,
      );
      expect(indexes.rows[0].n).toBe(3);
      const triggers = await client.query(
        `select count(*)::int as n from pg_trigger
         where tgrelid = 'pilot.feedback_submissions'::regclass and not tgisinternal`,
      );
      expect(triggers.rows[0].n).toBe(1);

      // The freeze survives a re-run: a replaced function that lost its trigger
      // would leave every stored route rewritable.
      await expect(
        client.query(
          `update pilot.feedback_submissions set route = 'product' where submission_id = $1`,
          [disclosure],
        ),
      ).rejects.toThrow(/FEEDBACK_SUBMISSION_IMMUTABLE/);
    } finally {
      await client.end();
    }
  });

  test('a submission cannot be filed for an organization or an account that does not exist', async () => {
    const client = await freshDatabase('ppbf_test_feedback_foreign_keys');
    try {
      await applyMigrationTransaction(client, migrationSql);

      await expect(
        submit(client, { organizationId: 'org-not-real', route: 'product' }),
      ).rejects.toThrow(/foreign key/);
      await expect(
        submit(client, { accountId: 'acct-not-real', route: 'product' }),
      ).rejects.toThrow(/foreign key/);
    } finally {
      await client.end();
    }
  });
});
