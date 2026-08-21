// Real PostgreSQL-backed contract test for the drills migration.
//
// A drill has never had an identity. pilot.drill_assignments stores drill_name
// and drill_description as free text with no foreign key, so two coaches
// assigning the same drill produce two unrelated strings, and the athlete drill
// library is three rows hardcoded in a useState initializer in
// apps/web/components/athlete/AthleteWorkspace.tsx.
//
// Five things need proving, and none can be proven by reading SQL:
//
// 1. The database, not application code, refuses a second drill of the same
//    name in one gym. Two concurrent creates each read no existing row and both
//    write, so a check in TypeScript loses that race by construction -- and the
//    duplicate it admits is exactly the ambiguous anchor this table exists to
//    remove.
//
// 2. The legacy path still works. Every assignment written before this
//    migration carries free text and no drill_id, and all of them must keep
//    inserting, reading and updating untouched.
//
// 3. The anchor is organization-scoped. The foreign key is composite, so one
//    gym's assignment cannot reference another gym's drill -- these are minors'
//    training records and the org boundary is not advisory.
//
// 4. Deleting a drill cannot reach assignment history, and a rename cannot
//    rewrite what a coach actually typed on the day.
//
// 5. The runner's readiness check actually fails when the migration did not
//    land. An all-green suite whose readiness passes on an unmigrated database
//    proves nothing, so that case -- and the cases where only the unique-name
//    index or only the assignment column is missing -- are asserted directly
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
const DATA_DIR = path.join(os.tmpdir(), `ppbf-drills-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const MIGRATION_FILE = 'pilot_slice_postgres_drills_migration.sql';
const MIGRATION_RUNNER_PATH = path.resolve(
  __dirname,
  '../../../scripts/pilot-apply-drills-migration.mjs',
);

const ORG_A = 'org-drills-a';
const ORG_B = 'org-drills-b';
const COACH_A = 'acct-drills-coach-a';
const COACH_B = 'acct-drills-coach-b';
const ATHLETE_A = 'ATH-DRILLS-A';
const ATHLETE_B = 'ATH-DRILLS-B';
const GAP_A = 'gap-drills-a';
const GAP_B = 'gap-drills-b';

// The vocabulary pilot.drill_assignments.drill_difficulty already carries. A
// drill's difficulty and the difficulty recorded on an assignment of it have to
// be one vocabulary or the anchor answers a different question than the
// assignment does.
const DIFFICULTIES = ['beginner', 'intermediate', 'advanced', 'elite'] as const;

// The library read: one gym's drills that are still taught.
const ACTIVE_LIBRARY_SQL = `
  select drill_id, name, category, focus, cues, difficulty
  from pilot.drills
  where organization_id = $1 and active
  order by category, name`;

// The read free text could never serve: every assignment of one drill.
const ASSIGNMENTS_OF_DRILL_SQL = `
  select assignment_id, drill_name
  from pilot.drill_assignments
  where organization_id = $1 and drill_id = $2
  order by assignment_id`;

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
let progressionSql: string;
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
 * Fresh database with the base schema, the progression tables this migration
 * ALTERs, two organizations, and the coaches, athletes and gaps the foreign
 * keys need. This migration is NOT applied here -- each test decides when to
 * apply it.
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
  // Without this there is no pilot.drill_assignments for drill_id to land on.
  await client.query(progressionSql);

  const orgs: Array<[string, string, string, string]> = [
    [ORG_A, COACH_A, ATHLETE_A, GAP_A],
    [ORG_B, COACH_B, ATHLETE_B, GAP_B],
  ];
  for (const [organizationId, coachId, athleteId, gapId] of orgs) {
    await client.query(
      `insert into pilot.organizations (organization_id, organization_name, status)
       values ($1, $1, 'active') on conflict do nothing`,
      [organizationId],
    );
    await client.query(
      `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
       values ($1, 'coach', $2, 'microsoft') on conflict do nothing`,
      [coachId, organizationId],
    );
    await client.query(
      `insert into pilot.athletes
         (organization_id, athlete_id, full_name, dob, weight_class, gym_status,
          emergency_contact, active_flag, coach_id, created_at, updated_at)
       values ($1, $2, 'Drills Athlete', '2011-05-06', 'fly', 'active', 'contact', true, $3, now(), now())`,
      [organizationId, athleteId, coachId],
    );
    await client.query(
      `insert into pilot.progression_gaps
         (gap_id, organization_id, athlete_id, coach_account_id, gap_type, gap_description, detected_from)
       values ($1, $2, $3, $4, 'technique', 'Guard drops after the jab.', 'coach_observation')`,
      [gapId, organizationId, athleteId, coachId],
    );
  }
  return client;
}

async function insertDrill(
  client: Client,
  values: {
    organizationId?: string;
    drillId: string;
    name: string;
    category?: string;
    focus?: string;
    cues?: string[];
    difficulty?: string;
    active?: boolean;
  },
): Promise<void> {
  await client.query(
    `insert into pilot.drills
       (organization_id, drill_id, name, category, focus, cues, difficulty, active)
     values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      values.organizationId ?? ORG_A,
      values.drillId,
      values.name,
      values.category ?? 'Striking',
      values.focus ?? 'Quick fist return to protect chin and guard stance.',
      values.cues ?? ['Elbow tucked', 'Snap fist on contact'],
      values.difficulty ?? 'intermediate',
      values.active ?? true,
    ],
  );
}

async function assignDrill(
  client: Client,
  values: {
    organizationId?: string;
    assignmentId: string;
    gapId?: string;
    athleteId?: string;
    assignedBy?: string;
    drillId?: string | null;
    drillName?: string;
    drillDescription?: string;
  },
): Promise<void> {
  await client.query(
    `insert into pilot.drill_assignments
       (assignment_id, organization_id, gap_id, athlete_id, assigned_by_account_id,
        drill_name, drill_description, drill_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      values.assignmentId,
      values.organizationId ?? ORG_A,
      values.gapId ?? GAP_A,
      values.athleteId ?? ATHLETE_A,
      values.assignedBy ?? COACH_A,
      values.drillName ?? 'Straight Jab Retraction Snap',
      values.drillDescription ?? 'Ten rounds of jab-and-return.',
      values.drillId ?? null,
    ],
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
  progressionSql = await fs.readFile(
    path.join(INFRA_DIR, 'pilot_slice_postgres_progression_migration.sql'), 'utf8');
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

describe('drills migration against real Postgres', () => {
  test('the gap is real: without the migration a drill has no record and no anchor', async () => {
    const client = await freshDatabase('ppbf_test_drills_absent');
    try {
      const table = await client.query(`select to_regclass('pilot.drills') as t`);
      expect(table.rows[0].t).toBeNull();

      await expect(client.query(ACTIVE_LIBRARY_SQL, [ORG_A])).rejects.toThrow(
        /drills|does not exist/,
      );
      // An assignment can only carry the typed string.
      await expect(
        client.query(`select drill_id from pilot.drill_assignments`),
      ).rejects.toThrow(/drill_id|does not exist/);
    } finally {
      await client.end();
    }
  });

  // NEGATIVE CONTROL. If readiness passed here, every other assertion in this
  // file would be worthless: the runner would commit an environment where the
  // migration silently did nothing.
  test('the readiness check REFUSES a database where the migration never ran', async () => {
    const client = await freshDatabase('ppbf_test_drills_readiness_negative');
    try {
      await expect(applyMigrationTransaction(client, 'select 1')).rejects.toThrow(
        /DRILLS_NOT_READY/,
      );

      const table = await client.query(`select to_regclass('pilot.drills') as t`);
      expect(table.rows[0].t).toBeNull();
    } finally {
      await client.end();
    }
  });

  // The readiness check has to measure the one-name-per-gym rule specifically.
  // A table-only check would pass on an environment that admits two drills of
  // the same name and therefore has no unambiguous anchor at all.
  test('the readiness check REFUSES a database whose unique-name index is missing', async () => {
    const client = await freshDatabase('ppbf_test_drills_readiness_index');
    try {
      await applyMigrationTransaction(client, migrationSql);
      await client.query('drop index pilot.pilot_drills_one_name_per_org');

      await expect(applyMigrationTransaction(client, 'select 1')).rejects.toThrow(
        /DRILLS_NOT_READY/,
      );

      // Re-running restores it, so a damaged environment is repaired rather
      // than left needing hand surgery.
      await applyMigrationTransaction(client, migrationSql);
      const { rows } = await client.query(
        `select indisunique, indpred is null as is_total
         from pg_index i
         join pg_class c on c.oid = i.indexrelid
         where c.relname = 'pilot_drills_one_name_per_org'`,
      );
      expect(rows).toEqual([{ indisunique: true, is_total: true }]);
    } finally {
      await client.end();
    }
  });

  // The regression that broke `apply-migrations migration=all` on both
  // environments. drill-versioning replaces this index with a PARTIAL unique
  // index of the same name, on purpose. This runner used to demand a TOTAL one,
  // so re-running `all` against any environment that had reached versioning
  // failed here forever -- and `create unique index if not exists` could not
  // put back the shape it was asking for.
  test('the readiness check ACCEPTS the partial index drill-versioning installs', async () => {
    const client = await freshDatabase('ppbf_test_drills_readiness_partial');
    try {
      await applyMigrationTransaction(client, migrationSql);

      // Exactly what the drill-versioning migration does to this index.
      await client.query('drop index pilot.pilot_drills_one_name_per_org');
      await client.query(
        `create unique index pilot_drills_one_name_per_org
           on pilot.drills(organization_id, name) where active`,
      );

      // Re-running must now be a no-op rather than a refusal.
      await expect(applyMigrationTransaction(client, 'select 1')).resolves.toBeUndefined();

      // And the partial index is still there -- re-running did not quietly
      // convert it back and re-break versioning.
      const { rows } = await client.query(
        `select indisunique, indpred is null as is_total
         from pg_index i
         join pg_class c on c.oid = i.indexrelid
         where c.relname = 'pilot_drills_one_name_per_org'`,
      );
      expect(rows).toEqual([{ indisunique: true, is_total: false }]);
    } finally {
      await client.end();
    }
  });

  // A non-unique index of the right name is still a refusal: the rule this
  // runner owns is uniqueness, and only the span of it moved.
  test('the readiness check REFUSES a same-named index that is not unique', async () => {
    const client = await freshDatabase('ppbf_test_drills_readiness_nonunique');
    try {
      await applyMigrationTransaction(client, migrationSql);
      await client.query('drop index pilot.pilot_drills_one_name_per_org');
      await client.query(
        'create index pilot_drills_one_name_per_org on pilot.drills(organization_id, name)',
      );

      await expect(applyMigrationTransaction(client, 'select 1')).rejects.toThrow(
        /DRILLS_NOT_READY/,
      );
    } finally {
      await client.end();
    }
  });

  // Half of this migration lands on pilot.drill_assignments. A database with
  // pilot.drills but no anchor column has the library and none of the point.
  test('the readiness check REFUSES a database whose assignment anchor is missing', async () => {
    const client = await freshDatabase('ppbf_test_drills_readiness_anchor');
    try {
      await applyMigrationTransaction(client, migrationSql);
      // Dropping the column takes its foreign key and index with it.
      await client.query('alter table pilot.drill_assignments drop column drill_id');

      await expect(applyMigrationTransaction(client, 'select 1')).rejects.toThrow(
        /DRILLS_NOT_READY/,
      );

      await applyMigrationTransaction(client, migrationSql);
      const { rows } = await client.query(
        `select conname, confdeltype, pg_get_constraintdef(oid) as def
         from pg_constraint
         where conrelid = 'pilot.drill_assignments'::regclass
           and conname = 'pilot_drill_assignments_fk_drill'`,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].confdeltype).toBe('r');
      expect(rows[0].def).toContain('(organization_id, drill_id)');
    } finally {
      await client.end();
    }
  });

  test('a drill inserts and reads back with its cues intact', async () => {
    const client = await freshDatabase('ppbf_test_drills_roundtrip');
    try {
      await applyMigrationTransaction(client, migrationSql);

      await insertDrill(client, {
        drillId: 'drill-slip-pivot',
        name: 'Slip and Lateral Pivot Step',
        category: 'Defense',
        focus: 'Move outside a straight punch while generating lateral counter angles.',
        cues: ['Slip with head off-center', 'Step 45-degrees', 'Maintain guard width'],
        difficulty: 'advanced',
      });

      const library = await client.query(ACTIVE_LIBRARY_SQL, [ORG_A]);
      expect(library.rows).toEqual([
        {
          drill_id: 'drill-slip-pivot',
          name: 'Slip and Lateral Pivot Step',
          category: 'Defense',
          focus: 'Move outside a straight punch while generating lateral counter angles.',
          cues: ['Slip with head off-center', 'Step 45-degrees', 'Maintain guard width'],
          difficulty: 'advanced',
        },
      ]);

      // A drill nobody has written cues for has no cues, not a NULL to render.
      await client.query(
        `insert into pilot.drills (organization_id, drill_id, name, category, focus)
         values ($1, 'drill-bare', 'Stance Width Stability', 'Footwork', 'Wide base under movement.')`,
        [ORG_A],
      );
      const bare = await client.query(
        `select cues, difficulty, active from pilot.drills where drill_id = 'drill-bare'`,
      );
      expect(bare.rows[0]).toEqual({ cues: [], difficulty: 'intermediate', active: true });
    } finally {
      await client.end();
    }
  });

  test('one gym cannot hold two drills of the same name', async () => {
    const client = await freshDatabase('ppbf_test_drills_name_unique');
    try {
      await applyMigrationTransaction(client, migrationSql);
      await insertDrill(client, { drillId: 'drill-jab-1', name: 'Straight Jab Retraction Snap' });

      // A different drill_id does not make it a different drill to a coach
      // looking for the one they already wrote.
      await expect(
        insertDrill(client, { drillId: 'drill-jab-2', name: 'Straight Jab Retraction Snap' }),
      ).rejects.toThrow(/pilot_drills_one_name_per_org|duplicate key/);

      // Renaming one drill onto another's name is the same violation.
      await insertDrill(client, { drillId: 'drill-slip', name: 'Slip and Lateral Pivot Step' });
      await expect(
        client.query(
          `update pilot.drills set name = 'Straight Jab Retraction Snap'
           where organization_id = $1 and drill_id = 'drill-slip'`,
          [ORG_A],
        ),
      ).rejects.toThrow(/pilot_drills_one_name_per_org|duplicate key/);
    } finally {
      await client.end();
    }
  });

  test('the same drill name in a different organization is fine', async () => {
    const client = await freshDatabase('ppbf_test_drills_cross_org_name');
    try {
      await applyMigrationTransaction(client, migrationSql);
      await insertDrill(client, { drillId: 'drill-jab-a', name: 'Straight Jab Retraction Snap' });
      await insertDrill(client, {
        organizationId: ORG_B,
        drillId: 'drill-jab-b',
        name: 'Straight Jab Retraction Snap',
      });

      const orgA = await client.query(ACTIVE_LIBRARY_SQL, [ORG_A]);
      const orgB = await client.query(ACTIVE_LIBRARY_SQL, [ORG_B]);
      expect(orgA.rows.map((row: { drill_id: string }) => row.drill_id)).toEqual(['drill-jab-a']);
      expect(orgB.rows.map((row: { drill_id: string }) => row.drill_id)).toEqual(['drill-jab-b']);

      // Each gym still gets exactly one of that name, independently.
      await expect(
        insertDrill(client, {
          organizationId: ORG_B,
          drillId: 'drill-jab-b2',
          name: 'Straight Jab Retraction Snap',
        }),
      ).rejects.toThrow(/pilot_drills_one_name_per_org|duplicate key/);
    } finally {
      await client.end();
    }
  });

  test('difficulty accepts the assignment vocabulary and nothing else', async () => {
    const client = await freshDatabase('ppbf_test_drills_difficulty');
    try {
      await applyMigrationTransaction(client, migrationSql);

      for (const difficulty of DIFFICULTIES) {
        await insertDrill(client, {
          drillId: `drill-${difficulty}`,
          name: `Drill ${difficulty}`,
          difficulty,
        });
      }
      const stored = await client.query(
        `select difficulty from pilot.drills where organization_id = $1 order by difficulty`,
        [ORG_A],
      );
      expect(stored.rows.map((row: { difficulty: string }) => row.difficulty))
        .toEqual([...DIFFICULTIES].sort());

      // A level the assignment column would refuse must not be storable here.
      await expect(
        insertDrill(client, { drillId: 'drill-expert', name: 'Drill expert', difficulty: 'expert' }),
      ).rejects.toThrow(/pilot_drills_difficulty_check/);
    } finally {
      await client.end();
    }
  });

  test('an assignment anchors to a drill, and the legacy free-text assignment still inserts', async () => {
    const client = await freshDatabase('ppbf_test_drills_assignment_anchor');
    try {
      await applyMigrationTransaction(client, migrationSql);
      await insertDrill(client, { drillId: 'drill-jab', name: 'Straight Jab Retraction Snap' });

      await assignDrill(client, { assignmentId: 'asg-anchored', drillId: 'drill-jab' });
      // Two coaches assigning the same drill now produce one anchor.
      await assignDrill(client, {
        assignmentId: 'asg-anchored-2',
        drillId: 'drill-jab',
        drillName: 'Jab snap-back',
      });
      // The path every assignment written before this migration takes.
      await assignDrill(client, { assignmentId: 'asg-legacy' });

      const anchored = await client.query(ASSIGNMENTS_OF_DRILL_SQL, [ORG_A, 'drill-jab']);
      expect(anchored.rows).toEqual([
        { assignment_id: 'asg-anchored', drill_name: 'Straight Jab Retraction Snap' },
        { assignment_id: 'asg-anchored-2', drill_name: 'Jab snap-back' },
      ]);

      const legacy = await client.query(
        `select drill_id, drill_name, drill_description, drill_difficulty, status
         from pilot.drill_assignments where assignment_id = 'asg-legacy'`,
      );
      expect(legacy.rows).toEqual([
        {
          drill_id: null,
          drill_name: 'Straight Jab Retraction Snap',
          drill_description: 'Ten rounds of jab-and-return.',
          drill_difficulty: 'intermediate',
          status: 'assigned',
        },
      ]);

      // A drill that does not exist is not an anchor.
      await expect(
        assignDrill(client, { assignmentId: 'asg-bad', drillId: 'drill-not-real' }),
      ).rejects.toThrow(/pilot_drill_assignments_fk_drill|foreign key/);
    } finally {
      await client.end();
    }
  });

  test('an assignment cannot anchor to another organization drill', async () => {
    const client = await freshDatabase('ppbf_test_drills_cross_org_anchor');
    try {
      await applyMigrationTransaction(client, migrationSql);
      await insertDrill(client, {
        organizationId: ORG_B,
        drillId: 'drill-b-only',
        name: 'Org B Only',
      });

      await expect(
        assignDrill(client, { assignmentId: 'asg-cross', drillId: 'drill-b-only' }),
      ).rejects.toThrow(/pilot_drill_assignments_fk_drill|foreign key/);

      // The same drill_id string is legal for the gym that owns it.
      await assignDrill(client, {
        organizationId: ORG_B,
        assignmentId: 'asg-b',
        gapId: GAP_B,
        athleteId: ATHLETE_B,
        assignedBy: COACH_B,
        drillId: 'drill-b-only',
      });
      const held = await client.query(ASSIGNMENTS_OF_DRILL_SQL, [ORG_B, 'drill-b-only']);
      expect(held.rows).toHaveLength(1);
    } finally {
      await client.end();
    }
  });

  test('deleting a drill cannot reach assignment history; retiring it is the way out', async () => {
    const client = await freshDatabase('ppbf_test_drills_delete_guard');
    try {
      await applyMigrationTransaction(client, migrationSql);
      await insertDrill(client, { drillId: 'drill-jab', name: 'Straight Jab Retraction Snap' });
      await insertDrill(client, { drillId: 'drill-unused', name: 'Never Assigned' });
      await assignDrill(client, { assignmentId: 'asg-history', drillId: 'drill-jab' });

      await expect(
        client.query(`delete from pilot.drills where organization_id = $1 and drill_id = 'drill-jab'`, [ORG_A]),
      ).rejects.toThrow(/pilot_drill_assignments_fk_drill|foreign key/);

      const survived = await client.query(ASSIGNMENTS_OF_DRILL_SQL, [ORG_A, 'drill-jab']);
      expect(survived.rows).toEqual([
        { assignment_id: 'asg-history', drill_name: 'Straight Jab Retraction Snap' },
      ]);

      // A gym stops teaching a drill by retiring it. The assignment keeps its
      // anchor, and the drill leaves the library.
      await client.query(
        `update pilot.drills set active = false, updated_at = now()
         where organization_id = $1 and drill_id = 'drill-jab'`,
        [ORG_A],
      );
      const library = await client.query(ACTIVE_LIBRARY_SQL, [ORG_A]);
      expect(library.rows.map((row: { drill_id: string }) => row.drill_id)).toEqual(['drill-unused']);
      const stillAnchored = await client.query(ASSIGNMENTS_OF_DRILL_SQL, [ORG_A, 'drill-jab']);
      expect(stillAnchored.rows).toHaveLength(1);

      // A drill nothing references deletes cleanly.
      await client.query(
        `delete from pilot.drills where organization_id = $1 and drill_id = 'drill-unused'`,
        [ORG_A],
      );
      const remaining = await client.query(
        `select drill_id from pilot.drills where organization_id = $1 order by drill_id`,
        [ORG_A],
      );
      expect(remaining.rows).toEqual([{ drill_id: 'drill-jab' }]);
    } finally {
      await client.end();
    }
  });

  test('renaming a drill does not rewrite what the coach typed on the assignment', async () => {
    // The typed name is the only record of what was actually assigned that day.
    const client = await freshDatabase('ppbf_test_drills_rename');
    try {
      await applyMigrationTransaction(client, migrationSql);
      await insertDrill(client, { drillId: 'drill-jab', name: 'Straight Jab Retraction Snap' });
      await assignDrill(client, {
        assignmentId: 'asg-historic',
        drillId: 'drill-jab',
        drillName: 'Jab retraction (Tuesday floor)',
        drillDescription: 'Three rounds, focus on the elbow.',
      });

      await client.query(
        `update pilot.drills set name = 'Jab Retraction Snap', updated_at = now()
         where organization_id = $1 and drill_id = 'drill-jab'`,
        [ORG_A],
      );

      const { rows } = await client.query(
        `select a.drill_name, a.drill_description, d.name as current_name
         from pilot.drill_assignments a
         join pilot.drills d
           on d.organization_id = a.organization_id and d.drill_id = a.drill_id
         where a.assignment_id = 'asg-historic'`,
      );
      expect(rows).toEqual([
        {
          drill_name: 'Jab retraction (Tuesday floor)',
          drill_description: 'Three rounds, focus on the elbow.',
          current_name: 'Jab Retraction Snap',
        },
      ]);
    } finally {
      await client.end();
    }
  });

  test('re-running is a no-op and keeps every drill and assignment', async () => {
    const client = await freshDatabase('ppbf_test_drills_idempotent');
    try {
      await applyMigrationTransaction(client, migrationSql);
      await insertDrill(client, { drillId: 'drill-jab', name: 'Straight Jab Retraction Snap' });
      await assignDrill(client, { assignmentId: 'asg-anchored', drillId: 'drill-jab' });
      await assignDrill(client, { assignmentId: 'asg-legacy' });

      await applyMigrationTransaction(client, migrationSql);
      await applyMigrationTransaction(client, migrationSql);

      const drills = await client.query(ACTIVE_LIBRARY_SQL, [ORG_A]);
      expect(drills.rows).toHaveLength(1);
      const assignments = await client.query(
        `select assignment_id, drill_id from pilot.drill_assignments
         where organization_id = $1 order by assignment_id`,
        [ORG_A],
      );
      expect(assignments.rows).toEqual([
        { assignment_id: 'asg-anchored', drill_id: 'drill-jab' },
        { assignment_id: 'asg-legacy', drill_id: null },
      ]);

      // Re-running must not multiply the constraints or the indexes either.
      const constraints = await client.query(
        `select count(*)::int as n from pg_constraint
         where conname in ('pilot_drills_difficulty_check', 'pilot_drill_assignments_fk_drill')`,
      );
      expect(constraints.rows[0].n).toBe(2);
      const drillIndexes = await client.query(
        `select count(*)::int as n from pg_indexes
         where schemaname = 'pilot' and tablename = 'drills'`,
      );
      expect(drillIndexes.rows[0].n).toBe(3);
      const assignmentIndexes = await client.query(
        `select count(*)::int as n from pg_indexes
         where schemaname = 'pilot' and indexname = 'idx_pilot_drill_assignments_drill'`,
      );
      expect(assignmentIndexes.rows[0].n).toBe(1);
    } finally {
      await client.end();
    }
  });

  test('a drill cannot be recorded for an organization that does not exist', async () => {
    const client = await freshDatabase('ppbf_test_drills_foreign_keys');
    try {
      await applyMigrationTransaction(client, migrationSql);

      await expect(
        insertDrill(client, { organizationId: 'org-not-real', drillId: 'drill-x', name: 'Nowhere' }),
      ).rejects.toThrow(/foreign key/);
    } finally {
      await client.end();
    }
  });
});
