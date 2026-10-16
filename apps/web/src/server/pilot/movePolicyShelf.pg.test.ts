// Real PostgreSQL coverage for scripts/pilot-move-policy-shelf.mjs, the tool
// that moves a gym's policy shelf between organizations (OD-2026-09-28-011
// item 6).
//
// The unit test (scripts/pilot-move-policy-shelf.test.ts) proves the tool's
// decisions against a stub client that answers by statement shape. It cannot
// prove the SQL. This suite runs the exported movePolicyShelf against the
// schema production actually runs (scripts/lib/full-schema.mjs), so:
//
//   - a dry run leaves every table in the pilot schema byte-for-byte unchanged;
//   - apply moves exactly the planned rows, leaves everything else where it
//     was, and every foreign key and unique constraint still holds;
//   - a key clash in the target and a row cited from elsewhere refuse, and the
//     refusal leaves the database unchanged.
//
// Spins up the same disposable, local-only embedded Postgres the other
// migration suites use. It NEVER connects to staging or production: the
// script's run() -- which reads AZURE_POSTGRES_CONNECTION_STRING -- is never
// called, only the exported movePolicyShelf, against a client this suite owns.
//
// The full schema is built ONCE into a template database; each test clones it
// (`create database ... template ...`), so a test's writes cannot leak into
// the next.

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
const DATA_DIR = path.join(os.tmpdir(), `ppbf-move-policy-shelf-pg-test-${process.pid}-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const FULL_SCHEMA_HELPER_PATH = path.resolve(__dirname, '../../../scripts/lib/full-schema.mjs');
const MOVE_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/pilot-move-policy-shelf.mjs');

const TEMPLATE_DB = 'ppbf_move_policy_template';

/* ts-jest compiles a plain `await import()` down to require(), which cannot
   load an ES module here. Building it through Function keeps a real dynamic
   import in the emitted code, honored under --experimental-vm-modules. */
const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

const FROM = 'org-root-shelf';
const TO = 'org-gym-target';
const ADMIN = 'acct-move-admin';
const PHRASE = 'MOVE POLICY SHELF';

type MoveResult = {
  status: string;
  // Codes on a dry run; { code, ...detail } objects on a refused apply.
  blockers?: Array<string | { code: string }>;
  plan_fingerprint?: string;
  [key: string]: unknown;
};

const blockerCodes = (result: MoveResult): string[] => (result.blockers ?? [])
  .map((b) => (typeof b === 'string' ? b : b.code));
type MoveFn = (client: Client, options: Record<string, unknown>, deps?: { log?: (e: string, p: unknown) => void }) => Promise<MoveResult>;

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let movePolicyShelf: MoveFn;
let databaseCounter = 0;

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

function options(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    fromOrganizationId: FROM,
    toOrganizationId: TO,
    sourceType: 'internal_policy',
    apply: false,
    confirm: '',
    maxRows: 500,
    ...extra,
  };
}

const silent = () => {};

async function seedSource(
  target: Client,
  organizationId: string,
  sourceId: string,
  { sourceType = 'internal_policy', tier = 3, approved = true, url = `https://example.org/${sourceId}` } = {},
): Promise<void> {
  await target.query(
    `insert into pilot.shadow_library_sources
       (source_id, organization_id, title, source_type, authority_tier, url,
        approval_state, verification_state, approved_by_account_id, approved_at,
        verified_by_account_id, verified_at, rights_status)
     values ($1, $2, $3, $4, $5, $6,
       case when $7 then 'approved' else 'pending_review' end,
       case when $7 then 'verified' else 'unverified' end,
       case when $7 then $8 else null end, case when $7 then now() else null end,
       case when $7 then $8 else null end, case when $7 then now() else null end,
       -- A gym's own policy text: full text, which needs a ppbf_owned source (source rights).
       'ppbf_owned')`,
    [sourceId, organizationId, `Title ${sourceId}`, sourceType, tier, url, approved, ADMIN],
  );
}

async function seedDocument(target: Client, organizationId: string, documentId: string, sourceId: string, sha: string) {
  await target.query(
    `insert into pilot.shadow_library_documents
       (document_id, source_id, organization_id, document_name, content_sha256)
     values ($1, $2, $3, $4, $5)`,
    [documentId, sourceId, organizationId, `Document ${documentId}`, sha],
  );
}

async function seedChunk(
  target: Client, organizationId: string, chunkId: string, documentId: string, sourceId: string, ordinal: number,
) {
  await target.query(
    `insert into pilot.shadow_library_chunks
       (chunk_id, document_id, source_id, organization_id, ordinal, text_content)
     values ($1, $2, $3, $4, $5, $6)`,
    [chunkId, documentId, sourceId, organizationId, ordinal, `Body ${chunkId}`],
  );
}

async function seedCitationCheck(target: Client, organizationId: string, checkId: string, sourceId: string) {
  await target.query(
    `insert into pilot.source_citation_checks
       (organization_id, check_id, source_id, identifier_kind, resolver, outcome, checker_version)
     values ($1, $2, $3, 'none', 'not_attempted', 'no_identifier', 'test')`,
    [organizationId, checkId, sourceId],
  );
}

async function seedRetractionCheck(target: Client, organizationId: string, checkId: string, sourceId: string) {
  await target.query(
    `insert into pilot.source_retraction_checks
       (organization_id, retraction_check_id, source_id, identifier_kind, resolver, status, checker_version)
     values ($1, $2, $3, 'none', 'not_attempted', 'not_checkable', 'test')`,
    [organizationId, checkId, sourceId],
  );
}

/**
 * The template's shelf, shaped like production's: an authority-model source
 * with its own document, two policy sources whose chunks sit in copied track
 * documents, the copied programme source those documents belong to -- plus a
 * research source in the same organization that must NOT move, and the target
 * gym's own row that must not be touched.
 */
async function seedTemplate(target: Client): Promise<void> {
  for (const organizationId of [FROM, TO]) {
    await target.query(
      `insert into pilot.organizations (organization_id, organization_name, status)
       values ($1, $1, 'active') on conflict do nothing`,
      [organizationId],
    );
  }
  await target.query(
    `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
     values ($1, 'organization_admin', $2, 'microsoft') on conflict do nothing`,
    [ADMIN, FROM],
  );

  await seedSource(target, FROM, 'pol-authority', { tier: 1 });
  await seedSource(target, FROM, 'pol-a');
  await seedSource(target, FROM, 'pol-b');
  await seedSource(target, FROM, 'prog-copy', { url: 'https://example.org/programme' });
  await seedSource(target, FROM, 'research-1', { sourceType: 'peer_reviewed', approved: false });

  await seedDocument(target, FROM, 'doc-authority', 'pol-authority', 'sha-authority');
  await seedDocument(target, FROM, 'doc-copy-1', 'prog-copy', 'sha-track-1');
  await seedDocument(target, FROM, 'doc-copy-2', 'prog-copy', 'sha-track-2');
  await seedDocument(target, FROM, 'doc-research', 'research-1', 'sha-research');

  await seedChunk(target, FROM, 'auth-chunk-1', 'doc-authority', 'pol-authority', 1);
  await seedChunk(target, FROM, 'auth-chunk-2', 'doc-authority', 'pol-authority', 2);
  await seedChunk(target, FROM, 'auth-chunk-3', 'doc-authority', 'pol-authority', 3);
  await seedChunk(target, FROM, 'pol-a-chunk', 'doc-copy-1', 'pol-a', 1);
  await seedChunk(target, FROM, 'pol-b-chunk', 'doc-copy-2', 'pol-b', 1);
  await seedChunk(target, FROM, 'research-chunk', 'doc-research', 'research-1', 1);

  await seedCitationCheck(target, FROM, 'cc-pol-a', 'pol-a');
  await seedCitationCheck(target, FROM, 'cc-research', 'research-1');
  await seedRetractionCheck(target, FROM, 'rc-pol-a', 'pol-a');

  await seedSource(target, TO, 'gym-own', { approved: false });
  await seedDocument(target, TO, 'gym-own-doc', 'gym-own', 'sha-gym-own');
}

async function freshDatabase(): Promise<Client> {
  databaseCounter += 1;
  const name = `ppbf_move_policy_${databaseCounter}`;
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

async function orgOf(target: Client, table: string, idColumn: string, id: string): Promise<string | null> {
  const result = await target.query<{ organization_id: string }>(
    `select organization_id from pilot.${table} where ${idColumn} = $1`,
    [id],
  );
  return result.rows.length === 1 ? result.rows[0].organization_id : null;
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

  const helper = await nativeDynamicImport(pathToFileURL(FULL_SCHEMA_HELPER_PATH).href);
  const applyFullSchema = helper.applyFullSchema as (c: Client, o?: { infraDir?: string }) => Promise<unknown>;
  const scriptModule = await nativeDynamicImport(pathToFileURL(MOVE_SCRIPT_PATH).href);
  movePolicyShelf = scriptModule.movePolicyShelf as MoveFn;

  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  await admin.query(`drop database if exists ${TEMPLATE_DB}`);
  await admin.query(`create database ${TEMPLATE_DB} encoding 'UTF8' template template0`);
  await admin.end();

  const template = new Client({ connectionString: connectionStringFor(TEMPLATE_DB) });
  await template.connect();
  try {
    await applyFullSchema(template, { infraDir: INFRA_DIR });
    await seedTemplate(template);
  } finally {
    // A template must have no open sessions when it is cloned.
    await template.end();
  }
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
  // Only this suite's own directory, named for this process.
  await fs.rm(DATA_DIR, { recursive: true, force: true });
});

describe('dry run (real database)', () => {
  test('plans the whole shelf and leaves every pilot table unchanged', async () => {
    const client = await freshDatabase();
    try {
      const before = await snapshot(client);
      const result = await movePolicyShelf(client, options(), { log: silent });
      const after = await snapshot(client);

      expect(result).toMatchObject({
        status: 'dry-run',
        would_apply: true,
        blockers: [],
        moving: { sources: 4, documents: 3, chunks: 5, citation_checks: 1, retraction_checks: 1 },
      });
      expect(after).toEqual(before);
    } finally {
      await client.end();
    }
  });

  test('tallies review state from the real columns', async () => {
    const client = await freshDatabase();
    try {
      // The template's documents are left at the schema defaults (pending,
      // pending_review). Bring one up to what retrieval reads.
      await client.query(
        `update pilot.shadow_library_documents
            set ingest_state = 'indexed', index_completed_at = now(),
                approval_state = 'approved', verification_state = 'verified',
                approved_by_account_id = $1, approved_at = now(),
                verified_by_account_id = $1, verified_at = now()
          where document_id = 'doc-authority'`,
        [ADMIN],
      );
      const result = await movePolicyShelf(client, options(), { log: silent });

      expect(result.state_tally).toEqual({
        sources: { ready: 4, not_ready: 0, by_approval_state: { approved: 4 } },
        documents: { ready: 1, not_ready: 2 },
        // The authority document's three chunks; pol-a and pol-b sit in the
        // pending copies.
        chunks: { ready: 3, not_ready: 2 },
      });
    } finally {
      await client.end();
    }
  });
});

describe('citing evidence report (real database)', () => {
  const COACH = 'acct-move-coach';

  async function seedEvidence(client: Client, bundleId: string, accountId: string, items: Array<[string, string, string, string]>) {
    await client.query(
      `insert into pilot.shadow_evidence_bundles
         (bundle_id, organization_id, account_id, subject_id, query_sha256, availability, item_count)
       values ($1, $2, $3, null, $4, 'available', $5)`,
      [bundleId, FROM, accountId, 'a'.repeat(64), items.length],
    );
    let ordinal = 0;
    for (const [evidenceId, sourceId, documentId, chunkId] of items) {
      ordinal += 1;
      await client.query(
        `insert into pilot.shadow_evidence_items
           (evidence_id, bundle_id, organization_id, account_id, source_id, document_id, chunk_id,
            ordinal, excerpt_sha256, library_organization_id)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $3)`,
        [evidenceId, bundleId, FROM, accountId, sourceId, documentId, chunkId, ordinal, 'b'.repeat(64)],
      );
    }
  }

  /** Two askers in the old organization: ADMIN (inactive in the target) and a
   * coach who is an active member of the target. One of ADMIN's items is cited
   * from a chat answer; one item cites a row that does not move. */
  async function seedCitations(client: Client): Promise<void> {
    await client.query(
      `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
       values ($1, 'coach', $2, 'microsoft')`,
      [COACH, FROM],
    );
    // Both askers are active members of the old organization, so a membership
    // check that stopped asking about the target would read them as members.
    await client.query(
      `insert into pilot.organization_memberships (account_id, organization_id, role, active_flag)
       values ($1, $3, 'coach', true), ($2, $3, 'coach', false),
              ($1, $4, 'coach', true), ($2, $4, 'organization_admin', true)`,
      [COACH, ADMIN, TO, FROM],
    );
    await seedEvidence(client, '00000000-0000-4000-8000-0000000000b1', ADMIN, [
      ['00000000-0000-4000-8000-0000000000e1', 'pol-authority', 'doc-authority', 'auth-chunk-1'],
      ['00000000-0000-4000-8000-0000000000e2', 'pol-a', 'doc-copy-1', 'pol-a-chunk'],
    ]);
    await seedEvidence(client, '00000000-0000-4000-8000-0000000000b2', COACH, [
      ['00000000-0000-4000-8000-0000000000e3', 'pol-authority', 'doc-authority', 'auth-chunk-2'],
    ]);
    // Cites the research source, which stays: not counted.
    await seedEvidence(client, '00000000-0000-4000-8000-0000000000b3', COACH, [
      ['00000000-0000-4000-8000-0000000000e4', 'research-1', 'doc-research', 'research-chunk'],
    ]);

    const conversationId = '00000000-0000-4000-8000-0000000000c1';
    const messageId = '00000000-0000-4000-8000-0000000000d1';
    await client.query(
      `insert into pilot.shadow_chat_sessions (conversation_id, organization_id, account_id) values ($1, $2, $3)`,
      [conversationId, FROM, ADMIN],
    );
    await client.query(
      `insert into pilot.shadow_chat_messages (message_id, conversation_id, organization_id, account_id, role, content)
       values ($1, $2, $3, $4, 'assistant', 'answer')`,
      [messageId, conversationId, FROM, ADMIN],
    );
    await client.query(
      `insert into pilot.shadow_message_citations
         (assistant_message_id, evidence_id, bundle_id, organization_id, account_id, ordinal)
       values ($1, $2, $3, $4, $5, 1)`,
      [messageId, '00000000-0000-4000-8000-0000000000e1', '00000000-0000-4000-8000-0000000000b1', FROM, ADMIN],
    );
  }

  test('a dry run groups citing items by asking organization, with target membership, and writes nothing', async () => {
    const client = await freshDatabase();
    try {
      await seedCitations(client);
      const clean = await freshDatabase();
      let cleanFingerprint: string | undefined;
      try {
        cleanFingerprint = (await movePolicyShelf(clean, options(), { log: silent })).plan_fingerprint;
      } finally {
        await clean.end();
      }

      const before = await snapshot(client);
      const events: Array<{ event: string; payload: Record<string, unknown> }> = [];
      const result = await movePolicyShelf(client, options(), {
        log: (event, payload) => events.push({ event, payload: payload as Record<string, unknown> }),
      });
      const after = await snapshot(client);

      const expected = {
        items: 3,
        message_citations: 1,
        bundles: 2,
        answers: 1,
        held: { items: 0, message_citations: 0 },
        by_asking_organization: [{
          asking_organization_id: FROM,
          items: 3,
          bundles: 2,
          message_citations: 1,
          asking_accounts: 2,
          asking_accounts_deidentified: 0,
          // The coach is an active member of the target; ADMIN's membership is inactive.
          asking_accounts_active_in_target: 1,
          all_asking_accounts_active_in_target: false,
        }],
      };
      // Citing items no longer block: they are detached on apply.
      expect(result).toMatchObject({ status: 'dry-run', would_apply: true, blockers: [] });
      expect(result.citing_evidence).toEqual(expected);
      expect(events.find((e) => e.event === 'dry-run')!.payload.citing_evidence).toEqual(expected);
      // Counts only: no account id, evidence id or answer id is printed.
      const printed = JSON.stringify(events);
      expect(printed).not.toContain(ADMIN);
      expect(printed).not.toContain(COACH);
      expect(printed).not.toContain('00000000-0000-4000-8000-0000000000e1');
      expect(printed).not.toContain('00000000-0000-4000-8000-0000000000d1');
      // The detached set is part of the fingerprint.
      expect(result.plan_fingerprint).not.toBe(cleanFingerprint);
      expect(after).toEqual(before);
    } finally {
      await client.end();
    }
  });

  test('every asking account active in the target reads true', async () => {
    const client = await freshDatabase();
    try {
      await seedCitations(client);
      await client.query(
        `update pilot.organization_memberships set active_flag = true where account_id = $1 and organization_id = $2`,
        [ADMIN, TO],
      );
      const result = await movePolicyShelf(client, options(), { log: silent });
      expect(result.citing_evidence).toMatchObject({
        items: 3,
        by_asking_organization: [{ asking_accounts: 2, asking_accounts_active_in_target: 2, all_asking_accounts_active_in_target: true }],
      });
    } finally {
      await client.end();
    }
  });

  test('an asker sign-in would refuse, or a de-identified asker, is not active in the target', async () => {
    const client = await freshDatabase();
    try {
      await seedCitations(client);
      await client.query(
        `update pilot.organization_memberships set active_flag = true where account_id = $1 and organization_id = $2`,
        [ADMIN, TO],
      );
      const activeInTarget = async () => {
        const result = await movePolicyShelf(client, options(), { log: silent });
        return (result.citing_evidence as { by_asking_organization: Array<Record<string, unknown>> })
          .by_asking_organization[0];
      };

      // An inactive account with an active target membership.
      await client.query(`update pilot.accounts set active_flag = false where account_id = $1`, [COACH]);
      expect(await activeInTarget()).toMatchObject({ asking_accounts: 2, asking_accounts_active_in_target: 1 });

      // A deleted account, even while still active.
      await client.query(`update pilot.accounts set deleted_at = now() where account_id = $1`, [ADMIN]);
      expect(await activeInTarget()).toMatchObject({ asking_accounts: 2, asking_accounts_active_in_target: 0 });

      // A de-identified asker: the purge's anon_<uuid> token, with no account row.
      const anon = 'anon_00000000-0000-4000-8000-0000000000aa';
      await seedEvidence(client, '00000000-0000-4000-8000-0000000000b4', anon, [
        ['00000000-0000-4000-8000-0000000000e5', 'pol-b', 'doc-copy-2', 'pol-b-chunk'],
      ]);
      expect(await activeInTarget()).toMatchObject({
        items: 4, asking_accounts: 3, asking_accounts_deidentified: 1, asking_accounts_active_in_target: 0,
        all_asking_accounts_active_in_target: false,
      });
    } finally {
      await client.end();
    }
  });

  describe('detach, then move (real database)', () => {
  const E = (n: number) => `00000000-0000-4000-8000-0000000000e${n}`;
  const B = (n: number) => `00000000-0000-4000-8000-0000000000b${n}`;
  const ANSWER = '00000000-0000-4000-8000-0000000000d1';

  async function count(client: Client, sql: string, values: unknown[] = []): Promise<number> {
    return Number((await client.query<{ n: number }>(sql, values)).rows[0].n);
  }

  test('apply detaches the citing items and their citations, moves the shelf, and records the detached ids', async () => {
    const client = await freshDatabase();
    try {
      await seedCitations(client);
      // Rows the detach must leave alone: an answer citing the research item,
      // which does not cite the shelf, and a claim on a bundle that loses items.
      const coachConversation = '00000000-0000-4000-8000-0000000000c2';
      const coachAnswer = '00000000-0000-4000-8000-0000000000d2';
      await client.query(
        `insert into pilot.shadow_chat_sessions (conversation_id, organization_id, account_id) values ($1, $2, $3)`,
        [coachConversation, FROM, COACH],
      );
      await client.query(
        `insert into pilot.shadow_chat_messages (message_id, conversation_id, organization_id, account_id, role, content)
         values ($1, $2, $3, $4, 'assistant', 'answer')`,
        [coachAnswer, coachConversation, FROM, COACH],
      );
      await client.query(
        `insert into pilot.shadow_message_citations
           (assistant_message_id, evidence_id, bundle_id, organization_id, account_id, ordinal)
         values ($1, $2, $3, $4, $5, 1)`,
        [coachAnswer, E(4), B(3), FROM, COACH],
      );
      await client.query(
        `insert into pilot.shadow_evidence_claims
           (claim_id, organization_id, account_id, conversation_id, assistant_message_id, bundle_id, claim_status)
         values ($1, $2, $3, $4, $5, $6, 'supported')`,
        ['00000000-0000-4000-8000-0000000000f1', FROM, ADMIN, '00000000-0000-4000-8000-0000000000c1', ANSWER, B(1)],
      );

      const dry = await movePolicyShelf(client, options(), { log: silent });
      const result = await movePolicyShelf(
        client,
        options({ apply: true, confirm: PHRASE, expectFingerprint: dry.plan_fingerprint }),
        { log: silent },
      );

      expect(result).toMatchObject({
        status: 'applied',
        detached: { message_citations: 1, evidence_items: 3 },
        moved: { sources: 4, documents: 3, chunks: 5, citation_checks: 1, retraction_checks: 1 },
      });

      // The three citing items and the one citation of them are gone.
      expect(await count(client, 'select count(*)::int as n from pilot.shadow_evidence_items where evidence_id = any($1::uuid[])',
        [[E(1), E(2), E(3)]])).toBe(0);
      expect(await count(client, 'select count(*)::int as n from pilot.shadow_message_citations where evidence_id = $1',
        [E(1)])).toBe(0);
      // The citation of the item that does not cite the shelf, and the claim, stay.
      expect(await count(client, 'select count(*)::int as n from pilot.shadow_message_citations where evidence_id = $1',
        [E(4)])).toBe(1);
      expect(await count(client, 'select count(*)::int as n from pilot.shadow_evidence_claims')).toBe(1);
      // The item citing the research source, which stays, is untouched.
      expect(await count(client, 'select count(*)::int as n from pilot.shadow_evidence_items where evidence_id = $1',
        [E(4)])).toBe(1);
      // The answer keeps its text; bundles and the conversation stay.
      expect(await count(client, 'select count(*)::int as n from pilot.shadow_chat_messages where message_id = $1',
        [ANSWER])).toBe(1);
      expect(await count(client, 'select count(*)::int as n from pilot.shadow_evidence_bundles where bundle_id = any($1::uuid[])',
        [[B(1), B(2), B(3)]])).toBe(3);
      // Nothing cites a moved row from the old organization any more.
      expect(await count(client,
        `select count(*)::int as n from pilot.shadow_evidence_items
          where source_id = any($1::text[]) or chunk_id = any($2::text[])`,
        [['pol-authority', 'pol-a', 'pol-b', 'prog-copy'], ['auth-chunk-1', 'auth-chunk-2', 'pol-a-chunk']])).toBe(0);
      expect(await orgOf(client, 'shadow_library_chunks', 'chunk_id', 'auth-chunk-1')).toBe(TO);

      const audit = await client.query<{ details: Record<string, unknown> }>(
        `select details from pilot.audit_events where entity_type = 'shadow_library_policy_move'`,
      );
      expect(audit.rows).toHaveLength(1);
      const details = audit.rows[0].details as {
        detached_counts: unknown;
        detached: { evidence_items: Array<Record<string, unknown>>; message_citations: unknown[] };
      };
      expect(details.detached_counts).toEqual({ message_citations: 1, evidence_items: 3 });
      expect(details.detached.evidence_items.map((row) => row.evidence_id).sort()).toEqual([E(1), E(2), E(3)]);
      expect(details.detached.evidence_items.find((row) => row.evidence_id === E(2))).toEqual({
        evidence_id: E(2),
        bundle_id: B(1),
        asking_organization_id: FROM,
        source_id: 'pol-a',
        document_id: 'doc-copy-1',
        chunk_id: 'pol-a-chunk',
        library_organization_id: FROM,
        ordinal: 2,
        excerpt_sha256: 'b'.repeat(64),
      });
      expect(details.detached.message_citations).toEqual([
        { assistant_message_id: ANSWER, evidence_id: E(1), bundle_id: B(1), ordinal: 1 },
      ]);
      const recorded = JSON.stringify(details);
      expect(recorded).not.toContain(ADMIN);
      expect(recorded).not.toContain(COACH);
      expect(recorded).not.toMatch(/account/);
    } finally {
      await client.end();
    }
  });

  test('an item citing the shelf added after the reviewed dry run: PLAN_FINGERPRINT_MISMATCH, nothing changes', async () => {
    const client = await freshDatabase();
    try {
      await seedCitations(client);
      const reviewed = await movePolicyShelf(client, options(), { log: silent });
      await seedEvidence(client, B(5), COACH, [[E(5), 'pol-b', 'doc-copy-2', 'pol-b-chunk']]);
      const before = await snapshot(client);
      const result = await movePolicyShelf(
        client,
        options({ apply: true, confirm: PHRASE, expectFingerprint: reviewed.plan_fingerprint }),
        { log: silent },
      );
      const after = await snapshot(client);

      expect(result).toMatchObject({ status: 'refused', reason: 'PLAN_FINGERPRINT_MISMATCH' });
      expect(after).toEqual(before);
    } finally {
      await client.end();
    }
  });

  /** Dry run, then apply with its fingerprint: the hold must refuse and change nothing. */
  async function expectHoldRefuses(client: Client, held: { items: number; message_citations: number }) {
    const dry = await movePolicyShelf(client, options(), { log: silent });
    expect(dry).toMatchObject({ status: 'dry-run', would_apply: false });
    expect(blockerCodes(dry)).toEqual(['DETACH_WOULD_BREAK_HOLD']);
    expect((dry.citing_evidence as { held: unknown }).held).toEqual(held);

    const before = await snapshot(client);
    const result = await movePolicyShelf(
      client,
      options({ apply: true, confirm: PHRASE, expectFingerprint: dry.plan_fingerprint }),
      { log: silent },
    );
    expect(result).toMatchObject({ status: 'refused', reason: 'PLAN_BLOCKED' });
    expect(result.blockers).toEqual([{
      code: 'DETACH_WOULD_BREAK_HOLD', held_items: held.items, held_message_citations: held.message_citations,
    }]);
    expect(await snapshot(client)).toEqual(before);
  }

  test('a held conversation that cites the shelf (safeguarding hold): DETACH_WOULD_BREAK_HOLD, nothing changes', async () => {
    const client = await freshDatabase();
    try {
      await seedCitations(client);
      // ADMIN's conversation cites E1 from bundle B1, which also holds E2.
      await client.query(
        `update pilot.shadow_chat_sessions set subject_deleted_at = now() where conversation_id = $1`,
        ['00000000-0000-4000-8000-0000000000c1'],
      );
      await expectHoldRefuses(client, { items: 2, message_citations: 1 });
    } finally {
      await client.end();
    }
  });

  test('a held conversation that only claims a citing bundle: DETACH_WOULD_BREAK_HOLD', async () => {
    const client = await freshDatabase();
    try {
      await seedCitations(client);
      const heldConversation = '00000000-0000-4000-8000-0000000000c3';
      const heldAnswer = '00000000-0000-4000-8000-0000000000d3';
      await client.query(
        `insert into pilot.shadow_chat_sessions (conversation_id, organization_id, account_id, subject_deleted_at)
         values ($1, $2, $3, now())`,
        [heldConversation, FROM, COACH],
      );
      await client.query(
        `insert into pilot.shadow_chat_messages (message_id, conversation_id, organization_id, account_id, role, content)
         values ($1, $2, $3, $4, 'assistant', 'answer')`,
        [heldAnswer, heldConversation, FROM, COACH],
      );
      // Bundle B2 (item E3) is claimed from the held conversation, never cited.
      await client.query(
        `insert into pilot.shadow_evidence_claims
           (claim_id, organization_id, account_id, conversation_id, assistant_message_id, bundle_id, claim_status)
         values ($1, $2, $3, $4, $5, $6, 'supported')`,
        ['00000000-0000-4000-8000-0000000000f2', FROM, COACH, heldConversation, heldAnswer, B(2)],
      );
      await expectHoldRefuses(client, { items: 1, message_citations: 0 });
    } finally {
      await client.end();
    }
  });
  });
});

describe('apply (real database)', () => {
  test('moves exactly the planned rows and nothing else, with every constraint holding', async () => {
    const client = await freshDatabase();
    try {
      const dry = await movePolicyShelf(client, options(), { log: silent });
      const result = await movePolicyShelf(
        client,
        options({ apply: true, confirm: PHRASE, expectFingerprint: dry.plan_fingerprint }),
        { log: silent },
      );

      expect(result).toMatchObject({
        status: 'applied',
        moved: { sources: 4, documents: 3, chunks: 5, citation_checks: 1, retraction_checks: 1 },
      });
      expect(result.plan_fingerprint).toBe(dry.plan_fingerprint);

      for (const id of ['pol-authority', 'pol-a', 'pol-b', 'prog-copy']) {
        expect(await orgOf(client, 'shadow_library_sources', 'source_id', id)).toBe(TO);
      }
      for (const id of ['doc-authority', 'doc-copy-1', 'doc-copy-2']) {
        expect(await orgOf(client, 'shadow_library_documents', 'document_id', id)).toBe(TO);
      }
      for (const id of ['auth-chunk-1', 'auth-chunk-2', 'auth-chunk-3', 'pol-a-chunk', 'pol-b-chunk']) {
        expect(await orgOf(client, 'shadow_library_chunks', 'chunk_id', id)).toBe(TO);
      }
      expect(await orgOf(client, 'source_citation_checks', 'check_id', 'cc-pol-a')).toBe(TO);
      expect(await orgOf(client, 'source_retraction_checks', 'retraction_check_id', 'rc-pol-a')).toBe(TO);

      // The research source shares the organization and the tables, and stays.
      expect(await orgOf(client, 'shadow_library_sources', 'source_id', 'research-1')).toBe(FROM);
      expect(await orgOf(client, 'shadow_library_documents', 'document_id', 'doc-research')).toBe(FROM);
      expect(await orgOf(client, 'shadow_library_chunks', 'chunk_id', 'research-chunk')).toBe(FROM);
      expect(await orgOf(client, 'source_citation_checks', 'check_id', 'cc-research')).toBe(FROM);
      // The target's own rows are untouched.
      expect(await orgOf(client, 'shadow_library_sources', 'source_id', 'gym-own')).toBe(TO);

      // Retrieval joins chunk -> document -> source on organization_id; every
      // chunk in the target must still resolve inside the target.
      const orphans = await client.query(
        `select c.chunk_id from pilot.shadow_library_chunks c
           left join pilot.shadow_library_documents d
             on d.document_id = c.document_id and d.organization_id = c.organization_id
           left join pilot.shadow_library_sources s
             on s.source_id = c.source_id and s.organization_id = c.organization_id
          where c.organization_id in ($1, $2) and (d.document_id is null or s.source_id is null)`,
        [FROM, TO],
      );
      expect(orphans.rows).toEqual([]);

      const audit = await client.query(
        `select event_type, entity_type, entity_id, details from pilot.audit_events
          where entity_type = 'shadow_library_policy_move'`,
      );
      expect(audit.rows).toHaveLength(1);
      expect(audit.rows[0]).toMatchObject({ event_type: 'update', entity_id: TO });
      expect(audit.rows[0].details).toMatchObject({ from_organization: FROM, to_organization: TO });

      // Nothing left to move: a second dry run finds an empty shelf.
      const again = await movePolicyShelf(client, options(), { log: silent });
      expect(blockerCodes(again)).toContain('NOTHING_TO_MOVE');
    } finally {
      await client.end();
    }
  });
});

describe('refusals leave the database unchanged (real database)', () => {
  async function expectRefusedUnchanged(
    prepare: (client: Client) => Promise<void>,
    code: string,
  ): Promise<void> {
    const client = await freshDatabase();
    try {
      await prepare(client);
      // Apply with the fingerprint of a dry run of this very state, so the
      // refusal is the blocker and not a fingerprint mismatch.
      const dry = await movePolicyShelf(client, options(), { log: silent });
      const before = await snapshot(client);
      const result = await movePolicyShelf(
        client,
        options({ apply: true, confirm: PHRASE, expectFingerprint: dry.plan_fingerprint }),
        { log: silent },
      );
      const after = await snapshot(client);

      expect(result).toMatchObject({ status: 'refused', reason: 'PLAN_BLOCKED' });
      expect(blockerCodes(result)).toContain(code);
      expect(after).toEqual(before);
    } finally {
      await client.end();
    }
  }

  test('a policy source added after the reviewed dry run: PLAN_FINGERPRINT_MISMATCH', async () => {
    const client = await freshDatabase();
    try {
      const reviewed = await movePolicyShelf(client, options(), { log: silent });
      await seedSource(client, FROM, 'pol-late');
      const before = await snapshot(client);
      const result = await movePolicyShelf(
        client,
        options({ apply: true, confirm: PHRASE, expectFingerprint: reviewed.plan_fingerprint }),
        { log: silent },
      );
      const after = await snapshot(client);

      expect(result).toMatchObject({
        status: 'refused',
        reason: 'PLAN_FINGERPRINT_MISMATCH',
        expected: reviewed.plan_fingerprint,
      });
      expect(result.actual).not.toBe(reviewed.plan_fingerprint);
      expect(after).toEqual(before);
      expect(await orgOf(client, 'shadow_library_sources', 'source_id', 'pol-authority')).toBe(FROM);
    } finally {
      await client.end();
    }
  });

  test('the target already holds a source with the same url', async () => {
    await expectRefusedUnchanged(async (client) => {
      await seedSource(client, TO, 'gym-dup-url', { approved: false, url: 'https://example.org/pol-a' });
    }, 'TARGET_ORG_COLLISION');
  });

  test('the target already holds a document with the same content hash', async () => {
    await expectRefusedUnchanged(async (client) => {
      await seedDocument(client, TO, 'gym-dup-doc', 'gym-own', 'sha-track-1');
    }, 'TARGET_ORG_COLLISION');
  });

  test('a lesson in the old organization cites a moving document', async () => {
    await expectRefusedUnchanged(async (client) => {
      await client.query(
        `insert into pilot.rabbit_holes
           (organization_id, rabbit_hole_id, anchor_type, anchor_key, title, concept,
            library_document_id, author_display_name)
         values ($1, '00000000-0000-4000-8000-000000000003', 'drill', 'jab', 'Lesson', 'Concept',
                 'doc-copy-1', 'Coach')`,
        [FROM],
      );
    }, 'RABBIT_HOLES_WOULD_LOSE_CITATION');
  });
});
