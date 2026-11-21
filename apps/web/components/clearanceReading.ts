/**
 * One athlete's clearance and active Training Hold, read the way the
 * Clearance Board reads them.
 *
 * Moved, not copied, from app/coach/sports-medicine/page.tsx (lane AS-5,
 * AS5-2b; Overwatch Q-3 = A on #2030, Q-B2 and Q-B3 = A on #2041), so that the
 * board and Athlete Safety read a clearance and an active Training Hold with
 * one set of rules. Read paths only: setting a clearance, and placing and
 * lifting a hold, stay on the Clearance Board.
 */

import { apiBase } from '@/lib/apiBase';

export type ClearanceValue = 'cleared' | 'restricted' | 'not_cleared' | 'pending';

/** One athlete's clearance reading. */
export interface ClearanceReading {
  // null = no clearance record on file; 'unavailable' = the read itself failed.
  // This is the route's `effectiveStatus`, the reading the gates act on, never
  // the stored word: a lapsed clearance is still stored as 'cleared'.
  clearance: ClearanceValue | 'cleared_expired' | null | 'unavailable';
  effective_at: string | null;
  // The end date of a lapsed clearance, shown in place of "since".
  expired_at: string | null;
  // The end date of a clearance still in force: when to ask the route again.
  ends_at: string | null;
}

const CLEARANCE_VALUES: ReadonlySet<string> = new Set(['cleared', 'restricted', 'not_cleared', 'pending']);

export function isClearanceRow(
  value: unknown,
  athleteId: string,
): value is { status: ClearanceValue; effective_at: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.status === 'string' && CLEARANCE_VALUES.has(row.status)
    && row.athlete_id === athleteId
    && typeof row.effective_at === 'string' && row.effective_at.trim().length > 0
  );
}

/* The route sends `expires_at` as Postgres text ('2026-09-01 16:00:00+00'),
   which not every browser's Date will read. ISO 8601 all of them do. */
export function isoInstant(value: string): string {
  return value.trim().replace(' ', 'T').replace(/(T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?[+-]\d{2})$/, '$1:00');
}

export const CLEARANCE_UNREAD: ClearanceReading = { clearance: 'unavailable', effective_at: null, expired_at: null, ends_at: null };

/* One athlete's clearance, as the route reports it. Never throws: whatever
   goes wrong is the fail-closed reading, 'unavailable'.

   "cleared" is the most consequential word on a row, so it is printed only
   from a success envelope carrying a status row that is this athlete's:
   `{ ok: true, status }`, status null (no record) or a row with an allowed
   value.

   And the word printed is `effectiveStatus`, taken only when it agrees with
   the row it came with: 'no_record' for no row, the stored value, or
   'cleared_expired' for a stored 'cleared'. A body without it, or one that
   contradicts its own row, is 'unavailable' too. */
export async function readClearance(athleteId: string): Promise<ClearanceReading> {
  try {
    const statusRes = await fetch(
      `${apiBase()}/api/pilot/shadow/medical-status?athleteId=${encodeURIComponent(athleteId)}`,
      { method: 'GET', credentials: 'include' },
    );
    if (!statusRes.ok) return CLEARANCE_UNREAD;
    const payload = (await statusRes.json()) as { ok?: unknown; status?: unknown; effectiveStatus?: unknown } | null;
    if (!payload || payload.ok !== true || !('status' in payload)) return CLEARANCE_UNREAD;
    const effective = payload.effectiveStatus;
    if (payload.status === null) {
      return effective === 'no_record' ? { ...CLEARANCE_UNREAD, clearance: null } : CLEARANCE_UNREAD;
    }
    if (!isClearanceRow(payload.status, athleteId)) return CLEARANCE_UNREAD;
    const stored = payload.status;
    const expiresAt = (stored as { expires_at?: unknown }).expires_at;
    const endDate = typeof expiresAt === 'string' ? isoInstant(expiresAt) : null;
    if (effective === stored.status) {
      return {
        clearance: stored.status,
        effective_at: stored.effective_at,
        expired_at: null,
        ends_at: stored.status === 'cleared' ? endDate : null,
      };
    }
    if (stored.status === 'cleared' && effective === 'cleared_expired') {
      return { clearance: 'cleared_expired', effective_at: null, expired_at: endDate, ends_at: null };
    }
    return CLEARANCE_UNREAD;
  } catch {
    return CLEARANCE_UNREAD;
  }
}

// Moved, not copied, from the Clearance Board with the reads above (Q-B1 = A
// on #2041), so the board and Athlete Safety draw a clearance with one badge.
//
// Room DNA (clinic): --locked (#A81E22) marks a medical or safeguarding FACT;
// red itself is not reserved (OD-2026-09-29-001). `not_cleared` is one: a
// clinician looked at this child and
// said no. `none` is not. It means nobody has typed a clearance record in yet,
// which the board's own copy calls what it is -- a coach or the office
// sets one. Both wore --locked, so a coach scanning the roster could
// not tell "a doctor said no" from "the front desk hasn't got to it", and the
// red that should stop a coach cold stopped meaning anything.
//
// `none` drops one rung to --restricted, where `pending` and `unavailable`
// already sit: still an action state, still fail-closed (nothing here reads as
// cleared), and still Law 3-legible because the LABEL, not the colour, is what
// separates "no record" from "pending" from "unavailable".
export const CLEARANCE_BADGE: Record<string, { className: string; glyph: string; label: string }> = {
  cleared: { className: 'badge badge--cleared', glyph: '✓', label: 'cleared' },
  restricted: { className: 'badge badge--restricted', glyph: '▲', label: 'restricted' },
  not_cleared: { className: 'badge badge--locked', glyph: '✕', label: 'not cleared' },
  pending: { className: 'badge badge--restricted', glyph: '▲', label: 'pending' },
  // Amber, not red: the clearance ran out; no clinician said no
  // (OD-2026-10-01-007 section 4).
  cleared_expired: { className: 'badge badge--restricted', glyph: '▲', label: 'clearance expired' },
  none: { className: 'badge badge--restricted', glyph: '▲', label: 'no record' },
  unavailable: { className: 'badge badge--restricted', glyph: '▲', label: 'unavailable' },
};

export function clearanceBadge(reading: Pick<ClearanceReading, 'clearance'>) {
  if (reading.clearance === 'unavailable') return CLEARANCE_BADGE.unavailable;
  if (reading.clearance === null) return CLEARANCE_BADGE.none;
  return CLEARANCE_BADGE[reading.clearance] ?? CLEARANCE_BADGE.unavailable;
}

/* The clock is looked at again at least this often while waiting. One long
   timer would not do: a timer does not run while a tablet sleeps, so a
   clearance ending during the night would be noticed hours into the morning;
   and setTimeout overflows a little under 25 days out and fires at once. */
const LONGEST_WAIT_MS = 60_000;
const RECHECK_MS = 30_000;

/* Calls `onDue` once `instant` has passed, and again every RECHECK_MS until it
   is cancelled. It decides nothing: `onDue` asks the route again, and the
   caller cancels when the route stops answering 'cleared'. The repeat is for a
   device whose clock runs ahead of the server's, which gets 'cleared' back the
   first time it asks. */
export function whenPassed(instant: string, onDue: () => void): () => void {
  const due = new Date(isoInstant(instant)).getTime();
  if (Number.isNaN(due)) return () => {};
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout>;
  const arm = () => {
    if (cancelled) return;
    const wait = due - Date.now();
    timer = setTimeout(() => {
      if (Date.now() >= due) onDue();
      arm();
    }, wait > 0 ? Math.min(wait, LONGEST_WAIT_MS) : RECHECK_MS);
  };
  arm();
  return () => {
    cancelled = true;
    clearTimeout(timer);
  };
}

// The staff projection of an active hold. Staff read the full row from GET, but
// the Clearance Board shows only the athlete-safe fields (the surface constraint
// at the top of its page) plus hold_id, which its lift action needs and nothing
// renders. Athlete Safety shows the same fields, and has no lift.
export interface ActiveHold {
  hold_id?: string;
  /** Who placed it. A coach may lift only a coach-placed hold
   *  (OD-2026-10-05-024 ruling 1); the route decides, this only hides a
   *  button the route would refuse. */
  placed_by_role?: string;
  scope: string;
  athlete_explanation: string;
  lift_condition_text: string;
}

/* What a page needs from a hold before it will show one. An entry that
   is not this -- null, false, an empty object, a row with no sentence for the
   athlete -- is not a hold and is not "no hold" either: the read did not
   deliver what the route always sends, so the hold is unread. */
export function isActiveHold(value: unknown): value is ActiveHold {
  if (!value || typeof value !== 'object') return false;
  const hold = value as Record<string, unknown>;
  return (
    typeof hold.hold_id === 'string' && hold.hold_id.length > 0
    && typeof hold.scope === 'string' && hold.scope.trim().length > 0
    && typeof hold.athlete_explanation === 'string' && hold.athlete_explanation.trim().length > 0
    && typeof hold.lift_condition_text === 'string'
  );
}

// The one hold read, used by the Clearance Board's initial load AND by its
// refresh after a write, so a placed or lifted hold is displayed by exactly
// the same GET-based logic that displayed it before -- no write response is
// trusted to paint the board on its own. Athlete Safety reads a hold with it
// too. It throws when the hold could not be read: that is never "no hold".
export async function readActiveHold(athleteId: string): Promise<ActiveHold | null> {
  const response = await fetch(
    `${apiBase()}/api/pilot/training-holds?athlete_id=${encodeURIComponent(athleteId)}&status=active`,
    { method: 'GET', credentials: 'include' },
  );
  if (!response.ok) throw new Error('Unable to read this athlete’s holds.');
  const payload = (await response.json()) as { ok?: unknown; holds?: unknown } | null;
  // The route's success is `{ ok: true, holds: [...] }`. A 200 that does not
  // say ok, or does not carry the array, is not a statement that there are
  // no holds -- and an EMPTY array is the only array that is. `[null]`,
  // `[false]` or `[{}]` has an entry, and an entry that is not a hold is an
  // unread hold.
  // And an entry has to be THIS athlete's, and active: the read asked for
  // exactly that, so a row that is someone else's or already lifted means
  // the answer is not the answer to this question. Painting it would put
  // another child's hold sentence on this row.
  const isThisAthletesActiveHold = (entry: unknown): boolean => {
    if (!isActiveHold(entry)) return false;
    const hold = entry as ActiveHold & { status?: unknown; athlete_id?: unknown };
    return hold.athlete_id === athleteId && hold.status === 'active';
  };
  if (
    !payload
    || payload.ok !== true
    || !Array.isArray(payload.holds)
    || !payload.holds.every(isThisAthletesActiveHold)
  ) {
    throw new Error('Unable to read this athlete’s holds.');
  }
  return (payload.holds as ActiveHold[])[0] ?? null;
}
