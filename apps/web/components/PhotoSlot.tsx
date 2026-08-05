'use client';

import React, { useState } from 'react';

import { gymPhotoSrc, type GymPhotoSlot } from '@/src/shared/gymPhotos';

/**
 * ONE FRAME ON THE WALL.
 *
 * THE EMPTY FRAME IS THE PRIMARY STATE, NOT THE FALLBACK.
 *
 * The gym has no photographs yet. On day one every slot on every surface is
 * empty, and the owner may fill them one at a time over months, so "empty" is
 * not a brief loading blip before the real design appears -- it IS the design
 * for most of this feature's life. Built the same way ProfilePortrait builds
 * its brass plate: a finished object, not a hole with an apology in it.
 *
 * An empty frame is a real thing that hangs in a real building. It has a
 * moulding, a mount, and an engraved plate underneath saying what belongs in
 * it. What it deliberately does NOT have:
 *
 *   - no stock photograph, no illustration, no silhouette of a boxer;
 *   - no placeholder gradient, which is exactly what a broken CDN looks like;
 *   - no dashed "upload" rectangle, because a visitor to the public page is not
 *     going to upload anything and being shown an authoring affordance they
 *     cannot use is worse than being shown nothing;
 *   - no spinner. Nothing is loading. There is no photograph.
 *
 * A frame whose photograph fails to load falls back to the empty state rather
 * than a broken-image glyph -- same stance ProfilePortrait takes, for the same
 * reason: the failed state must be indistinguishable from the never-had-one
 * state, so a reader cannot infer anything from it.
 */

export interface PhotoSlotProps {
  readonly slot: GymPhotoSlot;
  /** 'tall' is a portrait mount (a person), 'wide' a landscape one (a room). */
  readonly shape?: 'tall' | 'wide';
  readonly className?: string;
}

export default function PhotoSlot({ slot, shape = 'wide', className = '' }: PhotoSlotProps) {
  const [failed, setFailed] = useState(false);
  const src = gymPhotoSrc(slot.file);
  const showPhoto = src !== null && !failed;

  return (
    <figure className={`photo-slot photo-slot--${shape} ${className}`.trim()} data-filled={showPhoto ? 'yes' : 'no'}>
      <div className="photo-slot-mount">
        {showPhoto ? (
          /* A bare <img>, matching ProfilePortrait's reasoning about the image
             optimizer. These are static same-origin files under public/gym, so
             there is no session-scoped route for a cache to get wrong, but the
             files are already sized by whoever committed them and the optimizer
             would only add a build dependency for no gain. */
          // eslint-disable-next-line @next/next/no-img-element
          <img src={src} alt={slot.alt} loading="lazy" decoding="async" onError={() => setFailed(true)} />
        ) : (
          /* The mount, empty. Nothing is announced to a screen reader here: an
             empty frame is furniture, and the caption below already says in
             words what the frame is for. */
          <span className="photo-slot-mount-empty" aria-hidden="true" />
        )}
      </div>
      <figcaption className="photo-slot-caption">
        <span className="photo-slot-title">{slot.title}</span>
        <span className="photo-slot-note">{slot.caption}</span>
      </figcaption>
    </figure>
  );
}
