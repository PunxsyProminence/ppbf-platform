// Readiness provenance vocabulary and the one predicate that reads it.
//
// PURE ON PURPOSE. This module imports nothing -- in particular not ./db --
// so a client component can import the predicate as a VALUE without pulling
// the Postgres driver into the browser bundle. readinessBoard.ts (server,
// database-bound) and CoachWorkspace.tsx (client) both need the same answer to
// "does this score's method stand up", and two hand-kept copies of that rule
// would drift in the direction that flatters the number.
//
// See docs/capabilities/READINESS_PROVENANCE_FACTS.md for why pilot.readiness
// needed provenance at all.

/**
 * What produced a readiness score. Mirrors the CHECK constraint in
 * pilot_slice_postgres_readiness_provenance_migration.sql.
 */
export type ReadinessMethod = 'UNKNOWN' | 'staff_entered_intake';

/**
 * The value reliability_status and validity_status must hold before a score
 * may be presented as a measurement. Named rather than inlined so the bar
 * cannot be lowered in one call site without it being visible here.
 *
 * Nothing in the platform currently sets it. That is the true state, not an
 * oversight: no readiness method has been established.
 */
export const READINESS_STATUS_ESTABLISHED = 'ESTABLISHED';

export interface ReadinessProvenance {
  method: string;
  reliability_status: string;
  validity_status: string;
}

/**
 * Whether a reading's method has been established well enough for the score to
 * be shown as a measurement rather than as somebody's judgement.
 *
 * Fail-closed by construction: every branch that is not an explicit
 * established/established pair returns false, so an unrecognised status, an
 * empty string, or a method nobody registered all read as unvalidated. A
 * readiness score is used to adjust how a child trains; the failure that costs
 * something is treating an unvalidated number as a measurement, not the
 * reverse.
 *
 * Today NOTHING passes this -- every stored row is either 'UNKNOWN' or
 * staff-entered against the unvalidated defaults -- and that is the correct
 * current answer rather than a bug in this function.
 */
export function isReadinessMethodValidated(entry: ReadinessProvenance): boolean {
  if (!entry.method || entry.method === 'UNKNOWN') return false;
  if (entry.reliability_status !== READINESS_STATUS_ESTABLISHED) return false;
  return entry.validity_status === READINESS_STATUS_ESTABLISHED;
}

/**
 * The sentence a surface shows beside an unvalidated readiness score.
 *
 * Held here, next to the predicate that decides when it is needed, so the
 * caveat and the condition for showing it cannot drift apart.
 */
export const READINESS_UNVALIDATED_CAVEAT =
  'Readiness scores are entered by staff during intake review. No validated '
  + 'formula produces them, and their method is not an established measure -- '
  + 'read them as a colleague\'s judgement, not as a measurement.';
