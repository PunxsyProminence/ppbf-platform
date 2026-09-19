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
// THE ATHLETE READ IS THE LEARN READ. getAthleteDrillDetail applies the
// promoted-and-live predicate and the athlete-safe projection; OD-2026-09-17-001
// clause 7 says every athlete-reachable path to reference content applies both,
// so this path reuses that function rather than growing a second one. The
// consequence is deliberate: a drill whose promotion this gym has since retired
// (and not refined into an active successor), or whose reference was withdrawn,
// is unavailable to the athlete here exactly as it is in Learn. The assignment
// itself -- its snapshot wording, its completions -- is untouched and still
// readable (clause 4); only the library instruction is withheld.
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
  getDrillWithDetail,
  type AthleteDrillDetail,
  type DrillWithDetail,
} from './drillLibraryV3';
import { getOperationalDrillLifecycle, type OperationalDrillLifecycle } from './drillVersioning';

/** Who the instruction is shaped for. Decided by the route from the session role, never by the caller. */
export type AssignmentInstructionAudience = 'athlete' | 'coach';

/** The athlete detail without its drill_id, which is the reference pointer. */
export type AssignmentAthleteDrill = Omit<AthleteDrillDetail, 'drill_id'>;

export type AssignmentDrillInstruction =
  /** The linked reference instruction, athlete-safe. */
  | { state: 'available'; audience: 'athlete'; drill: AssignmentAthleteDrill }
  /**
   * The linked reference instruction in full, for staff, with where the
   * operational drill the work was issued against stands now, and whether the
   * athlete can open this same instruction from the work -- a coach who is
   * reading it should not tell an athlete to go and read it if they cannot.
   */
  | {
      state: 'available';
      audience: 'coach';
      drill: DrillWithDetail;
      operational_lifecycle: OperationalDrillLifecycle;
      athlete_can_open: boolean;
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
  assignment: { drill_id: string | null },
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
  assignment: { drill_id: string | null },
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
    const detail = await getAthleteDrillDetail(organizationId, operational.reference_drill_id);
    return detail
      ? { state: 'available', audience: 'athlete', drill: withoutReferencePointer(detail) }
      : { state: 'unavailable' };
  }

  // The coach read has no active filter by design: reviewing a retracted drill
  // is a legitimate coaching act, and the view says it is retracted.
  //
  // Whether the athlete can open it is answered by running the athlete's own
  // read, not by re-deriving the predicate here, so the two can never
  // disagree: if the promoted-and-live rule changes, this answer changes with it.
  const [detail, lifecycle, athleteDetail] = await Promise.all([
    getDrillWithDetail(organizationId, operational.reference_drill_id),
    getOperationalDrillLifecycle(organizationId, operational.drill_id),
    getAthleteDrillDetail(organizationId, operational.reference_drill_id),
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
    athlete_can_open: athleteDetail !== null,
  };
}
