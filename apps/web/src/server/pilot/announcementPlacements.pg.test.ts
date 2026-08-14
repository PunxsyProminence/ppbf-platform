// Real PostgreSQL-backed contract test for the announcement placements
// migration.
//
// Two things need proving, and neither can be proven by reading SQL:
//
// 1. The columns are genuinely absent beforehand. pilot.announcements exists in
//    every environment, so any check that only asks whether the table is there
//    passes with or without this migration. The first test therefore runs a
//    placement-filtered read against an unmigrated database and requires it to
//    FAIL -- if that ever starts passing, the rest of this file is measuring
//    nothing.
//
// 2. Rows written before the migration keep working. Without a placement, Gym
//    Notices is the only surface a row can reach, so every such row IS a
//    visible gym notice and the defaults have to say so: a row inserted in the
//    five-column shape must still come back from a read filtered on placement,
//    kind and active. That case inserts first and migrates second, in that
//    order, because doing it the other way round would only test the column
//    defaults on a fresh insert.
//
// Spins up the same disposable, local-only embedded Postgres the other
// migration suites use. It NEVER connects to production or staging.

import { type ChildProcessByStdio, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
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
const DATA_DIR = path.join(os.tmpdir(), `ppbf-placements-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const MIGRATION_FILE = 'pilot_slice_postgres_announcement_placements_migration.sql';

const ORG_ID = 'org-placement';
const OTHER_ORG_ID = 'org-placement-other';

// The read path the new index exists for: one organization's items for one
// surface, of one kind, still active and inside their window, newest first.
// 'everywhere' is included by every surface.
const READ_PATH_SQL = `
  select announcement_id, message, placement, kind
  from pilot.announcements
  where organization_id = $1
    and placement in ($2, 'everywhere')
    and kind = $3
    and active
    and (starts_at is null or starts_at <= now())
    and (ends_at is null or ends_at > now())
  order by created_at desc`;

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let migrationSql: string;
let baseSchemaSql: string;
let announcementsSql: string;

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
 * Fresh database in the state every environment is already in: base schema,
 * pilot.announcements in its five-column shape, and the organizations its
 * foreign key needs. This migration is NOT applied here -- each test decides
 * when to apply it.
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
  await client.query(announcementsSql);
  for (const orgId of [ORG_ID, OTHER_ORG_ID]) {
    await client.query(
      `insert into pilot.organizations (organization_id, organization_name, status)
       values ($1, $1, 'active') on conflict do nothing`,
      [orgId],
    );
  }
  return client;
}

/** Insert in the pre-migration column shape -- no placement, kind or window. */
async function insertLegacyAnnouncement(client: Client, message: string): Promise<string> {
  const announcementId = randomUUID();
  await client.query(
    `insert into pilot.announcements
       (organization_id, announcement_id, message, author_name, author_role)
     values ($1, $2, $3, 'Coach Ruiz', 'coach')`,
    [ORG_ID, announcementId, message],
  );
  return announcementId;
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
  // pilot.announcements is not in the base schema; its own migration creates
  // it, which is why the `all` loop orders announcements ahead of this file.
  announcementsSql = await fs.readFile(
    path.join(INFRA_DIR, 'pilot_slice_postgres_announcements_migration.sql'), 'utf8');
  // Like the announcements runner, this runner opens the transaction itself,
  // so the file applies here as plain statements exactly as the runner sends it.
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

describe('announcement placements migration against real Postgres', () => {
  test('the gap is real: without the migration a placement-filtered read fails', async () => {
    const client = await freshDatabase('ppbf_test_placement_absent');
    try {
      // The table is there either way, so its presence proves nothing.
      const table = await client.query(`select to_regclass('pilot.announcements') as t`);
      expect(table.rows[0].t).not.toBeNull();

      await expect(
        client.query(READ_PATH_SQL, [ORG_ID, 'gym_notices', 'notice']),
      ).rejects.toThrow(/placement/);
    } finally {
      await client.end();
    }
  });

  test('a row written before the migration is still a visible gym notice after it', async () => {
    const client = await freshDatabase('ppbf_test_placement_backfill');
    try {
      const legacyId = await insertLegacyAnnouncement(client, 'Gym closed Friday for ring maintenance.');

      await client.query(migrationSql);

      const row = await client.query(
        `select message, author_name, author_role, placement, kind, active, starts_at, ends_at
         from pilot.announcements
         where organization_id = $1 and announcement_id = $2`,
        [ORG_ID, legacyId],
      );
      expect(row.rows).toHaveLength(1);
      expect(row.rows[0]).toMatchObject({
        message: 'Gym closed Friday for ring maintenance.',
        author_name: 'Coach Ruiz',
        author_role: 'coach',
        placement: 'gym_notices',
        kind: 'notice',
        active: true,
        starts_at: null,
        ends_at: null,
      });

      const read = await client.query(READ_PATH_SQL, [ORG_ID, 'gym_notices', 'notice']);
      expect(read.rows.map((r: { announcement_id: string }) => r.announcement_id)).toEqual([legacyId]);
    } finally {
      await client.end();
    }
  });

  test('the migration adds the five columns, both constraints and the read-path index', async () => {
    const client = await freshDatabase('ppbf_test_placement_shape');
    try {
      await client.query(migrationSql);

      const columns = await client.query(
        `select column_name, is_nullable, column_default
         from information_schema.columns
         where table_schema = 'pilot' and table_name = 'announcements'
           and column_name in ('placement', 'kind', 'active', 'starts_at', 'ends_at')
         order by column_name`,
      );
      expect(columns.rows).toEqual([
        { column_name: 'active', is_nullable: 'NO', column_default: 'true' },
        { column_name: 'ends_at', is_nullable: 'YES', column_default: null },
        { column_name: 'kind', is_nullable: 'NO', column_default: "'notice'::text" },
        { column_name: 'placement', is_nullable: 'NO', column_default: "'gym_notices'::text" },
        { column_name: 'starts_at', is_nullable: 'YES', column_default: null },
      ]);

      const constraints = await client.query(
        `select conname from pg_constraint
         where conrelid = 'pilot.announcements'::regclass
         order by conname`,
      );
      const names = constraints.rows.map((r: { conname: string }) => r.conname);
      expect(names).toContain('pilot_announcements_placement_check');
      expect(names).toContain('pilot_announcements_kind_check');

      const indexes = await client.query(
        `select indexname from pg_indexes where schemaname = 'pilot' and tablename = 'announcements'`,
      );
      const indexNames = indexes.rows.map((r: { indexname: string }) => r.indexname);
      expect(indexNames).toContain('idx_pilot_announcements_org_placement_kind_active_created');
      // The organization-wide read keeps its own index.
      expect(indexNames).toContain('idx_pilot_announcements_org_created');
    } finally {
      await client.end();
    }
  });

  test('every surface and kind this migration defines is accepted, and nothing else is', async () => {
    const client = await freshDatabase('ppbf_test_placement_vocabulary');
    try {
      await client.query(migrationSql);

      for (const placement of ['gym_notices', 'athlete_workspace', 'coach_workspace', 'everywhere']) {
        await client.query(
          `insert into pilot.announcements
             (organization_id, announcement_id, message, author_name, author_role, placement)
           values ($1, $2, $3, 'Admin', 'admin', $4)`,
          [ORG_ID, randomUUID(), `Notice for ${placement}`, placement],
        );
      }
      for (const kind of ['notice', 'motivation']) {
        await client.query(
          `insert into pilot.announcements
             (organization_id, announcement_id, message, author_name, author_role, kind)
           values ($1, $2, $3, 'Admin', 'admin', $4)`,
          [ORG_ID, randomUUID(), `Item of kind ${kind}`, kind],
        );
      }

      // An unrecognized placement renders on no surface at all, so the write
      // is refused rather than accepted and silently invisible.
      await expect(
        client.query(
          `insert into pilot.announcements
             (organization_id, announcement_id, message, author_name, author_role, placement)
           values ($1, $2, 'Nowhere', 'Admin', 'admin', 'lobby_tv')`,
          [ORG_ID, randomUUID()],
        ),
      ).rejects.toThrow(/pilot_announcements_placement_check/);

      await expect(
        client.query(
          `insert into pilot.announcements
             (organization_id, announcement_id, message, author_name, author_role, kind)
           values ($1, $2, 'Unknown kind', 'Admin', 'admin', 'advertisement')`,
          [ORG_ID, randomUUID()],
        ),
      ).rejects.toThrow(/pilot_announcements_kind_check/);
    } finally {
      await client.end();
    }
  });

  test('the read path filters by surface, kind, retirement and schedule', async () => {
    const client = await freshDatabase('ppbf_test_placement_readpath');
    try {
      await client.query(migrationSql);

      const insert = async (values: {
        message: string;
        placement: string;
        kind: string;
        active?: boolean;
        startsAt?: string | null;
        endsAt?: string | null;
        organizationId?: string;
      }) => {
        await client.query(
          `insert into pilot.announcements
             (organization_id, announcement_id, message, author_name, author_role,
              placement, kind, active, starts_at, ends_at)
           values ($1, $2, $3, 'Coach Ruiz', 'coach', $4, $5, $6, $7, $8)`,
          [
            values.organizationId ?? ORG_ID,
            randomUUID(),
            values.message,
            values.placement,
            values.kind,
            values.active ?? true,
            values.startsAt ?? null,
            values.endsAt ?? null,
          ],
        );
      };

      await insert({ message: 'Hands up, chin down.', placement: 'athlete_workspace', kind: 'motivation' });
      await insert({ message: 'Everywhere motivation.', placement: 'everywhere', kind: 'motivation' });
      await insert({ message: 'Coach-only reminder.', placement: 'coach_workspace', kind: 'motivation' });
      await insert({ message: 'Athlete notice, not motivation.', placement: 'athlete_workspace', kind: 'notice' });
      await insert({ message: 'Retired line.', placement: 'athlete_workspace', kind: 'motivation', active: false });
      await insert({
        message: 'Tournament week only.',
        placement: 'athlete_workspace',
        kind: 'motivation',
        startsAt: '2099-01-01T00:00:00Z',
      });
      await insert({
        message: 'Last season.',
        placement: 'athlete_workspace',
        kind: 'motivation',
        endsAt: '2020-01-01T00:00:00Z',
      });
      await insert({
        message: 'Another gym entirely.',
        placement: 'athlete_workspace',
        kind: 'motivation',
        organizationId: OTHER_ORG_ID,
      });

      const rows = await client.query(READ_PATH_SQL, [ORG_ID, 'athlete_workspace', 'motivation']);
      expect(rows.rows.map((r: { message: string }) => r.message).sort()).toEqual([
        'Everywhere motivation.',
        'Hands up, chin down.',
      ]);

      // Retiring an item leaves the record in place.
      const retired = await client.query(
        `select count(*)::int as n from pilot.announcements
         where organization_id = $1 and active = false`,
        [ORG_ID],
      );
      expect(retired.rows[0].n).toBe(1);
    } finally {
      await client.end();
    }
  });

  test('re-running is idempotent and does not reset a chosen placement', async () => {
    const client = await freshDatabase('ppbf_test_placement_idempotent');
    try {
      const legacyId = await insertLegacyAnnouncement(client, 'Bags arrive Monday.');
      await client.query(migrationSql);

      const authoredId = randomUUID();
      await client.query(
        `insert into pilot.announcements
           (organization_id, announcement_id, message, author_name, author_role, placement, kind, active)
         values ($1, $2, 'Work the jab.', 'Coach Ruiz', 'coach', 'coach_workspace', 'motivation', false)`,
        [ORG_ID, authoredId],
      );

      await client.query(migrationSql);
      await client.query(migrationSql);

      const rows = await client.query(
        `select announcement_id, placement, kind, active from pilot.announcements
         where organization_id = $1 order by announcement_id`,
        [ORG_ID],
      );
      expect(rows.rows).toHaveLength(2);
      expect(rows.rows.find((r: { announcement_id: string }) => r.announcement_id === legacyId))
        .toMatchObject({ placement: 'gym_notices', kind: 'notice', active: true });
      expect(rows.rows.find((r: { announcement_id: string }) => r.announcement_id === authoredId))
        .toMatchObject({ placement: 'coach_workspace', kind: 'motivation', active: false });
    } finally {
      await client.end();
    }
  });
});
