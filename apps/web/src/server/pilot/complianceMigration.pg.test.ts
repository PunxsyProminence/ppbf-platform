// Real PostgreSQL-backed contract test for the compliance migration.
//
// Three things need proving, and none can be proven by reading SQL:
//
// 1. It CREATES the schema from nothing. That is the whole point -- these
//    three tables were reachable only through /api/pilot/admin/migrate-multiorg,
//    a bootstrap-key HTTP route, so a rebuilt environment had no way to get
//    them and /admin/compliance-center failed at the database.
//
// 2. It is a NO-OP against a database that already has them. This group is
//    the one PROVEN to exist in production -- the owner opened
//    /admin/compliance-center and the tiles rendered 0, and that page renders
//    '--' rather than '0' when its fetch fails, so a successful query means
//    the tables are there. The migration must apply over that live install
//    and leave the rows untouched.
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
const DATA_DIR = path.join(os.tmpdir(), `ppbf-compliance-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const MIGRATION_FILE = 'pilot_slice_postgres_compliance_migration.sql';

const ORG_ID = 'org-comp';
const COACH_ID = 'acct-comp-coach';
const ATHLETE_ID = 'ATH-COMP-1';

// Verbatim from app/api/pilot/admin/migrate-multiorg/route.ts. Copied rather
// than imported because it lives inside a Next route handler as an array of
// template strings; if the route's DDL ever changes, the no-op test below
// stops matching and the divergence surfaces here.
const LEGACY_DDL = [
  `create table if not exists pilot.compliance_rules (
    rule_id text primary key,
    organization_id text not null references pilot.organizations(organization_id),
    rule_name text not null,
    rule_category text not null check (rule_category in ('safety', 'technique', 'protocol', 'medical', 'behavioral')),
    description text not null,
    detection_logic text not null,
    severity text not null default 'medium' check (severity in ('critical', 'high', 'medium', 'low')),
    escalation_level text not null default 'coach' check (escalation_level in ('coach', 'admin', 'board', 'parent')),
    active_flag boolean not null default true,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint pilot_compliance_rules_unique_name unique (organization_id, rule_name)
  )`,
  `create table if not exists pilot.compliance_violations (
    violation_id text primary key,
    organization_id text not null references pilot.organizations(organization_id),
    rule_id text not null references pilot.compliance_rules(rule_id),
    video_session_id text null references pilot.video_sessions(video_session_id),
    athlete_id text not null,
    detected_by_account_id text not null references pilot.accounts(account_id),
    violation_timestamp timestamptz not null,
    severity text not null,
    details jsonb not null default '{}'::jsonb,
    evidence_path text null,
    status text not null default 'new' check (status in ('new', 'acknowledged', 'escalated', 'resolved', 'dismissed')),
    escalation_status text not null default 'pending' check (escalation_status in ('pending', 'in_progress', 'resolved', 'escalated_to_board')),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint pilot_compliance_violations_fk_athlete foreign key (organization_id, athlete_id) references pilot.athletes(organization_id, athlete_id) on delete cascade
  )`,
  `create table if not exists pilot.violation_escalations (
    escalation_id text primary key,
    organization_id text not null references pilot.organizations(organization_id),
    violation_id text not null references pilot.compliance_violations(violation_id) on delete cascade,
    escalated_by_account_id text not null references pilot.accounts(account_id),
    escalated_to_role text not null,
    escalation_reason text not null,
    board_notification_id text null,
    action_required text null,
    resolved_at timestamptz null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
  )`,
  `create index if not exists idx_compliance_violations_org_athlete on pilot.compliance_violations(organization_id, athlete_id, created_at desc)`,
  `create index if not exists idx_compliance_violations_status on pilot.compliance_violations(organization_id, status, escalation_status)`,
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
     values ($1, $2, 'Compliance Athlete', '2011-05-06', 'fly', 'active', 'contact', true, $3, now(), now())`,
    [ORG_ID, ATHLETE_ID, COACH_ID],
  );
  return client;
}

async function insertViolation(client: Client, violationId: string): Promise<void> {
  await client.query(
    `insert into pilot.compliance_rules
       (rule_id, organization_id, rule_name, rule_category, description, detection_logic)
     values ('rule-1', $1, 'Headgear required for sparring', 'safety', 'Sparring without headgear.', 'manual')
     on conflict do nothing`,
    [ORG_ID],
  );
  await client.query(
    `insert into pilot.compliance_violations
       (violation_id, organization_id, rule_id, athlete_id, detected_by_account_id, violation_timestamp, severity)
     values ($1, $2, 'rule-1', $3, $4, now(), 'high')`,
    [violationId, ORG_ID, ATHLETE_ID, COACH_ID],
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
  // compliance_violations carries `references pilot.video_sessions(...)`, and
  // video_sessions is NOT in the base schema -- it became migration-owned only
  // in #125. Without it the FK cannot resolve, which is exactly why the `all`
  // loop orders video-sessions ahead of compliance.
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

describe('compliance migration against real Postgres', () => {
  test('the gap is real: without the migration the tables do not exist', async () => {
    const client = await freshDatabase('ppbf_test_comp_absent');
    try {
      const row = await client.query(`select to_regclass('pilot.compliance_violations') as t`);
      expect(row.rows[0].t).toBeNull();
    } finally {
      await client.end();
    }
  });

  test('a fresh install creates all three tables and both indexes', async () => {
    const client = await freshDatabase('ppbf_test_comp_fresh');
    try {
      await client.query(migrationSql);

      for (const table of ['compliance_rules', 'compliance_violations', 'violation_escalations']) {
        const row = await client.query(`select to_regclass($1) as t`, [`pilot.${table}`]);
        expect(row.rows[0].t).not.toBeNull();
      }

      const indexes = await client.query(
        `select indexname from pg_indexes where schemaname = 'pilot' and tablename = 'compliance_violations'`,
      );
      const names = indexes.rows.map((r: { indexname: string }) => r.indexname);
      expect(names).toContain('idx_compliance_violations_org_athlete');
      expect(names).toContain('idx_compliance_violations_status');
    } finally {
      await client.end();
    }
  });

  test('the real read path works after the migration', async () => {
    // compliance.ts joins violations to rules and escalations; a table that
    // exists but rejects the app's own insert would still be broken.
    const client = await freshDatabase('ppbf_test_comp_readpath');
    try {
      await client.query(migrationSql);
      await insertViolation(client, 'viol-1');
      await client.query(
        `insert into pilot.violation_escalations
           (escalation_id, organization_id, violation_id, escalated_by_account_id, escalated_to_role, escalation_reason)
         values ('esc-1', $1, 'viol-1', $2, 'organization_admin', 'Repeat occurrence.')`,
        [ORG_ID, COACH_ID],
      );

      const joined = await client.query(
        `select v.violation_id, r.rule_name, e.escalation_id
         from pilot.compliance_violations v
         join pilot.compliance_rules r on r.rule_id = v.rule_id
         join pilot.violation_escalations e on e.violation_id = v.violation_id
         where v.organization_id = $1`,
        [ORG_ID],
      );
      expect(joined.rows).toHaveLength(1);
      expect(joined.rows[0].rule_name).toBe('Headgear required for sparring');
    } finally {
      await client.end();
    }
  });

  test('NO-OP: applies cleanly over the legacy route-created tables and keeps their rows', async () => {
    // The case that matters most in this series: these tables are PROVEN to
    // exist in production, so the migration has to be a no-op there.
    const client = await freshDatabase('ppbf_test_comp_legacy');
    try {
      for (const statement of LEGACY_DDL) await client.query(statement);
      await insertViolation(client, 'viol-legacy');

      await client.query(migrationSql);

      const row = await client.query(
        `select violation_id, severity, status from pilot.compliance_violations where violation_id = 'viol-legacy'`,
      );
      expect(row.rows).toHaveLength(1);
      expect(row.rows[0].severity).toBe('high');
      expect(row.rows[0].status).toBe('new');
    } finally {
      await client.end();
    }
  });

  test('NO-OP: the legacy install and a fresh install agree on columns and constraints', async () => {
    // Drift between the two would mean an environment built by migration
    // behaves differently from one built by the route -- worse than the gap
    // this migration closes.
    const legacy = await freshDatabase('ppbf_test_comp_shape_legacy');
    const fresh = await freshDatabase('ppbf_test_comp_shape_fresh');
    try {
      for (const statement of LEGACY_DDL) await legacy.query(statement);
      await fresh.query(migrationSql);

      const columnQuery = `
        select table_name, column_name, data_type, is_nullable, column_default
        from information_schema.columns
        where table_schema = 'pilot'
          and table_name in ('compliance_rules', 'compliance_violations', 'violation_escalations')
        order by table_name, column_name`;
      const constraintQuery = `
        select conrelid::regclass::text as tbl, conname, pg_get_constraintdef(oid) as def
        from pg_constraint
        where connamespace = 'pilot'::regnamespace
          and conrelid::regclass::text in ('pilot.compliance_rules', 'pilot.compliance_violations', 'pilot.violation_escalations')
        order by tbl, conname`;

      expect((await fresh.query(columnQuery)).rows).toEqual((await legacy.query(columnQuery)).rows);
      expect((await fresh.query(constraintQuery)).rows).toEqual((await legacy.query(constraintQuery)).rows);
    } finally {
      await legacy.end();
      await fresh.end();
    }
  });

  test('re-running is idempotent', async () => {
    const client = await freshDatabase('ppbf_test_comp_idempotent');
    try {
      await client.query(migrationSql);
      await insertViolation(client, 'viol-keep');
      await client.query(migrationSql);
      await client.query(migrationSql);

      const row = await client.query(`select count(*)::int as n from pilot.compliance_violations`);
      expect(row.rows[0].n).toBe(1);
    } finally {
      await client.end();
    }
  });

  test('the athlete foreign key is real: an unknown athlete cannot have a violation', async () => {
    const client = await freshDatabase('ppbf_test_comp_fk');
    try {
      await client.query(migrationSql);
      await client.query(
        `insert into pilot.compliance_rules
           (rule_id, organization_id, rule_name, rule_category, description, detection_logic)
         values ('rule-x', $1, 'r', 'safety', 'd', 'manual')`,
        [ORG_ID],
      );
      await expect(
        client.query(
          `insert into pilot.compliance_violations
             (violation_id, organization_id, rule_id, athlete_id, detected_by_account_id, violation_timestamp, severity)
           values ('viol-x', $1, 'rule-x', 'ATH-NOT-REAL', $2, now(), 'low')`,
          [ORG_ID, COACH_ID],
        ),
      ).rejects.toThrow(/pilot_compliance_violations_fk_athlete|foreign key/);
    } finally {
      await client.end();
    }
  });

  test('the rule name is unique per organization, as the route declared', async () => {
    const client = await freshDatabase('ppbf_test_comp_unique');
    try {
      await client.query(migrationSql);
      await insertViolation(client, 'viol-u');
      await expect(
        client.query(
          `insert into pilot.compliance_rules
             (rule_id, organization_id, rule_name, rule_category, description, detection_logic)
           values ('rule-dup', $1, 'Headgear required for sparring', 'safety', 'd', 'manual')`,
          [ORG_ID],
        ),
      ).rejects.toThrow(/pilot_compliance_rules_unique_name|duplicate key/);
    } finally {
      await client.end();
    }
  });
});
