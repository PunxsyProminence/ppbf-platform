// A coach edits a workout template and its items in the app (OD-2026-11-19-005,
// OW25-51), against a real database: the edit is the template's next version
// and never an in-place change, the old version and its items stay readable, a
// workout already issued is untouched and the next issue takes the new version,
// only edited fields lose their AI-draft label and record who edited them
// (OD-2026-11-15-011 ruling 2), the importer's item rules hold, and a refused
// edit writes nothing.
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
import { versionId } from './contentImport/datasets/templateScriptVersions';
import { editWorkoutTemplate, parseWorkoutTemplateEdit } from './workoutTemplateEdit';
import { getWorkoutTemplateWithItems, issueOrder, issueWorkoutTemplate } from './workoutTemplates';

jest.setTimeout(240_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-workout-template-edit-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const FULL_SCHEMA_HELPER_PATH = path.resolve(__dirname, '../../../scripts/lib/full-schema.mjs');
const DATABASE_NAME = 'ppbf_test_workout_template_edit';

const COACH = 'acct-ed-coach';
const DRAFT = 'AI draft, lane test, 2026-11-19';
const ATHLETE_ID = 'ath-ed-1';

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
/** A fresh gym: organization, boxing, a coach account and one athlete. */
async function newGym(): Promise<string> {
  gymCount += 1;
  const organizationId = `org-edt-${gymCount}`;
  await client.query(
    `insert into pilot.organizations (organization_id, organization_name, status) values ($1, $1, 'active')`,
    [organizationId],
  );
  await client.query(
    `insert into pilot.disciplines (organization_id, discipline, display_name, lane, exposure_model)
     values ($1, 'boxing', 'Boxing', 'striking', 'head_impact')`,
    [organizationId],
  );
  await client.query(`insert into pilot.accounts (account_id, role, organization_id) values ($1, 'coach', $2)`, [
    `${COACH}@${organizationId}`,
    organizationId,
  ]);
  await client.query(
    `insert into pilot.athletes
       (organization_id, athlete_id, full_name, dob, weight_class, gym_status, emergency_contact, active_flag, coach_id, created_at, updated_at)
     values ($1, $2, 'Template Athlete', '2012-01-01', '100', 'active', 'contact', true, $3, now(), now())`,
    [organizationId, ATHLETE_ID, `${COACH}@${organizationId}`],
  );
  return organizationId;
}

/** One reference drill that passes adoption readiness (scale levels, a stop rule, a cue). */
async function seedDrill(
  organizationId: string,
  drillId: string,
  name: string,
  opts: { contact?: string; lineage?: string; version?: number; active?: boolean } = {},
) {
  // A later version supersedes the lineage's current one first (one head per lineage).
  if (opts.lineage) {
    await client.query(
      `update pilot.drill_library set superseded_at = now() where organization_id = $1 and lineage_id = $2 and superseded_at is null`,
      [organizationId, opts.lineage],
    );
  }
  await client.query(
    `insert into pilot.drill_library
       (organization_id, drill_id, lineage_id, version, name, discipline, category, difficulty,
        target_behavior, purpose, standard_setup, execution, what_good_looks_like, what_bad_looks_like,
        contact_level, active)
     values ($1,$2,$3,$4,$5,'boxing','footwork','advanced', $5 || ' target.', $5 || ' purpose.',
             $5 || ' setup.', $5 || ' execution.', $5 || ' good.', $5 || ' bad.', $6, $7)`,
    [organizationId, drillId, opts.lineage ?? drillId, opts.version ?? 1, name, opts.contact ?? 'none', opts.active ?? true],
  );
  await client.query(
    `insert into pilot.drill_scale_levels
       (organization_id, scale_id, drill_id, scale_level, is_starting_point, demand_description, contact_level, authoring_state)
     values ($1, $2 || '-a', $2, 'A', false, 'easier', 'none', 'authored'),
            ($1, $2 || '-b', $2, 'B', true, 'standard', 'none', 'authored'),
            ($1, $2 || '-c', $2, 'C', false, 'harder', 'none', 'authored')`,
    [organizationId, drillId],
  );
  await client.query(
    `insert into pilot.drill_stop_rules (organization_id, stop_rule_id, drill_id, ordinal, condition_text, scope, rule_kind)
     values ($1, $2 || '-stop-1', $2, 1, 'Stop when the guard drops.', 'universal', 'safety')`,
    [organizationId, drillId],
  );
  await client.query(
    `insert into pilot.drill_cues (organization_id, cue_id, drill_id, cue_text, cue_family, focus_type)
     values ($1, $2 || '-cue-1', $2, $3 || ' cue', 'guard', 'external')`,
    [organizationId, drillId, name],
  );
}

/**
 * v1 of a template as an import leaves it: a step in words, a drill step and a
 * step held only in details, and a label row whose session_type, intent,
 * difficulty and duration are AI drafts.
 */
async function seedTemplate(organizationId: string, templateId: string, name: string, drillId: string) {
  await client.query(
    `insert into pilot.workout_templates
       (organization_id, template_id, lineage_id, version, name, session_type, difficulty, age_band, duration_minutes, intent, coach_notes)
     values ($1,$2,$2,1,$3,'technical','intermediate','any',45,'Old intent.','Old notes.')`,
    [organizationId, templateId, name],
  );
  const items = [
    { ordinal: 1, block: 'warmup', drill: null, words: 'Skip rope', details: '{}', minutes: 5 },
    { ordinal: 2, block: 'technical', drill: drillId, words: null, details: '{}', minutes: 10 },
    { ordinal: 3, block: 'cooldown', drill: null, words: null, details: '{"parts":["Breathe","Stretch"]}', minutes: null },
  ];
  for (const item of items) {
    await client.query(
      `insert into pilot.workout_template_items
         (organization_id, item_id, template_id, ordinal, block, drill_id, free_text_drill, scale_level, duration_minutes, contact_level, details)
       values ($1,$2,$3,$4,$5,$6,$7,'B',$8,'none',$9::jsonb)`,
      [organizationId, MINT.templateItem(templateId, String(item.ordinal)), templateId, item.ordinal, item.block, item.drill, item.words, item.minutes, item.details],
    );
  }
  const drafted = { status: 'INFERRED', draft: DRAFT, sources: ['DOC-1'] };
  await client.query(
    `insert into pilot.content_record_labels
       (organization_id, target_kind, target_lineage_id, target_version, field_labels, import_id, recorded_by_account_id, recorded_by_role)
     values ($1,'workout_template',$2,1,$3::jsonb,'imp-1','acct-import','organization_admin')`,
    [organizationId, templateId, JSON.stringify({ session_type: drafted, intent: drafted, difficulty: drafted, duration_minutes: drafted })],
  );
}

async function edit(organizationId: string, body: Record<string, unknown>) {
  return editWorkoutTemplate({
    organizationId,
    request: parseWorkoutTemplateEdit(body),
    actorAccountId: `${COACH}@${organizationId}`,
    actorRole: 'coach',
  });
}

async function versionsOf(organizationId: string, lineageId: string) {
  return (await client.query(
    `select * from pilot.workout_templates where organization_id = $1 and lineage_id = $2 order by version`,
    [organizationId, lineageId],
  )).rows;
}

async function itemsOf(organizationId: string, templateId: string) {
  return (await client.query(
    `select * from pilot.workout_template_items where organization_id = $1 and template_id = $2 order by ordinal`,
    [organizationId, templateId],
  )).rows;
}

async function labelsOf(organizationId: string, lineageId: string, version: number) {
  return (await client.query(
    `select * from pilot.content_record_labels
      where organization_id = $1 and target_kind = 'workout_template' and target_lineage_id = $2 and target_version = $3`,
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

describe('editing a workout template', () => {
  it('writes the next version with its items, keeps the old one, and relabels only what changed', async () => {
    const org = await newGym();
    await seedDrill(org, 'drl_jab', 'Jab');
    await seedDrill(org, 'drl_cross', 'Cross');
    await seedTemplate(org, 'wtp_one', 'Monday', 'drl_jab');
    const old = await itemsOf(org, 'wtp_one');

    const result = await edit(org, {
      template_id: 'wtp_one',
      intent: 'Coach intent.',
      session_type: 'technical', // resent unchanged: not an edit
      items: [
        { item_id: old[2].item_id }, // the details-only step, moved first and untouched
        { item_id: old[1].item_id, drill_id: 'drl_cross', coach_note: 'Switch to the cross.' },
        { block: 'finisher', free_text_drill: 'Burpees', rep_count: 20 },
      ],
    });

    const newId = versionId('wtp', 'wtp_one', 2);
    expect(result).toEqual({
      changed: true, template_id: newId, lineage_id: 'wtp_one', version: 2, previous_template_id: 'wtp_one', edited: ['intent', 'items'],
    });

    const [v1, v2] = await versionsOf(org, 'wtp_one');
    expect(v1).toMatchObject({ intent: 'Old intent.', active: false });
    expect(v1.superseded_at).not.toBeNull();
    expect(v2).toMatchObject({
      template_id: newId, version: 2, supersedes_template_id: 'wtp_one', superseded_at: null, active: true,
      intent: 'Coach intent.', session_type: 'technical', coach_notes: 'Old notes.', duration_minutes: 45,
      created_by_role: 'coach', created_by_account_id: `${COACH}@${org}`,
    });

    const items = await itemsOf(org, newId);
    expect(items.map((item) => [item.item_id, item.ordinal, item.block, item.drill_id, item.free_text_drill, item.rep_count, item.coach_note, item.details])).toEqual([
      [MINT.templateItem(newId, '1'), 1, 'cooldown', null, null, null, null, { parts: ['Breathe', 'Stretch'] }],
      [MINT.templateItem(newId, '2'), 2, 'technical', 'drl_cross', null, null, 'Switch to the cross.', {}],
      [MINT.templateItem(newId, '3'), 3, 'finisher', null, 'Burpees', 20, null, {}],
    ]);
    // The old version keeps its own items.
    expect((await itemsOf(org, 'wtp_one')).map((item) => item.block)).toEqual(['warmup', 'technical', 'cooldown']);

    const labels = await labelsOf(org, 'wtp_one', 2);
    const editedLabel = {
      status: 'REPORTED', sources: ['In-app edit'],
      edited: { by_account_id: `${COACH}@${org}`, by_role: 'coach', at: expect.any(String) },
    };
    expect(labels.field_labels.intent).toEqual(editedLabel);
    expect(labels.field_labels.items).toEqual(editedLabel);
    expect(labels.field_labels.session_type).toEqual({ status: 'INFERRED', draft: DRAFT, sources: ['DOC-1'] });
    expect(labels.field_labels.difficulty.draft).toBe(DRAFT);

    const audit = (await client.query(
      `select * from pilot.audit_events where organization_id = $1 and entity_type = 'workout_template' and entity_id = $2`, [org, newId],
    )).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0].details).toMatchObject({ action: 'in_app_edit', from_template_id: 'wtp_one', version: 2, edited: ['intent', 'items'] });

    // The old version is still readable as it was.
    const oldDetail = await getWorkoutTemplateWithItems(org, 'wtp_one');
    expect(oldDetail?.template.intent).toBe('Old intent.');
    expect(oldDetail?.items).toHaveLength(3);
  });

  it('leaves a workout already issued exactly as it was, and the next issue takes the new version', async () => {
    const org = await newGym();
    await seedDrill(org, 'drl_jab', 'Jab');
    await seedDrill(org, 'drl_cross', 'Cross');
    await seedTemplate(org, 'wtp_issued', 'Tuesday', 'drl_jab');
    // Only a drill step can be issued: drop the step in words and the details-only step.
    await client.query(`delete from pilot.workout_template_items where organization_id = $1 and template_id = 'wtp_issued' and drill_id is null`, [org]);
    const issue = (templateId: string) => issueWorkoutTemplate({
      organizationId: org, templateId, athleteId: ATHLETE_ID, actorAccountId: `${COACH}@${org}`, actorRole: 'coach',
    });
    expect((await issue('wtp_issued')).outcome).toBe('issued');
    const snapshot = async () => ({
      issues: (await client.query(`select * from pilot.workout_issues where organization_id = $1 order by issued_at`, [org])).rows,
      steps: (await client.query(`select * from pilot.workout_issue_steps where organization_id = $1 order by issue_id, ordinal`, [org])).rows,
      assignments: (await client.query(`select * from pilot.drill_assignments where organization_id = $1 order by assignment_id`, [org])).rows,
    });
    const before = await snapshot();
    expect(before.issues).toHaveLength(1);
    expect(before.steps.length).toBeGreaterThan(0);

    const result = await edit(org, {
      template_id: 'wtp_issued', name: 'Tuesday Revised', items: [{ block: 'all', drill_id: 'drl_cross', scale_level: 'B', duration_minutes: 30 }],
    });
    expect(await snapshot()).toEqual(before);
    expect(before.issues[0]).toMatchObject({ template_id: 'wtp_issued', template_name: 'Tuesday', template_version: 1 });

    // The old version is no longer current, so it cannot be issued again; the new one can.
    expect(await rejection(issue('wtp_issued'))).toMatchObject({ status: 409 });
    expect((await issue(result.template_id)).outcome).toBe('issued');
  });

  it("carries an owner's nested-step link to its parent's new id, follows a moved parent, and drops a link to a removed one (TL-ORD)", async () => {
    // details.within_item_id names the item a step sits inside (D-PK73-3); issueOrder issues it straight after.
    const org = await newGym();
    await seedDrill(org, 'drl_jab', 'Jab');
    await seedTemplate(org, 'wtp_nest', 'Nested', 'drl_jab');
    const v1 = await itemsOf(org, 'wtp_nest');
    await client.query(
      `update pilot.workout_template_items set details = jsonb_build_object('within_item_id', $3::text, 'timing', 'end of the warm-up')
        where organization_id = $1 and item_id = $2`,
      [org, v1[2].item_id, v1[0].item_id],
    );

    // A field-only edit carries every item: the link names step 1's new id, and the version issues 1, 3, 2.
    await edit(org, { template_id: 'wtp_nest', intent: 'New intent.' });
    const v2Id = versionId('wtp', 'wtp_nest', 2);
    const v2 = await itemsOf(org, v2Id);
    expect(v2[2].details).toEqual({ within_item_id: v2[0].item_id, timing: 'end of the warm-up' });
    expect(v2[0].item_id).toBe(MINT.templateItem(v2Id, '1'));
    const read2 = await getWorkoutTemplateWithItems(org, v2Id);
    expect(issueOrder(read2?.items ?? []).map((item) => item.ordinal)).toEqual([1, 3, 2]);

    // An edit that moves the parent: the link follows it to its new place, not to the old ordinal.
    await edit(org, { template_id: v2Id, items: [{ item_id: v2[1].item_id }, { item_id: v2[0].item_id }, { item_id: v2[2].item_id }] });
    const v3Id = versionId('wtp', 'wtp_nest', 3);
    const v3 = await itemsOf(org, v3Id);
    expect(v3.map((item) => item.block)).toEqual(['technical', 'warmup', 'cooldown']);
    expect(v3[2].details).toEqual({ within_item_id: v3[1].item_id, timing: 'end of the warm-up' });
    const read3 = await getWorkoutTemplateWithItems(org, v3Id);
    expect(issueOrder(read3?.items ?? []).map((item) => item.block)).toEqual(['technical', 'warmup', 'cooldown']);

    // An edit that removes the parent drops the link; the rest of the details stay.
    await edit(org, { template_id: v3Id, items: [{ item_id: v3[0].item_id }, { item_id: v3[2].item_id }] });
    const v4 = await itemsOf(org, versionId('wtp', 'wtp_nest', 4));
    expect(v4[1].details).toEqual({ timing: 'end of the warm-up' });

    // A link naming no item of the edited version (here an id of no template) is carried as it is, not dropped.
    const v4Id = versionId('wtp', 'wtp_nest', 4);
    await client.query(
      `update pilot.workout_template_items set details = jsonb_build_object('within_item_id', 'wti_elsewhere')
        where organization_id = $1 and item_id = $2`,
      [org, v4[0].item_id],
    );
    await edit(org, { template_id: v4Id, intent: 'Another intent.' });
    const v5 = await itemsOf(org, versionId('wtp', 'wtp_nest', 5));
    expect(v5[0].details).toEqual({ within_item_id: 'wti_elsewhere' });
  });

  it('writes nothing when nothing really changes', async () => {
    const org = await newGym();
    await seedDrill(org, 'drl_jab', 'Jab');
    await seedTemplate(org, 'wtp_same', 'Same', 'drl_jab');
    const old = await itemsOf(org, 'wtp_same');
    const result = await edit(org, {
      template_id: 'wtp_same',
      intent: 'Old intent.\r\n',
      duration_minutes: 45,
      items: old.map((item) => ({ item_id: item.item_id, block: item.block })),
    });
    expect(result).toMatchObject({ changed: false, version: 1, edited: [] });
    expect(await versionsOf(org, 'wtp_same')).toHaveLength(1);

    // Stored text the importer did not normalize, and a stored blank, read the same way as the resend.
    await client.query(
      `update pilot.workout_templates set session_type = E' technical\\r\\n', coach_notes = '' where organization_id = $1 and template_id = 'wtp_same'`,
      [org],
    );
    expect(await edit(org, { template_id: 'wtp_same', session_type: 'technical', coach_notes: '' })).toMatchObject({ changed: false });
  });

  it("refuses a version that is no longer current, and another gym's template", async () => {
    const orgA = await newGym();
    const orgB = await newGym();
    await seedDrill(orgA, 'drl_jab', 'Jab');
    await seedDrill(orgB, 'drl_jab', 'Jab');
    await seedTemplate(orgA, 'wtp_stale', 'Stale', 'drl_jab');
    await seedTemplate(orgB, 'wtp_b', 'Other', 'drl_jab');
    await edit(orgA, { template_id: 'wtp_stale', intent: 'First.' });
    expect(await rejection(edit(orgA, { template_id: 'wtp_stale', intent: 'Second.' }))).toMatchObject({ status: 409, code: 'TEMPLATE_VERSION_STALE' });
    expect(await rejection(edit(orgA, { template_id: 'wtp_b', intent: 'Not yours.' }))).toMatchObject({ status: 404 });
    expect(await versionsOf(orgB, 'wtp_b')).toHaveLength(1);
  });

  it("refuses a withdrawn or foreign drill, an item above its drill's contact, and the table's item rules, writing nothing", async () => {
    const org = await newGym();
    const other = await newGym();
    await seedDrill(org, 'drl_jab', 'Jab');
    await seedDrill(org, 'drl_gone', 'Gone', { active: false });
    await seedDrill(org, 'drl_spar', 'Spar', { contact: 'controlled_sparring' });
    await seedDrill(other, 'drl_theirs', 'Theirs');
    await seedTemplate(org, 'wtp_items', 'Items', 'drl_jab');
    const old = await itemsOf(org, 'wtp_items');
    const keep = old.map((item) => ({ item_id: item.item_id }));

    expect(await rejection(edit(org, { template_id: 'wtp_items', items: [...keep, { block: 'x', drill_id: 'drl_gone' }] })))
      .toMatchObject({ status: 400, code: 'ITEM_DRILL_WITHDRAWN' });
    expect(await rejection(edit(org, { template_id: 'wtp_items', items: [...keep, { block: 'x', drill_id: 'drl_nowhere' }] })))
      .toMatchObject({ status: 400, code: 'ITEM_DRILL_NOT_FOUND' });
    expect(await rejection(edit(org, { template_id: 'wtp_items', items: [...keep, { block: 'x', drill_id: 'drl_theirs' }] })))
      .toMatchObject({ status: 400, code: 'ITEM_DRILL_NOT_FOUND' });
    expect(await rejection(edit(org, {
      template_id: 'wtp_items', items: [{ item_id: old[1].item_id, contact_level: 'controlled_sparring', duration_minutes: null }],
    }))).toMatchObject({ status: 400, code: 'ITEM_CONTACT_ABOVE_DRILL' });
    expect(await rejection(edit(org, { template_id: 'wtp_items', items: [...keep, { block: 'empty' }] })))
      .toMatchObject({ status: 400, code: 'ITEM_NEEDS_SOURCE' });
    expect(await rejection(edit(org, {
      template_id: 'wtp_items', items: [{ block: 'spar', drill_id: 'drl_spar', contact_level: 'controlled_sparring', duration_minutes: 6 }],
    }))).toMatchObject({ status: 400, code: 'ITEM_CONTACT_VOLUME' });
    expect(await rejection(edit(org, { template_id: 'wtp_items', items: [{ item_id: 'wti_not_here' }] })))
      .toMatchObject({ status: 400 });
    expect(await versionsOf(org, 'wtp_items')).toHaveLength(1);

    const ok = await edit(org, { template_id: 'wtp_items', items: [{ block: 'spar', drill_id: 'drl_spar', contact_level: 'controlled_sparring' }] });
    expect(ok).toMatchObject({ changed: true, edited: ['items'] });
  });

  it("judges an item's drill by the drill's current version, and never refuses a carried drill resent unchanged", async () => {
    const org = await newGym();
    await seedDrill(org, 'drl_cond', 'Cond', { contact: 'conditioned' });
    await seedTemplate(org, 'wtp_pinned', 'Pinned', 'drl_cond');
    // The item stays on v1; the drill's current version (v2) is light technical.
    await seedDrill(org, 'drl_cond_v2', 'Cond', { contact: 'light_technical', lineage: 'drl_cond', version: 2 });
    await client.query(`update pilot.workout_template_items set contact_level = 'light_technical' where organization_id = $1 and template_id = 'wtp_pinned' and ordinal = 2`, [org]);
    const old = await itemsOf(org, 'wtp_pinned');

    // A whole list resent with the pinned drill unchanged, and an edit elsewhere: allowed, the pin kept.
    const resent = await edit(org, {
      template_id: 'wtp_pinned',
      intent: 'Changed.',
      items: old.map((item) => ({ item_id: item.item_id, block: item.block, drill_id: item.drill_id, contact_level: item.contact_level })),
    });
    expect(resent).toMatchObject({ changed: true, edited: ['intent'] });
    expect((await itemsOf(org, resent.template_id))[1].drill_id).toBe('drl_cond');

    // Raising the carried step to conditioned: above the current version's light technical.
    const now = await itemsOf(org, resent.template_id);
    expect(await rejection(edit(org, {
      template_id: resent.template_id, items: now.map((item) => ({ item_id: item.item_id, ...(item.ordinal === 2 ? { contact_level: 'conditioned', duration_minutes: null } : {}) })),
    }))).toMatchObject({ status: 400, code: 'ITEM_CONTACT_ABOVE_DRILL' });

    // Naming an older version of a drill stores its current version, as the importer does.
    const switched = await edit(org, { template_id: resent.template_id, items: [{ block: 'new', drill_id: 'drl_cond', contact_level: 'none' }] });
    expect((await itemsOf(org, switched.template_id))[0].drill_id).toBe('drl_cond_v2');
  });

  it('keeps a withdrawn template withdrawn, and numbers the version from the highest in the lineage', async () => {
    const org = await newGym();
    await seedDrill(org, 'drl_jab', 'Jab');
    await seedTemplate(org, 'wtp_off', 'Off', 'drl_jab');
    await client.query(`update pilot.workout_templates set active = false where organization_id = $1 and template_id = 'wtp_off'`, [org]);
    // A superseded version numbered above the head (the importer numbers from the highest, too).
    await client.query(
      `insert into pilot.workout_templates
         (organization_id, template_id, lineage_id, version, name, session_type, intent, duration_minutes, active, superseded_at)
       values ($1, 'wtp_off_v5', 'wtp_off', 5, 'Off v5', 'technical', 'Old.', 45, false, now())`,
      [org],
    );
    const result = await edit(org, { template_id: 'wtp_off', coach_notes: 'Still off.' });
    expect(result).toMatchObject({ version: 6, template_id: versionId('wtp', 'wtp_off', 6) });
    const head = (await versionsOf(org, 'wtp_off')).find((row) => row.superseded_at === null);
    expect(head).toMatchObject({ version: 6, active: false, coach_notes: 'Still off.' });
  });

  it('refuses a name another active template holds', async () => {
    const org = await newGym();
    await seedDrill(org, 'drl_jab', 'Jab');
    await seedTemplate(org, 'wtp_a', 'Name A', 'drl_jab');
    await seedTemplate(org, 'wtp_b', 'Name B', 'drl_jab');
    expect(await rejection(edit(org, { template_id: 'wtp_b', name: 'Name A' }))).toMatchObject({ status: 409, code: 'TEMPLATE_NAME_TAKEN' });
  });
});

// "LOOKS RIGHT" (OD-2026-11-19-007, OW25-55; lane ED-UI PR4, Q1 = A, Q3 = A).
describe('"Looks right" on a template', () => {
  it('writes the next version with the same content and items; the label keeps its sources, loses its draft and records the coach', async () => {
    const org = await newGym();
    await seedDrill(org, 'drl_lr_jab', 'Jab');
    await seedTemplate(org, 'wtp_lr', 'Tuesday', 'drl_lr_jab');
    const result = await edit(org, { template_id: 'wtp_lr', looks_right: 'intent' });
    expect(result).toMatchObject({ changed: true, version: 2, edited: [], looks_right: 'intent' });

    const [v1, v2] = await versionsOf(org, 'wtp_lr');
    expect(v2.intent).toBe(v1.intent);
    expect(v2.session_type).toBe(v1.session_type);
    const oldItems = await itemsOf(org, 'wtp_lr');
    const newItems = await itemsOf(org, result.template_id);
    expect(newItems.map((item) => [item.ordinal, item.block, item.drill_id])).toEqual(oldItems.map((item) => [item.ordinal, item.block, item.drill_id]));

    const labels = (await labelsOf(org, 'wtp_lr', 2)).field_labels;
    expect(labels.intent).toEqual({
      status: 'INFERRED', sources: ['DOC-1'], looks_right: { by_account_id: `${COACH}@${org}`, by_role: 'coach', at: expect.any(String) },
    });
    expect(labels.session_type.draft).toBe(DRAFT);

    const audit = (await client.query(
      `select * from pilot.audit_events where organization_id = $1 and entity_type = 'workout_template' and entity_id = $2`, [org, result.template_id],
    )).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0].details).toMatchObject({ action: 'in_app_edit', looks_right: 'intent', edited: [], from_template_id: 'wtp_lr' });
  });

  it('refuses a field that is not a draft (409 FIELD_NOT_DRAFT), and writes nothing', async () => {
    const org = await newGym();
    await seedDrill(org, 'drl_lr_cross', 'Cross');
    await seedTemplate(org, 'wtp_lr_no', 'Wednesday', 'drl_lr_cross');
    for (const looks_right of ['name', 'items', 'coach_notes']) {
      expect(await rejection(edit(org, { template_id: 'wtp_lr_no', looks_right }))).toMatchObject({ status: 409, code: 'FIELD_NOT_DRAFT' });
    }
    expect(await versionsOf(org, 'wtp_lr_no')).toHaveLength(1);
  });
});

describe('parseWorkoutTemplateEdit', () => {
  it('refuses unknown and never-editable fields by name', () => {
    expect(() => parseWorkoutTemplateEdit({ template_id: 'x', colour: 'red' })).toThrow('Unsupported field: colour');
    for (const key of ['details', 'active', 'version', 'lineage_id']) {
      expect(() => parseWorkoutTemplateEdit({ template_id: 'x', [key]: 'y' })).toThrow(`Unsupported field: ${key} is not editable`);
    }
    expect(() => parseWorkoutTemplateEdit({ template_id: 'x', items: [{ item_id: 'a', ordinal: 2 }] })).toThrow('Unsupported field: items.ordinal is not editable');
    expect(() => parseWorkoutTemplateEdit({ template_id: 'x', items: [{ item_id: 'a', colour: 1 }] })).toThrow('Unsupported field: items.colour');
  });

  it("applies the importer's bounds and lists", () => {
    expect(() => parseWorkoutTemplateEdit({ template_id: 'x', duration_minutes: 181 })).toThrow('from 1 to 180');
    expect(() => parseWorkoutTemplateEdit({ template_id: 'x', difficulty: 'expert' })).toThrow('Unsupported difficulty');
    expect(() => parseWorkoutTemplateEdit({ template_id: 'x', items: [{ block: 'b', free_text_drill: 'x', duration_minutes: 91 }] })).toThrow('from 1 to 90');
    expect(() => parseWorkoutTemplateEdit({ template_id: 'x', items: [{ block: 'b', free_text_drill: 'x', contact_level: 'sparring' }] })).toThrow('Unsupported items[0].contact_level');
    expect(() => parseWorkoutTemplateEdit({ template_id: 'x', items: [{ free_text_drill: 'x' }] })).toThrow('a new item needs a block');
    expect(() => parseWorkoutTemplateEdit({ template_id: 'x', name: ' ' })).toThrow('Missing name');
    expect(() => parseWorkoutTemplateEdit({ template_id: 'x', items: [] })).toThrow('a template keeps at least one item');
    expect(parseWorkoutTemplateEdit({ template_id: 'x', coach_notes: '' }).fields.coach_notes).toBeNull();
  });
});
