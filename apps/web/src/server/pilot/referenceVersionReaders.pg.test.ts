// Real PostgreSQL-backed suite for the three readers that must follow reference-content versions
// once revisions exist (content-intake plan IMP-05). A revision is a NEW ROW in the same lineage
// with a higher version -- the old row is kept as history (R2) -- so every reader that used to
// assume one row per script or per drill now has to say which row is current.
//
// What needs proving, none of which a mocked-query unit test can establish because each answer is
// a correlated subquery or a lateral join the database evaluates:
//
// 1. listSessionScripts returns ONE row per lineage, the head -- not v1 and v2 side by side.
// 2. startSessionScriptRun refuses a superseded version by name, and a run already live on the
//    older version keeps its pinned script through cursor, pause, resume and finish.
// 3. getWorkoutTemplateWithItems reports, per item, the head of the item's drill lineage and
//    whether the item is behind it -- without repointing the item.
// 4. All three stay inside one organization: another gym's higher version in a lineage with the
//    same id must neither hide this gym's head nor supersede its script or drill.
// 5. listSettledRunsForScript returns the whole lineage's deliveries. The list in (1) shows only
//    the head, and the page reads history only for a plan opened from that list, so a by-id read
//    would leave v1's nights on no screen at all once v2 loaded.
//
// FIXTURES USE A RENAMED v2 for drills. pilot_drill_library_one_active_name is unique on
// (organization_id, discipline, name) where active, and superseded is not withdrawn (active and
// superseded_at are separate axes, drillAdoptionReadiness.ts:51-52), so v1 and v2 are both active
// and a same-name v2 would collide with v1 until the content-import migration changes that index.
// The readers under test do not care about names, so renaming keeps this suite independent of it.
//
// Spins up the same disposable, local-only embedded Postgres the other migration suites use. It
// NEVER connects to production or staging.
import { type ChildProcessByStdio, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import type { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';

import { Client } from 'pg';

import {
  SessionScriptRunError,
  finishSessionScriptRun,
  getLiveRunForCoach,
  listSettledRunsForScript,
  moveSessionScriptRunCursor,
  pauseSessionScriptRun,
  resumeSessionScriptRun,
  startSessionScriptRun,
} from './sessionScriptRuns';
import { getSessionScriptLineage, getSessionScriptWithDetail, listSessionScripts } from './sessionScripts';
import { getWorkoutTemplateWithItems } from './workoutTemplates';

jest.setTimeout(180_000);

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
  // startSessionScriptRun runs in a transaction; the embedded client IS the connection here, the
  // same hand-through sessionScriptRuns.pg.test.ts uses.
  withTransaction: jest.fn(async (fn: (c: Client) => Promise<unknown>) => {
    if (!activeClient) throw new Error('test bug: no active embedded client');
    return fn(activeClient);
  }),
}));

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-reference-version-readers-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const SCRIPTS_DIR = path.resolve(__dirname, '../../../scripts');

// Each migration goes through its own runner, so a runner whose readiness gate disagrees with its
// migration fails this suite in beforeAll rather than passing on a schema nobody deploys. Order is
// the dependency order: scripts and templates both carry FKs into pilot.drill_library, and the
// run-state migration alters the runs table the scripts migration creates.
const MIGRATIONS: ReadonlyArray<{ file: string; runner: string }> = [
  {
    file: 'pilot_slice_postgres_drill_library_v3_migration.sql',
    runner: 'pilot-apply-drill-library-v3-migration.mjs',
  },
  {
    file: 'pilot_slice_postgres_session_scripts_migration.sql',
    runner: 'pilot-apply-session-scripts-migration.mjs',
  },
  {
    file: 'pilot_slice_postgres_session_run_state_migration.sql',
    runner: 'pilot-apply-session-run-state-migration.mjs',
  },
  {
    file: 'pilot_slice_postgres_workout_templates_v2_migration.sql',
    runner: 'pilot-apply-workout-templates-v2-migration.mjs',
  },
];

const ORG_A = 'org-refver-a';
const ORG_B = 'org-refver-b';
const COACH_A = 'acct-refver-coach-a';
const COACH_B = 'acct-refver-coach-b';

const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let client: Client;

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
      if (address === null || typeof address === 'string') {
        reject(new Error('Could not determine a free port'));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
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
  await admin.query('drop database if exists ppbf_test_reference_version_readers');
  await admin.query('create database ppbf_test_reference_version_readers');
  await admin.end();

  client = new Client({ connectionString: connectionStringFor('ppbf_test_reference_version_readers') });
  await client.connect();
  await client.query(await fs.readFile(path.join(INFRA_DIR, 'pilot_slice_postgres.sql'), 'utf8'));
  for (const { file, runner } of MIGRATIONS) {
    const sql = await fs.readFile(path.join(INFRA_DIR, file), 'utf8');
    const runnerModule = await nativeDynamicImport(pathToFileURL(path.join(SCRIPTS_DIR, runner)).href);
    const apply = runnerModule.applyMigrationTransaction as (c: Client, s: string) => Promise<void>;
    await apply(client, sql);
  }

  for (const [org, coach] of [[ORG_A, COACH_A], [ORG_B, COACH_B]]) {
    await client.query(
      `insert into pilot.organizations (organization_id, organization_name, status)
       values ($1,$1,'active') on conflict do nothing`,
      [org],
    );
    await client.query(
      `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
       values ($1,'coach',$2,'microsoft') on conflict do nothing`,
      [coach, org],
    );
  }

  activeClient = client;
});

afterAll(async () => {
  activeClient = null;
  if (client) await client.end();

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
  // On Windows kill() ends the server script outright, so Postgres can still hold files here for a
  // moment; the first local run failed its afterAll with EBUSY on exactly this line. Retrying is the
  // pattern drillLifecycle.pg.test.ts:436-440 settled on, and a leak is swept at the next start.
  await fs.rm(DATA_DIR, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }).catch(() => {});
});

beforeEach(async () => {
  // Children before parents: runs point at blocks, blocks and template items point at drills.
  await client.query('delete from pilot.session_script_runs');
  await client.query('delete from pilot.session_script_blocks');
  await client.query('delete from pilot.session_script_renderings');
  await client.query('delete from pilot.session_scripts');
  await client.query('delete from pilot.workout_template_items');
  await client.query('delete from pilot.workout_templates');
  await client.query('delete from pilot.drill_library');
});

// ---------------------------------------------------------------------------
// Fixtures. Blocks carry what_to_say so they satisfy pilot_ssb_content.

async function seedScript(opts: {
  org?: string;
  coach?: string;
  scriptId: string;
  lineageId: string;
  version: number;
  name?: string;
  phase?: string | null;
  authoringState?: string;
  blockIds?: string[];
}): Promise<void> {
  const org = opts.org ?? ORG_A;
  await client.query(
    `insert into pilot.session_scripts
       (organization_id, script_id, lineage_id, version, name, phase, authoring_state,
        created_by_account_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      org,
      opts.scriptId,
      opts.lineageId,
      opts.version,
      opts.name ?? 'Tuesday technical',
      opts.phase ?? null,
      opts.authoringState ?? 'in_use',
      opts.coach ?? COACH_A,
    ],
  );
  const blockIds = opts.blockIds ?? [];
  for (let i = 0; i < blockIds.length; i += 1) {
    await client.query(
      `insert into pilot.session_script_blocks
         (organization_id, block_id, script_id, block_order,
          start_offset_min, end_offset_min, block_label, what_to_say)
       values ($1,$2,$3,$4,$5,$6,$7,'cue')`,
      [org, blockIds[i], opts.scriptId, i + 1, i * 10, (i + 1) * 10, `block ${i + 1}`],
    );
  }
}

async function seedDrill(opts: {
  org?: string;
  drillId: string;
  lineageId: string;
  version: number;
  name: string;
  supersedesDrillId?: string | null;
  supersededAt?: string | null;
}): Promise<void> {
  await client.query(
    `insert into pilot.drill_library
       (organization_id, drill_id, lineage_id, version, supersedes_drill_id, superseded_at,
        name, discipline, category, difficulty, target_behavior,
        purpose, standard_setup, execution, what_good_looks_like, what_bad_looks_like)
     values ($1,$2,$3,$4,$5,$6,$7,'boxing','technical','beginner','x','x','x','x','x','x')`,
    [
      opts.org ?? ORG_A,
      opts.drillId,
      opts.lineageId,
      opts.version,
      opts.supersedesDrillId ?? null,
      opts.supersededAt ?? null,
      opts.name,
    ],
  );
}

async function seedTemplate(org: string, templateId: string): Promise<void> {
  await client.query(
    `insert into pilot.workout_templates
       (organization_id, template_id, lineage_id, name, session_type, duration_minutes, intent)
     values ($1,$2,$2,$3,'technical',45,'Test intent')`,
    [org, templateId, `Template ${templateId}`],
  );
}

async function seedItem(
  org: string,
  templateId: string,
  itemId: string,
  ordinal: number,
  source: { drillId: string } | { freeText: string },
): Promise<void> {
  await client.query(
    `insert into pilot.workout_template_items
       (organization_id, item_id, template_id, ordinal, block, drill_id, free_text_drill)
     values ($1,$2,$3,$4,'technical',$5,$6)`,
    [
      org,
      itemId,
      templateId,
      ordinal,
      'drillId' in source ? source.drillId : null,
      'freeText' in source ? source.freeText : null,
    ],
  );
}

async function runCount(): Promise<number> {
  const result = await client.query('select count(*)::int as n from pilot.session_script_runs');
  return result.rows[0].n as number;
}

// ---------------------------------------------------------------------------

describe('listSessionScripts follows versions', () => {
  test('listSessionScripts returns one row per lineage when v1 and v2 exist', async () => {
    await seedScript({ scriptId: 'scr-tue-v1', lineageId: 'lin-tue', version: 1 });
    await seedScript({ scriptId: 'scr-tue-v2', lineageId: 'lin-tue', version: 2 });
    await seedScript({ scriptId: 'scr-fri', lineageId: 'lin-fri', version: 1, name: 'Friday sparring' });

    const listed = await listSessionScripts(ORG_A);

    // One row per lineage, and for the revised one it is v2 -- v1 is not beside it.
    expect(listed.map((s) => [s.lineage_id, s.script_id, s.version]).sort()).toEqual([
      ['lin-fri', 'scr-fri', 1],
      ['lin-tue', 'scr-tue-v2', 2],
    ]);

    // Hidden from the list is not deleted: the lineage read still has both, and v1 still opens
    // by id, which a run pinned to it needs.
    expect((await getSessionScriptLineage(ORG_A, 'lin-tue')).map((s) => s.version)).toEqual([1, 2]);
    expect((await getSessionScriptWithDetail(ORG_A, 'scr-tue-v1'))?.version).toBe(1);
  });

  test('the head is chosen before the filters, so a superseded v1 never resurfaces', async () => {
    // v2 moved the session to another phase. Filtering first and then picking a head would hand
    // back v1 for the old phase -- the replaced plan.
    await seedScript({ scriptId: 'scr-v1', lineageId: 'lin-1', version: 1, phase: 'accumulation' });
    await seedScript({ scriptId: 'scr-v2', lineageId: 'lin-1', version: 2, phase: 'taper' });

    expect(await listSessionScripts(ORG_A, { phase: 'accumulation' })).toEqual([]);
    expect((await listSessionScripts(ORG_A, { phase: 'taper' })).map((s) => s.script_id)).toEqual(['scr-v2']);

    // Retiring the head retires the script from the default list; it does not bring v1 back.
    await client.query(
      `update pilot.session_scripts set authoring_state = 'retired' where script_id = 'scr-v2'`,
    );
    expect(await listSessionScripts(ORG_A)).toEqual([]);
    expect((await listSessionScripts(ORG_A, { includeRetired: true })).map((s) => s.script_id)).toEqual([
      'scr-v2',
    ]);
  });

  test('another organization\'s higher version in a same-id lineage does not hide this gym\'s head', async () => {
    await seedScript({ scriptId: 'scr-a', lineageId: 'lin-shared', version: 1 });
    await seedScript({
      org: ORG_B,
      coach: COACH_B,
      scriptId: 'scr-b',
      lineageId: 'lin-shared',
      version: 5,
    });

    expect((await listSessionScripts(ORG_A)).map((s) => s.script_id)).toEqual(['scr-a']);
    expect((await listSessionScripts(ORG_B)).map((s) => s.script_id)).toEqual(['scr-b']);
  });
});

describe('startSessionScriptRun follows versions', () => {
  test('starting a run on a superseded script version is refused', async () => {
    await seedScript({ scriptId: 'scr-v1', lineageId: 'lin-1', version: 1, blockIds: ['blk-v1-1'] });
    await seedScript({ scriptId: 'scr-v2', lineageId: 'lin-1', version: 2, blockIds: ['blk-v2-1'] });

    const refusal = await startSessionScriptRun(ORG_A, COACH_A, { scriptId: 'scr-v1' }).catch(
      (error: unknown) => error,
    );
    expect(refusal).toBeInstanceOf(SessionScriptRunError);
    expect((refusal as SessionScriptRunError).message).toBe('SESSION_SCRIPT_SUPERSEDED');
    expect((refusal as SessionScriptRunError).status).toBe(409);
    // Refused before anything was written, so it cannot hold the coach's one live slot.
    expect(await runCount()).toBe(0);

    // The head starts normally and pins its own version.
    const live = await startSessionScriptRun(ORG_A, COACH_A, { scriptId: 'scr-v2' });
    expect(live.script_id).toBe('scr-v2');
    expect(live.script_version).toBe(2);
  });

  test('a run already live on v1 keeps its pinned version after v2 lands', async () => {
    await seedScript({
      scriptId: 'scr-v1',
      lineageId: 'lin-1',
      version: 1,
      blockIds: ['blk-v1-1', 'blk-v1-2'],
    });
    const live = await startSessionScriptRun(ORG_A, COACH_A, { scriptId: 'scr-v1' });

    // The revision loads mid-session.
    await seedScript({ scriptId: 'scr-v2', lineageId: 'lin-1', version: 2, blockIds: ['blk-v2-1'] });

    // Every live-run action still works on the plan the coach started, and none of them moves the
    // run onto v2.
    const moved = await moveSessionScriptRunCursor(ORG_A, COACH_A, live.run_id, 'blk-v1-2');
    expect(moved.current_block_id).toBe('blk-v1-2');
    await pauseSessionScriptRun(ORG_A, COACH_A, live.run_id);
    await resumeSessionScriptRun(ORG_A, COACH_A, live.run_id);
    expect((await getLiveRunForCoach(ORG_A, COACH_A))?.script_id).toBe('scr-v1');

    const settled = await finishSessionScriptRun(ORG_A, COACH_A, live.run_id, { runState: 'completed' });
    expect(settled.run_state).toBe('completed');
    expect([settled.script_id, settled.script_version]).toEqual(['scr-v1', 1]);
  });

  test('another organization\'s higher version in a same-id lineage does not supersede this gym\'s script', async () => {
    await seedScript({ scriptId: 'scr-a', lineageId: 'lin-shared', version: 1, blockIds: ['blk-a-1'] });
    await seedScript({
      org: ORG_B,
      coach: COACH_B,
      scriptId: 'scr-b',
      lineageId: 'lin-shared',
      version: 2,
      blockIds: ['blk-b-1'],
    });

    const live = await startSessionScriptRun(ORG_A, COACH_A, { scriptId: 'scr-a' });
    expect(live.script_id).toBe('scr-a');
  });
});

describe('listSettledRunsForScript follows versions', () => {
  test('the history read for v2 includes the nights delivered from v1', async () => {
    await seedScript({ scriptId: 'scr-tue-v1', lineageId: 'lin-tue', version: 1, blockIds: ['blk-v1-1'] });
    const onV1 = await startSessionScriptRun(ORG_A, COACH_A, { scriptId: 'scr-tue-v1' });
    await finishSessionScriptRun(ORG_A, COACH_A, onV1.run_id, { runState: 'completed' });

    await seedScript({ scriptId: 'scr-tue-v2', lineageId: 'lin-tue', version: 2, blockIds: ['blk-v2-1'] });
    const onV2 = await startSessionScriptRun(ORG_A, COACH_A, { scriptId: 'scr-tue-v2' });
    await finishSessionScriptRun(ORG_A, COACH_A, onV2.run_id, { runState: 'abandoned' });

    // Another lineage of this gym, delivered too. It shares a script_id with a row of the OTHER
    // gym's 'lin-tue' below, so a lineage join that dropped the organization would pull it in.
    await seedScript({
      scriptId: 'scr-fri',
      lineageId: 'lin-fri',
      version: 1,
      name: 'Friday sparring',
      blockIds: ['blk-fri-1'],
    });
    const onFri = await startSessionScriptRun(ORG_A, COACH_A, { scriptId: 'scr-fri' });
    await finishSessionScriptRun(ORG_A, COACH_A, onFri.run_id, { runState: 'completed' });
    await seedScript({ org: ORG_B, coach: COACH_B, scriptId: 'scr-fri', lineageId: 'lin-tue', version: 3 });

    // Only the head is listed, so v2 is the plan a coach can open -- and its history must carry v1.
    expect((await listSessionScripts(ORG_A)).map((s) => s.script_id).sort()).toEqual(['scr-fri', 'scr-tue-v2']);
    const history = await listSettledRunsForScript(ORG_A, 'scr-tue-v2');
    expect(history.map((r) => [r.run_id, r.script_id, r.script_version]).sort()).toEqual(
      [
        [onV1.run_id, 'scr-tue-v1', 1],
        [onV2.run_id, 'scr-tue-v2', 2],
      ].sort(),
    );

    // Same lineage, same answer from either version's id.
    expect((await listSettledRunsForScript(ORG_A, 'scr-tue-v1')).map((r) => r.run_id).sort()).toEqual(
      [onV1.run_id, onV2.run_id].sort(),
    );
    // The other lineage keeps its own history only.
    expect((await listSettledRunsForScript(ORG_A, 'scr-fri')).map((r) => r.run_id)).toEqual([onFri.run_id]);
  });
});

describe('getWorkoutTemplateWithItems follows drill versions', () => {
  test('a template item pinned to drill v1 reports the head v2 and uses_older_drill_version', async () => {
    // v2 is RENAMED so both rows can stay active under today's one-active-name index.
    await seedDrill({
      drillId: 'drl-jab-v1',
      lineageId: 'drl-jab',
      version: 1,
      name: 'Jab Drill',
      supersededAt: '2026-09-01T00:00:00Z',
    });
    await seedDrill({
      drillId: 'drl-jab-v2',
      lineageId: 'drl-jab',
      version: 2,
      name: 'Jab Drill (revised)',
      supersedesDrillId: 'drl-jab-v1',
    });
    await seedDrill({ drillId: 'drl-solo', lineageId: 'drl-solo', version: 1, name: 'Footwork Box' });

    await seedTemplate(ORG_A, 'tpl-1');
    await seedItem(ORG_A, 'tpl-1', 'item-old', 1, { drillId: 'drl-jab-v1' });
    await seedItem(ORG_A, 'tpl-1', 'item-head', 2, { drillId: 'drl-jab-v2' });
    await seedItem(ORG_A, 'tpl-1', 'item-solo', 3, { drillId: 'drl-solo' });
    await seedItem(ORG_A, 'tpl-1', 'item-free', 4, { freeText: 'Rope intervals' });

    const detail = await getWorkoutTemplateWithItems(ORG_A, 'tpl-1');

    expect(
      detail?.items.map((i) => [i.item_id, i.drill_id, i.head_drill_id, i.uses_older_drill_version]),
    ).toEqual([
      // Reported, not repointed: drill_id is still the version the template was written against.
      ['item-old', 'drl-jab-v1', 'drl-jab-v2', true],
      ['item-head', 'drl-jab-v2', 'drl-jab-v2', false],
      ['item-solo', 'drl-solo', 'drl-solo', false],
      // A free-text item has no lineage, so no head and nothing to be behind.
      ['item-free', null, null, false],
    ]);
    // Strictly boolean, so a client reading it never has to treat null as "false".
    expect(detail?.items.every((i) => typeof i.uses_older_drill_version === 'boolean')).toBe(true);
  });

  test('the head comes from the versions, not from superseded_at', async () => {
    // A revision loaded without marking v1 (superseded_at left null) is still a revision.
    await seedDrill({ drillId: 'drl-hook-v1', lineageId: 'drl-hook', version: 1, name: 'Hook Drill' });
    await seedDrill({ drillId: 'drl-hook-v2', lineageId: 'drl-hook', version: 2, name: 'Hook Drill (revised)' });
    await seedTemplate(ORG_A, 'tpl-2');
    await seedItem(ORG_A, 'tpl-2', 'item-1', 1, { drillId: 'drl-hook-v1' });

    const [item] = (await getWorkoutTemplateWithItems(ORG_A, 'tpl-2'))?.items ?? [];
    expect([item?.head_drill_id, item?.uses_older_drill_version]).toEqual(['drl-hook-v2', true]);
  });

  test('another organization\'s newer version in a same-id lineage is never reported as the head', async () => {
    await seedDrill({ drillId: 'drl-a-v1', lineageId: 'drl-shared', version: 1, name: 'Cross Drill' });
    await seedDrill({
      org: ORG_B,
      drillId: 'drl-b-v2',
      lineageId: 'drl-shared',
      version: 2,
      name: 'Cross Drill (their revision)',
    });
    await seedTemplate(ORG_A, 'tpl-3');
    await seedItem(ORG_A, 'tpl-3', 'item-1', 1, { drillId: 'drl-a-v1' });

    const [item] = (await getWorkoutTemplateWithItems(ORG_A, 'tpl-3'))?.items ?? [];
    expect([item?.head_drill_id, item?.uses_older_drill_version]).toEqual(['drl-a-v1', false]);
  });
});
