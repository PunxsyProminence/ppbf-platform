// Real PostgreSQL-backed contract test for the compliance rule seeds.
//
// The compliance migration creates compliance_rules and puts nothing in it, so
// a gym provisioned through apply-migrations has an empty rule set and
// compliance monitoring has nothing to monitor against. Four things need
// proving, and none can be proven by reading SQL:
//
// 1. Every organization that exists when the migration runs ends up with all
//    five defaults, with the exact categories, severities and escalation
//    levels the platform ships.
//
// 2. Re-running does not duplicate. The workflow re-runs the whole `all` list
//    against every environment, so this file applies against production more
//    than once.
//
// 3. A gym's own edits survive. Archiving, rewriting or renaming a default is
//    a decision the gym made; the next run must not overturn it.
//
// 4. The runner's readiness check actually fails when the seeds did not land.
//    An all-green suite where readiness passes on an unseeded database proves
//    nothing, so that case is asserted directly against the real runner.
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
const DATA_DIR = path.join(os.tmpdir(), `ppbf-rule-seeds-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const MIGRATION_FILE = 'pilot_slice_postgres_compliance_rule_seeds_migration.sql';
const MIGRATION_RUNNER_PATH = path.resolve(
  __dirname,
  '../../../scripts/pilot-apply-compliance-rule-seeds-migration.mjs',
);

const ORG_A = 'org-seed-a';
const ORG_B = 'org-seed-b';
const COACH_ID = 'acct-seed-coach';
const ATHLETE_ID = 'ATH-SEED-1';

// ts-jest downlevels a plain `await import(...)` into require(), which cannot
// load an ESM-only .mjs file. Building the import() call inside `new Function`
// hides it from that transform, so Node's own ESM loader executes it.
const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

type DefaultRule = {
  ruleIdFor: (organizationId: string) => string;
  ruleName: string;
  ruleCategory: string;
  severity: string;
  escalationLevel: string;
};

// The five the platform ships. Spelled out here rather than parsed from the
// SQL: a test that derives its expectations from the file under test agrees
// with any change to that file, including a wrong one.
const DEFAULT_RULES: DefaultRule[] = [
  {
    ruleIdFor: (org) => `rule_behavioral_${org}_conduct`,
    ruleName: 'Code of Conduct',
    ruleCategory: 'behavioral',
    severity: 'medium',
    escalationLevel: 'coach',
  },
  {
    ruleIdFor: (org) => `rule_medical_${org}_clearance`,
    ruleName: 'Medical Clearance Status',
    ruleCategory: 'medical',
    severity: 'critical',
    escalationLevel: 'admin',
  },
  {
    ruleIdFor: (org) => `rule_protocol_${org}_attendance`,
    ruleName: 'Training Protocol Compliance',
    ruleCategory: 'protocol',
    severity: 'high',
    escalationLevel: 'coach',
  },
  {
    ruleIdFor: (org) => `rule_safety_${org}_physical_injury`,
    ruleName: 'Physical Injury Prevention',
    ruleCategory: 'safety',
    severity: 'critical',
    escalationLevel: 'admin',
  },
  {
    ruleIdFor: (org) => `rule_technique_${org}_form_standards`,
    ruleName: 'Proper Technique & Form',
    ruleCategory: 'technique',
    severity: 'high',
    escalationLevel: 'coach',
  },
];

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let seedsSql: string;
let baseSchemaSql: string;
let videoSessionsSql: string;
let complianceSql: string;
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
 * Fresh database holding two organizations. `withCompliance` false reproduces
 * an environment that never got the compliance migration.
 */
async function freshDatabase(name: string, withCompliance = true): Promise<Client> {
  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  await admin.query(`drop database if exists ${name}`);
  await admin.query(`create database ${name}`);
  await admin.end();

  const client = new Client({ connectionString: connectionStringFor(name) });
  await client.connect();
  await client.query(baseSchemaSql);
  await client.query(videoSessionsSql);
  if (withCompliance) {
    await client.query(complianceSql);
  }
  for (const organizationId of [ORG_A, ORG_B]) {
    await client.query(
      `insert into pilot.organizations (organization_id, organization_name, status)
       values ($1, $1, 'active') on conflict do nothing`,
      [organizationId],
    );
  }
  await client.query(
    `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
     values ($1, 'coach', $2, 'microsoft') on conflict do nothing`,
    [COACH_ID, ORG_A],
  );
  await client.query(
    `insert into pilot.athletes (organization_id, athlete_id, full_name, dob, weight_class, gym_status, emergency_contact, active_flag, coach_id, created_at, updated_at)
     values ($1, $2, 'Seeded Athlete', '2011-05-06', 'fly', 'active', 'contact', true, $3, now(), now())`,
    [ORG_A, ATHLETE_ID, COACH_ID],
  );
  return client;
}

async function rulesFor(client: Client, organizationId: string) {
  const { rows } = await client.query(
    `select rule_id, rule_name, rule_category, severity, escalation_level, active_flag, description
     from pilot.compliance_rules
     where organization_id = $1
     order by rule_id`,
    [organizationId],
  );
  return rows as Array<{
    rule_id: string;
    rule_name: string;
    rule_category: string;
    severity: string;
    escalation_level: string;
    active_flag: boolean;
    description: string;
  }>;
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
  // compliance_violations carries `references pilot.video_sessions(...)`, so
  // the compliance migration cannot apply without it.
  videoSessionsSql = await fs.readFile(
    path.join(INFRA_DIR, 'pilot_slice_postgres_video_sessions_migration.sql'), 'utf8');
  complianceSql = await fs.readFile(
    path.join(INFRA_DIR, 'pilot_slice_postgres_compliance_migration.sql'), 'utf8');
  seedsSql = await fs.readFile(path.join(INFRA_DIR, MIGRATION_FILE), 'utf8');

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

describe('compliance rule seeds against real Postgres', () => {
  test('the gap is real: the compliance migration alone leaves every gym with no rules', async () => {
    const client = await freshDatabase('ppbf_test_seeds_gap');
    try {
      const { rows } = await client.query(`select count(*)::int as n from pilot.compliance_rules`);
      expect(rows[0].n).toBe(0);
    } finally {
      await client.end();
    }
  });

  // NEGATIVE CONTROL. If readiness passed here, every other assertion in this
  // file would be worthless: the runner would commit an environment where the
  // seeds silently did nothing.
  test('the readiness check REFUSES a database where the seeds never ran', async () => {
    const client = await freshDatabase('ppbf_test_seeds_readiness_negative');
    try {
      await expect(applyMigrationTransaction(client, 'select 1')).rejects.toThrow(
        /COMPLIANCE_RULE_SEEDS_NOT_READY/,
      );

      // Rolled back as a unit -- the refusal must not leave a partial seed.
      const { rows } = await client.query(`select count(*)::int as n from pilot.compliance_rules`);
      expect(rows[0].n).toBe(0);
    } finally {
      await client.end();
    }
  });

  test('without the compliance migration the seeds cannot apply at all', async () => {
    const client = await freshDatabase('ppbf_test_seeds_no_tables', false);
    try {
      await expect(applyMigrationTransaction(client, seedsSql)).rejects.toThrow(
        /compliance_rules|does not exist/,
      );
    } finally {
      await client.end();
    }
  });

  test('every organization that exists gets all five defaults, verbatim', async () => {
    const client = await freshDatabase('ppbf_test_seeds_fresh');
    try {
      await applyMigrationTransaction(client, seedsSql);

      for (const organizationId of [ORG_A, ORG_B]) {
        const rows = await rulesFor(client, organizationId);
        expect(rows).toHaveLength(DEFAULT_RULES.length);
        expect(
          rows.map((row) => ({
            rule_id: row.rule_id,
            rule_name: row.rule_name,
            rule_category: row.rule_category,
            severity: row.severity,
            escalation_level: row.escalation_level,
            active_flag: row.active_flag,
          })),
        ).toEqual(
          DEFAULT_RULES.map((rule) => ({
            rule_id: rule.ruleIdFor(organizationId),
            rule_name: rule.ruleName,
            rule_category: rule.ruleCategory,
            severity: rule.severity,
            escalation_level: rule.escalationLevel,
            active_flag: true,
          })),
        );
      }
    } finally {
      await client.end();
    }
  });

  test('re-running does not duplicate', async () => {
    const client = await freshDatabase('ppbf_test_seeds_idempotent');
    try {
      await applyMigrationTransaction(client, seedsSql);
      await applyMigrationTransaction(client, seedsSql);
      await applyMigrationTransaction(client, seedsSql);

      const { rows } = await client.query(
        `select organization_id, count(*)::int as n
         from pilot.compliance_rules
         group by organization_id
         order by organization_id`,
      );
      expect(rows).toEqual([
        { organization_id: ORG_A, n: DEFAULT_RULES.length },
        { organization_id: ORG_B, n: DEFAULT_RULES.length },
      ]);
    } finally {
      await client.end();
    }
  });

  test('an archived default stays archived', async () => {
    // Turning a default off is a decision the gym made. Re-running the
    // migration must not switch it back on.
    const client = await freshDatabase('ppbf_test_seeds_archived');
    try {
      await applyMigrationTransaction(client, seedsSql);
      await client.query(
        `update pilot.compliance_rules set active_flag = false
         where organization_id = $1 and rule_name = 'Code of Conduct'`,
        [ORG_A],
      );

      await applyMigrationTransaction(client, seedsSql);

      const rows = await rulesFor(client, ORG_A);
      expect(rows).toHaveLength(DEFAULT_RULES.length);
      expect(rows.find((row) => row.rule_name === 'Code of Conduct')?.active_flag).toBe(false);
      // The other organization is untouched by ORG_A's decision.
      const untouched = await rulesFor(client, ORG_B);
      expect(untouched.every((row) => row.active_flag)).toBe(true);
    } finally {
      await client.end();
    }
  });

  test('an edited default keeps the gym\'s own wording and severity', async () => {
    const client = await freshDatabase('ppbf_test_seeds_edited');
    try {
      await applyMigrationTransaction(client, seedsSql);
      await client.query(
        `update pilot.compliance_rules
         set description = 'Headgear and mouthguard required for all contact work.',
             severity = 'low',
             escalation_level = 'board'
         where organization_id = $1 and rule_name = 'Physical Injury Prevention'`,
        [ORG_A],
      );

      await applyMigrationTransaction(client, seedsSql);

      const rows = await rulesFor(client, ORG_A);
      expect(rows).toHaveLength(DEFAULT_RULES.length);
      expect(rows.find((row) => row.rule_name === 'Physical Injury Prevention')).toMatchObject({
        description: 'Headgear and mouthguard required for all contact work.',
        severity: 'low',
        escalation_level: 'board',
      });
    } finally {
      await client.end();
    }
  });

  test('a renamed default is not re-created under its original name', async () => {
    // The name check no longer recognizes this row, so the insert is attempted
    // and `on conflict do nothing` is the only thing standing between the gym
    // and a duplicate rule.
    const client = await freshDatabase('ppbf_test_seeds_renamed');
    try {
      await applyMigrationTransaction(client, seedsSql);
      await client.query(
        `update pilot.compliance_rules set rule_name = 'Injury Prevention (PPBF)'
         where organization_id = $1 and rule_name = 'Physical Injury Prevention'`,
        [ORG_A],
      );

      await applyMigrationTransaction(client, seedsSql);

      const rows = await rulesFor(client, ORG_A);
      expect(rows).toHaveLength(DEFAULT_RULES.length);
      expect(rows.map((row) => row.rule_name)).toContain('Injury Prevention (PPBF)');
      expect(rows.map((row) => row.rule_name)).not.toContain('Physical Injury Prevention');
    } finally {
      await client.end();
    }
  });

  test('a seeded rule is a usable violation target', async () => {
    // The seeds exist so compliance monitoring has something to reference; a
    // rule_id that no violation can point at would not close the gap.
    const client = await freshDatabase('ppbf_test_seeds_violation');
    try {
      await applyMigrationTransaction(client, seedsSql);
      await client.query(
        `insert into pilot.compliance_violations
           (violation_id, organization_id, rule_id, athlete_id, detected_by_account_id, violation_timestamp, severity)
         values ('viol-seeded', $1, $2, $3, $4, now(), 'critical')`,
        [ORG_A, `rule_safety_${ORG_A}_physical_injury`, ATHLETE_ID, COACH_ID],
      );

      const { rows } = await client.query(
        `select r.rule_name
         from pilot.compliance_violations v
         join pilot.compliance_rules r on r.rule_id = v.rule_id
         where v.violation_id = 'viol-seeded'`,
      );
      expect(rows).toEqual([{ rule_name: 'Physical Injury Prevention' }]);
    } finally {
      await client.end();
    }
  });

  test('an organization created after the migration has no rules until it runs again', async () => {
    // Documented limitation, asserted rather than assumed: this migration
    // seeds the organizations that exist when it runs. Organization creation
    // does not seed.
    const client = await freshDatabase('ppbf_test_seeds_late_org');
    try {
      await applyMigrationTransaction(client, seedsSql);
      await client.query(
        `insert into pilot.organizations (organization_id, organization_name, status)
         values ('org-seed-late', 'Late Gym', 'active')`,
      );

      expect(await rulesFor(client, 'org-seed-late')).toHaveLength(0);
      await expect(applyMigrationTransaction(client, 'select 1')).rejects.toThrow(
        /COMPLIANCE_RULE_SEEDS_NOT_READY/,
      );

      await applyMigrationTransaction(client, seedsSql);
      expect(await rulesFor(client, 'org-seed-late')).toHaveLength(DEFAULT_RULES.length);
    } finally {
      await client.end();
    }
  });
});
