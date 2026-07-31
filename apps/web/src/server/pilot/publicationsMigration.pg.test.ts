// Real PostgreSQL-backed contract test for the publications migration.
//
// Three things need proving, and none can be proven by reading SQL:
//
// 1. It CREATES the schema from nothing. That is the whole point -- these
//    three tables were reachable only through /api/pilot/admin/migrate-multiorg,
//    a bootstrap-key HTTP route, so a rebuilt environment had no way to get
//    them and /coach/video-publications failed at the database.
//
// 2. It is a NO-OP against a database that already has them. The sibling
//    compliance tables are proven to exist in production, so these very
//    likely do too. The migration must apply over a live install and leave
//    the rows untouched.
//
// 3. It matches the legacy route's DDL. If the two ever diverge, an
//    environment built by migration behaves differently from one built by the
//    route, which is worse than the gap being fixed. The legacy DDL is
//    reproduced here from the route and applied FIRST in the no-op case, so
//    drift shows up as a failure in this file.
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
const DATA_DIR = path.join(os.tmpdir(), `ppbf-publications-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const MIGRATION_FILE = 'pilot_slice_postgres_publications_migration.sql';

const ORG_ID = 'org-pub';
const COACH_ID = 'acct-pub-coach';
const ATHLETE_ID = 'ATH-PUB-1';

// Verbatim from app/api/pilot/admin/migrate-multiorg/route.ts. Copied rather
// than imported because it lives inside a Next route handler as an array of
// template strings; if the route's DDL ever changes, the no-op test below
// stops matching and the divergence surfaces here.
const LEGACY_DDL = [
  `create table if not exists pilot.video_publications (
    publication_id text primary key,
    organization_id text not null references pilot.organizations(organization_id),
    video_session_id text not null references pilot.video_sessions(video_session_id) on delete cascade,
    athlete_id text not null,
    submitted_by_account_id text not null references pilot.accounts(account_id),
    publication_type text not null check (publication_type in ('research_library', 'public_coaching', 'private_archive')),
    title text not null,
    description text not null,
    tags text[] not null default '{}'::text[],
    approved_by_account_id text null references pilot.accounts(account_id),
    compliance_check_status text not null default 'pending' check (compliance_check_status in ('pending', 'passed', 'failed', 'manual_review')),
    metadata_complete boolean not null default false,
    visibility text not null default 'private' check (visibility in ('private', 'organization', 'public', 'research')),
    published_at timestamptz null,
    archived_at timestamptz null,
    status text not null default 'draft' check (status in ('draft', 'pending_review', 'approved', 'published', 'rejected', 'archived')),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint pilot_video_publications_fk_athlete foreign key (organization_id, athlete_id) references pilot.athletes(organization_id, athlete_id) on delete cascade
  )`,
  `create table if not exists pilot.publication_checks (
    check_id text primary key,
    organization_id text not null references pilot.organizations(organization_id),
    publication_id text not null references pilot.video_publications(publication_id) on delete cascade,
    check_type text not null check (check_type in ('compliance', 'safety', 'metadata', 'consent', 'legal')),
    check_status text not null check (check_status in ('passed', 'failed', 'warning', 'manual_review')),
    details text not null,
    checked_by_account_id text null references pilot.accounts(account_id),
    checked_at timestamptz null,
    created_at timestamptz not null default now()
  )`,
  `create table if not exists pilot.research_library (
    library_id text primary key,
    organization_id text not null references pilot.organizations(organization_id),
    publication_id text not null references pilot.video_publications(publication_id) on delete cascade,
    video_session_id text not null references pilot.video_sessions(video_session_id),
    title text not null,
    description text not null,
    tags text[] not null default '{}'::text[],
    view_count integer not null default 0,
    citation_count integer not null default 0,
    last_accessed_at timestamptz null,
    published_at timestamptz not null default now(),
    archived_at timestamptz null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
  )`,
  `create index if not exists idx_video_publications_status on pilot.video_publications(organization_id, status, created_at desc)`,
  `create index if not exists idx_research_library_published on pilot.research_library(organization_id, published_at desc)`,
  `create index if not exists idx_research_library_tags on pilot.research_library(organization_id, tags)`,
];

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let migrationSql: string;
let baseSchemaSql: string;
let videoSessionsSql: string;

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

/** Fresh database with the base schema and the org/coach/athlete rows the FKs need. */
async function freshDatabase(name: string): Promise<Client> {
  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  await admin.query(`drop database if exists ${name}`);
  await admin.query(`create database ${name}`);
  await admin.end();

  const client = new Client({ connectionString: connectionStringFor(name) });
  await client.connect();
  await client.query(baseSchemaSql);
  await client.query(videoSessionsSql);
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
     values ($1, $2, 'Publications Athlete', '2011-05-06', 'fly', 'active', 'contact', true, $3, now(), now())`,
    [ORG_ID, ATHLETE_ID, COACH_ID],
  );
  return client;
}

async function insertPublication(client: Client, publicationId: string): Promise<void> {
  await client.query(
    `insert into pilot.video_sessions
       (video_session_id, organization_id, uploaded_by_account_id, athlete_id, title, notes,
        blob_path, file_name, file_size_bytes, mime_type, status, created_at, updated_at)
     values ('vs-pub-1', $1, $2, $3, 'Session tape', '', $1 || '/vs-pub-1.mp4', 'tape.mp4', 1024, 'video/mp4', 'ready', now(), now())
     on conflict do nothing`,
    [ORG_ID, COACH_ID, ATHLETE_ID],
  );
  await client.query(
    `insert into pilot.video_publications
       (publication_id, organization_id, video_session_id, athlete_id, submitted_by_account_id,
        publication_type, title, description)
     values ($1, $2, 'vs-pub-1', $3, $4, 'research_library', 'Jab mechanics', 'Six rounds of jab work.')`,
    [publicationId, ORG_ID, ATHLETE_ID, COACH_ID],
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

  baseSchemaSql = await fs.readFile(path.join(INFRA_DIR, 'pilot_slice_postgres.sql'), 'utf8');
  // video_publications and research_library both carry `references
  // pilot.video_sessions(...)`, and
  // video_sessions is NOT in the base schema -- it became migration-owned only
  // in #125. Without it the FK cannot resolve, which is exactly why the `all`
  // loop orders video-sessions ahead of publications.
  videoSessionsSql = await fs.readFile(
    path.join(INFRA_DIR, 'pilot_slice_postgres_video_sessions_migration.sql'), 'utf8');
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

describe('publications migration against real Postgres', () => {
  test('the gap is real: without the migration the tables do not exist', async () => {
    const client = await freshDatabase('ppbf_test_pub_absent');
    try {
      const row = await client.query(`select to_regclass('pilot.video_publications') as t`);
      expect(row.rows[0].t).toBeNull();
    } finally {
      await client.end();
    }
  });

  test('a fresh install creates all three tables and all three indexes', async () => {
    const client = await freshDatabase('ppbf_test_pub_fresh');
    try {
      await client.query(migrationSql);

      for (const table of ['video_publications', 'publication_checks', 'research_library']) {
        const row = await client.query(`select to_regclass($1) as t`, [`pilot.${table}`]);
        expect(row.rows[0].t).not.toBeNull();
      }

      const indexes = await client.query(
        `select indexname from pg_indexes
         where schemaname = 'pilot'
           and tablename in ('video_publications', 'research_library')`,
      );
      const names = indexes.rows.map((r: { indexname: string }) => r.indexname);
      expect(names).toContain('idx_video_publications_status');
      expect(names).toContain('idx_research_library_published');
      expect(names).toContain('idx_research_library_tags');
    } finally {
      await client.end();
    }
  });

  test('the real read path works after the migration', async () => {
    // publication.ts joins publications to checks and the research library;
    // a table that exists but rejects the app's own insert is still broken.
    const client = await freshDatabase('ppbf_test_pub_readpath');
    try {
      await client.query(migrationSql);
      await insertPublication(client, 'pub-1');
      await client.query(
        `insert into pilot.publication_checks
           (check_id, organization_id, publication_id, check_type, check_status, details)
         values ('chk-1', $1, 'pub-1', 'consent', 'passed', 'Guardian consent on file.')`,
        [ORG_ID],
      );
      await client.query(
        `insert into pilot.research_library
           (library_id, organization_id, publication_id, video_session_id, title, description)
         values ('lib-1', $1, 'pub-1', 'vs-pub-1', 'Jab mechanics', 'Six rounds of jab work.')`,
        [ORG_ID],
      );

      const joined = await client.query(
        `select p.publication_id, c.check_status, l.library_id
         from pilot.video_publications p
         join pilot.publication_checks c on c.publication_id = p.publication_id
         join pilot.research_library l on l.publication_id = p.publication_id
         where p.organization_id = $1`,
        [ORG_ID],
      );
      expect(joined.rows).toHaveLength(1);
      expect(joined.rows[0].check_status).toBe('passed');
    } finally {
      await client.end();
    }
  });

  test('NO-OP: applies cleanly over the legacy route-created tables and keeps their rows', async () => {
    const client = await freshDatabase('ppbf_test_pub_legacy');
    try {
      for (const statement of LEGACY_DDL) await client.query(statement);
      await insertPublication(client, 'pub-legacy');

      await client.query(migrationSql);

      const row = await client.query(
        `select publication_id, title, status, visibility from pilot.video_publications where publication_id = 'pub-legacy'`,
      );
      expect(row.rows).toHaveLength(1);
      expect(row.rows[0].title).toBe('Jab mechanics');
      expect(row.rows[0].status).toBe('draft');
      expect(row.rows[0].visibility).toBe('private');
    } finally {
      await client.end();
    }
  });

  test('NO-OP: the legacy install and a fresh install agree on columns and constraints', async () => {
    // Drift between the two would mean an environment built by migration
    // behaves differently from one built by the route -- worse than the gap
    // this migration closes.
    const legacy = await freshDatabase('ppbf_test_pub_shape_legacy');
    const fresh = await freshDatabase('ppbf_test_pub_shape_fresh');
    try {
      for (const statement of LEGACY_DDL) await legacy.query(statement);
      await fresh.query(migrationSql);

      const columnQuery = `
        select table_name, column_name, data_type, is_nullable, column_default
        from information_schema.columns
        where table_schema = 'pilot'
          and table_name in ('video_publications', 'publication_checks', 'research_library')
        order by table_name, column_name`;
      const constraintQuery = `
        select conrelid::regclass::text as tbl, conname, pg_get_constraintdef(oid) as def
        from pg_constraint
        where connamespace = 'pilot'::regnamespace
          and conrelid::regclass::text in ('pilot.video_publications', 'pilot.publication_checks', 'pilot.research_library')
        order by tbl, conname`;

      expect((await fresh.query(columnQuery)).rows).toEqual((await legacy.query(columnQuery)).rows);
      expect((await fresh.query(constraintQuery)).rows).toEqual((await legacy.query(constraintQuery)).rows);
    } finally {
      await legacy.end();
      await fresh.end();
    }
  });

  test('re-running is idempotent', async () => {
    const client = await freshDatabase('ppbf_test_pub_idempotent');
    try {
      await client.query(migrationSql);
      await insertPublication(client, 'pub-keep');
      await client.query(migrationSql);
      await client.query(migrationSql);

      const row = await client.query(`select count(*)::int as n from pilot.video_publications`);
      expect(row.rows[0].n).toBe(1);
    } finally {
      await client.end();
    }
  });

  test('the athlete foreign key is real: an unknown athlete cannot be published', async () => {
    const client = await freshDatabase('ppbf_test_pub_fk');
    try {
      await client.query(migrationSql);
      await client.query(
        `insert into pilot.video_sessions
           (video_session_id, organization_id, uploaded_by_account_id, athlete_id, title, notes,
            blob_path, file_name, file_size_bytes, mime_type, status, created_at, updated_at)
         values ('vs-fk', $1, $2, $3, 't', '', 'p', 'f.mp4', 1, 'video/mp4', 'ready', now(), now())`,
        [ORG_ID, COACH_ID, ATHLETE_ID],
      );
      await expect(
        client.query(
          `insert into pilot.video_publications
             (publication_id, organization_id, video_session_id, athlete_id, submitted_by_account_id,
              publication_type, title, description)
           values ('pub-x', $1, 'vs-fk', 'ATH-NOT-REAL', $2, 'private_archive', 't', 'd')`,
          [ORG_ID, COACH_ID],
        ),
      ).rejects.toThrow(/pilot_video_publications_fk_athlete|foreign key/);
    } finally {
      await client.end();
    }
  });

  test('deleting a publication cascades to its checks and library entry', async () => {
    // Both children declare `on delete cascade`; losing that in a rewrite
    // would strand rows referencing a publication that no longer exists.
    const client = await freshDatabase('ppbf_test_pub_cascade');
    try {
      await client.query(migrationSql);
      await insertPublication(client, 'pub-c');
      await client.query(
        `insert into pilot.publication_checks
           (check_id, organization_id, publication_id, check_type, check_status, details)
         values ('chk-c', $1, 'pub-c', 'safety', 'passed', 'ok')`,
        [ORG_ID],
      );
      await client.query(
        `insert into pilot.research_library
           (library_id, organization_id, publication_id, video_session_id, title, description)
         values ('lib-c', $1, 'pub-c', 'vs-pub-1', 't', 'd')`,
        [ORG_ID],
      );

      await client.query(`delete from pilot.video_publications where publication_id = 'pub-c'`);

      const checks = await client.query(`select count(*)::int as n from pilot.publication_checks`);
      const library = await client.query(`select count(*)::int as n from pilot.research_library`);
      expect(checks.rows[0].n).toBe(0);
      expect(library.rows[0].n).toBe(0);
    } finally {
      await client.end();
    }
  });
});
