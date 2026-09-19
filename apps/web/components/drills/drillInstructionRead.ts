// The two GET reads that open a drill's instruction from somewhere other than
// the drill library itself (W-D4B). Both are reads and nothing else: opening a
// drill never writes, and neither function sends any other verb.
//
// Type-only imports from the server, as in drillDetailView.ts: nothing
// server-side reaches the client bundle.

import { apiBase } from '@/lib/apiBase';
import type { AssignmentDrillInstruction, AthleteInstructionAccess } from '@/src/server/pilot/assignmentDrillInstruction';
import type { DrillWithDetail } from '@/src/server/pilot/drillLibraryV3';
import type { OperationalDrillLifecycle } from '@/src/server/pilot/drillVersioning';
import { fromAthleteDrillDetail, fromCoachDrillDetail, type DrillDetailView } from './drillDetailView';

/** The body GET /api/pilot/progression/drill-instruction answers with. */
export type AssignmentInstructionResponse = { assignment_id: string; assigned_by: string } & AssignmentDrillInstruction;

/** What an opener shows, whichever read produced it. */
export interface OpenedInstruction {
  state: 'available' | 'no_drill' | 'gym_written' | 'unavailable';
  view: DrillDetailView | null;
  /** The assigning coach's display name. Only an assignment read knows it. */
  assignedBy: string | null;
  /**
   * Staff reads of an assignment only: where the operational drill the work
   * was issued against stands now -- still run, changed into another version,
   * or retired.
   */
  operationalLifecycle: OperationalDrillLifecycle | null;
  /**
   * Staff reads of an assignment only: which of an athlete's work on this drill
   * opens this same instruction. Null where the read does not say.
   */
  athleteAccess: AthleteInstructionAccess | null;
}

/** A read that did not answer. The message is for the log; the page decides what a person reads. */
export class InstructionReadError extends Error {}

/**
 * The instruction linked to one piece of assigned work. The server picks the
 * shape from the session: an athlete receives the athlete-safe projection,
 * without the reference pointer, so the view is keyed by the assignment.
 */
export async function readAssignmentInstruction(assignmentId: string, signal: AbortSignal): Promise<OpenedInstruction> {
  const response = await fetch(
    `${apiBase()}/api/pilot/progression/drill-instruction?assignment_id=${encodeURIComponent(assignmentId)}`,
    { method: 'GET', credentials: 'include', signal },
  );
  if (!response.ok) {
    throw new InstructionReadError(`drill-instruction read answered ${response.status}`);
  }
  const payload = (await response.json()) as AssignmentInstructionResponse;

  if (payload.state !== 'available') {
    return { state: payload.state, view: null, assignedBy: payload.assigned_by ?? null, operationalLifecycle: null, athleteAccess: null };
  }
  if (payload.audience === 'athlete') {
    return {
      state: 'available',
      view: fromAthleteDrillDetail({ ...payload.drill, drill_id: `assignment-${payload.assignment_id}` }),
      assignedBy: payload.assigned_by ?? null,
      operationalLifecycle: null,
      athleteAccess: null,
    };
  }
  return {
    state: 'available',
    view: fromCoachDrillDetail(payload.drill),
    assignedBy: payload.assigned_by ?? null,
    operationalLifecycle: payload.operational_lifecycle,
    athleteAccess: payload.athlete_access,
  };
}

/**
 * One reference drill by the pointer an operational drill carries -- the read
 * /coach/drills already makes. Staff only: the athlete branch of this route is
 * never reached from a coach surface.
 */
export async function readReferenceInstruction(referenceDrillId: string, signal: AbortSignal): Promise<OpenedInstruction> {
  const response = await fetch(
    `${apiBase()}/api/pilot/drill-library?drill_id=${encodeURIComponent(referenceDrillId)}`,
    { method: 'GET', credentials: 'include', signal },
  );
  if (response.status === 404) {
    return { state: 'unavailable', view: null, assignedBy: null, operationalLifecycle: null, athleteAccess: null };
  }
  if (!response.ok) {
    throw new InstructionReadError(`drill-library read answered ${response.status}`);
  }
  const payload = (await response.json()) as { drill?: DrillWithDetail };
  if (!payload.drill) {
    throw new InstructionReadError('drill-library read carried no drill');
  }
  return { state: 'available', view: fromCoachDrillDetail(payload.drill), assignedBy: null, operationalLifecycle: null, athleteAccess: null };
}
