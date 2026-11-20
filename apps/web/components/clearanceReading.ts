/**
 * One athlete's clearance, read the way the Clearance Board reads it.
 *
 * Moved, not copied, from app/coach/sports-medicine/page.tsx (lane AS-5,
 * AS5-2b; Overwatch Q-3 = A on #2030), so that the board and Athlete Safety
 * read a clearance with one set of rules. Read paths only: setting a
 * clearance stays on the Clearance Board.
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

const CLEARANCE_UNREAD: ClearanceReading = { clearance: 'unavailable', effective_at: null, expired_at: null, ends_at: null };

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
