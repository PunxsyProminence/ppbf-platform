'use client';

import React from 'react';

import PrintSheet, { printDate } from './PrintSheet';
import { TRACK_META, type Milestone } from '@/src/shared/achievementPaths';

/**
 * THE MILESTONE CERTIFICATE.
 *
 * A kid takes it home and a parent puts it on the fridge. That is the entire
 * specification and it decides everything else about this file.
 *
 * WHAT IT SAYS: one person, one thing they did, the day it was recorded. It is
 * the paper form of an award already in pilot.athlete_milestones -- this
 * component invents nothing and awards nothing.
 *
 * WHAT IT DOES NOT SAY:
 *   - Nothing health, clearance, injury or disciplinary. See PrintSheet.tsx.
 *   - No rank, no score, no points, no "level", and no comparison to anybody
 *     else. achievementPaths.ts rule 2 holds on paper as hard as on screen, and
 *     a certificate is the single most likely place for a "3rd of 12" to be
 *     added by somebody trying to be encouraging.
 *   - No "not yet earned" anything. A certificate is for a thing that happened.
 *
 * THE FAMILY WORDING IS THE HEADLINE. Every milestone carries two strings: what
 * the athlete sees (`label`) and the same fact told to somebody who was not in
 * the room (`family`). A certificate is read by a parent, an aunt, a
 * grandparent -- people who do not parse "slip and return" -- so `family` is
 * printed large and `label` is printed underneath as the gym's own words for
 * it. Neither is truer than the other; they are just addressed to different
 * readers, and this sheet has both readers.
 */

export interface PrintableCertificateProps {
  readonly athleteName: string;
  readonly milestone: Milestone;
  /** ISO timestamp from pilot.athlete_milestones.awarded_at. */
  readonly awardedAt: string | null;
  /** 'coach' | 'self' | 'parent' as stored. Rendered in words, never as a rank. */
  readonly awardedByRole?: string | null;
  readonly now?: Date;
}

/** Who marked it, said like a person. An unknown role is simply not mentioned. */
export function markedByLine(role: string | null | undefined): string | null {
  const value = (role ?? '').trim().toLowerCase();
  if (value === 'coach') return 'Marked by a coach who watched it happen.';
  if (value === 'self') return 'Logged by the athlete. Their word, and that counts here.';
  if (value === 'parent') return 'Logged at home by a parent.';
  return null;
}

export function awardedOnLabel(awardedAt: string | null): string {
  if (!awardedAt) return 'Date not recorded';
  const parsed = Date.parse(awardedAt);
  if (Number.isNaN(parsed)) return 'Date not recorded';
  return printDate(new Date(parsed));
}

export default function PrintableCertificate({
  athleteName,
  milestone,
  awardedAt,
  awardedByRole,
  now = new Date(),
}: PrintableCertificateProps) {
  const track = TRACK_META[milestone.track];
  const marked = markedByLine(awardedByRole);

  return (
    <PrintSheet
      eyebrow={track.family}
      title="Certificate"
      footNote={`Printed ${printDate(now)}. A record of something that happened. It is not a medical, clearance or eligibility document.`}
    >
      <div className="print-cert">
        <p className="print-cert-lead">This is to record that</p>
        <p className="print-cert-name">{athleteName}</p>

        <p className="print-cert-headline">{milestone.family}</p>
        <p className="print-cert-said">In the gym&apos;s own words: {milestone.label}</p>

        <dl className="print-facts print-cert-facts">
          <dt>Recorded</dt>
          <dd>{awardedOnLabel(awardedAt)}</dd>

          <dt>Part of</dt>
          <dd>
            {track.label} — {track.blurb}
          </dd>
        </dl>

        {marked ? <p className="print-cert-marked">{marked}</p> : null}

        {/* A seal, not a badge. .stamp is the one class the design system's
            print rules let keep its colour, on the argument that a stamp has to
            survive a photocopier -- which is exactly what happens to a
            certificate a grandparent asks for a copy of. */}
        <p className="print-cert-seal">
          <span className="stamp stamp--green stamp--lg">Recorded</span>
        </p>

        <div className="print-cert-signature">
          <span className="print-rule" />
          <p className="print-cert-signature-label">Coach</p>
        </div>
      </div>
    </PrintSheet>
  );
}
