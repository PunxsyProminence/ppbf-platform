import { adoptionReadiness } from '../../lib/drillAdoptionReadiness';
import { NOT_FLOOR_TESTED_READINESS_MESSAGE } from '../../lib/drillFloorValidation';
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
import { ConflictError } from './errors';
import { assertNewAssignmentMeetsCueRule, type DrillAssignment } from './progression';

// pilot.workout_templates and pilot.workout_template_items are owned by
// infra/azure/pilot_slice_postgres_workout_templates_v2_migration.sql,
// applied through the apply-migrations workflow like every other table.
// Nothing here issues DDL. The TEMPLATES are read-only, matching
// drillLibraryV3.ts's own design -- a change-proposal review lifecycle for
// templates is a reasonable future consolidation with drillVersioning.ts, not
// attempted here. The one write in this module is issueWorkoutTemplate, at the
// foot: it writes assignments and adopted drills, never a template row.
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
// ISSUING A TEMPLATE TO ONE ATHLETE -- OD-2026-10-07-012 ruling 2 and
// OD-2026-10-08-002 item 2.
//
// Every step becomes one gap-free assignment (a Coach Card: issueCoachCard,
// the same writer the cards route uses), all in ONE transaction, so a template
// is issued whole or not at all.
//
// A step names a REFERENCE drill (pilot.drill_library), and only an
// operational drill (pilot.drills) may be assigned (OD-2026-09-18-001). So:
//   - the gym already runs the drill          -> its operational drill is assigned.
//   - the gym has not adopted it, it is ready -> it is adopted in the same
//     transaction (promoteReferenceDrill, audited as a promotion is), then
//     assigned. "Ready" is adoptionReadiness, the check the promote route
//     enforces, so a floor-tested draft is ready and an untested one is not.
//   - anything else                           -> the WHOLE issue is refused and
//     every such drill is named with its reason. Nothing is written.
//
// WHAT IS NOT CARRIED. pilot.drill_assignments has no column for a step's
// block, its place in the order, its scale level, its contact level or its
// coach note, so none of those reach the athlete: each step arrives as a
// separate assignment carrying the drill, its rep count and its minutes. The
// link back to the template lives in the audit event only. The caller says so
// (TEMPLATE_STEP_FIELDS_NOT_CARRIED) rather than letting a reader assume the
// session's structure travelled with it.
//
// AUTHORIZATION IS THE ROUTE'S. Like issueCoachCard, this trusts its caller to
// have passed the role gate and assertActorCanAccessAthlete; organizationId is
// the session's and scopes every read and write below.
// ---------------------------------------------------------------------------

/** The template step columns an issued assignment has nowhere to store. */
export const TEMPLATE_STEP_FIELDS_NOT_CARRIED = ['block', 'ordinal', 'scale_level', 'contact_level', 'coach_note'] as const;

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
  /** True for a draft no coach of this gym has floor-tested (OD-2026-10-08-002 item 2). */
  untested_draft: boolean;
  reason: string;
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

export type TemplateIssueResult =
  | { outcome: 'not_found' }
  | { outcome: 'refused'; message: string; drills: TemplateIssueRefusedDrill[] }
  | {
      outcome: 'issued';
      template: { template_id: string; name: string; version: number };
      steps: TemplateIssuedStep[];
      adopted: TemplateAdoptedDrill[];
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
const OTHER_VERSION_REASON =
  'This gym already has another version of this drill, and this template names a different one.';
const UNREADABLE_DRILL_REASON = 'This drill could not be read from the library.';

function refusalMessage(drills: TemplateIssueRefusedDrill[]): string {
  const names = (list: TemplateIssueRefusedDrill[]) => list.map((drill) => drill.name).join(', ');
  const drafts = drills.filter((drill) => drill.untested_draft);
  const others = drills.filter((drill) => !drill.untested_draft);
  const parts = ['Nothing was issued.'];
  if (drafts.length > 0) {
    parts.push(`Not floor-tested by a coach of this gym yet: ${names(drafts)}.`);
  }
  if (others.length > 0) {
    parts.push(`Cannot be assigned as they stand: ${names(others)}.`);
  }
  return parts.join(' ');
}

interface TemplateIssuePlan {
  refused: TemplateIssueRefusedDrill[];
  /** reference drill id -> the gym's active operational drill id. */
  operational: Map<string, string>;
  /** Reference drills to adopt in the transaction, in drill-id order. */
  adoptions: AdoptableReference[];
}

/** A reference drill whose difficulty is already known to be in the operational vocabulary. */
type AdoptableReference = DrillWithDetail & { difficulty: DrillDifficulty };

/**
 * The read-only pass: what each step's drill is to this gym right now. Writes
 * nothing, and takes no lock, so its answer can be stale by the time the
 * transaction runs. The transaction re-decides exactly two things: the unique
 * indexes on pilot.drills (a name or a reference taken in the meantime) and
 * issueCoachCard's insert-from-an-active-drill (a drill retired in the
 * meantime). Both end in a rollback and a conflict, never a partial write.
 * NOT re-decided: a reference withdrawn or superseded, another version of a
 * drill adopted, or the template replaced, between this pass and the write --
 * the same windows the promote route has between its checks and its insert.
 */
async function planTemplateIssue(
  organizationId: string,
  items: WorkoutTemplateItemWithDrillHead[],
): Promise<TemplateIssuePlan> {
  const plan: TemplateIssuePlan = { refused: [], operational: new Map(), adoptions: [] };

  for (const item of items) {
    if (item.drill_id === null) {
      plan.refused.push({
        steps: [item.ordinal],
        drill_id: null,
        name: (item.free_text_drill ?? '').trim() || `Step ${item.ordinal}`,
        untested_draft: false,
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
  const floorTested = await listFloorValidations(organizationId, referenceIds);
  const refuseDrill = (referenceId: string, name: string, reason: string, untestedDraft = false) => {
    plan.refused.push({
      steps: stepsByReference.get(referenceId) ?? [],
      drill_id: referenceId,
      name,
      untested_draft: untestedDraft,
      reason,
    });
  };
  const candidates: AdoptableReference[] = [];

  for (const referenceId of referenceIds) {
    const reference = await getDrillWithDetail(organizationId, referenceId);
    const lifecycle = lifecycles[referenceId];
    const refuse = (reason: string, untestedDraft = false) =>
      refuseDrill(referenceId, reference?.name ?? referenceId, reason, untestedDraft);

    if (!reference || !lifecycle) {
      refuse(UNREADABLE_DRILL_REASON);
      continue;
    }

    // The gym runs this drill: no adoption, and the reference's own state no
    // longer decides anything (an adopted drill outlives a withdrawn
    // reference). The cue rule on a NEW assignment still applies, and is
    // asked here so a drill that breaks it is named with the others rather
    // than surfacing alone from inside the transaction.
    if (lifecycle.state === 'operational' && lifecycle.operational_drill_id) {
      try {
        await assertNewAssignmentMeetsCueRule(organizationId, lifecycle.operational_drill_id);
      } catch (error) {
        if (error instanceof ConflictError) {
          refuse(error.message);
          continue;
        }
        throw error;
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

    // Not adopted. The same readiness check, on the same inputs, the promote
    // route enforces -- so issuing a template can adopt nothing a coach could
    // not adopt by hand. An untested draft is the case the owner ruled on by
    // name; it is flagged so the caller can say so first -- but only when the
    // floor test is the ONE thing missing, so a coach is never told a floor
    // test will clear a drill that something else still holds back.
    const tested = Boolean(floorTested[referenceId]);
    const readiness = adoptionReadiness({ ...reference, floor_tested_by_this_gym: tested });
    if (!readiness.ready) {
      refuse(
        readiness.missing.join(' '),
        readiness.missing.length === 1 && readiness.missing[0] === NOT_FLOOR_TESTED_READINESS_MESSAGE,
      );
      continue;
    }

    // A different version of a drill this gym already has (running or
    // retired). The promote route refuses it until the coach-reviewed update
    // step exists; the template is not quietly pointed at the gym's version.
    if (await getOtherVersionAdoption(organizationId, referenceId)) {
      refuse(OTHER_VERSION_REASON);
      continue;
    }

    // The promote route checks the same vocabulary before it writes: a
    // reference row holding another value is not coerced.
    const difficulty = reference.difficulty;
    if (!isDrillDifficulty(difficulty)) {
      refuse('Its difficulty is not one this gym can assign.');
      continue;
    }

    candidates.push({ ...reference, difficulty });
  }

  // NAMES, for every drill about to be adopted, in one read. A gym holds one
  // ACTIVE drill per name (pilot_drills_one_name_per_org), and an adopted
  // drill takes the reference's name. Asked here rather than left to the index
  // so EVERY clash is named in one answer; the index stops a transaction at
  // the first. The library allows one name per discipline, so two drills of
  // one template can share a name the gym can hold only once.
  const taken = candidates.length === 0
    ? new Set<string>()
    : new Set(
        (await query<{ name: string }>(
          `select d.name from pilot.drills d
           where d.organization_id = $1 and d.active and d.name = any($2::text[])`,
          [organizationId, candidates.map((reference) => reference.name)],
        )).map((row) => row.name),
      );
  for (const reference of candidates) {
    if (taken.has(reference.name)) {
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
 * Issues one saved workout template to one athlete: every step an assignment,
 * every unadopted-but-ready reference drill adopted, in one transaction.
 *
 * Returns 'not_found' for a template id that names nothing in this gym,
 * 'refused' (nothing written) when any step cannot be assigned, and 'issued'
 * with what was created otherwise. Throws ConflictError for a template that is
 * withdrawn or has no steps, and for a write that lost a race.
 */
export async function issueWorkoutTemplate(params: {
  organizationId: string;
  templateId: string;
  athleteId: string;
  actorAccountId: string;
  actorRole: PilotRole;
}): Promise<TemplateIssueResult> {
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

      for (const reference of plan.adoptions) {
        // The promote route's mapping, and the whole of it: focus <- purpose,
        // the first twelve non-blank cues in the reference's own order.
        const drill = await promoteReferenceDrill(
          {
            organizationId: params.organizationId,
            referenceDrillId: reference.drill_id,
            name: reference.name,
            category: reference.category,
            focus: reference.purpose.trim(),
            difficulty: reference.difficulty,
            cues: reference.cues
              .map((cue) => cue.cue_text.trim())
              .filter((cue) => cue.length > 0)
              .slice(0, MAX_ADOPTED_CUES),
          },
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

      // The only durable link between these assignments and the template.
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
            template_name: template.name,
            template_version: template.version,
            steps: steps.map((issued) => ({
              step: issued.step,
              item_id: issued.item_id,
              assignment_id: issued.assignment.assignment_id,
              drill_id: issued.assignment.drill_id,
            })),
            adopted_drill_ids: adopted.map((drill) => drill.drill_id),
            not_carried: [...TEMPLATE_STEP_FIELDS_NOT_CARRIED],
          },
        },
        client,
      );

      return {
        outcome: 'issued' as const,
        template: { template_id: template.template_id, name: template.name, version: template.version },
        steps,
        adopted,
      };
    });
  } catch (error) {
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
