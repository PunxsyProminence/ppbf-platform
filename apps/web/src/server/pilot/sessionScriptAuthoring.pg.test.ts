// Real PostgreSQL-backed suite for sessionScriptAuthoring.ts: a coach makes a
// session script from a workout template and edits it.
//
// What needs a real database to prove:
//
// 1. A template's steps become blocks in the template's order with minutes
//    running on from the start, and the result satisfies every constraint the
//    session-scripts migration puts on a script and a block (pilot_ssb_content,
//    pilot_ssb_window, the total_minutes range, the discipline key).
// 2. The script it writes is one the existing run module starts and delivers
//    block by block, and a plain session still starts beside it.
// 3. VERSIONING. A script with no run is updated where it is. A script with a
//    run -- settled or still live -- is left byte for byte as it was, and the
//    edit lands as version + 1 in the same lineage; the run keeps reading the
//    version it pinned.
// 4. Organization scope: another gym's template and another gym's script are
//    refused and nothing is written.
//
// Spins up the same disposable, local-only embedded Postgres the other suites
// use. It NEVER connects to production or staging.

import { type ChildProcessByStdio, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import type { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';

import { Client } from 'pg';

/* ts-jest compiles a plain `await import()` down to require(), which cannot
   load an ES module here. Building it through Function keeps a real dynamic
   import in the emitted code, honored under --experimental-vm-modules. */
const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

const FULL_SCHEMA_HELPER_PATH = path.resolve(__dirname, '../../../scripts/lib/full-schema.mjs');

let activeClient: Client | null = null;
let activeConnectionString: string | null = null;

jest.mock('./db', () => ({
  withTransaction: jest.fn(async (fn: (client: unknown) => Promise<unknown>) => {
    if (!activeConnectionString) throw new Error('test bug: no active embedded database');
    const own = new Client({ connectionString: activeConnectionString });
    await own.connect();
    try {
      await own.query('BEGIN');
      try {
        const result = await fn({ query: (text: string, values: unknown[]) => own.query(text, values) });
        await own.query('COMMIT');
        return result;
      } catch (error) {
        await own.query('ROLLBACK').catch(() => {});
        throw error;
      }
    } finally {
      await own.end();
    }
  }),
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

import { query } from './db';
import {
  DEFAULT_STEP_MINUTES,
  SessionScriptAuthoringError,
  createSessionScriptFromTemplate,
  editSessionScript,
} from './sessionScriptAuthoring';
import {
  finishSessionScriptRun,
  listSettledRunsForScript,
  moveSessionScriptRunCursor,
  startSessionScriptRun,
} from './sessionScriptRuns';
import { getSessionScriptLineage, getSessionScriptWithDetail, listSessionScripts } from './sessionScripts';

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-session-script-authoring-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const DATABASE_NAME = 'ppbf_test_l1_session_script_authoring';

const TEMPLATE_ID = 'wtp_l1';

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let applyFullSchema: (client: Client, opts?: { infraDir?: string }) => Promise<unknown>;
let client: Client;
let gymCount = 0;

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

interface Gym {
  organizationId: string;
  coachId: string;
  otherCoachId: string;
}

/** A fresh gym: an organization, its boxing discipline and two coaches. Ids repeat across gyms on purpose. */
async function newGym(label: string): Promise<Gym> {
  gymCount += 1;
  const organizationId = `org-l1-${label}-${gymCount}`;
  const coachId = `coach@${organizationId}`;
  const otherCoachId = `coach2@${organizationId}`;
  await client.query(
    `insert into pilot.organizations (organization_id, organization_name, status) values ($1, $1, 'active')`,
    [organizationId],
  );
  await client.query(
    `insert into pilot.disciplines (organization_id, discipline, display_name, lane, exposure_model)
     values ($1, 'boxing', 'Boxing', 'striking', 'head_impact')`,
    [organizationId],
  );
  for (const accountId of [coachId, otherCoachId]) {
    await client.query(`insert into pilot.accounts (account_id, role, organization_id) values ($1, 'coach', $2)`, [
      accountId,
      organizationId,
    ]);
  }
  return { organizationId, coachId, otherCoachId };
}

async function insertReference(gym: Gym, drillId: string, name: string): Promise<void> {
  await client.query(
    `insert into pilot.drill_library
       (organization_id, drill_id, lineage_id, version, name, discipline, category, difficulty,
        target_behavior, purpose, standard_setup, execution, what_good_looks_like, what_bad_looks_like,
        field_provenance, active)
     values ($1,$2,$2,1,$3,'boxing','footwork','advanced', 'target', 'purpose', 'setup', 'execution',
             'good', 'bad', 'PPBF source manual v3', true)`,
    [gym.organizationId, drillId, name],
  );
}

/**
 * The fixture template, three steps, inserted OUT of order so only `ordinal`
 * can put them right:
 *   1  'warm-up'    drill ref-jab, scale A, 6 minutes, a coach note
 *   2  'technical'  typed step 'Partner mirror', 10 reps, no minutes
 *   3  ''           drill ref-spar, controlled sparring (so no minutes or reps), no note
 */
async function insertTemplate(gym: Gym, opts: { steps?: boolean } = {}): Promise<void> {
  await client.query(
    `insert into pilot.workout_templates
       (organization_id, template_id, lineage_id, version, name, session_type, difficulty, age_band, active,
        duration_minutes, intent)
     values ($1,$2,$2,3,'Fixture Workout','technical','intermediate','any',true,45,'Coach-typed intent')`,
    [gym.organizationId, TEMPLATE_ID],
  );
  if (opts.steps === false) return;
  await insertReference(gym, 'ref-jab', 'Jab Drill');
  await insertReference(gym, 'ref-spar', 'Sparring Round');
  await client.query(
    `insert into pilot.workout_template_items
       (organization_id, item_id, template_id, ordinal, block, drill_id, free_text_drill, scale_level,
        duration_minutes, rep_count, contact_level, coach_note)
     values ($1, 'wti_3', $2, 3, '',          'ref-spar', null,             null, null, null, 'controlled_sparring', null),
            ($1, 'wti_1', $2, 1, 'warm-up',   'ref-jab',  null,             'A',  6,    null, 'none',                '  Hands up.  '),
            ($1, 'wti_2', $2, 2, 'technical', null,       'Partner mirror', null, null, 10,   'none',                null)`,
    [gym.organizationId, TEMPLATE_ID],
  );
}

function create(gym: Gym, name?: string) {
  return createSessionScriptFromTemplate({
    organizationId: gym.organizationId,
    actorAccountId: gym.coachId,
    actorRole: 'coach',
    templateId: TEMPLATE_ID,
    name,
  });
}

type EditChange = Pick<Parameters<typeof editSessionScript>[0], 'name' | 'blocks'>;

/** Edits are made by the gym's OTHER coach: any coach of the gym may edit, not only the author. */
function edit(gym: Gym, scriptId: string, change: EditChange) {
  return editSessionScript({
    organizationId: gym.organizationId,
    actorAccountId: gym.otherCoachId,
    actorRole: 'coach',
    scriptId,
    ...change,
  });
}

/** Every stored column of a script and of its blocks, as text: what "unchanged" is compared on. */
async function storedBytes(gym: Gym, scriptId: string): Promise<string> {
  const script = await client.query(
    `select to_jsonb(s)::text as row from pilot.session_scripts s where organization_id = $1 and script_id = $2`,
    [gym.organizationId, scriptId],
  );
  const blocks = await client.query(
    `select to_jsonb(b)::text as row from pilot.session_script_blocks b
      where organization_id = $1 and script_id = $2 order by block_order`,
    [gym.organizationId, scriptId],
  );
  return [...script.rows, ...blocks.rows].map((row) => row.row).join('\n');
}

async function counts(gym: Gym): Promise<{ scripts: number; blocks: number; audit: number }> {
  const { rows } = await client.query(
    `select (select count(*)::int from pilot.session_scripts where organization_id = $1) as scripts,
            (select count(*)::int from pilot.session_script_blocks where organization_id = $1) as blocks,
            (select count(*)::int from pilot.audit_events
              where organization_id = $1 and entity_type = 'session_script') as audit`,
    [gym.organizationId],
  );
  return rows[0];
}

async function expectRefused(action: Promise<unknown>, code: string, status: number): Promise<void> {
  const error = await action.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(SessionScriptAuthoringError);
  expect((error as SessionScriptAuthoringError).message).toBe(code);
  expect((error as SessionScriptAuthoringError).status).toBe(status);
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

  const helper = await nativeDynamicImport(pathToFileURL(FULL_SCHEMA_HELPER_PATH).href);
  applyFullSchema = helper.applyFullSchema as typeof applyFullSchema;

  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  await admin.query(`drop database if exists ${DATABASE_NAME}`);
  await admin.query(`create database ${DATABASE_NAME}`);
  await admin.end();

  client = new Client({ connectionString: connectionStringFor(DATABASE_NAME) });
  await client.connect();
  // The whole schema production runs (scripts/lib/full-schema.mjs): authoring
  // crosses the template, drill library, session script, run and audit migrations.
  await applyFullSchema(client, { infraDir: INFRA_DIR });
  activeClient = client;
  activeConnectionString = connectionStringFor(DATABASE_NAME);
});

afterAll(async () => {
  activeClient = null;
  activeConnectionString = null;
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
  // On Windows kill() terminates the server script outright, so its own
  // cleanup never runs and Postgres may still hold files here for a moment.
  await fs.rm(DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 }).catch(() => {});
});

describe('making a session script from a workout template', () => {
  test('a gym with no scripts gets one: blocks in the template order, minutes running on from the start', async () => {
    const gym = await newGym('create');
    await insertTemplate(gym);
    expect(await listSessionScripts(gym.organizationId)).toEqual([]);

    const created = await create(gym);

    expect(created).toMatchObject({ lineage_id: created.script_id, version: 1, name: 'Fixture Workout', block_count: 3 });
    const listed = await listSessionScripts(gym.organizationId);
    expect(listed.map((script) => script.script_id)).toEqual([created.script_id]);
    expect(listed[0]).toMatchObject({
      name: 'Fixture Workout',
      discipline: 'boxing',
      // Sent to families; the template's intent is not, so it is not copied here.
      theme: '',
      total_minutes: 6 + DEFAULT_STEP_MINUTES + DEFAULT_STEP_MINUTES,
      contact_structure: 'split_non_contact_then_contact',
      authoring_state: 'coach_reviewed',
      source_document: 'Workout template: Fixture Workout v3',
      created_by_account_id: gym.coachId,
    });

    const detail = await getSessionScriptWithDetail(gym.organizationId, created.script_id);
    expect(detail?.blocks.map((block) => ({
      order: block.block_order,
      window: [block.start_offset_min, block.end_offset_min],
      label: block.block_label,
      kind: block.block_kind,
      drill: block.drill_id,
      scale: block.scale_level,
      contact: block.contact_level,
      say: block.what_to_say,
      explain: block.what_to_explain,
    }))).toEqual([
      { order: 1, window: [0, 6], label: 'Jab Drill', kind: 'drill_round', drill: 'ref-jab', scale: 'A', contact: 'none', say: 'Hands up.', explain: 'warm-up' },
      { order: 2, window: [6, 11], label: 'Partner mirror', kind: 'instruction', drill: null, scale: null, contact: 'none', say: null, explain: 'technical - 10 reps' },
      { order: 3, window: [11, 16], label: 'Sparring Round', kind: 'drill_round', drill: 'ref-spar', scale: null, contact: 'controlled_sparring', say: null, explain: 'From workout template: Fixture Workout' },
    ]);

    const audit = await query<{ event_type: string; actor_account_id: string; entity_id: string; details: Record<string, unknown> }>(
      `select event_type, actor_account_id, entity_id, details from pilot.audit_events
        where organization_id = $1 and entity_type = 'session_script'`,
      [gym.organizationId],
    );
    expect(audit).toEqual([
      {
        event_type: 'create',
        actor_account_id: gym.coachId,
        entity_id: created.script_id,
        details: { name: 'Fixture Workout', version: 1, block_count: 3, template_id: TEMPLATE_ID, template_version: 3 },
      },
    ]);
  });

  test('the coach may name it; a blank name is refused and nothing is written', async () => {
    const gym = await newGym('name');
    await insertTemplate(gym);

    await expectRefused(create(gym, '   '), 'SESSION_SCRIPT_NAME_INVALID', 422);
    expect(await counts(gym)).toEqual({ scripts: 0, blocks: 0, audit: 0 });

    const created = await create(gym, '  Tuesday juniors  ');
    expect(created.name).toBe('Tuesday juniors');
  });

  test("another gym's template is not found, and a template with no steps is refused; neither writes", async () => {
    const owner = await newGym('owner');
    const other = await newGym('other');
    await insertTemplate(owner);
    await expectRefused(create(other), 'WORKOUT_TEMPLATE_NOT_FOUND', 404);
    expect(await counts(other)).toEqual({ scripts: 0, blocks: 0, audit: 0 });
    expect(await counts(owner)).toEqual({ scripts: 0, blocks: 0, audit: 0 });

    const empty = await newGym('empty');
    await insertTemplate(empty, { steps: false });
    await expectRefused(create(empty), 'WORKOUT_TEMPLATE_HAS_NO_STEPS', 422);
    expect(await counts(empty)).toEqual({ scripts: 0, blocks: 0, audit: 0 });
  });

  test('the script is delivered block by block by the existing run module, and a plain session still starts', async () => {
    const gym = await newGym('deliver');
    await insertTemplate(gym);
    const created = await create(gym);
    const detail = await getSessionScriptWithDetail(gym.organizationId, created.script_id);
    const blockIds = detail!.blocks.map((block) => block.block_id);

    const run = await startSessionScriptRun(gym.organizationId, gym.coachId, { scriptId: created.script_id });
    expect(run).toMatchObject({ script_id: created.script_id, script_version: 1, current_block_id: blockIds[0] });
    for (const blockId of blockIds.slice(1)) {
      const moved = await moveSessionScriptRunCursor(gym.organizationId, gym.coachId, run.run_id, blockId);
      expect(moved.current_block_id).toBe(blockId);
    }
    const settled = await finishSessionScriptRun(gym.organizationId, gym.coachId, run.run_id, {
      runState: 'completed',
      blocksCompleted: blockIds.length,
    });
    expect(settled).toMatchObject({ run_state: 'completed', blocks_completed: 3 });

    const plain = await startSessionScriptRun(gym.organizationId, gym.coachId, {});
    expect(plain).toMatchObject({ script_id: null, script_version: null, current_block_id: null, run_state: 'in_progress' });
  });
});

describe('editing a session script', () => {
  test('a script nobody has run is updated where it is: same row, same version, same block ids', async () => {
    const gym = await newGym('inplace');
    await insertTemplate(gym);
    const created = await create(gym);
    const before = await getSessionScriptWithDetail(gym.organizationId, created.script_id);
    const [first, second, third] = before!.blocks;

    const result = await edit(gym, created.script_id, {
      name: 'Renamed plan',
      blocks: [
        { block_id: first.block_id, block_label: 'Jab warm-up', start_offset_min: 0, end_offset_min: 10 },
        { block_id: third.block_id, block_label: third.block_label, start_offset_min: 15, end_offset_min: 40 },
      ],
    });

    expect(result).toEqual({ outcome: 'updated', script_id: created.script_id, version: 1 });
    expect((await getSessionScriptLineage(gym.organizationId, created.script_id)).map((row) => row.version)).toEqual([1]);
    const after = await getSessionScriptWithDetail(gym.organizationId, created.script_id);
    expect(after).toMatchObject({ name: 'Renamed plan', version: 1, total_minutes: 40, created_by_account_id: gym.coachId });
    expect(after!.blocks.map((block) => [block.block_id, block.block_label, block.start_offset_min, block.end_offset_min])).toEqual([
      [first.block_id, 'Jab warm-up', 0, 10],
      // Not named in the edit: kept exactly.
      [second.block_id, 'Partner mirror', 6, 11],
      [third.block_id, 'Sparring Round', 15, 40],
    ]);
    // Everything the edit does not own is as it was.
    const untouched = ({ block_id, block_order, what_to_say, what_to_explain, block_kind, drill_id, scale_level, contact_level }: (typeof first)) =>
      ({ block_id, block_order, what_to_say, what_to_explain, block_kind, drill_id, scale_level, contact_level });
    expect(after!.blocks.map(untouched)).toEqual(before!.blocks.map(untouched));
    expect(await counts(gym)).toEqual({ scripts: 1, blocks: 3, audit: 2 });
  });

  test('a script that has been delivered is left as it was: the edit is version 2, and the run keeps version 1', async () => {
    const gym = await newGym('version');
    await insertTemplate(gym);
    const created = await create(gym);
    await client.query(
      `insert into pilot.session_script_renderings (organization_id, rendering_id, script_id, format, audience_note, body)
       values ($1, 'rnd_v1', $2, 'cheat_sheet', 'for the coach', 'the sheet')`,
      [gym.organizationId, created.script_id],
    );
    const v1 = await getSessionScriptWithDetail(gym.organizationId, created.script_id);
    const run = await startSessionScriptRun(gym.organizationId, gym.coachId, { scriptId: created.script_id });
    await finishSessionScriptRun(gym.organizationId, gym.coachId, run.run_id, { runState: 'completed' });
    const v1Bytes = await storedBytes(gym, created.script_id);

    const result = await edit(gym, created.script_id, {
      name: 'Fixture Workout, longer',
      blocks: [{ block_id: v1!.blocks[0].block_id, block_label: 'Long jab round', start_offset_min: 0, end_offset_min: 12 }],
    });

    expect(result.outcome).toBe('new_version');
    expect(result.version).toBe(2);
    expect(result.script_id).not.toBe(created.script_id);
    // History: version 1 is byte for byte what the night was delivered from.
    expect(await storedBytes(gym, created.script_id)).toBe(v1Bytes);

    const lineage = await getSessionScriptLineage(gym.organizationId, created.script_id);
    expect(lineage.map((row) => [row.script_id, row.version, row.created_by_account_id])).toEqual([
      [created.script_id, 1, gym.coachId],
      [result.script_id, 2, gym.otherCoachId],
    ]);

    const v2 = await getSessionScriptWithDetail(gym.organizationId, result.script_id);
    expect(v2).toMatchObject({
      name: 'Fixture Workout, longer',
      lineage_id: created.script_id,
      version: 2,
      total_minutes: 16,
      authoring_state: 'coach_reviewed',
      source_document: 'Workout template: Fixture Workout v3',
      contact_structure: 'split_non_contact_then_contact',
    });
    expect(v2!.blocks.map((block) => [block.block_order, block.block_label, block.start_offset_min, block.end_offset_min, block.drill_id, block.what_to_say, block.what_to_explain])).toEqual([
      [1, 'Long jab round', 0, 12, 'ref-jab', 'Hands up.', 'warm-up'],
      [2, 'Partner mirror', 6, 11, null, null, 'technical - 10 reps'],
      [3, 'Sparring Round', 11, 16, 'ref-spar', null, 'From workout template: Fixture Workout'],
    ]);
    // Re-minted, never shared: a version-1 run's cursor can never land on a version-2 block.
    const v1BlockIds = v1!.blocks.map((block) => block.block_id);
    expect(v2!.blocks.some((block) => v1BlockIds.includes(block.block_id))).toBe(false);
    expect(v2!.renderings.map((rendering) => [rendering.format, rendering.audience_note, rendering.body]))
      .toEqual([['cheat_sheet', 'for the coach', 'the sheet']]);
    expect(v2!.renderings[0].rendering_id).not.toBe('rnd_v1');

    // The list and the start follow the new version; the delivered night still says version 1.
    expect((await listSessionScripts(gym.organizationId)).map((script) => script.script_id)).toEqual([result.script_id]);
    const history = await listSettledRunsForScript(gym.organizationId, result.script_id);
    expect(history.map((row) => [row.run_id, row.script_id, row.script_version])).toEqual([[run.run_id, created.script_id, 1]]);
    await expect(startSessionScriptRun(gym.organizationId, gym.coachId, { scriptId: created.script_id }))
      .rejects.toThrow('SESSION_SCRIPT_SUPERSEDED');
    const next = await startSessionScriptRun(gym.organizationId, gym.coachId, { scriptId: result.script_id });
    expect(next).toMatchObject({ script_id: result.script_id, script_version: 2, current_block_id: v2!.blocks[0].block_id });

    // And the replaced version is no longer the one to edit.
    await expectRefused(edit(gym, created.script_id, { name: 'Late edit' }), 'SESSION_SCRIPT_SUPERSEDED', 409);
    expect(await storedBytes(gym, created.script_id)).toBe(v1Bytes);
  });

  test('a session still on the floor counts as a run: its plan is not changed under the coach', async () => {
    const gym = await newGym('live');
    await insertTemplate(gym);
    const created = await create(gym);
    const v1 = await getSessionScriptWithDetail(gym.organizationId, created.script_id);
    const run = await startSessionScriptRun(gym.organizationId, gym.coachId, { scriptId: created.script_id });
    const v1Bytes = await storedBytes(gym, created.script_id);

    const result = await edit(gym, created.script_id, { name: 'Changed mid-session' });

    expect(result.outcome).toBe('new_version');
    expect(await storedBytes(gym, created.script_id)).toBe(v1Bytes);
    const moved = await moveSessionScriptRunCursor(gym.organizationId, gym.coachId, run.run_id, v1!.blocks[2].block_id);
    expect(moved).toMatchObject({ script_id: created.script_id, script_version: 1, current_block_id: v1!.blocks[2].block_id });
  });

  test('saving with nothing changed writes nothing, even on a delivered script', async () => {
    const gym = await newGym('unchanged');
    await insertTemplate(gym);
    const created = await create(gym);
    const detail = await getSessionScriptWithDetail(gym.organizationId, created.script_id);
    const run = await startSessionScriptRun(gym.organizationId, gym.coachId, { scriptId: created.script_id });
    await finishSessionScriptRun(gym.organizationId, gym.coachId, run.run_id, { runState: 'abandoned' });
    const before = await counts(gym);

    const result = await edit(gym, created.script_id, {
      name: detail!.name,
      blocks: detail!.blocks.map(({ block_id, block_label, start_offset_min, end_offset_min }) => ({
        block_id,
        block_label,
        start_offset_min,
        end_offset_min,
      })),
    });

    expect(result).toEqual({ outcome: 'unchanged', script_id: created.script_id, version: 1 });
    expect(await counts(gym)).toEqual(before);
  });

  test("another gym's script is not found, and a refused edit changes nothing", async () => {
    const owner = await newGym('edit-owner');
    const other = await newGym('edit-other');
    await insertTemplate(owner);
    await insertTemplate(other);
    const created = await create(owner);
    const foreign = await create(other);
    const detail = await getSessionScriptWithDetail(owner.organizationId, created.script_id);
    const foreignDetail = await getSessionScriptWithDetail(other.organizationId, foreign.script_id);
    const bytes = await storedBytes(owner, created.script_id);
    const block = detail!.blocks[0];

    // The script id is real and correct; only the gym is wrong.
    await expectRefused(edit(other, created.script_id, { name: 'Taken over' }), 'SESSION_SCRIPT_NOT_FOUND', 404);
    // A block of another script, here another gym's, cannot be reached through this one.
    await expectRefused(
      edit(owner, created.script_id, {
        blocks: [{ block_id: foreignDetail!.blocks[0].block_id, block_label: 'x', start_offset_min: 0, end_offset_min: 5 }],
      }),
      'SESSION_SCRIPT_BLOCK_NOT_IN_SCRIPT',
      422,
    );
    for (const [start, end] of [[5, 5], [-1, 4], [0, 1.5], [0, 24 * 60 + 1]]) {
      await expectRefused(
        edit(owner, created.script_id, {
          blocks: [{ block_id: block.block_id, block_label: 'x', start_offset_min: start, end_offset_min: end }],
        }),
        'SESSION_SCRIPT_BLOCK_MINUTES_INVALID',
        422,
      );
    }
    await expectRefused(
      edit(owner, created.script_id, {
        blocks: [{ block_id: block.block_id, block_label: '  ', start_offset_min: 0, end_offset_min: 5 }],
      }),
      'SESSION_SCRIPT_BLOCK_LABEL_INVALID',
      422,
    );

    expect(await storedBytes(owner, created.script_id)).toBe(bytes);
    expect(await counts(owner)).toEqual({ scripts: 1, blocks: 3, audit: 1 });
  });
});
