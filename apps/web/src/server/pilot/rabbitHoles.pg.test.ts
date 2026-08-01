// Real PostgreSQL-backed contract test for the rabbit holes migration.
//
// A rabbit hole is CONCEPT + HOMEWORK: the shape the product already shows in
// apps/web/components/AthleteWorkspace.tsx under the 'rabbit-holes' tab, where
// one lesson is hardcoded JSX addressed to one role.
//
// Five things need proving, and none can be proven by reading SQL:
//
// 1. An anchor carries LESSONS, plural. A rabbit hole is not one-per-anchor --
//    two coaches may both write about the same gap type, and both must come
//    back.
//
// 2. The anchor vocabulary is closed and the anchor KEY is not. anchor_type is
//    refused outside eight values; anchor_key deliberately accepts anything,
//    because one column holds values drawn from eight separate vocabularies and
//    no CHECK could tell which one applies. That obligation belongs to the
//    writing code, so this file records it as an executable fact: every value
//    of the importable vocabularies stores and reads back, and a key belonging
//    to no vocabulary at all is accepted by the database.
//
// 3. audience never names a role the platform cannot hold. The role list is
//    read out of pilot.accounts' own CHECK rather than retyped, so adding a
//    role without teaching audience about it fails here.
//
// 4. The SHADOW Library reference behaves as a nullable pointer, not a foreign
//    key. A citation resolves only for a document that is approved, verified,
//    indexed, in the SAME organization and hanging off an approved, verified,
//    active source. Anything else -- a document that never existed, one still
//    pending review, another gym's, one purged with its source -- leaves the
//    lesson intact and the citation absent. Never an empty citation shell, and
//    never a borrowed SHADOW evidence tier.
//
// 5. The runner's readiness check actually fails when the migration did not
//    land. An all-green suite whose readiness passes on an unmigrated database
//    proves nothing, so that case -- and a same-named non-partial index, and a
//    narrowed anchor vocabulary -- are asserted directly against the real
//    runner.
//
// Spins up the same disposable, local-only embedded Postgres the other
// migration suites use. It NEVER connects to production or staging.

import { type ChildProcessByStdio, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import type { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';

import { Client } from 'pg';

import { FORMULA_IDS } from './formulas/types';
import { deriveEvidenceTier } from './shadowEvidenceTier';
import { boardSeatConfigs } from '@/app/board/boardWorkspaceConfig';

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-rabbit-holes-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const MIGRATION_FILE = 'pilot_slice_postgres_rabbit_holes_migration.sql';
const MIGRATION_RUNNER_PATH = path.resolve(
  __dirname,
  '../../../scripts/pilot-apply-rabbit-holes-migration.mjs',
);

const ORG_A = 'org-rabbit-a';
const ORG_B = 'org-rabbit-b';
const COACH_ID = 'acct-rabbit-coach';
const SECOND_COACH_ID = 'acct-rabbit-coach-two';
const ORG_B_COACH_ID = 'acct-rabbit-b-coach';

// The read the surface makes, minus the citation: every published lesson for
// one organization, one anchor and one audience. The citation-resolving form is
// asserted in the library test, which is the only database here carrying the
// SHADOW review columns.
const ANCHOR_LESSONS_SQL = `
  select title, concept, homework, library_document_id
  from pilot.rabbit_holes
  where organization_id = $1
    and anchor_type = $2
    and anchor_key = $3
    and audience in ('all', $4)
    and status = 'published'
  order by title`;

// The full read. The document is joined under the same predicate
// shadowLibrary.ts retrieval uses, INCLUDING d.organization_id =
// r.organization_id -- without a foreign key, organization scoping of the
// citation is the read's responsibility. A left join, so a lesson whose
// citation does not resolve still renders; only the citation disappears.
const PUBLISHED_WITH_CITATION_SQL = `
  select
    r.title,
    r.homework,
    d.document_id as cited_document_id,
    d.document_name as cited_document_name
  from pilot.rabbit_holes r
  left join pilot.shadow_library_documents d
    on d.organization_id = r.organization_id
   and d.document_id = r.library_document_id
   and d.ingest_state = 'indexed'
   and d.index_completed_at is not null
   and d.approval_state = 'approved'
   and d.verification_state = 'verified'
   and exists (
     select 1
     from pilot.shadow_library_sources s
     where s.source_id = d.source_id
       and s.organization_id = d.organization_id
       and s.status = 'active'
       and s.approval_state = 'approved'
       and s.verification_state = 'verified'
   )
  where r.organization_id = $1
    and r.anchor_type = $2
    and r.anchor_key = $3
    and r.audience in ('all', $4)
    and r.status = 'published'
  order by r.title`;

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
let boardRoleSql: string;
let progressionSql: string;
let videoSessionsSql: string;
let complianceSql: string;
let complianceSeedsSql: string;
let shadowRuntimeSql: string;
let shadowEvidenceSql: string;
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
 * Fresh database with the base schema, the board role vocabulary, two
 * organizations and the accounts the author foreign key needs. This migration
 * is NOT applied here -- each test decides when to apply it.
 */
async function freshDatabase(name: string): Promise<Client> {
  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  await admin.query(`drop database if exists ${name}`);
  // UTF8 explicitly: production Postgres is UTF8 and several migration files
  // carry non-ASCII characters in their headers, which a database created in
  // the embedded cluster's platform default encoding cannot accept.
  await admin.query(
    `create database ${name} with encoding 'UTF8' template template0 lc_collate 'C' lc_ctype 'C'`,
  );
  await admin.end();

  const client = new Client({ connectionString: connectionStringFor(name) });
  await client.connect();
  await client.query(baseSchemaSql);
  // The audience vocabulary is the account role vocabulary plus 'all', and
  // 'board' only joins that vocabulary here.
  await client.query(boardRoleSql);

  for (const organizationId of [ORG_A, ORG_B]) {
    await client.query(
      `insert into pilot.organizations (organization_id, organization_name, status)
       values ($1, $1, 'active') on conflict do nothing`,
      [organizationId],
    );
  }
  const accounts: Array<[string, string]> = [
    [COACH_ID, ORG_A],
    [SECOND_COACH_ID, ORG_A],
    [ORG_B_COACH_ID, ORG_B],
  ];
  for (const [accountId, organizationId] of accounts) {
    await client.query(
      `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
       values ($1, 'coach', $2, 'ppbf_local') on conflict do nothing`,
      [accountId, organizationId],
    );
  }
  return client;
}

/** Adds the migrations that own the anchor vocabularies stored in SQL. */
async function freshVocabularyDatabase(name: string): Promise<Client> {
  const client = await freshDatabase(name);
  await client.query(progressionSql);
  // compliance_violations references pilot.video_sessions, which is
  // migration-owned rather than part of the base schema.
  await client.query(videoSessionsSql);
  await client.query(complianceSql);
  await client.query(complianceSeedsSql);
  return client;
}

/** Adds the SHADOW Library review columns the citation predicate reads. */
async function freshLibraryDatabase(name: string): Promise<Client> {
  const client = await freshDatabase(name);
  // Both files carry their own begin/commit, so they are sent as-is rather
  // than through the runner's transaction.
  await client.query(shadowRuntimeSql);
  await client.query(shadowEvidenceSql);
  return client;
}

interface LessonInput {
  organizationId?: string;
  anchorType: string;
  anchorKey: string;
  audience?: string;
  title: string;
  concept?: string;
  homework?: string | null;
  libraryDocumentId?: string | null;
  authorAccountId?: string | null;
  authorDisplayName?: string;
  status?: string;
}

async function publishLesson(client: Client, values: LessonInput): Promise<string> {
  const rabbitHoleId = crypto.randomUUID();
  await client.query(
    `insert into pilot.rabbit_holes
       (organization_id, rabbit_hole_id, anchor_type, anchor_key, audience,
        title, concept, homework, library_document_id,
        author_account_id, author_display_name, status)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [
      values.organizationId ?? ORG_A,
      rabbitHoleId,
      values.anchorType,
      values.anchorKey,
      values.audience ?? 'all',
      values.title,
      values.concept ?? 'Force begins at the rear foot and arrives at the wrist.',
      values.homework ?? null,
      values.libraryDocumentId ?? null,
      values.authorAccountId === undefined ? COACH_ID : values.authorAccountId,
      values.authorDisplayName ?? 'Coach Jason',
      values.status ?? 'published',
    ],
  );
  return rabbitHoleId;
}

async function constraintDefinition(
  client: Client,
  table: string,
  constraintName: string,
): Promise<string> {
  const { rows } = await client.query(
    `select pg_get_constraintdef(oid) as def
     from pg_constraint
     where conrelid = $1::regclass and conname = $2`,
    [table, constraintName],
  );
  return rows[0]?.def ?? '';
}

/** The quoted literals of a CHECK, which is where a vocabulary is written. */
function checkVocabulary(definition: string): string[] {
  return [...definition.matchAll(/'([^']*)'/g)].map((match) => match[1]);
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

  const readInfra = (file: string) => fs.readFile(path.join(INFRA_DIR, file), 'utf8');

  baseSchemaSql = await readInfra('pilot_slice_postgres.sql');
  boardRoleSql = await readInfra('pilot_slice_postgres_board_role_migration.sql');
  progressionSql = await readInfra('pilot_slice_postgres_progression_migration.sql');
  videoSessionsSql = await readInfra('pilot_slice_postgres_video_sessions_migration.sql');
  complianceSql = await readInfra('pilot_slice_postgres_compliance_migration.sql');
  complianceSeedsSql = await readInfra('pilot_slice_postgres_compliance_rule_seeds_migration.sql');
  shadowRuntimeSql = await readInfra('pilot_slice_postgres_shadow_runtime_migration.sql');
  shadowEvidenceSql = await readInfra('pilot_slice_postgres_shadow_evidence_migration.sql');
  // Like the board-seats and announcements runners, this runner opens the
  // transaction itself, so the file applies here as plain statements exactly as
  // the runner sends it.
  migrationSql = await readInfra(MIGRATION_FILE);

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

describe('rabbit holes migration against real Postgres', () => {
  test('the gap is real: without the migration no lesson can be stored or read', async () => {
    const client = await freshDatabase('ppbf_test_rabbit_absent');
    try {
      const table = await client.query(`select to_regclass('pilot.rabbit_holes') as t`);
      expect(table.rows[0].t).toBeNull();

      await expect(
        client.query(ANCHOR_LESSONS_SQL, [ORG_A, 'gap_type', 'technique', 'athlete']),
      ).rejects.toThrow(/rabbit_holes|does not exist/);
    } finally {
      await client.end();
    }
  });

  // NEGATIVE CONTROL. If readiness passed here, every other assertion in this
  // file would be worthless: the runner would commit an environment where the
  // migration silently did nothing.
  test('the readiness check REFUSES a database where the migration never ran', async () => {
    const client = await freshDatabase('ppbf_test_rabbit_readiness_negative');
    try {
      await expect(applyMigrationTransaction(client, 'select 1')).rejects.toThrow(
        /RABBIT_HOLES_NOT_READY/,
      );

      const table = await client.query(`select to_regclass('pilot.rabbit_holes') as t`);
      expect(table.rows[0].t).toBeNull();
    } finally {
      await client.end();
    }
  });

  // The readiness check has to measure the read path specifically. An index of
  // the right name carrying every retired lesson is not the index the reader
  // traverses.
  test('the readiness check REFUSES a published-anchor index that is not partial', async () => {
    const client = await freshDatabase('ppbf_test_rabbit_readiness_index');
    try {
      await applyMigrationTransaction(client, migrationSql);
      await client.query('drop index pilot.idx_pilot_rabbit_holes_published_anchor');

      await expect(applyMigrationTransaction(client, 'select 1')).rejects.toThrow(
        /RABBIT_HOLES_NOT_READY/,
      );

      // A missing index is repaired by re-running, so a damaged environment
      // does not need hand surgery.
      await applyMigrationTransaction(client, migrationSql);
      const restored = await client.query(
        `select indpred is not null as is_partial
         from pg_index i
         join pg_class c on c.oid = i.indexrelid
         where c.relname = 'idx_pilot_rabbit_holes_published_anchor'`,
      );
      expect(restored.rows).toEqual([{ is_partial: true }]);

      // An index squatting on the name with the wrong shape is NOT repaired --
      // `create index if not exists` leaves it alone. Readiness is what stops
      // that environment being reported as migrated: the runner refuses to
      // commit rather than accepting an index that serves the wrong rows.
      await client.query('drop index pilot.idx_pilot_rabbit_holes_published_anchor');
      await client.query(
        `create index idx_pilot_rabbit_holes_published_anchor
           on pilot.rabbit_holes(organization_id, anchor_type, anchor_key, audience)`,
      );
      await expect(applyMigrationTransaction(client, migrationSql)).rejects.toThrow(
        /RABBIT_HOLES_NOT_READY/,
      );
    } finally {
      await client.end();
    }
  });

  test('a lesson is stored and fetched by its anchor, and an anchor carries more than one', async () => {
    const client = await freshDatabase('ppbf_test_rabbit_anchor_read');
    try {
      await applyMigrationTransaction(client, migrationSql);

      await publishLesson(client, {
        anchorType: 'gap_type',
        anchorKey: 'technique',
        audience: 'athlete',
        title: 'A: Kinetic force transfer',
        concept: 'Power does not generate in the shoulders.',
        homework: 'Thirty slow crosses, three seconds at full extension.',
      });
      // A rabbit hole is not one-per-anchor: a second coach writes about the
      // same gap type and both lessons are the reader's.
      await publishLesson(client, {
        anchorType: 'gap_type',
        anchorKey: 'technique',
        audience: 'all',
        title: 'B: Why the elbow finishes down',
        concept: 'Rotation ends before impact, not at it.',
        authorAccountId: SECOND_COACH_ID,
        authorDisplayName: 'Coach Danielle',
      });
      // A different key of the same vocabulary is a different anchor.
      await publishLesson(client, {
        anchorType: 'gap_type',
        anchorKey: 'endurance',
        audience: 'athlete',
        title: 'C: Round pacing',
      });
      // So is a different audience.
      await publishLesson(client, {
        anchorType: 'gap_type',
        anchorKey: 'technique',
        audience: 'coach',
        title: 'D: Cueing the rear foot',
      });

      const { rows } = await client.query(ANCHOR_LESSONS_SQL, [
        ORG_A, 'gap_type', 'technique', 'athlete',
      ]);
      expect(rows).toEqual([
        {
          title: 'A: Kinetic force transfer',
          concept: 'Power does not generate in the shoulders.',
          homework: 'Thirty slow crosses, three seconds at full extension.',
          library_document_id: null,
        },
        {
          title: 'B: Why the elbow finishes down',
          concept: 'Rotation ends before impact, not at it.',
          // Not every lesson has something to go and do.
          homework: null,
          library_document_id: null,
        },
      ]);

      const coachView = await client.query(ANCHOR_LESSONS_SQL, [
        ORG_A, 'gap_type', 'technique', 'coach',
      ]);
      expect(coachView.rows.map((row: { title: string }) => row.title)).toEqual([
        'B: Why the elbow finishes down',
        'D: Cueing the rear foot',
      ]);
    } finally {
      await client.end();
    }
  });

  test('an anchor_type, audience or status outside its vocabulary is refused', async () => {
    const client = await freshDatabase('ppbf_test_rabbit_vocabulary');
    try {
      await applyMigrationTransaction(client, migrationSql);

      // A display card is exactly what a lesson must never be anchored to.
      await expect(
        publishLesson(client, {
          anchorType: 'dashboard_card',
          anchorKey: 'kinetic-force-card',
          title: 'Anchored to copy',
        }),
      ).rejects.toThrow(/pilot_rabbit_holes_anchor_type_check/);

      await expect(
        publishLesson(client, {
          anchorType: 'gap_type',
          anchorKey: 'technique',
          audience: 'guardian',
          title: 'Addressed to nobody',
        }),
      ).rejects.toThrow(/pilot_rabbit_holes_audience_check/);

      await expect(
        publishLesson(client, {
          anchorType: 'gap_type',
          anchorKey: 'technique',
          title: 'Waiting on a reviewer who does not exist',
          status: 'pending_review',
        }),
      ).rejects.toThrow(/pilot_rabbit_holes_status_check/);

      // audience is the account role vocabulary plus 'all'. Read from
      // pilot.accounts' own CHECK rather than retyped, so a role added to the
      // platform without being taught to audience fails here.
      const roles = checkVocabulary(
        await constraintDefinition(client, 'pilot.accounts', 'accounts_role_check'),
      );
      const audiences = checkVocabulary(
        await constraintDefinition(client, 'pilot.rabbit_holes', 'pilot_rabbit_holes_audience_check'),
      );
      expect(roles).toContain('board');
      expect([...audiences].sort()).toEqual([...roles, 'all'].sort());
    } finally {
      await client.end();
    }
  });

  test('anchor keys come from several vocabularies at once, and the database polices none of them', async () => {
    const client = await freshVocabularyDatabase('ppbf_test_rabbit_anchor_keys');
    try {
      await applyMigrationTransaction(client, migrationSql);

      // Each vocabulary is read from its own authority, never retyped here.
      const gapTypes = checkVocabulary(
        await constraintDefinition(client, 'pilot.progression_gaps', 'progression_gaps_gap_type_check'),
      );
      const severities = checkVocabulary(
        await constraintDefinition(client, 'pilot.progression_gaps', 'progression_gaps_severity_check'),
      );
      const boardSeats = boardSeatConfigs.map((seat) => seat.slug);
      const evidenceTiers = [
        deriveEvidenceTier({ isAnsweredState: true, evidenceAvailability: 'available', citationCount: 2 }),
        deriveEvidenceTier({ isAnsweredState: true, evidenceAvailability: 'available', citationCount: 1 }),
        deriveEvidenceTier({ isAnsweredState: true, evidenceAvailability: 'available', citationCount: 0 }),
        deriveEvidenceTier({ isAnsweredState: false, evidenceAvailability: 'available', citationCount: 0 }),
      ];
      // The frozen union lives in the workspace components; there is no runtime
      // array to import, so these three are written out.
      const readinessBands = ['GREEN', 'YELLOW', 'RED'];
      // rule_id is deterministic ('rule_<category>_<organization_id>_<slug>'),
      // so the slug suffix is recoverable from the rules the seeds created.
      const seeded = await client.query(
        `select rule_id from pilot.compliance_rules where organization_id = $1 order by rule_id`,
        [ORG_A],
      );
      const complianceSlugs = seeded.rows.map(
        (row: { rule_id: string }) => row.rule_id.split(`_${ORG_A}_`)[1],
      );

      expect(gapTypes).toHaveLength(6);
      expect(severities).toHaveLength(4);
      expect(FORMULA_IDS).toHaveLength(39);
      expect(boardSeats).toHaveLength(8);
      expect(evidenceTiers).toEqual(['PROVEN', 'EMERGING', 'EXPERIMENTAL', 'RESEARCH_NEEDED']);
      expect(complianceSlugs.length).toBeGreaterThan(0);
      expect(complianceSlugs.every((slug) => typeof slug === 'string' && slug.length > 0)).toBe(true);

      const vocabularies: Array<[string, readonly string[]]> = [
        ['gap_type', gapTypes],
        ['severity', severities],
        ['formula_id', FORMULA_IDS],
        ['board_seat', boardSeats],
        ['evidence_tier', evidenceTiers],
        ['readiness_band', readinessBands],
        ['compliance_rule', complianceSlugs],
        // pilot.drills is owned elsewhere; a lesson about a drill holds its
        // drill_id and takes no foreign key, so a drill can still be deleted.
        ['drill', ['drill-slip-rope-01']],
      ];

      for (const [anchorType, keys] of vocabularies) {
        for (const anchorKey of keys) {
          await publishLesson(client, {
            anchorType,
            anchorKey,
            title: `${anchorType}/${anchorKey}`,
          });
        }
      }

      for (const [anchorType, keys] of vocabularies) {
        for (const anchorKey of keys) {
          const { rows } = await client.query(ANCHOR_LESSONS_SQL, [
            ORG_A, anchorType, anchorKey, 'athlete',
          ]);
          expect(rows.map((row: { title: string }) => row.title)).toEqual([
            `${anchorType}/${anchorKey}`,
          ]);
        }
      }

      // The same key text under two different vocabularies is two different
      // anchors, which is why no single CHECK on anchor_key could be right:
      // 'critical' is a severity and 'technique' is a gap type, and a
      // constraint listing every value of every vocabulary would accept either
      // under either.
      const crossed = await client.query(ANCHOR_LESSONS_SQL, [
        ORG_A, 'severity', 'technique', 'athlete',
      ]);
      expect(crossed.rows).toEqual([]);

      // THE OBLIGATION THIS RECORDS: the database accepts a key from no
      // vocabulary at all. Key validity is owned by the code that writes a
      // lesson, and nothing in the schema will catch it failing to check.
      await publishLesson(client, {
        anchorType: 'gap_type',
        anchorKey: 'not-a-gap-type',
        title: 'Stored anyway',
      });
      const junk = await client.query(ANCHOR_LESSONS_SQL, [
        ORG_A, 'gap_type', 'not-a-gap-type', 'athlete',
      ]);
      expect(junk.rows).toHaveLength(1);

      const anchorKeyChecks = await client.query(
        `select count(*)::int as n
         from pg_constraint
         where conrelid = 'pilot.rabbit_holes'::regclass
           and contype = 'c'
           and pg_get_constraintdef(oid) like '%anchor_key%'`,
      );
      expect(anchorKeyChecks.rows[0].n).toBe(0);
    } finally {
      await client.end();
    }
  });

  test('a retired lesson leaves the published read without leaving the record', async () => {
    const client = await freshDatabase('ppbf_test_rabbit_retired');
    try {
      await applyMigrationTransaction(client, migrationSql);

      const retiredId = await publishLesson(client, {
        anchorType: 'severity',
        anchorKey: 'critical',
        title: 'A: Superseded guidance',
        homework: 'Log every pain report before the next session.',
      });
      await publishLesson(client, {
        anchorType: 'severity',
        anchorKey: 'critical',
        title: 'B: Current guidance',
      });

      await client.query(
        `update pilot.rabbit_holes set status = 'retired', updated_at = now()
         where organization_id = $1 and rabbit_hole_id = $2`,
        [ORG_A, retiredId],
      );

      const published = await client.query(ANCHOR_LESSONS_SQL, [
        ORG_A, 'severity', 'critical', 'athlete',
      ]);
      expect(published.rows.map((row: { title: string }) => row.title)).toEqual([
        'B: Current guidance',
      ]);

      // Retiring is not deleting: homework a reader is part-way through does
      // not vanish from the record.
      const stored = await client.query(
        `select status, homework from pilot.rabbit_holes
         where organization_id = $1 and rabbit_hole_id = $2`,
        [ORG_A, retiredId],
      );
      expect(stored.rows).toEqual([
        { status: 'retired', homework: 'Log every pain report before the next session.' },
      ]);
    } finally {
      await client.end();
    }
  });

  test('another gym never sees this gym lessons on the same anchor', async () => {
    const client = await freshDatabase('ppbf_test_rabbit_cross_org');
    try {
      await applyMigrationTransaction(client, migrationSql);

      await publishLesson(client, {
        anchorType: 'formula_id',
        anchorKey: 'CORE-01',
        title: 'A gym lesson',
      });
      await publishLesson(client, {
        organizationId: ORG_B,
        anchorType: 'formula_id',
        anchorKey: 'CORE-01',
        title: 'B gym lesson',
        authorAccountId: ORG_B_COACH_ID,
        authorDisplayName: 'Coach Ruiz',
      });

      const orgA = await client.query(ANCHOR_LESSONS_SQL, [ORG_A, 'formula_id', 'CORE-01', 'athlete']);
      const orgB = await client.query(ANCHOR_LESSONS_SQL, [ORG_B, 'formula_id', 'CORE-01', 'athlete']);
      expect(orgA.rows.map((row: { title: string }) => row.title)).toEqual(['A gym lesson']);
      expect(orgB.rows.map((row: { title: string }) => row.title)).toEqual(['B gym lesson']);

      // Removing a gym takes its lessons with it and leaves the other alone.
      await client.query(`delete from pilot.accounts where organization_id = $1`, [ORG_B]);
      await client.query(`delete from pilot.organizations where organization_id = $1`, [ORG_B]);
      const remaining = await client.query(
        `select organization_id from pilot.rabbit_holes order by organization_id`,
      );
      expect(remaining.rows).toEqual([{ organization_id: ORG_A }]);
    } finally {
      await client.end();
    }
  });

  test('a library citation resolves only for an approved, verified document in the same gym', async () => {
    const client = await freshLibraryDatabase('ppbf_test_rabbit_library');
    try {
      await applyMigrationTransaction(client, migrationSql);

      const insertSource = async (sourceId: string, organizationId: string, approved: boolean) => {
        await client.query(
          `insert into pilot.shadow_library_sources
             (source_id, organization_id, title, source_type, authority_tier, status,
              approval_state, verification_state,
              approved_by_account_id, approved_at, verified_by_account_id, verified_at)
           values ($1, $2, $3, 'textbook', 1, 'active', $4, $5, $6, $7, $6, $7)`,
          [
            sourceId,
            organizationId,
            `Source ${sourceId}`,
            approved ? 'approved' : 'pending_review',
            approved ? 'verified' : 'unverified',
            approved ? COACH_ID : null,
            approved ? new Date() : null,
          ],
        );
      };
      const insertDocument = async (
        documentId: string,
        sourceId: string,
        organizationId: string,
        approved: boolean,
      ) => {
        await client.query(
          `insert into pilot.shadow_library_documents
             (document_id, source_id, organization_id, document_name, ingest_state,
              index_completed_at, approval_state, verification_state,
              approved_by_account_id, approved_at, verified_by_account_id, verified_at)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $6, $9, $6)`,
          [
            documentId,
            sourceId,
            organizationId,
            `Document ${documentId}`,
            approved ? 'indexed' : 'pending',
            approved ? new Date() : null,
            approved ? 'approved' : 'pending_review',
            approved ? 'verified' : 'unverified',
            approved ? COACH_ID : null,
          ],
        );
      };

      await insertSource('src-approved', ORG_A, true);
      await insertSource('src-pending', ORG_A, false);
      await insertSource('src-other-org', ORG_B, true);
      await insertDocument('doc-approved', 'src-approved', ORG_A, true);
      await insertDocument('doc-pending', 'src-pending', ORG_A, false);
      await insertDocument('doc-other-org', 'src-other-org', ORG_B, true);

      // No foreign key: a lesson citing a document that never existed is
      // accepted by the database, which is exactly why the read must resolve
      // the reference rather than trust it.
      const foreignKeys = await client.query(
        `select count(*)::int as n
         from pg_constraint
         where conrelid = 'pilot.rabbit_holes'::regclass
           and contype = 'f'
           and confrelid = 'pilot.shadow_library_documents'::regclass`,
      );
      expect(foreignKeys.rows[0].n).toBe(0);

      await publishLesson(client, {
        anchorType: 'evidence_tier',
        anchorKey: 'PROVEN',
        title: 'A: Cites an approved document',
        libraryDocumentId: 'doc-approved',
      });
      await publishLesson(client, {
        anchorType: 'evidence_tier',
        anchorKey: 'PROVEN',
        title: 'B: Cites a document that does not exist',
        libraryDocumentId: 'doc-never-existed',
      });
      await publishLesson(client, {
        anchorType: 'evidence_tier',
        anchorKey: 'PROVEN',
        title: 'C: Cites a document still in review',
        libraryDocumentId: 'doc-pending',
      });
      await publishLesson(client, {
        anchorType: 'evidence_tier',
        anchorKey: 'PROVEN',
        title: 'D: Cites another gym document',
        libraryDocumentId: 'doc-other-org',
      });
      await publishLesson(client, {
        anchorType: 'evidence_tier',
        anchorKey: 'PROVEN',
        title: 'E: Cites nothing',
        homework: 'Write down which claim you would want a source for.',
      });

      const before = await client.query(PUBLISHED_WITH_CITATION_SQL, [
        ORG_A, 'evidence_tier', 'PROVEN', 'athlete',
      ]);
      expect(before.rows).toEqual([
        {
          title: 'A: Cites an approved document',
          homework: null,
          cited_document_id: 'doc-approved',
          cited_document_name: 'Document doc-approved',
        },
        // Every unresolvable reference behaves identically: the lesson stands,
        // the citation is absent, and nothing renders in its place.
        { title: 'B: Cites a document that does not exist', homework: null, cited_document_id: null, cited_document_name: null },
        { title: 'C: Cites a document still in review', homework: null, cited_document_id: null, cited_document_name: null },
        { title: 'D: Cites another gym document', homework: null, cited_document_id: null, cited_document_name: null },
        {
          title: 'E: Cites nothing',
          homework: 'Write down which claim you would want a source for.',
          cited_document_id: null,
          cited_document_name: null,
        },
      ]);

      // Approval is revocable, which no foreign key could have expressed.
      await client.query(
        `update pilot.shadow_library_documents
         set approval_state = 'rejected', verification_state = 'unverified',
             approved_by_account_id = null, approved_at = null,
             verified_by_account_id = null, verified_at = null
         where document_id = 'doc-approved'`,
      );
      const revoked = await client.query(PUBLISHED_WITH_CITATION_SQL, [
        ORG_A, 'evidence_tier', 'PROVEN', 'athlete',
      ]);
      expect(revoked.rows[0]).toEqual({
        title: 'A: Cites an approved document',
        homework: null,
        cited_document_id: null,
        cited_document_name: null,
      });

      // Withdrawing library material takes its documents with it and must
      // neither be blocked by a lesson nor destroy one.
      await client.query(`delete from pilot.shadow_library_sources where source_id = 'src-approved'`);
      const purged = await client.query(PUBLISHED_WITH_CITATION_SQL, [
        ORG_A, 'evidence_tier', 'PROVEN', 'athlete',
      ]);
      expect(purged.rows).toHaveLength(5);
      expect(purged.rows[0]).toEqual({
        title: 'A: Cites an approved document',
        homework: null,
        cited_document_id: null,
        cited_document_name: null,
      });
    } finally {
      await client.end();
    }
  });

  test('a lesson outlives the coach who wrote it', async () => {
    const client = await freshDatabase('ppbf_test_rabbit_author');
    try {
      await applyMigrationTransaction(client, migrationSql);
      await publishLesson(client, {
        anchorType: 'board_seat',
        anchorKey: 'treasurer',
        audience: 'board',
        title: 'Reading a monthly statement',
        authorDisplayName: 'Coach Jason',
      });

      await client.query(`delete from pilot.accounts where account_id = $1`, [COACH_ID]);

      const { rows } = await client.query(
        `select author_account_id, author_display_name, status
         from pilot.rabbit_holes
         where organization_id = $1 and anchor_type = 'board_seat'`,
        [ORG_A],
      );
      expect(rows).toEqual([
        {
          author_account_id: null,
          author_display_name: 'Coach Jason',
          status: 'published',
        },
      ]);

      const stillPublished = await client.query(ANCHOR_LESSONS_SQL, [
        ORG_A, 'board_seat', 'treasurer', 'board',
      ]);
      expect(stillPublished.rows).toHaveLength(1);
    } finally {
      await client.end();
    }
  });

  test('re-running is a no-op and keeps every lesson', async () => {
    const client = await freshDatabase('ppbf_test_rabbit_idempotent');
    try {
      await applyMigrationTransaction(client, migrationSql);
      await publishLesson(client, {
        anchorType: 'readiness_band',
        anchorKey: 'RED',
        title: 'A: What RED means for today',
        homework: 'Name one thing you will do differently at training.',
      });
      await publishLesson(client, {
        anchorType: 'readiness_band',
        anchorKey: 'RED',
        title: 'B: Sleep debt and reaction time',
      });

      await applyMigrationTransaction(client, migrationSql);
      await applyMigrationTransaction(client, migrationSql);

      const { rows } = await client.query(ANCHOR_LESSONS_SQL, [
        ORG_A, 'readiness_band', 'RED', 'athlete',
      ]);
      expect(rows.map((row: { title: string }) => row.title)).toEqual([
        'A: What RED means for today',
        'B: Sleep debt and reaction time',
      ]);

      // Re-running must not multiply the constraints or the indexes either.
      const constraints = await client.query(
        `select conname from pg_constraint
         where conrelid = 'pilot.rabbit_holes'::regclass and contype = 'c'
         order by conname`,
      );
      expect(constraints.rows.map((row: { conname: string }) => row.conname)).toEqual([
        'pilot_rabbit_holes_anchor_type_check',
        'pilot_rabbit_holes_audience_check',
        'pilot_rabbit_holes_status_check',
      ]);
      const indexes = await client.query(
        `select indexname from pg_indexes
         where schemaname = 'pilot' and tablename = 'rabbit_holes'
         order by indexname`,
      );
      expect(indexes.rows.map((row: { indexname: string }) => row.indexname)).toEqual([
        'idx_pilot_rabbit_holes_published_anchor',
        'pilot_rabbit_holes_pkey',
      ]);
    } finally {
      await client.end();
    }
  });

  test('re-running reconciles an anchor vocabulary that drifted narrow', async () => {
    const client = await freshDatabase('ppbf_test_rabbit_reconcile');
    try {
      await applyMigrationTransaction(client, migrationSql);
      await publishLesson(client, {
        anchorType: 'drill',
        anchorKey: 'drill-slip-rope-01',
        title: 'Why the rope teaches the slip',
      });

      // An environment left holding a narrower list than this file describes.
      await client.query(
        `alter table pilot.rabbit_holes
         drop constraint pilot_rabbit_holes_anchor_type_check`,
      );
      await client.query(
        `alter table pilot.rabbit_holes
         add constraint pilot_rabbit_holes_anchor_type_check
         check (anchor_type in ('gap_type', 'drill'))`,
      );
      await expect(
        publishLesson(client, {
          anchorType: 'formula_id',
          anchorKey: 'CORE-01',
          title: 'Refused by a stale vocabulary',
        }),
      ).rejects.toThrow(/pilot_rabbit_holes_anchor_type_check/);
      await expect(applyMigrationTransaction(client, 'select 1')).rejects.toThrow(
        /RABBIT_HOLES_NOT_READY/,
      );

      // The file is the single source of truth, so re-running restores the
      // whole vocabulary rather than skipping a constraint that already exists.
      await applyMigrationTransaction(client, migrationSql);
      await publishLesson(client, {
        anchorType: 'formula_id',
        anchorKey: 'CORE-01',
        title: 'Accepted once the vocabulary is reconciled',
      });

      const definition = await constraintDefinition(
        client, 'pilot.rabbit_holes', 'pilot_rabbit_holes_anchor_type_check',
      );
      expect(checkVocabulary(definition).sort()).toEqual([
        'board_seat', 'compliance_rule', 'drill', 'evidence_tier',
        'formula_id', 'gap_type', 'readiness_band', 'severity',
      ]);

      // The lesson written before the drift is untouched by any of it.
      const kept = await client.query(ANCHOR_LESSONS_SQL, [
        ORG_A, 'drill', 'drill-slip-rope-01', 'athlete',
      ]);
      expect(kept.rows.map((row: { title: string }) => row.title)).toEqual([
        'Why the rope teaches the slip',
      ]);
    } finally {
      await client.end();
    }
  });

  test('a lesson cannot be recorded for an organization that does not exist', async () => {
    const client = await freshDatabase('ppbf_test_rabbit_foreign_keys');
    try {
      await applyMigrationTransaction(client, migrationSql);

      await expect(
        publishLesson(client, {
          organizationId: 'org-not-real',
          anchorType: 'gap_type',
          anchorKey: 'mental',
          title: 'Nowhere gym',
        }),
      ).rejects.toThrow(/foreign key/);

      await expect(
        publishLesson(client, {
          anchorType: 'gap_type',
          anchorKey: 'mental',
          title: 'Nobody wrote it',
          authorAccountId: 'acct-not-real',
        }),
      ).rejects.toThrow(/foreign key/);
    } finally {
      await client.end();
    }
  });
});
