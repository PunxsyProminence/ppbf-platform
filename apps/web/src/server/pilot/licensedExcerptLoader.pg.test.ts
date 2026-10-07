// Real PostgreSQL-backed test for the licensed-excerpt loader
// (OD-2026-10-03-002 section 2; OD-2026-10-05-009, -010).
//
// The loader writes through createShadowLibraryDocument and
// createShadowLibraryChunk, so only a real schema -- with the source-rights
// triggers (#1238), the unique (organization_id, content_sha256) key and the
// actor gate's membership rows -- can say whether a plan, an apply, a resume
// and a refusal land as intended. The "private blob container" here is a local
// folder: the workflow downloads the container into one, and the loader reads
// nothing else.
//
// Spins up the disposable, local-only embedded Postgres the other library
// suites use (scripts/test-embedded-pg-server.mjs). It NEVER connects to
// production or staging.

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
const DATA_DIR = path.join(os.tmpdir(), `ppbf-licensed-excerpts-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const TEST_DB_NAME = 'ppbf_test_licensed_excerpts';

const PLATFORM = '__platform__';
const GYM_ID = 'org-excerpt-gym';
const OTHER_GYM_ID = 'org-excerpt-other';
const OWNER_ACCOUNT = 'acct-excerpt-owner';
const GYM_ADMIN_ACCOUNT = 'acct-excerpt-admin';
const COACH_ACCOUNT = 'acct-excerpt-coach';

const SCHEMA_FILES = [
  'pilot_slice_postgres.sql',
  'pilot_slice_postgres_data_retention_deletion_migration.sql',
  'pilot_slice_postgres_shadow_runtime_migration.sql',
  'pilot_slice_postgres_shadow_evidence_migration.sql',
  'pilot_slice_postgres_shadow_chunk_embedding_migration.sql',
  'pilot_slice_postgres_retraction_surveillance_migration.sql',
  'pilot_slice_postgres_platform_library_scope_migration.sql',
  'pilot_slice_postgres_source_rights_migration.sql',
];

// Distinctive strings: the no-text-in-logs assertions look for them.
const SECRET_A = 'QUOKKA-LICENSED-TEXT-ALPHA a paragraph from a licensed book';
const SECRET_B = 'QUOKKA-LICENSED-TEXT-BRAVO a second paragraph';
const SECRET_C = 'QUOKKA-LICENSED-TEXT-CHARLIE a transcript at a timestamp';
// Non-ASCII on purpose: the plan's hash (Node) must equal the stored text's hash (Postgres).
const SECRET_D = 'QUOKKA-LICENSED-TEXT-DELTA na\u00efve caf\u00e9 \u2014 \u201cquoted\u201d \u{1F94A}\u00a0end';

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let loader: typeof import('./licensedExcerptLoader');
let library: typeof import('./shadowLibrary');
let workDir: string;
let gymSourceId: string;
let platformSourceId: string;

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

async function rawQuery<T extends Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  const client = new Client({ connectionString: connectionStringFor(TEST_DB_NAME) });
  await client.connect();
  try {
    return (await client.query<T>(sql, params)).rows;
  } finally {
    await client.end();
  }
}

async function freshFolder(files: Record<string, unknown>): Promise<string> {
  const dir = await fs.mkdtemp(path.join(workDir, 'batch-'));
  for (const [name, body] of Object.entries(files)) {
    const full = path.join(dir, ...name.split('/'));
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, typeof body === 'string' ? body : JSON.stringify(body, null, 2));
  }
  return dir;
}

function excerptFile(sourceId: string, overrides: Record<string, unknown> = {}) {
  return {
    format: 'ppbf-licensed-excerpts/1',
    source_id: sourceId,
    document_name: 'Quokka Conditioning, chapter 4',
    citation: 'Quokka, A. (2024). Conditioning for boxers. Example Press. ISBN 000-0-00-000000-0.',
    excerpts: [
      { locator: 'p. 41', text: SECRET_A },
      { locator: 'section 4.2', text: SECRET_B },
      { locator: 'p. 42 \u00a7 3', text: SECRET_D },
    ],
    ...overrides,
  };
}

async function run(options: {
  dir: string;
  organizationId?: string;
  actorAccountId?: string;
  apply?: boolean;
  confirm?: string;
  expectedFingerprint?: string;
}) {
  const lines: string[] = [];
  const outcome = await loader
    .runExcerptLoad({
      target: 'localhost/ppbf_test_licensed_excerpts',
      organizationId: options.organizationId ?? GYM_ID,
      actorAccountId: options.actorAccountId ?? GYM_ADMIN_ACCOUNT,
      dir: options.dir,
      apply: options.apply ?? false,
      confirm: options.confirm,
      expectedFingerprint: options.expectedFingerprint,
      log: (line) => lines.push(line),
    })
    .then((result) => ({ result, error: null as Error | null }), (error: Error) => ({ result: null, error }));
  const log = [...lines, outcome.error?.message ?? ''].join('\n');
  // Every run, whatever its outcome: licensed text never reaches the log.
  for (const secret of [SECRET_A, SECRET_B, SECRET_C, SECRET_D]) expect(log).not.toContain(secret.slice(0, 26));
  return { ...outcome, log };
}

async function documentCount(organizationId = GYM_ID): Promise<number> {
  const [row] = await rawQuery<{ n: string }>(
    'select count(*)::text as n from pilot.shadow_library_documents where organization_id = $1',
    [organizationId],
  );
  return Number(row.n);
}

async function chunkCount(organizationId = GYM_ID): Promise<number> {
  const [row] = await rawQuery<{ n: string }>(
    'select count(*)::text as n from pilot.shadow_library_chunks where organization_id = $1',
    [organizationId],
  );
  return Number(row.n);
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

  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  await admin.query(`drop database if exists ${TEST_DB_NAME}`);
  await admin.query(`create database ${TEST_DB_NAME}`);
  await admin.end();

  const migrate = new Client({ connectionString: connectionStringFor(TEST_DB_NAME) });
  await migrate.connect();
  for (const file of SCHEMA_FILES) {
    await migrate.query(await fs.readFile(path.join(INFRA_DIR, file), 'utf8'));
  }
  for (const org of [GYM_ID, OTHER_GYM_ID]) {
    await migrate.query(
      `insert into pilot.organizations (organization_id, organization_name, status)
       values ($1, $1, 'active') on conflict do nothing`,
      [org],
    );
  }
  for (const [accountId, role] of [
    [OWNER_ACCOUNT, 'platform_owner'],
    [GYM_ADMIN_ACCOUNT, 'organization_admin'],
    [COACH_ACCOUNT, 'coach'],
  ]) {
    await migrate.query(
      `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
       values ($1, $2, $3, 'microsoft') on conflict do nothing`,
      [accountId, role, GYM_ID],
    );
    await migrate.query(
      `insert into pilot.organization_memberships (account_id, organization_id, role)
       values ($1, $2, $3) on conflict do nothing`,
      [accountId, GYM_ID, role],
    );
  }
  await migrate.end();

  process.env.AZURE_POSTGRES_CONNECTION_STRING = connectionStringFor(TEST_DB_NAME);
  process.env.PPBF_POSTGRES_DISABLE_SSL = 'true';

  loader = await import('./licensedExcerptLoader');
  library = await import('./shadowLibrary');

  platformSourceId = (await library.createShadowLibrarySource({
    organizationId: PLATFORM,
    actorAccountId: OWNER_ACCOUNT,
    actorRole: 'platform_owner',
    title: 'Quokka Platform Lecture',
    sourceType: 'governing_body',
    authorityTier: 3,
    status: 'active',
  })).source_id;

  workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ppbf-excerpts-'));
});

// Each test gets its own excerpt-only source: a non-owned source is held to the
// per-source excerpt budget (10 chunks), and the loads in this suite would
// otherwise add up on one shared source. The rights marker is the one an
// excerpt-only source carries (#1238); the loader does not require it.
beforeEach(async () => {
  gymSourceId = (await library.createShadowLibrarySource({
    organizationId: GYM_ID,
    actorAccountId: GYM_ADMIN_ACCOUNT,
    actorRole: 'organization_admin',
    title: 'Quokka Conditioning',
    sourceType: 'peer_reviewed',
    authorityTier: 3,
    status: 'active',
  })).source_id;
  await rawQuery(`update pilot.shadow_library_sources set rights_status = 'licensed_excerpt_only' where source_id = $1`, [gymSourceId]);
});

afterAll(async () => {
  const { closePool } = await import('./db');
  await closePool();
  if (workDir) await fs.rm(workDir, { recursive: true, force: true });
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

describe('licensed-excerpt loader (real database)', () => {
  test('dry run plans, writes nothing, and prints a fingerprint but no text', async () => {
    const dir = await freshFolder({ 'book/chapter-4.json': excerptFile(gymSourceId) });
    const before = await chunkCount();
    const { result, error, log } = await run({ dir });
    expect(error).toBeNull();
    expect(result!.plan.blocked).toBe(false);
    expect(result!.plan.files.map((file) => [file.name, file.status, file.createOrdinals])).toEqual([
      ['book/chapter-4.json', 'new', [0, 1, 2]],
    ]);
    expect(result!.plan.files[0].sourceRights).toBe('licensed_excerpt_only');
    expect(log).toMatch(/plan_fingerprint: sha256:[0-9a-f]{64}/);
    expect(log).toContain('mode: dry-run (nothing written)');
    expect(await chunkCount()).toBe(before);
  });

  test('apply refuses without the phrase, without a fingerprint, or with a stale one -- before any write', async () => {
    const dir = await freshFolder({ 'a.json': excerptFile(gymSourceId, { document_name: 'Refusals' }) });
    const before = await chunkCount();
    const docsBefore = await documentCount();
    const noPhrase = await run({ dir, apply: true, expectedFingerprint: `sha256:${'0'.repeat(64)}` });
    expect(noPhrase.error?.message).toMatch(/^CONFIRM_PHRASE_MISMATCH/);
    const noPrint = await run({ dir, apply: true, confirm: 'LOAD EXCERPTS' });
    expect(noPrint.error?.message).toMatch(/^MISSING_EXPECTED_FINGERPRINT/);
    const stale = await run({ dir, apply: true, confirm: 'LOAD EXCERPTS', expectedFingerprint: `sha256:${'0'.repeat(64)}` });
    expect(stale.error?.message).toMatch(/^PLAN_FINGERPRINT_MISMATCH/);
    expect(await chunkCount()).toBe(before);
    expect(await documentCount()).toBe(docsBefore);
  });

  test('apply with the reviewed fingerprint loads excerpts; a rerun is a no-op', async () => {
    const dir = await freshFolder({ 'book/chapter-4.json': excerptFile(gymSourceId) });
    const dry = await run({ dir });
    const applied = await run({ dir, apply: true, confirm: 'LOAD EXCERPTS', expectedFingerprint: dry.result!.plan.fingerprint });
    expect(applied.error).toBeNull();
    expect(applied.result).toMatchObject({ documentsCreated: 1, chunksWritten: 3 });

    const documentId = applied.result!.plan.files[0].documentId
      ?? (await rawQuery<{ document_id: string }>(
        'select document_id from pilot.shadow_library_documents where content_sha256 = $1',
        [dry.result!.plan.files[0].contentSha256],
      ))[0].document_id;
    const chunks = await rawQuery<{ ordinal: number; text_kind: string; excerpt_locator: string; text_content: string; created_by_role: string }>(
      `select ordinal, text_kind, excerpt_locator, text_content, created_by_role
         from pilot.shadow_library_chunks where document_id = $1 order by ordinal`,
      [documentId],
    );
    expect(chunks).toEqual([
      { ordinal: 0, text_kind: 'excerpt', excerpt_locator: 'p. 41', text_content: SECRET_A, created_by_role: 'organization_admin' },
      { ordinal: 1, text_kind: 'excerpt', excerpt_locator: 'section 4.2', text_content: SECRET_B, created_by_role: 'organization_admin' },
      { ordinal: 2, text_kind: 'excerpt', excerpt_locator: 'p. 42 \u00a7 3', text_content: SECRET_D, created_by_role: 'organization_admin' },
    ]);
    const [document] = await rawQuery<{ approval_state: string; metadata: Record<string, unknown> }>(
      'select approval_state, metadata from pilot.shadow_library_documents where document_id = $1',
      [documentId],
    );
    // Loaded text waits for a reviewer, exactly as the screen's does.
    expect(document.approval_state).toBe('pending_review');
    expect(document.metadata).toMatchObject({ intake_method: 'licensed_excerpt_loader', blob_name: 'book/chapter-4.json' });

    const again = await run({ dir });
    expect(again.result!.plan.files.map((file) => file.status)).toEqual(['complete']);
    const before = await chunkCount();
    const reapplied = await run({ dir, apply: true, confirm: 'LOAD EXCERPTS', expectedFingerprint: again.result!.plan.fingerprint });
    expect(reapplied.result).toMatchObject({ documentsCreated: 0, chunksWritten: 0 });
    expect(await chunkCount()).toBe(before);
  });

  test('a partly loaded document resumes at the missing ordinals', async () => {
    const dir = await freshFolder({ 'resume.json': excerptFile(gymSourceId, { document_name: 'Resume me' }) });
    const dry = await run({ dir });
    await run({ dir, apply: true, confirm: 'LOAD EXCERPTS', expectedFingerprint: dry.result!.plan.fingerprint });
    const [doc] = await rawQuery<{ document_id: string }>(
      'select document_id from pilot.shadow_library_documents where content_sha256 = $1',
      [dry.result!.plan.files[0].contentSha256],
    );
    // As if the apply had stopped after the first chunk.
    await rawQuery('delete from pilot.shadow_library_chunks where document_id = $1 and ordinal >= 1', [doc.document_id]);

    const resumePlan = await run({ dir });
    expect(resumePlan.result!.plan.files.map((file) => [file.status, file.createOrdinals])).toEqual([['resume', [1, 2]]]);
    const resumed = await run({ dir, apply: true, confirm: 'LOAD EXCERPTS', expectedFingerprint: resumePlan.result!.plan.fingerprint });
    expect(resumed.result).toMatchObject({ documentsCreated: 0, chunksWritten: 2 });
  });

  test('a stored chunk that differs from the file is a conflict and blocks the apply', async () => {
    const dir = await freshFolder({ 'conflict.json': excerptFile(gymSourceId, { document_name: 'Conflict' }) });
    const dry = await run({ dir });
    await run({ dir, apply: true, confirm: 'LOAD EXCERPTS', expectedFingerprint: dry.result!.plan.fingerprint });
    await rawQuery(
      `update pilot.shadow_library_chunks set text_content = 'edited by hand'
        where ordinal = 0 and document_id = (select document_id from pilot.shadow_library_documents where content_sha256 = $1)`,
      [dry.result!.plan.files[0].contentSha256],
    );
    const conflicted = await run({ dir });
    expect(conflicted.result!.plan.blocked).toBe(true);
    expect(conflicted.result!.plan.files[0].status).toBe('conflict');
    const refused = await run({ dir, apply: true, confirm: 'LOAD EXCERPTS', expectedFingerprint: conflicted.result!.plan.fingerprint });
    expect(refused.error?.message).toMatch(/^PLAN_BLOCKED/);
  });

  test('one bad file blocks the whole batch, and nothing is written', async () => {
    const dir = await freshFolder({
      'good.json': excerptFile(gymSourceId, { document_name: 'Good one' }),
      'no-locator.json': excerptFile(gymSourceId, { document_name: 'No locator', excerpts: [{ locator: '  ', text: SECRET_C }] }),
      'other-org-source.json': excerptFile(platformSourceId, { document_name: 'Wrong shelf' }),
      'notes.txt': 'stray file',
      'twin.json': excerptFile(gymSourceId, { document_name: 'Good one' }),
    });
    const before = await chunkCount();
    const docsBefore = await documentCount();
    const dry = await run({ dir });
    const byName = Object.fromEntries(dry.result!.plan.files.map((file) => [file.name, file]));
    expect(byName['good.json'].status).toBe('new');
    expect(byName['no-locator.json'].problems.join(' ')).toMatch(/locator is required/);
    expect(byName['other-org-source.json'].problems.join(' ')).toMatch(/does not exist in organization/);
    expect(byName['notes.txt'].problems).toEqual(['not a .json excerpt file']);
    expect(byName['twin.json'].problems).toEqual(['same content as good.json']);
    const refused = await run({ dir, apply: true, confirm: 'LOAD EXCERPTS', expectedFingerprint: dry.result!.plan.fingerprint });
    expect(refused.error?.message).toMatch(/^PLAN_BLOCKED/);
    expect(await chunkCount()).toBe(before);
    expect(await documentCount()).toBe(docsBefore);
  });

  test('the platform shelf is loaded only by the platform owner; a gym is loaded only by its admin', async () => {
    const dir = await freshFolder({
      'lecture.json': excerptFile(platformSourceId, {
        document_name: 'Lecture transcript',
        excerpts: [{ locator: '00:12:30', text: SECRET_C }],
      }),
    });
    const byAdmin = await run({ dir, organizationId: PLATFORM, actorAccountId: GYM_ADMIN_ACCOUNT });
    expect(byAdmin.error?.message).toMatch(/ACTOR_NOT_PLATFORM_OWNER/);
    const ownerOnGym = await run({ dir, organizationId: GYM_ID, actorAccountId: OWNER_ACCOUNT });
    expect(ownerOnGym.error?.message).toMatch(/ACTOR_PLATFORM_OWNER/);
    const coach = await run({ dir, organizationId: GYM_ID, actorAccountId: COACH_ACCOUNT });
    expect(coach.error?.message).toMatch(/ACTOR_ROLE_NOT_ALLOWED/);
    const otherGym = await run({ dir, organizationId: OTHER_GYM_ID, actorAccountId: GYM_ADMIN_ACCOUNT });
    expect(otherGym.error?.message).toMatch(/ACTOR_NOT_A_MEMBER/);

    const dry = await run({ dir, organizationId: PLATFORM, actorAccountId: OWNER_ACCOUNT });
    const applied = await run({
      dir,
      organizationId: PLATFORM,
      actorAccountId: OWNER_ACCOUNT,
      apply: true,
      confirm: 'LOAD EXCERPTS',
      expectedFingerprint: dry.result!.plan.fingerprint,
    });
    expect(applied.error).toBeNull();
    const rows = await rawQuery<{ text_kind: string; excerpt_locator: string }>(
      'select text_kind, excerpt_locator from pilot.shadow_library_chunks where organization_id = $1',
      [PLATFORM],
    );
    expect(rows).toEqual([{ text_kind: 'excerpt', excerpt_locator: '00:12:30' }]);
  });

  test('a file changed between the reviewed dry run and the apply is refused before any write', async () => {
    const dir = await freshFolder({ 'swap.json': excerptFile(gymSourceId, { document_name: 'Swapped' }) });
    const dry = await run({ dir });
    await fs.writeFile(
      path.join(dir, 'swap.json'),
      JSON.stringify(excerptFile(gymSourceId, { document_name: 'Swapped', excerpts: [{ locator: 'p. 9', text: SECRET_C }] })),
    );
    const chunksBefore = await chunkCount();
    const docsBefore = await documentCount();
    const refused = await run({ dir, apply: true, confirm: 'LOAD EXCERPTS', expectedFingerprint: dry.result!.plan.fingerprint });
    expect(refused.error?.message).toMatch(/^PLAN_FINGERPRINT_MISMATCH/);
    expect(await chunkCount()).toBe(chunksBefore);
    expect(await documentCount()).toBe(docsBefore);
  });

  test('the same plan against another database has another fingerprint', async () => {
    const dir = await freshFolder({ 'target.json': excerptFile(gymSourceId, { document_name: 'Target bound' }) });
    const here = await run({ dir });
    const plan = await loader.buildLoadPlan({
      target: 'production-host/postgres',
      organizationId: GYM_ID,
      actorAccountId: GYM_ADMIN_ACCOUNT,
      files: await loader.readExcerptFolder(dir),
    });
    expect(plan.fingerprint).not.toBe(here.result!.plan.fingerprint);
  });

  test('a loaded file edited and re-uploaded under the same name is a conflict, not a second document', async () => {
    const dir = await freshFolder({ 'edited.json': excerptFile(gymSourceId, { document_name: 'Edited later' }) });
    const dry = await run({ dir });
    await run({ dir, apply: true, confirm: 'LOAD EXCERPTS', expectedFingerprint: dry.result!.plan.fingerprint });

    await fs.writeFile(
      path.join(dir, 'edited.json'),
      JSON.stringify(excerptFile(gymSourceId, { document_name: 'Edited later', citation: 'Corrected citation.' })),
    );
    const docsBefore = await documentCount();
    const replanned = await run({ dir });
    expect(replanned.result!.plan.files[0].status).toBe('conflict');
    expect(replanned.result!.plan.files[0].problems.join(' ')).toMatch(/load the edited file under a new name/);
    const refused = await run({ dir, apply: true, confirm: 'LOAD EXCERPTS', expectedFingerprint: replanned.result!.plan.fingerprint });
    expect(refused.error?.message).toMatch(/^PLAN_BLOCKED/);
    expect(await documentCount()).toBe(docsBefore);
  });

  test.each([
    ['a changed locator', `update pilot.shadow_library_chunks set excerpt_locator = 'p. 999' where ordinal = 0 and document_id = $1`],
    ['an extra stored ordinal', `insert into pilot.shadow_library_chunks
       (chunk_id, document_id, source_id, organization_id, ordinal, text_content, metadata, created_by_account_id, created_by_role, text_kind, excerpt_locator)
       select 'chunk_extra_' || md5(random()::text), document_id, source_id, organization_id, 7, 'extra', '{}'::jsonb, 'x', 'organization_admin', 'excerpt', 'p. 7'
         from pilot.shadow_library_documents where document_id = $1`],
  ])('%s under a loaded document is a conflict', async (label, sql) => {
    const dir = await freshFolder({ [`tamper-${label.replace(/ /g, '-')}.json`]: excerptFile(gymSourceId, { document_name: `Tamper ${label}` }) });
    const dry = await run({ dir });
    await run({ dir, apply: true, confirm: 'LOAD EXCERPTS', expectedFingerprint: dry.result!.plan.fingerprint });
    const [doc] = await rawQuery<{ document_id: string }>(
      'select document_id from pilot.shadow_library_documents where content_sha256 = $1',
      [dry.result!.plan.files[0].contentSha256],
    );
    await rawQuery(sql, [doc.document_id]);
    const replanned = await run({ dir });
    expect(replanned.result!.plan.files[0].status).toBe('conflict');
    expect(replanned.result!.plan.blocked).toBe(true);
  });

  // CL-C2: the database-side budget refuses the excerpt that takes a licensed
  // source past it, and an apply writes one excerpt at a time -- so the plan
  // must refuse an over-budget source before the first write, or a rerun
  // would stop at the same excerpt forever.
  test('a file that would take a licensed source past its excerpt budget is blocked in the plan, and nothing is written', async () => {
    const budgetSourceId = (await library.createShadowLibrarySource({
      organizationId: GYM_ID,
      actorAccountId: GYM_ADMIN_ACCOUNT,
      actorRole: 'organization_admin',
      title: 'Quokka Budget Paper',
      sourceType: 'peer_reviewed',
      authorityTier: 3,
      status: 'active',
    })).source_id;
    await rawQuery(`update pilot.shadow_library_sources set rights_status = 'licensed_excerpt_only' where source_id = $1`, [budgetSourceId]);
    const overBudget = Array.from({ length: library.MAX_EXCERPT_CHUNKS_PER_NON_OWNED_SOURCE + 1 }, (_, index) => ({
      locator: `p. ${index + 1}`,
      text: `Budget passage ${index + 1}.`,
    }));

    // One file over the budget.
    const single = await freshFolder({
      'budget/whole-paper.json': excerptFile(budgetSourceId, { document_name: 'Whole paper', excerpts: overBudget }),
    });
    const before = await chunkCount();
    const docsBefore = await documentCount();
    const dry = await run({ dir: single });
    expect(dry.result!.plan.blocked).toBe(true);
    expect(dry.result!.plan.files[0].status).toBe('invalid');
    expect(dry.result!.plan.files[0].problems.join(' ')).toMatch(/would hold \d+ excerpts/);
    const refused = await run({ dir: single, apply: true, confirm: 'LOAD EXCERPTS', expectedFingerprint: dry.result!.plan.fingerprint });
    expect(refused.error?.message).toMatch(/^PLAN_BLOCKED/);

    // Two files, each within the budget, that together are not: both blocked.
    const half = Math.ceil(overBudget.length / 2);
    const split = await freshFolder({
      'budget/part-1.json': excerptFile(budgetSourceId, { document_name: 'Part 1', excerpts: overBudget.slice(0, half) }),
      'budget/part-2.json': excerptFile(budgetSourceId, { document_name: 'Part 2', excerpts: overBudget.slice(half) }),
    });
    const splitPlan = await run({ dir: split });
    expect(splitPlan.result!.plan.files.map((file) => file.status)).toEqual(['invalid', 'invalid']);

    // Within the budget (control): the first part alone loads.
    const ok = await freshFolder({
      'budget/part-1.json': excerptFile(budgetSourceId, { document_name: 'Part 1', excerpts: overBudget.slice(0, half) }),
    });
    const okPlan = await run({ dir: ok });
    expect(okPlan.result!.plan.blocked).toBe(false);
    expect(await chunkCount()).toBe(before);
    expect(await documentCount()).toBe(docsBefore);
  });
});
