'use client';

import React, { useEffect, useState } from 'react';

import { apiBase } from '@/lib/apiBase';

/**
 * What a member and their parent see of a USA Boxing medical restriction
 * (lane P22c; Jason's card OW25-06 "A: On file, end date, release needed
 * (Recommended)"): that one is on file, its minimum end date, and whether a
 * physician's release is still needed. Nothing else reaches the browser --
 * the routes send exactly those three fields (familyMedicalRestriction in
 * src/server/pilot/medicalRestrictions.ts).
 *
 * Shown only while the restriction is in force. Lifted, voided, not yet
 * started or none: the routes send null and this renders nothing -- no
 * "cleared" line. A read that fails also renders nothing (Overwatch, P22c
 * step 1; OD-2026-11-10-001 RULES 1, no new warning): the save gate refuses
 * sparring on the server whatever this shows, and TrainingHoldBanner already
 * carries the workspace's one "talk to your coach" line.
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

/** A calendar day as words, read as that day (no time zone shift). */
function dayInWords(isoDay: string): string {
  const at = new Date(`${isoDay}T12:00:00Z`);
  if (Number.isNaN(at.getTime())) return isoDay;
  return at.toLocaleDateString('en-US', { timeZone: 'UTC', month: 'long', day: 'numeric', year: 'numeric' });
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
      <h2 className="t-command" style={{ fontSize: 'var(--t-md)' }}>USA Boxing medical restriction on file</h2>
      <p className="t-body">{medicalRestrictionSentence(restriction)}</p>
    </section>
  );
}

/** The member's own notice: reads /api/pilot/athlete/medical-restriction (self only). */
export default function MedicalRestrictionNotice() {
  const [restriction, setRestriction] = useState<FamilyMedicalRestriction | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    (async () => {
      try {
        const response = await fetch(`${apiBase()}/api/pilot/athlete/medical-restriction`, {
          credentials: 'include',
          signal: controller.signal,
        });
        // Not an athlete (a coach opening the sparring page), or a failed
        // read: nothing to show.
        if (!response.ok) return;
        const payload = (await response.json()) as { ok?: unknown; medical_restriction?: unknown } | null;
        if (payload?.ok === true && isFamilyMedicalRestriction(payload.medical_restriction)) {
          setRestriction(payload.medical_restriction);
        }
      } catch {
        // Unreachable, or unmounted: nothing to show.
      }
    })();
    return () => controller.abort();
  }, []);

  return restriction ? <MedicalRestrictionStatement restriction={restriction} /> : null;
}
