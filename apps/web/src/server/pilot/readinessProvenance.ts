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

/**
 * The SQL predicate every readiness MEASUREMENT CLAIM must sit behind.
 *
 * Exported so the four server surfaces that make such a claim -- the coach
 * RED-day digest, the Avg Readiness trend, the readiness_falling progression
 * rule and intervention evidence -- do not hand-roll it. Until 2026-08-24 none
 * of them consulted provenance at all: `isReadinessMethodValidated` had exactly
 * one production caller in the whole tree, a client component, so a score typed
 * by a staff member at intake became a counted RED day, a trend line, a stored
 * progression gap and formal measurement evidence without anything asking what
 * produced it.
 *
 * It mirrors `isReadinessMethodValidated` term for term, and a test asserts
 * the two agree on the same rows. Two copies of this rule drifting
 * apart would drift in the direction that flatters the number.
 *
 * NOTHING SATISFIES THIS TODAY. Every stored row is 'UNKNOWN' or staff-entered
 * against the unvalidated defaults, so each of these surfaces now reports an
 * honest empty rather than a confident wrong one. That is the correct current
 * answer, not a regression.
 */
/**
 * ALIAS-AWARE ON PURPOSE. Two of the four call sites alias pilot.readiness
 * (`... from pilot.readiness r`) and two do not. Bare column names happen to
 * resolve in both today because neither query joins another table carrying a
 * `method` column -- but the day one does, an unqualified predicate becomes
 * either an ambiguity error or, worse, a filter on the wrong table's column.
 * Passing the alias costs a caller nothing and removes that entirely.
 */
export function readinessValidatedScopeSql(alias = ''): string {
  const q = alias ? `${alias}.` : '';
  return `${q}method <> 'UNKNOWN'`
    + ` and ${q}method is not null`
    + ` and ${q}reliability_status = '${READINESS_STATUS_ESTABLISHED}'`
    + ` and ${q}validity_status = '${READINESS_STATUS_ESTABLISHED}'`;
}

/**
 * The band boundaries a readiness score is read against, when one may be read
 * at all.
 *
 * Held here rather than in readinessBoard so the value contract and the
 * provenance contract sit together: a score outside these bounds is not a
 * reading this platform can interpret, whatever its method says.
 */
export const READINESS_VALUE_MIN = 1;
export const READINESS_VALUE_MAX = 10;

/**
 * Whether a stored score is inside the range the readers assume.
 *
 * THIS IS AN INPUT CONTRACT, NOT VALIDATION OF THE CONSTRUCT. Both writers
 * (intake domain-upsert and review-action) accept any finite number, the column
 * is a bare `numeric not null` with no CHECK, and a test deliberately pins a
 * stored 0 as legitimate -- so 0 reads as RED and 1e9 reads as GREEN today.
 * Bounding that closes a corruption path.
 *
 * It says NOTHING about whether readiness means anything. A number being
 * between 1 and 10 is not evidence that the thing it measures was ever
 * established, and no caller may treat this returning true as a reason to skip
 * `isReadinessMethodValidated`.
 *
 * LEGACY ROWS ARE PRESERVED, NOT REWRITTEN. An out-of-range row stays exactly
 * as stored; it is simply not interpretable, and reads as unknown.
 */
export function isReadinessValueInContract(score: number | null | undefined): boolean {
  return typeof score === 'number'
    && Number.isFinite(score)
    && score >= READINESS_VALUE_MIN
    && score <= READINESS_VALUE_MAX;
}

/**
 * The one question every claim surface should ask: may this row be read as a
 * measurement at all?
 *
 * Both halves must hold -- an established method that stored an impossible
 * number is as uninterpretable as a valid number from a method nobody
 * established.
 */
export function isReadinessUsableAsMeasurement(
  entry: ReadinessProvenance & { score?: number | null },
): boolean {
  return isReadinessMethodValidated(entry) && isReadinessValueInContract(entry.score);
}
