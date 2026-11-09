// Real PostgreSQL coverage for scripts/pilot-redact-intake-upload-audit.mjs, the
// owner-gated tool that redacts the intake file names held in the
// 'shadow_research_upload_requirement' audit rows athlete intake uploads wrote
// before PR #1122 (Jason 2026-11-09, "Redact the names"; OD-2026-10-02-015 D4;
// OD-2026-10-03-002 section 1).
//
// The fixture is the full production schema (scripts/lib/full-schema.mjs) with
// two organizations and audit rows of every kind the tool must tell apart:
//   - tagged rows in organization A (one as the writer wrote it, one with no
//     research_requirement key) -- the rows to redact (stamp);
//   - a tagged row already redacted (has redacted_at), in A;
//   - a shadow_classification row in A carrying file_name AND the tag keys;
//   - a tagged row in organization B, and one with no organization;
//   - an unrelated 'update' row in A with a research_requirement key;
//   - a near miss in A: the right event_type and event name, another entity type.
// Every text value holds a sentinel standing in for a child's file name; no
// output the tool produces may contain it. Only research_requirement carried the
// name (git show 40df6e742^); knowledge_gap must survive byte for byte, and its
// sentinel proves the tool never prints it either.
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
const DATA_DIR = path.join(os.tmpdir(), `ppbf-intake-audit-redact-pg-test-${process.pid}-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const FULL_SCHEMA_HELPER_PATH = path.resolve(__dirname, '../../../scripts/lib/full-schema.mjs');
const TOOL_PATH = path.resolve(__dirname, '../../../scripts/pilot-redact-intake-upload-audit.mjs');

const TEMPLATE_DB = 'ppbf_intake_audit_redact_template';
const ORG_A = 'org-ar-a';
const ORG_B = 'org-ar-b';
const PHRASE = 'REDACT INTAKE UPLOAD AUDIT ROWS';
const MARKER = "[redacted 2026-11-09: intake file name; Jason 2026-11-09 'Redact the names']";
const OTHER_FINGERPRINT = `sha256:${'e'.repeat(64)}`;
const EVENT = 'shadow_research_upload_requirement';
const TAG_EVENT = 'SHADOW_UPLOAD_CLASSIFIED_AND_ROUTED';
const TAG_ENTITY = 'shadow_intake';
// Stands in for a child's name in a saved file name. Must never be printed.
const SENTINEL = 'SENTINEL-CHILD-Avery-Example';

const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

type Counts = { in_scope_unredacted: number; already_redacted_in_scope: number; event_type_total: number };
type Result = {
  status: string;
  reason?: string;
  plan_fingerprint?: string;
  counts?: Counts;
  by_organization?: Array<{ organization_id: string | null; rows: number }>;
  audit_ids?: string[];
  rows_redacted?: number;
  redacted_at?: string;
  before?: Counts;
  after?: Counts;
  mismatches?: string[];
  [key: string]: unknown;
};
type Options = Record<string, unknown>;
type RedactFn = (client: Client, options: Options, deps?: Record<string, unknown>) => Promise<Result>;
type RunFn = (env: Record<string, string>, argv: string[], deps?: Record<string, unknown>) => Promise<Result>;
type Details = Record<string, unknown>;

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let redact: RedactFn;
let runTool: RunFn;
let databaseCounter = 0;
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

/** The details the removed upload writer wrote (git show 40df6e742^), sentinel in the text. */
function uploadDetails(n: string, overrides: Details = {}): Details {
  return {
    source_event_name: TAG_EVENT,
    source_entity_type: TAG_ENTITY,
    source_entity_id: `intake-${n}`,
    intake_case_id: `case-${n}`,
    intake_document_id: `doc-${n}`,
    document_type: 'medical_form',
    classification: 'Unclassified',
    routed_queue: 'Admin SHADOW Queue',
    research_requirement: `Review medical_form (${SENTINEL}-waiver-${n}.pdf) and validate routing to Admin SHADOW Queue.`,
    knowledge_gap: `Source intent ${SENTINEL} is unclassified and requires manual triage.`,
    source_status: 'observed',
    source_verification_state: 'unverified',
    ...overrides,
  };
}

async function insertAudit(target: Client, row: { event: string; org: string | null; entity?: string; details: Details }): Promise<string> {
  return (await target.query<{ id: string }>(
    `insert into pilot.audit_events (event_type, actor_account_id, actor_role, organization_id, entity_type, entity_id, details)
     values ($1, 'acct-ar-admin', 'organization_admin', $2, $3, '42', $4::jsonb)
     returning audit_id::text as id`,
    [row.event, row.org, row.entity ?? 'shadow_research_requirement', JSON.stringify(row.details)],
  )).rows[0].id;
}

async function buildTemplate(target: Client): Promise<void> {
  await target.query(
    `insert into pilot.organizations (organization_id, organization_name, status)
     values ($1, 'AR org A', 'active'), ($2, 'AR org B', 'active')`,
    [ORG_A, ORG_B],
  );
  ids.taggedBothA = await insertAudit(target, { event: EVENT, org: ORG_A, details: uploadDetails('a1') });
  const noRequirement = uploadDetails('a2');
  delete noRequirement.research_requirement;
  ids.taggedNoRequirementA = await insertAudit(target, { event: EVENT, org: ORG_A, details: noRequirement });
  ids.alreadyRedactedA = await insertAudit(target, { event: EVENT, org: ORG_A, details: uploadDetails('a3', { redacted_at: '2026-11-01T00:00:00.000Z' }) });
  ids.classificationA = await insertAudit(target, {
    event: 'shadow_classification', org: ORG_A, entity: 'shadow_intake',
    details: { ...uploadDetails('a4'), file_name: `${SENTINEL}-waiver-a4.pdf` },
  });
  ids.unrelatedUpdateA = await insertAudit(target, {
    event: 'update', org: ORG_A, entity: 'something_else',
    details: { research_requirement: `${SENTINEL} unrelated`, knowledge_gap: SENTINEL },
  });
  ids.nearMissEntityA = await insertAudit(target, { event: EVENT, org: ORG_A, details: uploadDetails('a5', { source_entity_type: 'intake_case' }) });
  ids.taggedB = await insertAudit(target, { event: EVENT, org: ORG_B, details: uploadDetails('b1') });
  ids.taggedNoOrg = await insertAudit(target, { event: EVENT, org: null, details: uploadDetails('n1') });
}

async function freshDatabase(): Promise<{ client: Client; name: string }> {
  databaseCounter += 1;
  const name = `ppbf_intake_audit_redact_${databaseCounter}`;
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

/** Every audit row's details, as the database's own text (byte for byte), by audit_id. */
async function detailsText(target: Client): Promise<Record<string, string>> {
  const rows = (await target.query<{ id: string; t: string }>(
    'select audit_id::text as id, details::text as t from pilot.audit_events order by audit_id',
  )).rows;
  return Object.fromEntries(rows.map((row) => [row.id, row.t]));
}

async function detailsOf(target: Client, id: string): Promise<Details> {
  return (await target.query<{ details: Details }>('select details from pilot.audit_events where audit_id = $1', [id])).rows[0].details;
}

async function recordRows(target: Client): Promise<Array<{ event_type: string; organization_id: string | null; entity_id: string; details: Details }>> {
  return (await target.query(
    `select event_type, organization_id, entity_id, details from pilot.audit_events
      where entity_type = 'audit_details_redaction' order by entity_id`,
  )).rows;
}

const sorted = (values: string[]) => [...values].sort((a, b) => Number(a) - Number(b));
const without = (details: Details, ...keys: string[]) => Object.fromEntries(Object.entries(details).filter(([k]) => !keys.includes(k)));

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
  redact = tool.redactIntakeUploadAudit as RedactFn;
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
  test('one organization: ids, counts and a fingerprint; nothing written; no row text', async () => {
    const { client } = await freshDatabase();
    try {
      const before = await snapshot(client);
      const out = recorder();
      const result = await redact(client, dryRun(scopeA()), { log: out.log });
      expect(result.status).toBe('dry-run');
      expect(sorted(result.audit_ids!)).toEqual(sorted([ids.taggedBothA, ids.taggedNoRequirementA]));
      expect(result.counts).toEqual({ in_scope_unredacted: 2, already_redacted_in_scope: 1, event_type_total: 6 });
      expect(result.by_organization).toEqual([{ organization_id: ORG_A, rows: 2 }]);
      expect(result.plan_fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(result.created_at_range).toEqual({ earliest: expect.any(String), latest: expect.any(String) });
      expect(out.text()).toContain(result.plan_fingerprint!);
      expect(out.text()).not.toContain(SENTINEL);
      expect(await snapshot(client)).toEqual(before);
    } finally {
      await client.end();
    }
  });

  test('all organizations: B and the row with no organization too, a different fingerprint', async () => {
    const { client } = await freshDatabase();
    try {
      const out = recorder();
      const a = await redact(client, dryRun(scopeA()), { log: () => {} });
      const all = await redact(client, dryRun(scopeAll()), { log: out.log });
      expect(sorted(all.audit_ids!)).toEqual(sorted([ids.taggedBothA, ids.taggedNoRequirementA, ids.taggedB, ids.taggedNoOrg]));
      expect(all.by_organization).toEqual([{ organization_id: null, rows: 1 }, { organization_id: ORG_A, rows: 2 }, { organization_id: ORG_B, rows: 1 }]);
      expect(all.plan_fingerprint).not.toBe(a.plan_fingerprint);
      expect(out.text()).not.toContain(SENTINEL);
    } finally {
      await client.end();
    }
  });

  test('a dry run issues only a read-only transaction and no write statement', async () => {
    const { client } = await freshDatabase();
    try {
      const statements: string[] = [];
      const recording = {
        query: (text: string, values?: unknown[]) => {
          statements.push(text);
          return client.query(text, values);
        },
      };
      const result = await redact(recording as unknown as Client, dryRun(scopeAll()), { log: () => {} });
      expect(result.status).toBe('dry-run');
      expect(statements[0]).toBe('begin transaction read only');
      expect(statements.filter((text) => /^\s*(update|insert|delete)\b/i.test(text))).toEqual([]);
    } finally {
      await client.end();
    }
  });

  test('the same rows give the same fingerprint; a key removed from a planned row changes it', async () => {
    const { client } = await freshDatabase();
    try {
      const first = await redact(client, dryRun(scopeA()), { log: () => {} });
      const second = await redact(client, dryRun(scopeA()), { log: () => {} });
      expect(second.plan_fingerprint).toBe(first.plan_fingerprint);
      await client.query("update pilot.audit_events set details = details - 'research_requirement' where audit_id = $1", [ids.taggedBothA]);
      const third = await redact(client, dryRun(scopeA()), { log: () => {} });
      expect(third.plan_fingerprint).not.toBe(first.plan_fingerprint);
    } finally {
      await client.end();
    }
  });
});

describe('apply', () => {
  test('one organization, reviewed fingerprint: exactly its unredacted tagged rows change, and only research_requirement plus two added keys', async () => {
    const { client } = await freshDatabase();
    try {
      const originalBoth = await detailsOf(client, ids.taggedBothA);
      const originalNone = await detailsOf(client, ids.taggedNoRequirementA);
      const dry = await redact(client, dryRun(scopeA()), { log: () => {} });
      const beforeText = await detailsText(client);
      const beforeTables = await snapshot(client);
      const out = recorder();
      const result = await redact(client, applyWith(scopeA(), dry.plan_fingerprint), { log: out.log });

      expect(result.status).toBe('applied');
      expect(result.rows_redacted).toBe(2);
      expect(result.redacted_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      expect(result.before).toEqual({ in_scope_unredacted: 2, already_redacted_in_scope: 1, event_type_total: 6 });
      expect(result.after).toEqual({ in_scope_unredacted: 0, already_redacted_in_scope: 3, event_type_total: 6 });

      const both = await detailsOf(client, ids.taggedBothA);
      expect(both.research_requirement).toBe(MARKER);
      expect(both.knowledge_gap).toBe(originalBoth.knowledge_gap);
      expect(both.redacted_at).toBe(result.redacted_at);
      expect(both.redacted_fields).toEqual(['research_requirement']);
      expect(without(both, 'research_requirement', 'redacted_at', 'redacted_fields'))
        .toEqual(without(originalBoth, 'research_requirement'));
      const none = await detailsOf(client, ids.taggedNoRequirementA);
      expect('research_requirement' in none).toBe(false);
      expect(none.redacted_at).toBe(result.redacted_at);
      expect(none.redacted_fields).toEqual([]);
      expect(without(none, 'redacted_at', 'redacted_fields')).toEqual(originalNone);
      // Byte for byte, as the database holds it: the kept keys' text is unchanged.
      const kept = await client.query<{ same: boolean }>(
        `select (details - 'research_requirement' - 'redacted_at' - 'redacted_fields')::text
                  = ($2::jsonb - 'research_requirement')::text as same
           from pilot.audit_events where audit_id = $1`,
        [ids.taggedBothA, JSON.stringify(originalBoth)],
      );
      expect(kept.rows[0].same).toBe(true);

      // Every row that was there and not planned is byte for byte the same.
      const afterText = await detailsText(client);
      for (const id of Object.keys(beforeText).filter((k) => ![ids.taggedBothA, ids.taggedNoRequirementA].includes(k))) {
        expect([id, afterText[id]]).toEqual([id, beforeText[id]]);
      }
      expect(afterText[ids.classificationA]).toContain(SENTINEL);

      const afterTables = await snapshot(client);
      expect(Object.keys(afterTables).filter((t) => afterTables[t] !== beforeTables[t])).toEqual(['audit_events']);

      const records = await recordRows(client);
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({ event_type: 'update', organization_id: ORG_A, entity_id: ORG_A });
      expect(records[0].details).toMatchObject({
        plan_fingerprint: dry.plan_fingerprint,
        scope: { organization_id: ORG_A },
        rows_redacted: 2,
        redacted_at: result.redacted_at,
        ruling: expect.stringContaining('Redact the names'),
      });
      expect(sorted(records[0].details.redacted_audit_ids as string[])).toEqual(sorted([ids.taggedBothA, ids.taggedNoRequirementA]));
      expect(JSON.stringify(records)).not.toContain(SENTINEL);
      expect(out.text()).not.toContain(SENTINEL);

      // Idempotent: a second dry run finds nothing; the old plan refuses.
      const again = await redact(client, dryRun(scopeA()), { log: () => {} });
      expect(again.counts?.in_scope_unredacted).toBe(0);
      expect(await redact(client, applyWith(scopeA(), dry.plan_fingerprint), { log: () => {} }))
        .toMatchObject({ status: 'refused', reason: 'PLAN_FINGERPRINT_MISMATCH' });
      const quiet = await snapshot(client);
      expect((await redact(client, applyWith(scopeA(), again.plan_fingerprint), { log: () => {} })).status).toBe('nothing-to-redact');
      expect(await snapshot(client)).toEqual(quiet);
    } finally {
      await client.end();
    }
  });

  test('all organizations: every unredacted tagged row, one record per organization (and one for rows with none)', async () => {
    const { client } = await freshDatabase();
    try {
      const dry = await redact(client, dryRun(scopeAll()), { log: () => {} });
      const out = recorder();
      const result = await redact(client, applyWith(scopeAll(), dry.plan_fingerprint), { log: out.log });
      expect(result).toMatchObject({ status: 'applied', rows_redacted: 4 });
      for (const id of [ids.taggedB, ids.taggedNoOrg]) {
        expect((await detailsOf(client, id)).research_requirement).toBe(MARKER);
      }
      const records = await recordRows(client);
      expect(records.map((row) => [row.entity_id, row.organization_id, row.details.rows_redacted])).toEqual([
        ['no-organization', null, 1],
        [ORG_A, ORG_A, 2],
        [ORG_B, ORG_B, 1],
      ]);
      expect((await redact(client, dryRun(scopeAll()), { log: () => {} })).counts?.in_scope_unredacted).toBe(0);
      expect(out.text()).not.toContain(SENTINEL);
    } finally {
      await client.end();
    }
  });

  test('a failure after the update rolls everything back, and its message is not printed', async () => {
    const { client, name } = await freshDatabase();
    try {
      await client.query(`
        create function pilot.ar_test_refuse_record() returns trigger language plpgsql as $$
        begin
          if new.entity_type = 'audit_details_redaction' then
            raise exception 'refused %', '${SENTINEL}' using detail = '${SENTINEL}';
          end if;
          return new;
        end $$;
        create trigger ar_test_refuse_record before insert on pilot.audit_events
          for each row execute function pilot.ar_test_refuse_record();`);
      const dry = await redact(client, dryRun(scopeA()), { log: () => {} });
      const before = await snapshot(client);
      const out = recorder();
      const result = await runTool({
        AZURE_POSTGRES_CONNECTION_STRING: connectionStringFor(name),
        PPBF_EXPECTED_POSTGRES_HOSTNAME: 'localhost',
        PPBF_EXPECTED_POSTGRES_DATABASE: name,
        PPBF_INTAKE_AUDIT_REDACT_APPLY: 'true',
        PPBF_INTAKE_AUDIT_REDACT_CONFIRM: PHRASE,
        PPBF_INTAKE_AUDIT_REDACT_EXPECT_FINGERPRINT: dry.plan_fingerprint!,
      }, ['--organization', ORG_A], { log: out.log });
      expect(result).toMatchObject({ status: 'failed', code: 'P0001' });
      expect(await snapshot(client)).toEqual(before);
      expect(out.text()).toContain('"failed"');
      expect(out.text()).not.toContain(SENTINEL);
    } finally {
      await client.end();
    }
  });

  test('a change to any other key during the update is caught and rolled back', async () => {
    const { client } = await freshDatabase();
    try {
      // Stands in for any write path that would alter a kept key.
      await client.query(`
        create function pilot.ar_test_touch_key() returns trigger language plpgsql as $$
        begin
          new.details := new.details || '{"document_type": "changed"}'::jsonb;
          return new;
        end $$;
        create trigger ar_test_touch_key before update on pilot.audit_events
          for each row execute function pilot.ar_test_touch_key();`);
      const dry = await redact(client, dryRun(scopeA()), { log: () => {} });
      const before = await snapshot(client);
      const out = recorder();
      const result = await redact(client, applyWith(scopeA(), dry.plan_fingerprint), { log: out.log });
      expect(result).toMatchObject({ status: 'refused', reason: 'END_STATE_MISMATCH', mismatches: ['rows_with_other_keys_changed=2'] });
      expect(await snapshot(client)).toEqual(before);
      expect(out.text()).not.toContain(SENTINEL);
    } finally {
      await client.end();
    }
  });

  test.each([
    ['the name put back', "case when old.details ? 'research_requirement' then jsonb_build_object('research_requirement', old.details->'research_requirement') else '{}'::jsonb end", 'rows_with_text_left=1'],
    ['another stamp', `'{"redacted_at": "1999-01-01T00:00:00.000Z"}'::jsonb`, 'rows_without_this_stamp=2'],
    ['a wrong redacted_fields', `'{"redacted_fields": ["x"]}'::jsonb`, 'rows_with_wrong_redacted_fields=2'],
  ])('an update that leaves %s is caught and rolled back', async (_label, patch, mismatch) => {
    const { client } = await freshDatabase();
    try {
      await client.query(`
        create function pilot.ar_test_undo() returns trigger language plpgsql as $$
        begin
          new.details := new.details || ${patch};
          return new;
        end $$;
        create trigger ar_test_undo before update on pilot.audit_events
          for each row execute function pilot.ar_test_undo();`);
      const dry = await redact(client, dryRun(scopeA()), { log: () => {} });
      const before = await snapshot(client);
      const out = recorder();
      const result = await redact(client, applyWith(scopeA(), dry.plan_fingerprint), { log: out.log });
      expect(result).toMatchObject({ status: 'refused', reason: 'END_STATE_MISMATCH' });
      expect(result.mismatches).toContain(mismatch);
      expect(await snapshot(client)).toEqual(before);
      expect(out.text()).not.toContain(SENTINEL);
    } finally {
      await client.end();
    }
  });

  test('apply plans with the rows locked: a key-share lock held elsewhere stops it before any write', async () => {
    const { client, name } = await freshDatabase();
    const holder = new Client({ connectionString: connectionStringFor(name) });
    await holder.connect();
    try {
      const dry = await redact(client, dryRun(scopeA()), { log: () => {} });
      // FOR KEY SHARE conflicts with the plan's FOR UPDATE but not with the
      // UPDATE's own lock, so only a locked plan waits here.
      await holder.query('begin');
      await holder.query('select 1 from pilot.audit_events where audit_id = $1 for key share', [ids.taggedBothA]);
      const before = await snapshot(client);
      await expect(redact(client, applyWith(scopeA(), dry.plan_fingerprint), { log: () => {} }))
        .rejects.toMatchObject({ code: '55P03' });
      await holder.query('rollback');
      expect(await snapshot(client)).toEqual(before);
    } finally {
      await holder.end();
      await client.end();
    }
  });

  test('an update that touches fewer rows than planned refuses and rolls back', async () => {
    const { client } = await freshDatabase();
    try {
      await client.query(`
        create function pilot.ar_test_skip() returns trigger language plpgsql as $$
        begin
          if old.details->>'source_entity_id' = 'intake-a2' then return null; end if;
          return new;
        end $$;
        create trigger ar_test_skip before update on pilot.audit_events
          for each row execute function pilot.ar_test_skip();`);
      const dry = await redact(client, dryRun(scopeA()), { log: () => {} });
      const before = await snapshot(client);
      const result = await redact(client, applyWith(scopeA(), dry.plan_fingerprint), { log: () => {} });
      expect(result).toMatchObject({ status: 'refused', reason: 'UPDATE_COUNT_MISMATCH', planned: 2, updated: 1 });
      expect(await snapshot(client)).toEqual(before);
    } finally {
      await client.end();
    }
  });

  test('a tagged row that appears during the apply is caught by the end-state check', async () => {
    const { client } = await freshDatabase();
    try {
      await client.query(`
        create function pilot.ar_test_late_row() returns trigger language plpgsql as $$
        begin
          insert into pilot.audit_events (event_type, organization_id, entity_type, entity_id, details)
          values ('shadow_research_upload_requirement', '${ORG_A}', 'shadow_research_requirement', '43',
                  '{"source_event_name": "${TAG_EVENT}", "source_entity_type": "${TAG_ENTITY}"}'::jsonb);
          return null;
        end $$;
        create trigger ar_test_late_row after update on pilot.audit_events
          for each statement execute function pilot.ar_test_late_row();`);
      const dry = await redact(client, dryRun(scopeA()), { log: () => {} });
      const before = await snapshot(client);
      const result = await redact(client, applyWith(scopeA(), dry.plan_fingerprint), { log: () => {} });
      expect(result).toMatchObject({ status: 'refused', reason: 'END_STATE_MISMATCH', mismatches: ['unredacted_left_in_scope=1'] });
      expect(await snapshot(client)).toEqual(before);
    } finally {
      await client.end();
    }
  });

  test('a planned row already holding a redacted_fields key refuses rather than overwrite it', async () => {
    const { client } = await freshDatabase();
    try {
      await client.query(`update pilot.audit_events set details = details || '{"redacted_fields": ["x"]}'::jsonb where audit_id = $1`, [ids.taggedBothA]);
      const dry = await redact(client, dryRun(scopeA()), { log: () => {} });
      const before = await snapshot(client);
      const result = await redact(client, applyWith(scopeA(), dry.plan_fingerprint), { log: () => {} });
      expect(result).toMatchObject({ status: 'refused', reason: 'END_STATE_MISMATCH', mismatches: ['rows_with_other_keys_changed=1'] });
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
      const result = await redact(client, options, { log: out.log });
      expect(result).toMatchObject({ status: 'refused', reason });
      expect(await snapshot(client)).toEqual(before);
      expect(out.text()).not.toContain(SENTINEL);
    } finally {
      await client.end();
    }
  }

  async function fingerprintOf(scope: Options, prepare?: (c: Client) => Promise<void>): Promise<string> {
    const { client } = await freshDatabase();
    try {
      if (prepare) await prepare(client);
      return (await redact(client, dryRun(scope), { log: () => {} })).plan_fingerprint!;
    } finally {
      await client.end();
    }
  }

  test('a wrong fingerprint', async () => {
    await refusesUnchanged(applyWith(scopeA(), OTHER_FINGERPRINT), 'PLAN_FINGERPRINT_MISMATCH');
  });

  test("one organization's fingerprint used for all organizations", async () => {
    await refusesUnchanged(applyWith(scopeAll(), await fingerprintOf(scopeA())), 'PLAN_FINGERPRINT_MISMATCH');
  });

  test('a different scope over the very same rows: the fingerprint binds the approved organization input', async () => {
    const onlyA = async (c: Client) => {
      await c.query('delete from pilot.audit_events where audit_id = any($1::bigint[])', [[ids.taggedB, ids.taggedNoOrg]]);
    };
    const { client } = await freshDatabase();
    try {
      await onlyA(client);
      const a = await redact(client, dryRun(scopeA()), { log: () => {} });
      const all = await redact(client, dryRun(scopeAll()), { log: () => {} });
      expect(all.audit_ids).toEqual(a.audit_ids);
    } finally {
      await client.end();
    }
    await refusesUnchanged(applyWith(scopeAll(), await fingerprintOf(scopeA(), onlyA)), 'PLAN_FINGERPRINT_MISMATCH', onlyA);
  });

  test('a row added after the review', async () => {
    await refusesUnchanged(applyWith(scopeA(), await fingerprintOf(scopeA())), 'PLAN_FINGERPRINT_MISMATCH', async (c) => {
      await insertAudit(c, { event: EVENT, org: ORG_A, details: uploadDetails('late') });
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
    ['an unknown organization', { apply: false, organizationId: 'org-ar-missing' }, 'ORGANIZATION_NOT_FOUND'],
  ])('%s', async (_label, options, reason) => {
    await refusesUnchanged(options as Options, reason);
  });

  test('input refusals are decided before any statement', async () => {
    const query = jest.fn();
    const result = await redact({ query } as unknown as Client, { apply: true, confirm: '', organizationId: ORG_A }, { log: () => {} });
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

  test("end to end on this suite's own database: dry run, then apply with the reviewed fingerprint", async () => {
    const { client, name } = await freshDatabase();
    await client.end();
    const out = recorder();
    const dry = await runTool(envFor(name), ['--organization', ORG_A], { log: out.log });
    expect(dry.status).toBe('dry-run');
    const applied = await runTool(envFor(name, {
      PPBF_INTAKE_AUDIT_REDACT_APPLY: 'true',
      PPBF_INTAKE_AUDIT_REDACT_CONFIRM: PHRASE,
      PPBF_INTAKE_AUDIT_REDACT_EXPECT_FINGERPRINT: dry.plan_fingerprint!,
    }), ['--organization', ORG_A], { log: out.log });
    expect(applied).toMatchObject({ status: 'applied', rows_redacted: 2 });
    expect(out.text()).not.toContain(SENTINEL);
  });

  test("PPBF_INTAKE_AUDIT_REDACT_APPLY other than exactly 'true' is a dry run", async () => {
    const { client, name } = await freshDatabase();
    try {
      const before = await snapshot(client);
      const result = await runTool(envFor(name, {
        PPBF_INTAKE_AUDIT_REDACT_APPLY: 'TRUE',
        PPBF_INTAKE_AUDIT_REDACT_CONFIRM: PHRASE,
        PPBF_INTAKE_AUDIT_REDACT_EXPECT_FINGERPRINT: OTHER_FINGERPRINT,
      }), ['--all-organizations'], { log: () => {} });
      expect(result.status).toBe('dry-run');
      expect(await snapshot(client)).toEqual(before);
    } finally {
      await client.end();
    }
  });
});
