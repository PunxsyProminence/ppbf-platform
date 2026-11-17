'use client';

import React, { useEffect, useState } from 'react';

import { apiBase } from '@/lib/apiBase';
import { formatGymDay } from '@/src/lib/gymTime';

/**
 * What a member and their parent see of a USA Boxing medical restriction
 * (lane P22c; Jason's card OW25-06 "A: On file, end date, release needed
 * (Recommended)"): that one is on file, its minimum end date, and whether a
 * physician's release is still needed. Nothing else reaches the browser --
 * the routes send exactly those three fields (familyMedicalRestriction in
 * src/server/pilot/medicalRestrictions.ts).
 *
 * Shown while the restriction is in force, with the Restricted mark: the
 * restricted rung, ▲ and the word, never the medical-stop (locked) mark
 * (OD-2026-11-17-009 ruling 5, Jason's card OW25-38 A). Lifted, voided, not
 * yet started or none: the routes send null and this renders nothing -- no
 * "cleared" line.
 *
 * A READ THAT FAILS IS NOT "NONE" (OD-2026-11-17-009 ruling 3, Jason's card
 * OW25-35 A, the owner's direction RULES s1 allows). It shows one neutral line,
 * the card's words with a closing period (Overwatch, DFX step 1, Q1): no
 * warning colour, no glyph, nothing blocked. The save gate refuses sparring
 * on the server whatever this shows. A value that is not null and not the
 * three fields is treated as not read, the same line.
 */

export interface FamilyMedicalRestriction {
  on_file: true;
  minimum_end_date: string;
  release_needed: boolean;
}

/** The three fields and nothing malformed; anything else is treated as not read. */
export function isFamilyMedicalRestriction(value: unknown): value is FamilyMedicalRestriction {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return row.on_file === true
    && typeof row.minimum_end_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(row.minimum_end_date)
    && typeof row.release_needed === 'boolean';
}

/** OD-2026-11-17-009 ruling 3 (OW25-35 A), word for word, plus the closing period Overwatch approved. */
export const MEDICAL_RESTRICTION_UNREAD_LINE = 'Medical restriction: could not be checked just now; your coach can see it.';

/** The glyph of the restricted rung (as the Clearance Board's "restricted"); never ✕, the medical-stop mark. */
export const RESTRICTED_GLYPH = '▲';

/** The Restricted mark (OD-2026-11-17-009 ruling 5, OW25-38 A): glyph and word, on the restricted rung. */
export function RestrictedMark() {
  return (
    <span className="badge badge--restricted" data-testid="restricted-mark">
      <i aria-hidden="true">{RESTRICTED_GLYPH}</i>Restricted
    </span>
  );
}

/** What one read of the family view comes to: in force, none in force, or not read. */
export type FamilyRestrictionRead =
  | { readonly kind: 'in_force'; readonly restriction: FamilyMedicalRestriction }
  | { readonly kind: 'none' }
  | { readonly kind: 'unread' };

/**
 * null is the server's "none in force". Anything else that is not the three
 * fields -- a failed read, a missing field, a malformed value -- was not read,
 * and must never look like none.
 */
export function familyRestrictionRead(value: unknown, readFailed: boolean): FamilyRestrictionRead {
  if (readFailed) return { kind: 'unread' };
  if (value === null) return { kind: 'none' };
  if (isFamilyMedicalRestriction(value)) return { kind: 'in_force', restriction: value };
  return { kind: 'unread' };
}

/** A calendar day as words, through the gym's date helper (a date-only value is never shifted by the viewer's zone). */
function dayInWords(isoDay: string): string {
  return formatGymDay(isoDay) ?? isoDay;
}

export function medicalRestrictionSentence(restriction: FamilyMedicalRestriction): string {
  const until = restriction.release_needed
    ? `${dayInWords(restriction.minimum_end_date)} has passed and a physician’s release is on file`
    : `${dayInWords(restriction.minimum_end_date)} has passed`;
  return `No sparring until ${until}. Training below sparring is fine.`;
}

/** The statement itself, for a page that already holds the value (the guardian's Safety page). */
export function MedicalRestrictionStatement({ restriction }: { readonly restriction: unknown }) {
  if (!isFamilyMedicalRestriction(restriction)) return null;
  return (
    <section data-testid="medical-restriction-notice" className="space-y-[var(--s2)]">
      <div className="flex flex-wrap items-center gap-[var(--s2)]">
        <RestrictedMark />
        <h2 className="t-command" style={{ fontSize: 'var(--t-md)' }}>USA Boxing medical restriction on file</h2>
      </div>
      <p className="t-body">{medicalRestrictionSentence(restriction)}</p>
    </section>
  );
}

/** The neutral line for a read that failed: plain body text, no colour, no glyph, no block. */
export function MedicalRestrictionUnread() {
  return <p className="t-body" role="status" data-testid="medical-restriction-unread">{MEDICAL_RESTRICTION_UNREAD_LINE}</p>;
}

/** One read's view: the statement, the neutral line, or nothing for none in force. */
export function MedicalRestrictionFromRead({ read }: { readonly read: FamilyRestrictionRead }) {
  if (read.kind === 'in_force') return <MedicalRestrictionStatement restriction={read.restriction} />;
  if (read.kind === 'unread') return <MedicalRestrictionUnread />;
  return null;
}

/** The member's own notice: reads /api/pilot/athlete/medical-restriction (self only). */
export default function MedicalRestrictionNotice() {
  // null while reading: nothing is shown until the read has an answer.
  const [read, setRead] = useState<FamilyRestrictionRead | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    (async () => {
      try {
        const response = await fetch(`${apiBase()}/api/pilot/athlete/medical-restriction`, {
          credentials: 'include',
          signal: controller.signal,
        });
        // Not this member's own view: signed out (401), not an athlete (403),
        // or no live record (404). The mounts are athlete-only, so these are
        // edge cases; there is no member's restriction to report.
        if (response.status === 401 || response.status === 403 || response.status === 404) return;
        if (!response.ok) {
          setRead({ kind: 'unread' });
          return;
        }
        const payload = (await response.json()) as { ok?: unknown; medical_restriction?: unknown } | null;
        if (controller.signal.aborted) return;
        const answered = payload?.ok === true && Object.prototype.hasOwnProperty.call(payload, 'medical_restriction');
        setRead(familyRestrictionRead(answered ? payload.medical_restriction : undefined, !answered));
      } catch {
        // Unmounted: nothing to update. Unreachable, or not JSON: not read.
        if (!controller.signal.aborted) setRead({ kind: 'unread' });
      }
    })();
    return () => controller.abort();
  }, []);

  return read ? <MedicalRestrictionFromRead read={read} /> : null;
}
