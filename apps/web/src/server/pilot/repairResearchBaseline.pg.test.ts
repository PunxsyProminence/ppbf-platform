// Real PostgreSQL coverage for scripts/pilot-repair-research-baseline.mjs, the
// owner-gated tool that repairs the research baseline production imported and
// approved before the 2026-08-07 corpus was corrected (Jason, 2026-09-29, Q1-Q4).
//
// The unit test (scripts/pilot-repair-research-baseline.test.ts) proves the
// tool's decisions against a stub client. It cannot prove the SQL, and it
// cannot prove the constraint that stopped the algorithm lane's SQL:
// shadow_library_sources_review_pair_check. This suite can, because it runs the
// REAL committed plan against a database shaped like production:
//
//   - the full production schema (scripts/lib/full-schema.mjs);
//   - the platform baseline imported by the importer itself from the committed
//     seed, then rewound to the pre-repair values in
//     repairs/pre_repair_values.csv, with the 213 wrong-paper and duplicate
//     sources the seed no longer carries put back -- so every repoint, merge,
//     DOI-fragment retire, tier change and metadata change in the logs is
//     present, not a hand-picked sample;
//   - every source approved and verified WITH stamps, as production's
//     2026-08-13 approval left them;
//   - the gym's own policy shelf in punxsy_prominence, which must not move.
//
// It shows the lane SQL's retire statement failing on that fixture, the tool
// reaching the seed's values with every constraint holding, and the state
// machine (PRE_REPAIR, PARTIAL, REPAIRED, DRIFTED) on real rows.
//
// Local-only embedded Postgres; the script's run() -- which reads
// AZURE_POSTGRES_CONNECTION_STRING -- is never called, only the exported
// functions, against clients this suite owns. The fixture is built once into a
// template database and each test clones it.

import { type ChildProcessByStdio, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import type { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';

import { parse } from 'csv-parse/sync';
import { Client } from 'pg';

jest.setTimeout(600_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-repair-research-pg-test-${process.pid}-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const FULL_SCHEMA_HELPER_PATH = path.resolve(__dirname, '../../../scripts/lib/full-schema.mjs');
const TOOL_PATH = path.resolve(__dirname, '../../../scripts/pilot-repair-research-baseline.mjs');
const IMPORTER_PATH = path.resolve(__dirname, '../../../scripts/import-shadow-research.mjs');
const SCOPE_CHECK_PATH = path.resolve(__dirname, '../../../scripts/pilot-check-library-scope.mjs');
const LOG_0928 = path.resolve(
  __dirname, '../../../seed-data/shadow-research/2026-08-07/repairs/2026-09-28_repair_log.csv',
);

const TEMPLATE_DB = 'ppbf_repair_research_template';
const PLATFORM = '__platform__';
const GYM = 'punxsy_prominence';
const ADMIN = 'acct-repair-admin';
const PHRASE = 'REPAIR RESEARCH BASELINE';
const OTHER_FINGERPRINT = `sha256:${'e'.repeat(64)}`;

const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

type Field = { field: string; before: string | null; after: string | null };
type Plan = {
  sources: Array<{ source_id: string; retire: boolean; fields: Field[] }>;
  chunks: Array<{ chunk_id: string; fields: Field[] }>;
  retireIds: string[];
  liveSources: string[];
  expected: Record<string, { fields: number; sources: number; chunks: number }>;
};
type Result = {
  status: string;
  state?: string;
  state_before?: string;
  state_after?: string;
  reason?: string;
  plan_fingerprint?: string;
  blockers?: Array<string | { code: string }>;
  counts?: Record<string, { planned: number; pending: number; done: number; unchanged: number; drifted: number }>;
  written?: Record<string, number>;
  spot_check?: Array<{ source_title: string }>;
  [key: string]: unknown;
};
type RepairFn = (client: Client, options: Record<string, unknown>, deps?: Record<string, unknown>) => Promise<Result>;
type SeedRow = Record<string, unknown> & { metadata: Record<string, unknown> };
type Seed = { sources: SeedRow[]; chunks: SeedRow[]; [key: string]: unknown[] };

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let repair: RepairFn;
let plan: Plan;
let canonicalJson: (value: unknown) => string;
let managedKeys: string[];
let seed: Seed;
let checkLibraryScope: (client: Client) => Promise<{ corpusByOrg: Array<Record<string, unknown>>; byOrg: Array<Record<string, unknown>> }>;
let libraryScopeState: (input: Record<string, unknown>) => string;
let platformExpectedSources: number;
let databaseCounter = 0;

const silent = () => {};
const codes = (result: Result): string[] => (result.blockers ?? []).map((b) => (typeof b === 'string' ? b : b.code));

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

function dryRun(): Record<string, unknown> {
  return { apply: false, confirm: '' };
}

function applyWith(expectFingerprint: string | undefined): Record<string, unknown> {
  return { apply: true, confirm: PHRASE, expectFingerprint };
}

/** metadata edits that move a row's managed keys to `pick` of each field. */
function metadataEdit(fields: Field[], pick: 'before' | 'after') {
  const set: Record<string, unknown> = {};
  const remove: string[] = [];
  for (const f of fields.filter((x) => x.before !== x.after && x.field.startsWith('metadata.'))) {
    const key = f.field.slice('metadata.'.length);
    const value = f[pick];
    if (value === null) remove.push(key);
    else set[key] = JSON.parse(value);
  }
  return { set_keys: set, remove_keys: remove };
}

/**
 * Production's state before the repair, from the committed files: the seed as
 * imported, the retired sources put back, every changed field set to its
 * pre-repair value.
 */
async function rewindToPreRepair(target: Client): Promise<void> {
  const retired = plan.sources.filter((s) => s.retire).map((s) => ({
    source_id: s.source_id,
    title: `Retired by the 2026-09-28/29 repair: ${s.source_id}`,
  }));
  await target.query(
    `insert into pilot.shadow_library_sources
       (source_id, organization_id, title, source_type, authority_tier, status, metadata,
        created_by_account_id, created_by_role)
     select x.source_id, $1, x.title, 'peer_reviewed', 3, 'active',
            '{"seeded_from": "PPBF research program 2026-08-07"}'::jsonb, $2, 'platform_owner'
       from jsonb_to_recordset($3::jsonb) as x(source_id text, title text)`,
    [PLATFORM, ADMIN, JSON.stringify(retired)],
  );

  const chunkEdits = plan.chunks
    .filter((c) => c.fields.some((f) => f.before !== f.after))
    .map((c) => {
      const moved = c.fields.find((f) => f.field === 'source_id' && f.before !== f.after);
      return { chunk_id: c.chunk_id, source_id: moved ? JSON.parse(moved.before!) : null, ...metadataEdit(c.fields, 'before') };
    });
  await target.query(
    `update pilot.shadow_library_chunks c
        set source_id = coalesce(x.source_id, c.source_id),
            metadata = (c.metadata - x.remove_keys) || x.set_keys
       from jsonb_to_recordset($1::jsonb) as x(chunk_id text, source_id text, set_keys jsonb, remove_keys text[])
      where c.chunk_id = x.chunk_id`,
    [JSON.stringify(chunkEdits)],
  );

  const sourceEdits = plan.sources
    .filter((s) => !s.retire && s.fields.some((f) => f.before !== f.after))
    .map((s) => {
      const tier = s.fields.find((f) => f.field === 'authority_tier' && f.before !== f.after);
      return { source_id: s.source_id, authority_tier: tier ? JSON.parse(tier.before!) : null, ...metadataEdit(s.fields, 'before') };
    });
  await target.query(
    `update pilot.shadow_library_sources s
        set authority_tier = coalesce(x.authority_tier, s.authority_tier),
            metadata = (s.metadata - x.remove_keys) || x.set_keys
       from jsonb_to_recordset($1::jsonb) as x(source_id text, authority_tier smallint, set_keys jsonb, remove_keys text[])
      where s.source_id = x.source_id`,
    [JSON.stringify(sourceEdits)],
  );
}

/** What pilot-approve-library-baseline.mjs left in production on 2026-08-13. */
async function approveEverything(target: Client): Promise<void> {
  await target.query(
    `update pilot.shadow_library_sources
        set approval_state = 'approved', verification_state = 'verified',
            approved_by_account_id = $1, approved_at = now(),
            verified_by_account_id = $1, verified_at = now()`,
    [ADMIN],
  );
  await target.query(
    `update pilot.shadow_library_documents
        set ingest_state = 'indexed', index_completed_at = now(),
            approval_state = 'approved', verification_state = 'verified',
            approved_by_account_id = $1, approved_at = now(),
            verified_by_account_id = $1, verified_at = now()`,
    [ADMIN],
  );
}

async function buildTemplate(target: Client, importer: Record<string, unknown>): Promise<void> {
  const loadSeedPackage = importer.loadSeedPackage as (input: Record<string, unknown>) => Promise<Seed>;
  const importSeedPackage = importer.importSeedPackage as (c: Client, s: Seed, org: string) => Promise<void>;

  await target.query(
    `insert into pilot.organizations (organization_id, organization_name, status)
     values ($1, 'PPBF Platform Evidence Baseline', 'active'), ($2, 'Punxsy Prominence', 'active')
     on conflict do nothing`,
    [PLATFORM, GYM],
  );
  await target.query(
    `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
     values ($1, 'organization_admin', $2, 'microsoft') on conflict do nothing`,
    [ADMIN, GYM],
  );

  seed = await loadSeedPackage({ organizationId: PLATFORM, accountId: ADMIN, scope: 'platform_baseline' });
  await importSeedPackage(target, seed, PLATFORM);
  // The gym's own shelf: rows in another organization that must stay put.
  const gym = await loadSeedPackage({ organizationId: GYM, accountId: ADMIN, scope: 'ppbf_policy' });
  await importSeedPackage(target, gym, GYM);

  await rewindToPreRepair(target);
  await approveEverything(target);
}

async function freshDatabase(): Promise<Client> {
  databaseCounter += 1;
  const name = `ppbf_repair_research_${databaseCounter}`;
  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  await admin.query(`drop database if exists ${name}`);
  await admin.query(`create database ${name} template ${TEMPLATE_DB}`);
  await admin.end();

  const client = new Client({ connectionString: connectionStringFor(name) });
  await client.connect();
  return client;
}

/** Row count and a content hash for every base table in the pilot schema. */
async function snapshot(target: Client): Promise<Record<string, string>> {
  const tables = await target.query<{ table_name: string }>(
    `select table_name from information_schema.tables
      where table_schema = 'pilot' and table_type = 'BASE TABLE'
      order by table_name`,
  );
  const out: Record<string, string> = {};
  for (const { table_name: table } of tables.rows) {
    const result = await target.query<{ n: number; h: string }>(
      `select count(*)::int as n, coalesce(md5(string_agg(t::text, '|' order by t::text)), '') as h
         from pilot."${table.replace(/"/g, '""')}" t`,
    );
    out[table] = `${result.rows[0].n}:${result.rows[0].h}`;
  }
  return out;
}

/** Every library row outside the platform baseline, hashed per organization and table. */
async function outsidePlatform(target: Client): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const table of ['shadow_library_sources', 'shadow_library_documents', 'shadow_library_chunks']) {
    const rows = (await target.query<{ organization_id: string; n: number; h: string }>(
      `select organization_id, count(*)::int as n, md5(string_agg(t::text, '|' order by t::text)) as h
         from pilot.${table} t where organization_id <> $1 group by organization_id order by organization_id`,
      [PLATFORM],
    )).rows;
    for (const row of rows) out[`${table}:${row.organization_id}`] = `${row.n}:${row.h}`;
  }
  return out;
}

type SourceRow = {
  source_id: string; organization_id: string; status: string; authority_tier: number;
  metadata: Record<string, unknown>; approval_state: string; verification_state: string;
  approved_by_account_id: string | null; approved_at: string | null;
  verified_by_account_id: string | null; verified_at: string | null; updated_at: string; title: string;
};
type ChunkRow = { chunk_id: string; organization_id: string; source_id: string; metadata: Record<string, unknown>; updated_at: string; text_content: string };

async function sourcesById(target: Client): Promise<Map<string, SourceRow>> {
  const rows = (await target.query<SourceRow>(
    `select source_id, organization_id, status, authority_tier, metadata, approval_state, verification_state,
            approved_by_account_id, approved_at::text as approved_at, verified_by_account_id,
            verified_at::text as verified_at, updated_at::text as updated_at, title
       from pilot.shadow_library_sources`,
  )).rows;
  return new Map(rows.map((row) => [row.source_id, row]));
}

async function chunksById(target: Client): Promise<Map<string, ChunkRow>> {
  const rows = (await target.query<ChunkRow>(
    `select chunk_id, organization_id, source_id, metadata, updated_at::text as updated_at, text_content
       from pilot.shadow_library_chunks`,
  )).rows;
  return new Map(rows.map((row) => [row.chunk_id, row]));
}

function withoutManaged(metadata: Record<string, unknown>): string {
  const rest = { ...metadata };
  for (const key of managedKeys) delete rest[key];
  return canonicalJson(rest);
}

function managed(metadata: Record<string, unknown>): string {
  return canonicalJson(Object.fromEntries(managedKeys.filter((k) => k in metadata).map((k) => [k, metadata[k]])));
}

async function auditRows(target: Client): Promise<Array<{ details: Record<string, unknown>; organization_id: string }>> {
  return (await target.query(
    `select organization_id, details from pilot.audit_events
      where entity_type = 'shadow_library_research_repair' order by audit_id`,
  )).rows;
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
    }, 240_000);

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

  const helper = await nativeDynamicImport(pathToFileURL(FULL_SCHEMA_HELPER_PATH).href);
  const applyFullSchema = helper.applyFullSchema as (c: Client, o?: { infraDir?: string }) => Promise<unknown>;
  const tool = await nativeDynamicImport(pathToFileURL(TOOL_PATH).href);
  repair = tool.repairResearchBaseline as RepairFn;
  canonicalJson = tool.canonicalJson as (value: unknown) => string;
  managedKeys = [...(tool.MANAGED_METADATA_KEYS as string[])];
  plan = await (tool.loadRepairPlan as () => Promise<Plan>)();
  const importer = await nativeDynamicImport(pathToFileURL(IMPORTER_PATH).href);
  platformExpectedSources = (importer.SCOPE_EXPECTED_COUNTS as Record<string, { sources: number }>).platform_baseline.sources;
  const scopeCheck = await nativeDynamicImport(pathToFileURL(SCOPE_CHECK_PATH).href);
  checkLibraryScope = scopeCheck.checkLibraryScope as typeof checkLibraryScope;
  libraryScopeState = scopeCheck.libraryScopeState as typeof libraryScopeState;

  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  await admin.query(`drop database if exists ${TEMPLATE_DB}`);
  await admin.query(`create database ${TEMPLATE_DB} encoding 'UTF8' template template0`);
  await admin.end();

  const template = new Client({ connectionString: connectionStringFor(TEMPLATE_DB) });
  await template.connect();
  try {
    await applyFullSchema(template, { infraDir: INFRA_DIR });
    await buildTemplate(template, importer);
  } finally {
    // A template must have no open sessions when it is cloned.
    await template.end();
  }
});

afterAll(async () => {
  if (!serverProcess) return;
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
  // Only this suite's own directory, named for this process. On Windows kill()
  // terminates the server script outright, so Postgres may still hold files
  // here for a moment (drillLifecycle.pg.test.ts): retry on EBUSY/EPERM.
  await fs.rm(DATA_DIR, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }).catch(() => {});
});

describe('the fixture is production before the repair', () => {
  test('1194 corpus sources live in the baseline, all approved and verified with stamps', async () => {
    const client = await freshDatabase();
    try {
      const counts = (await client.query(
        `select count(*)::int as sources,
                count(*) filter (where approval_state = 'approved' and verification_state = 'verified'
                                  and approved_by_account_id is not null and verified_at is not null)::int as approved
           from pilot.shadow_library_sources where organization_id = $1`,
        [PLATFORM],
      )).rows[0];
      expect(counts).toEqual({ sources: platformExpectedSources + plan.retireIds.length, approved: platformExpectedSources + plan.retireIds.length });
      expect(plan.retireIds).toHaveLength(213);
    } finally {
      await client.end();
    }
  });

  test('the algorithm lane\'s retire statement fails here on shadow_library_sources_review_pair_check', async () => {
    // Its section 4, SET clause verbatim, over the 2026-09-28 log's retired
    // sources (its list also held the reverted AAP merge, src_6dd70cf8a54ca4c8).
    const rows = parse(await fs.readFile(LOG_0928, 'utf8'), { bom: true, columns: true }) as Array<Record<string, string>>;
    const retireIds = rows
      .filter((row) => row.action === 'MERGE_DUPLICATE' || row.action === 'DELETE_DEAD_BOGUS_SOURCE')
      .map((row) => row.source_id);
    expect(retireIds).toHaveLength(172);

    const client = await freshDatabase();
    try {
      await client.query('begin');
      let caught: { constraint?: string; code?: string } | null = null;
      try {
        await client.query(
          `update pilot.shadow_library_sources set approval_state='rejected', metadata = metadata || '{"retired": {"on": "2026-09-28", "reason": "misresolved citation or merged duplicate; see research batch repair"}}'::jsonb where organization_id='__platform__' and source_id = any($1::text[])`,
          [retireIds],
        );
      } catch (error) {
        caught = error as { constraint?: string; code?: string };
      }
      await client.query('rollback');
      expect(caught).toMatchObject({ code: '23514', constraint: 'shadow_library_sources_review_pair_check' });
    } finally {
      await client.end();
    }
  });
});

describe('dry run (real database)', () => {
  test('reports PRE_REPAIR with every planned change pending, a stable fingerprint, and writes nothing', async () => {
    const client = await freshDatabase();
    try {
      const before = await snapshot(client);
      const first = await repair(client, dryRun(), { log: silent, plan });
      const second = await repair(client, dryRun(), { log: silent, plan });
      const after = await snapshot(client);

      expect(first).toMatchObject({ status: 'dry-run', state: 'PRE_REPAIR', would_apply: true, blockers: [] });
      expect(second.plan_fingerprint).toBe(first.plan_fingerprint);
      for (const action of ['repoint', 'retire', 'retier', 'metadata']) {
        expect(first.counts![action]).toMatchObject({ planned: plan.expected[action].fields, pending: plan.expected[action].fields, done: 0, drifted: 0 });
      }
      expect(first.counts!.repoint.pending).toBe(221);
      expect(first.counts!.retire.pending).toBe(213);
      expect(after).toEqual(before);
    } finally {
      await client.end();
    }
  });

  test('pilot-check-library-scope sees the unrepaired baseline holding more than the corpus assigns', async () => {
    const client = await freshDatabase();
    try {
      const result = await checkLibraryScope(client);
      const platform = result.corpusByOrg.find((r) => r.organization_id === PLATFORM)!;
      expect(platform).toMatchObject({ corpus_sources: platformExpectedSources + 213, corpus_retired: 0 });
    } finally {
      await client.end();
    }
  });
});

describe('apply (real database)', () => {
  test('a fingerprint from another plan is refused before any write', async () => {
    const client = await freshDatabase();
    try {
      const before = await snapshot(client);
      const result = await repair(client, applyWith(OTHER_FINGERPRINT), { log: silent, plan });
      expect(result).toMatchObject({ status: 'refused', reason: 'PLAN_FINGERPRINT_MISMATCH', expected: OTHER_FINGERPRINT });
      expect(await snapshot(client)).toEqual(before);
    } finally {
      await client.end();
    }
  });

  test('reaches the seed\'s values on every planned field, commits under every constraint, and changes nothing else', async () => {
    const client = await freshDatabase();
    try {
      const sourcesBefore = await sourcesById(client);
      const chunksBefore = await chunksById(client);
      const beforeAll = await snapshot(client);
      const outsideBefore = await outsidePlatform(client);

      const dry = await repair(client, dryRun(), { log: silent, plan });
      const result = await repair(client, applyWith(dry.plan_fingerprint), { log: silent, plan });

      const touchedChunks = plan.chunks.filter((c) => c.fields.some((f) => f.before !== f.after));
      const chunkMetadataRows = plan.chunks.filter((c) => c.fields.some((f) => f.before !== f.after && f.field.startsWith('metadata.')));
      expect(result).toMatchObject({
        status: 'applied',
        state_before: 'PRE_REPAIR',
        state_after: 'REPAIRED',
        plan_fingerprint: dry.plan_fingerprint,
        written: {
          chunks_repointed: 221,
          chunks_metadata: chunkMetadataRows.length,
          sources_tier_and_metadata: 224,
          sources_archived: 213,
        },
      });

      const sourcesAfter = await sourcesById(client);
      const chunksAfter = await chunksById(client);
      const retired = new Set(plan.retireIds);
      const touchedSourceIds = new Set(plan.sources.filter((s) => s.fields.some((f) => f.before !== f.after)).map((s) => s.source_id));
      const touchedChunkIds = new Set(touchedChunks.map((c) => c.chunk_id));
      const wrong: string[] = [];

      // Every platform source ends at the seed; retired rows are archived with
      // their review columns exactly as they were.
      for (const seedRow of seed.sources) {
        const row = sourcesAfter.get(seedRow.source_id as string)!;
        if (row.status !== 'active') wrong.push(`${row.source_id} status ${row.status}`);
        if (row.authority_tier !== seedRow.authority_tier) wrong.push(`${row.source_id} tier`);
        if (managed(row.metadata) !== managed(seedRow.metadata)) wrong.push(`${row.source_id} managed metadata`);
      }
      for (const id of retired) {
        const row = sourcesAfter.get(id)!;
        const was = sourcesBefore.get(id)!;
        if (row.status !== 'archived') wrong.push(`${id} not archived`);
        if (canonicalJson(row.metadata) !== canonicalJson(was.metadata)) wrong.push(`${id} metadata changed`);
      }
      for (const [id, row] of sourcesAfter) {
        const was = sourcesBefore.get(id)!;
        for (const column of ['organization_id', 'approval_state', 'verification_state', 'approved_by_account_id',
          'approved_at', 'verified_by_account_id', 'verified_at', 'title'] as const) {
          if (row[column] !== was[column]) wrong.push(`${id} ${column} changed`);
        }
        if (withoutManaged(row.metadata) !== withoutManaged(was.metadata)) wrong.push(`${id} unmanaged metadata changed`);
        const touched = touchedSourceIds.has(id);
        if (touched === (row.updated_at === was.updated_at)) wrong.push(`${id} updated_at ${touched ? 'not advanced' : 'moved'}`);
      }

      // Every platform chunk ends on the seed's source with the seed's managed
      // metadata; its text and every other key are what they were.
      for (const seedRow of seed.chunks) {
        const row = chunksAfter.get(seedRow.chunk_id as string)!;
        if (row.source_id !== seedRow.source_id) wrong.push(`${row.chunk_id} source`);
        if (managed(row.metadata) !== managed(seedRow.metadata)) wrong.push(`${row.chunk_id} managed metadata`);
      }
      for (const [id, row] of chunksAfter) {
        const was = chunksBefore.get(id)!;
        if (row.organization_id !== was.organization_id || row.text_content !== was.text_content) wrong.push(`${id} changed outside the plan`);
        if (withoutManaged(row.metadata) !== withoutManaged(was.metadata)) wrong.push(`${id} unmanaged metadata changed`);
        const touched = touchedChunkIds.has(id);
        if (touched === (row.updated_at === was.updated_at)) wrong.push(`${id} updated_at ${touched ? 'not advanced' : 'moved'}`);
      }
      expect(wrong).toEqual([]);

      // No claim sits on an archived source; every chunk in the baseline joins a
      // source retrieval can read.
      const unreadable = await client.query(
        `select c.chunk_id from pilot.shadow_library_chunks c
           join pilot.shadow_library_sources s on s.source_id = c.source_id
          where c.organization_id = $1
            and not (s.status = 'active' and s.approval_state = 'approved' and s.verification_state = 'verified')`,
        [PLATFORM],
      );
      expect(unreadable.rows).toEqual([]);
      expect(result.spot_check!.map((r) => r.source_title)).toEqual([
        'Quantifying head impacts and neurocognitive performance in collegiate boxers',
      ]);

      // The gym's rows, the documents and every other table are untouched.
      const afterAll = await snapshot(client);
      const changedTables = Object.keys(afterAll).filter((t) => afterAll[t] !== beforeAll[t]).sort();
      expect(changedTables).toEqual(['audit_events', 'shadow_library_chunks', 'shadow_library_sources']);
      expect(await outsidePlatform(client)).toEqual(outsideBefore);

      const audit = await auditRows(client);
      expect(audit).toHaveLength(1);
      expect(audit[0].organization_id).toBe(PLATFORM);
      expect(audit[0].details).toMatchObject({ plan_fingerprint: dry.plan_fingerprint, state_before: 'PRE_REPAIR' });
    } finally {
      await client.end();
    }
  });

  test('a second run reports REPAIRED and writes nothing', async () => {
    const client = await freshDatabase();
    try {
      const dry = await repair(client, dryRun(), { log: silent, plan });
      await repair(client, applyWith(dry.plan_fingerprint), { log: silent, plan });
      const between = await snapshot(client);

      const again = await repair(client, dryRun(), { log: silent, plan });
      expect(again).toMatchObject({ status: 'dry-run', state: 'REPAIRED', would_apply: false, blockers: [] });
      expect(again.plan_fingerprint).not.toBe(dry.plan_fingerprint);
      for (const action of ['repoint', 'retire', 'retier', 'metadata']) {
        expect(again.counts![action]).toMatchObject({ pending: 0, done: plan.expected[action].fields, drifted: 0 });
      }

      const second = await repair(client, applyWith(again.plan_fingerprint), { log: silent, plan });
      expect(second).toMatchObject({ status: 'already-repaired', state: 'REPAIRED' });
      // The old fingerprint names a state that no longer exists.
      const stale = await repair(client, applyWith(dry.plan_fingerprint), { log: silent, plan });
      expect(stale).toMatchObject({ status: 'refused', reason: 'PLAN_FINGERPRINT_MISMATCH' });

      expect(await snapshot(client)).toEqual(between);
      expect(await auditRows(client)).toHaveLength(1);
    } finally {
      await client.end();
    }
  });

  test('pilot-check-library-scope counts the archived rows apart and reports the baseline correctly split', async () => {
    const client = await freshDatabase();
    try {
      const dry = await repair(client, dryRun(), { log: silent, plan });
      await repair(client, applyWith(dry.plan_fingerprint), { log: silent, plan });

      const result = await checkLibraryScope(client);
      const platform = result.corpusByOrg.find((r) => r.organization_id === PLATFORM)!;
      expect(platform).toMatchObject({ corpus_sources: platformExpectedSources, corpus_retired: 213 });
      const platformRow = result.byOrg.find((r) => r.organization_id === PLATFORM);
      const elsewhere = result.corpusByOrg.filter((r) => r.organization_id !== PLATFORM);
      expect(libraryScopeState({
        platformRow, platformCorpus: platform.corpus_sources, elsewhere, expected: platformExpectedSources,
      })).toBe('PRESENT_AND_SPLIT');
    } finally {
      await client.end();
    }
  });

  test('resumes a PARTIAL repair: only what is still pending is written', async () => {
    const client = await freshDatabase();
    try {
      // One repoint and one source tier already in place, as a half-run would leave them.
      const moved = plan.chunks.find((c) => c.fields.some((f) => f.field === 'source_id' && f.before !== f.after))!;
      const to = JSON.parse(moved.fields.find((f) => f.field === 'source_id')!.after!);
      await client.query('update pilot.shadow_library_chunks set source_id = $2 where chunk_id = $1', [moved.chunk_id, to]);
      const tiered = plan.sources.find((s) => s.fields.some((f) => f.field === 'authority_tier' && f.before !== f.after))!;
      const tier = JSON.parse(tiered.fields.find((f) => f.field === 'authority_tier')!.after!);
      await client.query('update pilot.shadow_library_sources set authority_tier = $2 where source_id = $1', [tiered.source_id, tier]);

      const dry = await repair(client, dryRun(), { log: silent, plan });
      expect(dry).toMatchObject({ status: 'dry-run', state: 'PARTIAL', would_apply: true, blockers: [] });
      expect(dry.counts!.repoint).toMatchObject({ pending: 220, done: 1 });

      const result = await repair(client, applyWith(dry.plan_fingerprint), { log: silent, plan });
      expect(result).toMatchObject({ status: 'applied', state_before: 'PARTIAL', state_after: 'REPAIRED' });
      expect(result.written!.chunks_repointed).toBe(220);
      expect((await repair(client, dryRun(), { log: silent, plan })).state).toBe('REPAIRED');
    } finally {
      await client.end();
    }
  });
});

describe('DRIFTED: apply refuses and writes nothing', () => {
  const cases: Array<[string, string, (client: Client) => Promise<void>]> = [
    ['a listed field in neither the before nor the after state', 'FIELD_DRIFTED', async (client) => {
      const tiered = plan.sources.find((s) => s.fields.some((f) => f.field === 'authority_tier' && f.before !== f.after))!;
      const f = tiered.fields.find((x) => x.field === 'authority_tier')!;
      const third = [1, 2, 3, 4].find((t) => String(t) !== f.before && String(t) !== f.after)!;
      await client.query('update pilot.shadow_library_sources set authority_tier = $2 where source_id = $1', [tiered.source_id, third]);
    }],
    ['a repoint target that is no longer approved', 'TARGET_NOT_LIVE', async (client) => {
      await client.query(
        `update pilot.shadow_library_sources
            set approval_state = 'pending_review', verification_state = 'unverified',
                approved_by_account_id = null, approved_at = null, verified_by_account_id = null, verified_at = null
          where source_id = $1`,
        [plan.liveSources[0]],
      );
    }],
    ['a chunk the plan does not know sitting on a source it retires', 'UNPLANNED_CHUNKS_ON_RETIRING_SOURCES', async (client) => {
      const document = (await client.query<{ document_id: string }>(
        'select document_id from pilot.shadow_library_documents where organization_id = $1 order by document_id limit 1', [PLATFORM],
      )).rows[0].document_id;
      await client.query(
        `insert into pilot.shadow_library_chunks (chunk_id, document_id, source_id, organization_id, ordinal, text_content)
         values ('chk_added_after_review', $1, $2, $3, 99999, 'added after the plan was written')`,
        [document, plan.retireIds[0], PLATFORM],
      );
    }],
    ['a listed source that sits in another organization', 'LISTED_ROW_OUTSIDE_PLATFORM', async (client) => {
      await client.query('update pilot.shadow_library_sources set organization_id = $2 where source_id = $1', [plan.retireIds[0], GYM]);
    }],
  ];

  test.each(cases)('%s: %s', async (_label, code, drift) => {
    const client = await freshDatabase();
    try {
      await drift(client);
      const before = await snapshot(client);
      const dry = await repair(client, dryRun(), { log: silent, plan });
      expect(dry).toMatchObject({ status: 'dry-run', state: 'DRIFTED', would_apply: false });
      expect(codes(dry)).toContain(code);

      const result = await repair(client, applyWith(dry.plan_fingerprint), { log: silent, plan });
      expect(result).toMatchObject({ status: 'refused', reason: 'PLAN_DRIFTED' });
      expect(await snapshot(client)).toEqual(before);
    } finally {
      await client.end();
    }
  });
});
