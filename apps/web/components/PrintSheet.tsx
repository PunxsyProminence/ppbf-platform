'use client';

import React, { type ReactNode } from 'react';
import { formatGymDate } from '@/src/lib/gymTime';

/**
 * ONE SHEET OF US LETTER.
 *
 * Boxing gyms are covered in paper: bout sheets, weigh-in slips, certificates
 * taped inside locker doors, a card on a fridge under a magnet. This is the
 * platform's contribution to that pile.
 *
 * ---------------------------------------------------------------------------
 * WHAT MAY NEVER BE ON A PRINTED ARTIFACT
 * ---------------------------------------------------------------------------
 *
 * No health, medical, clearance, readiness, injury, or disciplinary fact. Not
 * softened, not abbreviated, not "cleared to train" -- none of it.
 *
 * The reason is stronger than the on-screen one. A screen has a session behind
 * it: revoke the release, change the coach, and the next render is different.
 * Paper leaves the building and never comes back. It gets photographed, put in
 * a folder, handed to somebody at a tournament, and it says whatever it said on
 * the day it printed, forever. printArtifacts.test.tsx scans the rendered
 * output of both artifacts for that vocabulary, because the failure mode is an
 * addition in six months rather than a decision today.
 *
 * NO PHOTOGRAPH, EITHER. Three reasons, in order:
 *   1. A printed face is a copy of a child's photograph with no session behind
 *      it and no way to take it back. profileVisibility.ts's whole design is
 *      that a portrait is served to a viewer, not handed out as an artifact.
 *   2. The design system's own print rules flatten every gradient and material
 *      to white because printers render them as grey mud; a photograph on a
 *      home inkjet is the same problem with somebody's face in it.
 *   3. The brass nameplate is not a fallback here. ProfilePortrait already
 *      argues that the plate is the primary object, and struck initials are
 *      exactly the right thing on a printed card.
 *
 * ---------------------------------------------------------------------------
 * GEOMETRY
 * ---------------------------------------------------------------------------
 *
 * @page in globals.css sets `size: letter portrait` with a 1in margin, so the
 * printable area is 6.5in x 9in. .print-sheet is that size exactly and carries
 * `break-after: page`, so N artifacts produce N pages with nothing spilling
 * onto an orphan page. The sizes are in INCHES rather than in the pixel ladder,
 * on purpose: this box is a physical object and its dimensions are the paper's,
 * not the screen's.
 */

export interface PrintSheetProps {
  /** Small caps line at the top of the sheet, above the rule. */
  readonly eyebrow: string;
  /** What this piece of paper is. Printed large, in wood type. */
  readonly title: string;
  /** Printed at the foot, under the rule. Where it came from and when. */
  readonly footNote: string;
  readonly children: ReactNode;
  readonly className?: string;
}

export const GYM_NAME = 'Punxsy Prominence Boxing & Fitness';
export const GYM_ADDRESS = '204 Pennsylvania Ave, Big Run, PA 15715';

export default function PrintSheet({ eyebrow, title, footNote, children, className = '' }: PrintSheetProps) {
  return (
    <article className={`print-sheet ${className}`.trim()}>
      <header className="print-sheet-head">
        <p className="print-sheet-eyebrow">{eyebrow}</p>
        <p className="print-sheet-gym">{GYM_NAME}</p>
        <h2 className="print-sheet-title">{title}</h2>
      </header>

      <div className="print-sheet-body">{children}</div>

      <footer className="print-sheet-foot">
        <p className="print-sheet-address">{GYM_ADDRESS}</p>
        <p className="print-sheet-note">{footNote}</p>
      </footer>
    </article>
  );
}

/**
 * The struck-brass plate, printed.
 *
 * Not ProfilePortrait: that component renders its initials inside an
 * aria-hidden span, and the design system's print block hides every
 * aria-hidden element that is not a stamp -- so the plate would print blank.
 * On paper the initials ARE the content, so they are announced.
 */
export function PrintPlate({ initials, name }: { readonly initials: string; readonly name: string }) {
  return (
    <span className="print-plate" role="img" aria-label={name}>
      {initials}
    </span>
  );
}

/** Today, written the way a person writes a date on a form. */
export function printDate(value: Date = new Date()): string {
  try {
    return formatGymDate(value) ?? '';
  } catch {
    return value.toISOString().slice(0, 10);
  }
}
