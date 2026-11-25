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
// 5. Two coaches editing one script: the second save is refused and told, on
//    the timestamp the database itself wrote.
// 6. What a family reader is sent of a coach-made script (the projection the
//    route applies), read off the rows this module really wrote.
// 7. RETIRING. A retired script leaves the list and comes back when asked for;
//    every column but its state and updated_at is as it was; a delivered plan
//    gets no new version; and the server's start does not read the state.
// 8. MARKING REVIEWED (F-092). A coach moves a draft to coach_reviewed in
//    place, and the audit row names that coach.
// 9. AUDIT 2026-10-17. A block is titled with the drill version it links
//    (item 4); a template replaced while a plan is being made from it is
//    refused under lock (item 5's window, on this writer); and an edit
//    re-renders the coach renderings made from the blocks and leaves every
//    other rendering as written (item 8).
// 10. LANE W4-5, SP-1a. A library drill added, a block removed, blocks moved:
//    in place they are renumbered without tripping the order constraint, the
//    contact label is read again, and a removed block's row is gone; a block
//    something else names is never deleted -- that edit is a new version.
// 11. LANE W4-5, SP-1b. A text block carries the contact level the coach
//    picked; a copy carries everything its source says, from any plan of the
//    gym; both raise the label like any block, and a copy's drill is locked
//    before the plan.
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
  SessionScriptAuthoringError,
  createSessionScriptFromTemplate,
  editSessionScript,
  markSessionScriptReviewed,
  renderingFromBlocks,
  setSessionScriptRetired,
} from './sessionScriptAuthoring';
import {
  finishSessionScriptRun,
  listSettledRunsForScript,
  moveSessionScriptRunCursor,
  startSessionScriptRun,
} from './sessionScriptRuns';
import { projectSessionScriptDetailForReader } from './sessionScriptProjection';
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
 *   1  'warm-up'                        drill ref-jab, scale A, 6 minutes, a coach note
 *   2  'technical'  typed step 'Partner mirror', 10 reps, no minutes
 *   3  ''           drill ref-spar, controlled sparring (so no minutes or reps), no note
 */
async function insertTemplate(gym: Gym, opts: { steps?: boolean; active?: boolean; superseded?: boolean } = {}): Promise<void> {
  await client.query(
    `insert into pilot.workout_templates
       (organization_id, template_id, lineage_id, version, name, session_type, difficulty, age_band, active,
        duration_minutes, intent, superseded_at)
     values ($1,$2,$2,3,'Fixture Workout','technical','intermediate','any',$3,45,'Coach-typed intent',
             case when $4::boolean then now() else null end)`,
    [gym.organizationId, TEMPLATE_ID, opts.active ?? true, opts.superseded ?? false],
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

type EditChange = Pick<Parameters<typeof editSessionScript>[0], 'name' | 'blocks' | 'add' | 'remove' | 'order' | 'expectedUpdatedAt'>;

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

/** Every stored column of a script, its blocks and its renderings, as text: what "unchanged" is compared on. */
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
  const renderings = await client.query(
    `select to_jsonb(r)::text as row from pilot.session_script_renderings r
      where organization_id = $1 and script_id = $2 order by format`,
    [gym.organizationId, scriptId],
  );
  return [...script.rows, ...blocks.rows, ...renderings.rows].map((row) => row.row).join('\n');
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
      // The template's stated length (45), not the 16 minutes its blocks add up to.
      total_minutes: 45,
      contact_structure: 'split_non_contact_then_contact',
      // Made from a template, not reviewed by anyone: a draft (F-078).
      authoring_state: 'draft',
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
      { order: 1, window: [0, 6], label: 'Jab Drill', kind: 'drill_round', drill: 'ref-jab', scale: 'A', contact: 'none', say: 'Hands up.', explain: 'From the template: Warm-up' },
      { order: 2, window: [6, 11], label: 'Partner mirror', kind: 'instruction', drill: null, scale: null, contact: 'none', say: null, explain: 'From the template: Technical, 10 reps' },
      { order: 3, window: [11, 16], label: 'Sparring Round', kind: 'drill_round', drill: 'ref-spar', scale: null, contact: 'controlled_sparring', say: null, explain: 'From the template: Fixture Workout' },
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

  test("another gym's template is not found; one with no steps, withdrawn or replaced is refused; none writes", async () => {
    const owner = await newGym('owner');
    const other = await newGym('other');
    await insertTemplate(owner);
    await expectRefused(create(other), 'WORKOUT_TEMPLATE_NOT_FOUND', 404);
    expect(await counts(other)).toEqual({ scripts: 0, blocks: 0, audit: 0 });
    expect(await counts(owner)).toEqual({ scripts: 0, blocks: 0, audit: 0 });

    const empty = await newGym('empty');
    await insertTemplate(empty, { steps: false });
    await expectRefused(create(empty), 'WORKOUT_TEMPLATE_EMPTY', 409);
    expect(await counts(empty)).toEqual({ scripts: 0, blocks: 0, audit: 0 });

    // The rule issuing a template holds: only a current one.
    for (const state of [{ active: false }, { superseded: true }]) {
      const gym = await newGym('not-current');
      await insertTemplate(gym, state);
      await expectRefused(create(gym), 'WORKOUT_TEMPLATE_NOT_CURRENT', 409);
      expect(await counts(gym)).toEqual({ scripts: 0, blocks: 0, audit: 0 });
    }
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

describe('what a family is sent of a coach-made script', () => {
  test('a parent and an athlete get the running order without the block titles, the coach text or who made it', async () => {
    const gym = await newGym('family');
    await insertTemplate(gym);
    const created = await create(gym);
    const stored = await getSessionScriptWithDetail(gym.organizationId, created.script_id);
    // The staff text really is in the stored rows, so its absence below is the projection's doing.
    expect(JSON.stringify(stored)).toContain('Hands up.');

    for (const role of ['parent', 'athlete'] as const) {
      const sent = projectSessionScriptDetailForReader(role, stored!);
      const text = JSON.stringify(sent);
      for (const staffOnly of [
        'Jab Drill', 'Partner mirror', 'Sparring Round', // block titles
        'Hands up.', 'From the template: Warm-up', 'From the template: Technical, 10 reps', 'From the template', // what to say / explain
        'Workout template: Fixture Workout v3', // source document
        gym.coachId,
        'Coach-typed intent',
      ]) {
        expect(text).not.toContain(staffOnly);
      }
      for (const block of sent.blocks) {
        expect(Object.keys(block).sort()).toEqual([
          'block_id', 'block_kind', 'block_order', 'contact_level', 'drill_id', 'end_offset_min',
          'organization_id', 'scale_level', 'script_id', 'start_offset_min',
        ]);
      }
      expect(sent).toMatchObject({ name: 'Fixture Workout', theme: '', total_minutes: 45 });
      expect(sent.blocks.map((block) => [block.start_offset_min, block.end_offset_min])).toEqual([[0, 6], [6, 11], [11, 16]]);
    }
    // The coach still reads all of it.
    expect(projectSessionScriptDetailForReader('coach', stored!)).toBe(stored);
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
        { block_id: third.block_id, block_label: third.block_label, start_offset_min: 15, end_offset_min: 50 },
      ],
    });

    expect(result).toEqual({ outcome: 'updated', script_id: created.script_id, version: 1 });
    expect((await getSessionScriptLineage(gym.organizationId, created.script_id)).map((row) => row.version)).toEqual([1]);
    const after = await getSessionScriptWithDetail(gym.organizationId, created.script_id);
    // The last block now ends past the 45 minutes the template stated, so the stated length is 50.
    expect(after).toMatchObject({ name: 'Renamed plan', version: 1, total_minutes: 50, created_by_account_id: gym.coachId });
    expect(after!.blocks.map((block) => [block.block_id, block.block_label, block.start_offset_min, block.end_offset_min])).toEqual([
      [first.block_id, 'Jab warm-up', 0, 10],
      // Not named in the edit: kept exactly.
      [second.block_id, 'Partner mirror', 6, 11],
      [third.block_id, 'Sparring Round', 15, 50],
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
      // A block moved, but the blocks still end inside the 45 minutes stated: it stays 45.
      total_minutes: 45,
      // Made from a template, not reviewed by anyone: a draft (F-078).
      authoring_state: 'draft',
      source_document: 'Workout template: Fixture Workout v3',
      contact_structure: 'split_non_contact_then_contact',
    });
    expect(v2!.blocks.map((block) => [block.block_order, block.block_label, block.start_offset_min, block.end_offset_min, block.drill_id, block.what_to_say, block.what_to_explain])).toEqual([
      [1, 'Long jab round', 0, 12, 'ref-jab', 'Hands up.', 'From the template: Warm-up'],
      [2, 'Partner mirror', 6, 11, null, null, 'From the template: Technical, 10 reps'],
      [3, 'Sparring Round', 11, 16, 'ref-spar', null, 'From the template: Fixture Workout'],
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

  test('two edits of a delivered script at once: one becomes version 2, the other is told it was replaced', async () => {
    const gym = await newGym('race');
    await insertTemplate(gym);
    const created = await create(gym);
    const run = await startSessionScriptRun(gym.organizationId, gym.coachId, { scriptId: created.script_id });
    await finishSessionScriptRun(gym.organizationId, gym.coachId, run.run_id, { runState: 'completed' });
    const v1Bytes = await storedBytes(gym, created.script_id);

    // Each edit runs on a connection and transaction of its own (the ./db mock above).
    const settled = await Promise.allSettled([
      edit(gym, created.script_id, { name: 'First save' }),
      edit(gym, created.script_id, { name: 'Second save' }),
    ]);

    const made = settled.filter((result) => result.status === 'fulfilled');
    const refused = settled.filter((result) => result.status === 'rejected');
    expect(made).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect((made[0] as PromiseFulfilledResult<{ outcome: string; version: number }>).value).toMatchObject({ outcome: 'new_version', version: 2 });
    // Not a unique-key error surfacing as a server fault: the same answer a late edit gets.
    const reason = (refused[0] as PromiseRejectedResult).reason;
    expect(reason).toBeInstanceOf(SessionScriptAuthoringError);
    expect(reason.message).toBe('SESSION_SCRIPT_SUPERSEDED');
    expect((await getSessionScriptLineage(gym.organizationId, created.script_id)).map((row) => row.version)).toEqual([1, 2]);
    expect(await storedBytes(gym, created.script_id)).toBe(v1Bytes);
  });

  test('two coaches edit a plan nobody has delivered: the second save is refused and the first is kept', async () => {
    const gym = await newGym('two-coaches');
    await insertTemplate(gym);
    const created = await create(gym);
    // Both coaches open the editor on the same stored plan.
    const opened = await getSessionScriptWithDetail(gym.organizationId, created.script_id);
    const readAt = new Date(opened!.updated_at).toISOString();

    const first = await edit(gym, created.script_id, { name: 'First coach', expectedUpdatedAt: readAt });
    expect(first.outcome).toBe('updated');
    const afterFirst = await storedBytes(gym, created.script_id);

    await expectRefused(
      edit(gym, created.script_id, {
        name: 'Second coach',
        blocks: [{ block_id: opened!.blocks[0].block_id, block_label: 'Overwritten', start_offset_min: 0, end_offset_min: 30 }],
        expectedUpdatedAt: readAt,
      }),
      'SESSION_SCRIPT_CHANGED',
      409,
    );
    // Told, not silently overwritten: the first coach's save is exactly as it was.
    expect(await storedBytes(gym, created.script_id)).toBe(afterFirst);
    expect((await getSessionScriptWithDetail(gym.organizationId, created.script_id))!.name).toBe('First coach');

    // Having re-read the plan, the second coach saves on top of the first.
    const reread = await getSessionScriptWithDetail(gym.organizationId, created.script_id);
    const second = await edit(gym, created.script_id, {
      name: 'Second coach',
      expectedUpdatedAt: new Date(reread!.updated_at).toISOString(),
    });
    expect(second.outcome).toBe('updated');

    // And at the same instant, from the same read: one saves, one is told.
    const again = await getSessionScriptWithDetail(gym.organizationId, created.script_id);
    const at = new Date(again!.updated_at).toISOString();
    const settled = await Promise.allSettled([
      edit(gym, created.script_id, { name: 'Left hand', expectedUpdatedAt: at }),
      edit(gym, created.script_id, { name: 'Right hand', expectedUpdatedAt: at }),
    ]);
    expect(settled.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const lost = settled.find((result) => result.status === 'rejected') as PromiseRejectedResult;
    expect(lost.reason).toBeInstanceOf(SessionScriptAuthoringError);
    expect(lost.reason.message).toBe('SESSION_SCRIPT_CHANGED');
    expect((await getSessionScriptLineage(gym.organizationId, created.script_id)).map((row) => row.version)).toEqual([1]);
  });

  test('a start that waited for an edit to finish is told the plan was replaced, not started on the old version', async () => {
    const gym = await newGym('start-race');
    await insertTemplate(gym);
    const created = await create(gym);
    const first = await startSessionScriptRun(gym.organizationId, gym.coachId, { scriptId: created.script_id });
    await finishSessionScriptRun(gym.organizationId, gym.coachId, first.run_id, { runState: 'completed' });

    // An edit of this delivered plan, held open at the point where it has
    // locked version 1 and written version 2 but not yet committed.
    const editor = new Client({ connectionString: connectionStringFor(DATABASE_NAME) });
    await editor.connect();
    try {
      await editor.query('BEGIN');
      await editor.query(
        `select 1 from pilot.session_scripts where organization_id = $1 and script_id = $2 for update`,
        [gym.organizationId, created.script_id],
      );
      await editor.query(
        `insert into pilot.session_scripts
           (organization_id, script_id, lineage_id, version, name, created_by_account_id)
         values ($1, 'scr_v2_held', $2, 2, 'Version two', $3)`,
        [gym.organizationId, created.script_id, gym.otherCoachId],
      );

      // The other coach presses Start on version 1 while that edit is open.
      const start = startSessionScriptRun(gym.organizationId, gym.otherCoachId, { scriptId: created.script_id }).then(
        (run) => ({ run, error: null as unknown }),
        (error: unknown) => ({ run: null, error }),
      );
      // It has to be waiting on the edit, not already answered.
      const early = await Promise.race([start, new Promise((resolve) => setTimeout(() => resolve('waiting'), 750))]);
      expect(early).toBe('waiting');

      await editor.query('COMMIT');
      const outcome = await start;

      expect(outcome.run).toBeNull();
      expect((outcome.error as Error).message).toBe('SESSION_SCRIPT_SUPERSEDED');
    } finally {
      await editor.query('ROLLBACK').catch(() => {});
      await editor.end();
    }
    // Nothing was started on the replaced version: the one run is the earlier, settled one.
    const runs = await client.query(
      `select run_id from pilot.session_script_runs where organization_id = $1 and script_id = $2`,
      [gym.organizationId, created.script_id],
    );
    expect(runs.rows.map((row) => row.run_id)).toEqual([first.run_id]);
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

describe('retiring a session script', () => {
  function retire(gym: Gym, scriptId: string, retired: boolean, expectedUpdatedAt?: string) {
    return setSessionScriptRetired({
      organizationId: gym.organizationId,
      actorAccountId: gym.otherCoachId,
      actorRole: 'coach',
      scriptId,
      retired,
      expectedUpdatedAt,
    });
  }

  /** The script row without the two columns a retire may change, then its blocks and renderings. */
  async function allButState(gym: Gym, scriptId: string): Promise<string> {
    const script = await client.query(
      `select (to_jsonb(s) - 'authoring_state' - 'updated_at')::text as row
         from pilot.session_scripts s where organization_id = $1 and script_id = $2`,
      [gym.organizationId, scriptId],
    );
    const whole = await storedBytes(gym, scriptId);
    return [script.rows[0].row, ...whole.split('\n').slice(1)].join('\n');
  }

  const listed = async (gym: Gym, includeRetired = false) =>
    (await listSessionScripts(gym.organizationId, { includeRetired })).map((script) => script.script_id);

  test('a retired plan leaves the list and is kept whole; brought back, it returns to what it was before (F-078)', async () => {
    const gym = await newGym('retire');
    await insertTemplate(gym);
    const created = await create(gym);
    // An imported plan in use, so "brought back" has a different state to return to than it left.
    await client.query(
      `update pilot.session_scripts set authoring_state = 'in_use' where organization_id = $1 and script_id = $2`,
      [gym.organizationId, created.script_id],
    );
    const before = await allButState(gym, created.script_id);
    const auditBefore = (await counts(gym)).audit;

    const retired = await retire(gym, created.script_id, true);

    expect(retired).toEqual({ outcome: 'retired', script_id: created.script_id, version: 1 });
    expect(await listed(gym)).toEqual([]);
    expect(await listed(gym, true)).toEqual([created.script_id]);
    // Kept, not deleted, and not a new version: one row, every other column as it was.
    expect(await counts(gym)).toEqual({ scripts: 1, blocks: 3, audit: auditBefore + 1 });
    expect(await allButState(gym, created.script_id)).toBe(before);
    expect((await getSessionScriptWithDetail(gym.organizationId, created.script_id))!.authoring_state).toBe('retired');

    // Asked again, nothing is written.
    expect((await retire(gym, created.script_id, true)).outcome).toBe('unchanged');
    expect((await counts(gym)).audit).toBe(auditBefore + 1);

    const back = await retire(gym, created.script_id, false);

    expect(back).toEqual({ outcome: 'brought_back', script_id: created.script_id, version: 1 });
    expect(await listed(gym)).toEqual([created.script_id]);
    // In use before it was retired, so in use again: not a review nobody did.
    expect((await getSessionScriptWithDetail(gym.organizationId, created.script_id))!.authoring_state).toBe('in_use');
    expect(await allButState(gym, created.script_id)).toBe(before);
    expect((await retire(gym, created.script_id, false)).outcome).toBe('unchanged');

    const audit = await query<{ event_type: string; actor_account_id: string; details: Record<string, unknown> }>(
      `select event_type, actor_account_id, details from pilot.audit_events
        where organization_id = $1 and entity_type = 'session_script' and details ? 'state_after'
        order by created_at, details->>'state_after' desc`,
      [gym.organizationId],
    );
    expect(audit.map((row) => [row.event_type, row.actor_account_id, row.details.outcome, row.details.state_before, row.details.state_after])).toEqual([
      ['update', gym.otherCoachId, 'retired', 'in_use', 'retired'],
      ['update', gym.otherCoachId, 'brought_back', 'retired', 'in_use'],
    ]);
  });

  test('brought back, a plan takes the state of its LAST retire; with no retire on record, it is a draft (F-078)', async () => {
    const gym = await newGym('retire-restore');
    await insertTemplate(gym);
    const created = await create(gym);
    const state = async () => (await getSessionScriptWithDetail(gym.organizationId, created.script_id))!.authoring_state;
    const setState = (value: string) => client.query(
      `update pilot.session_scripts set authoring_state = $3 where organization_id = $1 and script_id = $2`,
      [gym.organizationId, created.script_id, value],
    );

    // Made from a template: a draft, retired from draft, back as a draft.
    expect(await state()).toBe('draft');
    await retire(gym, created.script_id, true);
    await retire(gym, created.script_id, false);
    expect(await state()).toBe('draft');

    // Reviewed later, retired again: the newer retire is the one that counts.
    await setState('coach_reviewed');
    await retire(gym, created.script_id, true);
    await retire(gym, created.script_id, false);
    expect(await state()).toBe('coach_reviewed');

    // Retired with no retire on record (as an import may leave it): a draft, never a review.
    await setState('retired');
    await client.query(
      `delete from pilot.audit_events where organization_id = $1 and entity_type = 'session_script' and entity_id = $2`,
      [gym.organizationId, created.script_id],
    );
    await retire(gym, created.script_id, false);
    expect(await state()).toBe('draft');
  });

  test('retiring a delivered plan makes no new version and leaves the delivered night as it was', async () => {
    const gym = await newGym('retire-delivered');
    await insertTemplate(gym);
    const created = await create(gym);
    const run = await startSessionScriptRun(gym.organizationId, gym.coachId, { scriptId: created.script_id });
    await finishSessionScriptRun(gym.organizationId, gym.coachId, run.run_id, { runState: 'completed', whatWorked: 'The jab round.' });
    const before = await allButState(gym, created.script_id);
    const runBefore = await client.query(
      `select to_jsonb(r)::text as row from pilot.session_script_runs r where organization_id = $1 and run_id = $2`,
      [gym.organizationId, run.run_id],
    );

    const retired = await retire(gym, created.script_id, true);

    expect(retired.outcome).toBe('retired');
    // An edit of a delivered plan makes version 2. A retire does not: nothing a night ran from changed.
    expect((await getSessionScriptLineage(gym.organizationId, created.script_id)).map((row) => row.version)).toEqual([1]);
    expect(await allButState(gym, created.script_id)).toBe(before);
    const runAfter = await client.query(
      `select to_jsonb(r)::text as row from pilot.session_script_runs r where organization_id = $1 and run_id = $2`,
      [gym.organizationId, run.run_id],
    );
    expect(runAfter.rows[0].row).toBe(runBefore.rows[0].row);
    const history = await listSettledRunsForScript(gym.organizationId, created.script_id);
    expect(history.map((row) => [row.run_id, row.what_worked])).toEqual([[run.run_id, 'The jab round.']]);
  });

  test('a session live on a plan that is then retired finishes normally', async () => {
    const gym = await newGym('retire-live');
    await insertTemplate(gym);
    const created = await create(gym);
    const detail = await getSessionScriptWithDetail(gym.organizationId, created.script_id);
    const run = await startSessionScriptRun(gym.organizationId, gym.coachId, { scriptId: created.script_id });

    expect((await retire(gym, created.script_id, true)).outcome).toBe('retired');

    const moved = await moveSessionScriptRunCursor(gym.organizationId, gym.coachId, run.run_id, detail!.blocks[1].block_id);
    expect(moved.current_block_id).toBe(detail!.blocks[1].block_id);
    const settled = await finishSessionScriptRun(gym.organizationId, gym.coachId, run.run_id, { runState: 'completed' });
    expect(settled.run_state).toBe('completed');
  });

  // TODAY'S BEHAVIOUR, WRITTEN DOWN (Overwatch on the H plan): the server's
  // start does not read authoring_state. The screen is what stops offering
  // Start on a retired plan. If the server is ever to refuse it, that is a
  // decision someone makes on purpose, and this case is what it changes.
  test('the server still starts a retired plan when asked by id: retired hides, it does not refuse', async () => {
    const gym = await newGym('retire-start');
    await insertTemplate(gym);
    const created = await create(gym);
    await retire(gym, created.script_id, true);

    const run = await startSessionScriptRun(gym.organizationId, gym.coachId, { scriptId: created.script_id });

    expect(run).toMatchObject({ script_id: created.script_id, script_version: 1, run_state: 'in_progress' });
  });

  test("another gym's plan, a plan saved since it was read, and a replaced version are each refused and unchanged", async () => {
    const owner = await newGym('retire-owner');
    const other = await newGym('retire-other');
    await insertTemplate(owner);
    const created = await create(owner);
    const opened = await getSessionScriptWithDetail(owner.organizationId, created.script_id);
    const readAt = new Date(opened!.updated_at).toISOString();
    const bytes = await storedBytes(owner, created.script_id);

    // The script id is real and correct; only the gym is wrong.
    await expectRefused(retire(other, created.script_id, true), 'SESSION_SCRIPT_NOT_FOUND', 404);
    expect(await storedBytes(owner, created.script_id)).toBe(bytes);

    // Another coach renamed it after this one opened it: told, not retired from under them.
    await edit(owner, created.script_id, { name: 'Renamed meanwhile', expectedUpdatedAt: readAt });
    const afterRename = await storedBytes(owner, created.script_id);
    await expectRefused(retire(owner, created.script_id, true, readAt), 'SESSION_SCRIPT_CHANGED', 409);
    expect(await storedBytes(owner, created.script_id)).toBe(afterRename);
    expect(await listed(owner)).toEqual([created.script_id]);

    // A version that has been replaced is not the one to retire.
    const run = await startSessionScriptRun(owner.organizationId, owner.coachId, { scriptId: created.script_id });
    await finishSessionScriptRun(owner.organizationId, owner.coachId, run.run_id, { runState: 'completed' });
    const v2 = await edit(owner, created.script_id, { name: 'Version two' });
    await expectRefused(retire(owner, created.script_id, true), 'SESSION_SCRIPT_SUPERSEDED', 409);
    expect(await listed(owner)).toEqual([v2.script_id]);
  });
});

describe('retiring and the other writes', () => {
  const retireAs = (gym: Gym, scriptId: string, retired: boolean) => setSessionScriptRetired({
    organizationId: gym.organizationId,
    actorAccountId: gym.coachId,
    actorRole: 'coach',
    scriptId,
    retired,
  });

  test('a retire counts as a save: an edit made from before it is refused, not applied to a retired plan', async () => {
    const gym = await newGym('retire-then-stale-edit');
    await insertTemplate(gym);
    const created = await create(gym);
    // One coach opens the editor; another retires the plan; the first then saves.
    const opened = await getSessionScriptWithDetail(gym.organizationId, created.script_id);
    const readAt = new Date(opened!.updated_at).toISOString();

    await retireAs(gym, created.script_id, true);

    const after = await getSessionScriptWithDetail(gym.organizationId, created.script_id);
    expect(new Date(after!.updated_at).getTime()).toBeGreaterThan(new Date(opened!.updated_at).getTime());
    const bytes = await storedBytes(gym, created.script_id);
    await expectRefused(
      edit(gym, created.script_id, { name: 'Saved from before the retire', expectedUpdatedAt: readAt }),
      'SESSION_SCRIPT_CHANGED',
      409,
    );
    expect(await storedBytes(gym, created.script_id)).toBe(bytes);
  });

  // WRITTEN DOWN, NOT DESIGNED HERE: the server lets a retired plan be edited
  // (the screen does not offer it), and the state travels with the plan, as it
  // does across a content import.
  test('an edit of a retired plan keeps it retired, in place and on a new version', async () => {
    const gym = await newGym('edit-retired');
    await insertTemplate(gym);
    const created = await create(gym);
    await retireAs(gym, created.script_id, true);

    const inPlace = await edit(gym, created.script_id, { name: 'Renamed while retired' });
    expect(inPlace.outcome).toBe('updated');
    expect((await getSessionScriptWithDetail(gym.organizationId, created.script_id))!.authoring_state).toBe('retired');

    // Delivered (the server's start does not read the state), then edited: version 2 is retired too.
    const run = await startSessionScriptRun(gym.organizationId, gym.coachId, { scriptId: created.script_id });
    await finishSessionScriptRun(gym.organizationId, gym.coachId, run.run_id, { runState: 'completed' });
    const v2 = await edit(gym, created.script_id, { name: 'Version two, still retired' });
    expect(v2.outcome).toBe('new_version');
    expect((await getSessionScriptWithDetail(gym.organizationId, v2.script_id))!.authoring_state).toBe('retired');
    expect(await listSessionScripts(gym.organizationId)).toEqual([]);
    expect((await listSessionScripts(gym.organizationId, { includeRetired: true })).map((script) => script.script_id))
      .toEqual([v2.script_id]);
  });

  test('brought back after an edit made a new version while retired, a plan takes the state it was retired from (F-078)', async () => {
    const gym = await newGym('retire-new-version');
    await insertTemplate(gym);
    const created = await create(gym);
    await client.query(
      `update pilot.session_scripts set authoring_state = 'in_use' where organization_id = $1 and script_id = $2`,
      [gym.organizationId, created.script_id],
    );
    await retireAs(gym, created.script_id, true);
    const run = await startSessionScriptRun(gym.organizationId, gym.coachId, { scriptId: created.script_id });
    await finishSessionScriptRun(gym.organizationId, gym.coachId, run.run_id, { runState: 'completed' });
    const v2 = await edit(gym, created.script_id, { name: 'Version two, still retired' });
    expect(v2.outcome).toBe('new_version');

    // The retire's audit row is under version 1; version 2 is brought back.
    await retireAs(gym, v2.script_id, false);
    expect((await getSessionScriptWithDetail(gym.organizationId, v2.script_id))!.authoring_state).toBe('in_use');
  });
});

describe('marking a session script reviewed (F-092)', () => {
  /** Marked by the gym's OTHER coach: whole-gym reach (OD-2026-10-11-007), not only the author. */
  function markReviewed(gym: Gym, scriptId: string, expectedUpdatedAt?: string) {
    return markSessionScriptReviewed({
      organizationId: gym.organizationId,
      actorAccountId: gym.otherCoachId,
      actorRole: 'coach',
      scriptId,
      expectedUpdatedAt,
    });
  }

  const stateOf = async (gym: Gym, scriptId: string) =>
    (await getSessionScriptWithDetail(gym.organizationId, scriptId))!.authoring_state;

  const reviewRows = (gym: Gym) => query<{ event_type: string; actor_account_id: string; actor_role: string; entity_id: string; details: Record<string, unknown> }>(
    `select event_type, actor_account_id, actor_role, entity_id, details from pilot.audit_events
      where organization_id = $1 and entity_type = 'session_script' and details->>'outcome' = 'reviewed'`,
    [gym.organizationId],
  );

  test('a coach marks a draft reviewed: in place, the list reads it, and the audit row names the coach', async () => {
    const gym = await newGym('review');
    await insertTemplate(gym);
    const created = await create(gym);
    expect(await stateOf(gym, created.script_id)).toBe('draft');
    const readAt = (await getSessionScriptWithDetail(gym.organizationId, created.script_id))!.updated_at;
    const before = await counts(gym);

    const result = await markReviewed(gym, created.script_id, new Date(readAt).toISOString());

    expect(result).toEqual({ outcome: 'reviewed', script_id: created.script_id, version: 1 });
    expect(await stateOf(gym, created.script_id)).toBe('coach_reviewed');
    expect((await listSessionScripts(gym.organizationId)).map((script) => [script.script_id, script.authoring_state]))
      .toEqual([[created.script_id, 'coach_reviewed']]);
    // No new version, no new block: one audit row more.
    expect(await counts(gym)).toEqual({ ...before, audit: before.audit + 1 });
    expect(await reviewRows(gym)).toEqual([{
      event_type: 'update',
      actor_account_id: gym.otherCoachId,
      actor_role: 'coach',
      entity_id: created.script_id,
      details: { name: created.name, version: 1, outcome: 'reviewed', state_before: 'draft', state_after: 'coach_reviewed' },
    }]);

    // Pressed again: nothing is written.
    expect((await markReviewed(gym, created.script_id)).outcome).toBe('unchanged');
    expect((await counts(gym)).audit).toBe(before.audit + 1);
  });

  test('a plan in use is left as it is', async () => {
    const gym = await newGym('review-in-use');
    await insertTemplate(gym);
    const created = await create(gym);
    await client.query(
      `update pilot.session_scripts set authoring_state = 'in_use' where organization_id = $1 and script_id = $2`,
      [gym.organizationId, created.script_id],
    );
    expect((await markReviewed(gym, created.script_id)).outcome).toBe('unchanged');
    expect(await stateOf(gym, created.script_id)).toBe('in_use');
    expect(await reviewRows(gym)).toEqual([]);
  });

  test('refused, nothing written: a retired plan, a plan saved since it was read, another gym', async () => {
    const owner = await newGym('review-owner');
    const other = await newGym('review-other');
    await insertTemplate(owner);
    const created = await create(owner);
    const readAt = new Date((await getSessionScriptWithDetail(owner.organizationId, created.script_id))!.updated_at).toISOString();

    await expectRefused(
      markSessionScriptReviewed({
        organizationId: other.organizationId,
        actorAccountId: other.coachId,
        actorRole: 'coach',
        scriptId: created.script_id,
      }),
      'SESSION_SCRIPT_NOT_FOUND',
      404,
    );

    await edit(owner, created.script_id, { name: 'Renamed meanwhile' });
    await expectRefused(markReviewed(owner, created.script_id, readAt), 'SESSION_SCRIPT_CHANGED', 409);

    await setSessionScriptRetired({
      organizationId: owner.organizationId,
      actorAccountId: owner.coachId,
      actorRole: 'coach',
      scriptId: created.script_id,
      retired: true,
    });
    await expectRefused(markReviewed(owner, created.script_id), 'SESSION_SCRIPT_RETIRED', 409);

    expect(await stateOf(owner, created.script_id)).toBe('retired');
    expect(await reviewRows(owner)).toEqual([]);
    expect(await reviewRows(other)).toEqual([]);
  });

  test('reviewed, retired and brought back, a plan is coach reviewed again', async () => {
    const gym = await newGym('review-retire');
    await insertTemplate(gym);
    const created = await create(gym);
    await markReviewed(gym, created.script_id);
    const retireAs = (retired: boolean) => setSessionScriptRetired({
      organizationId: gym.organizationId,
      actorAccountId: gym.coachId,
      actorRole: 'coach',
      scriptId: created.script_id,
      retired,
    });
    await retireAs(true);
    await retireAs(false);
    expect(await stateOf(gym, created.script_id)).toBe('coach_reviewed');
  });
});

/**
 * Holds `statement` uncommitted on a connection of its own, starts `act`, and
 * commits as soon as `act` is seen waiting on that connection's lock -- or
 * once `act` has finished without ever waiting. Says which happened.
 */
async function whileUncommitted<T>(
  statement: string,
  values: unknown[],
  act: () => Promise<T>,
): Promise<{ waited: boolean; outcome: PromiseSettledResult<T> }> {
  const holder = new Client({ connectionString: activeConnectionString as string });
  await holder.connect();
  try {
    await holder.query('BEGIN');
    await holder.query(statement, values);
    const { rows } = await holder.query<{ pid: number }>('select pg_backend_pid() as pid');
    let finished = false;
    const settled: Promise<PromiseSettledResult<T>> = act().then(
      (value) => ({ status: 'fulfilled' as const, value }),
      (reason: unknown) => ({ status: 'rejected' as const, reason }),
    );
    void settled.then(() => {
      finished = true;
    });
    let waited = false;
    const deadline = Date.now() + 30_000;
    while (!finished && Date.now() < deadline) {
      const blocked = await client.query(
        `select 1 from pg_stat_activity where $1 = any(pg_blocking_pids(pid)) limit 1`,
        [rows[0].pid],
      );
      if ((blocked.rowCount ?? 0) > 0) {
        waited = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    await holder.query('COMMIT');
    return { waited, outcome: await settled };
  } finally {
    await holder.end();
  }
}

describe('audit 2026-10-17: version names, the template under lock, and renderings on edit', () => {
  test('a block is titled with the drill version it links, though a newer version renamed the drill (item 4)', async () => {
    const gym = await newGym('version-name');
    await insertTemplate(gym);
    // A newer version of the jab drill, renamed. The template still names v1,
    // which the revision supersedes (one head per lineage).
    await client.query(
      `update pilot.drill_library set superseded_at = now() where organization_id = $1 and drill_id = 'ref-jab'`,
      [gym.organizationId],
    );
    await client.query(
      `insert into pilot.drill_library
         (organization_id, drill_id, lineage_id, version, supersedes_drill_id, name, discipline, category, difficulty,
          target_behavior, purpose, standard_setup, execution, what_good_looks_like, what_bad_looks_like,
          field_provenance, active)
       values ($1, 'ref-jab-v2', 'ref-jab', 2, 'ref-jab', 'Renamed drill v2', 'boxing', 'footwork', 'advanced',
               'target', 'purpose', 'setup', 'execution', 'good', 'bad', 'PPBF source manual v3', true)`,
      [gym.organizationId],
    );

    const created = await create(gym);

    const detail = await getSessionScriptWithDetail(gym.organizationId, created.script_id);
    expect([detail!.blocks[0].drill_id, detail!.blocks[0].block_label]).toEqual(['ref-jab', 'Jab Drill']);
  });

  test('a template replaced while a plan is being made from it is refused, and nothing is written', async () => {
    const gym = await newGym('create-lock');
    await insertTemplate(gym);
    const before = await counts(gym);

    const { waited, outcome } = await whileUncommitted(
      `update pilot.workout_templates set superseded_at = now() where organization_id = $1 and template_id = $2`,
      [gym.organizationId, TEMPLATE_ID],
      () => create(gym),
    );

    expect(outcome.status).toBe('rejected');
    const reason = (outcome as PromiseRejectedResult).reason as SessionScriptAuthoringError;
    expect([reason.message, reason.status]).toEqual(['WORKOUT_TEMPLATE_NOT_CURRENT', 409]);
    expect(waited).toBe(true);
    expect(await counts(gym)).toEqual(before);
  });

  async function insertRenderings(gym: Gym, scriptId: string): Promise<void> {
    await client.query(
      `insert into pilot.session_script_renderings
         (organization_id, rendering_id, script_id, format, audience_note, body, generated_from_blocks)
       values ($1, $2 || '-sheet',  $2, 'cheat_sheet',    'coach, in hand', 'made from the old blocks', true),
              ($1, $2 || '-plan',   $2, 'class_plan',     'coach',          'Written by hand.',         false),
              ($1, $2 || '-parent', $2, 'parent_summary', 'families',       'Family words.',            true)`,
      [gym.organizationId, scriptId],
    );
  }

  async function renderings(gym: Gym, scriptId: string): Promise<Array<[string, string, boolean]>> {
    const { rows } = await client.query<{ format: string; body: string; generated_from_blocks: boolean }>(
      `select format, body, generated_from_blocks from pilot.session_script_renderings
        where organization_id = $1 and script_id = $2 order by format`,
      [gym.organizationId, scriptId],
    );
    return rows.map((row) => [row.format, row.body, row.generated_from_blocks]);
  }

  test('an edit in place re-renders the coach rendering made from the blocks; hand-written and family ones stay as written (item 8)', async () => {
    const gym = await newGym('render-in-place');
    await insertTemplate(gym);
    const created = await create(gym);
    await insertRenderings(gym, created.script_id);
    const before = await getSessionScriptWithDetail(gym.organizationId, created.script_id);

    const result = await edit(gym, created.script_id, {
      name: 'Friday plan',
      blocks: [{ block_id: before!.blocks[0].block_id, block_label: 'Long jab round', start_offset_min: 0, end_offset_min: 12 }],
    });

    expect(result.outcome).toBe('updated');
    const after = await getSessionScriptWithDetail(gym.organizationId, created.script_id);
    expect(renderingFromBlocks('Friday plan', after!.blocks)).toContain('0-12 min  Long jab round');
    expect(await renderings(gym, created.script_id)).toEqual([
      ['cheat_sheet', renderingFromBlocks('Friday plan', after!.blocks), true],
      ['class_plan', 'Written by hand.', false],
      ['parent_summary', 'Family words.', true],
    ]);
  });

  test('a delivered plan: the new version re-renders the coach rendering made from the blocks, copies the rest, and version 1 is untouched (item 8)', async () => {
    const gym = await newGym('render-version');
    await insertTemplate(gym);
    const created = await create(gym);
    await insertRenderings(gym, created.script_id);
    const v1 = await getSessionScriptWithDetail(gym.organizationId, created.script_id);
    const run = await startSessionScriptRun(gym.organizationId, gym.coachId, { scriptId: created.script_id });
    await finishSessionScriptRun(gym.organizationId, gym.coachId, run.run_id, { runState: 'completed' });
    const v1Bytes = await storedBytes(gym, created.script_id);

    const result = await edit(gym, created.script_id, {
      blocks: [{ block_id: v1!.blocks[2].block_id, block_label: 'Two rounds', start_offset_min: 11, end_offset_min: 20 }],
    });

    expect(result.outcome).toBe('new_version');
    expect(await storedBytes(gym, created.script_id)).toBe(v1Bytes);
    const v2 = await getSessionScriptWithDetail(gym.organizationId, result.script_id);
    expect(renderingFromBlocks('Fixture Workout', v2!.blocks)).toContain('11-20 min  Two rounds');
    expect(await renderings(gym, result.script_id)).toEqual([
      ['cheat_sheet', renderingFromBlocks('Fixture Workout', v2!.blocks), true],
      ['class_plan', 'Written by hand.', false],
      ['parent_summary', 'Family words.', true],
    ]);
  });
});

describe('backbone labels across an in-app edit that writes a new version', () => {
  async function labelRows(gym: Gym, lineage: string) {
    const { rows } = await client.query(
      `select target_version, field_labels, evidence, backbone_version, import_id from pilot.content_record_labels
        where organization_id = $1 and target_kind = 'session_script' and target_lineage_id = $2 order by target_version`,
      [gym.organizationId, lineage],
    );
    return rows;
  }
  async function linkRows(gym: Gym, lineage: string) {
    const { rows } = await client.query(
      `select stage_key, superseded_at from pilot.content_stage_links
        where organization_id = $1 and target_kind = 'session_script' and target_lineage_id = $2 order by stage_key`,
      [gym.organizationId, lineage],
    );
    return rows;
  }
  async function labelled(label: string) {
    const gym = await newGym(label);
    await insertTemplate(gym);
    const created = await create(gym);
    await client.query(
      `insert into pilot.content_record_labels
         (organization_id, target_kind, target_lineage_id, target_version, field_labels, evidence, backbone_version,
          import_id, recorded_by_account_id, recorded_by_role)
       values ($1, 'session_script', $2, 1, '{"name":"authored"}'::jsonb, '[{"source":"manual"}]'::jsonb, 'bb-1', 'imp_l1', $3, 'organization_admin')`,
      [gym.organizationId, created.lineage_id, gym.coachId],
    );
    await client.query(
      `insert into pilot.pathway_stages (organization_id, stage_key, segment, ordinal, name, contact_default)
       values ($1, 'Y1', 'youth', 1, 'Introduction', 'none')`,
      [gym.organizationId],
    );
    await client.query(
      `insert into pilot.content_stage_links (organization_id, target_kind, target_lineage_id, stage_key, import_id, recorded_by_account_id, recorded_by_role)
       values ($1, 'session_script', $2, 'Y1', 'imp_l1', $3, 'organization_admin')`,
      [gym.organizationId, created.lineage_id, gym.coachId],
    );
    const run = await startSessionScriptRun(gym.organizationId, gym.coachId, { scriptId: created.script_id });
    await finishSessionScriptRun(gym.organizationId, gym.coachId, run.run_id, { runState: 'completed' });
    return { gym, created };
  }

  test('a script with a run, edited to version 2, keeps its labels; its stage links stay as they were', async () => {
    const { gym, created } = await labelled('labels-carry');
    const before = await labelRows(gym, created.lineage_id);
    const linksBefore = await linkRows(gym, created.lineage_id);

    const result = await edit(gym, created.script_id, { name: 'Renamed after a run' });

    expect(result).toMatchObject({ outcome: 'new_version', version: 2 });
    const after = await labelRows(gym, created.lineage_id);
    expect(after).toHaveLength(2);
    expect(after[0]).toEqual(before[0]);
    expect(after[1]).toEqual({ ...before[0], target_version: 2 });
    expect(await linkRows(gym, created.lineage_id)).toEqual(linksBefore);
  });

  test('a script without labels gets none invented; an in-place edit (no run) writes no label row', async () => {
    const gym = await newGym('labels-none');
    await insertTemplate(gym);
    const created = await create(gym);
    const run = await startSessionScriptRun(gym.organizationId, gym.coachId, { scriptId: created.script_id });
    await finishSessionScriptRun(gym.organizationId, gym.coachId, run.run_id, { runState: 'completed' });
    expect(await edit(gym, created.script_id, { name: 'Unlabelled v2' })).toMatchObject({ version: 2 });
    expect(await labelRows(gym, created.lineage_id)).toEqual([]);

    const second = await newGym('labels-inplace');
    await insertTemplate(second);
    const plain = await create(second);
    await client.query(
      `insert into pilot.content_record_labels
         (organization_id, target_kind, target_lineage_id, target_version, field_labels, import_id, recorded_by_account_id, recorded_by_role)
       values ($1, 'session_script', $2, 1, '{"name":"x"}'::jsonb, 'imp_l1', $3, 'organization_admin')`,
      [second.organizationId, plain.lineage_id, second.coachId],
    );
    expect(await edit(second, plain.script_id, { name: 'In place' })).toMatchObject({ outcome: 'updated', version: 1 });
    expect((await labelRows(second, plain.lineage_id)).map((row) => row.target_version)).toEqual([1]);
  });
});

// Lane W4-5, SP-1a (Overwatch GO on #2189: Q1 = C, Q2 = A, Q3 = A). The fixture plan runs
//   1 Jab Drill (ref-jab, no contact) 0-6, 2 Partner mirror (typed, no contact) 6-11,
//   3 Sparring Round (ref-spar, controlled_sparring) 11-16, labelled split_non_contact_then_contact.
describe('adding, removing and moving blocks (lane W4-5, SP-1a)', () => {
  async function libraryDrill(gym: Gym, drillId: string, name: string, contactLevel = 'none'): Promise<void> {
    await insertReference(gym, drillId, name);
    await client.query(`update pilot.drill_library set contact_level = $3 where organization_id = $1 and drill_id = $2`, [
      gym.organizationId,
      drillId,
      contactLevel,
    ]);
  }

  async function plan(label: string) {
    const gym = await newGym(label);
    await insertTemplate(gym);
    const created = await create(gym);
    const before = await getSessionScriptWithDetail(gym.organizationId, created.script_id);
    const [jab, mirror, spar] = before!.blocks.map((block) => block.block_id);
    return { gym, scriptId: created.script_id, jab, mirror, spar };
  }

  const shape = (blocks: NonNullable<Awaited<ReturnType<typeof getSessionScriptWithDetail>>>['blocks']) =>
    blocks.map((block) => [block.block_order, block.block_id, block.block_label, block.start_offset_min, block.end_offset_min]);

  async function lastAudit(gym: Gym): Promise<Record<string, unknown>> {
    const { rows } = await client.query<{ details: Record<string, unknown> }>(
      `select details from pilot.audit_events where organization_id = $1 and entity_type = 'session_script'
        order by created_at desc, audit_id desc limit 1`,
      [gym.organizationId],
    );
    return rows[0].details;
  }

  test("a library drill is added where the order puts it, in place: the drill's contact level, a line naming the drill, the label read again", async () => {
    const { gym, scriptId, jab, mirror, spar } = await plan('add');
    await libraryDrill(gym, 'ref-clinch', 'Clinch Work', 'controlled_sparring');

    const result = await edit(gym, scriptId, {
      add: [{ ref: 'new-1', kind: 'drill', drill_id: 'ref-clinch', start_offset_min: 0, end_offset_min: 4 }],
      order: ['new-1', jab, mirror, spar],
    });

    expect(result).toEqual({ outcome: 'updated', script_id: scriptId, version: 1 });
    const after = await getSessionScriptWithDetail(gym.organizationId, scriptId);
    const added = after!.blocks[0];
    expect(added).toMatchObject({
      block_order: 1,
      block_label: 'Clinch Work',
      start_offset_min: 0,
      end_offset_min: 4,
      block_kind: 'drill_round',
      drill_id: 'ref-clinch',
      scale_level: null,
      // Q1 = C: the drill's own level, the most step_contact_above_drill allows.
      contact_level: 'controlled_sparring',
      what_to_say: null,
      what_to_explain: 'From the drill: Clinch Work',
      what_to_watch: null,
      what_to_fix: null,
    });
    expect(added.block_id).toMatch(/^blk_/);
    // The kept blocks keep their ids, titles and minutes, and move down one place.
    expect(shape(after!.blocks).slice(1)).toEqual([
      [2, jab, 'Jab Drill', 0, 6],
      [3, mirror, 'Partner mirror', 6, 11],
      [4, spar, 'Sparring Round', 11, 16],
    ]);
    // Contact, no contact, no contact, contact: the plan now reads contact, never less.
    expect(after).toMatchObject({ contact_structure: 'contact', total_minutes: 45, version: 1 });
    expect(await counts(gym)).toEqual({ scripts: 1, blocks: 4, audit: 2 });
    expect(await lastAudit(gym)).toMatchObject({ outcome: 'updated', blocks_added: 1, blocks_removed: 0, order_changed: false });
  });

  // Overwatch Q2 = A on #2191: no block row is ever deleted, so every removal is a new version.
  test('a removal is a new version though nobody ran the plan: version 1 keeps every block, version 2 runs without it', async () => {
    const { gym, scriptId, jab, mirror, spar } = await plan('remove');
    const v1Bytes = await storedBytes(gym, scriptId);

    const result = await edit(gym, scriptId, { remove: [mirror], order: [spar, jab] });

    expect(result).toMatchObject({ outcome: 'new_version', version: 2, because: 'removal' });
    expect(await storedBytes(gym, scriptId)).toBe(v1Bytes);
    const v2 = await getSessionScriptWithDetail(gym.organizationId, result.script_id);
    expect(v2!.blocks.map((block) => [block.block_order, block.block_label, block.start_offset_min, block.end_offset_min])).toEqual([
      [1, 'Sparring Round', 11, 16],
      [2, 'Jab Drill', 0, 6],
    ]);
    // Contact first, then none: the label is raised to contact.
    expect(v2!.contact_structure).toBe('contact');
    expect(await lastAudit(gym)).toMatchObject({
      outcome: 'new_version', blocks_added: 0, blocks_removed: 1, order_changed: true, new_version_because: 'a block was removed',
    });
  });

  test('moving blocks only swaps their places; an order that changes nothing writes nothing', async () => {
    const { gym, scriptId, jab, mirror, spar } = await plan('move');
    const unchangedBytes = await storedBytes(gym, scriptId);

    await expect(edit(gym, scriptId, { order: [jab, mirror, spar] })).resolves.toEqual({
      outcome: 'unchanged',
      script_id: scriptId,
      version: 1,
    });
    expect(await storedBytes(gym, scriptId)).toBe(unchangedBytes);

    await edit(gym, scriptId, { order: [mirror, jab, spar] });
    const after = await getSessionScriptWithDetail(gym.organizationId, scriptId);
    // Minutes are stored as sent (Q2 = A: the editor proposes them); only the places changed.
    expect(shape(after!.blocks)).toEqual([
      [1, mirror, 'Partner mirror', 6, 11],
      [2, jab, 'Jab Drill', 0, 6],
      [3, spar, 'Sparring Round', 11, 16],
    ]);
    expect(after!.contact_structure).toBe('split_non_contact_then_contact');
  });

  test('a delivered plan: the blocks change on version 2, and version 1 is byte for byte what the night ran', async () => {
    const { gym, scriptId, jab, mirror, spar } = await plan('delivered');
    await libraryDrill(gym, 'ref-pads', 'Pad Round');
    const run = await startSessionScriptRun(gym.organizationId, gym.coachId, { scriptId });
    await finishSessionScriptRun(gym.organizationId, gym.coachId, run.run_id, { runState: 'completed' });
    const v1Bytes = await storedBytes(gym, scriptId);

    const result = await edit(gym, scriptId, {
      add: [{ ref: 'pads', kind: 'drill', drill_id: 'ref-pads', block_label: 'Pads, two rounds', start_offset_min: 16, end_offset_min: 22 }],
      remove: [mirror],
      order: [jab, 'pads', spar],
    });

    // A delivered plan, removal or not: the version was made because it had been run.
    expect(result).toMatchObject({ outcome: 'new_version', version: 2, because: 'run' });
    expect(await storedBytes(gym, scriptId)).toBe(v1Bytes);
    const v2 = await getSessionScriptWithDetail(gym.organizationId, result.script_id);
    expect(v2!.blocks.map((block) => [block.block_order, block.block_label, block.drill_id, block.contact_level])).toEqual([
      [1, 'Jab Drill', 'ref-jab', 'none'],
      [2, 'Pads, two rounds', 'ref-pads', 'none'],
      [3, 'Sparring Round', 'ref-spar', 'controlled_sparring'],
    ]);
    expect(v2!.blocks.some((block) => [jab, mirror, spar].includes(block.block_id))).toBe(false);
    // The blocks end at 22, inside the 45 minutes stated.
    expect(v2).toMatchObject({ contact_structure: 'split_non_contact_then_contact', total_minutes: 45 });
  });

  // Reviewer B on #2191, findings 2 and 3: on the new version, the places and the label are the edit's.
  test('a delivered plan moved and relabelled: version 2 runs in the new order and reads the new label', async () => {
    const { gym, scriptId, jab, mirror, spar } = await plan('delivered-move');
    const run = await startSessionScriptRun(gym.organizationId, gym.coachId, { scriptId });
    await finishSessionScriptRun(gym.organizationId, gym.coachId, run.run_id, { runState: 'completed' });

    const moved = await edit(gym, scriptId, { order: [spar, jab, mirror] });
    const v2 = await getSessionScriptWithDetail(gym.organizationId, moved.script_id);
    expect(v2!.blocks.map((block) => [block.block_order, block.block_label])).toEqual([
      [1, 'Sparring Round'],
      [2, 'Jab Drill'],
      [3, 'Partner mirror'],
    ]);
    // Contact first: the label the blocks said (split) follows them to contact.
    expect(v2!.contact_structure).toBe('contact');

    const run2 = await startSessionScriptRun(gym.organizationId, gym.coachId, { scriptId: moved.script_id });
    await finishSessionScriptRun(gym.organizationId, gym.coachId, run2.run_id, { runState: 'completed' });
    const v2Spar = v2!.blocks[0].block_id;
    const removed = await edit(gym, moved.script_id, { remove: [v2Spar] });
    expect(removed).toMatchObject({ outcome: 'new_version', version: 3 });
    // Removing the contact block does not lower it.
    expect((await getSessionScriptWithDetail(gym.organizationId, removed.script_id))!.contact_structure).toBe('contact');
  });

  test('a block a research claim names stays, with its claim, on the version it was written for (Q3 = A)', async () => {
    const { gym, scriptId, mirror } = await plan('claimed');
    await client.query(
      `insert into pilot.transfer_claims (organization_id, transfer_id, block_id, claim_kind, statement)
       values ($1, 'trc_1', $2, 'life_skill_transfer', 'Waiting a turn')`,
      [gym.organizationId, mirror],
    );
    const v1Bytes = await storedBytes(gym, scriptId);

    const result = await edit(gym, scriptId, { remove: [mirror] });

    expect(result).toMatchObject({ outcome: 'new_version', version: 2 });
    expect(await storedBytes(gym, scriptId)).toBe(v1Bytes);
    const claim = await client.query(`select block_id from pilot.transfer_claims where organization_id = $1 and transfer_id = 'trc_1'`, [
      gym.organizationId,
    ]);
    expect(claim.rows).toEqual([{ block_id: mirror }]);
    const v2 = await getSessionScriptWithDetail(gym.organizationId, result.script_id);
    expect(v2!.blocks.map((block) => block.block_label)).toEqual(['Jab Drill', 'Sparring Round']);
  });

  test("refused and nothing written: another gym's drill, a replaced or withdrawn drill, an order that drops a block, another gym's plan", async () => {
    const { gym, scriptId, jab, mirror, spar } = await plan('refused');
    const other = await newGym('refused-other');
    await insertReference(other, 'ref-theirs', 'Their Drill');
    await libraryDrill(gym, 'ref-old', 'Old Drill');
    await client.query(`update pilot.drill_library set superseded_at = now() where organization_id = $1 and drill_id = 'ref-old'`, [
      gym.organizationId,
    ]);
    await libraryDrill(gym, 'ref-gone', 'Gone Drill');
    await client.query(`update pilot.drill_library set active = false where organization_id = $1 and drill_id = 'ref-gone'`, [
      gym.organizationId,
    ]);
    const bytes = await storedBytes(gym, scriptId);
    const before = await counts(gym);
    const drillBlock = (drillId: string) => [{ ref: 'n', kind: 'drill' as const, drill_id: drillId, start_offset_min: 16, end_offset_min: 20 }];

    await expectRefused(edit(gym, scriptId, { add: drillBlock('ref-theirs') }), 'SESSION_SCRIPT_DRILL_NOT_FOUND', 422);
    await expectRefused(edit(gym, scriptId, { add: drillBlock('ref-old') }), 'SESSION_SCRIPT_DRILL_NOT_CURRENT', 409);
    await expectRefused(edit(gym, scriptId, { add: drillBlock('ref-gone') }), 'SESSION_SCRIPT_DRILL_NOT_CURRENT', 409);
    await expectRefused(edit(gym, scriptId, { order: [jab, spar] }), 'SESSION_SCRIPT_ORDER_INVALID', 422);
    await expectRefused(edit(other, scriptId, { remove: [mirror] }), 'SESSION_SCRIPT_NOT_FOUND', 404);

    expect(await storedBytes(gym, scriptId)).toBe(bytes);
    expect(await counts(gym)).toEqual(before);
  });

  test('a drill replaced while a block is being added from it is refused under lock, and nothing is written', async () => {
    const { gym, scriptId } = await plan('drill-lock');
    await libraryDrill(gym, 'ref-pads', 'Pad Round');
    const bytes = await storedBytes(gym, scriptId);

    const { waited, outcome } = await whileUncommitted(
      `update pilot.drill_library set superseded_at = now() where organization_id = $1 and drill_id = 'ref-pads'`,
      [gym.organizationId],
      () => edit(gym, scriptId, { add: [{ ref: 'n', kind: 'drill', drill_id: 'ref-pads', start_offset_min: 16, end_offset_min: 20 }] }),
    );

    expect(waited).toBe(true);
    expect(outcome.status).toBe('rejected');
    const reason = (outcome as PromiseRejectedResult).reason as SessionScriptAuthoringError;
    expect([reason.message, reason.status]).toEqual(['SESSION_SCRIPT_DRILL_NOT_CURRENT', 409]);
    expect(await storedBytes(gym, scriptId)).toBe(bytes);
  });

  // Reviewer A on #2191, finding 2: a plan with no blocks is an existing state the page shows.
  test('a plan left with no blocks is kept: it can still be renamed, and blocks added to it', async () => {
    const { gym, scriptId, jab, mirror, spar } = await plan('empty');
    await libraryDrill(gym, 'ref-pads', 'Pad Round');

    const emptied = await edit(gym, scriptId, { remove: [jab, mirror, spar] });
    expect(emptied).toMatchObject({ outcome: 'new_version', version: 2 });
    expect((await getSessionScriptWithDetail(gym.organizationId, emptied.script_id))!.blocks).toEqual([]);
    await expect(edit(gym, emptied.script_id, { name: 'Renamed, still empty' })).resolves.toMatchObject({ outcome: 'updated' });
    await edit(gym, emptied.script_id, { add: [{ ref: 'n', kind: 'drill', drill_id: 'ref-pads', start_offset_min: 0, end_offset_min: 5 }] });
    const after = await getSessionScriptWithDetail(gym.organizationId, emptied.script_id);
    expect(after).toMatchObject({ name: 'Renamed, still empty', total_minutes: 45, version: 2 });
    expect(after!.blocks.map((block) => [block.block_order, block.block_label])).toEqual([[1, 'Pad Round']]);
  });

  // Reviewers A and B on #2191: an import names the label in its own column, and a block imported with
  // no contact level reads 'none'. Nothing records which labels are an author's, so no block edit lowers
  // one -- not in one save, and not across saves that end where they started.
  test('no block edit lowers the contact label, in one save or across several; the blocks raise it', async () => {
    const { gym, scriptId, jab, mirror, spar } = await plan('label-floor');
    await libraryDrill(gym, 'ref-clinch', 'Clinch Work', 'controlled_sparring');
    await client.query(`update pilot.session_scripts set contact_structure = 'contact' where organization_id = $1 and script_id = $2`, [
      gym.organizationId,
      scriptId,
    ]);
    await client.query(`update pilot.session_script_blocks set contact_level = 'none' where organization_id = $1 and block_id = $2`, [
      gym.organizationId,
      spar,
    ]);
    const label = async () => (await getSessionScriptWithDetail(gym.organizationId, scriptId))!.contact_structure;

    await edit(gym, scriptId, { order: [mirror, jab, spar] });
    expect(await label()).toBe('contact');
    // observation_only, which no block can say, is kept while no block has contact, through a real save.
    await client.query(`update pilot.session_scripts set contact_structure = 'observation_only' where organization_id = $1 and script_id = $2`, [
      gym.organizationId,
      scriptId,
    ]);
    await edit(gym, scriptId, { order: [jab, mirror, spar] });
    expect(await label()).toBe('observation_only');
    await client.query(`update pilot.session_scripts set contact_structure = 'contact' where organization_id = $1 and script_id = $2`, [
      gym.organizationId,
      scriptId,
    ]);

    // Add a contact drill, then take it out again (version 2): the plan ends as it began, and so does its label.
    await edit(gym, scriptId, { add: [{ ref: 'n', kind: 'drill', drill_id: 'ref-clinch', start_offset_min: 16, end_offset_min: 20 }] });
    const added = (await getSessionScriptWithDetail(gym.organizationId, scriptId))!.blocks.find((block) => block.drill_id === 'ref-clinch');
    const v2 = await edit(gym, scriptId, { remove: [added!.block_id] });
    expect((await getSessionScriptWithDetail(gym.organizationId, v2.script_id))!.contact_structure).toBe('contact');

    // A plan whose contact block is removed keeps the contact it said (the floor errs on the safe side).
    const fresh = await plan('label-kept');
    const kept = await edit(fresh.gym, fresh.scriptId, { remove: [fresh.spar] });
    expect((await getSessionScriptWithDetail(fresh.gym.organizationId, kept.script_id))!.contact_structure).toBe('split_non_contact_then_contact');
  });

  // Reviewer A on #2191 (reproduced on main) and Overwatch on #2191: an edit that writes a new version
  // copies the plan's blocks, and each copy's drill key is checked; the plan's linked drills are locked
  // before the plan, as content import locks them, so the two queue instead of deadlocking.
  test('a new version and an import holding a linked drill then the plan queue, never deadlock', async () => {
    const { gym, scriptId, mirror } = await plan('version-lock');
    const holder = new Client({ connectionString: activeConnectionString as string });
    await holder.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(`select 1 from pilot.drill_library where organization_id = $1 and drill_id = 'ref-jab' for update`, [gym.organizationId]);
      const { rows } = await holder.query<{ pid: number }>('select pg_backend_pid() as pid');
      const removing = edit(gym, scriptId, { remove: [mirror] }).then(
        (value) => ({ status: 'fulfilled' as const, value }),
        (reason: unknown) => ({ status: 'rejected' as const, reason }),
      );
      const deadline = Date.now() + 30_000;
      for (;;) {
        const blocked = await client.query(`select 1 from pg_stat_activity where $1 = any(pg_blocking_pids(pid))`, [rows[0].pid]);
        if ((blocked.rowCount ?? 0) > 0 || Date.now() > deadline) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      await holder.query(`select 1 from pilot.session_scripts where organization_id = $1 and script_id = $2 for update`, [gym.organizationId, scriptId]);
      await holder.query('COMMIT');
      const outcome = await removing;
      expect(outcome.status).toBe('fulfilled');
      expect((outcome as PromiseFulfilledResult<{ outcome: string }>).value.outcome).toBe('new_version');
    } finally {
      await holder.end();
    }
  });

  // Reviewer A on #2191, finding 3: content import locks a drill, then the plan. An edit adding that
  // drill takes them in the same order, so the two queue instead of deadlocking.
  test('an edit adding a drill and an import holding that drill then the plan queue, never deadlock', async () => {
    const { gym, scriptId } = await plan('lock-order');
    await libraryDrill(gym, 'ref-pads', 'Pad Round');
    const holder = new Client({ connectionString: activeConnectionString as string });
    await holder.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(`select 1 from pilot.drill_library where organization_id = $1 and drill_id = 'ref-pads' for update`, [
        gym.organizationId,
      ]);
      const { rows } = await holder.query<{ pid: number }>('select pg_backend_pid() as pid');
      const editing = edit(gym, scriptId, {
        add: [{ ref: 'n', kind: 'drill', drill_id: 'ref-pads', start_offset_min: 16, end_offset_min: 20 }],
      }).then(
        (value) => ({ status: 'fulfilled' as const, value }),
        (reason: unknown) => ({ status: 'rejected' as const, reason }),
      );
      const deadline = Date.now() + 30_000;
      for (;;) {
        const blocked = await client.query(`select 1 from pg_stat_activity where $1 = any(pg_blocking_pids(pid))`, [rows[0].pid]);
        if ((blocked.rowCount ?? 0) > 0 || Date.now() > deadline) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      // The import's next step: the plan row. Under the other lock order this is a deadlock.
      await holder.query(`select 1 from pilot.session_scripts where organization_id = $1 and script_id = $2 for update`, [
        gym.organizationId,
        scriptId,
      ]);
      await holder.query('COMMIT');
      const outcome = await editing;
      expect(outcome.status).toBe('fulfilled');
    } finally {
      await holder.end();
    }
    expect((await getSessionScriptWithDetail(gym.organizationId, scriptId))!.blocks.map((block) => block.drill_id)).toContain('ref-pads');
  });

  // Reviewer A on #2191, round 4: content import locks every drill it names in one statement, in drill_id
  // order. An edit locks its new and its linked drills in one ordered statement too, so an import
  // holding a linked drill (ref-jab) and then wanting the new one (ref-pads) queues with it.
  test('an edit adding a drill and an import holding a linked drill then the new drill queue, never deadlock', async () => {
    const { gym, scriptId } = await plan('lock-union');
    await libraryDrill(gym, 'ref-pads', 'Pad Round');
    const holder = new Client({ connectionString: activeConnectionString as string });
    await holder.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(`select 1 from pilot.drill_library where organization_id = $1 and drill_id = 'ref-jab' for update`, [gym.organizationId]);
      const { rows } = await holder.query<{ pid: number }>('select pg_backend_pid() as pid');
      const adding = edit(gym, scriptId, { add: [{ ref: 'n', kind: 'drill', drill_id: 'ref-pads', start_offset_min: 16, end_offset_min: 20 }] }).then(
        (value) => ({ status: 'fulfilled' as const, value }),
        (reason: unknown) => ({ status: 'rejected' as const, reason }),
      );
      const deadline = Date.now() + 30_000;
      for (;;) {
        const blocked = await client.query(`select 1 from pg_stat_activity where $1 = any(pg_blocking_pids(pid))`, [rows[0].pid]);
        if ((blocked.rowCount ?? 0) > 0 || Date.now() > deadline) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      await holder.query(`select 1 from pilot.drill_library where organization_id = $1 and drill_id = 'ref-pads' for update`, [gym.organizationId]);
      await holder.query(`select 1 from pilot.session_scripts where organization_id = $1 and script_id = $2 for update`, [gym.organizationId, scriptId]);
      await holder.query('COMMIT');
      expect((await adding).status).toBe('fulfilled');
    } finally {
      await holder.end();
    }
  });

  test('the coach rendering made from the blocks follows the new running order', async () => {
    const { gym, scriptId, jab, mirror, spar } = await plan('render');
    await client.query(
      `insert into pilot.session_script_renderings
         (organization_id, rendering_id, script_id, format, audience_note, body, generated_from_blocks)
       values ($1, 'rnd_sheet', $2, 'cheat_sheet', 'coach', 'made from the old blocks', true)`,
      [gym.organizationId, scriptId],
    );

    await edit(gym, scriptId, { order: [spar, jab, mirror] });

    const after = await getSessionScriptWithDetail(gym.organizationId, scriptId);
    const sheet = after!.renderings.find((rendering) => rendering.format === 'cheat_sheet');
    expect(sheet!.body).toBe(renderingFromBlocks(after!.name, after!.blocks));
    expect(sheet!.body.indexOf('Sparring Round')).toBeLessThan(sheet!.body.indexOf('Jab Drill'));
  });
});

// Lane W4-5, SP-1b (Overwatch GO on #2189: Q1 = C, a text block's contact level is the coach's pick,
// required; a copied block carries its source's).
describe('adding text blocks and copies (lane W4-5, SP-1b)', () => {
  async function plan(label: string) {
    const gym = await newGym(label);
    await insertTemplate(gym);
    // The fixture's sparring step runs at controlled_sparring; its drill says so too, as the importer's
    // step_contact_above_drill rule requires of any committed step (reviewer C on #2196).
    await client.query(`update pilot.drill_library set contact_level = 'controlled_sparring' where organization_id = $1 and drill_id = 'ref-spar'`, [
      gym.organizationId,
    ]);
    const created = await create(gym);
    const before = await getSessionScriptWithDetail(gym.organizationId, created.script_id);
    const [jab, mirror, spar] = before!.blocks.map((block) => block.block_id);
    return { gym, scriptId: created.script_id, jab, mirror, spar };
  }
  const place = { start_offset_min: 16, end_offset_min: 20 };
  const text = (overrides: Record<string, unknown> = {}) => ({
    ref: 't', kind: 'text' as const, block_kind: 'teaching_minute', block_label: 'Guard talk', text: '  Hands home after every punch. ',
    contact_level: 'none', ...place, ...overrides,
  });

  test('a text block carries its kind, title, words and the contact level the coach picked, and raises the label', async () => {
    const { gym, scriptId, jab, mirror, spar } = await plan('text');

    await edit(gym, scriptId, { add: [text({ contact_level: 'controlled_sparring' })], order: ['t', jab, mirror, spar] });

    const after = await getSessionScriptWithDetail(gym.organizationId, scriptId);
    expect(after!.blocks[0]).toMatchObject({
      block_order: 1, block_kind: 'teaching_minute', block_label: 'Guard talk', what_to_say: 'Hands home after every punch.',
      what_to_explain: null, what_to_watch: null, what_to_fix: null, drill_id: null, scale_level: null, contact_level: 'controlled_sparring',
    });
    // Contact, then none, none, contact: the split label is raised to contact.
    expect(after!.contact_structure).toBe('contact');
  });

  // Reviewer D on #2196: every kind, and the cap measured as a coach note's is.
  test.each(['arrival', 'transition', 'close'])('a %s may hold no words', async (kind) => {
    const { gym, scriptId } = await plan(`text-empty-${kind}`);
    await edit(gym, scriptId, { add: [text({ block_kind: kind, text: '  ' })] });
    expect((await getSessionScriptWithDetail(gym.organizationId, scriptId))!.blocks[3]).toMatchObject({ block_kind: kind, what_to_say: null });
  });

  test("no other kind may hold no words (nor only invisible characters), none holds more than a coach note, and drill_round or a contact level off the ladder is refused", async () => {
    const { gym, scriptId } = await plan('text-rules');
    const bytes = await storedBytes(gym, scriptId);
    for (const kind of ['instruction', 'demonstration', 'reset_minute', 'teaching_minute', 'conditioning', 'reflection']) {
      await expectRefused(edit(gym, scriptId, { add: [text({ block_kind: kind, text: '' })] }), 'SESSION_SCRIPT_BLOCK_TEXT_INVALID', 422);
    }
    await expectRefused(edit(gym, scriptId, { add: [text({ text: '\u200B \u2060' })] }), 'SESSION_SCRIPT_BLOCK_TEXT_INVALID', 422);
    await expectRefused(edit(gym, scriptId, { add: [text({ text: '\u200E\u00AD\u3164\u2063' })] }), 'SESSION_SCRIPT_BLOCK_TEXT_INVALID', 422);
    await expectRefused(edit(gym, scriptId, { add: [text({ text: 'x'.repeat(1001) })] }), 'SESSION_SCRIPT_BLOCK_TEXT_INVALID', 422);
    await expectRefused(edit(gym, scriptId, { add: [text({ block_kind: 'drill_round' })] }), 'SESSION_SCRIPT_BLOCK_KIND_INVALID', 422);
    await expectRefused(edit(gym, scriptId, { add: [text({ contact_level: 'full_contact' })] }), 'SESSION_SCRIPT_BLOCK_CONTACT_INVALID', 422);
    await expectRefused(edit(gym, scriptId, { add: [text({ contact_level: '' })] }), 'SESSION_SCRIPT_BLOCK_CONTACT_INVALID', 422);
    expect(await storedBytes(gym, scriptId)).toBe(bytes);

    // Exactly 1000 is a coach note's length; 600 decomposed é are 600 characters once normalised; CRLF is LF.
    await edit(gym, scriptId, { add: [text({ ref: 'a', text: 'x'.repeat(1000) })] });
    await edit(gym, scriptId, { add: [text({ ref: 'b', text: 'e\u0301'.repeat(600) })] });
    await edit(gym, scriptId, { add: [text({ ref: 'c', text: 'one\r\ntwo' })] });
    const says = (await getSessionScriptWithDetail(gym.organizationId, scriptId))!.blocks.slice(3).map((block) => block.what_to_say);
    expect(says.map((say) => say?.length)).toEqual([1000, 600, 7]);
    expect(says[2]).toBe('one\ntwo');
  });

  test("a copy from another plan of the gym carries everything its source says, its contact level included, under a new id", async () => {
    const { gym, scriptId, jab } = await plan('copy');
    const other = await create(gym, 'Another plan');
    const sparId = (await getSessionScriptWithDetail(gym.organizationId, other.script_id))!.blocks[2].block_id;
    // Watch and Fix written on the source too (reviewer D on #2196), so every line is carried and checked.
    await client.query(
      `update pilot.session_script_blocks set what_to_watch = 'Chin down', what_to_fix = 'Reset to stance'
        where organization_id = $1 and block_id = $2`,
      [gym.organizationId, sparId],
    );
    const source = (await getSessionScriptWithDetail(gym.organizationId, other.script_id))!.blocks[2];
    const sourceBytes = await storedBytes(gym, other.script_id);

    await edit(gym, scriptId, { add: [{ ref: 'c', kind: 'copy', block_id: source.block_id, ...place }] });
    await edit(gym, scriptId, { add: [{ ref: 'd', kind: 'copy', block_id: jab, block_label: 'Jab again', start_offset_min: 20, end_offset_min: 26 }] });

    const blocks = (await getSessionScriptWithDetail(gym.organizationId, scriptId))!.blocks;
    const carried = ({ block_label, what_to_say, what_to_explain, what_to_watch, what_to_fix, block_kind, drill_id, scale_level, contact_level }: typeof source) =>
      ({ block_label, what_to_say, what_to_explain, what_to_watch, what_to_fix, block_kind, drill_id, scale_level, contact_level });
    expect(carried(blocks[3])).toEqual(carried(source));
    expect(blocks[3]).toMatchObject({ what_to_watch: 'Chin down', what_to_fix: 'Reset to stance' });
    expect(blocks[3]).toMatchObject({ block_order: 4, start_offset_min: 16, end_offset_min: 20, contact_level: 'controlled_sparring' });
    expect(blocks[3].block_id).not.toBe(source.block_id);
    // A block of the same plan can be copied too, retitled.
    expect(blocks[4]).toMatchObject({ block_label: 'Jab again', drill_id: 'ref-jab', scale_level: 'A', what_to_say: 'Hands up.' });
    expect(await storedBytes(gym, other.script_id)).toBe(sourceBytes);
  });

  test("a copy links its drill's current version, as a template step does; the audit names the source block", async () => {
    const { gym, scriptId, jab } = await plan('copy-version');
    // A drill edit's shape: the old version superseded, then the new one written in its lineage.
    await client.query(`update pilot.drill_library set superseded_at = now() where organization_id = $1 and drill_id = 'ref-jab'`, [
      gym.organizationId,
    ]);
    await client.query(
      `insert into pilot.drill_library
         (organization_id, drill_id, lineage_id, version, supersedes_drill_id, name, discipline, category, difficulty,
          target_behavior, purpose, standard_setup, execution, what_good_looks_like, what_bad_looks_like, field_provenance, active)
       values ($1, 'ref-jab-v2', 'ref-jab', 2, 'ref-jab', 'Jab Drill, revised', 'boxing', 'footwork', 'advanced',
               'target', 'purpose', 'setup', 'execution', 'good', 'bad', 'PPBF source manual v3', true)`,
      [gym.organizationId],
    );

    await edit(gym, scriptId, { add: [{ ref: 'c', kind: 'copy', block_id: jab, ...place }] });

    const copy = (await getSessionScriptWithDetail(gym.organizationId, scriptId))!.blocks[3];
    // The title is the coach's text and is carried; the template's line is the template's and is carried too.
    expect(copy).toMatchObject({ drill_id: 'ref-jab-v2', block_label: 'Jab Drill', contact_level: 'none', what_to_explain: 'From the template: Warm-up' });
    const { rows } = await client.query(
      `select details from pilot.audit_events where organization_id = $1 and entity_type = 'session_script'
        order by created_at desc, audit_id desc limit 1`,
      [gym.organizationId],
    );
    expect(rows[0].details).toMatchObject({ blocks_added: 1, copied_from: [jab] });
  });

  // Reviewer C on #2196, round 2: the "From the drill" line is written by the app and names the drill
  // version the block links, so a copy relinked to a renamed drill's current version names that one.
  test('a copy of a block added from a drill, after the drill was renamed, names the version it now links', async () => {
    const { gym, scriptId } = await plan('copy-rename');
    await insertReference(gym, 'ref-pads', 'Pad Round');
    await edit(gym, scriptId, { add: [{ ref: 'p', kind: 'drill', drill_id: 'ref-pads', ...place }] });
    const pads = (await getSessionScriptWithDetail(gym.organizationId, scriptId))!.blocks[3];
    expect(pads.what_to_explain).toBe('From the drill: Pad Round');
    await client.query(`update pilot.drill_library set superseded_at = now() where organization_id = $1 and drill_id = 'ref-pads'`, [
      gym.organizationId,
    ]);
    await client.query(
      `insert into pilot.drill_library
         (organization_id, drill_id, lineage_id, version, supersedes_drill_id, name, discipline, category, difficulty,
          target_behavior, purpose, standard_setup, execution, what_good_looks_like, what_bad_looks_like, field_provenance, active)
       values ($1, 'ref-pads-v2', 'ref-pads', 2, 'ref-pads', 'Pad Ladder', 'boxing', 'footwork', 'advanced',
               'target', 'purpose', 'setup', 'execution', 'good', 'bad', 'PPBF source manual v3', true)`,
      [gym.organizationId],
    );

    await edit(gym, scriptId, { add: [{ ref: 'c', kind: 'copy', block_id: pads.block_id, start_offset_min: 20, end_offset_min: 24 }] });

    const copy = (await getSessionScriptWithDetail(gym.organizationId, scriptId))!.blocks[4];
    expect(copy).toMatchObject({ drill_id: 'ref-pads-v2', what_to_explain: 'From the drill: Pad Ladder', block_label: 'Pad Round' });
  });

  test("refused and nothing written: a copy of a withdrawn drill, a copy above its drill's current contact, another gym's block", async () => {
    const { gym, scriptId, jab, mirror, spar } = await plan('copy-refused');
    const theirs = await plan('copy-theirs');
    const bytes = await storedBytes(gym, scriptId);
    const copyOf = (blockId: string) => edit(gym, scriptId, { add: [{ ref: 'c', kind: 'copy', block_id: blockId, ...place }] });

    await client.query(`update pilot.drill_library set active = false where organization_id = $1 and drill_id = 'ref-jab'`, [gym.organizationId]);
    await expectRefused(copyOf(jab), 'SESSION_SCRIPT_DRILL_NOT_CURRENT', 409);
    // The gym lowered its sparring drill to no contact; a block that ran it at controlled sparring cannot be copied above it.
    await client.query(`update pilot.drill_library set contact_level = 'none' where organization_id = $1 and drill_id = 'ref-spar'`, [gym.organizationId]);
    await expectRefused(copyOf(spar), 'SESSION_SCRIPT_COPY_CONTACT_ABOVE_DRILL', 422);
    await expectRefused(copyOf(theirs.jab), 'SESSION_SCRIPT_COPY_SOURCE_NOT_FOUND', 422);
    expect(await storedBytes(gym, scriptId)).toBe(bytes);
    // A level off the ladder, which only a write outside the app could leave, is not carried (reviewer D).
    await client.query(`update pilot.session_script_blocks set contact_level = 'full_contact' where organization_id = $1 and block_id = $2`, [
      gym.organizationId,
      mirror,
    ]);
    const withOddLevel = await storedBytes(gym, scriptId);
    await expectRefused(copyOf(mirror), 'SESSION_SCRIPT_BLOCK_CONTACT_INVALID', 422);
    expect(await storedBytes(gym, scriptId)).toBe(withOddLevel);
  });

  // Reviewer D on #2196, round 2: new, copied and linked drills are locked in ONE statement in drill_id
  // order, as content import locks the drills it names, so an import holding a linked drill (ref-jab)
  // and then wanting the copy's (ref-spar) queues with the edit.
  test("an import holding a linked drill then a copy's drill queues with the copy, never deadlocks", async () => {
    const { gym, scriptId, spar } = await plan('copy-lock-union');
    const holder = new Client({ connectionString: activeConnectionString as string });
    await holder.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(`select 1 from pilot.drill_library where organization_id = $1 and drill_id = 'ref-jab' for update`, [gym.organizationId]);
      const { rows } = await holder.query<{ pid: number }>('select pg_backend_pid() as pid');
      const copying = edit(gym, scriptId, { add: [{ ref: 'c', kind: 'copy', block_id: spar, ...place }] }).then(
        (value) => ({ status: 'fulfilled' as const, value }),
        (reason: unknown) => ({ status: 'rejected' as const, reason }),
      );
      const deadline = Date.now() + 30_000;
      for (;;) {
        const blocked = await client.query(`select 1 from pg_stat_activity where $1 = any(pg_blocking_pids(pid))`, [rows[0].pid]);
        if ((blocked.rowCount ?? 0) > 0 || Date.now() > deadline) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      await holder.query(`select 1 from pilot.drill_library where organization_id = $1 and drill_id = 'ref-spar' for update`, [gym.organizationId]);
      await holder.query(`select 1 from pilot.session_scripts where organization_id = $1 and script_id = $2 for update`, [gym.organizationId, scriptId]);
      await holder.query('COMMIT');
      expect((await copying).status).toBe('fulfilled');
    } finally {
      await holder.end();
    }
  });

  test("a copy's drill is locked before the plan, so an import holding that drill then the plan queues with it", async () => {
    const { gym, scriptId, spar } = await plan('copy-lock');
    const holder = new Client({ connectionString: activeConnectionString as string });
    await holder.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(`select 1 from pilot.drill_library where organization_id = $1 and drill_id = 'ref-spar' for update`, [gym.organizationId]);
      const { rows } = await holder.query<{ pid: number }>('select pg_backend_pid() as pid');
      const copying = edit(gym, scriptId, { add: [{ ref: 'c', kind: 'copy', block_id: spar, ...place }] }).then(
        (value) => ({ status: 'fulfilled' as const, value }),
        (reason: unknown) => ({ status: 'rejected' as const, reason }),
      );
      const deadline = Date.now() + 30_000;
      for (;;) {
        const blocked = await client.query(`select 1 from pg_stat_activity where $1 = any(pg_blocking_pids(pid))`, [rows[0].pid]);
        if ((blocked.rowCount ?? 0) > 0 || Date.now() > deadline) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      await holder.query(`select 1 from pilot.session_scripts where organization_id = $1 and script_id = $2 for update`, [gym.organizationId, scriptId]);
      await holder.query('COMMIT');
      expect((await copying).status).toBe('fulfilled');
    } finally {
      await holder.end();
    }
  });
});
