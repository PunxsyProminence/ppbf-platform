// Real PostgreSQL-backed contract test for W-D4C's reference-drill LIFECYCLE
// (OD-2026-09-19-001): drillLibraryV3.ts#listReferenceLifecycles, and the
// RESTORE GUARD drills.ts#updateDrill now carries in its own UPDATE.
//
// WHY A REAL DATABASE. Every property here is a predicate, and a mocked query
// can observe none of them:
//
//   * THE FIVE STATES ARE ONE CASE EXPRESSION over EXISTS subqueries and two
//     reference columns. Which branch wins -- adoption before withdrawal,
//     withdrawal before supersession -- is SQL order, proven on rows where
//     more than one branch is true at once.
//   * THE OPERATIONAL IDENTITY HAS TWO SOURCES, one per branch of a COALESCE.
//     While the gym runs the drill it is the ACTIVE row pointing at the
//     reference (the highest active version) -- the row Retire takes out, even
//     when an earlier version is the active one. Once retired it is the
//     lineage HEAD, found through the lineage ROOT that carries the reference
//     pointer -- the row Restore brings back. A refinement writes a successor
//     that inherits the pointer; only a real lineage shows that the answer is
//     v2 (or v3), not the root, that a retired lineage still names its newest
//     version, and that an active earlier version beats an inactive newer one.
//   * ONE GYM AT A TIME. Reference ids, operational ids and lineage ids are
//     all per-organization keys, so another gym may use the very same
//     strings. Every organization term is proven by a second gym holding the
//     same ids in the state that would change the answer if the term went
//     missing: adopted where this gym is not, a higher version in a lineage of
//     the same id -- active, and read both while this gym runs its drill (the
//     live branch) and after it retired it (the head branch) -- and an active
//     copy of a withdrawn reference.
//   * THE RESTORE GUARD LIVES IN THE WHERE CLAUSE, so a refused restore is an
//     UPDATE that matched nothing. What proves "refused" is that the rows are
//     byte-for-byte what they were -- updated_at included -- and that no row
//     was added, not merely that an error was thrown.
//   * A NAME COLLISION IS pilot_drills_one_name_per_org, a partial unique
//     index on active rows. A restore sends no name, so the drill named in the
//     error has to be read back after the failed statement.
//
// ISOLATION WITHOUT TRANSACTIONS. The schema is built once, in beforeAll, and
// every test seeds its own gym(s) under a fresh organization id. Tests are
// NOT wrapped in BEGIN/ROLLBACK, deliberately: after a unique violation
// updateDrill reads the drill again to name it, and inside an outer
// transaction that read would hit "current transaction is aborted" -- a
// failure production (autocommit, pooled) can never have. A fresh gym per
// test gives the same independence without changing what the code sees.
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

import { listReferenceLifecycles, type ReferenceLifecycle } from './drillLibraryV3';
import {
  createDrill,
  DrillNameTakenError,
  DrillRestoreRefusedError,
  promoteReferenceDrill,
  updateDrill,
  type RestoreRefusal,
} from './drills';

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-drill-lifecycle-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const DATABASE_NAME = 'ppbf_test_wd4c_drill_lifecycle';

/**
 * Every key a PilotDrill carries, written out rather than imported: the
 * UPDATE's RETURNING list is now built by prefixing each column with the
 * table alias, and a column lost or renamed in that rewrite must show here.
 */
const PILOT_DRILL_KEYS = [
  'active', 'category', 'created_at', 'cues', 'difficulty', 'drill_id', 'focus', 'name',
  'organization_id', 'reference_drill_id', 'updated_at',
];

/** The refusal copy, written out so a changed message is a visible change here. */
const REFUSAL_MESSAGES: Record<RestoreRefusal, string> = {
  not_latest_version: 'This is an earlier version of the drill. Restore its newest version instead.',
  another_version_active: 'Another version of this drill is already in use in this gym.',
  reference_withdrawn: "This drill's reference has been withdrawn, so it cannot be restored.",
  state_changed: 'This drill changed while it was being restored. Reload the page and try again.',
};

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

/**
 * A fresh gym for one test. Every test gets its own, so nothing one test
 * writes is visible to another -- and ids can be reused across gyms on purpose.
 */
async function newGym(label: string): Promise<string> {
  gymCount += 1;
  const organizationId = `org-wd4c-${label}-${gymCount}`;
  await client.query(
    `insert into pilot.organizations (organization_id, organization_name, status)
     values ($1, $1, 'active')`,
    [organizationId],
  );
  // pilot.drill_library.discipline references pilot.disciplines.
  await client.query(
    `insert into pilot.disciplines (organization_id, discipline, display_name, lane, exposure_model)
     values ($1, 'boxing', 'Boxing', 'striking', 'head_impact')`,
    [organizationId],
  );
  return organizationId;
}

/**
 * One reference drill VERSION. No children: neither the lifecycle read nor the
 * restore guard looks at scale levels, stop rules or cues, and adoption
 * readiness is the promote route's check, not these functions'.
 */
async function insertReference(
  organizationId: string,
  opts: {
    drillId: string;
    name: string;
    active?: boolean;
    superseded?: boolean;
    lineageId?: string;
    version?: number;
    supersedesDrillId?: string | null;
  },
): Promise<void> {
  await client.query(
    `insert into pilot.drill_library
       (organization_id, drill_id, lineage_id, version, supersedes_drill_id, superseded_at, name,
        discipline, category, difficulty, target_behavior, purpose, standard_setup, execution,
        what_good_looks_like, what_bad_looks_like, active)
     values ($1,$2,$3,$4,$5,case when $6::boolean then now() else null end,$7,
             'boxing','footwork','intermediate', $7 || ' target.', $7 || ' purpose.', $7 || ' setup.',
             $7 || ' execution.', $7 || ' good.', $7 || ' bad.', $8)`,
    [
      organizationId,
      opts.drillId,
      opts.lineageId ?? opts.drillId,
      opts.version ?? 1,
      opts.supersedesDrillId ?? null,
      opts.superseded ?? false,
      opts.name,
      opts.active ?? true,
    ],
  );
}

async function setReferenceActive(organizationId: string, drillId: string, active: boolean): Promise<void> {
  await client.query(
    `update pilot.drill_library set active = $3 where organization_id = $1 and drill_id = $2`,
    [organizationId, drillId, active],
  );
}

/**
 * An operational drill written RAW, for the shapes no current writer produces
 * on demand: a chosen drill id shared with another gym, or an earlier version
 * active beside an inactive newer one.
 */
async function insertOperationalDrill(
  organizationId: string,
  opts: {
    drillId: string;
    name: string;
    referenceDrillId?: string | null;
    active?: boolean;
    supersedesDrillId?: string | null;
    lineageId?: string;
    version?: number;
  },
): Promise<void> {
  await client.query(
    `insert into pilot.drills
       (organization_id, drill_id, name, category, focus, active, lineage_id,
        supersedes_drill_id, reference_drill_id, version)
     values ($1,$2,$3,'bagwork','Focus.',$4,$5,$6,$7,$8)`,
    [
      organizationId,
      opts.drillId,
      opts.name,
      opts.active ?? true,
      opts.lineageId ?? opts.drillId,
      opts.supersedesDrillId ?? null,
      opts.referenceDrillId ?? null,
      opts.version ?? 1,
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
 * A refinement, written the way adoptDrillChangeProposal writes it
 * (drillVersioning.ts): the current version deactivated and stamped
 * superseded, the successor inserted active with the SAME lineage and the
 * SAME reference pointer, then the old row pointed at it.
 */
async function refine(organizationId: string, currentDrillId: string, newDrillId: string): Promise<void> {
  const { rows } = await client.query<{ lineage_id: string; version: number; name: string; reference_drill_id: string | null }>(
    `update pilot.drills set active = false, superseded_at = now(), updated_at = now()
     where organization_id = $1 and drill_id = $2
     returning lineage_id, version, name, reference_drill_id`,
    [organizationId, currentDrillId],
  );
  if (!rows[0]) throw new Error(`test bug: ${currentDrillId} is not in ${organizationId}`);
  await insertOperationalDrill(organizationId, {
    drillId: newDrillId,
    name: rows[0].name,
    referenceDrillId: rows[0].reference_drill_id,
    supersedesDrillId: currentDrillId,
    lineageId: rows[0].lineage_id,
    version: rows[0].version + 1,
  });
  await client.query(
    `update pilot.drills set superseded_by_drill_id = $3 where organization_id = $1 and drill_id = $2`,
    [organizationId, currentDrillId, newDrillId],
  );
}

async function lifecycleOf(organizationId: string, referenceDrillId: string): Promise<ReferenceLifecycle | undefined> {
  return (await listReferenceLifecycles(organizationId, [referenceDrillId]))[referenceDrillId];
}

/** Every column of every operational row in this gym, updated_at included, in a stable order. */
async function drillRows(organizationId: string): Promise<Record<string, unknown>[]> {
  const { rows } = await client.query(
    `select * from pilot.drills where organization_id = $1 order by lineage_id, version, drill_id`,
    [organizationId],
  );
  return rows;
}

async function activeOf(organizationId: string, drillId: string): Promise<boolean | undefined> {
  const { rows } = await client.query<{ active: boolean }>(
    `select active from pilot.drills where organization_id = $1 and drill_id = $2`,
    [organizationId, drillId],
  );
  return rows[0]?.active;
}

/** The restore a coach's Restore button sends: active:true and nothing else. */
function restore(organizationId: string, drillId: string) {
  return updateDrill({ organizationId, drillId, active: true });
}

function retire(organizationId: string, drillId: string) {
  return updateDrill({ organizationId, drillId, active: false });
}

/**
 * The restore is refused with exactly this reason and message, and NOTHING in
 * the gym changed: same rows, same values, same updated_at, no row added.
 */
async function expectRefusedAndUnchanged(
  organizationId: string,
  drillId: string,
  reason: RestoreRefusal,
): Promise<void> {
  const before = await drillRows(organizationId);
  let thrown: unknown;
  try {
    await restore(organizationId, drillId);
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(DrillRestoreRefusedError);
  expect((thrown as DrillRestoreRefusedError).reason).toBe(reason);
  expect((thrown as DrillRestoreRefusedError).message).toBe(REFUSAL_MESSAGES[reason]);
  expect(await drillRows(organizationId)).toEqual(before);
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
  /* THE WHOLE SCHEMA, not a hand-picked subset (see scripts/lib/full-schema.mjs).
     Both functions cross the drills, versioning, provenance and v3 library
     migrations, the partial name index and the discipline foreign key. */
  await applyFullSchema(client, { infraDir: INFRA_DIR });
  activeClient = client;
});

afterAll(async () => {
  activeClient = null;
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
  // Retrying on EBUSY/EPERM keeps the data directory from leaking on a
  // passing run.
  await fs.rm(DATA_DIR, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }).catch(() => {});
});

describe('listReferenceLifecycles: where a reference drill stands in one gym (real database)', () => {
  test('available: an active, current reference this gym never adopted', async () => {
    const gym = await newGym('available');
    await insertReference(gym, { drillId: 'ref-available', name: 'Pivot Out' });

    expect(await lifecycleOf(gym, 'ref-available')).toEqual({ state: 'available', operational_drill_id: null });
  });

  test('operational: promoted through the production writer, and the operational drill is live', async () => {
    const gym = await newGym('operational');
    await insertReference(gym, { drillId: 'ref-operational', name: 'Jab Return' });
    const operationalId = await promote(gym, 'ref-operational', 'Jab Return');

    expect(await lifecycleOf(gym, 'ref-operational')).toEqual({
      state: 'operational',
      operational_drill_id: operationalId,
    });
  });

  test('retired: the promotion was retired, so the reference reads as adopted-and-retired, not available', async () => {
    const gym = await newGym('retired');
    await insertReference(gym, { drillId: 'ref-retired', name: 'Slip Line' });
    const operationalId = await promote(gym, 'ref-retired', 'Slip Line');
    await retire(gym, operationalId);

    expect(await lifecycleOf(gym, 'ref-retired')).toEqual({ state: 'retired', operational_drill_id: operationalId });
  });

  test('superseded: not adopted, and a newer version of the reference exists; the newer version is available', async () => {
    const gym = await newGym('superseded');
    await insertReference(gym, { drillId: 'ref-sup-v1', name: 'Hook Off The Jab', superseded: true });
    await insertReference(gym, {
      drillId: 'ref-sup-v2',
      name: 'Hook Off The Jab, revised',
      lineageId: 'ref-sup-v1',
      version: 2,
      supersedesDrillId: 'ref-sup-v1',
    });

    expect(await listReferenceLifecycles(gym)).toEqual({
      'ref-sup-v1': { state: 'superseded', operational_drill_id: null },
      'ref-sup-v2': { state: 'available', operational_drill_id: null },
    });
  });

  test('unavailable: not adopted and withdrawn -- and withdrawal wins over supersession when both hold', async () => {
    const gym = await newGym('unavailable');
    await insertReference(gym, { drillId: 'ref-withdrawn', name: 'Withdrawn Drill', active: false });
    await insertReference(gym, {
      drillId: 'ref-withdrawn-and-superseded',
      name: 'Withdrawn Old Drill',
      active: false,
      superseded: true,
    });

    expect(await listReferenceLifecycles(gym)).toEqual({
      'ref-withdrawn': { state: 'unavailable', operational_drill_id: null },
      'ref-withdrawn-and-superseded': { state: 'unavailable', operational_drill_id: null },
    });
  });

  test('adoption comes first: an adopted reference reads operational or retired even when superseded or withdrawn', async () => {
    const gym = await newGym('adoption-first');
    await insertReference(gym, { drillId: 'ref-sup-live', name: 'Superseded Live', superseded: true });
    await insertReference(gym, { drillId: 'ref-sup-retired', name: 'Superseded Retired', superseded: true });
    await insertReference(gym, { drillId: 'ref-wd-live', name: 'Withdrawn Live' });
    await insertReference(gym, { drillId: 'ref-wd-retired', name: 'Withdrawn Retired' });
    const supLive = await promote(gym, 'ref-sup-live', 'Superseded Live');
    const supRetired = await promote(gym, 'ref-sup-retired', 'Superseded Retired');
    const wdLive = await promote(gym, 'ref-wd-live', 'Withdrawn Live');
    const wdRetired = await promote(gym, 'ref-wd-retired', 'Withdrawn Retired');
    await retire(gym, supRetired);
    await retire(gym, wdRetired);
    // Withdrawn AFTER adoption: promotion refuses an inactive reference, but a
    // reference can be withdrawn under a gym that already runs it.
    await setReferenceActive(gym, 'ref-wd-live', false);
    await setReferenceActive(gym, 'ref-wd-retired', false);

    expect(await listReferenceLifecycles(gym)).toEqual({
      'ref-sup-live': { state: 'operational', operational_drill_id: supLive },
      'ref-sup-retired': { state: 'retired', operational_drill_id: supRetired },
      'ref-wd-live': { state: 'operational', operational_drill_id: wdLive },
      'ref-wd-retired': { state: 'retired', operational_drill_id: wdRetired },
    });
  });

  test('operational_drill_id is the lineage HEAD: v2 after one refinement, v3 after two -- never the root', async () => {
    const gym = await newGym('head');
    await insertReference(gym, { drillId: 'ref-head', name: 'Step Drag' });
    const v1 = await promote(gym, 'ref-head', 'Step Drag');

    await refine(gym, v1, 'op-head-v2');
    expect(await lifecycleOf(gym, 'ref-head')).toEqual({ state: 'operational', operational_drill_id: 'op-head-v2' });

    await refine(gym, 'op-head-v2', 'op-head-v3');
    expect(await lifecycleOf(gym, 'ref-head')).toEqual({ state: 'operational', operational_drill_id: 'op-head-v3' });

    // The chain really is v1 -> v2 -> v3, only v3 active, every version carrying the pointer.
    const { rows } = await client.query(
      `select drill_id, version, active, reference_drill_id from pilot.drills
       where organization_id = $1 order by version`,
      [gym],
    );
    expect(rows).toEqual([
      { drill_id: v1, version: 1, active: false, reference_drill_id: 'ref-head' },
      { drill_id: 'op-head-v2', version: 2, active: false, reference_drill_id: 'ref-head' },
      { drill_id: 'op-head-v3', version: 3, active: true, reference_drill_id: 'ref-head' },
    ]);
  });

  test('a retired lineage names its HIGHEST version -- the identity Restore brings back', async () => {
    const gym = await newGym('retired-head');
    await insertReference(gym, { drillId: 'ref-retired-head', name: 'Roll Under' });
    const v1 = await promote(gym, 'ref-retired-head', 'Roll Under');
    await refine(gym, v1, 'op-retired-head-v2');
    await retire(gym, 'op-retired-head-v2');

    expect(await activeOf(gym, v1)).toBe(false);
    expect(await lifecycleOf(gym, 'ref-retired-head')).toEqual({
      state: 'retired',
      operational_drill_id: 'op-retired-head-v2',
    });
  });

  test('an ACTIVE earlier version beside an inactive newer one: operational names the active v1 (what Retire takes out); retired names the head v2 (what Restore brings back)', async () => {
    const gym = await newGym('live-earlier');
    await insertReference(gym, { drillId: 'ref-live-earlier', name: 'Half Step' });
    // RAW, the pre-guard reinstated shape: v1 active, its newer v2 inactive,
    // BOTH carrying the reference pointer.
    await insertOperationalDrill(gym, { drillId: 'op-le-v1', name: 'Half Step', referenceDrillId: 'ref-live-earlier' });
    await insertOperationalDrill(gym, {
      drillId: 'op-le-v2',
      name: 'Half Step',
      referenceDrillId: 'ref-live-earlier',
      active: false,
      supersedesDrillId: 'op-le-v1',
      lineageId: 'op-le-v1',
      version: 2,
    });

    // The live row, not the head: naming v2 here would point Retire at a row
    // that is already retired and leave v1 running.
    expect(await lifecycleOf(gym, 'ref-live-earlier')).toEqual({ state: 'operational', operational_drill_id: 'op-le-v1' });

    // Retire acts on the id the lifecycle named.
    await expect(updateDrill({ organizationId: gym, drillId: 'op-le-v1', active: false }))
      .resolves.toMatchObject({ drill_id: 'op-le-v1', active: false });
    expect(await activeOf(gym, 'op-le-v2')).toBe(false);

    // Nothing is live any more, so the answer is the lineage head -- the only
    // version the restore guard lets back.
    expect(await lifecycleOf(gym, 'ref-live-earlier')).toEqual({ state: 'retired', operational_drill_id: 'op-le-v2' });
    await expect(restore(gym, 'op-le-v2')).resolves.toMatchObject({ drill_id: 'op-le-v2', active: true });
    expect(await activeOf(gym, 'op-le-v1')).toBe(false);
    expect(await lifecycleOf(gym, 'ref-live-earlier')).toEqual({ state: 'operational', operational_drill_id: 'op-le-v2' });
  });

  test('two ACTIVE versions in one lineage: operational names the HIGHEST active version -- not the root, not the inactive head', async () => {
    const gym = await newGym('live-highest');
    await insertReference(gym, { drillId: 'ref-live-highest', name: 'Cut Off' });
    // RAW: v1 and v2 both active (a refinement renamed the drill, so the
    // active-name index lets both stand), v3 inactive.
    await insertOperationalDrill(gym, { drillId: 'op-lh-v1', name: 'Cut Off', referenceDrillId: 'ref-live-highest' });
    await insertOperationalDrill(gym, {
      drillId: 'op-lh-v2',
      name: 'Cut Off, Angled',
      referenceDrillId: 'ref-live-highest',
      supersedesDrillId: 'op-lh-v1',
      lineageId: 'op-lh-v1',
      version: 2,
    });
    await insertOperationalDrill(gym, {
      drillId: 'op-lh-v3',
      name: 'Cut Off, Angled',
      referenceDrillId: 'ref-live-highest',
      active: false,
      supersedesDrillId: 'op-lh-v2',
      lineageId: 'op-lh-v1',
      version: 3,
    });

    expect(await lifecycleOf(gym, 'ref-live-highest')).toEqual({ state: 'operational', operational_drill_id: 'op-lh-v2' });
  });

  test('drillIds narrows to the named ids this gym has; omitted, it is every reference of this gym and no other', async () => {
    const gym = await newGym('filter');
    const otherGym = await newGym('filter-other');
    for (const drillId of ['ref-f-1', 'ref-f-2', 'ref-f-3']) {
      await insertReference(gym, { drillId, name: `Name ${drillId}` });
    }
    await insertReference(otherGym, { drillId: 'ref-f-other-only', name: 'Other Gym Only' });

    expect(Object.keys(await listReferenceLifecycles(gym, ['ref-f-2', 'ref-f-missing', 'ref-f-other-only'])))
      .toEqual(['ref-f-2']);
    expect(Object.keys(await listReferenceLifecycles(gym)).sort()).toEqual(['ref-f-1', 'ref-f-2', 'ref-f-3']);
    expect(await listReferenceLifecycles(gym, [])).toEqual({});
    expect(Object.keys(await listReferenceLifecycles(otherGym))).toEqual(['ref-f-other-only']);
  });
});

describe('listReferenceLifecycles is read in the asking gym only (real database)', () => {
  test("another gym adopting, retiring or running the same reference id never changes this gym's state", async () => {
    const gym = await newGym('scope-a');
    const otherGym = await newGym('scope-b');
    await insertReference(gym, { drillId: 'ref-shared', name: 'Shared Drill' });
    await insertReference(otherGym, { drillId: 'ref-shared', name: 'Shared Drill' });

    const otherOperational = await promote(otherGym, 'ref-shared', 'Shared Drill');
    expect(await lifecycleOf(gym, 'ref-shared')).toEqual({ state: 'available', operational_drill_id: null });
    expect(await lifecycleOf(otherGym, 'ref-shared')).toEqual({
      state: 'operational',
      operational_drill_id: otherOperational,
    });

    await retire(otherGym, otherOperational);
    expect(await lifecycleOf(gym, 'ref-shared')).toEqual({ state: 'available', operational_drill_id: null });

    const ownOperational = await promote(gym, 'ref-shared', 'Shared Drill');
    expect(await lifecycleOf(gym, 'ref-shared')).toEqual({ state: 'operational', operational_drill_id: ownOperational });
    expect(await lifecycleOf(otherGym, 'ref-shared')).toEqual({
      state: 'retired',
      operational_drill_id: otherOperational,
    });
  });

  test('the live row AND the lineage head are found in this gym only, though another gym has the same operational and lineage ids with a higher, active version', async () => {
    const gym = await newGym('head-scope-a');
    const otherGym = await newGym('head-scope-b');
    await insertReference(gym, { drillId: 'ref-head-shared', name: 'Shared Head' });
    await insertReference(otherGym, { drillId: 'ref-head-shared', name: 'Shared Head' });
    // This gym: the root refined once, so its head (v2) is not its root.
    await insertOperationalDrill(gym, { drillId: 'op-head-shared', name: 'Shared Head', referenceDrillId: 'ref-head-shared' });
    await refine(gym, 'op-head-shared', 'op-head-shared-v2');
    // The other gym: the SAME root id (so the same lineage id), refined twice
    // to a LIVE v3 -- a higher version than anything in this gym, and active,
    // so it wins any lookup that loses its organization term.
    await insertOperationalDrill(otherGym, {
      drillId: 'op-head-shared',
      name: 'Shared Head',
      referenceDrillId: 'ref-head-shared',
    });
    await refine(otherGym, 'op-head-shared', 'op-head-shared-other-v2');
    await refine(otherGym, 'op-head-shared-other-v2', 'op-head-shared-other-v3');

    // THE LIVE BRANCH: each gym runs its drill, so each answer is that gym's
    // own active row.
    expect(await lifecycleOf(gym, 'ref-head-shared')).toEqual({
      state: 'operational',
      operational_drill_id: 'op-head-shared-v2',
    });
    expect(await lifecycleOf(otherGym, 'ref-head-shared')).toEqual({
      state: 'operational',
      operational_drill_id: 'op-head-shared-other-v3',
    });

    // THE HEAD BRANCH. While any row here is active the live branch answers
    // and the lineage-head join never runs, so retire every active row in
    // this gym first. Now the join runs with the other gym's lineage of the
    // same id still holding its higher, active v3.
    await retire(gym, 'op-head-shared-v2');
    const { rows: stillActive } = await client.query(
      `select drill_id from pilot.drills where organization_id = $1 and active`,
      [gym],
    );
    expect(stillActive).toEqual([]);

    expect(await lifecycleOf(gym, 'ref-head-shared')).toEqual({
      state: 'retired',
      operational_drill_id: 'op-head-shared-v2',
    });
    expect(await lifecycleOf(otherGym, 'ref-head-shared')).toEqual({
      state: 'operational',
      operational_drill_id: 'op-head-shared-other-v3',
    });
  });
});

describe('updateDrill restore guard: Restore brings back the same identity, and only that (real database)', () => {
  test('a retired head restores in place: same drill_id, same reference pointer, no new row, operational again', async () => {
    const gym = await newGym('restore-head');
    await insertReference(gym, { drillId: 'ref-restore', name: 'Level Change' });
    const operationalId = await promote(gym, 'ref-restore', 'Level Change');
    await retire(gym, operationalId);
    const rowsBefore = await drillRows(gym);
    expect(rowsBefore).toHaveLength(1);

    const restored = await restore(gym, operationalId);

    expect(restored).not.toBeNull();
    expect(Object.keys(restored!).sort()).toEqual(PILOT_DRILL_KEYS);
    expect(restored).toMatchObject({
      organization_id: gym,
      drill_id: operationalId,
      name: 'Level Change',
      active: true,
      reference_drill_id: 'ref-restore',
    });
    const rowsAfter = await drillRows(gym);
    expect(rowsAfter).toHaveLength(1);
    expect(rowsAfter[0]).toMatchObject({
      drill_id: operationalId,
      active: true,
      reference_drill_id: 'ref-restore',
      version: 1,
      lineage_id: rowsBefore[0].lineage_id,
    });
    expect(await lifecycleOf(gym, 'ref-restore')).toEqual({ state: 'operational', operational_drill_id: operationalId });
  });

  test('a refined lineage restores through its head; the earlier version stays retired', async () => {
    const gym = await newGym('restore-refined');
    await insertReference(gym, { drillId: 'ref-restore-refined', name: 'Catch And Counter' });
    const v1 = await promote(gym, 'ref-restore-refined', 'Catch And Counter');
    await refine(gym, v1, 'op-restore-refined-v2');
    await retire(gym, 'op-restore-refined-v2');

    const restored = await restore(gym, 'op-restore-refined-v2');

    expect(restored).toMatchObject({ drill_id: 'op-restore-refined-v2', active: true, reference_drill_id: 'ref-restore-refined' });
    expect(await activeOf(gym, v1)).toBe(false);
    expect(await drillRows(gym)).toHaveLength(2);
    expect(await lifecycleOf(gym, 'ref-restore-refined')).toEqual({
      state: 'operational',
      operational_drill_id: 'op-restore-refined-v2',
    });
  });

  test('restoring an EARLIER version is refused not_latest_version, and nothing changes -- live head or retired head', async () => {
    const gym = await newGym('restore-earlier');
    await insertReference(gym, { drillId: 'ref-earlier', name: 'Double Jab' });
    const v1 = await promote(gym, 'ref-earlier', 'Double Jab');
    await refine(gym, v1, 'op-earlier-v2');

    // The head is live.
    await expectRefusedAndUnchanged(gym, v1, 'not_latest_version');

    // The whole lineage is retired: no version is active, the reference is
    // active -- the ONLY thing wrong with bringing v1 back is that it is not
    // the newest version.
    await retire(gym, 'op-earlier-v2');
    await expectRefusedAndUnchanged(gym, v1, 'not_latest_version');
    expect(await lifecycleOf(gym, 'ref-earlier')).toEqual({ state: 'retired', operational_drill_id: 'op-earlier-v2' });
  });

  test('restoring the head while an earlier version is active is refused another_version_active, and nothing changes', async () => {
    const gym = await newGym('restore-other-active');
    await insertReference(gym, { drillId: 'ref-other-active', name: 'Shoulder Roll' });
    // RAW: an earlier version active beside the inactive newer one. The guard
    // under test now refuses to build this shape through updateDrill, but rows
    // written before it can still carry it.
    await insertOperationalDrill(gym, { drillId: 'op-oa-v1', name: 'Shoulder Roll', referenceDrillId: 'ref-other-active' });
    await insertOperationalDrill(gym, {
      drillId: 'op-oa-v2',
      name: 'Shoulder Roll',
      referenceDrillId: 'ref-other-active',
      active: false,
      supersedesDrillId: 'op-oa-v1',
      lineageId: 'op-oa-v1',
      version: 2,
    });

    await expectRefusedAndUnchanged(gym, 'op-oa-v2', 'another_version_active');
    expect(await activeOf(gym, 'op-oa-v1')).toBe(true);
  });

  test('restoring when the reference has been withdrawn is refused reference_withdrawn -- another gym\'s active copy of the id does not lift it', async () => {
    const gym = await newGym('restore-withdrawn');
    const otherGym = await newGym('restore-withdrawn-other');
    await insertReference(gym, { drillId: 'ref-restore-withdrawn', name: 'Pull Counter' });
    // The other gym holds the same reference id, ACTIVE.
    await insertReference(otherGym, { drillId: 'ref-restore-withdrawn', name: 'Pull Counter' });
    const operationalId = await promote(gym, 'ref-restore-withdrawn', 'Pull Counter');
    await retire(gym, operationalId);
    await setReferenceActive(gym, 'ref-restore-withdrawn', false);

    await expectRefusedAndUnchanged(gym, operationalId, 'reference_withdrawn');

    // CONTROL: the reference was the only obstacle. Put it back and the same
    // restore goes through.
    await setReferenceActive(gym, 'ref-restore-withdrawn', true);
    await expect(restore(gym, operationalId)).resolves.toMatchObject({ drill_id: operationalId, active: true });
  });

  test('a gym-written drill (no reference) retires and restores through the same guard', async () => {
    const gym = await newGym('restore-hand');
    const drill = await createDrill({ organizationId: gym, name: 'Wall Shadowboxing', category: 'bagwork', focus: 'Tight.' });

    await expect(retire(gym, drill.drill_id)).resolves.toMatchObject({ drill_id: drill.drill_id, active: false });
    const restored = await restore(gym, drill.drill_id);

    expect(restored).toMatchObject({ drill_id: drill.drill_id, active: true, reference_drill_id: null });
    expect(await drillRows(gym)).toHaveLength(1);
  });

  test('active:true on an already-active drill is an ordinary edit -- a name change goes through, even on an earlier version', async () => {
    const gym = await newGym('active-edit');
    await insertReference(gym, { drillId: 'ref-active-edit', name: 'Feint Jab' });
    const operationalId = await promote(gym, 'ref-active-edit', 'Feint Jab');

    await expect(updateDrill({ organizationId: gym, drillId: operationalId, active: true, name: 'Feint Jab, Short' }))
      .resolves.toMatchObject({ drill_id: operationalId, name: 'Feint Jab, Short', active: true });

    // An active EARLIER version (the pre-guard reinstated shape): not the
    // head, but already active, so it is an edit and not a restore.
    await insertOperationalDrill(gym, { drillId: 'op-ae-v1', name: 'Parry Step' });
    await insertOperationalDrill(gym, {
      drillId: 'op-ae-v2',
      name: 'Parry Step',
      active: false,
      supersedesDrillId: 'op-ae-v1',
      lineageId: 'op-ae-v1',
      version: 2,
    });
    await expect(updateDrill({ organizationId: gym, drillId: 'op-ae-v1', active: true, name: 'Parry Step, Wide' }))
      .resolves.toMatchObject({ drill_id: 'op-ae-v1', name: 'Parry Step, Wide', active: true });
  });

  test('a name collision on restore throws DrillNameTakenError naming the drill, and the drill stays retired', async () => {
    const gym = await newGym('restore-name');
    await insertReference(gym, { drillId: 'ref-restore-name', name: 'Cross Counter' });
    const operationalId = await promote(gym, 'ref-restore-name', 'Cross Counter');
    await retire(gym, operationalId);
    // While it was retired the gym wrote its own drill under the same name --
    // legal, because the name index covers active rows only.
    await createDrill({ organizationId: gym, name: 'Cross Counter', category: 'bagwork', focus: 'Own version.' });
    const before = await drillRows(gym);

    let thrown: unknown;
    try {
      await restore(gym, operationalId);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(DrillNameTakenError);
    // The restore sent no name; the error names the drill that could not come back.
    expect((thrown as DrillNameTakenError).drillName).toBe('Cross Counter');
    expect((thrown as DrillNameTakenError).message).toBe('This gym already has a drill named "Cross Counter"');
    expect(await drillRows(gym)).toEqual(before);
    expect(await activeOf(gym, operationalId)).toBe(false);

    // With a name in the same request, the error names what was asked for.
    await createDrill({ organizationId: gym, name: 'Cross Counter II', category: 'bagwork', focus: 'Another.' });
    await expect(updateDrill({ organizationId: gym, drillId: operationalId, active: true, name: 'Cross Counter II' }))
      .rejects.toMatchObject({ name: 'DrillNameTakenError', drillName: 'Cross Counter II' });
  });

  test('retire is always allowed: an active earlier version, a withdrawn reference, a drill already retired', async () => {
    const gym = await newGym('retire');
    // An active EARLIER version beside its inactive head.
    await insertOperationalDrill(gym, { drillId: 'op-rt-v1', name: 'Retire Me' });
    await insertOperationalDrill(gym, {
      drillId: 'op-rt-v2',
      name: 'Retire Me',
      active: false,
      supersedesDrillId: 'op-rt-v1',
      lineageId: 'op-rt-v1',
      version: 2,
    });
    // A live promotion whose reference has since been withdrawn.
    await insertReference(gym, { drillId: 'ref-retire-withdrawn', name: 'Withdrawn Under Us' });
    const withdrawnOperational = await promote(gym, 'ref-retire-withdrawn', 'Withdrawn Under Us');
    await setReferenceActive(gym, 'ref-retire-withdrawn', false);

    await expect(retire(gym, 'op-rt-v1')).resolves.toMatchObject({ drill_id: 'op-rt-v1', active: false });
    await expect(retire(gym, withdrawnOperational)).resolves.toMatchObject({ drill_id: withdrawnOperational, active: false });
    // Already retired, and not the head: retiring again still answers with the row.
    await expect(retire(gym, 'op-rt-v1')).resolves.toMatchObject({ drill_id: 'op-rt-v1', active: false });
    await expect(retire(gym, 'op-rt-v2')).resolves.toMatchObject({ drill_id: 'op-rt-v2', active: false });
  });

  test('a drill id this gym does not have restores to null -- not a refusal -- and the other gym\'s row is untouched', async () => {
    const gym = await newGym('restore-absent');
    const otherGym = await newGym('restore-absent-other');
    const drill = await createDrill({ organizationId: otherGym, name: 'Not Yours', category: 'bagwork', focus: 'Theirs.' });
    await retire(otherGym, drill.drill_id);
    const otherBefore = await drillRows(otherGym);

    await expect(restore(gym, drill.drill_id)).resolves.toBeNull();
    await expect(restore(gym, 'op-does-not-exist')).resolves.toBeNull();
    expect(await drillRows(otherGym)).toEqual(otherBefore);
  });

  test('the guard reads this gym\'s lineage only: another gym\'s active, higher version under the same lineage id does not block a restore', async () => {
    const gym = await newGym('guard-scope-a');
    const otherGym = await newGym('guard-scope-b');
    // This gym: one version, retired.
    await insertOperationalDrill(gym, { drillId: 'op-gs', name: 'Scoped Drill', active: false });
    // The other gym: the same id, so the same lineage id, with an ACTIVE v2.
    await insertOperationalDrill(otherGym, { drillId: 'op-gs', name: 'Scoped Drill' });
    await refine(otherGym, 'op-gs', 'op-gs-other-v2');

    await expect(restore(gym, 'op-gs')).resolves.toMatchObject({ drill_id: 'op-gs', active: true });
    expect(await activeOf(otherGym, 'op-gs')).toBe(false);
    expect(await activeOf(otherGym, 'op-gs-other-v2')).toBe(true);
  });
});
