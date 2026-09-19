// Real PostgreSQL-backed contract test for W-D4B's assignment -> instruction
// chain (OD-2026-09-19-001): getDrillAssignmentById, then
// resolveAssignmentDrillInstruction, against real rows in the schema
// production actually runs.
//
// WHY A REAL DATABASE. Every property the owner ruled on lives in a predicate
// or in which row gets read, not in anything a mocked query can observe:
//
//   * NO SILENT VERSION SUBSTITUTION. The assignment names an operational
//     VERSION, that row names a reference VERSION, and nothing follows either
//     lineage to its head. The only way to prove "nothing follows" is a
//     database where following WOULD find something -- a newer, active,
//     readable version sitting right next to the pinned one.
//   * THE ATHLETE NEVER RECEIVES THE POINTER. The athlete detail's own
//     drill_id IS the reference id, so dropping it is this module's job. The
//     proof is the real detail, from the real read, with the id absent at
//     every depth -- and a control showing the upstream read DOES carry it,
//     so the absence is this module's work and not an accident upstream.
//   * RETIRED AND WITHDRAWN. The promoted-and-live predicate and the
//     reference `active` term are SQL. Retire one, withdraw the other, and
//     the athlete answer must change while the coach answer must not.
//   * REFINED IS NOT RETIRED. Adopting a change proposal deactivates the
//     version it replaces, so a row's own `active` cannot tell a refined drill
//     from a retired one; only the rest of its lineage can. The coach's
//     lifecycle line (getOperationalDrillLifecycle) is proven against real
//     lineages where the difference exists -- refined forward, an earlier
//     version reinstated, truly retired -- and against another gym whose
//     lineage id is the same string.
//   * WHETHER THE ATHLETE CAN OPEN IT. The coach payload's athlete_can_open
//     must be the athlete's own answer for the same work, not a guess at it.
//     Proven as a property over every assignment in the fixture -- the coach
//     flag against the athlete resolve, side by side -- and in a rolled-back
//     state where the lineage and the promotion disagree, which is the only
//     place a proxy built from the lifecycle line would give itself away.
//   * ONE ANSWER FOR AN ATHLETE. Legacy, gym-written, retired and withdrawn
//     all reach the athlete as the same bare 'unavailable', byte for byte;
//     staff still get the distinction.
//   * READ-ONLY. Opening a drill from assigned work writes nothing. Proven
//     twice: a content hash of every table the chain touches, before and
//     after opening every assignment; and the same sweep inside a READ ONLY
//     transaction, where Postgres itself refuses any write to any table.
//
// ONE FIXTURE, EVERY SCENARIO SIDE BY SIDE. Unlike the neighbouring suites,
// which build a fresh database per test, this one builds a single database in
// beforeAll and seeds every scenario into it. That is deliberate, not a
// shortcut: the substitution case is only meaningful when the newer version
// lives in the SAME database, the cross-organization case is only meaningful
// when the other gym shares ids with this one, and the read-only case has to
// open every assignment against one set of rows. It is safe because nothing
// here writes -- which is itself what the last describe block proves.
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

// Routes every query into the one embedded database this suite seeds.
// Declared before the imports so jest's mock hoisting sees it.
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

import {
  resolveAssignmentDrillInstruction,
  type AssignmentDrillInstruction,
  type AssignmentInstructionAudience,
} from './assignmentDrillInstruction';
import { getAthleteDrillDetail, getDrillLibraryLineage } from './drillLibraryV3';
import { getOperationalDrillLifecycle } from './drillVersioning';
import { getDrillAssignmentById } from './progression';

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-assignment-drill-instruction-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const DATABASE_NAME = 'ppbf_test_wd4b_assignment_instruction';

const ORG_A = 'org-wd4b-a';
/** The other gym. Shares a reference id AND an operational id with ORG_A on purpose. */
const ORG_B = 'org-wd4b-b';
const COACH_A = 'acct-wd4b-coach-a';
const COACH_B = 'acct-wd4b-coach-b';
const ATHLETE_A = 'ATH-WD4B-A';
const ATHLETE_B = 'ATH-WD4B-B';

/* Reference ids are deliberately unlike any content string below, so "the id
   appears nowhere in the athlete payload" is a substring check that cannot be
   satisfied or defeated by coincidence. */
/** Promoted, and the promotion is live. The happy path. */
const REF_LIVE = 'drl-wd4b-7c1-live';
/** v1 of a reference lineage. The assignment's operational row pins THIS one. */
const REF_JAB_V1 = 'drl-wd4b-7c1-jab-v1';
/** v2 of the same lineage: newer, active, supersedes v1, and live-promoted by a second operational drill. */
const REF_JAB_V2 = 'drl-wd4b-7c1-jab-v2';
/** Pointed at by BOTH an operational v1 (inactive, refined) and its active successor v2. */
const REF_REFINED = 'drl-wd4b-7c1-refined';
/** Pointed at by an operational v1 that was reinstated and the v2 the gym stepped back from. */
const REF_REINSTATED = 'drl-wd4b-7c1-reinstated';
/** Its only operational drill is retired, with no successor. */
const REF_RETIRED = 'drl-wd4b-7c1-retired';
/** The reference row itself is inactive, while its promotion is live. */
const REF_WITHDRAWN = 'drl-wd4b-7c1-withdrawn';

const OP_GYM = 'op-wd4b-gym';
const OP_LIVE = 'op-wd4b-live';
const OP_JAB_V1 = 'op-wd4b-jab-pinned';
const OP_JAB_V2_ADOPTION = 'op-wd4b-jab-revised';
const OP_REFINED_V1 = 'op-wd4b-refined-v1';
const OP_REFINED_V2 = 'op-wd4b-refined-v2';
/** Active again: the gym went back to it after adopting v2. */
const OP_REINSTATED_V1 = 'op-wd4b-reinstated-v1';
/** Inactive, superseding v1 -- the version the work was issued against. */
const OP_REINSTATED_V2 = 'op-wd4b-reinstated-v2';
const OP_RETIRED = 'op-wd4b-retired';
const OP_WITHDRAWN = 'op-wd4b-withdrawn';

/** Written before drills had identity: drill_id NULL. */
const ASG_LEGACY = 'asg-wd4b-legacy';
const ASG_GYM = 'asg-wd4b-gym';
const ASG_LIVE = 'asg-wd4b-live';
const ASG_PINNED_V1 = 'asg-wd4b-pinned-v1';
const ASG_REFINED_V1 = 'asg-wd4b-refined-v1';
const ASG_REINSTATED_V2 = 'asg-wd4b-reinstated-v2';
const ASG_RETIRED = 'asg-wd4b-retired';
const ASG_WITHDRAWN = 'asg-wd4b-withdrawn';
/** ORG_B's assignment, anchored to ORG_B's copy of OP_LIVE. */
const ASG_ORG_B = 'asg-wd4b-org-b';

const ORG_A_ASSIGNMENTS = [
  ASG_LEGACY, ASG_GYM, ASG_LIVE, ASG_PINNED_V1, ASG_REFINED_V1, ASG_REINSTATED_V2, ASG_RETIRED, ASG_WITHDRAWN,
];

/** Every operational row seeded in each gym, for the lifecycle sweep. */
const ORG_A_OPERATIONAL = [
  OP_GYM, OP_LIVE, OP_JAB_V1, OP_JAB_V2_ADOPTION, OP_REFINED_V1, OP_REFINED_V2, OP_REINSTATED_V1,
  OP_REINSTATED_V2, OP_RETIRED, OP_WITHDRAWN,
];
const ORG_B_OPERATIONAL = [OP_LIVE, OP_REFINED_V1];

/**
 * The athlete detail's keys (drillLibraryV3.pg.test.ts pins those fifteen)
 * minus drill_id, which is the reference pointer. An exact allow-list: a key
 * added to the athlete projection tomorrow fails here as well as there.
 */
const ATHLETE_INSTRUCTION_KEYS = [
  'common_errors', 'contact_level', 'corrections', 'cues', 'equipment_needed', 'execution', 'name',
  'purpose', 'requires_coach_authorization', 'scale_levels', 'setup', 'stop_rules',
  'what_bad_looks_like', 'what_good_looks_like',
];

/**
 * Nothing that says where content came from, how it is versioned, or which
 * reference row it is -- at any depth. drill_id heads the list: in this
 * payload it could only ever be the reference pointer.
 */
const FORBIDDEN_ATHLETE_KEYS = [
  'drill_id', 'reference_drill_id', 'source_ref', 'evidence_note', 'field_provenance',
  'grounding_claim_ids', 'content_class', 'created_by_account_id', 'created_by_role',
  'authoring_state', 'active', 'lineage_id', 'version', 'supersedes_drill_id', 'superseded_at',
  'skill_id', 'target_behavior', 'secondary_skills', 'organization_id', 'transfer',
  'operational_active', 'operational_lifecycle', 'scale_id', 'stop_rule_id', 'cue_id',
];

/** The only athlete answer when there is nothing to open, whatever the reason -- exactly these bytes. */
const ATHLETE_NOTHING_TO_OPEN = '{"state":"unavailable"}';

/** Grounding-claim tag shape, e.g. [A2-070]. */
const CLAIM_TAG = /\[[A-Z]\d+-\d+\]/;

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let applyFullSchema: (client: Client, opts?: { infraDir?: string }) => Promise<unknown>;
let seededClient: Client;

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
 * One reference drill VERSION with a full set of children. Every text field
 * is derived from `label`, so a wrong version is visible as wrong words rather
 * than as a passing assertion. Provenance is written the way the seed writes
 * it -- inline claim tags, grounding ids, a source_ref, an authoring account --
 * so the athlete projection is proven against rows that actually carry it.
 */
async function insertReference(
  client: Client,
  opts: {
    organizationId?: string;
    drillId: string;
    label: string;
    name: string;
    active?: boolean;
    lineageId?: string;
    version?: number;
    supersedesDrillId?: string | null;
  },
): Promise<void> {
  const organizationId = opts.organizationId ?? ORG_A;
  const { drillId, label } = opts;
  await client.query(
    `insert into pilot.drill_library
       (organization_id, drill_id, lineage_id, version, supersedes_drill_id, name, discipline, category,
        difficulty, target_behavior, purpose, standard_setup, execution, what_good_looks_like,
        what_bad_looks_like, common_errors, corrections, transfer, contact_level, equipment_needed,
        requires_coach_authorization, source_ref, grounding_claim_ids, active, created_by_account_id,
        created_by_role)
     values ($1,$2,$3,$4,$5,$6,'boxing','footwork','intermediate',
             $7 || ' target behavior.', $7 || ' purpose.', $7 || ' setup.', $7 || ' execution.',
             $7 || ' good [A2-070]', $7 || ' bad [B3-047][A5-149]', $7 || ' errors',
             $7 || ' correction [A2-070]', $7 || ' transfer [A3-021]', 'light_technical', 'focus mitts',
             false, 'Manual v3 p.12', array['A2-070','B3-047'], $8, 'acct-wd4b-author', 'platform_owner')`,
    [
      organizationId,
      drillId,
      opts.lineageId ?? drillId,
      opts.version ?? 1,
      opts.supersedesDrillId ?? null,
      opts.name,
      label,
      opts.active ?? true,
    ],
  );
  await client.query(
    `insert into pilot.drill_scale_levels
       (organization_id, scale_id, drill_id, scale_level, is_starting_point, demand_description,
        constraint_applied, contact_level, coach_watch_point, authoring_state)
     values ($1, $2 || '-a', $2, 'A', false, $3 || ' demand A', $3 || ' constraint A', 'none', $3 || ' watch A', 'authored'),
            ($1, $2 || '-b', $2, 'B', true,  $3 || ' demand B', '',                    'none', $3 || ' watch B', 'authored')`,
    [organizationId, drillId, label],
  );
  await client.query(
    `insert into pilot.drill_stop_rules
       (organization_id, stop_rule_id, drill_id, ordinal, condition_text, scope, rule_kind)
     values ($1, $2 || '-stop-1', $2, 1, $3 || ' stop when the guard drops.', 'universal', 'safety')`,
    [organizationId, drillId, label],
  );
  await client.query(
    `insert into pilot.drill_cues
       (organization_id, cue_id, drill_id, cue_text, cue_family, focus_type, evidence_note, source_ref)
     values ($1, $2 || '-cue-1', $2, $3 || ' cue hands home', 'guard', 'external', 'Believed because of claim A2-070.', 'batch-7'),
            ($1, $2 || '-cue-2', $2, $3 || ' cue feet under', 'base',  'external', 'Believed because of claim B3-047.', 'batch-7')`,
    [organizationId, drillId, label],
  );
}

/** An operational drill, optionally pointing at a reference version -- i.e. a promotion. */
async function insertOperationalDrill(
  client: Client,
  opts: {
    organizationId?: string;
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
      opts.organizationId ?? ORG_A,
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

/**
 * RAW, not through a writer: the W-D3 writers refuse a NULL drill_id, and the
 * legacy row is exactly the shape they refuse. drill_name/drill_description
 * are the typed-on-the-day snapshot and deliberately differ from every drill
 * name, so a rewrite of the snapshot is visible.
 */
async function insertAssignment(
  client: Client,
  opts: {
    organizationId?: string;
    assignmentId: string;
    athleteId?: string;
    assignedBy?: string;
    drillId: string | null;
    drillName: string;
  },
): Promise<void> {
  await client.query(
    `insert into pilot.drill_assignments
       (assignment_id, organization_id, gap_id, athlete_id, assigned_by_account_id, drill_id,
        drill_name, drill_description, rep_count, duration_minutes, frequency_per_week, due_date,
        status, completion_percentage)
     values ($1,$2,null,$3,$4,$5,$6,'Typed on the day.',30,15,3,'2026-10-01','in_progress',40)`,
    [
      opts.assignmentId,
      opts.organizationId ?? ORG_A,
      opts.athleteId ?? ATHLETE_A,
      opts.assignedBy ?? COACH_A,
      opts.drillId,
      opts.drillName,
    ],
  );
}

/**
 * The whole schema, then every scenario at once. See the header for why one
 * database rather than one per test.
 */
async function seededDatabase(): Promise<Client> {
  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  await admin.query(`drop database if exists ${DATABASE_NAME}`);
  await admin.query(`create database ${DATABASE_NAME}`);
  await admin.end();

  const client = new Client({ connectionString: connectionStringFor(DATABASE_NAME) });
  await client.connect();
  /* THE WHOLE SCHEMA, not a hand-picked subset (see scripts/lib/full-schema.mjs).
     The chain crosses the progression, drills, versioning, provenance and v3
     library migrations, and the discipline foreign key; picking them by hand
     is how a suite ends up testing a database that has never existed. */
  await applyFullSchema(client, { infraDir: INFRA_DIR });

  for (const [organizationId, coachId, athleteId] of [
    [ORG_A, COACH_A, ATHLETE_A],
    [ORG_B, COACH_B, ATHLETE_B],
  ]) {
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
    await client.query(
      `insert into pilot.accounts (account_id, login_email, role, organization_id, auth_provider)
       values ($1, $1 || '@ppbf.test', 'coach', $2, 'microsoft')`,
      [coachId, organizationId],
    );
    await client.query(
      `insert into pilot.athletes (organization_id, athlete_id, full_name, dob, weight_class, gym_status, emergency_contact, active_flag, coach_id, created_at, updated_at)
       values ($1, $2, 'Assigned Athlete', '2011-05-06', 'fly', 'active', 'contact', true, $3, now(), now())`,
      [organizationId, athleteId, coachId],
    );
  }

  // (1) Legacy: no anchor at all.
  await insertAssignment(client, { assignmentId: ASG_LEGACY, drillId: null, drillName: 'Shadow boxing, three rounds' });

  // (2) Written by this gym: an operational drill with no reference behind it.
  await insertOperationalDrill(client, { drillId: OP_GYM, name: 'Gym Heavy Bag Rounds' });
  await insertAssignment(client, { assignmentId: ASG_GYM, drillId: OP_GYM, drillName: 'Bag rounds as typed' });

  // (3) Promoted and live.
  await insertReference(client, { drillId: REF_LIVE, label: 'Live', name: 'Live Drill' });
  await insertOperationalDrill(client, { drillId: OP_LIVE, name: 'Live Drill', referenceDrillId: REF_LIVE });
  await insertAssignment(client, { assignmentId: ASG_LIVE, drillId: OP_LIVE, drillName: 'Live drill as typed' });

  // (4) A reference lineage with a newer version. v2 supersedes v1, both are
  // active, and v2 is ALSO live-promoted by a second operational drill -- so
  // an implementation that followed the lineage head would find readable v2
  // content for either audience, and the substitution would show as words.
  await insertReference(client, { drillId: REF_JAB_V1, label: 'Jab v1', name: 'Jab Return' });
  await insertReference(client, {
    drillId: REF_JAB_V2,
    label: 'Jab v2',
    name: 'Jab Return, revised',
    lineageId: REF_JAB_V1,
    version: 2,
    supersedesDrillId: REF_JAB_V1,
  });
  await client.query(
    `update pilot.drill_library set superseded_at = now() where organization_id = $1 and drill_id = $2`,
    [ORG_A, REF_JAB_V1],
  );
  await insertOperationalDrill(client, { drillId: OP_JAB_V1, name: 'Jab Return', referenceDrillId: REF_JAB_V1 });
  await insertOperationalDrill(client, {
    drillId: OP_JAB_V2_ADOPTION,
    name: 'Jab Return, revised',
    referenceDrillId: REF_JAB_V2,
  });
  await insertAssignment(client, { assignmentId: ASG_PINNED_V1, drillId: OP_JAB_V1, drillName: 'Jab return as typed' });

  // (5) The operational drill was refined. Written the way
  // adoptDrillChangeProposal writes it (drillVersioning.ts): v1 deactivated
  // and stamped superseded, v2 inserted active with supersedes_drill_id and
  // the SAME reference_drill_id carried forward, then v1 pointed at v2.
  await insertReference(client, { drillId: REF_REFINED, label: 'Refined', name: 'Slip Line' });
  await insertOperationalDrill(client, {
    drillId: OP_REFINED_V1,
    name: 'Slip Line',
    referenceDrillId: REF_REFINED,
    active: false,
  });
  await insertOperationalDrill(client, {
    drillId: OP_REFINED_V2,
    name: 'Slip Line',
    referenceDrillId: REF_REFINED,
    supersedesDrillId: OP_REFINED_V1,
    lineageId: OP_REFINED_V1,
    version: 2,
  });
  await client.query(
    `update pilot.drills set superseded_at = now(), superseded_by_drill_id = $3
     where organization_id = $1 and drill_id = $2`,
    [ORG_A, OP_REFINED_V1, OP_REFINED_V2],
  );
  await insertAssignment(client, { assignmentId: ASG_REFINED_V1, drillId: OP_REFINED_V1, drillName: 'Slip line as typed' });

  // (5b) An EARLIER version reinstated. v2 was adopted exactly as in (5), then
  // the gym went back: v2 retired and v1 restored through updateDrill's
  // `active` (v2 first, so the active-name index never sees both). The work
  // was issued against v2, which is now the inactive row -- while the lineage
  // is still run, through v1. v2's own `active` says "retired"; it is not.
  await insertReference(client, { drillId: REF_REINSTATED, label: 'Reinstated', name: 'Hook Off The Jab' });
  await insertOperationalDrill(client, {
    drillId: OP_REINSTATED_V1,
    name: 'Hook Off The Jab',
    referenceDrillId: REF_REINSTATED,
  });
  await insertOperationalDrill(client, {
    drillId: OP_REINSTATED_V2,
    name: 'Hook Off The Jab',
    referenceDrillId: REF_REINSTATED,
    active: false,
    supersedesDrillId: OP_REINSTATED_V1,
    lineageId: OP_REINSTATED_V1,
    version: 2,
  });
  await client.query(
    `update pilot.drills set superseded_at = now(), superseded_by_drill_id = $3
     where organization_id = $1 and drill_id = $2`,
    [ORG_A, OP_REINSTATED_V1, OP_REINSTATED_V2],
  );
  await insertAssignment(client, {
    assignmentId: ASG_REINSTATED_V2,
    drillId: OP_REINSTATED_V2,
    drillName: 'Hook off the jab as typed',
  });

  // (6) Retired, with no active successor.
  await insertReference(client, { drillId: REF_RETIRED, label: 'Retired', name: 'Retired Drill' });
  await insertOperationalDrill(client, {
    drillId: OP_RETIRED,
    name: 'Retired Drill',
    referenceDrillId: REF_RETIRED,
    active: false,
  });
  await insertAssignment(client, { assignmentId: ASG_RETIRED, drillId: OP_RETIRED, drillName: 'Retired drill as typed' });

  // (7) The reference row is withdrawn while the promotion is still live.
  await insertReference(client, { drillId: REF_WITHDRAWN, label: 'Withdrawn', name: 'Withdrawn Drill', active: false });
  await insertOperationalDrill(client, { drillId: OP_WITHDRAWN, name: 'Withdrawn Drill', referenceDrillId: REF_WITHDRAWN });
  await insertAssignment(client, { assignmentId: ASG_WITHDRAWN, drillId: OP_WITHDRAWN, drillName: 'Withdrawn drill as typed' });

  // (8) The other gym reuses ORG_A's reference id AND operational id, with its
  // own words. Legal, because both keys are (organization_id, drill_id) -- and
  // exactly the shape that surfaces a missing organization term anywhere in
  // the chain as the wrong gym's content.
  await insertReference(client, { organizationId: ORG_B, drillId: REF_LIVE, label: 'Org B', name: 'Other Gym Drill' });
  await insertOperationalDrill(client, {
    organizationId: ORG_B,
    drillId: OP_LIVE,
    name: 'Other Gym Drill',
    referenceDrillId: REF_LIVE,
  });
  await insertAssignment(client, {
    organizationId: ORG_B,
    assignmentId: ASG_ORG_B,
    athleteId: ATHLETE_B,
    assignedBy: COACH_B,
    drillId: OP_LIVE,
    drillName: 'Other gym drill as typed',
  });
  // ...and an operational id -- so, by the default, a lineage id -- that in
  // ORG_A is a REFINED lineage with an active v2, but here is one lone
  // retired drill. Where this gym's drill stands must be read from this gym's
  // lineage; ORG_A's active v2 would make it look merely changed.
  await insertOperationalDrill(client, {
    organizationId: ORG_B,
    drillId: OP_REFINED_V1,
    name: 'Other Gym Slip Line',
    active: false,
  });

  // Logged work, so the read-only snapshot covers completions that exist
  // rather than an empty table.
  await client.query(
    `insert into pilot.assignment_completions
       (completion_id, organization_id, assignment_id, athlete_id, completed_at, reps_completed, notes)
     values ('cmp-wd4b-live-1', $1, $2, $3, now() - interval '1 day', 30, 'Felt sharp.'),
            ('cmp-wd4b-refined-1', $1, $4, $3, now() - interval '2 days', 20, 'Slipped late.')`,
    [ORG_A, ASG_LIVE, ATHLETE_A, ASG_REFINED_V1],
  );

  return client;
}

/** The route's own sequence: read the assignment in this organization, then resolve its instruction. */
async function openAssignment(
  organizationId: string,
  assignmentId: string,
  audience: AssignmentInstructionAudience,
): Promise<AssignmentDrillInstruction> {
  const assignment = await getDrillAssignmentById(organizationId, assignmentId);
  if (!assignment) throw new Error(`test bug: ${assignmentId} is not readable in ${organizationId}`);
  return resolveAssignmentDrillInstruction(organizationId, assignment, audience);
}

async function openAsAthlete(assignmentId: string) {
  const result = await openAssignment(ORG_A, assignmentId, 'athlete');
  if (result.state !== 'available' || !('audience' in result) || result.audience !== 'athlete') {
    throw new Error(`expected an available athlete instruction, got ${JSON.stringify(result)}`);
  }
  return result;
}

async function openAsCoach(assignmentId: string) {
  const result = await openAssignment(ORG_A, assignmentId, 'coach');
  if (result.state !== 'available' || !('audience' in result) || result.audience !== 'coach') {
    throw new Error(`expected an available coach instruction, got ${JSON.stringify(result)}`);
  }
  return result;
}

function keysAtEveryDepth(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(keysAtEveryDepth);
  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>)
      .flatMap(([key, nested]) => [key, ...keysAtEveryDepth(nested)]);
  }
  return [];
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

  seededClient = await seededDatabase();
  // Shared by every test, and never reset between them: nothing here writes.
  activeClient = seededClient;
});

afterAll(async () => {
  activeClient = null;
  await seededClient?.end().catch(() => {});
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

describe('assignments that link to no reference instruction (real database)', () => {
  test('a legacy assignment with no drill_id is no_drill to the coach and plain unavailable to the athlete', async () => {
    const assignment = await getDrillAssignmentById(ORG_A, ASG_LEGACY);

    // The row is real and readable; it simply has no anchor.
    expect(assignment).toMatchObject({ assignment_id: ASG_LEGACY, drill_id: null });
    expect(assignment?.drill_display_name).toBe('Shadow boxing, three rounds');

    // "This work predates drill links" is a fact about how the library was
    // assembled, so the athlete is not told it.
    await expect(openAssignment(ORG_A, ASG_LEGACY, 'athlete')).resolves.toEqual({ state: 'unavailable' });
    await expect(openAssignment(ORG_A, ASG_LEGACY, 'coach')).resolves.toEqual({ state: 'no_drill' });
  });

  test('a gym-written operational drill (reference_drill_id NULL) is gym_written to the coach and plain unavailable to the athlete', async () => {
    const assignment = await getDrillAssignmentById(ORG_A, ASG_GYM);
    expect(assignment?.drill_id).toBe(OP_GYM);

    // "Your gym wrote this drill" is provenance; the athlete is not told it.
    await expect(openAssignment(ORG_A, ASG_GYM, 'athlete')).resolves.toEqual({ state: 'unavailable' });
    await expect(openAssignment(ORG_A, ASG_GYM, 'coach')).resolves.toEqual({ state: 'gym_written' });
  });

  test('every reason there is nothing to open reaches the athlete as the same bytes, while staff keep the reasons', async () => {
    // Legacy, gym-written, retired promotion, withdrawn reference: four
    // different situations, one athlete answer.
    const withheld = [ASG_LEGACY, ASG_GYM, ASG_RETIRED, ASG_WITHDRAWN];
    const athleteAnswers: string[] = [];
    const coachStates: string[] = [];
    for (const assignmentId of withheld) {
      athleteAnswers.push(JSON.stringify(await openAssignment(ORG_A, assignmentId, 'athlete')));
      coachStates.push((await openAssignment(ORG_A, assignmentId, 'coach')).state);
    }

    // Byte for byte: no reason, no name, no pointer -- nothing that tells one
    // of these apart from another.
    expect(athleteAnswers).toEqual(withheld.map(() => ATHLETE_NOTHING_TO_OPEN));
    // CONTROL: they really are four different situations, and staff see them.
    expect(coachStates).toEqual(['no_drill', 'gym_written', 'available', 'available']);
  });
});

describe('a promoted, live reference (real database)', () => {
  test('the athlete gets the athlete-safe instruction, without the reference pointer', async () => {
    const result = await openAsAthlete(ASG_LIVE);

    // AN EXACT ALLOW-LIST: the fifteen keys of getAthleteDrillDetail minus drill_id.
    expect(Object.keys(result.drill).sort()).toEqual(ATHLETE_INSTRUCTION_KEYS);
    expect(Object.keys(result).sort()).toEqual(['audience', 'drill', 'state']);

    // The whole instruction, word for word: ORG_A's row (not ORG_B's, which
    // shares the reference id), tags stripped, cues and children in order.
    expect(result.drill).toEqual({
      name: 'Live Drill',
      purpose: 'Live purpose.',
      setup: 'Live setup.',
      execution: 'Live execution.',
      contact_level: 'light_technical',
      requires_coach_authorization: false,
      cues: ['Live cue feet under', 'Live cue hands home'],
      what_good_looks_like: 'Live good',
      what_bad_looks_like: 'Live bad',
      common_errors: 'Live errors',
      corrections: 'Live correction',
      equipment_needed: 'focus mitts',
      scale_levels: [
        {
          scale_level: 'A',
          is_starting_point: false,
          demand_description: 'Live demand A',
          constraint_applied: 'Live constraint A',
          contact_level: 'none',
          coach_watch_point: 'Live watch A',
        },
        {
          scale_level: 'B',
          is_starting_point: true,
          demand_description: 'Live demand B',
          constraint_applied: '',
          contact_level: 'none',
          coach_watch_point: 'Live watch B',
        },
      ],
      stop_rules: [
        { ordinal: 1, condition_text: 'Live stop when the guard drops.', scope: 'universal', rule_kind: 'safety' },
      ],
    });

    // THE POINTER AND THE PROVENANCE, at every depth and as bare strings.
    const serialized = JSON.stringify(result);
    const keys = keysAtEveryDepth(JSON.parse(serialized));
    expect(keys.length).toBeGreaterThan(0);
    for (const forbidden of FORBIDDEN_ATHLETE_KEYS) {
      expect(keys).not.toContain(forbidden);
    }
    expect(serialized).not.toContain(REF_LIVE);
    expect(serialized).not.toMatch(CLAIM_TAG);
    for (const provenanceValue of ['Manual v3 p.12', 'batch-7', 'Believed because', 'acct-wd4b-author', 'transfer']) {
      expect(serialized).not.toContain(provenanceValue);
    }
  });

  test('CONTROL: the upstream athlete read does carry the pointer, so its absence above is this module dropping it', async () => {
    // Without this, the allow-list above could be passing because
    // getAthleteDrillDetail stopped returning drill_id, and the day it started
    // again nothing here would notice the resolver no longer removes it.
    const upstream = await getAthleteDrillDetail(ORG_A, REF_LIVE);

    expect(upstream?.drill_id).toBe(REF_LIVE);
    expect(Object.keys(upstream ?? {}).sort()).toEqual([...ATHLETE_INSTRUCTION_KEYS, 'drill_id'].sort());
  });

  test("the coach gets the full reference detail, the reference id, operational_lifecycle 'current' and athlete_can_open true", async () => {
    const result = await openAsCoach(ASG_LIVE);

    expect(result.operational_lifecycle).toBe('current');
    // Promoted and live: the athlete can open this same instruction from the
    // work. A real boolean, not merely truthy.
    expect(result.athlete_can_open).toBe(true);
    // The lifecycle REPLACES the old boolean, and athlete_can_open is the one
    // thing beside it; the envelope carries nothing else.
    expect(Object.keys(result).sort()).toEqual([
      'athlete_can_open', 'audience', 'drill', 'operational_lifecycle', 'state',
    ]);
    expect(result.drill.drill_id).toBe(REF_LIVE);
    expect(result.drill.organization_id).toBe(ORG_A);
    expect(result.drill.name).toBe('Live Drill');
    expect(result.drill.purpose).toBe('Live purpose.');
    // The canonical row, unprojected: staff review the evidence the athlete
    // read strips, so the tag is still here.
    expect(result.drill.corrections).toBe('Live correction [A2-070]');
    expect(result.drill.source_ref).toBe('Manual v3 p.12');
    expect(result.drill.scale_levels).toHaveLength(2);
    expect(result.drill.stop_rules).toHaveLength(1);
    expect(result.drill.cues).toHaveLength(2);
  });
});

describe('NO SILENT VERSION SUBSTITUTION (real database)', () => {
  test('CONTROL: the lineage really has a newer, active, athlete-readable head', async () => {
    // Every assertion in this block is only worth something if following the
    // lineage WOULD have found different content.
    const lineage = await getDrillLibraryLineage(ORG_A, REF_JAB_V1);
    expect(lineage.map((row) => [row.drill_id, row.version, row.active, row.supersedes_drill_id])).toEqual([
      [REF_JAB_V1, 1, true, null],
      [REF_JAB_V2, 2, true, REF_JAB_V1],
    ]);
    expect((await getAthleteDrillDetail(ORG_A, REF_JAB_V2))?.name).toBe('Jab Return, revised');
  });

  test('the athlete reads the v1 the operational row pins, not the v2 that supersedes it', async () => {
    const result = await openAsAthlete(ASG_PINNED_V1);

    expect(result.drill.name).toBe('Jab Return');
    expect(result.drill.purpose).toBe('Jab v1 purpose.');
    expect(result.drill.execution).toBe('Jab v1 execution.');
    expect(result.drill.corrections).toBe('Jab v1 correction');
    expect(result.drill.cues).toEqual(['Jab v1 cue feet under', 'Jab v1 cue hands home']);
    expect(result.drill.stop_rules.map((rule) => rule.condition_text)).toEqual([
      'Jab v1 stop when the guard drops.',
    ]);
    expect(JSON.stringify(result)).not.toContain('Jab v2');
    expect(JSON.stringify(result)).not.toContain('revised');
  });

  test('the coach reads the same pinned v1, by its own id and version', async () => {
    const result = await openAsCoach(ASG_PINNED_V1);

    expect(result.drill.drill_id).toBe(REF_JAB_V1);
    expect(result.drill.version).toBe(1);
    expect(result.drill.name).toBe('Jab Return');
    expect(result.drill.purpose).toBe('Jab v1 purpose.');
    // The operational v1 is itself still the active row: it is the REFERENCE
    // lineage that moved on, and that is not an operational lifecycle change.
    expect(result.operational_lifecycle).toBe('current');
    // And the pinned v1 is still live-promoted, so the athlete can open it too;
    // a newer reference head does not take it away.
    expect(result.athlete_can_open).toBe(true);
  });

  test('an assignment on a refined operational v1 whose active v2 carries the same pointer reads that same reference version', async () => {
    // The assignment still names v1 -- it is the version the work was issued
    // against, and nothing rewrote it.
    const assignment = await getDrillAssignmentById(ORG_A, ASG_REFINED_V1);
    expect(assignment?.drill_id).toBe(OP_REFINED_V1);
    const { rows: operational } = await seededClient.query(
      `select drill_id, active, reference_drill_id from pilot.drills
       where organization_id = $1 and lineage_id = $2 order by version`,
      [ORG_A, OP_REFINED_V1],
    );
    expect(operational).toEqual([
      { drill_id: OP_REFINED_V1, active: false, reference_drill_id: REF_REFINED },
      { drill_id: OP_REFINED_V2, active: true, reference_drill_id: REF_REFINED },
    ]);

    // Promoted-and-live holds through the successor, so the athlete can read it.
    const athlete = await openAsAthlete(ASG_REFINED_V1);
    expect(athlete.drill.name).toBe('Slip Line');
    expect(athlete.drill.purpose).toBe('Refined purpose.');
    expect(Object.keys(athlete.drill).sort()).toEqual(ATHLETE_INSTRUCTION_KEYS);
    expect(JSON.stringify(athlete)).not.toContain(REF_REFINED);

    // The coach sees the same reference version, and that the drill the work
    // was issued against has CHANGED -- not that it was retired. v1's own
    // `active` is false, so a status read off that row alone would say
    // 'retired', which is false: the gym refined the drill and still runs it.
    const coach = await openAsCoach(ASG_REFINED_V1);
    expect(coach.drill.drill_id).toBe(REF_REFINED);
    expect(coach.drill.version).toBe(1);
    expect(coach.operational_lifecycle).toBe('changed');
    // Changed is not "the athlete cannot open it": the active v2 carries the
    // same pointer, so the promotion is live and the athlete read above
    // succeeded. v1's own `active` (false) would say the opposite.
    expect(coach.athlete_can_open).toBe(true);
  });

  test('an assignment on a newer version the gym stepped back from (earlier version reinstated) is changed to the coach, available to the athlete', async () => {
    const assignment = await getDrillAssignmentById(ORG_A, ASG_REINSTATED_V2);
    expect(assignment?.drill_id).toBe(OP_REINSTATED_V2);
    // CONTROL: the assigned v2 is the inactive row and the EARLIER v1 is the
    // active one -- the reverse of a refinement.
    const { rows: operational } = await seededClient.query(
      `select drill_id, version, active, supersedes_drill_id from pilot.drills
       where organization_id = $1 and lineage_id = $2 order by version`,
      [ORG_A, OP_REINSTATED_V1],
    );
    expect(operational).toEqual([
      { drill_id: OP_REINSTATED_V1, version: 1, active: true, supersedes_drill_id: null },
      { drill_id: OP_REINSTATED_V2, version: 2, active: false, supersedes_drill_id: OP_REINSTATED_V1 },
    ]);

    // Promoted-and-live holds through the reinstated v1.
    const athlete = await openAsAthlete(ASG_REINSTATED_V2);
    expect(athlete.drill.name).toBe('Hook Off The Jab');
    expect(athlete.drill.purpose).toBe('Reinstated purpose.');
    expect(Object.keys(athlete.drill).sort()).toEqual(ATHLETE_INSTRUCTION_KEYS);
    expect(JSON.stringify(athlete)).not.toContain(REF_REINSTATED);

    const coach = await openAsCoach(ASG_REINSTATED_V2);
    expect(coach.drill.drill_id).toBe(REF_REINSTATED);
    expect(coach.drill.purpose).toBe('Reinstated purpose.');
    expect(coach.operational_lifecycle).toBe('changed');
    expect(coach.athlete_can_open).toBe(true);
  });
});

describe('retired promotions and withdrawn references (real database)', () => {
  test('a retired operational drill with no active successor is unavailable to the athlete, available to the coach', async () => {
    // Exactly { state }, nothing else: an unavailable answer carries no
    // name, no content and no pointer.
    await expect(openAssignment(ORG_A, ASG_RETIRED, 'athlete')).resolves.toEqual({ state: 'unavailable' });

    const coach = await openAsCoach(ASG_RETIRED);
    expect(coach.drill.drill_id).toBe(REF_RETIRED);
    expect(coach.drill.active).toBe(true);
    expect(coach.drill.purpose).toBe('Retired purpose.');
    // No version of the lineage is active: this one really is retired.
    expect(coach.operational_lifecycle).toBe('retired');
    // The coach can read it; the athlete cannot, and the payload says so --
    // while the reference row itself is still active, so `drill.active` would
    // have said the opposite.
    expect(coach.athlete_can_open).toBe(false);
  });

  test('an inactive reference is unavailable to the athlete while its promotion is live, available to the coach', async () => {
    await expect(openAssignment(ORG_A, ASG_WITHDRAWN, 'athlete')).resolves.toEqual({ state: 'unavailable' });

    const coach = await openAsCoach(ASG_WITHDRAWN);
    expect(coach.drill.drill_id).toBe(REF_WITHDRAWN);
    expect(coach.drill.active).toBe(false);
    expect(coach.drill.purpose).toBe('Withdrawn purpose.');
    // The gym still runs the operational drill; it is the reference that went.
    expect(coach.operational_lifecycle).toBe('current');
    // So the lifecycle line alone would tell a coach the athlete can open this.
    // They cannot: the athlete read above refused it.
    expect(coach.athlete_can_open).toBe(false);
  });
});

describe('WHERE THE OPERATIONAL DRILL STANDS NOW: getOperationalDrillLifecycle (real database)', () => {
  async function lifecycles(organizationId: string, drillIds: string[]) {
    const answers: Array<[string, string | null]> = [];
    for (const drillId of drillIds) {
      answers.push([drillId, await getOperationalDrillLifecycle(organizationId, drillId)]);
    }
    return answers;
  }

  test('an active version is current: promoted, gym-written, a refined successor, a reinstated original', async () => {
    const current = [OP_LIVE, OP_GYM, OP_JAB_V1, OP_REFINED_V2, OP_REINSTATED_V1, OP_WITHDRAWN];
    expect(await lifecycles(ORG_A, current)).toEqual(current.map((drillId) => [drillId, 'current']));
  });

  test('changed via refinement: the version is inactive and its successor is active', async () => {
    // CONTROL: exactly the rows adoptDrillChangeProposal leaves behind.
    const { rows } = await seededClient.query(
      `select drill_id, active, superseded_by_drill_id from pilot.drills
       where organization_id = $1 and lineage_id = $2 order by version`,
      [ORG_A, OP_REFINED_V1],
    );
    expect(rows).toEqual([
      { drill_id: OP_REFINED_V1, active: false, superseded_by_drill_id: OP_REFINED_V2 },
      { drill_id: OP_REFINED_V2, active: true, superseded_by_drill_id: null },
    ]);

    await expect(getOperationalDrillLifecycle(ORG_A, OP_REFINED_V1)).resolves.toBe('changed');
  });

  test('changed via an EARLIER version reinstated: the newer version is inactive while v1 is active again', async () => {
    // Not "the successor is active" -- there is no active successor. Only
    // "some version of this lineage is active" gets this one right.
    await expect(getOperationalDrillLifecycle(ORG_A, OP_REINSTATED_V2)).resolves.toBe('changed');
    await expect(getOperationalDrillLifecycle(ORG_A, OP_REINSTATED_V1)).resolves.toBe('current');
  });

  test('retired: no version of the lineage is active', async () => {
    const { rows } = await seededClient.query(
      `select drill_id, active from pilot.drills where organization_id = $1 and lineage_id = $2`,
      [ORG_A, OP_RETIRED],
    );
    expect(rows).toEqual([{ drill_id: OP_RETIRED, active: false }]);

    await expect(getOperationalDrillLifecycle(ORG_A, OP_RETIRED)).resolves.toBe('retired');
  });

  test("another gym's drill is null, and a lineage id both gyms use is read in the asking gym only", async () => {
    // Drills that exist only in ORG_A, asked for by ORG_B -- and one that
    // exists nowhere. Positive control: the same ids resolve in ORG_A.
    expect(await lifecycles(ORG_B, [OP_RETIRED, OP_REINSTATED_V2, OP_GYM])).toEqual([
      [OP_RETIRED, null],
      [OP_REINSTATED_V2, null],
      [OP_GYM, null],
    ]);
    await expect(getOperationalDrillLifecycle(ORG_A, 'op-wd4b-nowhere')).resolves.toBeNull();
    expect(await lifecycles(ORG_A, [OP_RETIRED, OP_REINSTATED_V2, OP_GYM])).toEqual([
      [OP_RETIRED, 'retired'],
      [OP_REINSTATED_V2, 'changed'],
      [OP_GYM, 'current'],
    ]);

    // Same id, same lineage id, two gyms: ORG_A refined it (active v2), ORG_B
    // retired it. ORG_A's active v2 must not make ORG_B's drill look changed.
    await expect(getOperationalDrillLifecycle(ORG_B, OP_REFINED_V1)).resolves.toBe('retired');
    await expect(getOperationalDrillLifecycle(ORG_A, OP_REFINED_V1)).resolves.toBe('changed');
    // And ORG_B's own live drill under a shared id is its own answer.
    await expect(getOperationalDrillLifecycle(ORG_B, OP_LIVE)).resolves.toBe('current');
  });
});

describe('the organization boundary (real database)', () => {
  test("another gym's assignment id is not returned to this gym, and this gym's is not returned to it", async () => {
    await expect(getDrillAssignmentById(ORG_A, ASG_ORG_B)).resolves.toBeNull();
    await expect(getDrillAssignmentById(ORG_B, ASG_LIVE)).resolves.toBeNull();

    // Positive control: the row exists and is readable in its own gym, so the
    // null above is the organization predicate and not a missing row.
    const own = await getDrillAssignmentById(ORG_B, ASG_ORG_B);
    expect(own).toMatchObject({ assignment_id: ASG_ORG_B, athlete_id: ATHLETE_B, drill_id: OP_LIVE });
  });

  test("the same operational and reference ids resolve to each gym's own words", async () => {
    const orgB = await openAssignment(ORG_B, ASG_ORG_B, 'athlete');
    expect(orgB).toMatchObject({ state: 'available', audience: 'athlete', drill: { name: 'Other Gym Drill' } });

    const orgA = await openAsAthlete(ASG_LIVE);
    expect(orgA.drill.name).toBe('Live Drill');
    expect(JSON.stringify(orgA)).not.toContain('Org B');
  });
});

/** Every assignment seeded, in both gyms: the property below runs over all of them. */
const EVERY_ASSIGNMENT: ReadonlyArray<readonly [organizationId: string, assignmentId: string]> = [
  ...ORG_A_ASSIGNMENTS.map((assignmentId) => [ORG_A, assignmentId] as const),
  [ORG_B, ASG_ORG_B],
];

type CanOpenRow = [
  assignmentId: string,
  coachState: AssignmentDrillInstruction['state'],
  athleteCanOpen: boolean | 'absent',
  athleteOpens: boolean,
];

/**
 * The fixture, one row per assignment: the coach's state and athlete_can_open
 * beside whether the athlete resolve for the SAME work was available. Pinned
 * so the property cannot pass by having nothing to range over, and so both
 * answers are known to occur.
 */
const FIXTURE_CAN_OPEN: CanOpenRow[] = [
  [ASG_LEGACY, 'no_drill', 'absent', false],
  [ASG_GYM, 'gym_written', 'absent', false],
  [ASG_LIVE, 'available', true, true],
  [ASG_PINNED_V1, 'available', true, true],
  [ASG_REFINED_V1, 'available', true, true],
  [ASG_REINSTATED_V2, 'available', true, true],
  [ASG_RETIRED, 'available', false, false],
  [ASG_WITHDRAWN, 'available', false, false],
  [ASG_ORG_B, 'available', true, true],
];

/**
 * Opens every assignment as both audiences, the way the route does. A coach
 * payload without the key records 'absent', so a non-available state that
 * grew the key -- or an available one that lost it -- is visible as a value.
 */
async function athleteCanOpenBesideAthleteAnswer(): Promise<CanOpenRow[]> {
  const rows: CanOpenRow[] = [];
  for (const [organizationId, assignmentId] of EVERY_ASSIGNMENT) {
    const coach = await openAssignment(organizationId, assignmentId, 'coach');
    const athlete = await openAssignment(organizationId, assignmentId, 'athlete');
    const athleteCanOpen = 'athlete_can_open' in coach ? coach.athlete_can_open : 'absent';
    rows.push([assignmentId, coach.state, athleteCanOpen, athlete.state === 'available']);
  }
  return rows;
}

/**
 * THE PROPERTY. Where the coach has an instruction, its athlete_can_open is
 * exactly the athlete's answer for the same assignment -- the same boolean,
 * not merely the same truthiness. Where the coach has none, there is no flag
 * to carry, and the athlete has nothing to open either.
 */
function expectCanOpenIsTheAthleteAnswer(rows: CanOpenRow[]): void {
  expect(rows).toHaveLength(EVERY_ASSIGNMENT.length);
  for (const [assignmentId, coachState, athleteCanOpen, athleteOpens] of rows) {
    if (coachState === 'available') {
      expect({ assignmentId, athleteCanOpen }).toEqual({ assignmentId, athleteCanOpen: athleteOpens });
    } else {
      expect({ assignmentId, athleteCanOpen, athleteOpens })
        .toEqual({ assignmentId, athleteCanOpen: 'absent', athleteOpens: false });
    }
  }
}

describe("WHETHER THE ATHLETE CAN OPEN IT: the coach's athlete_can_open is the athlete's own answer (real database)", () => {
  test('PROPERTY: for every assignment in the fixture, athlete_can_open equals whether the athlete resolve for the same work is available', async () => {
    const rows = await athleteCanOpenBesideAthleteAnswer();

    expectCanOpenIsTheAthleteAnswer(rows);
    // Every scenario, both answers, each row as seeded.
    expect(rows).toEqual(FIXTURE_CAN_OPEN);
  });

  test('CONTROL: nothing else the coach payload carries predicts athlete_can_open in this fixture', async () => {
    // A property a proxy could satisfy proves little. Across these four rows
    // the lifecycle line, the reference row's own `active` and the assigned
    // operational row's own `active` each keep one value while
    // athlete_can_open takes both -- so a flag computed from any one of them
    // fails the property above on at least one row.
    const observed: Array<[string, string, boolean, boolean, boolean]> = [];
    for (const assignmentId of [ASG_LIVE, ASG_WITHDRAWN, ASG_RETIRED, ASG_REFINED_V1]) {
      const coach = await openAsCoach(assignmentId);
      const { rows } = await seededClient.query<{ active: boolean }>(
        `select d.active from pilot.drill_assignments a
         join pilot.drills d on d.organization_id = a.organization_id and d.drill_id = a.drill_id
         where a.organization_id = $1 and a.assignment_id = $2`,
        [ORG_A, assignmentId],
      );
      observed.push([assignmentId, coach.operational_lifecycle, coach.drill.active, rows[0].active, coach.athlete_can_open]);
    }

    expect(observed).toEqual([
      // [assignment, lifecycle, reference active, operational row active, athlete_can_open]
      [ASG_LIVE, 'current', true, true, true],
      [ASG_WITHDRAWN, 'current', false, true, false], // lifecycle 'current', operational active: yet false
      [ASG_RETIRED, 'retired', true, false, false], // reference active: yet false
      [ASG_REFINED_V1, 'changed', true, false, true], // operational row inactive: yet true
    ]);
  });

  test('where the lineage and the promotion disagree, the flag follows the athlete read, not the lineage (rolled back)', async () => {
    // In every state the writers reach today, adoption copies reference_drill_id
    // forward, so "some version of this lineage is active, and the reference is
    // active" coincides with the promoted-and-live rule -- and a flag computed
    // from the lifecycle line plus drill.active would pass every assertion
    // above. The schema allows them to part: pilot_drills_one_reference_per_org
    // is scoped to lineage roots, so a successor version may carry another
    // pointer. Re-point the refined v2 at REF_RETIRED and they part both ways:
    //   ASG_REFINED_V1: lineage still run ('changed'), reference active, but no
    //                   active drill points at REF_REFINED any more -> false.
    //   ASG_RETIRED:    lineage retired, but an active drill now points at
    //                   REF_RETIRED -> the athlete can open it -> true.
    // Rolled back, so the shared fixture is untouched (checked below).
    const before = await snapshot();
    await seededClient.query('begin');
    try {
      await seededClient.query(
        `update pilot.drills set reference_drill_id = $3 where organization_id = $1 and drill_id = $2`,
        [ORG_A, OP_REFINED_V2, REF_RETIRED],
      );

      const rows = await athleteCanOpenBesideAthleteAnswer();
      expectCanOpenIsTheAthleteAnswer(rows);
      expect(rows).toEqual(FIXTURE_CAN_OPEN.map((row): CanOpenRow => {
        if (row[0] === ASG_REFINED_V1) return [ASG_REFINED_V1, 'available', false, false];
        if (row[0] === ASG_RETIRED) return [ASG_RETIRED, 'available', true, true];
        return row;
      }));

      // The lifecycle line and the reference row did NOT move: only the
      // promotion did, and the flag moved with it.
      const refined = await openAsCoach(ASG_REFINED_V1);
      expect([refined.operational_lifecycle, refined.drill.active, refined.athlete_can_open])
        .toEqual(['changed', true, false]);
      const retired = await openAsCoach(ASG_RETIRED);
      expect([retired.operational_lifecycle, retired.drill.active, retired.athlete_can_open])
        .toEqual(['retired', true, true]);
      // And the athlete really does get the pinned REF_RETIRED instruction.
      expect((await openAsAthlete(ASG_RETIRED)).drill.purpose).toBe('Retired purpose.');
    } finally {
      await seededClient.query('rollback');
    }
    expect(await snapshot()).toEqual(before);
  });
});

/**
 * THE TABLES THE CHAIN TOUCHES, AS CONTENT. A count alone would miss an
 * UPDATE, which is the write that actually threatens here: touching
 * completion_percentage, status or updated_at on open. So each table is
 * hashed over every column of every row, in key order.
 *
 * The lifecycle read put drillVersioning on the chain, so the two tables that
 * module owns besides pilot.drills are hashed too: a "record that a coach
 * looked at this version" write would land in one of them. Empty here, which
 * still makes any insert a change in both count and hash.
 */
const SNAPSHOT_TABLES: Array<[table: string, orderBy: string]> = [
  ['pilot.drill_assignments', 'assignment_id'],
  ['pilot.assignment_completions', 'completion_id'],
  ['pilot.drills', 'organization_id, drill_id'],
  ['pilot.drill_library', 'organization_id, drill_id'],
  ['pilot.drill_scale_levels', 'organization_id, scale_id'],
  ['pilot.drill_stop_rules', 'organization_id, stop_rule_id'],
  ['pilot.drill_cues', 'organization_id, cue_id'],
  ['pilot.drill_change_proposals', 'organization_id, proposal_id'],
  ['pilot.drill_version_outcomes', 'organization_id, outcome_id'],
];

async function snapshot(): Promise<Record<string, { rows: number; md5: string }>> {
  const result: Record<string, { rows: number; md5: string }> = {};
  for (const [table, orderBy] of SNAPSHOT_TABLES) {
    const { rows } = await seededClient.query<{ rows: number; md5: string }>(
      `select count(*)::int as rows,
              md5(coalesce(string_agg(t::text, E'\\n' order by ${orderBy}), '')) as md5
       from ${table} t`,
    );
    result[table] = rows[0];
  }
  return result;
}

/**
 * Everything a viewer can do from assigned work: read every assignment in both
 * gyms, as both audiences, plus the cross-organization probes -- and the
 * lifecycle read directly, for every operational row in both gyms, which
 * reaches the not-in-this-gym path the resolver never takes. Returns what it
 * saw so a sweep that silently did nothing cannot pass.
 */
async function openEverything(): Promise<string[]> {
  const states: string[] = [];
  for (const [organizationId, assignmentIds] of [
    [ORG_A, ORG_A_ASSIGNMENTS],
    [ORG_B, [ASG_ORG_B]],
  ] as const) {
    for (const assignmentId of assignmentIds) {
      for (const audience of ['athlete', 'coach'] as const) {
        const result = await openAssignment(organizationId, assignmentId, audience);
        const lifecycle = 'operational_lifecycle' in result ? `:${result.operational_lifecycle}` : '';
        states.push(`${assignmentId}:${audience}:${result.state}${lifecycle}`);
      }
    }
  }
  for (const [organizationId, drillIds] of [
    [ORG_A, ORG_A_OPERATIONAL],
    [ORG_B, ORG_B_OPERATIONAL],
  ] as const) {
    for (const drillId of drillIds) {
      states.push(`${organizationId}:${drillId}:lifecycle:${await getOperationalDrillLifecycle(organizationId, drillId)}`);
    }
  }
  await getDrillAssignmentById(ORG_A, ASG_ORG_B);
  await getDrillAssignmentById(ORG_B, ASG_LIVE);
  await getOperationalDrillLifecycle(ORG_B, OP_RETIRED);
  return states;
}

/** Two audiences per assignment, plus one lifecycle read per operational row. */
const SWEEP_SIZE =
  (ORG_A_ASSIGNMENTS.length + 1) * 2 + ORG_A_OPERATIONAL.length + ORG_B_OPERATIONAL.length;

describe('READ-ONLY: opening a drill from assigned work writes nothing (real database)', () => {
  test('every table the chain touches is identical, row for row, after opening every assignment', async () => {
    const before = await snapshot();
    // Non-trivial tables, so "identical" is a statement about data.
    expect(before['pilot.drill_assignments'].rows).toBe(ORG_A_ASSIGNMENTS.length + 1);
    expect(before['pilot.assignment_completions'].rows).toBe(2);
    expect(before['pilot.drills'].rows).toBe(ORG_A_OPERATIONAL.length + ORG_B_OPERATIONAL.length);
    expect(before['pilot.drill_library'].rows).toBeGreaterThan(0);
    expect(Object.keys(before).sort()).toEqual(SNAPSHOT_TABLES.map(([table]) => table).sort());

    const states = await openEverything();
    // Autocommit: any write any of these made has already persisted.
    const after = await snapshot();

    expect(states).toHaveLength(SWEEP_SIZE);
    expect(states.filter((state) => state.includes(':available')).length).toBeGreaterThan(0);
    // The sweep reached every lifecycle answer, through the resolver and directly.
    expect(states).toEqual(expect.arrayContaining([
      `${ASG_LIVE}:coach:available:current`,
      `${ASG_REFINED_V1}:coach:available:changed`,
      `${ASG_RETIRED}:coach:available:retired`,
      `${ORG_A}:${OP_REINSTATED_V2}:lifecycle:changed`,
      `${ORG_B}:${OP_REFINED_V1}:lifecycle:retired`,
    ]));
    expect(after).toEqual(before);
  });

  test('CONTROL: the snapshot does see a one-column change to one assignment', async () => {
    // The write an "open counts as progress" regression would make. Rolled
    // back, so the shared fixture is untouched.
    const before = await snapshot();
    await seededClient.query('begin');
    try {
      await seededClient.query(
        `update pilot.drill_assignments set completion_percentage = completion_percentage + 1
         where assignment_id = $1`,
        [ASG_LIVE],
      );
      const during = await snapshot();
      expect(during['pilot.drill_assignments'].md5).not.toBe(before['pilot.drill_assignments'].md5);
      expect(during['pilot.drill_assignments'].rows).toBe(before['pilot.drill_assignments'].rows);
    } finally {
      await seededClient.query('rollback');
    }
    expect(await snapshot()).toEqual(before);
  });

  test('CONTROL: the snapshot does see a row appear in a versioning table that starts empty', async () => {
    // The write a "lifecycle read records an outcome" regression would make.
    const before = await snapshot();
    expect(before['pilot.drill_version_outcomes'].rows).toBe(0);
    await seededClient.query('begin');
    try {
      await seededClient.query(
        `insert into pilot.drill_version_outcomes
           (outcome_id, organization_id, drill_id, lineage_id, window_start, window_end, computed_by)
         values ('out-wd4b-control', $1, $2, $3, '2026-09-01', '2026-09-30', 'manual')`,
        [ORG_A, OP_REFINED_V1, OP_REFINED_V1],
      );
      const during = await snapshot();
      expect(during['pilot.drill_version_outcomes']).not.toEqual(before['pilot.drill_version_outcomes']);
      expect(during['pilot.drill_version_outcomes'].rows).toBe(1);
    } finally {
      await seededClient.query('rollback');
    }
    expect(await snapshot()).toEqual(before);
  });

  test('the same sweep succeeds inside a READ ONLY transaction, where Postgres refuses any write to any table', async () => {
    // Wider than the hash: a write to a table not listed above -- an activity
    // log, a progress touch elsewhere -- fails here with 25006.
    await seededClient.query('begin transaction read only');
    try {
      const states = await openEverything();
      expect(states).toHaveLength(SWEEP_SIZE);
      await seededClient.query('commit');
    } catch (error) {
      await seededClient.query('rollback').catch(() => {});
      throw error;
    }
  });

  test('CONTROL: the READ ONLY transaction does refuse a write', async () => {
    await seededClient.query('begin transaction read only');
    try {
      await expect(
        seededClient.query(
          `update pilot.drill_assignments set status = 'completed' where assignment_id = $1`,
          [ASG_LIVE],
        ),
      ).rejects.toMatchObject({ code: '25006' });
    } finally {
      await seededClient.query('rollback');
    }
  });
});
