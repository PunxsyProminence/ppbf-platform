'use client';

import React, { useEffect, useState } from 'react';

import PhotoSlot from './PhotoSlot';
import { gymPhotoSlotsFor, gymPhotoSrc, type GymPhotoSlot } from '@/src/shared/gymPhotos';
import { apiBase } from '@/lib/apiBase';

/**
 * THE GYM WALL — photographs of this building, on a dashboard.
 *
 * ---------------------------------------------------------------------------
 * THE PRIVACY DECISION, STATED PLAINLY
 * ---------------------------------------------------------------------------
 *
 * NO PEOPLE. This module shows the room, the ring, the bags, the bench and the
 * wall. It never shows a member, and it is structurally incapable of showing
 * one: its sources are src/shared/gymPhotos.ts (a manifest of static files
 * under public/gym) and the gym-wall route (/api/pilot/gym-photos, serving
 * only what an admin uploaded through /admin/gym-photos for THIS slot list).
 * There is no code path from this component to pilot.account_profiles, to the
 * portrait route, or to any athlete media.
 *
 * That is not caution for its own sake. A dashboard module is seen by everyone
 * signed in to the gym, which makes the honest viewer relationship
 * 'organization_staff' at best -- and profileVisibility.ts's decidePortrait()
 * answers 'plate' for a minor at that relationship, deliberately and with the
 * argument written out in full. There is therefore no reading of the existing
 * scoping under which a child's released portrait may be rotated onto a shared
 * surface, so this module does not source faces at all rather than inventing a
 * second, weaker rule beside the one that exists.
 *
 * A gym-space photograph with a person incidentally in it is a judgement the
 * person committing the file makes, in front of the actual picture. The
 * platform cannot make that judgement and does not pretend to -- the same
 * position profileVisibility.ts takes about portraits.
 *
 * ---------------------------------------------------------------------------
 * THE EMPTY STATE IS THE DESIGN
 * ---------------------------------------------------------------------------
 *
 * There are zero photographs today and there may be zero for months. So the
 * empty wall is built first and the populated one is the variant: frames hung
 * on the wall with nothing in them yet, an engraved plate under each saying
 * what it is for, and one line explaining how a photograph gets there. Nothing
 * is dashed, greyed, spinning, or shaped like a broken image.
 */

/** How long one photograph holds the frame. Long enough to look at. */
export const GYM_WALL_ROTATE_MS = 12_000;

export interface GymWallModuleProps {
  /**
   * Injectable for tests and for a future gym-space photo store. Defaults to
   * the dashboard slots of the static manifest -- which are all empty today.
   */
  readonly slots?: readonly GymPhotoSlot[];
  readonly className?: string;
  /** Off in tests and under reduced motion; see the effect below. */
  readonly rotateMs?: number;
}

export default function GymWallModule({
  slots = gymPhotoSlotsFor('dashboard'),
  className = '',
  rotateMs = GYM_WALL_ROTATE_MS,
}: GymWallModuleProps) {
  // Admin-uploaded photographs, slot key -> session-scoped URL. Loaded once,
  // defensively: a wall that cannot reach the route shows the manifest's
  // placeholder illustrations, which is a complete answer rather than an error.
  const [uploads, setUploads] = useState<Record<string, string>>({});
  useEffect(() => {
    if (typeof fetch !== 'function') return undefined;
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch(`${apiBase()}/api/pilot/gym-photos`, { credentials: 'include' });
        if (!response.ok) return;
        const data: unknown = await response.json();
        const uploaded = (data as { ok?: boolean; uploads?: Record<string, string> } | null)?.uploads;
        if (!cancelled && uploaded && typeof uploaded === 'object') setUploads(uploaded);
      } catch {
        // Signed-out surface, offline kiosk, or a route hiccup: the manifest
        // stands in. Nothing to report to the person looking at a wall.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const filled = slots.filter((slot) => uploads[slot.key] || gymPhotoSrc(slot.file) !== null);
  const [index, setIndex] = useState(0);

  // Rotation exists only when there is something to rotate. With one
  // photograph, or none, no timer is ever created -- a wall with a single
  // picture on it does not need a carousel, and a wall with none needs one even
  // less.
  useEffect(() => {
    if (filled.length < 2 || rotateMs <= 0) return undefined;
    if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
      // A picture swapping itself out on a timer is motion, and somebody who
      // asked the operating system to stop motion asked for this too. They get
      // the first photograph and the buttons.
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return undefined;
    }
    const timer = window.setInterval(() => {
      setIndex((current) => (current + 1) % filled.length);
    }, rotateMs);
    return () => window.clearInterval(timer);
  }, [filled.length, rotateMs]);

  const showing = filled.length > 0 ? filled[index % filled.length] : null;

  return (
    <section className={`gym-wall ${className}`.trim()} aria-label="Photographs from the gym" data-filled={showing ? 'yes' : 'no'}>
      <div className="gym-wall-head">
        <p className="gym-wall-eyebrow">On the wall</p>
      </div>

      {showing ? (
        <>
          <PhotoSlot slot={showing} shape="wide" className="gym-wall-frame" uploadedSrc={uploads[showing.key] ?? null} />
          {filled.length > 1 && (
            <div className="gym-wall-controls">
              <button
                type="button"
                className="btn btn--ghost btn--compact"
                onClick={() => setIndex((current) => (current - 1 + filled.length) % filled.length)}
              >
                Previous
              </button>
              <p className="gym-wall-count" aria-live="off">
                {(index % filled.length) + 1} of {filled.length}
              </p>
              <button
                type="button"
                className="btn btn--ghost btn--compact"
                onClick={() => setIndex((current) => (current + 1) % filled.length)}
              >
                Next
              </button>
            </div>
          )}
        </>
      ) : (
        <div className="gym-wall-empty">
          {/* Frames, hung, empty. Two of them rather than one, because a single
              empty frame reads as a thing that failed to load and a row of them
              reads as a wall waiting to be filled -- which is exactly what this
              is. */}
          {slots.slice(0, 2).map((slot) => (
            <PhotoSlot key={slot.key} slot={slot} shape="wide" className="gym-wall-frame" />
          ))}
          <p className="gym-wall-note">
            Nobody has taken these yet. When somebody does, they go up here — the room, the ring, the bags. No
            stock photographs, and no pictures of anybody&apos;s kid on a shared screen.
          </p>
        </div>
      )}
    </section>
  );
}
