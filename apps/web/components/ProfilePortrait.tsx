'use client';

import React, { useState } from 'react';
import { apiBase } from '@/lib/apiBase';
import { portraitUrl, type CornerChoice } from './profileClient';

/**
 * A member's face, or the object that stands in for it.
 *
 * THE PLATE IS THE PRIMARY STATE, NOT THE FALLBACK.
 *
 * On day one nobody has uploaded anything. Under the privacy rules most viewers
 * are never shown a child's face at all, and a portrait stays pending until a
 * coach releases it. So the no-photo case is the case this platform is mostly
 * in, and it has to be a finished object rather than a hole with a shrug in it.
 *
 * It is a brass nameplate with the member's initials struck into it -- the same
 * material, the same two screws and the same engraved text shadow as the
 * .nameplate the Organizations rail already hangs. A member with no photograph
 * has a nameplate; a member with one has a photograph in the same frame. Both
 * are things that hang on a wall in this building, which is the whole point:
 * you cannot tell by looking at the layout which one somebody has, so nobody's
 * space looks unfinished.
 *
 * It is also the privacy fallback, and that is deliberate. A viewer who may not
 * see a child's face gets exactly what a viewer of a member with no photo gets.
 * There is no "hidden" badge, no lock glyph, nothing that says a photograph
 * exists -- because saying so is itself a disclosure about that child.
 */

export interface ProfilePortraitProps {
  readonly accountId: string | null;
  readonly initials: string;
  readonly name: string;
  /** False renders the plate without ever requesting the photo route. */
  readonly photoAvailable: boolean;
  readonly corner?: CornerChoice;
  readonly size?: 'sm' | 'md' | 'lg';
  /**
   * True when the member's name is already printed next to the portrait -- a
   * roster row, a child chip, the coach line on a card. The plate then carries
   * no role and no label, because a screen reader announcing "Sofia Alvarez,
   * image, Sofia Alvarez" is the portrait making the name harder to read rather
   * than easier. Default false: a portrait standing alone must still say who it
   * is of.
   */
  readonly decorative?: boolean;
}

export default function ProfilePortrait({
  accountId,
  initials,
  name,
  photoAvailable,
  corner = 'none',
  size = 'md',
  decorative = false,
}: ProfilePortraitProps) {
  // A photo that 404s or fails to decode falls back to the plate rather than
  // rendering a broken-image glyph. The server answers 404 for every refusal,
  // so this path is also what a revoked release looks like mid-session.
  const [failed, setFailed] = useState(false);
  const showPhoto = photoAvailable && accountId !== null && !failed;

  const sizeClass = size === 'sm' ? 'plate--sm' : size === 'lg' ? 'plate--lg' : '';

  return (
    <div
      className={`plate ${sizeClass} ${corner === 'none' ? '' : 'plate--cornered'} corner-scope`}
      data-corner={corner}
      /* The plate carries the name for a screen reader whether or not a
         photograph is showing, and the alt text below is empty for the same
         reason: two announcements of the same person is noise. Where the name
         is already on screen beside it, the whole plate steps out of the
         accessibility tree instead. */
      {...(decorative
        ? { 'aria-hidden': true as const }
        : { role: 'img', 'aria-label': name })}
    >
      {showPhoto ? (
        /* A bare <img>, not next/image, and that is the point. The image
           optimizer fetches the source itself and caches the result on the
           server, which for a route that answers differently depending on WHO
           is asking means a cached copy of a child's face served past the
           visibility gate. The portrait is already bounded to 512px by the
           upload policy, so there is nothing for the optimizer to save. */
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={portraitUrl(apiBase(), accountId)}
          alt=""
          loading="lazy"
          decoding="async"
          onError={() => setFailed(true)}
        />
      ) : (
        <span className="plate-initials" aria-hidden="true">{initials}</span>
      )}
    </div>
  );
}
