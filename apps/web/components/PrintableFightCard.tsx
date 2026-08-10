'use client';

import React from 'react';

import PrintSheet, { PrintPlate, printDate } from './PrintSheet';
import type { FightCardPayload } from './profileClient';

/**
 * THE FIGHT CARD, ON PAPER.
 *
 * The same object FightCard.tsx renders on screen, set for a sheet somebody
 * takes home. Its rules carry over unchanged and are worth restating because
 * this is the version that ends up on a fridge:
 *
 *   - A fitness member's card is the same object as a competitor's. No record,
 *     no win/loss, no weight class, no ranking -- a card whose fields three
 *     quarters of the gym cannot fill is a form, not a card.
 *   - Nothing on it is a status. No readiness, no clearance, no injury, no
 *     attendance. A card is who somebody is.
 *
 * It reads the payload from /api/pilot/profile/card, which has already run the
 * whole visibility gate: `displayName` is a real name only because the viewer
 * was entitled to it, `ringName` is null unless they were entitled to that too,
 * and the coach line ran the gate a second time from the same viewer's
 * standpoint. Nothing here re-decides any of that, and nothing here can widen
 * it -- there is no second copy of the rule in this file.
 *
 * The photograph is deliberately dropped even when `photoAvailable` is true.
 * See PrintSheet.tsx for the argument.
 */

export interface PrintableFightCardProps {
  readonly card: FightCardPayload;
  readonly now?: Date;
}

export default function PrintableFightCard({ card, now = new Date() }: PrintableFightCardProps) {
  return (
    <PrintSheet
      eyebrow="Member Card"
      title={card.displayName}
      footNote={`Printed ${printDate(now)}. This card records who somebody is. It is not a medical, clearance or eligibility document, and nobody should treat it as one.`}
    >
      <div className="print-card-top">
        <PrintPlate initials={card.initials} name={card.displayName} />
        <div className="print-card-identity">
          {card.ringName ? <p className="print-card-ring">&ldquo;{card.ringName}&rdquo;</p> : null}
          <p className="print-card-programme">{card.programLabel}</p>
          {/* Law 3 -- the words carry it. A photocopier throws the tint away
              and the corner still reads. */}
          <p className="print-card-corner">{card.cornerLabel}</p>
        </div>
      </div>

      <dl className="print-facts">
        <dt>In your corner</dt>
        <dd>{card.coachName ?? 'No coach of record yet'}</dd>

        <dt>At the gym</dt>
        <dd>{card.timeAtGym ?? 'Start date not recorded'}</dd>
      </dl>

      {/* The blank half of the sheet, used the way a gym uses paper: room to
          write on. Ruled lines rather than empty space, because an unexplained
          blank half-page reads as a layout that broke. */}
      <section className="print-notes" aria-label="Space to write">
        <p className="print-notes-label">Notes</p>
        <span className="print-rule" />
        <span className="print-rule" />
        <span className="print-rule" />
        <span className="print-rule" />
      </section>
    </PrintSheet>
  );
}
