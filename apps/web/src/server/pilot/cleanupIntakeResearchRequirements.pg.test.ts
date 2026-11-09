// Real PostgreSQL coverage for scripts/pilot-cleanup-intake-research-requirements.mjs,
// the owner-gated tool that deletes the research-requirement rows athlete
// intake uploads wrote before PR #1122 (OD-2026-10-02-015 D4;
// OD-2026-10-03-002 section 1, "Delete them all").
//
// The fixture is the full production schema (scripts/lib/full-schema.mjs) with
// two organizations and research rows of every kind the tool must tell apart:
//   - tagged (SHADOW_UPLOAD_CLASSIFIED_AND_ROUTED / shadow_intake), open and
//     resolved, in organization A -- the rows to delete;
//   - a tagged row in organization B;
//   - a SHADOW asker requirement (another source_event_name) in A;
//   - near misses in A: the tag's event name with another entity type, and the
//     tag's entity type with another event name;
//   - a submission linked to a tagged row (it goes too, counted) and one linked
//     to the asker row (it stays).
// Every text column holds a sentinel standing in for a child's file name; no
// output the tool produces may contain it.
//
// Local-only embedded Postgres. The script's run() is called only with a
// connection string this suite built for its own embedded server.

import { type ChildProcessByStdio, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import type { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';

import { Client } from 'pg';

jest.setTimeout(600_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-intake-rr-cleanup-pg-test-${process.pid}-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const FULL_SCHEMA_HELPER_PATH = path.resolve(__dirname, '../../../scripts/lib/full-schema.mjs');
const TOOL_PATH = path.resolve(__dirname, '../../../scripts/pilot-cleanup-intake-research-requirements.mjs');

const TEMPLATE_DB = 'ppbf_intake_rr_cleanup_template';
const ORG_A = 'org-rr-a';
const ORG_B = 'org-rr-b';
const ADMIN = 'acct-rr-admin';
const SOURCE = 'src-rr-1';
const PHRASE = 'DELETE INTAKE RESEARCH REQUIREMENTS';
const OTHER_FINGERPRINT = `sha256:${'e'.repeat(64)}`;
const TAG_EVENT = 'SHADOW_UPLOAD_CLASSIFIED_AND_ROUTED';
const TAG_ENTITY = 'shadow_intake';
// Stands in for a child's name in a saved file name. Must never be printed.
const SENTINEL = 'SENTINEL-CHILD-Avery-Example';

const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

type Result = {
  status: string;
  reason?: string;
  plan_fingerprint?: string;
  counts?: { requirements: number; open: number; resolved: number; linked_submissions: number };
  by_organization?: Array<{ organization_id: string; total: number; open: number; resolved: number }>;
  research_requirement_ids?: string[];
  requirements_deleted?: number;
  submissions_deleted?: number;
  before?: { table_rows_total: number; tagged_in_scope: number };
  after?: { table_rows_total: number; tagged_in_scope: number };
  [key: string]: unknown;
};
type Options = Record<string, unknown>;
type CleanupFn = (client: Client, options: Options, deps?: Record<string, unknown>) => Promise<Result>;
type RunFn = (env: Record<string, string>, argv: string[], deps?: Record<string, unknown>) => Promise<Result>;

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let cleanup: CleanupFn;
let runTool: RunFn;
let databaseCounter = 0;
// The fixture's ids, by role.
const ids: Record<string, string> = {};

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

/** Captures every line the tool logs, as the JSON text it would print. */
function recorder() {
  const lines: string[] = [];
  return {
    lines,
    log: (event: string, payload: Record<string, unknown>) => { lines.push(JSON.stringify({ event, ...payload })); },
    text: () => lines.join('\n'),
  };
}

const scopeA = (): Options => ({ organizationId: ORG_A });
const scopeAll = (): Options => ({ allOrganizations: true });
const dryRun = (scope: Options): Options => ({ apply: false, confirm: '', ...scope });
const applyWith = (scope: Options, expectFingerprint: string | undefined): Options => ({
  apply: true, confirm: PHRASE, expectFingerprint, ...scope,
});

async function insertRequirement(target: Client, row: {
  org: string; event: string; entity: string; entityId: string; status?: 'open' | 'resolved';
}): Promise<string> {
  const resolved = row.status === 'resolved';
  const inserted = await target.query<{ id: string }>(
    `insert into pilot.shadow_research_requirements
       (organization_id, source_event_name, source_entity_type, source_entity_id,
        research_requirement, knowledge_gap, evidence_label, source_status, source_confidence_tier,
        source_verification_state, status, created_by_account_id, created_by_role, metadata,
        subject_id, resolved_at)
     values ($1, $2, $3, $4, $5, $6, 'medical_form', 'unverified', 'SUFFICIENT_FOR_REVIEW', 'unverified',
             $7, $8, 'organization_admin', $9::jsonb, $10, $11)
     returning research_requirement_id::text as id`,
    [
      row.org, row.event, row.entity, row.entityId,
      `Review medical_form (${SENTINEL}-waiver.pdf) and validate routing to intake_review`,
      `Is ${SENTINEL}-waiver.pdf routed correctly?`,
      resolved ? 'resolved' : 'open',
      ADMIN,
      JSON.stringify({ file_name: `${SENTINEL}-waiver.pdf`, note: SENTINEL }),
      `${SENTINEL}-subject`,
      resolved ? new Date().toISOString() : null,
    ],
  );
  return inserted.rows[0].id;
}

async function insertSubmission(target: Client, org: string, submissionId: string, requirementId: string): Promise<void> {
  await target.query(
    `insert into pilot.shadow_research_submissions
       (organization_id, submission_id, research_requirement_id, source_id, provenance,
        submission_note, submitted_by_account_id)
     values ($1, $2, $3, $4, $5::jsonb, $6, $7)`,
    [org, submissionId, requirementId, SOURCE, JSON.stringify({ original_filename: `${SENTINEL}.pdf` }), `note ${SENTINEL}`, ADMIN],
  );
}

async function buildTemplate(target: Client): Promise<void> {
  await target.query(
    `insert into pilot.organizations (organization_id, organization_name, status)
     values ($1, 'RR org A', 'active'), ($2, 'RR org B', 'active')`,
    [ORG_A, ORG_B],
  );
  await target.query(
    `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
     values ($1, 'organization_admin', $2, 'microsoft')`,
    [ADMIN, ORG_A],
  );
  await target.query(
    `insert into pilot.shadow_library_sources
       (source_id, organization_id, title, source_type, authority_tier, status, metadata,
        created_by_account_id, created_by_role)
     values ($1, $2, 'A research source', 'peer_reviewed', 3, 'active', '{}'::jsonb, $3, 'organization_admin')`,
    [SOURCE, ORG_A, ADMIN],
  );
  ids.taggedOpenA = await insertRequirement(target, { org: ORG_A, event: TAG_EVENT, entity: TAG_ENTITY, entityId: 'intake-a-1' });
  ids.taggedResolvedA = await insertRequirement(target, { org: ORG_A, event: TAG_EVENT, entity: TAG_ENTITY, entityId: 'intake-a-2', status: 'resolved' });
  ids.askerA = await insertRequirement(target, { org: ORG_A, event: 'shadow_unanswered_question', entity: 'shadow_asker_question', entityId: 'question-a-1' });
  ids.nearMissEntityA = await insertRequirement(target, { org: ORG_A, event: TAG_EVENT, entity: 'intake_case', entityId: 'intake-a-3' });
  ids.nearMissEventA = await insertRequirement(target, { org: ORG_A, event: 'SHADOW_INTAKE_REVIEWED', entity: TAG_ENTITY, entityId: 'intake-a-4' });
  ids.taggedOpenB = await insertRequirement(target, { org: ORG_B, event: TAG_EVENT, entity: TAG_ENTITY, entityId: 'intake-b-1' });
  await insertSubmission(target, ORG_A, 'sub-on-tagged', ids.taggedOpenA);
  await insertSubmission(target, ORG_A, 'sub-on-asker', ids.askerA);
}

async function freshDatabase(): Promise<{ client: Client; name: string }> {
  databaseCounter += 1;
  const name = `ppbf_intake_rr_cleanup_${databaseCounter}`;
  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  await admin.query(`drop database if exists ${name}`);
  await admin.query(`create database ${name} template ${TEMPLATE_DB}`);
  await admin.end();
  const client = new Client({ connectionString: connectionStringFor(name) });
  await client.connect();
  return { client, name };
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

async function requirementIds(target: Client): Promise<string[]> {
  return (await target.query<{ id: string }>(
    'select research_requirement_id::text as id from pilot.shadow_research_requirements order by research_requirement_id',
  )).rows.map((row) => row.id);
}

async function submissionIds(target: Client): Promise<string[]> {
  return (await target.query<{ id: string }>(
    'select submission_id as id from pilot.shadow_research_submissions order by submission_id',
  )).rows.map((row) => row.id);
}

async function auditRows(target: Client): Promise<Array<{ event_type: string; organization_id: string; entity_type: string; details: Record<string, unknown> }>> {
  return (await target.query(
    `select event_type, organization_id, entity_type, details from pilot.audit_events
      where entity_type = 'intake_research_requirement_cleanup' order by organization_id`,
  )).rows;
}

const sorted = (values: string[]) => [...values].sort((a, b) => Number(a) - Number(b));

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
  cleanup = tool.cleanupIntakeResearchRequirements as CleanupFn;
  runTool = tool.run as RunFn;

  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  await admin.query(`drop database if exists ${TEMPLATE_DB}`);
  await admin.query(`create database ${TEMPLATE_DB} encoding 'UTF8' template template0`);
  await admin.end();

  const template = new Client({ connectionString: connectionStringFor(TEMPLATE_DB) });
  await template.connect();
  try {
    await applyFullSchema(template, { infraDir: INFRA_DIR });
    await buildTemplate(template);
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
  await fs.rm(DATA_DIR, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }).catch(() => {});
});

describe('dry run', () => {
  test('one organization: counts, the open/resolved split and a fingerprint; nothing written; no row text', async () => {
    const { client } = await freshDatabase();
    try {
      const before = await snapshot(client);
      const out = recorder();
      const result = await cleanup(client, dryRun(scopeA()), { log: out.log });
      expect(result.status).toBe('dry-run');
      expect(result.counts).toEqual({ requirements: 2, open: 1, resolved: 1, linked_submissions: 1 });
      expect(result.by_organization).toEqual([{ organization_id: ORG_A, total: 2, open: 1, resolved: 1 }]);
      expect(sorted(result.research_requirement_ids!)).toEqual(sorted([ids.taggedOpenA, ids.taggedResolvedA]));
      expect(result.table_rows_total).toBe(6);
      expect(result.plan_fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(result.created_at_range).toEqual({ earliest: expect.any(String), latest: expect.any(String) });
      expect(out.text()).toContain(result.plan_fingerprint!);
      expect(out.text()).toContain('sub-on-tagged');
      expect(out.text()).not.toContain('sub-on-asker');
      expect(out.text()).not.toContain(SENTINEL);
      expect(await snapshot(client)).toEqual(before);
    } finally {
      await client.end();
    }
  });

  test('all organizations: both organizations counted, a different fingerprint', async () => {
    const { client } = await freshDatabase();
    try {
      const out = recorder();
      const a = await cleanup(client, dryRun(scopeA()), { log: () => {} });
      const all = await cleanup(client, dryRun(scopeAll()), { log: out.log });
      expect(all.counts).toEqual({ requirements: 3, open: 2, resolved: 1, linked_submissions: 1 });
      expect(all.by_organization).toEqual([
        { organization_id: ORG_A, total: 2, open: 1, resolved: 1 },
        { organization_id: ORG_B, total: 1, open: 1, resolved: 0 },
      ]);
      expect(all.plan_fingerprint).not.toBe(a.plan_fingerprint);
      expect(out.text()).not.toContain(SENTINEL);
    } finally {
      await client.end();
    }
  });

  test('the same rows give the same fingerprint; a status flip changes it', async () => {
    const { client } = await freshDatabase();
    try {
      const first = await cleanup(client, dryRun(scopeA()), { log: () => {} });
      const second = await cleanup(client, dryRun(scopeA()), { log: () => {} });
      expect(second.plan_fingerprint).toBe(first.plan_fingerprint);
      await client.query(
        "update pilot.shadow_research_requirements set status = 'resolved', resolved_at = now() where research_requirement_id = $1",
        [ids.taggedOpenA],
      );
      const third = await cleanup(client, dryRun(scopeA()), { log: () => {} });
      expect(third.plan_fingerprint).not.toBe(first.plan_fingerprint);
    } finally {
      await client.end();
    }
  });
});

describe('apply', () => {
  test('one organization, reviewed fingerprint: exactly its tagged rows and their submission go; everything else stays', async () => {
    const { client } = await freshDatabase();
    try {
      const dry = await cleanup(client, dryRun(scopeA()), { log: () => {} });
      const before = await snapshot(client);
      const out = recorder();
      const result = await cleanup(client, applyWith(scopeA(), dry.plan_fingerprint), { log: out.log });

      expect(result.status).toBe('applied');
      expect(result.requirements_deleted).toBe(2);
      expect(result.submissions_deleted).toBe(1);
      expect(result.before).toEqual({ table_rows_total: 6, tagged_in_scope: 2 });
      expect(result.after).toEqual({ table_rows_total: 4, tagged_in_scope: 0 });
      expect(sorted(await requirementIds(client))).toEqual(sorted([ids.askerA, ids.nearMissEntityA, ids.nearMissEventA, ids.taggedOpenB]));
      expect(await submissionIds(client)).toEqual(['sub-on-asker']);

      const after = await snapshot(client);
      const changed = Object.keys(after).filter((t) => after[t] !== before[t]).sort();
      expect(changed).toEqual(['audit_events', 'shadow_research_requirements', 'shadow_research_submissions']);

      const audit = await auditRows(client);
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ event_type: 'data_purged', organization_id: ORG_A });
      expect(audit[0].details).toMatchObject({
        plan_fingerprint: dry.plan_fingerprint,
        scope: { organization_id: ORG_A },
        requirements_deleted: 2,
        open_deleted: 1,
        resolved_deleted: 1,
        submissions_deleted: 1,
        submission_ids: ['sub-on-tagged'],
      });
      expect(sorted(audit[0].details.research_requirement_ids as string[])).toEqual(sorted([ids.taggedOpenA, ids.taggedResolvedA]));
      expect(JSON.stringify(audit)).not.toContain(SENTINEL);
      expect(out.text()).not.toContain(SENTINEL);
    } finally {
      await client.end();
    }
  });

  test('all organizations: every tagged row goes, one audit row per organization', async () => {
    const { client } = await freshDatabase();
    try {
      const dry = await cleanup(client, dryRun(scopeAll()), { log: () => {} });
      const out = recorder();
      const result = await cleanup(client, applyWith(scopeAll(), dry.plan_fingerprint), { log: out.log });
      expect(result.status).toBe('applied');
      expect(result.requirements_deleted).toBe(3);
      expect(sorted(await requirementIds(client))).toEqual(sorted([ids.askerA, ids.nearMissEntityA, ids.nearMissEventA]));
      const audit = await auditRows(client);
      expect(audit.map((row) => [row.organization_id, row.details.requirements_deleted])).toEqual([[ORG_A, 2], [ORG_B, 1]]);
      expect((audit[1].details.research_requirement_ids as string[])).toEqual([ids.taggedOpenB]);
      expect(out.text()).not.toContain(SENTINEL);
    } finally {
      await client.end();
    }
  });

  test('a second apply of the same plan refuses: the rows it reviewed are gone', async () => {
    const { client } = await freshDatabase();
    try {
      const dry = await cleanup(client, dryRun(scopeA()), { log: () => {} });
      await cleanup(client, applyWith(scopeA(), dry.plan_fingerprint), { log: () => {} });
      const again = await cleanup(client, applyWith(scopeA(), dry.plan_fingerprint), { log: () => {} });
      expect(again).toMatchObject({ status: 'refused', reason: 'PLAN_FINGERPRINT_MISMATCH' });
      const empty = await cleanup(client, dryRun(scopeA()), { log: () => {} });
      expect(empty.counts).toEqual({ requirements: 0, open: 0, resolved: 0, linked_submissions: 0 });
      const before = await snapshot(client);
      const nothing = await cleanup(client, applyWith(scopeA(), empty.plan_fingerprint), { log: () => {} });
      expect(nothing.status).toBe('nothing-to-delete');
      expect(await snapshot(client)).toEqual(before);
    } finally {
      await client.end();
    }
  });
});

describe('refusals write nothing', () => {
  async function refusesUnchanged(options: Options, reason: string, prepare?: (c: Client) => Promise<void>) {
    const { client } = await freshDatabase();
    try {
      if (prepare) await prepare(client);
      const before = await snapshot(client);
      const out = recorder();
      const result = await cleanup(client, options, { log: out.log });
      expect(result).toMatchObject({ status: 'refused', reason });
      expect(await snapshot(client)).toEqual(before);
      expect(out.text()).not.toContain(SENTINEL);
    } finally {
      await client.end();
    }
  }

  test('a wrong fingerprint', async () => {
    await refusesUnchanged(applyWith(scopeA(), OTHER_FINGERPRINT), 'PLAN_FINGERPRINT_MISMATCH');
  });

  test("one organization's fingerprint used for all organizations", async () => {
    const { client } = await freshDatabase();
    let fingerprint: string;
    try {
      fingerprint = (await cleanup(client, dryRun(scopeA()), { log: () => {} })).plan_fingerprint!;
    } finally {
      await client.end();
    }
    await refusesUnchanged(applyWith(scopeAll(), fingerprint), 'PLAN_FINGERPRINT_MISMATCH');
  });

  test('a row tagged after the review', async () => {
    const { client } = await freshDatabase();
    let fingerprint: string;
    try {
      fingerprint = (await cleanup(client, dryRun(scopeA()), { log: () => {} })).plan_fingerprint!;
    } finally {
      await client.end();
    }
    await refusesUnchanged(applyWith(scopeA(), fingerprint), 'PLAN_FINGERPRINT_MISMATCH', async (c) => {
      await insertRequirement(c, { org: ORG_A, event: TAG_EVENT, entity: TAG_ENTITY, entityId: 'intake-a-late' });
    });
  });

  test('a submission linked after the review', async () => {
    const { client } = await freshDatabase();
    let fingerprint: string;
    try {
      fingerprint = (await cleanup(client, dryRun(scopeA()), { log: () => {} })).plan_fingerprint!;
    } finally {
      await client.end();
    }
    await refusesUnchanged(applyWith(scopeA(), fingerprint), 'PLAN_FINGERPRINT_MISMATCH', async (c) => {
      await insertSubmission(c, ORG_A, 'sub-late', ids.taggedResolvedA);
    });
  });

  test.each([
    ['no confirm phrase', { apply: true, confirm: '', expectFingerprint: OTHER_FINGERPRINT, organizationId: ORG_A }, 'APPLY_WITHOUT_CONFIRM_PHRASE'],
    ['the phrase in lower case', { apply: true, confirm: PHRASE.toLowerCase(), expectFingerprint: OTHER_FINGERPRINT, organizationId: ORG_A }, 'APPLY_WITHOUT_CONFIRM_PHRASE'],
    ['no fingerprint', { apply: true, confirm: PHRASE, organizationId: ORG_A }, 'APPLY_WITHOUT_EXPECTED_FINGERPRINT'],
    ['a malformed fingerprint', { apply: true, confirm: PHRASE, expectFingerprint: 'sha256:abc', organizationId: ORG_A }, 'INVALID_EXPECTED_FINGERPRINT'],
    ['apply as a string', { apply: 'true', confirm: PHRASE, expectFingerprint: OTHER_FINGERPRINT, organizationId: ORG_A }, 'INVALID_APPLY'],
    ['no scope', { apply: false }, 'ORGANIZATION_SCOPE_REQUIRED'],
    ['both scopes', { apply: false, organizationId: ORG_A, allOrganizations: true }, 'ORGANIZATION_SCOPE_AMBIGUOUS'],
    ['an empty organization', { apply: false, organizationId: '' }, 'INVALID_ORGANIZATION'],
    ['an unknown organization', { apply: false, organizationId: 'org-rr-missing' }, 'ORGANIZATION_NOT_FOUND'],
  ])('%s', async (_label, options, reason) => {
    await refusesUnchanged(options as Options, reason);
  });

  test('input refusals are decided before any statement', async () => {
    const query = jest.fn();
    const result = await cleanup({ query } as unknown as Client, { apply: true, confirm: '', organizationId: ORG_A }, { log: () => {} });
    expect(result).toMatchObject({ status: 'refused', reason: 'APPLY_WITHOUT_CONFIRM_PHRASE' });
    expect(query).not.toHaveBeenCalled();
  });
});

describe('run(): the command line and the target check', () => {
  function envFor(database: string, overrides: Record<string, string> = {}): Record<string, string> {
    return {
      AZURE_POSTGRES_CONNECTION_STRING: connectionStringFor(database),
      PPBF_EXPECTED_POSTGRES_HOSTNAME: 'localhost',
      PPBF_EXPECTED_POSTGRES_DATABASE: database,
      ...overrides,
    };
  }

  test.each([
    ['a mismatched hostname', { PPBF_EXPECTED_POSTGRES_HOSTNAME: 'ppbf-pg-195892.postgres.database.azure.com' }, 'POSTGRES_TARGET_MISMATCH'],
    ['a mismatched database', { PPBF_EXPECTED_POSTGRES_DATABASE: 'postgres' }, 'POSTGRES_TARGET_MISMATCH'],
    ['no declared hostname', { PPBF_EXPECTED_POSTGRES_HOSTNAME: '' }, 'MISSING_PPBF_EXPECTED_POSTGRES_HOSTNAME'],
    ['no connection string', { AZURE_POSTGRES_CONNECTION_STRING: '' }, 'MISSING_CONNECTION_STRING'],
  ])('refuses %s before a client is created', async (_label, overrides, reason) => {
    const createClient = jest.fn();
    const result = await runTool(envFor('unused', overrides), ['--all-organizations'], { createClient, log: () => {} });
    expect(result).toMatchObject({ status: 'refused', reason });
    expect(createClient).not.toHaveBeenCalled();
  });

  test.each([
    ['no scope', []],
    ['both scopes', ['--organization', ORG_A, '--all-organizations']],
    ['an unknown argument', ['--organisation', ORG_A]],
    ['--organization with no value', ['--organization']],
    ['--organization followed by a flag', ['--organization', '--all-organizations']],
  ])('refuses %s before a client is created', async (_label, argv) => {
    const createClient = jest.fn();
    const result = await runTool(envFor('unused'), argv as string[], { createClient, log: () => {} });
    expect(result.status).toBe('refused');
    expect(createClient).not.toHaveBeenCalled();
  });

  test('end to end on this suite\'s own database: dry run, then apply with the reviewed fingerprint', async () => {
    const { client, name } = await freshDatabase();
    await client.end();
    const out = recorder();
    const dry = await runTool(envFor(name), ['--organization', ORG_A], { log: out.log });
    expect(dry.status).toBe('dry-run');
    const applied = await runTool(envFor(name, {
      PPBF_INTAKE_RR_CLEANUP_APPLY: 'true',
      PPBF_INTAKE_RR_CLEANUP_CONFIRM: PHRASE,
      PPBF_INTAKE_RR_CLEANUP_EXPECT_FINGERPRINT: dry.plan_fingerprint!,
    }), ['--organization', ORG_A], { log: out.log });
    expect(applied).toMatchObject({ status: 'applied', requirements_deleted: 2, submissions_deleted: 1 });
    expect(out.text()).not.toContain(SENTINEL);
  });

  test("PPBF_INTAKE_RR_CLEANUP_APPLY other than exactly 'true' is a dry run", async () => {
    const { client, name } = await freshDatabase();
    try {
      const before = await snapshot(client);
      const result = await runTool(envFor(name, {
        PPBF_INTAKE_RR_CLEANUP_APPLY: 'TRUE',
        PPBF_INTAKE_RR_CLEANUP_CONFIRM: PHRASE,
        PPBF_INTAKE_RR_CLEANUP_EXPECT_FINGERPRINT: OTHER_FINGERPRINT,
      }), ['--all-organizations'], { log: () => {} });
      expect(result.status).toBe('dry-run');
      expect(await snapshot(client)).toEqual(before);
    } finally {
      await client.end();
    }
  });
});
