// Real PostgreSQL-backed test for recomputeShadowCapabilityCoverage.
//
// Until now this function had ZERO real-database coverage -- the only test
// touching it (the capability-coverage route test) mocks shadowLibrary
// wholesale, so the actual SQL never ran against a real Postgres. That
// mattered here specifically because this change batches what was a
// per-rule UPDATE loop (and a per-rule full-list refetch inside it) into
// one multi-row UPDATE via unnest($1::text[], $2::text[]) -- a real SQL
// construct a mock cannot validate, and exactly the kind of statement
// that's easy to get subtly wrong (column order, array binding, the join
// predicate) without ever finding out until it runs for real.
//
// './db' is mocked to route into the embedded server (see
// trainingHolds.pg.test.ts for the same pattern), so
// recomputeShadowCapabilityCoverage below is the actual production
// function executing its actual SQL against actual rows.
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

let activeClient: Client | null = null;

jest.mock('./db', () => ({
  query: jest.fn(async (text: string, params: unknown[] = []) => {
    if (!activeClient) throw new Error('test bug: no active embedded client');
    const result = await activeClient.query(text, params);
    return result.rows;
  }),
  queryOne: jest.fn(async (text: string, params: unknown[] = []) => {
    if (!activeClient) throw new Error('test bug: no active embedded client');
    const result = await activeClient.query(text, params);
    return result.rows[0] ?? null;
  }),
}));

import { PLATFORM_LIBRARY_ORGANIZATION_ID } from './platformLibraryScope';
import {
  listApprovedGlobalEvidenceForResearchBridge,
  listShadowCapabilityCoverage,
  recomputeShadowCapabilityCoverage,
} from './shadowLibrary';
import { resolveShadowResearchRequirement } from './shadowResearch';

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-shadow-library-coverage-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');

const ORG_ID = 'org-coverage';
const ADMIN_ID = 'acct-coverage-admin';

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let schemaSql: string[];

/* The coverage count now asks what search asks -- approval, verification,
   retraction suppression, an indexed document -- so the fixture carries the
   migrations that add those columns, in the order shadowLibraryPipeline.pg
   applies them. Each file is applied on its own: two of them manage their own
   transaction. */
const SCHEMA_FILES = [
  'pilot_slice_postgres.sql',
  /* PRODUCTION HAS THIS MIGRATION, so the fixture does too. It adds
     pilot.athletes.deleted_at, which the authorization queries in access.ts
     now require. deploy-production's schema check asserts every migration's
     `add column` exists in the live database and it passed on the 2026-08-27
     release, so a fixture without it is not a smaller production -- it is a
     schema nobody runs. */
  'pilot_slice_postgres_data_retention_deletion_migration.sql',
  'pilot_slice_postgres_shadow_runtime_migration.sql',
  'pilot_slice_postgres_shadow_evidence_migration.sql',
  'pilot_slice_postgres_shadow_chunk_embedding_migration.sql',
  'pilot_slice_postgres_retraction_surveillance_migration.sql',
  /* The shared platform shelf (__platform__). Coverage counts it because
     search reads it (R1, Jason 2026-09-29); the migration creates the reserved
     organization and the CHECK that keeps athlete-scoped rows off it. */
  'pilot_slice_postgres_platform_library_scope_migration.sql',
];

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

async function freshDatabase(name: string): Promise<Client> {
  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  await admin.query(`drop database if exists ${name}`);
  await admin.query(`create database ${name}`);
  await admin.end();

  const client = new Client({ connectionString: connectionStringFor(name) });
  await client.connect();
  for (const sql of schemaSql) {
    await client.query(sql);
  }
  await client.query(
    `insert into pilot.organizations (organization_id, organization_name, status)
     values ($1, $1, 'active') on conflict do nothing`,
    [ORG_ID],
  );
  await client.query(
    `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
     values ($1, 'organization_admin', $2, 'microsoft') on conflict do nothing`,
    [ADMIN_ID, ORG_ID],
  );
  return client;
}

async function seedRule(
  client: Client,
  capabilityMapId: string,
  overrides: { minimumSourceCount?: number; minimumAuthorityTier?: number; requiredSourceTypes?: string[] } = {},
) {
  await client.query(
    `insert into pilot.shadow_library_capability_map
       (capability_map_id, organization_id, capability_key, minimum_authority_tier, minimum_source_count,
        required_source_types)
     values ($1, $2, $1, $3, $4, $5::text[])`,
    [
      capabilityMapId,
      ORG_ID,
      overrides.minimumAuthorityTier ?? 3,
      overrides.minimumSourceCount ?? 1,
      overrides.requiredSourceTypes ?? [],
    ],
  );
}

type SourceState = 'servable' | 'pending_review' | 'unindexed' | 'retracted' | 'athlete_scoped';

/**
 * A source in one of the states that matter to search. Only 'servable' is one
 * a gym-wide searchShadowLibrary can return: approved and verified, with an
 * indexed, approved, verified document holding a chunk. The others are each
 * one step short of that, and each used to count as coverage. 'athlete_scoped'
 * is fully approved and indexed, but its only document (and so its chunk) names
 * one athlete, which a gym-wide search never returns.
 */
async function seedSource(
  client: Client,
  sourceId: string,
  options: {
    authorityTier?: number;
    state?: SourceState;
    sourceType?: string;
    text?: string;
    /** Which shelf the source sits on. Defaults to the gym's own. */
    organizationId?: string;
    /**
     * False writes the source row alone: no document of its own, no chunk.
     * That is most of the research corpus -- a source cited by chunks that sit
     * in another source's document (see the "real corpus shape" cases).
     */
    ownsDocument?: boolean;
  } = {},
) {
  const state = options.state ?? 'servable';
  const sourceApproved = state !== 'pending_review';
  const organizationId = options.organizationId ?? ORG_ID;
  await client.query(
    `insert into pilot.shadow_library_sources
       (source_id, organization_id, title, source_type, authority_tier, status,
        approval_state, verification_state,
        approved_by_account_id, approved_at, verified_by_account_id, verified_at)
     values ($1, $2, $1, $3, $4, 'active',
        case when $5::boolean then 'approved' else 'pending_review' end,
        case when $5::boolean then 'verified' else 'unverified' end,
        case when $5::boolean then $6::text end, case when $5::boolean then now() end,
        case when $5::boolean then $6::text end, case when $5::boolean then now() end)`,
    [sourceId, organizationId, options.sourceType ?? 'article', options.authorityTier ?? 1, sourceApproved, ADMIN_ID],
  );

  if (options.ownsDocument !== false) {
    const documentId = `doc-${sourceId}`;
    // What createShadowLibraryDocument writes for an athlete's document; its
    // chunks inherit the same subject_id (createShadowLibraryChunk).
    const subjectId = state === 'athlete_scoped' ? 'athlete-coverage-subject' : null;
    await seedDocument(client, documentId, sourceId, {
      organizationId,
      indexed: state !== 'unindexed',
      subjectId,
    });
    await seedChunk(client, `chunk-${sourceId}`, documentId, sourceId, {
      organizationId,
      subjectId,
      text: options.text,
    });
  }

  if (state === 'retracted') {
    // What suppressSource writes: the flag and its reason, nothing else. The
    // approvals stay, which is exactly why every reader has to check the flag.
    await client.query(
      `update pilot.shadow_library_sources
         set retrieval_suppressed = true,
             suppression_reason = 'Retracted by the publisher (test fixture).',
             suppressed_at = now(),
             suppressed_by_account_id = $3
       where organization_id = $1 and source_id = $2`,
      [organizationId, sourceId, ADMIN_ID],
    );
  }
}

/**
 * A document owned by `ownerSourceId`. Indexed means indexed, approved and
 * verified; otherwise it was registered and chunked but never indexed -- so
 * never approvable either.
 */
async function seedDocument(
  client: Client,
  documentId: string,
  ownerSourceId: string,
  options: { organizationId?: string; indexed?: boolean; subjectId?: string | null } = {},
) {
  const organizationId = options.organizationId ?? ORG_ID;
  if (options.indexed === false) {
    await client.query(
      `insert into pilot.shadow_library_documents
         (document_id, source_id, organization_id, document_name, ingest_state)
       values ($1, $2, $3, $1, 'chunking')`,
      [documentId, ownerSourceId, organizationId],
    );
    return;
  }
  await client.query(
    `insert into pilot.shadow_library_documents
       (document_id, source_id, organization_id, subject_id, document_name, ingest_state, index_completed_at,
        approval_state, verification_state,
        approved_by_account_id, approved_at, verified_by_account_id, verified_at)
     values ($1, $2, $3, $5, $1, 'indexed', now(), 'approved', 'verified', $4, now(), $4, now())`,
    [documentId, ownerSourceId, organizationId, ADMIN_ID, options.subjectId ?? null],
  );
}

/**
 * A chunk inside `documentId` that CITES `citedSourceId`. The two need not be
 * the document's owner: search joins a chunk to its source by the chunk's own
 * source_id.
 */
async function seedChunk(
  client: Client,
  chunkId: string,
  documentId: string,
  citedSourceId: string,
  options: { organizationId?: string; subjectId?: string | null; ordinal?: number; text?: string } = {},
) {
  await client.query(
    `insert into pilot.shadow_library_chunks
       (chunk_id, document_id, source_id, organization_id, subject_id, ordinal, text_content)
     values ($1, $2, $3, $4, $6, $7, $5)`,
    [
      chunkId,
      documentId,
      citedSourceId,
      options.organizationId ?? ORG_ID,
      options.text ?? `Evidence text for ${citedSourceId}.`,
      options.subjectId ?? null,
      options.ordinal ?? 0,
    ],
  );
}

async function seedActiveSource(client: Client, sourceId: string, authorityTier = 1) {
  await seedSource(client, sourceId, { authorityTier });
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

  schemaSql = await Promise.all(
    SCHEMA_FILES.map((file) => fs.readFile(path.join(INFRA_DIR, file), 'utf8')),
  );
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
  await fs.rm(DATA_DIR, { recursive: true, force: true }).catch(() => {});
});

afterEach(() => {
  activeClient = null;
});

describe('recomputeShadowCapabilityCoverage: the batched unnest UPDATE against real rows', () => {
  test('computes uncovered and covered correctly, and every rule lands its own state (not one state for all)', async () => {
    const client = await freshDatabase('coverage_states');
    activeClient = client;
    try {
      // Neither rule filters by source_type, so the one source in this org
      // is visible to both -- differentiated by authority_tier instead: a
      // tier-3 source satisfies a rule requiring tier<=3 but not one
      // requiring tier<=1, which is the actual lever that makes one rule
      // 'uncovered' and the other 'covered' from the SAME batched UPDATE,
      // not one shared state written to every row.
      await seedRule(client, 'cap-uncovered', { minimumSourceCount: 1, minimumAuthorityTier: 1 });
      await seedRule(client, 'cap-covered', { minimumSourceCount: 1, minimumAuthorityTier: 3 });
      await seedActiveSource(client, 'src-1', 3);

      const result = await recomputeShadowCapabilityCoverage({
        organizationId: ORG_ID,
        actorAccountId: ADMIN_ID,
        actorRole: 'organization_admin',
      });

      const byKey = Object.fromEntries(result.map((row) => [row.capability_key, row.coverage_state]));
      expect(byKey['cap-uncovered']).toBe('uncovered');
      expect(byKey['cap-covered']).toBe('covered');
    } finally {
      await client.end();
    }
  });

  test('a rule with a real partial match (one source of two required) computes partial, not covered', async () => {
    const client = await freshDatabase('coverage_partial');
    activeClient = client;
    try {
      await seedRule(client, 'cap-needs-two', { minimumSourceCount: 2 });
      await seedActiveSource(client, 'src-only-one');

      const result = await recomputeShadowCapabilityCoverage({
        organizationId: ORG_ID,
        actorAccountId: ADMIN_ID,
        actorRole: 'organization_admin',
      });

      expect(result.find((row) => row.capability_key === 'cap-needs-two')?.coverage_state).toBe('partial');
    } finally {
      await client.end();
    }
  });

  test('the batched UPDATE stamps last_evaluated_at and persists coverage_state -- verified by a second recompute call', async () => {
    const client = await freshDatabase('coverage_persist');
    activeClient = client;
    try {
      await seedRule(client, 'cap-1', { minimumSourceCount: 1 });
      await seedRule(client, 'cap-2', { minimumSourceCount: 1 });
      await seedActiveSource(client, 'src-1');

      await recomputeShadowCapabilityCoverage({
        organizationId: ORG_ID,
        actorAccountId: ADMIN_ID,
        actorRole: 'organization_admin',
      });

      const rows = await client.query(
        `select capability_key, coverage_state, last_evaluated_at from pilot.shadow_library_capability_map
         where organization_id = $1 order by capability_key`,
        [ORG_ID],
      );
      // Every rule's row was actually written (the unnest join matched
      // every capability_map_id), not just the first one.
      expect(rows.rows).toHaveLength(2);
      for (const row of rows.rows) {
        expect(row.last_evaluated_at).not.toBeNull();
      }

      const listed = await listShadowCapabilityCoverage(ORG_ID);
      expect(listed.map((row) => row.capability_key).sort()).toEqual(['cap-1', 'cap-2']);
    } finally {
      await client.end();
    }
  });

  test('an uncovered or partial rule gets exactly one open research requirement, not one per recompute call', async () => {
    const client = await freshDatabase('coverage_research_requirement');
    activeClient = client;
    try {
      await seedRule(client, 'cap-gap', { minimumSourceCount: 1 });

      await recomputeShadowCapabilityCoverage({
        organizationId: ORG_ID,
        actorAccountId: ADMIN_ID,
        actorRole: 'organization_admin',
      });
      // A second recompute call, still uncovered: the pre-fetched-once
      // openItems dedup check (now shared across the whole pass instead of
      // refetched per row) must still catch this as a duplicate.
      await recomputeShadowCapabilityCoverage({
        organizationId: ORG_ID,
        actorAccountId: ADMIN_ID,
        actorRole: 'organization_admin',
      });

      const requirements = await client.query(
        `select research_requirement_id from pilot.shadow_research_requirements
         where organization_id = $1 and source_entity_id = 'cap-gap' and status = 'open'`,
        [ORG_ID],
      );
      expect(requirements.rows).toHaveLength(1);
    } finally {
      await client.end();
    }
  });

  test('a covered rule gets no research requirement at all', async () => {
    const client = await freshDatabase('coverage_no_requirement_when_covered');
    activeClient = client;
    try {
      await seedRule(client, 'cap-fine', { minimumSourceCount: 1 });
      await seedActiveSource(client, 'src-fine');

      await recomputeShadowCapabilityCoverage({
        organizationId: ORG_ID,
        actorAccountId: ADMIN_ID,
        actorRole: 'organization_admin',
      });

      const requirements = await client.query(
        `select research_requirement_id from pilot.shadow_research_requirements
         where organization_id = $1 and source_entity_id = 'cap-fine'`,
        [ORG_ID],
      );
      expect(requirements.rows).toHaveLength(0);
    } finally {
      await client.end();
    }
  });

  test('an org with no capability rules at all recomputes to an empty list without error', async () => {
    const client = await freshDatabase('coverage_empty');
    activeClient = client;
    try {
      const result = await recomputeShadowCapabilityCoverage({
        organizationId: ORG_ID,
        actorAccountId: ADMIN_ID,
        actorRole: 'organization_admin',
      });
      expect(result).toEqual([]);
    } finally {
      await client.end();
    }
  });

  test('recompute for one organization never touches another organization\'s rules', async () => {
    const client = await freshDatabase('coverage_tenancy');
    activeClient = client;
    try {
      const OTHER_ORG_ID = 'org-coverage-other';
      const OTHER_ADMIN_ID = 'acct-coverage-other-admin';
      await client.query(
        `insert into pilot.organizations (organization_id, organization_name, status) values ($1, $1, 'active')`,
        [OTHER_ORG_ID],
      );
      await client.query(
        `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
         values ($1, 'organization_admin', $2, 'microsoft')`,
        [OTHER_ADMIN_ID, OTHER_ORG_ID],
      );
      await client.query(
        `insert into pilot.shadow_library_capability_map
           (capability_map_id, organization_id, capability_key, minimum_source_count)
         values ('cap-other', $1, 'cap-other', 1)`,
        [OTHER_ORG_ID],
      );
      await seedRule(client, 'cap-mine', { minimumSourceCount: 1 });

      await recomputeShadowCapabilityCoverage({
        organizationId: ORG_ID,
        actorAccountId: ADMIN_ID,
        actorRole: 'organization_admin',
      });

      // The other org's rule was never evaluated -- last_evaluated_at stays null.
      const other = await client.query(
        `select last_evaluated_at from pilot.shadow_library_capability_map where organization_id = $1`,
        [OTHER_ORG_ID],
      );
      expect(other.rows[0].last_evaluated_at).toBeNull();
    } finally {
      await client.end();
    }
  });
});

describe('coverage counts only sources search can serve', () => {
  // Each of these used to count as coverage while a gym-wide searchShadowLibrary
  // returned nothing for it -- and a rule that reads "covered" opens no
  // research gap.
  test.each<[SourceState, string]>([
    ['pending_review', 'a source still waiting for review'],
    ['unindexed', 'a source whose document was never indexed'],
    ['retracted', 'a source suppressed for retraction'],
    ['athlete_scoped', 'a source whose only document is scoped to one athlete'],
  ])('%s: %s leaves the rule uncovered, and opens the gap', async (state) => {
    const client = await freshDatabase(`coverage_not_${state}`);
    activeClient = client;
    try {
      await seedRule(client, 'cap-unservable', { minimumSourceCount: 1 });
      await seedSource(client, `src-${state}`, { state });

      const result = await recomputeShadowCapabilityCoverage({
        organizationId: ORG_ID,
        actorAccountId: ADMIN_ID,
        actorRole: 'organization_admin',
      });

      const rule = result.find((row) => row.capability_key === 'cap-unservable');
      expect(rule?.coverage_state).toBe('uncovered');
      expect(rule?.matched_sources).toBe(0);

      const requirements = await client.query(
        `select research_requirement_id from pilot.shadow_research_requirements
         where organization_id = $1 and source_entity_id = 'cap-unservable' and status = 'open'`,
        [ORG_ID],
      );
      expect(requirements.rows).toHaveLength(1);
    } finally {
      await client.end();
    }
  });

  // The other half: without this, counting nothing at all would pass the three
  // cases above.
  test('a servable source beside an unservable one counts once, not twice', async () => {
    const client = await freshDatabase('coverage_servable_only');
    activeClient = client;
    try {
      await seedRule(client, 'cap-needs-two', { minimumSourceCount: 2 });
      await seedSource(client, 'src-servable', { state: 'servable' });
      await seedSource(client, 'src-retracted', { state: 'retracted' });

      const result = await recomputeShadowCapabilityCoverage({
        organizationId: ORG_ID,
        actorAccountId: ADMIN_ID,
        actorRole: 'organization_admin',
      });

      const rule = result.find((row) => row.capability_key === 'cap-needs-two');
      expect(rule?.matched_sources).toBe(1);
      expect(rule?.coverage_state).toBe('partial');
    } finally {
      await client.end();
    }
  });
});

// R1 (Jason 2026-09-29): coverage counts the shared platform shelf too,
// because search reads it. Only the shelves search reads -- the gym's own and
// __platform__ -- and only what search could serve from them.
describe('coverage counts the shared platform shelf, as search does', () => {
  async function recompute() {
    return recomputeShadowCapabilityCoverage({
      organizationId: ORG_ID,
      actorAccountId: ADMIN_ID,
      actorRole: 'organization_admin',
    });
  }

  test('a gym covered only by platform evidence reads covered, and opens no gap', async () => {
    const client = await freshDatabase('coverage_platform_only');
    activeClient = client;
    try {
      await seedRule(client, 'cap-platform', { minimumSourceCount: 1 });
      await seedSource(client, 'src-platform', { organizationId: PLATFORM_LIBRARY_ORGANIZATION_ID });

      const result = await recompute();

      const rule = result.find((row) => row.capability_key === 'cap-platform');
      expect(rule?.matched_sources).toBe(1);
      expect(rule?.coverage_state).toBe('covered');
      // The list read and the stored state agree.
      const listed = await listShadowCapabilityCoverage(ORG_ID);
      expect(listed.find((row) => row.capability_key === 'cap-platform')?.matched_sources).toBe(1);

      const requirements = await client.query(
        `select research_requirement_id from pilot.shadow_research_requirements
         where organization_id = $1 and source_entity_id = 'cap-platform'`,
        [ORG_ID],
      );
      expect(requirements.rows).toHaveLength(0);
    } finally {
      await client.end();
    }
  });

  test('a gym source and a platform source add up', async () => {
    const client = await freshDatabase('coverage_platform_plus_gym');
    activeClient = client;
    try {
      await seedRule(client, 'cap-needs-two', { minimumSourceCount: 2 });
      await seedSource(client, 'src-gym-own');
      await seedSource(client, 'src-platform-shared', { organizationId: PLATFORM_LIBRARY_ORGANIZATION_ID });

      const rule = (await recompute()).find((row) => row.capability_key === 'cap-needs-two');
      expect(rule?.matched_sources).toBe(2);
      expect(rule?.coverage_state).toBe('covered');
    } finally {
      await client.end();
    }
  });

  // The platform shelf is held to the same bar as the gym's: search drops a
  // retracted or unreviewed platform source, so coverage does too.
  test.each<[SourceState]>([['retracted'], ['pending_review'], ['unindexed']])(
    'a %s platform source does not count',
    async (state) => {
      const client = await freshDatabase(`coverage_platform_not_${state}`);
      activeClient = client;
      try {
        await seedRule(client, 'cap-platform-unservable', { minimumSourceCount: 1 });
        await seedSource(client, `src-platform-${state}`, { organizationId: PLATFORM_LIBRARY_ORGANIZATION_ID, state });

        const rule = (await recompute()).find((row) => row.capability_key === 'cap-platform-unservable');
        expect(rule?.matched_sources).toBe(0);
        expect(rule?.coverage_state).toBe('uncovered');
      } finally {
        await client.end();
      }
    },
  );

  // Never wider than search: another gym's servable evidence is not this
  // gym's coverage.
  test("another gym's servable source never counts", async () => {
    const client = await freshDatabase('coverage_other_gym_shelf');
    activeClient = client;
    try {
      const OTHER_ORG_ID = 'org-coverage-neighbour';
      await client.query(
        `insert into pilot.organizations (organization_id, organization_name, status) values ($1, $1, 'active')`,
        [OTHER_ORG_ID],
      );
      await seedRule(client, 'cap-neighbour', { minimumSourceCount: 1 });
      await seedSource(client, 'src-neighbour', { organizationId: OTHER_ORG_ID });

      const rule = (await recompute()).find((row) => row.capability_key === 'cap-neighbour');
      expect(rule?.matched_sources).toBe(0);
      expect(rule?.coverage_state).toBe('uncovered');
    } finally {
      await client.end();
    }
  });
});

// Search serves a source through the chunks that CITE it, inside whatever
// document each chunk sits in; it never asks which source owns that document
// (searchShadowLibrary joins `s.source_id = c.source_id` and `d.document_id =
// c.document_id`). The research corpus is built exactly that way: on
// __platform__ all 14 documents belong to one programme source
// (src_6563c68e39047128, internal_policy, tier 3) and their 1,173 chunks cite
// 968 other sources that own no document; on the gym's shelf the PPBF policy
// sources sit in documents owned by the copied programme source
// (import-shadow-research.mjs applySeedScope). Every other fixture here gives
// each source its own document, which is why a count keyed on document
// ownership passed them all while counting almost nothing search serves.
describe('coverage counts sources the way search serves them: through the chunks that cite them (real corpus shape)', () => {
  const PROGRAMME_SOURCE_ID = 'src-programme';

  async function recompute() {
    return recomputeShadowCapabilityCoverage({
      organizationId: ORG_ID,
      actorAccountId: ADMIN_ID,
      actorRole: 'organization_admin',
    });
  }

  /**
   * The programme source (approved, verified, internal_policy, tier 3) and one
   * indexed, approved, verified document it owns. No chunk cites it, as in the
   * corpus. One per database: each case below starts from a fresh one.
   */
  async function seedProgrammeDocument(client: Client, organizationId: string, documentId: string) {
    await seedSource(client, PROGRAMME_SOURCE_ID, {
      organizationId,
      sourceType: 'internal_policy',
      authorityTier: 3,
      ownsDocument: false,
    });
    await seedDocument(client, documentId, PROGRAMME_SOURCE_ID, { organizationId });
  }

  test('platform: a programme-owned document whose chunks cite two peer-reviewed tier-1 sources covers a rule needing two', async () => {
    const client = await freshDatabase('coverage_corpus_shape_platform');
    activeClient = client;
    try {
      const shelf = PLATFORM_LIBRARY_ORGANIZATION_ID;
      await seedRule(client, 'cap-peer-reviewed', {
        requiredSourceTypes: ['peer_reviewed'],
        minimumAuthorityTier: 1,
        minimumSourceCount: 2,
      });
      await seedProgrammeDocument(client, shelf, 'doc-track');
      for (const [ordinal, sourceId] of ['src-peer-a', 'src-peer-b'].entries()) {
        await seedSource(client, sourceId, {
          organizationId: shelf,
          sourceType: 'peer_reviewed',
          authorityTier: 1,
          ownsDocument: false,
        });
        await seedChunk(client, `chunk-${sourceId}`, 'doc-track', sourceId, { organizationId: shelf, ordinal });
      }

      const rule = (await recompute()).find((row) => row.capability_key === 'cap-peer-reviewed');
      expect(rule?.matched_sources).toBe(2);
      expect(rule?.coverage_state).toBe('covered');
      const listed = await listShadowCapabilityCoverage(ORG_ID);
      expect(listed.find((row) => row.capability_key === 'cap-peer-reviewed')?.matched_sources).toBe(2);

      const requirements = await client.query(
        `select research_requirement_id from pilot.shadow_research_requirements
         where organization_id = $1 and source_entity_id = 'cap-peer-reviewed'`,
        [ORG_ID],
      );
      expect(requirements.rows).toHaveLength(0);
    } finally {
      await client.end();
    }
  });

  // The gym's own PPBF policy sources: their chunks sit in documents owned by
  // the copied programme source. Search returns the two policy sources, never
  // the programme source (no chunk cites it), so the count is two -- not the
  // one an ownership join produced.
  test("gym shelf: policy sources cited inside the copied programme's document count, the programme source does not", async () => {
    const client = await freshDatabase('coverage_corpus_shape_gym');
    activeClient = client;
    try {
      await seedRule(client, 'cap-house-policy', {
        requiredSourceTypes: ['internal_policy'],
        minimumAuthorityTier: 3,
        minimumSourceCount: 2,
      });
      await seedProgrammeDocument(client, ORG_ID, 'doc-ppbfpol-track');
      for (const [ordinal, sourceId] of ['src-policy-a', 'src-policy-b'].entries()) {
        await seedSource(client, sourceId, { sourceType: 'internal_policy', authorityTier: 3, ownsDocument: false });
        await seedChunk(client, `chunk-${sourceId}`, 'doc-ppbfpol-track', sourceId, { ordinal });
      }

      const rule = (await recompute()).find((row) => row.capability_key === 'cap-house-policy');
      expect(rule?.matched_sources).toBe(2);
      expect(rule?.coverage_state).toBe('covered');
    } finally {
      await client.end();
    }
  });

  // The other direction. Owning a servable document is not being served: the
  // programme source is in no search result, because no chunk cites it. And a
  // cited source whose only chunk sits in an unindexed document is in none
  // either.
  test('a source that only owns a servable document, and one cited only inside an unindexed document, both count zero', async () => {
    const client = await freshDatabase('coverage_corpus_shape_unserved');
    activeClient = client;
    try {
      const shelf = PLATFORM_LIBRARY_ORGANIZATION_ID;
      await seedRule(client, 'cap-anything-tier-3', { minimumAuthorityTier: 3, minimumSourceCount: 1 });
      await seedProgrammeDocument(client, shelf, 'doc-served-but-uncited');
      await seedDocument(client, 'doc-unindexed', PROGRAMME_SOURCE_ID, { organizationId: shelf, indexed: false });
      await seedSource(client, 'src-peer-unindexed', {
        organizationId: shelf,
        sourceType: 'peer_reviewed',
        authorityTier: 1,
        ownsDocument: false,
      });
      await seedChunk(client, 'chunk-peer-unindexed', 'doc-unindexed', 'src-peer-unindexed', { organizationId: shelf });

      const rule = (await recompute()).find((row) => row.capability_key === 'cap-anything-tier-3');
      expect(rule?.matched_sources).toBe(0);
      expect(rule?.coverage_state).toBe('uncovered');
    } finally {
      await client.end();
    }
  });
});

// R2 (Jason 2026-09-29): the coverage check closes its own gap tickets once a
// capability grades covered -- and, so a gap that comes back is not left
// without a ticket, reopens a ticket it closed itself.
describe('the coverage check closes, and reopens, its own gap tickets', () => {
  async function recompute(actorAccountId = ADMIN_ID) {
    return recomputeShadowCapabilityCoverage({
      organizationId: ORG_ID,
      actorAccountId,
      actorRole: 'organization_admin',
    });
  }

  async function gapTickets(client: Client, capabilityKey: string, organizationId = ORG_ID) {
    const { rows } = await client.query<{
      research_requirement_id: string;
      status: string;
      resolved_at: Date | null;
      metadata: Record<string, unknown>;
      knowledge_gap: string;
    }>(
      `select research_requirement_id, status, resolved_at, metadata, knowledge_gap
       from pilot.shadow_research_requirements
       where organization_id = $1
         and source_event_name = 'SHADOW_LIBRARY_CAPABILITY_GAP_DETECTED'
         and source_entity_type = 'shadow_library_capability_map'
         and source_entity_id = $2`,
      [organizationId, capabilityKey],
    );
    return rows;
  }

  test('a rule that becomes covered closes its open gap ticket, attributed to whoever ran the recompute', async () => {
    const client = await freshDatabase('coverage_closes_gap');
    activeClient = client;
    try {
      await seedRule(client, 'cap-filled', { minimumSourceCount: 1 });
      await recompute();
      const [opened] = await gapTickets(client, 'cap-filled');
      expect(opened.status).toBe('open');

      // The evidence arrives on the shared shelf: R1 and R2 together.
      await seedSource(client, 'src-filled', { organizationId: PLATFORM_LIBRARY_ORGANIZATION_ID });
      const result = await recompute();
      expect(result.find((row) => row.capability_key === 'cap-filled')?.coverage_state).toBe('covered');

      const tickets = await gapTickets(client, 'cap-filled');
      expect(tickets).toHaveLength(1);
      expect(tickets[0].research_requirement_id).toBe(opened.research_requirement_id);
      expect(tickets[0].status).toBe('resolved');
      expect(tickets[0].resolved_at).not.toBeNull();
      expect(tickets[0].metadata).toEqual(expect.objectContaining({
        resolution: 'capability_covered',
        resolved_by_account_id: ADMIN_ID,
        resolved_by_role: 'organization_admin',
        resolved_matched_sources: 1,
      }));

      // The pass records what it closed on its own attributed event.
      const events = await client.query(
        `select payload from pilot.shadow_events
         where organization_id = $1 and event_name = 'SHADOW_LIBRARY_CAPABILITY_COVERAGE_RECOMPUTED'
         order by shadow_event_id desc limit 1`,
        [ORG_ID],
      );
      // bigserial ids come back from node-postgres as strings; compare as such.
      expect(events.rows[0].payload.closed_research_requirement_ids.map(String))
        .toEqual([String(opened.research_requirement_id)]);
    } finally {
      await client.end();
    }
  });

  test('closing touches only the covered capability, in this gym', async () => {
    const client = await freshDatabase('coverage_close_scope');
    activeClient = client;
    try {
      const OTHER_ORG_ID = 'org-coverage-close-other';
      const OTHER_ADMIN_ID = 'acct-coverage-close-other-admin';
      await client.query(
        `insert into pilot.organizations (organization_id, organization_name, status) values ($1, $1, 'active')`,
        [OTHER_ORG_ID],
      );
      await client.query(
        `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
         values ($1, 'organization_admin', $2, 'microsoft')`,
        [OTHER_ADMIN_ID, OTHER_ORG_ID],
      );
      // The same capability key, still uncovered in the other gym.
      await client.query(
        `insert into pilot.shadow_library_capability_map
           (capability_map_id, organization_id, capability_key, minimum_source_count)
         values ('cap-shared-key-other', $1, 'cap-shared-key', 1)`,
        [OTHER_ORG_ID],
      );
      await recomputeShadowCapabilityCoverage({
        organizationId: OTHER_ORG_ID,
        actorAccountId: OTHER_ADMIN_ID,
        actorRole: 'organization_admin',
      });

      await seedRule(client, 'cap-shared-key', { minimumSourceCount: 1 });
      await seedRule(client, 'cap-still-missing', { minimumSourceCount: 1, minimumAuthorityTier: 1 });
      await recompute();

      // Tier 3 satisfies cap-shared-key (tier <= 3) but not cap-still-missing
      // (tier <= 1).
      await seedSource(client, 'src-tier-three', { authorityTier: 3 });
      await recompute();

      expect((await gapTickets(client, 'cap-shared-key'))[0].status).toBe('resolved');
      expect((await gapTickets(client, 'cap-still-missing'))[0].status).toBe('open');
      expect((await gapTickets(client, 'cap-shared-key', OTHER_ORG_ID))[0].status).toBe('open');
    } finally {
      await client.end();
    }
  });

  test('a gap that comes back reopens the ticket the check closed, instead of going ticketless', async () => {
    const client = await freshDatabase('coverage_reopens_gap');
    activeClient = client;
    try {
      await seedRule(client, 'cap-flaky', { minimumSourceCount: 1 });
      await recompute();
      await seedSource(client, 'src-flaky');
      await recompute();
      const [closed] = await gapTickets(client, 'cap-flaky');
      expect(closed.status).toBe('resolved');

      // The only source is retracted: search drops it, so the gap is back.
      await client.query(
        `update pilot.shadow_library_sources
           set retrieval_suppressed = true,
               suppression_reason = 'Retracted by the publisher (test fixture).',
               suppressed_at = now(),
               suppressed_by_account_id = $2
         where organization_id = $1 and source_id = 'src-flaky'`,
        [ORG_ID, ADMIN_ID],
      );
      const result = await recompute();
      expect(result.find((row) => row.capability_key === 'cap-flaky')?.coverage_state).toBe('uncovered');

      const tickets = await gapTickets(client, 'cap-flaky');
      expect(tickets).toHaveLength(1);
      expect(tickets[0].research_requirement_id).toBe(closed.research_requirement_id);
      expect(tickets[0].status).toBe('open');
      expect(tickets[0].resolved_at).toBeNull();
      // An open ticket does not name who resolved it; when the last closure
      // happened is kept.
      expect(tickets[0].metadata).not.toHaveProperty('resolution');
      expect(tickets[0].metadata).not.toHaveProperty('resolved_by_account_id');
      expect(tickets[0].metadata).not.toHaveProperty('resolved_by_role');
      expect(tickets[0].metadata.reopened_after_resolution_at).toEqual(expect.any(String));
      expect(tickets[0].metadata.coverage_state).toBe('uncovered');
      expect(tickets[0].knowledge_gap).toContain('No qualifying SHADOW Library sources');
    } finally {
      await client.end();
    }
  });

  test('a ticket a person resolved by hand is never reopened automatically', async () => {
    const client = await freshDatabase('coverage_manual_resolution_stands');
    activeClient = client;
    try {
      await seedRule(client, 'cap-waived', { minimumSourceCount: 1 });
      await recompute();
      const [opened] = await gapTickets(client, 'cap-waived');

      const resolved = await resolveShadowResearchRequirement({
        organizationId: ORG_ID,
        researchRequirementId: Number(opened.research_requirement_id),
        resolvedByAccountId: ADMIN_ID,
        resolvedByRole: 'organization_admin',
        metadata: { note: 'Not pursuing this capability.' },
        expectedSubjectAthleteId: null,
      });
      expect(resolved).toBe(true);

      // Still uncovered: a person's decision is not overridden.
      await recompute();
      const tickets = await gapTickets(client, 'cap-waived');
      expect(tickets).toHaveLength(1);
      expect(tickets[0].status).toBe('resolved');
      expect(tickets[0].metadata.note).toBe('Not pursuing this capability.');
    } finally {
      await client.end();
    }
  });

  // A coverage gap names no athlete. A row under the same key that does name
  // one is not the coverage check's to close.
  test('a row that names an athlete is never closed by coverage', async () => {
    const client = await freshDatabase('coverage_close_skips_athlete_rows');
    activeClient = client;
    try {
      await seedRule(client, 'cap-athlete-row', { minimumSourceCount: 1 });
      await client.query(
        `insert into pilot.shadow_research_requirements
           (organization_id, source_event_name, source_entity_type, source_entity_id,
            research_requirement, knowledge_gap, source_status, source_confidence_tier,
            source_verification_state, created_by_account_id, created_by_role, metadata, subject_id)
         values ($1, 'SHADOW_LIBRARY_CAPABILITY_GAP_DETECTED', 'shadow_library_capability_map', 'cap-athlete-row',
            'requirement', 'gap', 'missing', 'INSUFFICIENT', 'unknown', $2, 'organization_admin', '{}'::jsonb,
            'athlete-coverage-subject')`,
        [ORG_ID, ADMIN_ID],
      );
      await seedSource(client, 'src-athlete-row');

      const result = await recompute();
      expect(result.find((row) => row.capability_key === 'cap-athlete-row')?.coverage_state).toBe('covered');
      expect((await gapTickets(client, 'cap-athlete-row'))[0].status).toBe('open');
    } finally {
      await client.end();
    }
  });
});

describe('listApprovedGlobalEvidenceForResearchBridge against real rows', () => {
  // suppressSource flips only retrieval_suppressed -- approval and
  // verification stay -- so the export needs the flag in its own WHERE or it
  // keeps shipping a retracted source's text as approved evidence.
  test('a source suppressed for retraction is absent; an approved one is present', async () => {
    const client = await freshDatabase('bridge_retracted');
    activeClient = client;
    try {
      await seedSource(client, 'src-standing', {
        sourceType: 'peer_reviewed',
        text: 'Standing evidence passage.',
      });
      await seedSource(client, 'src-withdrawn', {
        state: 'retracted',
        sourceType: 'peer_reviewed',
        text: 'Withdrawn evidence passage.',
      });

      const rows = await listApprovedGlobalEvidenceForResearchBridge({ organizationId: ORG_ID });

      expect(rows.map((row) => row.text_content)).toEqual(['Standing evidence passage.']);
    } finally {
      await client.end();
    }
  });
});
