// Real PostgreSQL-backed test for the reference-content census
// (scripts/pilot-check-reference-content.mjs).
//
// The census is how the first gym load gets planned on facts: where the
// 2026-08-24 reference rows sit (organization_id, created_by_role), how many a
// gym has adopted or superseded, and how many drill rows carry the '|' claim-id
// defect. It is meant to be pointed at production, so four things need a real
// database rather than a reading of the SQL:
//
//   1. Every count is keyed the way the plan needs it, against the schema
//      production actually runs -- built by applyFullSchema, so a table the
//      census names but the migrations do not create would fail here. A
//      table's total stays complete when its list of groups is cut.
//   2. A table or column the database does not have is reported `absent`,
//      never 0 and never an error. That is a legitimate production state and
//      the reason the census exists.
//   3. It only reads, inside one read-only transaction. Asserted on the
//      statements it actually sends, not on the file's text.
//   4. What it prints carries no row identifier -- no drill id, name, account id
//      or claim id -- and a hostile organization_id or created_by_role cannot
//      forge a log line.
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

jest.setTimeout(240_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-reference-census-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const FULL_SCHEMA_HELPER_PATH = path.resolve(__dirname, '../../../scripts/lib/full-schema.mjs');
const CENSUS_PATH = path.resolve(__dirname, '../../../scripts/pilot-check-reference-content.mjs');

// Jest's CJS transform rewrites a bare `import()` into `require()`, which cannot
// load an ESM .mjs. Same pattern as disciplineValueCensus.pg.test.ts.
const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

const ORG_DEFAULT = 'org-census-default';
const ORG_GYM = 'org-census-gym';
/**
 * An organization_id shaped to forge log lines if echoed raw: a real CR+LF and
 * a GitHub workflow command. Built with join so the control characters are
 * genuine, not the two-character sequence backslash-n.
 */
const HOSTILE_ORG = ['org-census-hostile', '::warning::forged'].join('\r\n');
const HOSTILE_ROLE = ['organization_admin', '::error::forged'].join('\n');

/** Row-level values the census must never print. Every one is planted below. */
const SECRET_ACCOUNT = 'secret.seeder@example.org';
const SECRET_NAME = 'Secret Drill Name';
const SECRET_CLAIM = 'A1-001';
const DRILLS = {
  defaultPipe: 'drl-secret-default-pipe',
  defaultClean: 'drl-secret-default-clean',
  defaultSuperseded: 'drl-secret-default-superseded',
  defaultNoRole: 'drl-secret-default-norole',
  gymPipe: 'drl-secret-gym-pipe',
  gymClean: 'drl-secret-gym-clean',
  gymHostileRole: 'drl-secret-gym-hostile',
  gymRetired: 'drl-secret-gym-retired',
};
const TEMPLATE_IDS = ['tpl-secret-default', 'tpl-secret-gym'];
const OPERATIONAL_DRILL_IDS = ['op-secret-adopted', 'op-secret-own'];

type Group = { organization_id: string; created_by_role?: string | null; row_count: number };
type TableEntry = {
  table: string;
  present: boolean;
  byRole?: boolean;
  total?: number;
  groups?: Group[];
  truncated?: boolean;
};
type FilteredEntry = {
  table: string;
  column: string;
  state: 'counted' | 'table absent' | 'column absent';
  total?: number;
  groups?: Group[];
  truncated?: boolean;
};
type CensusReport = {
  tables: TableEntry[];
  adopted: FilteredEntry;
  superseded: FilteredEntry;
  pipeClaimIds: FilteredEntry;
};
type Queryable = Pick<Client, 'query'>;

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let census: (client: Queryable) => Promise<CensusReport>;
let formatReport: (report: CensusReport) => string[];
let referenceTables: string[];
let groupLimit: number;
let applyFullSchema: (client: Client, opts?: { infraDir?: string }) => Promise<unknown>;

/** Built once: the census only reads, so every case can share it. */
let fullClient: Client;

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

async function emptyDatabase(name: string): Promise<Client> {
  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  await admin.query(`drop database if exists ${name}`);
  await admin.query(`create database ${name}`);
  await admin.end();

  const client = new Client({ connectionString: connectionStringFor(name) });
  await client.connect();
  return client;
}

async function insertReferenceDrill(
  client: Client,
  organizationId: string,
  drillId: string,
  opts: { role: string | null; claims?: string[]; superseded?: boolean; active?: boolean },
) {
  await client.query(
    `insert into pilot.drill_library (
       organization_id, drill_id, lineage_id, name, category, target_behavior, purpose,
       standard_setup, execution, what_good_looks_like, what_bad_looks_like,
       grounding_claim_ids, created_by_account_id, created_by_role, superseded_at, active
     )
     values ($1, $2, $2, $3, 'defense', 'b', 'p', 's', 'e', 'g', 'bad', $4, $5, $6, $7, $8)`,
    [
      organizationId,
      drillId,
      `${SECRET_NAME} ${drillId}`,
      opts.claims ?? [],
      SECRET_ACCOUNT,
      opts.role,
      opts.superseded ? '2026-09-01T00:00:00Z' : null,
      opts.active ?? !opts.superseded,
    ],
  );
}

/**
 * The shape the plan is worried about: a default org holding the platform-seeded
 * library (with the '|' defect and a superseded version), and a gym holding its
 * own organization_admin-seeded rows, one of them adopted.
 */
async function plantReferenceContent(client: Client) {
  for (const org of [ORG_DEFAULT, ORG_GYM, HOSTILE_ORG]) {
    await client.query(
      `insert into pilot.organizations (organization_id, organization_name, status)
       values ($1, $1, 'active')`,
      [org],
    );
    await client.query(
      `insert into pilot.disciplines (organization_id, discipline, display_name, lane, exposure_model)
       values ($1, 'boxing', 'Boxing', 'striking', 'head_impact')`,
      [org],
    );
  }
  await client.query(
    `insert into pilot.disciplines (organization_id, discipline, display_name, lane, exposure_model)
     values ($1, 'conditioning', 'Conditioning', 'non_contact', 'none')`,
    [ORG_DEFAULT],
  );

  // 'A1-001|A2-002' as ONE element is the defect: the loader's splitter did not
  // know '|' (the retired seed-drill-library.mjs split on ';' and ',' only). The clean row holds the same two
  // ids split properly, so a census counting ids-that-contain-A1 instead of
  // elements-that-contain-'|' would count it and fail.
  await insertReferenceDrill(client, ORG_DEFAULT, DRILLS.defaultPipe, {
    role: 'platform_owner', claims: [`${SECRET_CLAIM}|A2-002`],
  });
  await insertReferenceDrill(client, ORG_DEFAULT, DRILLS.defaultClean, {
    role: 'platform_owner', claims: [SECRET_CLAIM, 'A2-002'],
  });
  await insertReferenceDrill(client, ORG_DEFAULT, DRILLS.defaultSuperseded, {
    role: 'platform_owner', claims: ['B1-001|B2-002'], superseded: true,
  });
  // A NULL role is its own group, not folded into a neighbour.
  await insertReferenceDrill(client, ORG_DEFAULT, DRILLS.defaultNoRole, { role: null });
  // Two '|' elements in ONE row, beside a clean one. The census counts rows, so
  // this is 1; a census counting elements would say 2.
  await insertReferenceDrill(client, ORG_GYM, DRILLS.gymPipe, {
    role: 'organization_admin', claims: ['C1-001|C2-002', 'C3-003|C4-004', 'C5-005'],
  });
  await insertReferenceDrill(client, ORG_GYM, DRILLS.gymClean, { role: 'organization_admin' });
  await insertReferenceDrill(client, ORG_GYM, DRILLS.gymHostileRole, { role: HOSTILE_ROLE });
  // Retired but never superseded: active=false, superseded_at NULL. The
  // superseded count reads superseded_at, so this row is not in it; a census
  // reading `not active` instead would count it.
  await insertReferenceDrill(client, ORG_GYM, DRILLS.gymRetired, {
    role: 'organization_admin', active: false,
  });

  // A child table with no created_by_role column: keyed by organization alone.
  for (const [cueId, org, drill] of [
    ['cue-secret-1', ORG_DEFAULT, DRILLS.defaultPipe],
    ['cue-secret-2', ORG_DEFAULT, DRILLS.defaultClean],
    ['cue-secret-3', ORG_GYM, DRILLS.gymClean],
  ]) {
    await client.query(
      `insert into pilot.drill_cues (organization_id, cue_id, drill_id, cue_text)
       values ($1, $2, $3, 'secret cue text')`,
      [org, cueId, drill],
    );
  }

  // The other table that carries created_by_role.
  for (const [templateId, org, role] of [
    [TEMPLATE_IDS[0], ORG_DEFAULT, 'platform_owner'],
    [TEMPLATE_IDS[1], ORG_GYM, 'organization_admin'],
  ]) {
    await client.query(
      `insert into pilot.workout_templates
         (organization_id, template_id, lineage_id, name, session_type, duration_minutes, intent,
          created_by_account_id, created_by_role)
       values ($1, $2, $2, $2, 'technical', 45, 'intent', $3, $4)`,
      [org, templateId, SECRET_ACCOUNT, role],
    );
  }

  // One gym drill adopted from the gym's own reference row, and one the gym
  // authored itself -- the filter has to tell them apart.
  await client.query(
    `insert into pilot.drills (organization_id, drill_id, name, category, focus, reference_drill_id)
     values ($1, $2, $2, 'bagwork', 'Focus.', $3), ($4, $5, $5, 'bagwork', 'Focus.', null)`,
    [ORG_GYM, OPERATIONAL_DRILL_IDS[0], DRILLS.gymClean, ORG_DEFAULT, OPERATIONAL_DRILL_IDS[1]],
  );

  // More organizations than the census lists groups for, one competence level
  // each (a table whose only foreign key is the organization, so nothing else
  // asserted here moves). GROUP_LIMIT + 2, not + 1: the query fetches
  // GROUP_LIMIT + 1 rows to see the cut, so a total summed over what was fetched
  // would say GROUP_LIMIT + 1 and one summed over what is printed would say
  // GROUP_LIMIT. Only a total taken before the LIMIT says GROUP_LIMIT + 2.
  for (const statement of [
    `insert into pilot.organizations (organization_id, organization_name, status)
     select 'org-census-bulk-' || g, 'bulk', 'active' from generate_series(1, $1::int) as g`,
    `insert into pilot.competence_levels (organization_id, level_key, ordinal, display_name, observable_test)
     select 'org-census-bulk-' || g, 'level-1', 1, 'Level 1', 'observable'
     from generate_series(1, $1::int) as g`,
  ]) {
    await client.query(statement, [groupLimit + 2]);
  }
}

/** Order-free comparison: the census orders by collation, which is not the point here. */
function sortedGroups(groups: Group[] | undefined): Group[] {
  return [...(groups ?? [])].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

function tableEntry(report: CensusReport, table: string): TableEntry {
  const entry = report.tables.find((candidate) => candidate.table === table);
  if (!entry) throw new Error(`census did not report pilot.${table}`);
  return entry;
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
      reject(new Error(`Embedded Postgres exited early (code ${code}). stderr:\n${stderrOutput}`));
    });
  });

  // The real script, not a copy of its queries.
  const censusModule = await nativeDynamicImport(pathToFileURL(CENSUS_PATH).href);
  census = censusModule.checkReferenceContent as typeof census;
  formatReport = censusModule.formatReport as typeof formatReport;
  referenceTables = censusModule.REFERENCE_TABLES as string[];
  groupLimit = censusModule.GROUP_LIMIT as number;

  const helper = await nativeDynamicImport(pathToFileURL(FULL_SCHEMA_HELPER_PATH).href);
  applyFullSchema = helper.applyFullSchema as typeof applyFullSchema;

  fullClient = await emptyDatabase('rc_full');
  await applyFullSchema(fullClient, { infraDir: INFRA_DIR });
  await plantReferenceContent(fullClient);
});

afterAll(async () => {
  await fullClient?.end().catch(() => {});
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

describe('against the schema production runs', () => {
  test('reports every reference table grouped by organization_id, and by created_by_role where it exists', async () => {
    const report = await census(fullClient);

    // Every named table exists in the full schema. One the migrations do not
    // create would show here as absent -- a census asking about a table that
    // exists nowhere.
    expect(report.tables.map((entry) => entry.table)).toEqual(referenceTables);
    expect(report.tables.filter((entry) => !entry.present).map((entry) => entry.table)).toEqual([]);

    // created_by_role is discovered, not assumed, and today exactly these two
    // tables carry it (drill_library_v3_migration.sql:135,
    // workout_templates_v2_migration.sql:60).
    expect(report.tables.filter((entry) => entry.byRole).map((entry) => entry.table).sort())
      .toEqual(['drill_library', 'workout_templates']);

    const library = tableEntry(report, 'drill_library');
    expect(library.total).toBe(8);
    expect(sortedGroups(library.groups)).toEqual(sortedGroups([
      { organization_id: ORG_DEFAULT, created_by_role: null, row_count: 1 },
      { organization_id: ORG_DEFAULT, created_by_role: 'platform_owner', row_count: 3 },
      { organization_id: ORG_GYM, created_by_role: 'organization_admin', row_count: 3 },
      { organization_id: ORG_GYM, created_by_role: HOSTILE_ROLE, row_count: 1 },
    ]));

    expect(sortedGroups(tableEntry(report, 'workout_templates').groups)).toEqual(sortedGroups([
      { organization_id: ORG_DEFAULT, created_by_role: 'platform_owner', row_count: 1 },
      { organization_id: ORG_GYM, created_by_role: 'organization_admin', row_count: 1 },
    ]));

    // No created_by_role column: keyed by organization alone, no role key at all.
    expect(sortedGroups(tableEntry(report, 'drill_cues').groups)).toEqual(sortedGroups([
      { organization_id: ORG_DEFAULT, row_count: 2 },
      { organization_id: ORG_GYM, row_count: 1 },
    ]));
    expect(sortedGroups(tableEntry(report, 'disciplines').groups)).toEqual(sortedGroups([
      { organization_id: ORG_DEFAULT, row_count: 2 },
      { organization_id: ORG_GYM, row_count: 1 },
      { organization_id: HOSTILE_ORG, row_count: 1 },
    ]));

    // Present and empty is 0 with no groups -- a different answer from absent.
    const protocols = tableEntry(report, 'assessment_protocols');
    expect(protocols).toMatchObject({ present: true, total: 0, groups: [], truncated: false });
  });

  test("counts adoptions, superseded versions and the '|' claim-id defect per organization", async () => {
    const report = await census(fullClient);

    expect(report.adopted).toMatchObject({ state: 'counted', total: 1 });
    expect(report.adopted.groups).toEqual([{ organization_id: ORG_GYM, row_count: 1 }]);

    // superseded_at, not `not active`: the gym's retired row is inactive and
    // was never superseded, so the gym has no group here.
    expect(report.superseded).toMatchObject({ state: 'counted', total: 1 });
    expect(report.superseded.groups).toEqual([{ organization_id: ORG_DEFAULT, row_count: 1 }]);

    // Rows, not elements: the gym row has two '|' elements and counts once
    // (counting elements would make the gym 2 and the total 4). The clean
    // default row counts not at all.
    expect(report.pipeClaimIds).toMatchObject({ state: 'counted', total: 3 });
    expect(sortedGroups(report.pipeClaimIds.groups)).toEqual(sortedGroups([
      { organization_id: ORG_DEFAULT, row_count: 2 },
      { organization_id: ORG_GYM, row_count: 1 },
    ]));

    const text = formatReport(report).join('\n');
    expect(text).toContain("grounding_claim_ids element containing '|'): 3 row(s)");
  });

  test('issues only reads, inside one read-only transaction, and changes nothing', async () => {
    const statements: string[] = [];
    const recorder: Queryable = {
      query: ((text: string, values?: unknown[]) => {
        statements.push(text);
        return fullClient.query(text, values);
      }) as Client['query'],
    };

    const snapshot = async () => (await fullClient.query(
      `select (select count(*) from pilot.drill_library)::int as drills,
              (select count(*) from pilot.drill_library where superseded_at is not null)::int as superseded,
              (select count(*) from pilot.drills)::int as operational,
              (select string_agg(organization_id || ':' || coalesce(created_by_role, '-'), ',' order by drill_id)
                 from pilot.drill_library) as ownership`,
    )).rows[0];
    const before = await snapshot();

    await census(recorder);

    expect(statements[0]).toMatch(/^BEGIN TRANSACTION READ ONLY\b/);
    expect(statements[statements.length - 1]).toBe('COMMIT');
    const body = statements.slice(1, -1);
    expect(body.length).toBeGreaterThan(referenceTables.length);
    // Every statement between BEGIN and COMMIT is a SELECT, and none carries a
    // write or DDL keyword anywhere -- not in a subquery, not in a CTE.
    expect(body.filter((statement) => !/^\s*select\b/i.test(statement))).toEqual([]);
    expect(statements.filter((statement) =>
      /\b(insert|update|delete|merge|alter|drop|create|truncate|grant|revoke|copy)\b/i.test(statement)))
      .toEqual([]);

    expect(await snapshot()).toEqual(before);
  });

  test('keeps a table total complete when its list of groups is cut', async () => {
    const report = await census(fullClient);
    const levels = tableEntry(report, 'competence_levels');

    // The planted table, and only it, is over the limit.
    expect(report.tables.filter((entry) => entry.truncated).map((entry) => entry.table))
      .toEqual(['competence_levels']);
    expect(levels.truncated).toBe(true);
    expect(levels.groups).toHaveLength(groupLimit);
    expect(levels.total).toBe(groupLimit + 2);

    // And the log says both: the complete total, and that the list is cut.
    const lines = formatReport(report);
    expect(lines).toContain(`pilot.competence_levels: ${groupLimit + 2} row(s), by organization_id`);
    expect(lines).toContain(
      `    !! more than ${groupLimit} groups -- list above is TRUNCATED; the total is complete`,
    );
  });

  test('prints counts and organization/role keys only, one physical line per record', async () => {
    const lines = formatReport(await census(fullClient));
    const text = lines.join('\n');

    // The keys the plan needs are there, JSON-quoted.
    expect(text).toContain(`organization_id="${ORG_DEFAULT}" created_by_role="platform_owner" -> 3`);
    expect(text).toContain(`organization_id="${ORG_GYM}" -> 1`);
    expect(text).toContain('pilot.drill_library: 8 row(s), by organization_id, created_by_role');
    expect(text).toContain('pilot.drill_cues: 3 row(s), by organization_id');

    // Nothing row-level was planted that the output repeats.
    for (const secret of [
      SECRET_ACCOUNT, SECRET_NAME, SECRET_CLAIM, 'secret cue text',
      ...Object.values(DRILLS), ...TEMPLATE_IDS, ...OPERATIONAL_DRILL_IDS,
    ]) {
      expect(text).not.toContain(secret);
    }

    // The hostile keys are present but escaped: no line holds a raw line break,
    // and nothing a database string carries can begin a line.
    for (const line of lines) {
      expect(line).not.toMatch(/[\r\n\u2028\u2029]/);
      expect(line).not.toMatch(/^::/);
    }
    expect(text).toContain('organization_id="org-census-hostile\\r\\n::warning::forged"');
    expect(text).toContain('created_by_role="organization_admin\\n::error::forged"');
  });
});

describe('against a database that never took the reference migrations', () => {
  test('reports a missing table or column as absent, not as zero and not as an error', async () => {
    // Base schema plus the operational drills table and the progression
    // migration it depends on (drills_migration.sql:78): pilot.drills exists
    // WITHOUT reference_drill_id (added by drill_reference_provenance), and no
    // reference table exists at all. Both states are plausible for an
    // environment behind on migrations, and both are answers.
    const client = await emptyDatabase('rc_absent');
    try {
      for (const file of [
        'pilot_slice_postgres.sql',
        'pilot_slice_postgres_progression_migration.sql',
        'pilot_slice_postgres_drills_migration.sql',
      ]) {
        await client.query(await fs.readFile(path.join(INFRA_DIR, file), 'utf8'));
      }

      const report = await census(client);

      expect(report.tables.filter((entry) => entry.present)).toEqual([]);
      expect(report.adopted.state).toBe('column absent');
      expect(report.superseded.state).toBe('table absent');
      expect(report.pipeClaimIds.state).toBe('table absent');

      const lines = formatReport(report);
      expect(lines).toContain('pilot.assessment_protocols: absent');
      expect(lines).toContain(
        'Adopted by a gym (pilot.drills.reference_drill_id set): absent (pilot.drills.reference_drill_id not in this database)',
      );
      expect(lines.join('\n')).not.toMatch(/: 0 row\(s\)/);
      expect(lines[lines.length - 1]).toBe('PILOT REFERENCE CONTENT CENSUS PASS');
    } finally {
      await client.end();
    }
  });
});
