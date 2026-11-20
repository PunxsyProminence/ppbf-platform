// A coach edits a library drill in the app (OD-2026-11-19-005, OW25-51), against
// a real database: the edit is the drill's next version and never an in-place
// change (OD-2026-11-15-011 ruling 3), the old version keeps its content and
// stays readable, only the edited parts lose their AI-draft label and record
// who edited them (ruling 2), field_provenance and authoring_state stay, the
// cue rule holds both ways (OD-2026-10-06-026 ruling 2), a stale or foreign
// drill is refused, and a refused edit writes nothing.
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

import { Client } from 'pg';

let activeClient: Client | null = null;
let activeConnectionString: string | null = null;

// withTransaction opens its own connection, as db.ts's pool does, so a refused
// edit's ROLLBACK is a real one.
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
    return (await activeClient.query(text, params)).rows;
  }),
  queryOne: jest.fn(async (text: string, params: unknown[] = []) => {
    if (!activeClient) throw new Error('test bug: no active embedded client');
    return (await activeClient.query(text, params)).rows[0] ?? null;
  }),
}));

import { MINT } from './contentImport/ids';
import { editLibraryDrill, parseDrillLibraryEdit } from './drillLibraryEdit';
import { getDrillWithDetail } from './drillLibraryV3';

jest.setTimeout(240_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-drill-library-edit-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const FULL_SCHEMA_HELPER_PATH = path.resolve(__dirname, '../../../scripts/lib/full-schema.mjs');
const DATABASE_NAME = 'ppbf_test_drill_library_edit';

const COACH = 'acct-ed-coach';
const DRAFT = 'AI draft, lane test, 2026-11-19';
const LONG_ROAD = 'Long Road practice';
const LITERATURE_DRAFT = 'LITERATURE-GROUNDED DRAFT — generated from cited registry claims; REQUIRES FLOOR VALIDATION';

const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
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

/** A fresh gym with a boxing and a conditioning discipline. */
async function newGym(): Promise<string> {
  gymCount += 1;
  const organizationId = `org-ed-${gymCount}`;
  await client.query(
    `insert into pilot.organizations (organization_id, organization_name, status) values ($1, $1, 'active')`,
    [organizationId],
  );
  await client.query(
    `insert into pilot.disciplines (organization_id, discipline, display_name, lane, exposure_model)
     values ($1, 'boxing', 'Boxing', 'striking', 'head_impact'),
            ($1, 'conditioning', 'Conditioning', 'non_contact', 'none')`,
    [organizationId],
  );
  return organizationId;
}

/**
 * One drill as an import would leave it: v1 with two scale levels, two stop
 * rules, the given cues, a transfer claim, and a label row whose purpose,
 * execution, scale levels and stop rules are AI drafts.
 */
async function seedDrill(organizationId: string, opts: { drillId: string; name: string; discipline?: string; cues?: string[]; provenance?: string; labels?: boolean }) {
  const { drillId } = opts;
  await client.query(
    `insert into pilot.drill_library
       (organization_id, drill_id, lineage_id, version, name, discipline, category, difficulty,
        target_behavior, purpose, standard_setup, execution, what_good_looks_like, what_bad_looks_like,
        common_errors, corrections, equipment_needed, grounding_claim_ids, field_provenance, created_by_account_id, created_by_role)
     values ($1,$2,$2,1,$3,$4,'footwork','intermediate','Target.','Old purpose.','Setup.','Old execution.',
             'Good.','Bad.','Errors.','Corrections.','Gloves',array['A1-001'],$5,'acct-import','organization_admin')`,
    [organizationId, drillId, opts.name, opts.discipline ?? 'boxing', opts.provenance ?? LONG_ROAD],
  );
  for (const [level, start] of [['A', false], ['B', true]] as const) {
    await client.query(
      `insert into pilot.drill_scale_levels
         (organization_id, scale_id, drill_id, scale_level, is_starting_point, demand_description, authoring_state)
       values ($1,$2,$3,$4,$5,$6,'literature_grounded_draft')`,
      [organizationId, MINT.scale(drillId, level), drillId, level, start, `Level ${level} demand.`],
    );
  }
  for (const ordinal of [1, 2]) {
    await client.query(
      `insert into pilot.drill_stop_rules (organization_id, stop_rule_id, drill_id, ordinal, condition_text, rule_kind)
       values ($1,$2,$3,$4,$5,'fatigue')`,
      [organizationId, MINT.stopRule(drillId, String(ordinal)), drillId, ordinal, `Stop when ${ordinal}.`],
    );
  }
  for (const cue of opts.cues ?? ['Eyes up']) {
    await client.query(
      `insert into pilot.drill_cues (organization_id, cue_id, drill_id, cue_text, cue_family, focus_type)
       values ($1,$2,$3,$4,'stance','external')`,
      [organizationId, MINT.cue(drillId, cue), drillId, cue],
    );
  }
  await client.query(
    `insert into pilot.transfer_claims (organization_id, transfer_id, drill_id, claim_kind, statement)
     values ($1,$2,$3,'cognitive_demand','Reads a moving target.')`,
    [organizationId, MINT.transfer(drillId, 'cognitive_demand', 'Reads a moving target.'), drillId],
  );
  if (opts.labels === false) return;
  const drafted = { status: 'INFERRED', draft: DRAFT, sources: ['DOC-1'] };
  await client.query(
    `insert into pilot.content_record_labels
       (organization_id, target_kind, target_lineage_id, target_version, field_labels, evidence, import_id,
        recorded_by_account_id, recorded_by_role)
     values ($1,'drill',$2,1,$3::jsonb,$4::jsonb,'imp-1','acct-import','organization_admin')`,
    [organizationId, drillId, JSON.stringify({
      purpose: drafted,
      execution: drafted,
      cues: { status: 'OBSERVED', sources: ['DOC-1'] },
      scale_levels: { ...drafted, A: { status: 'INFERRED', sources: ['DOC-1'] }, B: { status: 'INFERRED', sources: ['DOC-1'] } },
      stop_rules: { ...drafted, 1: { status: 'INFERRED', sources: ['DOC-1'] } },
    }), JSON.stringify({ category: 'test' })],
  );
}

async function edit(organizationId: string, body: Record<string, unknown>) {
  return editLibraryDrill({ organizationId, request: parseDrillLibraryEdit(body), actorAccountId: COACH, actorRole: 'coach' });
}

async function versionsOf(organizationId: string, lineageId: string) {
  return (await client.query(
    `select * from pilot.drill_library where organization_id = $1 and lineage_id = $2 order by version`,
    [organizationId, lineageId],
  )).rows;
}

async function labelsOf(organizationId: string, lineageId: string, version: number) {
  return (await client.query(
    `select * from pilot.content_record_labels
      where organization_id = $1 and target_kind = 'drill' and target_lineage_id = $2 and target_version = $3`,
    [organizationId, lineageId, version],
  )).rows[0];
}

async function rejection(promise: Promise<unknown>): Promise<{ status?: number; code?: string; message: string }> {
  try {
    await promise;
  } catch (error) {
    const e = error as { status?: number; code?: string; message: string };
    return { status: e.status, code: e.code, message: e.message };
  }
  throw new Error('expected a rejection');
}

beforeAll(async () => {
  PG_PORT = await findFreePort();
  serverProcess = spawn(process.execPath, [SERVER_SCRIPT_PATH, DATA_DIR, String(PG_PORT)], { stdio: ['ignore', 'pipe', 'pipe'] });
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

  const helper = await nativeDynamicImport(pathToFileURL(FULL_SCHEMA_HELPER_PATH).href);
  const applyFullSchema = helper.applyFullSchema as (c: Client, opts?: { infraDir?: string }) => Promise<unknown>;
  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  await admin.query(`drop database if exists ${DATABASE_NAME}`);
  await admin.query(`create database ${DATABASE_NAME}`);
  await admin.end();
  client = new Client({ connectionString: connectionStringFor(DATABASE_NAME) });
  await client.connect();
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
  await fs.rm(DATA_DIR, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }).catch(() => {});
});

describe('editing a library drill', () => {
  it('writes the next version, keeps the old one, and relabels only what changed', async () => {
    const org = await newGym();
    await seedDrill(org, { drillId: 'drl_edit_one', name: 'Edit One', provenance: LITERATURE_DRAFT });

    const result = await edit(org, {
      drill_id: 'drl_edit_one',
      purpose: 'Coach purpose.',
      execution: 'Old execution.', // resent unchanged: not an edit
      scale_levels: { B: { demand_description: 'Coach B demand.' }, A: { demand_description: 'Level A demand.' } },
      stop_rules: [{ ordinal: 2, condition_text: 'Coach stop.' }],
    });

    const newId = MINT.drillVersion('drl_edit_one', 2);
    expect(result).toEqual({
      changed: true,
      drill_id: newId,
      lineage_id: 'drl_edit_one',
      version: 2,
      previous_drill_id: 'drl_edit_one',
      edited: ['purpose', 'scale_levels.B', 'stop_rules.2'],
    });

    const [v1, v2] = await versionsOf(org, 'drl_edit_one');
    // The old version: content untouched, superseded, still active for gyms that pinned it.
    expect(v1.purpose).toBe('Old purpose.');
    expect(v1.superseded_at).not.toBeNull();
    expect(v1.active).toBe(true);
    // The new version: the edit laid over a copy of everything else.
    expect(v2).toMatchObject({
      drill_id: newId, version: 2, supersedes_drill_id: 'drl_edit_one', superseded_at: null, active: true,
      purpose: 'Coach purpose.', execution: 'Old execution.', name: 'Edit One', equipment_needed: 'Gloves',
      grounding_claim_ids: ['A1-001'], field_provenance: LITERATURE_DRAFT,
      created_by_account_id: COACH, created_by_role: 'coach',
    });

    const scales = (await client.query(
      `select * from pilot.drill_scale_levels where organization_id = $1 and drill_id = $2 order by scale_level`, [org, newId],
    )).rows;
    expect(scales.map((row) => [row.scale_id, row.demand_description, row.authoring_state, row.is_starting_point])).toEqual([
      [MINT.scale(newId, 'A'), 'Level A demand.', 'literature_grounded_draft', false],
      [MINT.scale(newId, 'B'), 'Coach B demand.', 'literature_grounded_draft', true],
    ]);
    const stops = (await client.query(
      `select * from pilot.drill_stop_rules where organization_id = $1 and drill_id = $2 order by ordinal`, [org, newId],
    )).rows;
    expect(stops.map((row) => row.condition_text)).toEqual(['Stop when 1.', 'Coach stop.']);
    const cues = (await client.query(`select * from pilot.drill_cues where organization_id = $1 and drill_id = $2`, [org, newId])).rows;
    expect(cues.map((row) => [row.cue_id, row.cue_text, row.cue_family])).toEqual([[MINT.cue(newId, 'Eyes up'), 'Eyes up', 'stance']]);
    const transfers = (await client.query(`select count(*)::int as n from pilot.transfer_claims where organization_id = $1 and drill_id = $2`, [org, newId])).rows;
    expect(transfers[0].n).toBe(1);
    // The old version keeps its own children.
    const oldScale = (await client.query(
      `select demand_description from pilot.drill_scale_levels where organization_id = $1 and drill_id = 'drl_edit_one' and scale_level = 'B'`, [org],
    )).rows[0];
    expect(oldScale.demand_description).toBe('Level B demand.');

    // Labels: the edited parts are REPORTED with the editor and no draft marker;
    // everything untouched keeps its label, AI draft included.
    const labels = await labelsOf(org, 'drl_edit_one', 2);
    const fieldLabels = labels.field_labels;
    const editedLabel = {
      status: 'REPORTED',
      sources: ['In-app edit'],
      edited: { by_account_id: COACH, by_role: 'coach', at: expect.any(String) },
    };
    expect(fieldLabels.purpose).toEqual(editedLabel);
    expect(fieldLabels.execution).toEqual({ status: 'INFERRED', draft: DRAFT, sources: ['DOC-1'] });
    expect(fieldLabels.scale_levels.B).toEqual(editedLabel);
    expect(fieldLabels.scale_levels.A).toEqual({ status: 'INFERRED', sources: ['DOC-1'] });
    expect(fieldLabels.scale_levels.draft).toBe(DRAFT);
    expect(fieldLabels.stop_rules['2']).toEqual(editedLabel);
    expect(fieldLabels.stop_rules['1']).toEqual({ status: 'INFERRED', sources: ['DOC-1'] });
    expect(labels.evidence).toEqual({ category: 'test' });
    expect(labels.recorded_by_account_id).toBe(COACH);
    expect(labels.import_id).toMatch(/^in-app-edit:/);
    // The old version's labels are untouched (the table is append-only anyway).
    expect((await labelsOf(org, 'drl_edit_one', 1)).field_labels.purpose.draft).toBe(DRAFT);

    const audit = (await client.query(
      `select * from pilot.audit_events where organization_id = $1 and entity_type = 'drill_library' and entity_id = $2`, [org, newId],
    )).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ event_type: 'update', actor_account_id: COACH, actor_role: 'coach' });
    expect(audit[0].details).toMatchObject({ action: 'in_app_edit', from_drill_id: 'drl_edit_one', version: 2 });

    // The old version is still readable as it was.
    const oldDetail = await getDrillWithDetail(org, 'drl_edit_one');
    expect(oldDetail?.purpose).toBe('Old purpose.');
    const newDetail = await getDrillWithDetail(org, newId);
    expect(newDetail?.purpose).toBe('Coach purpose.');
  });

  it('writes nothing when nothing really changes', async () => {
    const org = await newGym();
    await seedDrill(org, { drillId: 'drl_same', name: 'Same' });
    const result = await edit(org, { drill_id: 'drl_same', purpose: 'Old purpose.', cues: ['Eyes up'] });
    expect(result).toMatchObject({ changed: false, drill_id: 'drl_same', version: 1, edited: [] });
    expect(await versionsOf(org, 'drl_same')).toHaveLength(1);
  });

  it('refuses a version that is no longer the current one', async () => {
    const org = await newGym();
    await seedDrill(org, { drillId: 'drl_stale', name: 'Stale' });
    await edit(org, { drill_id: 'drl_stale', purpose: 'First.' });
    const refused = await rejection(edit(org, { drill_id: 'drl_stale', purpose: 'Second.' }));
    expect(refused).toMatchObject({ status: 409, code: 'DRILL_VERSION_STALE' });
    expect(await versionsOf(org, 'drl_stale')).toHaveLength(2);
  });

  it("reads another gym's drill as not found and leaves it alone", async () => {
    const orgA = await newGym();
    const orgB = await newGym();
    await seedDrill(orgB, { drillId: 'drl_other_gym', name: 'Other Gym' });
    const refused = await rejection(edit(orgA, { drill_id: 'drl_other_gym', purpose: 'Not yours.' }));
    expect(refused).toMatchObject({ status: 404 });
    expect(await versionsOf(orgB, 'drl_other_gym')).toHaveLength(1);
  });

  describe('the cue rule', () => {
    it('refuses an edit that leaves a technique drill without a cue, and writes nothing', async () => {
      const org = await newGym();
      await seedDrill(org, { drillId: 'drl_cue_tech', name: 'Cue Tech' });
      const refused = await rejection(edit(org, { drill_id: 'drl_cue_tech', cues: [' ', ''], purpose: 'Changed.' }));
      expect(refused).toMatchObject({ status: 409, code: 'DRILL_CUE_REQUIRED' });
      expect(await versionsOf(org, 'drl_cue_tech')).toHaveLength(1);
    });

    it('lets a conditioning drill go without a cue', async () => {
      const org = await newGym();
      await seedDrill(org, { drillId: 'drl_cue_cond', name: 'Cue Cond', discipline: 'conditioning' });
      const result = await edit(org, { drill_id: 'drl_cue_cond', cues: [] });
      expect(result).toMatchObject({ changed: true, edited: ['cues'] });
      const cues = (await client.query(`select * from pilot.drill_cues where organization_id = $1 and drill_id = $2`, [org, result.drill_id])).rows;
      expect(cues).toHaveLength(0);
    });

    it('does not judge a cue-less technique drill on an edit that leaves the cues alone', async () => {
      const org = await newGym();
      await seedDrill(org, { drillId: 'drl_cue_none', name: 'Cue None', cues: [] });
      const result = await edit(org, { drill_id: 'drl_cue_none', purpose: 'Changed.' });
      expect(result).toMatchObject({ changed: true, edited: ['purpose'] });
    });

    it('keeps a kept cue as it was and gives a new cue the table defaults', async () => {
      const org = await newGym();
      await seedDrill(org, { drillId: 'drl_cue_new', name: 'Cue New', cues: ['Eyes up', 'Chin down'] });
      const result = await edit(org, { drill_id: 'drl_cue_new', cues: ['Eyes up', 'Breathe out'] });
      const cues = (await client.query(
        `select cue_text, cue_family, focus_type from pilot.drill_cues where organization_id = $1 and drill_id = $2 order by cue_text`,
        [org, result.drill_id],
      )).rows;
      expect(cues).toEqual([
        { cue_text: 'Breathe out', cue_family: '', focus_type: 'unspecified' },
        { cue_text: 'Eyes up', cue_family: 'stance', focus_type: 'external' },
      ]);
      expect((await labelsOf(org, 'drl_cue_new', 2)).field_labels.cues.status).toBe('REPORTED');
    });
  });

  it("refuses a value outside the importer's lists, and writes nothing", async () => {
    const org = await newGym();
    await seedDrill(org, { drillId: 'drl_bad_value', name: 'Bad Value' });
    for (const body of [
      { contact_level: 'full_contact' },
      // drill_scale_levels.contact_level has no CHECK: the list is the only guard.
      { scale_levels: { B: { contact_level: 'light-technical' } } },
      { stop_rules: [{ ordinal: 1, rule_kind: 'tired' }] },
      { difficulty: 'expert' },
    ]) {
      const refused = await rejection(edit(org, { drill_id: 'drl_bad_value', ...body }));
      expect(refused).toMatchObject({ status: 400, code: 'VALUE_NOT_ALLOWED' });
    }
    expect(await versionsOf(org, 'drl_bad_value')).toHaveLength(1);
  });

  it("refuses lowering a drill's contact below a current template step that runs it, and allows raising it", async () => {
    const org = await newGym();
    await seedDrill(org, { drillId: 'drl_contact', name: 'Contact' });
    await client.query(`update pilot.drill_library set contact_level = 'controlled_sparring' where organization_id = $1 and drill_id = 'drl_contact'`, [org]);
    await client.query(
      `insert into pilot.workout_templates (organization_id, template_id, lineage_id, version, name, session_type, intent, duration_minutes)
       values ($1, 'wtp_contact', 'wtp_contact', 1, 'Contact Night', 'technical', 'Spar.', 60)`,
      [org],
    );
    await client.query(
      `insert into pilot.workout_template_items (organization_id, item_id, template_id, ordinal, block, drill_id, contact_level)
       values ($1, 'wti_contact', 'wtp_contact', 1, 'main', 'drl_contact', 'controlled_sparring')`,
      [org],
    );
    const refused = await rejection(edit(org, { drill_id: 'drl_contact', contact_level: 'light_technical' }));
    expect(refused).toMatchObject({ status: 409, code: 'DRILL_CONTACT_BELOW_STEPS' });
    expect(refused.message).toContain('template wtp_contact step 1 (controlled_sparring)');
    expect(await versionsOf(org, 'drl_contact')).toHaveLength(1);

    const raised = await edit(org, { drill_id: 'drl_contact', contact_level: 'open_sparring' });
    expect(raised).toMatchObject({ changed: true, edited: ['contact_level'] });
  });

  it('chains edits: the next edit names the new version and writes v3', async () => {
    const org = await newGym();
    await seedDrill(org, { drillId: 'drl_chain', name: 'Chain' });
    const first = await edit(org, { drill_id: 'drl_chain', purpose: 'Second.' });
    const second = await edit(org, { drill_id: first.drill_id, execution: 'Third.' });
    expect(second).toMatchObject({ version: 3, drill_id: MINT.drillVersion('drl_chain', 3), previous_drill_id: first.drill_id });
    const versions = await versionsOf(org, 'drl_chain');
    expect(versions.map((row) => [row.version, row.purpose, row.execution, row.superseded_at === null])).toEqual([
      [1, 'Old purpose.', 'Old execution.', false],
      [2, 'Second.', 'Old execution.', false],
      [3, 'Second.', 'Third.', true],
    ]);
    const labels = (await labelsOf(org, 'drl_chain', 3)).field_labels;
    expect(labels.purpose.status).toBe('REPORTED');
    expect(labels.execution.status).toBe('REPORTED');
  });

  it('treats line endings, Unicode form and cue order a client resends as no change', async () => {
    const org = await newGym();
    await seedDrill(org, { drillId: 'drl_resend', name: 'Resend', cues: ['Eyes up', 'Chin down'] });
    await client.query(`update pilot.drill_library set corrections = E'Line one.\\nLine two.' where organization_id = $1 and drill_id = 'drl_resend'`, [org]);
    const result = await edit(org, {
      drill_id: 'drl_resend',
      corrections: 'Line one.\r\nLine two.  ',
      cues: ['Chin down', 'Eyes up', 'Eyes up '],
      name: 'Resend'.normalize('NFD'),
    });
    expect(result).toMatchObject({ changed: false, edited: [] });
  });

  it("relabels an edited rule kind under the rule kinds' own label, and clears a group's draft once every part is edited", async () => {
    const org = await newGym();
    await seedDrill(org, { drillId: 'drl_groups', name: 'Groups' });
    const result = await edit(org, {
      drill_id: 'drl_groups',
      stop_rules: [{ ordinal: 1, rule_kind: 'safety' }],
      scale_levels: { A: { demand_description: 'Coach A.' }, B: { demand_description: 'Coach B.' } },
    });
    expect(result.edited).toEqual(['scale_levels.A', 'scale_levels.B', 'stop_rules.1']);
    const labels = (await labelsOf(org, 'drl_groups', 2)).field_labels;
    expect(labels['stop_rules.rule_kind']['1']).toMatchObject({ status: 'REPORTED' });
    // Stop rule 2 was not edited: the group keeps its draft label.
    expect(labels.stop_rules.draft).toBe(DRAFT);
    // Both scale levels the drill has were edited: the group no longer reads as a draft.
    expect(labels.scale_levels).not.toHaveProperty('draft');
    expect(labels.scale_levels).toMatchObject({ status: 'REPORTED', sources: ['In-app edit'], A: { status: 'REPORTED' }, B: { status: 'REPORTED' } });
  });

  it('refuses a name another current drill of the discipline holds', async () => {
    const org = await newGym();
    await seedDrill(org, { drillId: 'drl_name_a', name: 'Name A' });
    await seedDrill(org, { drillId: 'drl_name_b', name: 'Name B' });
    const refused = await rejection(edit(org, { drill_id: 'drl_name_b', name: 'Name A' }));
    expect(refused).toMatchObject({ status: 409, code: 'DRILL_NAME_TAKEN' });
  });

  it('refuses a scale level or stop rule the drill does not have', async () => {
    const org = await newGym();
    await seedDrill(org, { drillId: 'drl_missing_part', name: 'Missing Part' });
    expect(await rejection(edit(org, { drill_id: 'drl_missing_part', scale_levels: { C: { demand_description: 'C.' } } })))
      .toMatchObject({ status: 400 });
    expect(await rejection(edit(org, { drill_id: 'drl_missing_part', stop_rules: [{ ordinal: 9, condition_text: 'X.' }] })))
      .toMatchObject({ status: 400 });
    expect(await versionsOf(org, 'drl_missing_part')).toHaveLength(1);
  });

  it('writes a label row holding only the edit when the version had none', async () => {
    const org = await newGym();
    await seedDrill(org, { drillId: 'drl_unlabelled', name: 'Unlabelled', labels: false });
    const result = await edit(org, { drill_id: 'drl_unlabelled', corrections: 'Coach corrections.' });
    const labels = await labelsOf(org, 'drl_unlabelled', result.version);
    expect(labels.field_labels).toEqual({ corrections: expect.objectContaining({ status: 'REPORTED' }) });
    expect(labels.evidence).toBeNull();
  });

  // Lane NW-b (PK-197 A): a coach can fill the two fields the frozen Backbone often left empty.
  it('lets a coach write the exit condition and correction path as the next version, each labelled REPORTED', async () => {
    const org = await newGym();
    await seedDrill(org, { drillId: 'drl_exit_path', name: 'Exit Path' });
    const result = await edit(org, {
      drill_id: 'drl_exit_path',
      exit_condition: 'Three clean rounds.',
      correction_path: 'Reset the stance.\nShorten the step.',
    });
    expect(result).toMatchObject({ changed: true, version: 2 });
    expect([...result.edited].sort()).toEqual(['correction_path', 'exit_condition']);
    const head = (await client.query(
      `select exit_condition, correction_path from pilot.drill_library where organization_id = $1 and lineage_id = 'drl_exit_path' and superseded_at is null`,
      [org],
    )).rows[0];
    expect(head).toEqual({ exit_condition: 'Three clean rounds.', correction_path: 'Reset the stance.\nShorten the step.' });
    const labels = (await labelsOf(org, 'drl_exit_path', 2)).field_labels;
    expect(labels.exit_condition).toMatchObject({ status: 'REPORTED', sources: ['In-app edit'] });
    expect(labels.correction_path).toMatchObject({ status: 'REPORTED', sources: ['In-app edit'] });
  });

  it('carries a written exit condition and correction path into the next version when another field is edited', async () => {
    const org = await newGym();
    await seedDrill(org, { drillId: 'drl_exit_keep', name: 'Exit Keep' });
    await client.query(
      `update pilot.drill_library set exit_condition = 'Clean twice.', correction_path = 'Slow down.' where organization_id = $1 and drill_id = 'drl_exit_keep'`,
      [org],
    );
    const result = await edit(org, { drill_id: 'drl_exit_keep', purpose: 'A coach purpose.' });
    expect(result.edited).toEqual(['purpose']);
    const rows = (await client.query(
      `select version, exit_condition, correction_path from pilot.drill_library where organization_id = $1 and lineage_id = 'drl_exit_keep' order by version`,
      [org],
    )).rows;
    expect(rows).toEqual([
      { version: 1, exit_condition: 'Clean twice.', correction_path: 'Slow down.' },
      { version: 2, exit_condition: 'Clean twice.', correction_path: 'Slow down.' },
    ]);
  });
});

// "LOOKS RIGHT" (OD-2026-11-19-007, OW25-55; lane ED-UI PR4, Q1 = A, Q2 = A, Q3 = A).
describe('"Looks right": a coach confirms one drafted field as it stands', () => {
  it('writes the next version with the same text; the label keeps its sources, loses its draft and records the coach; one audit row', async () => {
    const org = await newGym();
    await seedDrill(org, { drillId: 'drl_lr_one', name: 'Looks Right One' });
    const result = await edit(org, { drill_id: 'drl_lr_one', looks_right: 'purpose' });
    expect(result).toMatchObject({ changed: true, version: 2, previous_drill_id: 'drl_lr_one', edited: [], looks_right: 'purpose' });

    const [v1, v2] = await versionsOf(org, 'drl_lr_one');
    expect(v1.superseded_at).not.toBeNull();
    expect(v2.purpose).toBe(v1.purpose);
    expect(v2.execution).toBe(v1.execution);
    expect(v2.created_by_account_id).toBe(COACH);

    const labels = await labelsOf(org, 'drl_lr_one', 2);
    expect(labels.field_labels.purpose).toEqual({
      status: 'INFERRED', sources: ['DOC-1'], looks_right: { by_account_id: COACH, by_role: 'coach', at: expect.any(String) },
    });
    // Nothing else changes: the other drafts stay drafts, the evidence is carried.
    expect(labels.field_labels.execution.draft).toBe(DRAFT);
    expect(labels.field_labels.scale_levels.draft).toBe(DRAFT);
    expect(labels.evidence).toEqual({ category: 'test' });
    expect(labels.import_id).toMatch(/^looks-right:/);
    expect((await labelsOf(org, 'drl_lr_one', 1)).field_labels.purpose.draft).toBe(DRAFT);

    const audit = (await client.query(
      `select * from pilot.audit_events where organization_id = $1 and entity_type = 'drill_library' and entity_id = $2`, [org, result.drill_id],
    )).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0].details).toMatchObject({ action: 'in_app_edit', looks_right: 'purpose', edited: [], from_drill_id: 'drl_lr_one', version: 2 });
  });

  it('refuses a field that is not a draft on the current version (409 FIELD_NOT_DRAFT), and writes nothing', async () => {
    const org = await newGym();
    await seedDrill(org, { drillId: 'drl_lr_twice', name: 'Looks Right Twice' });
    const first = await edit(org, { drill_id: 'drl_lr_twice', looks_right: 'purpose' });
    // Pressed again on the new version; a field labelled and not a draft; a field with no label.
    for (const looks_right of ['purpose', 'cues', 'transfer']) {
      expect(await rejection(edit(org, { drill_id: first.drill_id, looks_right })))
        .toMatchObject({ status: 409, code: 'FIELD_NOT_DRAFT' });
    }
    // An older version is refused as stale before anything is read.
    expect(await rejection(edit(org, { drill_id: 'drl_lr_twice', looks_right: 'execution' }))).toMatchObject({ status: 409, code: 'DRILL_VERSION_STALE' });
    expect(await versionsOf(org, 'drl_lr_twice')).toHaveLength(2);
  });

  it('refuses a version with no label row at all: nothing there is labelled a draft', async () => {
    const org = await newGym();
    await seedDrill(org, { drillId: 'drl_lr_unlabelled', name: 'Looks Right Unlabelled', labels: false });
    expect(await rejection(edit(org, { drill_id: 'drl_lr_unlabelled', looks_right: 'purpose' })))
      .toMatchObject({ status: 409, code: 'FIELD_NOT_DRAFT' });
    expect(await versionsOf(org, 'drl_lr_unlabelled')).toHaveLength(1);
  });

  it('confirms one scale level on its own label, and the stop-rule list with its rules and kinds as one', async () => {
    const org = await newGym();
    await seedDrill(org, { drillId: 'drl_lr_parts', name: 'Looks Right Parts' });
    const level = await edit(org, { drill_id: 'drl_lr_parts', looks_right: 'scale_levels.B' });
    expect(level.looks_right).toBe('scale_levels.B');
    const afterLevel = (await labelsOf(org, 'drl_lr_parts', 2)).field_labels;
    expect(afterLevel.scale_levels.B).toEqual({
      status: 'INFERRED', sources: ['DOC-1'], looks_right: { by_account_id: COACH, by_role: 'coach', at: expect.any(String) },
    });
    // The group still speaks for the level nobody confirmed.
    expect(afterLevel.scale_levels.draft).toBe(DRAFT);
    expect(afterLevel.scale_levels.A).toEqual({ status: 'INFERRED', sources: ['DOC-1'] });

    const list = await edit(org, { drill_id: level.drill_id, looks_right: 'stop_rules' });
    const afterList = (await labelsOf(org, 'drl_lr_parts', list.version)).field_labels;
    expect(afterList.stop_rules).not.toHaveProperty('draft');
    expect(afterList.stop_rules.looks_right).toMatchObject({ by_account_id: COACH });
    expect(afterList.stop_rules['1']).toEqual({ status: 'INFERRED', sources: ['DOC-1'] });

    expect(await rejection(edit(org, { drill_id: list.drill_id, looks_right: 'scale_levels.C' }))).toMatchObject({ status: 400 });
  });
});

describe('parseDrillLibraryEdit', () => {
  it('refuses an unknown field and a never-editable field by name', () => {
    expect(() => parseDrillLibraryEdit({ drill_id: 'x', colour: 'red' })).toThrow('Unsupported field: colour');
    for (const key of ['field_provenance', 'discipline', 'active', 'version', 'content_class']) {
      expect(() => parseDrillLibraryEdit({ drill_id: 'x', [key]: 'y' })).toThrow(`Unsupported field: ${key} is not editable`);
    }
    expect(() => parseDrillLibraryEdit({ drill_id: 'x', scale_levels: { B: { authoring_state: 'authored' } } }))
      .toThrow('Unsupported field: scale_levels.B.authoring_state');
  });

  it('bounds text and keeps the name from going blank', () => {
    expect(() => parseDrillLibraryEdit({ drill_id: 'x', name: '  ' })).toThrow('Missing name');
    expect(() => parseDrillLibraryEdit({ drill_id: 'x', purpose: 'p'.repeat(4001) })).toThrow('at most 4000');
    expect(parseDrillLibraryEdit({ drill_id: 'x', common_errors: '' }).fields.common_errors).toBe('');
    expect(() => parseDrillLibraryEdit({ drill_id: 'x', cues: Array.from({ length: 13 }, (_, i) => `cue ${i}`) })).toThrow('at most 12');
    expect(() => parseDrillLibraryEdit({ purpose: 'x' })).toThrow('Missing drill_id');
  });
});
