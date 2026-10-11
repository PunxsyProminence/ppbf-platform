// Real PostgreSQL-backed contract test for the drill READERS under owner
// rulings R2 and R3 (2026-09-29), on the FULL schema, content-import
// migration included:
//
//   R2 "1 an d new stuff gets added if there is nothing to update"
//      -- a revised drill is v(n+1); the old version is kept, superseded but
//      still active, for the gyms that adopted it.
//   R3 "every drill is different so the rules would vary, obviously injury of
//      some sort would require stoppage universally"
//      -- a drill's stop rules are its own (the legacy scope='universal' rows
//      included); a small gym-wide set is stored once in
//      pilot.universal_stop_rules and applies to every drill.
//
// WHY A REAL DATABASE. Every property here is a predicate over rows the
// content-import migration made legal -- a superseded v1 that keeps its name
// and stays active beside its v2, a stored-once rule narrowed by a text[] of
// contact levels -- and a mocked query can observe none of them:
//
//   * "current version" is `superseded_at is null`, a second term beside
//     `active`; only a real v1/v2 pair shows the browse and the cue library
//     stopped listing both.
//   * 'newer_version_available' is a LATERAL join from the head to the gym's
//     operational drill for another version of the same lineage. Only real
//     promotions (through the production writer), a real retirement and a
//     second gym holding the same ids show which drill it names and that the
//     organization terms hold.
//   * the stored-once rules are filtered by `active`, `superseded_at` and
//     `$2 = any(applies_to_contact_levels)`; a rule of each shape is written
//     and only the applicable current ones may come back, to coaches AND
//     athletes, through the Learn read and the open-work read alike.
//
// ISOLATION WITHOUT TRANSACTIONS, as drillLifecycle.pg.test.ts: the schema is
// built once, and every test seeds its own gym(s) under a fresh organization
// id, so nothing one test writes is visible to another and ids can be reused
// across gyms on purpose.
//
// './db' is mocked to route into the embedded server, so every function below
// is production code running its production SQL.
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
import { pathToFileURL } from 'node:url';

import { Client } from 'pg';

/* ts-jest compiles a plain `await import()` down to require(), which cannot
   load an ES module here. Building it through Function keeps a real dynamic
   import in the emitted code, honored under --experimental-vm-modules. */
const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

const FULL_SCHEMA_HELPER_PATH = path.resolve(__dirname, '../../../scripts/lib/full-schema.mjs');

// Routes every query into the one embedded database. Declared before the
// imports so jest's mock hoisting sees it.
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

import { fromAthleteDrillDetail, fromCoachDrillDetail } from '../../../components/drills/drillDetailView';
import { adoptionReadiness } from '../../lib/drillAdoptionReadiness';
import {
  getAthleteDrillDetail,
  getAthleteDrillDetailForOpenWork,
  getDrillWithDetail,
  getOtherVersionAdoption,
  listCueLibrary,
  listDrillLibrary,
  listReferenceLifecycles,
  type ReferenceLifecycle,
} from './drillLibraryV3';
import {
  DrillNameTakenError,
  ReferenceDrillAlreadyPromotedError,
  createDrill,
  promoteReferenceDrill,
  updateDrill,
} from './drills';
import { updateDrillToReferenceVersion } from './drillVersioning';

jest.setTimeout(300_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-reference-drill-versions-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const DATABASE_NAME = 'ppbf_test_reference_drill_versions';

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

/** A fresh gym for one test, with the discipline pilot.drill_library points at. */
async function newGym(label: string): Promise<string> {
  gymCount += 1;
  const organizationId = `org-refver-${label}-${gymCount}`;
  await client.query(
    `insert into pilot.organizations (organization_id, organization_name, status)
     values ($1, $1, 'active')`,
    [organizationId],
  );
  await client.query(
    `insert into pilot.disciplines (organization_id, discipline, display_name, lane, exposure_model)
     values ($1, 'boxing', 'Boxing', 'striking', 'head_impact')`,
    [organizationId],
  );
  return organizationId;
}

/** One reference drill VERSION, written raw. */
async function insertReference(
  organizationId: string,
  opts: {
    drillId: string;
    name: string;
    lineageId?: string;
    version?: number;
    supersedesDrillId?: string | null;
    active?: boolean;
    contactLevel?: string;
  },
): Promise<void> {
  await client.query(
    `insert into pilot.drill_library
       (organization_id, drill_id, lineage_id, version, supersedes_drill_id, name,
        discipline, category, difficulty, target_behavior, purpose, standard_setup, execution,
        what_good_looks_like, what_bad_looks_like, contact_level, active)
     values ($1,$2,$3,$4,$5,$6,
             'boxing','footwork','intermediate', $6 || ' target.', $6 || ' purpose.', $6 || ' setup.',
             $6 || ' execution.', $6 || ' good.', $6 || ' bad.', $7, $8)`,
    [
      organizationId,
      opts.drillId,
      opts.lineageId ?? opts.drillId,
      opts.version ?? 1,
      opts.supersedesDrillId ?? null,
      opts.name,
      opts.contactLevel ?? 'none',
      opts.active ?? true,
    ],
  );
}

/**
 * A revision the way R2 writes one (content-import migration, section (2)):
 * the current head is stamped superseded FIRST -- and stays active, for the
 * gyms that adopted it -- and then the successor is inserted with the same
 * lineage, the next version and, here, the same name. The one-head-per-lineage
 * index refuses the other order, and the redefined name index is what lets v2
 * keep v1's name.
 */
async function revise(
  organizationId: string,
  currentDrillId: string,
  next: { drillId: string; name?: string; active?: boolean },
): Promise<void> {
  const { rows } = await client.query<{ lineage_id: string; version: number; name: string; contact_level: string }>(
    `update pilot.drill_library set superseded_at = now(), updated_at = now()
     where organization_id = $1 and drill_id = $2
     returning lineage_id, version, name, contact_level`,
    [organizationId, currentDrillId],
  );
  if (!rows[0]) throw new Error(`test bug: ${currentDrillId} is not in ${organizationId}`);
  await insertReference(organizationId, {
    drillId: next.drillId,
    name: next.name ?? rows[0].name,
    lineageId: rows[0].lineage_id,
    version: rows[0].version + 1,
    supersedesDrillId: currentDrillId,
    active: next.active,
    contactLevel: rows[0].contact_level,
  });
}

async function insertCue(organizationId: string, drillId: string, cueId: string, cueText: string): Promise<void> {
  await client.query(
    `insert into pilot.drill_cues (organization_id, cue_id, drill_id, cue_text, cue_family, focus_type)
     values ($1,$2,$3,$4,'Return','external')`,
    [organizationId, cueId, drillId, cueText],
  );
}

async function insertOwnStopRule(
  organizationId: string,
  drillId: string,
  opts: { stopRuleId: string; ordinal: number; text: string; scope: 'universal' | 'drill_specific'; kind: string },
): Promise<void> {
  await client.query(
    `insert into pilot.drill_stop_rules
       (organization_id, stop_rule_id, drill_id, ordinal, condition_text, scope, rule_kind)
     values ($1,$2,$3,$4,$5,$6,$7)`,
    [organizationId, opts.stopRuleId, drillId, opts.ordinal, opts.text, opts.scope, opts.kind],
  );
}

/** One stored-once rule VERSION (pilot.universal_stop_rules), written raw. */
async function insertUniversalRule(
  organizationId: string,
  opts: {
    ruleId: string;
    ordinal: number;
    text: string;
    kind?: string;
    contactLevels?: string[] | null;
    lineageId?: string;
    version?: number;
    supersedesRuleId?: string | null;
    superseded?: boolean;
    active?: boolean;
  },
): Promise<void> {
  await client.query(
    `insert into pilot.universal_stop_rules
       (organization_id, universal_rule_id, lineage_id, version, supersedes_rule_id, superseded_at,
        active, ordinal, condition_text, rule_kind, applies_to_contact_levels)
     values ($1,$2,$3,$4,$5,case when $6::boolean then now() else null end,$7,$8,$9,$10,$11::text[])`,
    [
      organizationId,
      opts.ruleId,
      opts.lineageId ?? opts.ruleId,
      opts.version ?? 1,
      opts.supersedesRuleId ?? null,
      opts.superseded ?? false,
      opts.active ?? true,
      opts.ordinal,
      opts.text,
      opts.kind ?? 'safety',
      opts.contactLevels ?? null,
    ],
  );
}

/** A promotion through the production writer. Returns the new operational drill id. */
async function promote(organizationId: string, referenceDrillId: string, name: string): Promise<string> {
  const drill = await promoteReferenceDrill({
    organizationId,
    referenceDrillId,
    name,
    category: 'footwork',
    focus: `${name} focus.`,
  });
  return drill.drill_id;
}

/**
 * A refinement of the gym's OWN drill, written the way adoptDrillChangeProposal
 * writes it (drillVersioning.ts): the current operational version deactivated,
 * the successor inserted active with the same lineage and the SAME reference
 * pointer.
 */
async function refineOperational(organizationId: string, currentDrillId: string, newDrillId: string): Promise<void> {
  const { rows } = await client.query<{ lineage_id: string; version: number; name: string; reference_drill_id: string | null }>(
    `update pilot.drills set active = false, superseded_at = now(), updated_at = now()
     where organization_id = $1 and drill_id = $2
     returning lineage_id, version, name, reference_drill_id`,
    [organizationId, currentDrillId],
  );
  if (!rows[0]) throw new Error(`test bug: ${currentDrillId} is not in ${organizationId}`);
  await client.query(
    `insert into pilot.drills
       (organization_id, drill_id, name, category, focus, active, lineage_id,
        supersedes_drill_id, reference_drill_id, version)
     values ($1,$2,$3,'footwork','Focus.',true,$4,$5,$6,$7)`,
    [organizationId, newDrillId, rows[0].name, rows[0].lineage_id, currentDrillId, rows[0].reference_drill_id, rows[0].version + 1],
  );
  await client.query(
    `update pilot.drills set superseded_by_drill_id = $3 where organization_id = $1 and drill_id = $2`,
    [organizationId, currentDrillId, newDrillId],
  );
}

async function lifecyclesOf(organizationId: string, ids: string[]): Promise<Record<string, ReferenceLifecycle>> {
  return listReferenceLifecycles(organizationId, ids);
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
  /* THE WHOLE SCHEMA, in the workflow's `all` order (scripts/lib/full-schema.mjs):
     the v3 library, the drills/versioning/provenance migrations the lifecycle
     joins, and the content-import migration that makes a superseded v1 and a
     same-named v2 coexist and creates pilot.universal_stop_rules. */
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
  await fs.rm(DATA_DIR, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }).catch(() => {});
});

describe('the coach browse and cue library list current versions only (real database)', () => {
  test('coach browse lists only v2 when v1 is superseded but active', async () => {
    const gym = await newGym('browse');
    await insertReference(gym, { drillId: 'ref-jab-v1', name: 'Jab Return', lineageId: 'lin-jab' });
    await insertReference(gym, { drillId: 'ref-pivot', name: 'Pivot Out' });
    await revise(gym, 'ref-jab-v1', { drillId: 'ref-jab-v2' });

    // CONTROL: v1 really is the shape R2 keeps -- superseded, still active,
    // same name as its successor -- so `active` alone would list it.
    const { rows } = await client.query(
      `select drill_id, name, active, superseded_at is not null as superseded
       from pilot.drill_library where organization_id = $1 and lineage_id = 'lin-jab' order by version`,
      [gym],
    );
    expect(rows).toEqual([
      { drill_id: 'ref-jab-v1', name: 'Jab Return', active: true, superseded: true },
      { drill_id: 'ref-jab-v2', name: 'Jab Return', active: true, superseded: false },
    ]);

    expect((await listDrillLibrary(gym)).map((drill) => drill.drill_id)).toEqual(['ref-jab-v2', 'ref-pivot']);
    expect((await listDrillLibrary(gym, { discipline: 'boxing', category: 'footwork' })).map((drill) => drill.drill_id))
      .toEqual(['ref-jab-v2', 'ref-pivot']);

    // History stays readable by id: a gym running v1 opens it from its
    // operational drill through the coach detail, which has no version filter.
    expect((await getDrillWithDetail(gym, 'ref-jab-v1'))?.superseded_at).not.toBeNull();
  });

  test('the cue library lists head cues only', async () => {
    const gym = await newGym('cues');
    await insertReference(gym, { drillId: 'ref-jab-v1', name: 'Jab Return', lineageId: 'lin-jab' });
    await insertCue(gym, 'ref-jab-v1', 'cue-v1-a', 'Hand home, v1 wording');
    await revise(gym, 'ref-jab-v1', { drillId: 'ref-jab-v2' });
    // A revision re-mints every cue onto the new version.
    await insertCue(gym, 'ref-jab-v2', 'cue-v2-a', 'Hand home first');
    await insertReference(gym, { drillId: 'ref-pivot', name: 'Pivot Out' });
    await insertCue(gym, 'ref-pivot', 'cue-pivot', 'Pivot on the lead foot');

    expect((await listCueLibrary(gym)).map((cue) => [cue.cue_id, cue.drill_id]).sort()).toEqual([
      ['cue-pivot', 'ref-pivot'],
      ['cue-v2-a', 'ref-jab-v2'],
    ]);
    // The name search matches both versions' shared name; still the head only.
    expect((await listCueLibrary(gym, { search: 'Jab Return' })).map((cue) => cue.cue_id)).toEqual(['cue-v2-a']);
  });
});

describe("'newer_version_available': a gym running v1 is told v2 exists (real database)", () => {
  test('v2 of an adopted lineage reports the newer-version state with the operational drill id', async () => {
    const gym = await newGym('newer');
    await insertReference(gym, { drillId: 'ref-jab-v1', name: 'Jab Return', lineageId: 'lin-jab' });
    const operationalId = await promote(gym, 'ref-jab-v1', 'Jab Return');
    await revise(gym, 'ref-jab-v1', { drillId: 'ref-jab-v2' });

    expect(await lifecyclesOf(gym, ['ref-jab-v1', 'ref-jab-v2'])).toEqual({
      // The gym still runs the version it adopted; adoption comes first.
      'ref-jab-v1': { state: 'operational', operational_drill_id: operationalId },
      // The head links back to the gym's drill.
      'ref-jab-v2': { state: 'newer_version_available', operational_drill_id: operationalId },
    });
    // The promote route's question, answered from the same subquery.
    expect(await getOtherVersionAdoption(gym, 'ref-jab-v2')).toEqual({
      operational_drill_id: operationalId,
      adopted_reference_drill_id: 'ref-jab-v1',
    });
    // v1 is the version adopted, not ANOTHER one.
    expect(await getOtherVersionAdoption(gym, 'ref-jab-v1')).toBeNull();

    // The browse the coach sees is the head, and the full-list lifecycle map
    // carries the same answer for it.
    expect((await listDrillLibrary(gym)).map((drill) => drill.drill_id)).toEqual(['ref-jab-v2']);
    expect((await listReferenceLifecycles(gym))['ref-jab-v2']).toEqual({
      state: 'newer_version_available',
      operational_drill_id: operationalId,
    });
  });

  test("the link follows the gym's drill: its refined successor while it runs, its lineage head once retired", async () => {
    const gym = await newGym('newer-follow');
    await insertReference(gym, { drillId: 'ref-jab-v1', name: 'Jab Return', lineageId: 'lin-jab' });
    const rootId = await promote(gym, 'ref-jab-v1', 'Jab Return');
    await refineOperational(gym, rootId, 'op-jab-refined');
    await revise(gym, 'ref-jab-v1', { drillId: 'ref-jab-v2' });

    // The live operational row is the refined successor, not the root.
    expect((await lifecyclesOf(gym, ['ref-jab-v2']))['ref-jab-v2']).toEqual({
      state: 'newer_version_available',
      operational_drill_id: 'op-jab-refined',
    });

    await updateDrill({ organizationId: gym, drillId: 'op-jab-refined', active: false });

    // Retired, the gym still HAS the drill (Restore brings it back), so v2 is
    // still not a fresh adoption: it names the lineage head -- and says the
    // drill is retired, because v2's card is now the only place the coach
    // page can offer that Restore (the browse hides v1).
    expect(await lifecyclesOf(gym, ['ref-jab-v1', 'ref-jab-v2'])).toEqual({
      'ref-jab-v1': { state: 'retired', operational_drill_id: 'op-jab-refined' },
      'ref-jab-v2': { state: 'newer_version_retired', operational_drill_id: 'op-jab-refined' },
    });
    expect((await listDrillLibrary(gym)).map((drill) => drill.drill_id)).toEqual(['ref-jab-v2']);
    // The promote route still refuses v2: the gym has a version, running or not.
    expect(await getOtherVersionAdoption(gym, 'ref-jab-v2')).toEqual({
      operational_drill_id: 'op-jab-refined',
      adopted_reference_drill_id: 'ref-jab-v1',
    });

    // The Restore that state offers is one the server's own guard accepts:
    // the named drill comes back, and v2 goes back to naming a running drill.
    const restored = await updateDrill({ organizationId: gym, drillId: 'op-jab-refined', active: true });
    expect(restored?.active).toBe(true);
    expect(await lifecyclesOf(gym, ['ref-jab-v1', 'ref-jab-v2'])).toEqual({
      'ref-jab-v1': { state: 'operational', operational_drill_id: 'op-jab-refined' },
      'ref-jab-v2': { state: 'newer_version_available', operational_drill_id: 'op-jab-refined' },
    });
  });

  test('a retired drill whose pinned version was withdrawn is not offered back', async () => {
    const gym = await newGym('newer-pinned-withdrawn');
    await insertReference(gym, { drillId: 'ref-jab-v1', name: 'Jab Return', lineageId: 'lin-jab' });
    const operationalId = await promote(gym, 'ref-jab-v1', 'Jab Return');
    await revise(gym, 'ref-jab-v1', { drillId: 'ref-jab-v2' });
    await updateDrill({ organizationId: gym, drillId: operationalId, active: false });
    await client.query(
      `update pilot.drill_library set active = false where organization_id = $1 and drill_id = 'ref-jab-v1'`,
      [gym],
    );

    // No Restore state: the server refuses that restore, so the head keeps the
    // action-less newer-version state (the page offers nothing on it).
    expect((await lifecyclesOf(gym, ['ref-jab-v2']))['ref-jab-v2']).toEqual({
      state: 'newer_version_available',
      operational_drill_id: operationalId,
    });
    // CONTROL: the server's guard really does refuse it.
    await expect(updateDrill({ organizationId: gym, drillId: operationalId, active: true }))
      .rejects.toMatchObject({ reason: 'reference_withdrawn' });
  });

  test("a gym that never adopted the lineage sees v2 available and v1 superseded, whatever another gym adopted", async () => {
    // Both gyms hold the very same ids. Only the other gym adopted v1, so an
    // organization term missing from the lateral join would leak its drill.
    const adopter = await newGym('newer-adopter');
    const fresh = await newGym('newer-fresh');
    for (const gym of [adopter, fresh]) {
      await insertReference(gym, { drillId: 'ref-jab-v1', name: 'Jab Return', lineageId: 'lin-jab' });
    }
    await promote(adopter, 'ref-jab-v1', 'Jab Return');
    for (const gym of [adopter, fresh]) {
      await revise(gym, 'ref-jab-v1', { drillId: 'ref-jab-v2' });
    }

    expect(await lifecyclesOf(fresh, ['ref-jab-v1', 'ref-jab-v2'])).toEqual({
      'ref-jab-v1': { state: 'superseded', operational_drill_id: null },
      'ref-jab-v2': { state: 'available', operational_drill_id: null },
    });
    expect(await getOtherVersionAdoption(fresh, 'ref-jab-v2')).toBeNull();
    // CONTROL: the other gym's answer really is the newer-version state.
    expect((await lifecyclesOf(adopter, ['ref-jab-v2']))['ref-jab-v2'].state).toBe('newer_version_available');
  });

  test('a withdrawn head stays unavailable even though the gym runs an earlier version', async () => {
    const gym = await newGym('newer-withdrawn');
    await insertReference(gym, { drillId: 'ref-jab-v1', name: 'Jab Return', lineageId: 'lin-jab' });
    const operationalId = await promote(gym, 'ref-jab-v1', 'Jab Return');
    await revise(gym, 'ref-jab-v1', { drillId: 'ref-jab-v2', active: false });

    expect(await lifecyclesOf(gym, ['ref-jab-v1', 'ref-jab-v2'])).toEqual({
      'ref-jab-v1': { state: 'operational', operational_drill_id: operationalId },
      'ref-jab-v2': { state: 'unavailable', operational_drill_id: null },
    });
  });
});

describe('stop rules on drill detail: the drill\'s own and the gym\'s stored-once set (real database)', () => {
  const INJURY = 'Stop on any sign of injury.';
  const HEAD_BLOW = 'Stop after any blow to the head.';
  const REWORDED_NEW = 'Stop when the athlete cannot answer a simple question.';

  /** The stored-once rules of every shape the reader must include or exclude. */
  async function seedStoredOnceRules(gym: string, otherGym: string): Promise<void> {
    // Applies to every drill.
    await insertUniversalRule(gym, { ruleId: 'ust_injury', ordinal: 1, text: INJURY });
    // Narrowed to contact drills.
    await insertUniversalRule(gym, {
      ruleId: 'ust_head',
      ordinal: 2,
      text: HEAD_BLOW,
      contactLevels: ['controlled_sparring', 'open_sparring'],
    });
    // Revised: v1 superseded FIRST, then v2 inserted -- only v2 is current.
    await insertUniversalRule(gym, {
      ruleId: 'ust_question_v1', lineageId: 'ust_question', ordinal: 3,
      text: 'Stop when the athlete seems confused.', superseded: true,
    });
    await insertUniversalRule(gym, {
      ruleId: 'ust_question_v2', lineageId: 'ust_question', version: 2, supersedesRuleId: 'ust_question_v1',
      ordinal: 3, text: REWORDED_NEW,
    });
    // Withdrawn head: applies to nothing.
    await insertUniversalRule(gym, { ruleId: 'ust_withdrawn', ordinal: 4, text: 'Withdrawn rule.', active: false });
    // Another gym's rule under the SAME id and position.
    await insertUniversalRule(otherGym, { ruleId: 'ust_injury', ordinal: 1, text: 'Another gym only.' });
  }

  test("coach and athlete detail include the org's applicable stored-once rules; a contact-level-limited rule is excluded for a non-matching drill", async () => {
    const gym = await newGym('stored-once');
    const otherGym = await newGym('stored-once-other');
    await insertReference(gym, { drillId: 'ref-shadow', name: 'Shadow Rounds', contactLevel: 'none' });
    await insertReference(gym, { drillId: 'ref-spar', name: 'Open Sparring', contactLevel: 'open_sparring' });
    await promote(gym, 'ref-shadow', 'Shadow Rounds');
    await promote(gym, 'ref-spar', 'Open Sparring');
    await seedStoredOnceRules(gym, otherGym);

    const coachShadow = await getDrillWithDetail(gym, 'ref-shadow');
    const coachSpar = await getDrillWithDetail(gym, 'ref-spar');
    expect(coachShadow?.universal_stop_rules.map((rule) => rule.condition_text)).toEqual([INJURY, REWORDED_NEW]);
    expect(coachSpar?.universal_stop_rules.map((rule) => rule.condition_text)).toEqual([INJURY, HEAD_BLOW, REWORDED_NEW]);
    // The coach row names where it came from, all the way down to its id.
    expect(coachSpar?.universal_stop_rules[1]).toEqual({
      organization_id: gym,
      universal_rule_id: 'ust_head',
      lineage_id: 'ust_head',
      version: 1,
      ordinal: 2,
      condition_text: HEAD_BLOW,
      rule_kind: 'safety',
      applies_to_contact_levels: ['controlled_sparring', 'open_sparring'],
      origin: 'universal',
    });
    // Never merged into the drill's own rules: these drills have none.
    expect(coachShadow?.stop_rules).toEqual([]);

    for (const read of [getAthleteDrillDetail, getAthleteDrillDetailForOpenWork]) {
      const athleteShadow = await read(gym, 'ref-shadow');
      const athleteSpar = await read(gym, 'ref-spar');
      expect(athleteShadow?.universal_stop_rules).toEqual([
        { ordinal: 1, condition_text: INJURY, rule_kind: 'safety', origin: 'universal' },
        { ordinal: 3, condition_text: REWORDED_NEW, rule_kind: 'safety', origin: 'universal' },
      ]);
      expect(athleteSpar?.universal_stop_rules.map((rule) => rule.condition_text)).toEqual([INJURY, HEAD_BLOW, REWORDED_NEW]);
      // Instruction only: no id, lineage, version, active flag or targeting.
      expect(Object.keys(athleteSpar?.universal_stop_rules[0] ?? {}).sort()).toEqual([
        'condition_text', 'ordinal', 'origin', 'rule_kind',
      ]);
      expect(athleteShadow?.stop_rules).toEqual([]);
    }

    // The gym's stored-once rules never make a drill adoptable on their own
    // (R3; drillAdoptionReadiness.ts): two apply here, none is the drill's.
    expect(adoptionReadiness({ ...coachShadow!, floor_tested_by_this_gym: true }).missing).toContain('It has no stop rules.');
  });

  test("legacy scope='universal' per-drill rows appear as the drill's own", async () => {
    const gym = await newGym('legacy');
    const otherGym = await newGym('legacy-other');
    await insertReference(gym, { drillId: 'ref-catch', name: 'Catch and Return', contactLevel: 'light_technical' });
    await promote(gym, 'ref-catch', 'Catch and Return');
    // The seeded corpus shape: a generic line labelled scope='universal' on
    // this drill, beside a drill-specific one.
    await insertOwnStopRule(gym, 'ref-catch', {
      stopRuleId: 'stp-chasing', ordinal: 1, text: 'Stop when chasing replaces positioning.', scope: 'universal', kind: 'intent_drift',
    });
    await insertOwnStopRule(gym, 'ref-catch', {
      stopRuleId: 'stp-glove', ordinal: 2, text: 'Stop when the glove stops meeting the punch.', scope: 'drill_specific', kind: 'technique_degradation',
    });
    await insertUniversalRule(gym, { ruleId: 'ust_injury', ordinal: 1, text: INJURY });
    await insertUniversalRule(otherGym, { ruleId: 'ust_injury', ordinal: 1, text: 'Another gym only.' });

    const coach = await getDrillWithDetail(gym, 'ref-catch');
    if (!coach) throw new Error('test bug: the reference should be readable');
    expect(coach.stop_rules.map((rule) => [rule.stop_rule_id, rule.scope, rule.origin])).toEqual([
      ['stp-chasing', 'universal', 'drill'],
      ['stp-glove', 'drill_specific', 'drill'],
    ]);
    expect(coach.universal_stop_rules.map((rule) => [rule.universal_rule_id, rule.origin])).toEqual([
      ['ust_injury', 'universal'],
    ]);

    const athlete = await getAthleteDrillDetail(gym, 'ref-catch');
    if (!athlete) throw new Error('test bug: the promoted drill should be readable');
    expect(athlete.stop_rules).toEqual([
      { ordinal: 1, condition_text: 'Stop when chasing replaces positioning.', scope: 'universal', rule_kind: 'intent_drift', origin: 'drill' },
      { ordinal: 2, condition_text: 'Stop when the glove stops meeting the punch.', scope: 'drill_specific', rule_kind: 'technique_degradation', origin: 'drill' },
    ]);
    expect(athlete.universal_stop_rules).toEqual([
      { ordinal: 1, condition_text: INJURY, rule_kind: 'safety', origin: 'universal' },
    ]);

    // What both audiences' screens group by (DrillDetail.tsx): the labelled
    // row is the drill's own, and only the stored-once rule is for every drill.
    const expectedView = [
      { ordinal: 1, text: 'Stop when chasing replaces positioning.', origin: 'drill', kind: 'intent_drift' },
      { ordinal: 2, text: 'Stop when the glove stops meeting the punch.', origin: 'drill', kind: 'technique_degradation' },
      { ordinal: 1, text: INJURY, origin: 'universal', kind: 'safety' },
    ];
    expect(fromCoachDrillDetail(coach).stopRules).toEqual(expectedView);
    expect(fromAthleteDrillDetail(athlete).stopRules).toEqual(expectedView);

    // And they count for adoption: the legacy-labelled row is the drill's own.
    expect(adoptionReadiness({ ...coach, floor_tested_by_this_gym: true }).missing).not.toContain('It has no stop rules.');
  });
});

describe('claim tags never reach an athlete (real database)', () => {
  test('athlete text strips [PS-012] and [CB-003]', async () => {
    const gym = await newGym('tags');
    await insertReference(gym, { drillId: 'ref-tags', name: 'Tagged Drill' });
    await promote(gym, 'ref-tags', 'Tagged Drill');
    await client.query(
      `update pilot.drill_library
          set what_good_looks_like = 'Hands home [PS-012]',
              what_bad_looks_like = 'Hands drop [CB-003][A2-070]',
              common_errors = 'Pawing the jab [PS-001]',
              corrections = 'Coach calls home [CB-003].'
        where organization_id = $1 and drill_id = $2`,
      [gym, 'ref-tags'],
    );
    // Stop-rule text is prose the content validator accepts tags in too
    // (validate.ts inline-claim check over text() columns): the drill's own
    // rule and a stored-once rule, each tagged.
    await insertOwnStopRule(gym, 'ref-tags', {
      stopRuleId: 'stp-tagged', ordinal: 1, text: 'Stop when the hands drop [PS-012].', scope: 'drill_specific', kind: 'technique_degradation',
    });
    await insertUniversalRule(gym, { ruleId: 'ust_tagged', ordinal: 1, text: 'Stop on any sign of injury [CB-003]' });

    // CONTROL: the tags really are in the row -- the coach read is unprojected.
    const coach = await getDrillWithDetail(gym, 'ref-tags');
    expect(coach?.what_good_looks_like).toBe('Hands home [PS-012]');
    expect(coach?.what_bad_looks_like).toBe('Hands drop [CB-003][A2-070]');
    expect(coach?.stop_rules.map((rule) => rule.condition_text)).toEqual(['Stop when the hands drop [PS-012].']);
    expect(coach?.universal_stop_rules.map((rule) => rule.condition_text)).toEqual(['Stop on any sign of injury [CB-003]']);

    for (const read of [getAthleteDrillDetail, getAthleteDrillDetailForOpenWork]) {
      const athlete = await read(gym, 'ref-tags');
      expect(athlete?.what_good_looks_like).toBe('Hands home');
      expect(athlete?.what_bad_looks_like).toBe('Hands drop');
      expect(athlete?.common_errors).toBe('Pawing the jab');
      expect(athlete?.corrections).toBe('Coach calls home.');
      expect(athlete?.stop_rules.map((rule) => rule.condition_text)).toEqual(['Stop when the hands drop.']);
      expect(athlete?.universal_stop_rules.map((rule) => rule.condition_text)).toEqual(['Stop on any sign of injury']);
      expect(JSON.stringify(athlete)).not.toMatch(/\[[A-Z][A-Z0-9]-\d{3}\]/);
    }
  });
});

describe('a gym updates its drill to the newer reference version in place (OD-2026-10-08-008 D1, real database)', () => {
  const RETIRED_MESSAGE =
    'This drill is retired, so it cannot be updated to the newer version. Restore the drill first.';
  const CONTENT = {
    name: 'Jab Return',
    category: 'footwork',
    focus: 'Jab Return v2 purpose.',
    cues: ['Hand home first'],
    difficulty: 'intermediate' as const,
  };

  function updateTo(organizationId: string, drillId: string, referenceDrillId = 'ref-jab-v2', content = CONTENT) {
    return updateDrillToReferenceVersion({
      organizationId,
      drillId,
      referenceDrillId,
      content,
      actorAccountId: 'acct-coach',
      actorRole: 'coach',
    });
  }

  /** A gym that adopted v1 of a reference drill that has since been revised to v2. */
  async function gymOnV1(label: string): Promise<{ gym: string; rootId: string }> {
    const gym = await newGym(label);
    await insertReference(gym, { drillId: 'ref-jab-v1', name: 'Jab Return', lineageId: 'lin-jab' });
    const rootId = await promote(gym, 'ref-jab-v1', 'Jab Return');
    await revise(gym, 'ref-jab-v1', { drillId: 'ref-jab-v2' });
    return { gym, rootId };
  }

  async function versionsOf(gym: string, lineageId: string) {
    const { rows } = await client.query(
      `select version, drill_id, active, reference_drill_id, supersedes_drill_id, superseded_by_drill_id,
              superseded_at is not null as superseded
       from pilot.drills where organization_id = $1 and lineage_id = $2 order by version`,
      [gym, lineageId],
    );
    return rows;
  }

  async function auditRowsFor(gym: string) {
    const { rows } = await client.query(
      `select event_type, actor_account_id, actor_role, entity_type, entity_id, details
       from pilot.audit_events where organization_id = $1 and event_type = 'update' order by audit_id`,
      [gym],
    );
    return rows;
  }

  test('writes a new version of the SAME gym drill pointing at the newer reference; the old one is kept as history', async () => {
    const { gym, rootId } = await gymOnV1('update');
    // A coach's own edit on the old version (Q2 "Start clean"): it stays there.
    await updateDrill({ organizationId: gym, drillId: rootId, focus: 'Our own wording.' });

    const { drill, previous } = await updateTo(gym, rootId);

    expect(previous.drill_id).toBe(rootId);
    expect(drill).toMatchObject({
      organization_id: gym,
      lineage_id: rootId,
      version: 2,
      active: true,
      supersedes_drill_id: rootId,
      reference_drill_id: 'ref-jab-v2',
      name: 'Jab Return',
      focus: 'Jab Return v2 purpose.',
      cues: ['Hand home first'],
    });
    expect(await versionsOf(gym, rootId)).toEqual([
      {
        version: 1, drill_id: rootId, active: false, reference_drill_id: 'ref-jab-v1',
        supersedes_drill_id: null, superseded_by_drill_id: drill.drill_id, superseded: true,
      },
      {
        version: 2, drill_id: drill.drill_id, active: true, reference_drill_id: 'ref-jab-v2',
        supersedes_drill_id: rootId, superseded_by_drill_id: null, superseded: false,
      },
    ]);
    // The coach's edit is history on v1, not carried into v2.
    const { rows: old } = await client.query(
      `select focus from pilot.drills where organization_id = $1 and drill_id = $2`,
      [gym, rootId],
    );
    expect(old[0].focus).toBe('Our own wording.');

    // One audit row, on the same write, saying what moved.
    expect(await auditRowsFor(gym)).toEqual([
      {
        event_type: 'update',
        actor_account_id: 'acct-coach',
        actor_role: 'coach',
        entity_type: 'drill',
        entity_id: drill.drill_id,
        details: {
          action: 'reference_version_update',
          lineage_id: rootId,
          version: 2,
          from_drill_id: rootId,
          from_reference_drill_id: 'ref-jab-v1',
          reference_drill_id: 'ref-jab-v2',
          name: 'Jab Return',
          category: 'footwork',
          difficulty: 'intermediate',
        },
      },
    ]);

    // Q1: the version the gym moved on from reads as the gym's running drill,
    // never "retired", and both versions lead to the drill it runs now.
    expect(await lifecyclesOf(gym, ['ref-jab-v1', 'ref-jab-v2'])).toEqual({
      'ref-jab-v1': { state: 'operational', operational_drill_id: drill.drill_id },
      'ref-jab-v2': { state: 'operational', operational_drill_id: drill.drill_id },
    });
  });

  test('a retired drill is refused, DRILL_RETIRED, and nothing is written', async () => {
    const { gym, rootId } = await gymOnV1('update-retired');
    await updateDrill({ organizationId: gym, drillId: rootId, active: false });
    const before = await versionsOf(gym, rootId);

    await expect(updateTo(gym, rootId)).rejects.toMatchObject({
      message: RETIRED_MESSAGE,
      code: 'DRILL_RETIRED',
      status: 409,
    });
    expect(await versionsOf(gym, rootId)).toEqual(before);
    expect(await auditRowsFor(gym)).toEqual([]);
  });

  test('a drill refined by the gym is updated from its newest version, and the refinement is kept', async () => {
    const { gym, rootId } = await gymOnV1('update-refined');
    await refineOperational(gym, rootId, 'op-jab-refined');

    const { drill, previous } = await updateTo(gym, rootId);

    expect(previous.drill_id).toBe('op-jab-refined');
    expect((await versionsOf(gym, rootId)).map((row) => [row.version, row.active, row.reference_drill_id])).toEqual([
      [1, false, 'ref-jab-v1'],
      [2, false, 'ref-jab-v1'],
      [3, true, 'ref-jab-v2'],
    ]);
    expect(drill.supersedes_drill_id).toBe('op-jab-refined');
  });

  test('the legacy shape (an earlier version running, the newest not) is in use, not retired: updated, and one version runs after', async () => {
    const { gym, rootId } = await gymOnV1('update-legacy');
    await refineOperational(gym, rootId, 'op-jab-2');
    // Two statements: one active row per name is checked row by row.
    await client.query(`update pilot.drills set active = false where organization_id = $1 and drill_id = 'op-jab-2'`, [gym]);
    await client.query(`update pilot.drills set active = true where organization_id = $1 and drill_id = $2`, [gym, rootId]);

    const { previous } = await updateTo(gym, rootId);

    expect(previous.drill_id).toBe('op-jab-2');
    expect((await versionsOf(gym, rootId)).map((row) => [row.version, row.active])).toEqual([
      [1, false],
      [2, false],
      [3, true],
    ]);
  });

  test('a gym already on that version is told so, and no second version is written', async () => {
    const { gym, rootId } = await gymOnV1('update-twice');
    await updateTo(gym, rootId);

    await expect(updateTo(gym, rootId)).rejects.toBeInstanceOf(ReferenceDrillAlreadyPromotedError);
    expect((await versionsOf(gym, rootId)).length).toBe(2);
    expect((await auditRowsFor(gym)).length).toBe(1);
  });

  test("a name another of the gym's drills holds is refused as the name clash, and nothing is written", async () => {
    const { gym, rootId } = await gymOnV1('update-name');
    await createDrill({ organizationId: gym, name: 'Jab Return Plus', category: 'footwork', focus: 'Theirs.' });
    const before = await versionsOf(gym, rootId);

    await expect(updateTo(gym, rootId, 'ref-jab-v2', { ...CONTENT, name: 'Jab Return Plus' }))
      .rejects.toBeInstanceOf(DrillNameTakenError);
    expect(await versionsOf(gym, rootId)).toEqual(before);
    expect(await auditRowsFor(gym)).toEqual([]);
  });

  test('a reference drill outside the lineage the gym pins is not written', async () => {
    const { gym, rootId } = await gymOnV1('update-wrong-lineage');
    await insertReference(gym, { drillId: 'ref-hook', name: 'Hook Return', lineageId: 'lin-hook' });
    const before = await versionsOf(gym, rootId);

    await expect(updateTo(gym, rootId, 'ref-hook')).rejects.toThrow('REFERENCE_VERSION_NOT_IN_DRILL_LINEAGE');
    expect(await versionsOf(gym, rootId)).toEqual(before);
  });

  test("another gym holding the very same ids is untouched, and still sees the newer version as available to it", async () => {
    const { gym, rootId } = await gymOnV1('update-gym-a');
    const other = await newGym('update-gym-b');
    await insertReference(other, { drillId: 'ref-jab-v1', name: 'Jab Return', lineageId: 'lin-jab' });
    const otherRoot = await promote(other, 'ref-jab-v1', 'Jab Return');
    await revise(other, 'ref-jab-v1', { drillId: 'ref-jab-v2' });
    const otherBefore = await versionsOf(other, otherRoot);

    await updateTo(gym, rootId);

    expect(await versionsOf(other, otherRoot)).toEqual(otherBefore);
    expect(await lifecyclesOf(other, ['ref-jab-v1', 'ref-jab-v2'])).toEqual({
      'ref-jab-v1': { state: 'operational', operational_drill_id: otherRoot },
      'ref-jab-v2': { state: 'newer_version_available', operational_drill_id: otherRoot },
    });
    // And the other gym's own drill id, handed to this gym's update, names nothing here.
    await expect(updateTo(gym, otherRoot)).rejects.toThrow('DRILL_NOT_FOUND');
  });

  test('retired after the update: both versions read retired and Restore brings back the drill the gym ran last', async () => {
    const { gym, rootId } = await gymOnV1('update-then-retire');
    const { drill } = await updateTo(gym, rootId);
    await updateDrill({ organizationId: gym, drillId: drill.drill_id, active: false });

    expect(await lifecyclesOf(gym, ['ref-jab-v1', 'ref-jab-v2'])).toEqual({
      'ref-jab-v1': { state: 'retired', operational_drill_id: drill.drill_id },
      'ref-jab-v2': { state: 'retired', operational_drill_id: drill.drill_id },
    });
    const restored = await updateDrill({ organizationId: gym, drillId: drill.drill_id, active: true });
    expect(restored?.active).toBe(true);
  });

  test('a Retire that commits while the update waits on the drill is seen: the update refuses and writes nothing', async () => {
    // The retirement is held open on a second real connection, so the update
    // has to wait for the drill's row; what it decides on is what the row says
    // once the retirement commits. The UPDATE is the statement updateDrill
    // issues for a retire, written out to hold the transaction open.
    const { gym, rootId } = await gymOnV1('update-race');
    const retiring = new Client({ connectionString: connectionStringFor(DATABASE_NAME) });
    await retiring.connect();
    try {
      await retiring.query('BEGIN');
      await retiring.query(
        `update pilot.drills set active = false, updated_at = now() where organization_id = $1 and drill_id = $2`,
        [gym, rootId],
      );

      const updating = updateTo(gym, rootId).then(
        () => ({ updated: true, reason: null as unknown }),
        (reason: unknown) => ({ updated: false, reason }),
      );

      // Not a sleep: the retirement commits only once the update is seen
      // waiting on a lock, so the two really did meet on the row.
      let waiting = 0;
      for (let attempt = 0; attempt < 400 && waiting === 0; attempt += 1) {
        const result = await client.query(
          `select count(*)::int as n from pg_stat_activity
           where datname = current_database() and wait_event_type = 'Lock'`,
        );
        waiting = result.rows[0].n;
        if (waiting === 0) await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(waiting).toBe(1);

      await retiring.query('COMMIT');

      const outcome = await updating;
      expect(outcome.updated).toBe(false);
      expect(outcome.reason).toMatchObject({ message: RETIRED_MESSAGE, code: 'DRILL_RETIRED' });
      expect((await versionsOf(gym, rootId)).map((row) => [row.version, row.active])).toEqual([[1, false]]);
      expect(await auditRowsFor(gym)).toEqual([]);
    } finally {
      await retiring.query('ROLLBACK').catch(() => {});
      await retiring.end();
    }
  });
});
