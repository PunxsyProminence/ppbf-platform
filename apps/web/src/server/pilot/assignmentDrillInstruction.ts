// Assigned work -> the exact drill instruction it was issued against
// (OD-2026-09-19-001, W-D4B).
//
// READ-ONLY. Nothing here writes: opening a drill from an assignment is
// reading, and reading does not complete work, log performance or move
// progression. The only assignment writers stay recordCompletion and
// touchAssignmentProgress, behind POST /api/pilot/progression/completions.
//
// THE CHAIN, WITH NO LOOKUP ALONG THE WAY:
//
//   assignment.drill_id           the exact operational VERSION that was assigned
//     -> pilot.drills row          read by that id, active or not
//     -> reference_drill_id        the exact reference VERSION that row adopted
//     -> pilot.drill_library row   read by that id
//
// Nothing follows a lineage to choose content. An assignment made against v1
// of a gym drill reads v1's pointer even after v2 exists, and that pointer
// names one reference version, not "the newest one". Following either lineage
// to its current head would be the silent version substitution
// OD-2026-09-16-001 clause 5 rules out. adoptDrillChangeProposal copies
// reference_drill_id forward unchanged, so a refined operational drill still
// names the same reference version its predecessor did. (Staff are TOLD where
// the lineage stands -- getOperationalDrillLifecycle -- but that is a status
// line, not a content source.)
//
// THE ATHLETE READ IS THE LEARN READ, EXCEPT FOR OPEN WORK. By default the
// athlete path uses getAthleteDrillDetail -- the promoted-and-live predicate
// and the athlete-safe projection -- because OD-2026-09-17-001 clause 7 applies
// both to every athlete-reachable path to reference content. OD-2026-09-19-002
// carves out one case: work that is still OPEN (assigned or in progress) keeps
// the exact instruction it was issued against after the gym retires the drill,
// because the athlete is still expected to do it, safety and stop rules
// included. That case reads getAthleteDrillDetailForOpenWork, which drops only
// the adoption term: a retracted (inactive) reference is still withheld, and so
// is completed or cancelled work on a retired drill. The assignment itself --
// its snapshot wording, its completions -- is untouched either way (clause 4).
//
// NOTHING ABOUT PROVENANCE REACHES AN ATHLETE. W-D2 removed reference_drill_id
// from every athlete response as internal provenance, and the athlete detail's
// own drill_id IS that reference id, so the athlete projection below drops it.
// For the same reason an athlete is not told WHY there is nothing to open --
// "your gym wrote this drill", "the gym retired it" and "this work predates
// drill links" are facts about how the library was assembled and governed.
// Every one of them reaches the athlete as the same 'unavailable'. Staff get
// the distinction, because it changes what they should do.

import { getDrill } from './drills';
import {
  getAthleteDrillDetail,
  getAthleteDrillDetailForOpenWork,
  getDrillWithDetail,
  type AthleteDrillDetail,
  type DrillWithDetail,
} from './drillLibraryV3';
import { getOperationalDrillLifecycle, type OperationalDrillLifecycle } from './drillVersioning';

/** Who the instruction is shaped for. Decided by the route from the session role, never by the caller. */
export type AssignmentInstructionAudience = 'athlete' | 'coach';

/**
 * Which of an athlete's work on this drill opens its instruction -- a property
 * of the drill in this gym, not of one card, so it holds for every card of a
 * group issuance alike:
 *
 *   all_work        the gym runs the drill: any work opens it (the Learn rule).
 *   open_work_only  the gym retired it: only work still assigned or in
 *                   progress opens it (OD-2026-09-19-002).
 *   none            the reference itself is withdrawn: no work opens it.
 */
export type AthleteInstructionAccess = 'all_work' | 'open_work_only' | 'none';

/** The athlete detail without its drill_id, which is the reference pointer. */
export type AssignmentAthleteDrill = Omit<AthleteDrillDetail, 'drill_id'>;

export type AssignmentDrillInstruction =
  /** The linked reference instruction, athlete-safe. */
  | { state: 'available'; audience: 'athlete'; drill: AssignmentAthleteDrill }
  /**
   * The linked reference instruction in full, for staff, with where the
   * operational drill the work was issued against stands now, and which work
   * an athlete can open this same instruction from -- a coach who is reading
   * it should not send an athlete to read it if they cannot.
   */
  | {
      state: 'available';
      audience: 'coach';
      drill: DrillWithDetail;
      operational_lifecycle: OperationalDrillLifecycle;
      athlete_access: AthleteInstructionAccess;
    }
  /** Staff only: no operational drill is anchored -- a legacy row written before drills had identity (OD-2026-09-18-001 clause 1). */
  | { state: 'no_drill' }
  /** Staff only: the operational drill was written by this gym, so there is no reference instruction to open. */
  | { state: 'gym_written' }
  /**
   * Nothing this audience may open now. For staff: a reference that does not
   * resolve. For an athlete: every reason there is nothing to open, collapsed
   * on purpose (see the header).
   */
  | { state: 'unavailable' };

/**
 * Removes the reference pointer from the athlete detail. The detail is
 * already a constructive projection (drillLibraryV3.ts), so every other key
 * here was put there on purpose; this only takes one away.
 */
export function withoutReferencePointer(detail: AthleteDrillDetail): AssignmentAthleteDrill {
  const { drill_id: referencePointer, ...instruction } = detail;
  void referencePointer;
  return instruction;
}

/**
 * The instruction for one assignment. The caller has already read the
 * assignment inside this organization and checked the actor may see its
 * athlete; this function decides only what instruction, if any, it links to.
 */
export async function resolveAssignmentDrillInstruction(
  organizationId: string,
  assignment: { drill_id: string | null; status: string },
  audience: AssignmentInstructionAudience,
): Promise<AssignmentDrillInstruction> {
  const instruction = await resolveLinkedInstruction(organizationId, assignment, audience);
  if (audience === 'athlete' && instruction.state !== 'available') {
    return { state: 'unavailable' };
  }
  return instruction;
}

async function resolveLinkedInstruction(
  organizationId: string,
  assignment: { drill_id: string | null; status: string },
  audience: AssignmentInstructionAudience,
): Promise<AssignmentDrillInstruction> {
  if (!assignment.drill_id) {
    return { state: 'no_drill' };
  }

  // By id, with no active filter: the assignment names the version it was
  // issued against, and a retired version is still that version.
  const operational = await getDrill(organizationId, assignment.drill_id);
  if (!operational) {
    // The foreign key is ON DELETE RESTRICT, so this is not expected; if it
    // happens there is still nothing to open, and saying so beats a 500.
    return { state: 'no_drill' };
  }
  if (!operational.reference_drill_id) {
    return { state: 'gym_written' };
  }

  if (audience === 'athlete') {
    const detail = await readAthleteInstruction(organizationId, operational.reference_drill_id, assignment.status);
    return detail
      ? { state: 'available', audience: 'athlete', drill: withoutReferencePointer(detail) }
      : { state: 'unavailable' };
  }

  // The coach read has no active filter by design: reviewing a retracted drill
  // is a legitimate coaching act, and the view says it is retracted.
  //
  // Which work an athlete can open it from is answered by running the two
  // reads the athlete path chooses between -- not by re-deriving either
  // predicate here -- so the coach's answer and the athlete's can never
  // disagree: if either rule changes, this answer changes with it.
  const [detail, lifecycle, learnDetail, openWorkDetail] = await Promise.all([
    getDrillWithDetail(organizationId, operational.reference_drill_id),
    getOperationalDrillLifecycle(organizationId, operational.drill_id),
    getAthleteDrillDetail(organizationId, operational.reference_drill_id),
    getAthleteDrillDetailForOpenWork(organizationId, operational.reference_drill_id),
  ]);
  if (!detail) {
    return { state: 'unavailable' };
  }
  return {
    state: 'available',
    audience: 'coach',
    drill: detail,
    // The row was just read, so a null here would mean it vanished between two
    // reads; its own active flag is then the most that can honestly be said.
    operational_lifecycle: lifecycle ?? (operational.active ? 'current' : 'retired'),
    athlete_access: learnDetail ? 'all_work' : openWorkDetail ? 'open_work_only' : 'none',
  };
}

/**
 * Work the athlete is still expected to do (OD-2026-09-19-002: "assigned / in
 * progress"). Completed, cancelled and incomplete work is not open.
 */
export function isOpenWork(status: string): boolean {
  return status === 'assigned' || status === 'in_progress';
}

/**
 * What the athlete may read for this work: the open-work read while the work
 * is open, the Learn read otherwise. The coach's athlete_access runs the same
 * two reads.
 */
function readAthleteInstruction(organizationId: string, referenceDrillId: string, status: string) {
  return isOpenWork(status)
    ? getAthleteDrillDetailForOpenWork(organizationId, referenceDrillId)
    : getAthleteDrillDetail(organizationId, referenceDrillId);
}
