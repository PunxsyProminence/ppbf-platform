'use client';

import Link from 'next/link';
import React from 'react';
import ProfilePortrait from './ProfilePortrait';
import type { FightCardPayload } from './profileClient';

/**
 * THE FIGHT CARD — a member's bio, printed the way a bout is announced.
 *
 * The generic profile row this replaces read like a database table with a
 * stylesheet on it: name, status, coach id, joined date. A card is an object.
 * Name in wood type, ring name under it in the member's own handwriting, the
 * corner said out loud, and the facts set as a ledger.
 *
 * A FITNESS MEMBER'S CARD IS THE SAME OBJECT AS A COMPETITOR'S.
 *
 * That is the rule this component is built around. The gym runs fitness-only,
 * adult recreational, youth mentorship and competitive tracks. Design the card
 * around the competitive case and everyone else gets a stub with blanks in it,
 * which tells three quarters of the membership the platform thinks they are an
 * incomplete boxer. So: no record, no win/loss, no weight class, no ranking --
 * every one of those is real for a fraction of the members and absent for the
 * rest, and a card whose fields half the gym cannot fill is a form, not a card.
 * The programme line is set in the display voice at the same size whichever
 * programme it names.
 *
 * NOTHING ON THIS CARD IS A STATUS. No readiness, no clearance, no injury, no
 * attendance. A card is who somebody is; the safety ladder is a claim about
 * their body, and the two must not share a surface (Law 2).
 */

export interface FightCardProps {
  readonly card: FightCardPayload;
  /** Renders the settings link. Only ever true on the member's own surface. */
  readonly own?: boolean;
  readonly className?: string;
}

const FACT_LABEL = 'text-[length:var(--t-xs)]';

export default function FightCard({ card, own = false, className = '' }: FightCardProps) {
  return (
    <article
      className={`fightcard corner-scope ${className}`}
      data-corner={card.corner}
      aria-label={`Fight card for ${card.displayName}`}
    >
      <div className="flex flex-wrap items-start gap-[var(--s5)]">
        <ProfilePortrait
          accountId={card.accountId}
          initials={card.initials}
          name={card.displayName}
          photoAvailable={card.photoAvailable}
          corner={card.corner}
          size="lg"
        />

        <div className="min-w-[233px] flex-1 space-y-[var(--s3)]">
          <h2 className="fightcard-name">{card.displayName}</h2>

          {/* The one line on the card the member wrote themselves, so it is the
              one line that is handwriting. Absent rather than placeheld: an
              empty quotation mark is a gap wearing a decoration. */}
          {card.ringName && (
            <p className="fightcard-ring">&ldquo;{card.ringName}&rdquo;</p>
          )}

          <p className="fightcard-programme">{card.programLabel}</p>

          {/* Law 3 -- the dye is never the only channel. The words are here
              whether or not the colour survives the screen, the printer, or the
              reader's eyes. */}
          <p className="fightcard-corner">
            <i aria-hidden="true" />
            {card.cornerLabel}
          </p>

          <dl className="fightcard-facts pt-[var(--s3)]">
            <dt className={FACT_LABEL}>In your corner</dt>
            <dd className={FACT_LABEL}>
              {card.coachName ? (
                <span className="inline-flex items-center gap-[var(--s3)]">
                  <ProfilePortrait
                    accountId={card.coachAccountId}
                    initials={card.coachInitials ?? '—'}
                    name={card.coachName}
                    photoAvailable={card.coachPhotoAvailable}
                    size="sm"
                    decorative
                  />
                  {card.coachName}
                </span>
              ) : (
                /* Honest, not blank: the platform genuinely does not have a
                   coach of record for this member, and saying so is better
                   than an em dash the reader has to interpret. */
                'No coach of record yet'
              )}
            </dd>

            <dt className={FACT_LABEL}>At the gym</dt>
            <dd className={FACT_LABEL}>{card.timeAtGym ?? 'Start date not recorded'}</dd>
          </dl>

          {own && (
            <p className="pt-[var(--s3)]">
              <Link
                href="/profile"
                className="btn btn--ghost text-[length:var(--t-xs)]"
              >
                Edit your card
              </Link>
            </p>
          )}
        </div>
      </div>
    </article>
  );
}
