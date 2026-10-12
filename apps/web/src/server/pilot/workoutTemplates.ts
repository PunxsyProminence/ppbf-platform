import { adoptionReadiness } from '../../lib/drillAdoptionReadiness';
import { requiresFloorValidation } from '../../lib/drillFloorValidation';
import { writePilotAuditEvent } from './audit';
import { issueCoachCard } from './coachCards';
import type { PilotRole } from './contracts';
import { query, queryOne, withTransaction } from './db';
import { listFloorValidations } from './drillFloorValidations';
import {
  getDrillWithDetail,
  getOtherVersionAdoption,
  listReferenceLifecycles,
  type DrillWithDetail,
} from './drillLibraryV3';
import {
  DrillNameTakenError,
  ReferenceDrillAlreadyPromotedError,
  isDrillDifficulty,
  promoteReferenceDrill,
  type DrillDifficulty,
} from './drills';
import { updateDrillToReferenceVersion } from './drillVersioning';
import { ConflictError } from './errors';
import { assertNewAssignmentMeetsCueRule, type DrillAssignment } from './progression';
import {
  findWorkoutIssueByRequestKey,
  recordWorkoutIssue,
  WorkoutIssueRequestKeyTakenError,
} from './workoutIssues';

// pilot.workout_templates and pilot.workout_template_items are owned by
// infra/azure/pilot_slice_postgres_workout_templates_v2_migration.sql,
// applied through the apply-migrations workflow like every other table.
// Nothing here issues DDL. The TEMPLATES are read-only, matching
// drillLibraryV3.ts's own design -- a change-proposal review lifecycle for
// templates is a reasonable future consolidation with drillVersioning.ts, not
// attempted here. The one write in this module is issueWorkoutTemplate, at the
// foot: it writes assignments, adopted drills and the issued workout's shape
// (workoutIssues.ts), never a template row.
//
// SCALE LEVEL IS NEVER FORCED. getWorkoutTemplateWithItems returns each
// item's drill_id and its own scale_level PREFERENCE (nullable) as-is --
// it does not resolve or default a level. A caller wanting the full A/B/C
// detail for a specific drill calls drillLibraryV3.ts's
// getDrillWithDetail, which already returns all three levels together;
// this module does not duplicate that read.
//
// AN ITEM KEEPS THE DRILL VERSION IT WAS WRITTEN AGAINST. item.drill_id
// names one exact pilot.drill_library row, and a revised drill is a new row
// in the same lineage (drill_library v3 migration :86-89), so a template can
// point at a drill that has since been revised. The item is NOT repointed:
// the template was authored against that version, and silently swapping the
// drill under it is the in-place edit versioning exists to prevent. Instead
// the read reports, per item, the lineage's head and whether the item is
// behind it, so the coach sees it and decides.

export type WorkoutTemplateDifficulty = 'beginner' | 'intermediate' | 'advanced' | 'elite';
export type WorkoutTemplateItemScaleLevel = 'A' | 'B' | 'C';
export type WorkoutTemplateItemContactLevel =
  | 'none'
  | 'light_technical'
  | 'conditioned'
  | 'controlled_sparring'
  | 'open_sparring';

export interface WorkoutTemplateRow {
  organization_id: string;
  template_id: string;
  lineage_id: string;
  version: number;
  supersedes_template_id: string | null;
  superseded_at: string | null;
  name: string;
  session_type: string;
  difficulty: WorkoutTemplateDifficulty;
  age_band: string;
  duration_minutes: number;
  intent: string;
  coach_notes: string | null;
  requires_coach_authorization: boolean;
  active: boolean;
  created_by_account_id: string | null;
  created_by_role: string | null;
  created_at: string;
  updated_at: string;
}

export interface WorkoutTemplateItemRow {
  organization_id: string;
  item_id: string;
  template_id: string;
  ordinal: number;
  block: string;
  drill_id: string | null;
  free_text_drill: string | null;
  scale_level: WorkoutTemplateItemScaleLevel | null;
  duration_minutes: number | null;
  rep_count: number | null;
  contact_level: WorkoutTemplateItemContactLevel;
  coach_note: string | null;
  created_at: string;
}

/**
 * An item as the detail read returns it: the stored row plus where its drill
 * stands in its lineage. Derived on every read (nothing stored), so it cannot
 * drift from the drill rows it describes.
 *
 *   head_drill_id             the highest version in the item's drill lineage;
 *                             equal to drill_id when the item is current. Null
 *                             for a free-text item, which has no lineage.
 *   head_drill_name           that head's name, what the coach screen shows
 *                             for a linked item. Null exactly when
 *                             head_drill_id is.
 *   uses_older_drill_version  true when a higher version of the item's drill
 *                             exists. Always false for a free-text item.
 */
export interface WorkoutTemplateItemWithDrillHead extends WorkoutTemplateItemRow {
  head_drill_id: string | null;
  head_drill_name: string | null;
  uses_older_drill_version: boolean;
}

const TEMPLATE_FIELDS =
  'organization_id, template_id, lineage_id, version, supersedes_template_id, superseded_at, name, '
  + 'session_type, difficulty, age_band, duration_minutes, intent, coach_notes, requires_coach_authorization, '
  + 'active, created_by_account_id, created_by_role, created_at, updated_at';

const ITEM_FIELDS =
  'organization_id, item_id, template_id, ordinal, block, drill_id, free_text_drill, scale_level, '
  + 'duration_minutes, rep_count, contact_level, coach_note, created_at';

// The same columns qualified to the item alias, because the detail read joins
// pilot.drill_library, which also has organization_id, drill_id,
// contact_level and created_at -- a bare column would be ambiguous.
const ITEM_FIELDS_QUALIFIED = ITEM_FIELDS.split(', ').map((field) => `i.${field}`).join(', ');

export async function listWorkoutTemplates(
  organizationId: string,
  filter: { sessionType?: string; difficulty?: WorkoutTemplateDifficulty; ageBand?: string } = {},
): Promise<WorkoutTemplateRow[]> {
  return query<WorkoutTemplateRow>(
    `select ${TEMPLATE_FIELDS}
     from pilot.workout_templates
     where organization_id = $1
       and active
       and ($2::text is null or session_type = $2)
       and ($3::text is null or difficulty = $3)
       and ($4::text is null or age_band = $4)
     order by session_type, difficulty, name`,
    [organizationId, filter.sessionType ?? null, filter.difficulty ?? null, filter.ageBand ?? null],
  );
}

export interface WorkoutTemplateWithItems {
  template: WorkoutTemplateRow;
  items: WorkoutTemplateItemWithDrillHead[];
}

export async function getWorkoutTemplateWithItems(
  organizationId: string,
  templateId: string,
): Promise<WorkoutTemplateWithItems | null> {
  const template = await queryOne<WorkoutTemplateRow>(
    `select ${TEMPLATE_FIELDS} from pilot.workout_templates where organization_id = $1 and template_id = $2`,
    [organizationId, templateId],
  );
  if (!template) {
    return null;
  }

  // HEAD = the highest version in the lineage, the rule drillLibraryV3.ts's
  // listReferenceLifecycles already uses for "the adopted lineage's HEAD".
  // Not superseded_at: that column is set by whoever loads the revision, and
  // a comparison of versions cannot be left out of step with the rows. Not
  // filtered on active either: active means "not withdrawn", a separate axis
  // from superseded (drillAdoptionReadiness.ts:51-52), so it says nothing
  // about which version is newest.
  //
  // The lateral join is scoped to the item's own organization at both hops,
  // so a lineage id shared with another gym can never supply the head.
  const items = await query<WorkoutTemplateItemWithDrillHead>(
    `select ${ITEM_FIELDS_QUALIFIED},
            head.drill_id as head_drill_id,
            head.name as head_drill_name,
            coalesce(head.drill_id <> i.drill_id, false) as uses_older_drill_version
     from pilot.workout_template_items i
     left join pilot.drill_library pinned
       on pinned.organization_id = i.organization_id
      and pinned.drill_id = i.drill_id
     left join lateral (
       select h.drill_id, h.name
       from pilot.drill_library h
       where h.organization_id = pinned.organization_id
         and h.lineage_id = pinned.lineage_id
       order by h.version desc
       limit 1
     ) head on true
     where i.organization_id = $1 and i.template_id = $2
     order by i.ordinal asc`,
    [organizationId, templateId],
  );

  return { template, items };
}

// ---------------------------------------------------------------------------
// ISSUING A TEMPLATE TO ONE ATHLETE -- OD-2026-10-07-012 ruling 2; the
// floor test as Jason ruled it on 2026-10-11 ("B", issue #1473), which
// replaces OD-2026-10-08-002 item 2 at template issue.
//
// Every step becomes one gap-free assignment (a Coach Card: issueCoachCard,
// the same writer the cards route uses), all in ONE transaction, so a template
// is issued whole or not at all.
//
// A step names a REFERENCE drill (pilot.drill_library), and only an
// operational drill (pilot.drills) may be assigned (OD-2026-09-18-001). So:
//   - the gym already runs the drill          -> its operational drill is
//     assigned, even when its reference has since been withdrawn or superseded
//     (an adopted drill is the gym's).
//   - the gym has not adopted it, it is ready -> it is adopted in the same
//     transaction (promoteReferenceDrill, audited as a promotion is), then
//     assigned. "Ready" is adoptionReadiness, the check the promote route
//     enforces, with ONE difference: the floor test is taken as met here.
//
// THE FLOOR TEST DOES NOT STOP AN ISSUE (Jason, 2026-10-11: "B" -- "Let a
// workout be issued with untested drills, shown to the coach as untested";
// issue #1473). A draft no coach of this gym has floor-tested stays a draft
// and stays marked untested (OD-2026-10-06-026 ruling 3); it is assigned, and
// adopted or updated in place when the step needs it, and the result and the
// audit name it (listUntestedTemplateDrills, the same list the template's
// detail read gives the coach before issuing). Adoption by hand, the promote
// route, still requires the floor test: that rule is not this one.
//   - it is a newer version of a drill the gym runs, and it is ready -> the
//     gym's drill is updated to it in place in the same transaction
//     (updateDrillToReferenceVersion, as the promote route does; Jason,
//     question card 2026-10-11: "A: Update while issuing (Recommended)"), then
//     the new version is assigned. A step naming an OLDER version than the
//     gym's updated drill is the first case: the gym runs that drill.
//   - anything else                           -> the WHOLE issue is refused and
//     every such drill is named with its reason. Nothing is written.
//
// THE WORKOUT KEEPS ITS SHAPE (lane P7c, OD-2026-10-10-004 ruling 5). The
// assignment carries the drill, its rep count and its minutes;
// pilot.drill_assignments has no column for a step's block, its place in the
// order, its scale level, its contact level or its coach note. Those, and the
// link back to the template, are written by recordWorkoutIssue
// (workoutIssues.ts) in the SAME transaction as the assignments: one issue
// row, one row per step. An issue made before that existed has no such rows
// and reads as separate assignments.
//
// AUTHORIZATION IS THE ROUTE'S. Like issueCoachCard, this trusts its caller to
// have passed the role gate and assertActorCanAccessAthlete; organizationId is
// the session's and scopes every read and write below.
// ---------------------------------------------------------------------------

// The operational ceiling the promote route enforces (drills/promote/route.ts
// MAX_CUES): an adopted drill takes the reference's first twelve cues.
const MAX_ADOPTED_CUES = 12;

/** One drill (or typed step) that stopped a template from being issued. */
export interface TemplateIssueRefusedDrill {
  /** The template steps (ordinals) that name it. */
  steps: number[];
  /** The reference drill id; null for a typed step, which names no drill. */
  drill_id: string | null;
  name: string;
  reason: string;
}

/**
 * A drill in a template that no coach of this gym has floor-tested. It does not
 * stop the issue (Jason, 2026-10-11: "B", issue #1473); it is named to the
 * coach before and after issuing.
 */
export interface TemplateUntestedDrill {
  /**
   * The reference drill whose floor test counts: the version the gym runs
   * when a step names an older one it has updated past, otherwise the step's
   * own. The id a coach marks floor-tested.
   */
  reference_drill_id: string;
  name: string;
  /** The template steps (ordinals) that name it. */
  steps: number[];
}

export interface TemplateIssuedStep {
  /** The template step (ordinal) this assignment was created from. */
  step: number;
  item_id: string;
  assignment: DrillAssignment;
}

export interface TemplateAdoptedDrill {
  /** The gym's new operational drill. */
  drill_id: string;
  reference_drill_id: string;
  name: string;
}

/** A drill the gym already ran, updated in place to the reference version a step names (D1). Not an adoption. */
export interface TemplateUpdatedDrill {
  /** The new version of the gym's drill. */
  drill_id: string;
  reference_drill_id: string;
  name: string;
  /** The version it replaced. */
  updated_from_drill_id: string;
}

export type TemplateIssueResult =
  | { outcome: 'not_found' }
  | { outcome: 'refused'; message: string; drills: TemplateIssueRefusedDrill[] }
  | {
      outcome: 'issued';
      /** The issued workout (pilot.workout_issues) that holds the steps' shape. */
      issue_id: string;
      template: { template_id: string; name: string; version: number };
      steps: TemplateIssuedStep[];
      adopted: TemplateAdoptedDrill[];
      updated: TemplateUpdatedDrill[];
      /** Drills in this workout no coach of this gym has floor-tested. Assigned all the same. */
      untested: TemplateUntestedDrill[];
    }
  // A repeat of a request that already issued this workout: nothing was
  // written this time. The template is as it was issued.
  | {
      outcome: 'already_issued';
      issue_id: string;
      template: { template_id: string; name: string; version: number };
      step_count: number;
    };

const TYPED_STEP_REASON =
  'This step is typed text, not a drill from the library, so it cannot be assigned.';
const RETIRED_ADOPTION_REASON =
  'This gym adopted this drill and then retired it. Restore it in the drill library first.';
// Restore is refused once the reference is withdrawn (drills.ts restore guard),
// so that case is not sent to a step that cannot work.
const RETIRED_WITHDRAWN_REASON =
  'This gym adopted this drill and then retired it, and its reference has since been withdrawn, so it cannot be assigned.';
const SHARED_NAME_REASON =
  'Another drill in this template has the same name, and a gym can hold only one drill under a name.';
const RETIRED_OTHER_VERSION_REASON =
  'This gym adopted an earlier version of this drill and then retired it. Restore it in the drill library first.';
const UNREADABLE_DRILL_REASON = 'This drill could not be read from the library.';

function refusalMessage(drills: TemplateIssueRefusedDrill[]): string {
  return `Nothing was issued. Cannot be assigned as they stand: ${drills.map((drill) => drill.name).join(', ')}.`;
}

/**
 * The drills in a template that no coach of this gym has floor-tested, in step
 * order. Reads only; every query is scoped to the organization. The issue
 * plan and the template's detail read both use it, so the list the coach sees
 * before issuing and the one the result names come from one rule.
 *
 * Which drill's floor test counts: the drill the step will actually assign.
 * The step's own reference, except when the gym runs this drill and
 *   - the SAME template names a newer version of it, which the issue will
 *     update the gym's drill to (every step on that drill then assigns the
 *     newer version), so the newer version counts; or
 *   - the step names a version the gym has since updated past, so the version
 *     the gym runs counts (the rule the issue used when the floor test still
 *     refused).
 * Only a draft (requiresFloorValidation) can be untested; another gym's mark
 * does not count.
 */
export async function listUntestedTemplateDrills(
  organizationId: string,
  items: readonly Pick<WorkoutTemplateItemWithDrillHead, 'drill_id' | 'ordinal'>[],
): Promise<TemplateUntestedDrill[]> {
  const stepsByReference = new Map<string, number[]>();
  for (const item of items) {
    if (item.drill_id !== null) {
      stepsByReference.set(item.drill_id, [...(stepsByReference.get(item.drill_id) ?? []), item.ordinal]);
    }
  }
  const referenceIds = [...stepsByReference.keys()];
  if (referenceIds.length === 0) {
    return [];
  }

  const lifecycles = await listReferenceLifecycles(organizationId, referenceIds);

  // The gym drills this template will update in place: gym drill id -> the
  // newer reference a step names. Asked only when some step names a drill the
  // gym runs, since only those steps can be moved onto the newer version, and
  // only for a 'newer_version_available' reference: the one state the issue
  // updates from (active, not superseded, the gym's lineage still running).
  // Superseded, withdrawn and retired-lineage versions are refused by the
  // issue, so they never decide which version a step assigns.
  const updatedTo = new Map<string, string>();
  const runsSome = referenceIds.some((id) => lifecycles[id]?.state === 'operational');
  if (runsSome) {
    for (const referenceId of referenceIds) {
      if (lifecycles[referenceId]?.state !== 'newer_version_available') continue;
      const other = await getOtherVersionAdoption(organizationId, referenceId);
      if (other) updatedTo.set(other.operational_drill_id, referenceId);
    }
  }

  const drafts = new Map<string, TemplateUntestedDrill>();
  for (const referenceId of referenceIds) {
    const reference = await getDrillWithDetail(organizationId, referenceId);
    if (!reference) {
      // Unreadable: the issue refuses it by name; there is no draft to judge.
      continue;
    }
    let countedId = referenceId;
    let counted: DrillWithDetail = reference;
    const lifecycle = lifecycles[referenceId];
    const newer = lifecycle?.state === 'operational' && lifecycle.operational_drill_id
      ? updatedTo.get(lifecycle.operational_drill_id)
      : undefined;
    if (newer !== undefined && newer !== referenceId) {
      const newerDrill = await getDrillWithDetail(organizationId, newer);
      if (!newerDrill) {
        // Unreadable: the issue refuses it by name.
        continue;
      }
      countedId = newer;
      counted = newerDrill;
    } else if (lifecycle?.state === 'operational' && lifecycle.operational_drill_id && reference.superseded_at !== null) {
      const runs = (await queryOne<{ reference_drill_id: string | null }>(
        `select o.reference_drill_id from pilot.drills o where o.organization_id = $1 and o.drill_id = $2`,
        [organizationId, lifecycle.operational_drill_id],
      ))?.reference_drill_id ?? null;
      if (runs !== null && runs !== referenceId) {
        countedId = runs;
        counted = (await getDrillWithDetail(organizationId, runs)) ?? reference;
      }
    }
    if (!requiresFloorValidation(counted.field_provenance)) {
      continue;
    }
    const steps = stepsByReference.get(referenceId) ?? [];
    const existing = drafts.get(countedId);
    drafts.set(countedId, {
      reference_drill_id: countedId,
      name: counted.name,
      steps: existing ? [...existing.steps, ...steps].sort((a, b) => a - b) : [...steps],
    });
  }
  if (drafts.size === 0) {
    return [];
  }

  const marks = await listFloorValidations(organizationId, [...drafts.keys()]);
  return [...drafts.values()]
    .filter((drill) => !marks[drill.reference_drill_id])
    .sort((a, b) => Math.min(...a.steps) - Math.min(...b.steps));
}

interface TemplateIssuePlan {
  refused: TemplateIssueRefusedDrill[];
  /** reference drill id -> the gym's active operational drill id. */
  operational: Map<string, string>;
  /** Reference drills to adopt, or to update the gym's drill to, in the transaction, in drill-id order. */
  adoptions: AdoptableReference[];
  /** Drills no coach of this gym has floor-tested; named, never refused. */
  untested: TemplateUntestedDrill[];
}

/**
 * A reference drill whose difficulty is already known to be in the operational
 * vocabulary. `update` is set when it is a newer version of a drill the gym
 * runs: the gym drill to update, and its lineage (whose own name is not a clash).
 */
type AdoptableReference = DrillWithDetail & {
  difficulty: DrillDifficulty;
  update: { drillId: string; lineageId: string } | null;
};

/**
 * The read-only pass: what each step's drill is to this gym right now. Writes
 * nothing, and takes no lock, so its answer can be stale by the time the
 * transaction runs. The transaction re-decides: the unique indexes on
 * pilot.drills (a name or a reference taken in the meantime),
 * issueCoachCard's insert-from-an-active-drill (a drill retired in the
 * meantime), and, for an update in place, updateDrillToReferenceVersion's
 * checks under its lineage lock (retired, already updated, a name clash).
 * Each ends in a rollback and a conflict, never a partial write.
 * NOT re-decided: a reference withdrawn or superseded, another version of a
 * drill adopted, or the template replaced, between this pass and the write --
 * the same windows the promote route has between its checks and its insert.
 */
async function planTemplateIssue(
  organizationId: string,
  items: WorkoutTemplateItemWithDrillHead[],
): Promise<TemplateIssuePlan> {
  const plan: TemplateIssuePlan = {
    refused: [],
    operational: new Map(),
    adoptions: [],
    untested: await listUntestedTemplateDrills(organizationId, items),
  };

  for (const item of items) {
    if (item.drill_id === null) {
      plan.refused.push({
        steps: [item.ordinal],
        drill_id: null,
        name: (item.free_text_drill ?? '').trim() || `Step ${item.ordinal}`,
        reason: TYPED_STEP_REASON,
      });
    }
  }

  // One verdict per reference drill, however many steps name it.
  const stepsByReference = new Map<string, number[]>();
  for (const item of items) {
    if (item.drill_id !== null) {
      stepsByReference.set(item.drill_id, [...(stepsByReference.get(item.drill_id) ?? []), item.ordinal]);
    }
  }
  const referenceIds = [...stepsByReference.keys()];
  if (referenceIds.length === 0) {
    return plan;
  }

  const lifecycles = await listReferenceLifecycles(organizationId, referenceIds);
  const refuseDrill = (referenceId: string, name: string, reason: string) => {
    plan.refused.push({
      steps: stepsByReference.get(referenceId) ?? [],
      drill_id: referenceId,
      name,
      reason,
    });
  };
  const candidates: AdoptableReference[] = [];

  for (const referenceId of referenceIds) {
    const reference = await getDrillWithDetail(organizationId, referenceId);
    const lifecycle = lifecycles[referenceId];
    const refuse = (reason: string) => refuseDrill(referenceId, reference?.name ?? referenceId, reason);

    if (!reference || !lifecycle) {
      refuse(UNREADABLE_DRILL_REASON);
      continue;
    }

    // The gym runs this drill: no adoption, and the reference being withdrawn
    // or superseded since no longer decides anything (an adopted drill
    // outlives its reference). One rule still applies to a NEW issue of it,
    // the cue rule on a new assignment, and it is asked here so the drill is
    // named with the others rather than surfacing alone from inside the
    // transaction (where issueCoachCard asks it again on the transaction's
    // own connection). An untested draft is not refused (Jason, 2026-10-11:
    // "B"); listUntestedTemplateDrills names it.
    if (lifecycle.state === 'operational' && lifecycle.operational_drill_id) {
      try {
        await assertNewAssignmentMeetsCueRule(organizationId, lifecycle.operational_drill_id);
      } catch (error) {
        if (!(error instanceof ConflictError)) {
          throw error;
        }
        refuse(error.message);
        continue;
      }
      plan.operational.set(referenceId, lifecycle.operational_drill_id);
      continue;
    }

    // Adopted once and retired: the promote route refuses a second promotion
    // and sends the coach to Restore, so issuing does not revive it either.
    if (lifecycle.state === 'retired') {
      refuse(reference.active ? RETIRED_ADOPTION_REASON : RETIRED_WITHDRAWN_REASON);
      continue;
    }

    // Not adopted. The readiness check the promote route enforces, on the
    // same inputs, with the floor test taken as met (Jason, 2026-10-11: "B"):
    // every OTHER rule -- withdrawn, superseded, no stop rule, no cue,
    // incomplete scaling -- still refuses, and a draft untested AND short of
    // something else is refused for the something else alone. Adoption by
    // hand keeps the floor test.
    const readiness = adoptionReadiness({ ...reference, floor_tested_by_this_gym: true });
    if (!readiness.ready) {
      refuse(readiness.missing.join(' '));
      continue;
    }

    // A newer version of a drill this gym already has: issuing updates the
    // gym's drill to it in place, as the promote route does. Retired is
    // refused and named here (no version of the gym's lineage active), so it
    // is named with the others; the write asks again under its lock.
    let update: AdoptableReference['update'] = null;
    const otherVersion = await getOtherVersionAdoption(organizationId, referenceId);
    if (otherVersion) {
      const gymDrill = await queryOne<{ lineage_id: string; lineage_active: boolean }>(
        `select d.lineage_id,
                exists (
                  select 1 from pilot.drills l
                  where l.organization_id = d.organization_id and l.lineage_id = d.lineage_id and l.active
                ) as lineage_active
         from pilot.drills d
         where d.organization_id = $1 and d.drill_id = $2`,
        [organizationId, otherVersion.operational_drill_id],
      );
      if (!gymDrill) {
        refuse(UNREADABLE_DRILL_REASON);
        continue;
      }
      if (!gymDrill.lineage_active) {
        refuse(RETIRED_OTHER_VERSION_REASON);
        continue;
      }
      update = { drillId: otherVersion.operational_drill_id, lineageId: gymDrill.lineage_id };
    }

    // The promote route checks the same vocabulary before it writes: a
    // reference row holding another value is not coerced.
    const difficulty = reference.difficulty;
    if (!isDrillDifficulty(difficulty)) {
      refuse('Its difficulty is not one this gym can assign.');
      continue;
    }

    candidates.push({ ...reference, difficulty, update });
  }

  // NAMES, for every drill about to be adopted, in one read. A gym holds one
  // ACTIVE drill per name (pilot_drills_one_name_per_org), and an adopted
  // drill takes the reference's name. Asked here rather than left to the index
  // so EVERY clash is named in one answer; the index stops a transaction at
  // the first. The library allows one name per discipline, so two drills of
  // one template can share a name the gym can hold only once.
  // A drill being updated holds its own name already; only another lineage's
  // drill under that name is a clash.
  const takenRows = candidates.length === 0
    ? []
    : await query<{ name: string; lineage_id: string }>(
        `select d.name, d.lineage_id from pilot.drills d
         where d.organization_id = $1 and d.active and d.name = any($2::text[])`,
        [organizationId, candidates.map((reference) => reference.name)],
      );
  for (const reference of candidates) {
    const clash = takenRows.some((row) =>
      row.name === reference.name && (reference.update === null || row.lineage_id !== reference.update.lineageId));
    if (clash) {
      refuseDrill(
        reference.drill_id,
        reference.name,
        `${new DrillNameTakenError(reference.name).message}, so this one cannot be adopted under that name.`,
      );
    } else if (candidates.some((other) => other.drill_id !== reference.drill_id && other.name === reference.name)) {
      refuseDrill(reference.drill_id, reference.name, SHARED_NAME_REASON);
    } else {
      plan.adoptions.push(reference);
    }
  }
  // One fixed order for every issue, so two issues adopting the same two
  // drills take the index locks in the same order and cannot deadlock.
  plan.adoptions.sort((a, b) => (a.drill_id < b.drill_id ? -1 : a.drill_id > b.drill_id ? 1 : 0));

  // In step order, so the answer reads the way the template does.
  plan.refused.sort((a, b) => Math.min(...a.steps) - Math.min(...b.steps));
  return plan;
}

/**
 * The answer to a request whose key already names an issue, or null when the
 * key names none. A key is one issue's: sent again with a different athlete or
 * template it is refused, never answered with the other issue and never
 * issued a second time under the same key.
 */
async function repeatOfIssuedRequest(
  organizationId: string,
  requestKey: string,
  athleteId: string,
  templateId: string,
): Promise<TemplateIssueResult | null> {
  const first = await findWorkoutIssueByRequestKey(organizationId, requestKey);
  if (!first) return null;
  if (first.athlete_id !== athleteId || first.template_id !== templateId) {
    throw new ConflictError(
      'This request was already used to issue a different workout.',
      'WORKOUT_ISSUE_REQUEST_KEY_REUSED',
    );
  }
  return {
    outcome: 'already_issued',
    issue_id: first.issue_id,
    template: { template_id: first.template_id, name: first.template_name, version: first.template_version },
    step_count: first.step_count,
  };
}

/**
 * Issues one saved workout template to one athlete: every step an assignment,
 * every unadopted-but-ready reference drill adopted, in one transaction.
 *
 * Returns 'not_found' for a template id that names nothing in this gym,
 * 'refused' (nothing written) when any step cannot be assigned, 'issued' with
 * what was created, and 'already_issued' (nothing written) for a repeat of a
 * request whose key already issued this workout. Throws ConflictError for a
 * template that is withdrawn or has no steps, for a write that lost a race,
 * and for a request key already used for a different workout.
 */
export async function issueWorkoutTemplate(params: {
  organizationId: string;
  templateId: string;
  athleteId: string;
  actorAccountId: string;
  actorRole: PilotRole;
  /** The request's key, when it sent one. See workoutIssues.ts. */
  requestKey?: string | null;
}): Promise<TemplateIssueResult> {
  // FIRST, before the template is read: a request whose key already names an
  // issue is a repeat, and is answered with that issue whatever has happened
  // to the template since.
  const requestKey = params.requestKey ?? null;
  if (requestKey !== null) {
    const repeat = await repeatOfIssuedRequest(params.organizationId, requestKey, params.athleteId, params.templateId);
    if (repeat) return repeat;
  }

  const detail = await getWorkoutTemplateWithItems(params.organizationId, params.templateId);
  if (!detail) {
    return { outcome: 'not_found' };
  }
  const { template, items } = detail;

  // Only a current template is issued: not a withdrawn one (the list read
  // leaves those out) and not one a newer version has replaced.
  if (!template.active || template.superseded_at !== null) {
    throw new ConflictError(
      'This workout template is no longer in use, so it cannot be issued.',
      'WORKOUT_TEMPLATE_NOT_CURRENT',
    );
  }
  if (items.length === 0) {
    throw new ConflictError('This workout template has no steps to issue.', 'WORKOUT_TEMPLATE_EMPTY');
  }

  const plan = await planTemplateIssue(params.organizationId, items);
  if (plan.refused.length > 0) {
    return { outcome: 'refused', message: refusalMessage(plan.refused), drills: plan.refused };
  }

  try {
    return await withTransaction(async (client) => {
      const drillByReference = new Map(plan.operational);
      const adopted: TemplateAdoptedDrill[] = [];
      const updated: TemplateUpdatedDrill[] = [];

      for (const reference of plan.adoptions) {
        // The promote route's mapping, and the whole of it: focus <- purpose,
        // the first twelve non-blank cues in the reference's own order.
        const content = {
          name: reference.name,
          category: reference.category,
          focus: reference.purpose.trim(),
          difficulty: reference.difficulty,
          cues: reference.cues
            .map((cue) => cue.cue_text.trim())
            .filter((cue) => cue.length > 0)
            .slice(0, MAX_ADOPTED_CUES),
        };
        if (reference.update) {
          // Audited inside, with what caused it.
          const { drill, previous } = await updateDrillToReferenceVersion(
            {
              organizationId: params.organizationId,
              drillId: reference.update.drillId,
              referenceDrillId: reference.drill_id,
              content,
              actorAccountId: params.actorAccountId,
              actorRole: params.actorRole,
              auditDetails: { adopted_by: 'workout_template_issue', template_id: template.template_id },
            },
            client,
          );
          // Every step on this gym drill now assigns the new version, including
          // a step naming the older reference version the plan mapped to it.
          for (const [stepReference, drillId] of drillByReference) {
            if (drillId === reference.update.drillId || drillId === previous.drill_id) {
              drillByReference.set(stepReference, drill.drill_id);
            }
          }
          drillByReference.set(reference.drill_id, drill.drill_id);
          updated.push({
            drill_id: drill.drill_id,
            reference_drill_id: reference.drill_id,
            name: drill.name,
            updated_from_drill_id: previous.drill_id,
          });
          continue;
        }
        const drill = await promoteReferenceDrill(
          { organizationId: params.organizationId, referenceDrillId: reference.drill_id, ...content },
          client,
        );
        // The evidence a promotion writes, plus what caused this one.
        await writePilotAuditEvent(
          {
            event_type: 'create',
            actor_account_id: params.actorAccountId,
            actor_role: params.actorRole,
            organization_id: params.organizationId,
            entity_type: 'drill',
            entity_id: drill.drill_id,
            details: {
              name: drill.name,
              category: drill.category,
              difficulty: drill.difficulty,
              reference_drill_id: drill.reference_drill_id,
              adopted_by: 'workout_template_issue',
              template_id: template.template_id,
            },
          },
          client,
        );
        drillByReference.set(reference.drill_id, drill.drill_id);
        adopted.push({ drill_id: drill.drill_id, reference_drill_id: reference.drill_id, name: drill.name });
      }

      const steps: TemplateIssuedStep[] = [];
      for (const item of items) {
        const drillId = item.drill_id === null ? undefined : drillByReference.get(item.drill_id);
        if (!drillId) {
          // Unreachable while planTemplateIssue judges every step; thrown
          // rather than skipped, so a step can never be silently left out.
          throw new ConflictError(
            'This workout template changed while it was being issued. Nothing was issued; try again.',
            'WORKOUT_TEMPLATE_ISSUE_STATE_CHANGED',
          );
        }
        const assignment = await issueCoachCard(
          {
            organizationId: params.organizationId,
            athleteId: params.athleteId,
            assignedByAccountId: params.actorAccountId,
            drillId,
            repCount: item.rep_count ?? undefined,
            durationMinutes: item.duration_minutes ?? undefined,
          },
          client,
        );
        steps.push({ step: item.ordinal, item_id: item.item_id, assignment });
      }

      // The workout's shape, on this transaction: block, order, scale level,
      // contact level and coach note per step, each as the template item has
      // it, tied to the assignment that step just became.
      const issuedTemplate = { template_id: template.template_id, name: template.name, version: template.version };
      const itemById = new Map(items.map((item) => [item.item_id, item]));
      const issueId = await recordWorkoutIssue(client, {
        organizationId: params.organizationId,
        athleteId: params.athleteId,
        template: issuedTemplate,
        issuedByAccountId: params.actorAccountId,
        requestKey,
        steps: steps.map((issued) => {
          const item = itemById.get(issued.item_id) as WorkoutTemplateItemWithDrillHead;
          return {
            ordinal: item.ordinal,
            block: item.block,
            scale_level: item.scale_level,
            contact_level: item.contact_level,
            coach_note: item.coach_note,
            template_item_id: item.item_id,
            assignment_id: issued.assignment.assignment_id,
          };
        }),
      });

      await writePilotAuditEvent(
        {
          event_type: 'create',
          actor_account_id: params.actorAccountId,
          actor_role: params.actorRole,
          organization_id: params.organizationId,
          entity_type: 'workout_template_issue',
          entity_id: template.template_id,
          details: {
            athlete_id: params.athleteId,
            issue_id: issueId,
            template_name: template.name,
            template_version: template.version,
            steps: steps.map((issued) => ({
              step: issued.step,
              item_id: issued.item_id,
              assignment_id: issued.assignment.assignment_id,
              drill_id: issued.assignment.drill_id,
            })),
            adopted_drill_ids: adopted.map((drill) => drill.drill_id),
            updated_drill_ids: updated.map((drill) => drill.drill_id),
            untested_reference_drill_ids: plan.untested.map((drill) => drill.reference_drill_id),
          },
        },
        client,
      );

      return {
        outcome: 'issued' as const,
        issue_id: issueId,
        template: issuedTemplate,
        steps,
        adopted,
        updated,
        untested: plan.untested,
      };
    });
  } catch (error) {
    // The same request arrived twice at the same moment and the other one
    // committed first. This transaction has rolled back -- no assignment and
    // no adoption of its own is kept -- so it is answered as the repeat it is.
    // The other one is met at whichever unique index this transaction reaches
    // first: the request key's, or, when the template adopts a drill, the
    // drill library's (adoption comes before the issue row). So all three are
    // asked here, before the drill library's refusal below can say "nothing
    // was issued" about a workout the other send did issue. A collision that
    // was somebody else's adoption finds no issue under this key and falls
    // through to that refusal, as before.
    const lostARace = error instanceof WorkoutIssueRequestKeyTakenError
      || error instanceof DrillNameTakenError
      || error instanceof ReferenceDrillAlreadyPromotedError;
    if (lostARace && requestKey !== null) {
      const repeat = await repeatOfIssuedRequest(params.organizationId, requestKey, params.athleteId, params.templateId);
      if (repeat) return repeat;
    }
    // A unique index refused an adoption inside the transaction, which has
    // rolled back by the time this is seen: nothing was written. The plan
    // found the name and the reference free a moment ago, so someone adopted
    // or named a drill in between. Which index reports it depends on index
    // order, so neither is described to the coach as a standing name clash;
    // the next attempt plans against what is there now and says exactly why.
    if (error instanceof DrillNameTakenError || error instanceof ReferenceDrillAlreadyPromotedError) {
      throw new ConflictError(
        'The drill library changed while this template was being issued. Nothing was issued; try again.',
        'WORKOUT_TEMPLATE_ISSUE_STATE_CHANGED',
      );
    }
    throw error;
  }
}
