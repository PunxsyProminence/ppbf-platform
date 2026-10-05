// POST /api/pilot/admin/content-import -- the upload route (IMP-12) -- against
// the full migrated schema, with the REAL content-import core behind it.
//
// app/api/pilot/admin/content-import/route.test.ts pins the route's own logic
// with the database mocked. This suite is what that one cannot show: that a
// check really writes nothing, that the org really comes from the session and
// not the body, that a literal org in a file really blocks, that a plan the
// database moved away from really cannot be applied, and that an apply really
// commits the content, its history and one audit row together. It also sends
// the committed 119-drill package (~590 KB) through the route's own body
// reading, which is the nearest this repository gets to the NOT SURE of
// whether that size passes -- the Azure ingress itself is not tested here.
//
// Only the session is stubbed (requireMicrosoftAuthenticatedPrincipal), as
// libraryReviewFlags.pg.test.ts does; the route, db.ts's pool and
// withTransaction, and every line of the core run for real.
//
// Spins up the same disposable, local-only embedded Postgres the other pg
// suites use. It NEVER connects to production or staging.

import { type ChildProcessByStdio, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import type { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';

import { NextRequest } from 'next/server';
import { Client } from 'pg';

import type { PilotPrincipal } from './auth';
import { readDatasetFiles } from './contentImport/cli';
import { claimIdsFromChunksCsv, LOADED_RESEARCH_CHUNKS } from './contentImport/referenceSets';
import type { PlanView } from './contentImport/upload';
import { requireMicrosoftAuthenticatedPrincipal } from './http';

jest.mock('./http', () => {
  const actual = jest.requireActual('./http');
  return { ...actual, requireMicrosoftAuthenticatedPrincipal: jest.fn() };
});

jest.setTimeout(300_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATABASE = 'content_upload';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-content-upload-pg-test-${Date.now()}`);
const WEB_DIR = path.resolve(__dirname, '../../..');
const SERVER_SCRIPT_PATH = path.join(WEB_DIR, 'scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(WEB_DIR, '../../infra/azure');
const FULL_SCHEMA_HELPER_PATH = path.join(WEB_DIR, 'scripts/lib/full-schema.mjs');
const SEED_DATA_DIR = path.join(WEB_DIR, 'seed-data');

const REGISTRIES = ['disciplines', 'competence-levels', 'cohort-definitions'] as const;

const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

const mockPrincipal = requireMicrosoftAuthenticatedPrincipal as jest.Mock;

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let client: Client;
/** A second connection: sees only what is COMMITTED. */
let observer: Client;
let POST: (request: NextRequest) => Promise<Response>;

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

beforeAll(async () => {
  PG_PORT = await findFreePort();
  serverProcess = spawn(process.execPath, [SERVER_SCRIPT_PATH, DATA_DIR, String(PG_PORT)], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stderrOutput = '';
  serverProcess.stderr.on('data', (chunk) => { stderrOutput += chunk.toString(); });

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
  serverProcess.stdout.resume();

  const fullSchema = await nativeDynamicImport(pathToFileURL(FULL_SCHEMA_HELPER_PATH).href);
  const applyFullSchema = fullSchema.applyFullSchema as (c: Client, opts?: { infraDir?: string }) => Promise<unknown>;

  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  await admin.query(`drop database if exists ${DATABASE}`);
  await admin.query(`create database ${DATABASE}`);
  await admin.end();

  client = new Client({ connectionString: connectionStringFor(DATABASE) });
  await client.connect();
  await applyFullSchema(client, { infraDir: INFRA_DIR });
  observer = new Client({ connectionString: connectionStringFor(DATABASE) });
  await observer.connect();
  await loadPlatformClaims();

  process.env.AZURE_POSTGRES_CONNECTION_STRING = connectionStringFor(DATABASE);
  // db.ts honours this only when NODE_ENV is exactly 'test' (Jest sets it).
  process.env.PPBF_POSTGRES_DISABLE_SSL = 'true';
  // Imported only now, so the app's lazily built pool targets this database.
  POST = (await import('@/app/api/pilot/admin/content-import/route')).POST;
});

afterAll(async () => {
  const { closePool } = await import('./db');
  await closePool().catch(() => {});
  await observer?.end().catch(() => {});
  await client?.end().catch(() => {});
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

// ---------------------------------------------------------------------------
// Fixtures

async function createOrganization(organizationId: string): Promise<void> {
  await client.query(
    `insert into pilot.organizations (organization_id, organization_name, status)
     values ($1, $1, 'active') on conflict (organization_id) do nothing`,
    [organizationId],
  );
}

/** A gym, its organization admin (active membership) and a coach of it. */
async function createGym(organizationId: string): Promise<{ admin: string; coach: string }> {
  await createOrganization(organizationId);
  const admin = `admin@${organizationId}`;
  const coach = `coach@${organizationId}`;
  for (const [accountId, role] of [[admin, 'organization_admin'], [coach, 'coach']] as const) {
    await client.query(
      `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
       values ($1, $2, $3, 'microsoft')`,
      [accountId, role, organizationId],
    );
    await client.query(
      `insert into pilot.organization_memberships (account_id, organization_id, role, active_flag)
       values ($1, $2, $3, true)`,
      [accountId, organizationId, role],
    );
  }
  return { admin, coach };
}

/** Every claim id of the LOADED research package, as chunks of the shared __platform__ library (referenceSetsDb.ts reads them for every gym). */
async function loadPlatformClaims(): Promise<void> {
  const ids = [...claimIdsFromChunksCsv(await fs.readFile(path.join(SEED_DATA_DIR, LOADED_RESEARCH_CHUNKS), 'utf8'))];
  await client.query(
    // ppbf_owned: the claims it stands in for are the research program's own
    // synthesis, and full text loads only under such a source (source rights).
    `insert into pilot.shadow_library_sources (source_id, organization_id, title, source_type, authority_tier, url, rights_status)
     values ('src_upload_test', '__platform__', 'Loaded research claims (test)', 'peer_reviewed', 1, 'https://example.org/upload-test', 'ppbf_owned')`,
  );
  await client.query(
    `insert into pilot.shadow_library_documents (document_id, source_id, organization_id, document_name, content_sha256)
     values ('doc_upload_test', 'src_upload_test', '__platform__', 'Loaded research claims (test)', 'upload-test')`,
  );
  await client.query(
    `insert into pilot.shadow_library_chunks (chunk_id, document_id, source_id, organization_id, ordinal, text_content, metadata)
     select 'chunk_' || claim_id, 'doc_upload_test', 'src_upload_test', '__platform__', ordinal::int, 'Claim ' || claim_id,
            jsonb_build_object('claim_id', claim_id)
       from unnest($1::text[]) with ordinality as claim(claim_id, ordinal)`,
    [ids],
  );
}

function principal(accountId: string, organizationId: string, role: PilotPrincipal['role'] = 'organization_admin'): PilotPrincipal {
  return { accountId, role, organizationId, athleteId: null, sessionToken: 'token', authProvider: 'microsoft' };
}

/** The committed files of these datasets as a browser sends them: bare file names. */
function uploadFiles(datasets: readonly string[]): { name: string; text: string }[] {
  return Object.entries(readDatasetFiles(SEED_DATA_DIR, datasets as never)).map(([relative, text]) => ({
    name: path.basename(relative),
    text,
  }));
}

/** The route's answer, as the page reads it. `plan` is absent on a refusal. */
interface RouteBody {
  committed?: boolean;
  plan: PlanView;
  import_id?: string | null;
  audit_mirror?: string;
  ledger_rows?: number;
  code?: string;
  error?: string;
}

async function post(as: PilotPrincipal, body: Record<string, unknown>): Promise<{ status: number; body: RouteBody }> {
  mockPrincipal.mockResolvedValue(as);
  const response = await POST(new NextRequest('http://localhost/api/pilot/admin/content-import', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }));
  return { status: response.status, body: (await response.json()) as RouteBody };
}

interface Counts {
  disciplines: number;
  levels: number;
  cohorts: number;
  drills: number;
  ledger: number;
  audit: number;
  shadowEvents: number;
}

/** Committed rows only: read on the observer connection. */
async function committedCounts(organizationId: string): Promise<Counts> {
  const { rows } = await observer.query<{ [K in keyof Counts]: string }>(
    `select
       (select count(*) from pilot.disciplines where organization_id = $1) as disciplines,
       (select count(*) from pilot.competence_levels where organization_id = $1) as levels,
       (select count(*) from pilot.cohort_definitions where organization_id = $1) as cohorts,
       (select count(*) from pilot.drill_library where organization_id = $1) as drills,
       (select count(*) from pilot.reference_content_revisions where organization_id = $1) as ledger,
       (select count(*) from pilot.audit_events where organization_id = $1 and entity_type = 'content_import') as audit,
       (select count(*) from pilot.shadow_events where organization_id = $1 and entity_type = 'content_import') as "shadowEvents"`,
    [organizationId],
  );
  return Object.fromEntries(Object.entries(rows[0]).map(([key, value]) => [key, Number(value)])) as unknown as Counts;
}

const NOTHING = { disciplines: 0, levels: 0, cohorts: 0, drills: 0, ledger: 0, audit: 0, shadowEvents: 0 };

// ---------------------------------------------------------------------------

describe('POST /api/pilot/admin/content-import against the real core', () => {
  test('commit omitted: nothing is written and the plan comes back', async () => {
    const gym = await createGym('gym_check');

    const checked = await post(principal(gym.admin, 'gym_check'), { files: uploadFiles(REGISTRIES) });

    expect(checked.status).toBe(200);
    expect(checked.body.committed).toBe(false);
    expect(checked.body.plan.organization_id).toBe('gym_check');
    expect(checked.body.plan.counts.disciplines).toEqual({ new: 5, new_version: 0, unchanged: 0, absent: 0, reject: 0 });
    expect(checked.body.plan.counts['cohort-definitions']).toEqual({ new: 6, new_version: 0, unchanged: 0, absent: 0, reject: 0 });
    expect(checked.body.plan.changes).toBe(17);
    expect(checked.body.plan.blocking).toEqual([]);
    expect(checked.body.plan.plan_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(checked.body.plan.units).toContainEqual(expect.objectContaining({ dataset: 'disciplines', key: 'boxing', outcome: 'new', label: 'Boxing' }));

    expect(await committedCounts('gym_check')).toEqual(NOTHING);
  });

  test('a coach is refused, and nothing is written', async () => {
    const gym = await createGym('gym_coach');

    const refused = await post(principal(gym.coach, 'gym_coach', 'coach'), { files: uploadFiles(REGISTRIES) });

    expect(refused.status).toBe(403);
    expect(await committedCounts('gym_coach')).toEqual(NOTHING);
  });

  test('an organization named in the body is ignored: the plan and the write are the session\'s gym, the named gym is untouched', async () => {
    const gym = await createGym('gym_session');
    await createGym('gym_named');

    const checked = await post(principal(gym.admin, 'gym_session'), { files: uploadFiles(REGISTRIES), organization_id: 'gym_named' });
    expect(checked.status).toBe(200);
    expect(checked.body.plan.organization_id).toBe('gym_session');

    const applied = await post(principal(gym.admin, 'gym_session'), {
      files: uploadFiles(REGISTRIES),
      organization_id: 'gym_named',
      commit: true,
      plan_hash: checked.body.plan.plan_hash,
    });

    expect(applied.status).toBe(200);
    expect(applied.body).toMatchObject({ committed: true, audit_mirror: 'written', ledger_rows: 17 });
    // One transaction wrote the content, its history and one audit row; the
    // SHADOW mirror followed the commit.
    expect(await committedCounts('gym_session')).toEqual({ disciplines: 5, levels: 6, cohorts: 6, drills: 0, ledger: 17, audit: 1, shadowEvents: 1 });
    expect(await committedCounts('gym_named')).toEqual(NOTHING);
    const audit = await observer.query(
      "select entity_id, actor_account_id, actor_role from pilot.audit_events where organization_id = 'gym_session' and entity_type = 'content_import'",
    );
    expect(audit.rows).toEqual([{ entity_id: applied.body.import_id, actor_account_id: 'admin@gym_session', actor_role: 'organization_admin' }]);

    // The same files again: every item unchanged, nothing to apply.
    const again = await post(principal(gym.admin, 'gym_session'), { files: uploadFiles(REGISTRIES) });
    expect(again.body.plan.changes).toBe(0);
    expect(again.body.plan.totals).toEqual({ new: 0, new_version: 0, unchanged: 17, absent: 0, reject: 0 });
  });

  test('a literal organization in a file is a blocking finding, and that plan cannot be applied', async () => {
    const gym = await createGym('gym_literal');
    await createGym('gym_target');
    const files = uploadFiles(REGISTRIES).map((file) =>
      (file.name === 'seed_disciplines.csv' ? { ...file, text: file.text.replace('{{PPBF_ORG_ID}}', 'gym_target') } : file));
    expect(files.find((file) => file.name === 'seed_disciplines.csv')?.text).toContain('gym_target');

    const checked = await post(principal(gym.admin, 'gym_literal'), { files });

    expect(checked.status).toBe(200);
    expect(checked.body.plan.blocking).toContainEqual(
      expect.objectContaining({ code: 'literal_organization', file: 'seed_disciplines.csv', column: 'organization_id' }),
    );

    const applied = await post(principal(gym.admin, 'gym_literal'), { files, commit: true, plan_hash: checked.body.plan.plan_hash });

    expect(applied.status).toBe(409);
    expect(applied.body.code).toBe('PLAN_BLOCKED');
    expect(await committedCounts('gym_literal')).toEqual(NOTHING);
    expect(await committedCounts('gym_target')).toEqual(NOTHING);
  });

  test('commit is refused when the plan hash changed since the preview, and nothing is written', async () => {
    const gym = await createGym('gym_stale');
    const first = await post(principal(gym.admin, 'gym_stale'), { files: uploadFiles(REGISTRIES) });
    expect((await post(principal(gym.admin, 'gym_stale'), {
      files: uploadFiles(REGISTRIES), commit: true, plan_hash: first.body.plan.plan_hash,
    })).status).toBe(200);
    const before = await committedCounts('gym_stale');

    // Jason's revision: boxing gets a new display name.
    const revised = uploadFiles(REGISTRIES).map((file) =>
      (file.name === 'seed_disciplines.csv' ? { ...file, text: file.text.replace(',boxing,Boxing,', ',boxing,Boxing (revised),') } : file));
    expect(revised.find((file) => file.name === 'seed_disciplines.csv')?.text).toContain('Boxing (revised)');
    const shown = await post(principal(gym.admin, 'gym_stale'), { files: revised });
    expect(shown.body.plan.counts.disciplines).toEqual({ new: 0, new_version: 1, unchanged: 4, absent: 0, reject: 0 });

    // Someone else changes that same row after the preview was shown.
    await client.query("update pilot.disciplines set display_name = 'Boxing (edited elsewhere)' where organization_id = 'gym_stale' and discipline = 'boxing'");

    const applied = await post(principal(gym.admin, 'gym_stale'), { files: revised, commit: true, plan_hash: shown.body.plan.plan_hash });

    expect(applied.status).toBe(409);
    expect(applied.body.code).toBe('STALE_PLAN');
    expect(applied.body.error).toMatch(/^the database changed after the plan was made .*nothing was written/);
    expect(await committedCounts('gym_stale')).toEqual(before);
    const boxing = await observer.query("select display_name from pilot.disciplines where organization_id = 'gym_stale' and discipline = 'boxing'");
    expect(boxing.rows).toEqual([{ display_name: 'Boxing (edited elsewhere)' }]);
  });

  test('the committed 119-drill package (~590 KB) goes through the route\'s own body reading, plans, and applies', async () => {
    const gym = await createGym('gym_drills');
    const files = uploadFiles([...REGISTRIES, 'drill-library']);
    const drillBytes = files
      .filter((file) => file.name.startsWith('seed_drill_'))
      .reduce((sum, file) => sum + Buffer.byteLength(file.text, 'utf8'), 0);
    const bodyBytes = Buffer.byteLength(JSON.stringify({ files }), 'utf8');
    expect(drillBytes).toBeGreaterThan(580_000);

    const started = Date.now();
    const checked = await post(principal(gym.admin, 'gym_drills'), { files });
    const checkMs = Date.now() - started;

    expect(checked.status).toBe(200);
    expect(checked.body.plan.blocking).toEqual([]);
    expect(checked.body.plan.counts['drill-library']).toEqual({ new: 119, new_version: 0, unchanged: 0, absent: 0, reject: 0 });

    const applyStarted = Date.now();
    const applied = await post(principal(gym.admin, 'gym_drills'), { files, commit: true, plan_hash: checked.body.plan.plan_hash });
    const applyMs = Date.now() - applyStarted;

    expect(applied.status).toBe(200);
    expect(applied.body.committed).toBe(true);
    expect((await committedCounts('gym_drills')).drills).toBe(119);
    // The measurement the NOT SURE asks for, printed so a run records it.
    console.info(`content-import upload measurement: drill files ${drillBytes} bytes, request body ${bodyBytes} bytes, check ${checkMs} ms, apply ${applyMs} ms`);
  });
});
