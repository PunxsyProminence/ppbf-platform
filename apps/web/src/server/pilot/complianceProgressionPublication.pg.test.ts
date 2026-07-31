// Real PostgreSQL-backed test for the compliance / progression / publication
// migration.
//
// Nine tables that three shipped feature areas read and write had no migration
// at all -- their only definition lived inside the migrate-multiorg HTTP route
// handler, so they exist in an environment only if somebody once POSTed to it
// there. Reading the ported SQL cannot prove the port is faithful; this suite
// applies it to a real server and then runs the application's own statements
// against the result.
//
// What needs proving:
//
// 1. The SQL applies at all, and applies twice (the workflow re-runs the whole
//    `all` list against every environment, so a non-idempotent statement would
//    break every future migration run).
// 2. The seeded compliance rules insert once per organization, not once per
//    run -- they are guarded by a NOT IN check, and a second application must
//    not duplicate them.
// 3. The real INSERT from publication.ts succeeds, including the text[] tags
//    column. That column is why publications never worked: the code passed
//    JSON.stringify(tags), which array_in rejects. A test that mocks the
//    database cannot catch that class of defect -- only a real one can.
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

import { Client } from 'pg';

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-cpp-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const MIGRATION_FILE = 'pilot_slice_postgres_compliance_progression_publication_migration.sql';

// The parent tables the nine reference. Trimmed to the columns the foreign
// keys need -- this suite proves the migration, not the base schema.
const PARENT_TABLES = `
  create table if not exists pilot.organizations (
    organization_id text primary key,
    display_name text not null default ''
  );
  create table if not exists pilot.accounts (
    account_id text primary key,
    organization_id text not null references pilot.organizations(organization_id)
  );
  create table if not exists pilot.athletes (
    organization_id text not null references pilot.organizations(organization_id),
    athlete_id text not null,
    display_name text not null default '',
    primary key (organization_id, athlete_id)
  );
  create table if not exists pilot.video_sessions (
    video_session_id text primary key,
    organization_id text not null references pilot.organizations(organization_id),
    uploaded_by_account_id text not null,
    athlete_id text null,
    title text not null,
    blob_path text not null,
    status text not null default 'quarantined',
    created_at timestamptz not null default now()
  );
`;

const SEED_ROWS = `
  insert into pilot.organizations (organization_id, display_name)
  values ('org-a', 'Gym A'), ('org-b', 'Gym B');
  insert into pilot.accounts (account_id, organization_id)
  values ('coach-a', 'org-a'), ('admin-a', 'org-a');
  insert into pilot.athletes (organization_id, athlete_id, display_name)
  values ('org-a', 'ath-1', 'Athlete One');
  insert into pilot.video_sessions (video_session_id, organization_id, uploaded_by_account_id, athlete_id, title, blob_path)
  values ('vid-1', 'org-a', 'coach-a', 'ath-1', 'Sparring tape', 'org-a/vid-1.mp4');
`;

// Verbatim from apps/web/src/server/pilot/publication.ts createPublication.
// Copied rather than imported because the module reaches for the app's pooled
// db client; if that INSERT's columns ever change, this test keeps asserting
// the old contract and the mismatch shows up here.
const PUBLICATION_INSERT = `insert into pilot.video_publications (
      publication_id, organization_id, video_session_id, athlete_id, submitted_by_account_id,
      publication_type, title, description, tags, status, compliance_check_status, metadata_complete
    ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'draft', 'pending', false)
    returning publication_id, tags`;

const EXPECTED_TABLES = [
  'compliance_rules',
  'compliance_violations',
  'violation_escalations',
  'progression_gaps',
  'drill_assignments',
  'assignment_completions',
  'video_publications',
  'publication_checks',
  'research_library',
];

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
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
      if (address && typeof address === 'object') {
        const { port } = address;
        server.close(() => resolve(port));
      } else {
        server.close(() => reject(new Error('Could not determine a free port')));
      }
    });
  });
}

/** Fresh database per case, so each starts from a known schema state. */
async function freshDatabase(name: string): Promise<Client> {
  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  await admin.query(`drop database if exists ${name}`);
  await admin.query(`create database ${name}`);
  await admin.end();

  const client = new Client({ connectionString: connectionStringFor(name) });
  await client.connect();
  await client.query('create schema if not exists pilot');
  await client.query(PARENT_TABLES);
  await client.query(SEED_ROWS);
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
});

describe('compliance/progression/publication migration against real Postgres', () => {
  test('a fresh install creates all nine tables', async () => {
    const client = await freshDatabase('ppbf_test_cpp_fresh');
    try {
      await client.query(migrationSql);

      const present = await client.query<{ table_name: string }>(
        `select table_name from information_schema.tables
         where table_schema = 'pilot' and table_name = any($1::text[])`,
        [EXPECTED_TABLES],
      );
      expect(present.rows.map((r) => r.table_name).sort()).toEqual([...EXPECTED_TABLES].sort());
    } finally {
      await client.end();
    }
  });

  test('the real publication INSERT succeeds, tags included', async () => {
    // The whole publication feature failed here: tags is text[], and the code
    // used to bind JSON.stringify(tags), which array_in rejects with 22P02.
    const client = await freshDatabase('ppbf_test_cpp_publication');
    try {
      await client.query(migrationSql);

      const inserted = await client.query<{ publication_id: string; tags: string[] }>(
        PUBLICATION_INSERT,
        [
          'pub-1', 'org-a', 'vid-1', 'ath-1', 'coach-a',
          'research_library', 'Jab mechanics', 'Session review', ['jab', 'footwork'],
        ],
      );
      expect(inserted.rows[0].tags).toEqual(['jab', 'footwork']);

      const empty = await client.query<{ tags: string[] }>(
        PUBLICATION_INSERT,
        [
          'pub-2', 'org-a', 'vid-1', 'ath-1', 'coach-a',
          'private_archive', 'Untagged', '', [],
        ],
      );
      expect(empty.rows[0].tags).toEqual([]);
    } finally {
      await client.end();
    }
  });

  test('a JSON-encoded tags value is still rejected -- the defect cannot silently return', async () => {
    const client = await freshDatabase('ppbf_test_cpp_tags_guard');
    try {
      await client.query(migrationSql);

      await expect(client.query(PUBLICATION_INSERT, [
        'pub-3', 'org-a', 'vid-1', 'ath-1', 'coach-a',
        'research_library', 'Bad tags', '', JSON.stringify(['jab']),
      ])).rejects.toThrow(/malformed array literal/);
    } finally {
      await client.end();
    }
  });

  test('compliance and progression rows insert against the ported shapes', async () => {
    const client = await freshDatabase('ppbf_test_cpp_rows');
    try {
      await client.query(migrationSql);

      await client.query(
        `insert into pilot.compliance_violations
           (violation_id, organization_id, rule_id, athlete_id, detected_by_account_id, violation_timestamp, severity)
         select 'vio-1', 'org-a', rule_id, 'ath-1', 'coach-a', now(), 'critical'
         from pilot.compliance_rules where organization_id = 'org-a' limit 1`,
      );
      await client.query(
        `insert into pilot.progression_gaps
           (gap_id, organization_id, athlete_id, coach_account_id, gap_type, gap_description, detected_from)
         values ('gap-1', 'org-a', 'ath-1', 'coach-a', 'technique', 'Guard drops after the jab', 'coach_review')`,
      );
      await client.query(
        `insert into pilot.drill_assignments
           (assignment_id, organization_id, gap_id, athlete_id, assigned_by_account_id, drill_name, drill_description)
         values ('asn-1', 'org-a', 'gap-1', 'ath-1', 'coach-a', 'Return-to-guard reps', 'Ten rounds of jab-return')`,
      );

      const counts = await client.query<{ violations: string; gaps: string; assignments: string }>(
        `select
           (select count(*) from pilot.compliance_violations) as violations,
           (select count(*) from pilot.progression_gaps) as gaps,
           (select count(*) from pilot.drill_assignments) as assignments`,
      );
      expect(counts.rows[0]).toEqual({ violations: '1', gaps: '1', assignments: '1' });
    } finally {
      await client.end();
    }
  });

  test('an athlete from another organization cannot be referenced', async () => {
    // The composite (organization_id, athlete_id) foreign key is what keeps a
    // violation, gap, or publication inside the tenant that owns the athlete.
    const client = await freshDatabase('ppbf_test_cpp_tenancy');
    try {
      await client.query(migrationSql);

      await expect(client.query(
        `insert into pilot.progression_gaps
           (gap_id, organization_id, athlete_id, coach_account_id, gap_type, gap_description, detected_from)
         values ('gap-x', 'org-b', 'ath-1', 'coach-a', 'technique', 'Cross-tenant', 'coach_review')`,
      )).rejects.toThrow(/violates foreign key constraint/);
    } finally {
      await client.end();
    }
  });

  test('re-running is idempotent and does not duplicate the seeded rules', async () => {
    // The workflow re-runs the whole `all` list against every environment, so
    // a second application has to be a no-op.
    const client = await freshDatabase('ppbf_test_cpp_idempotent');
    try {
      await client.query(migrationSql);
      const first = await client.query<{ count: string }>('select count(*) from pilot.compliance_rules');

      await client.query(migrationSql);
      await client.query(migrationSql);
      const third = await client.query<{ count: string }>('select count(*) from pilot.compliance_rules');

      expect(Number(first.rows[0].count)).toBeGreaterThan(0);
      expect(third.rows[0].count).toBe(first.rows[0].count);

      const perOrg = await client.query<{ organization_id: string; count: string }>(
        `select organization_id, count(*) from pilot.compliance_rules group by organization_id order by organization_id`,
      );
      expect(perOrg.rows.map((r) => r.organization_id)).toEqual(['org-a', 'org-b']);
      expect(new Set(perOrg.rows.map((r) => r.count)).size).toBe(1);
    } finally {
      await client.end();
    }
  });

  test("the runner's own readiness query passes against a migrated database", async () => {
    // The runner refuses to COMMIT unless every column of this query comes
    // back true, so a readiness check that drifted from the SQL would block
    // every future migration run. The query is lifted out of the runner as
    // text rather than imported: the script is an ESM module with top-level
    // await, which this test environment cannot require.
    const client = await freshDatabase('ppbf_test_cpp_readiness');
    try {
      await client.query(migrationSql);

      const runnerSource = await fs.readFile(
        path.resolve(__dirname, '../../../scripts/pilot-apply-compliance-progression-publication-migration.mjs'),
        'utf8',
      );
      const readinessQuery = runnerSource.match(/const READINESS_QUERY = `([\s\S]*?)`;/)?.[1];
      expect(readinessQuery).toBeTruthy();

      const readiness = await client.query(readinessQuery as string);
      expect(Object.values(readiness.rows[0])).not.toContain(false);
      expect(Object.values(readiness.rows[0]).length).toBeGreaterThan(0);
    } finally {
      await client.end();
    }
  });

  test('the readiness query FAILS on a database that never got the migration', async () => {
    // Otherwise an all-true result would prove nothing.
    const client = await freshDatabase('ppbf_test_cpp_readiness_negative');
    try {
      const runnerSource = await fs.readFile(
        path.resolve(__dirname, '../../../scripts/pilot-apply-compliance-progression-publication-migration.mjs'),
        'utf8',
      );
      const readinessQuery = runnerSource.match(/const READINESS_QUERY = `([\s\S]*?)`;/)?.[1] as string;

      const readiness = await client.query(readinessQuery);
      expect(Object.values(readiness.rows[0])).toContain(false);
    } finally {
      await client.end();
    }
  });
});
