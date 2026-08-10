'use client';

/**
 * The last line of defence for the wall.
 *
 * WallDisplay already survives a failed read -- it keeps the last good board,
 * dates it, and falls back to the crest and the clock. This boundary is for the
 * case that one cannot cover: a render-time throw. Next's default error screen
 * is a developer artefact ("Application error: a client-side exception has
 * occurred"), and putting that on a television in front of the whole gym is the
 * failure this route exists to avoid.
 *
 * So the boundary renders the same standing screen the display itself falls
 * back to, and the digest goes nowhere near the panel. There is no "Try again"
 * button, because there is nobody standing at this screen to press it: the
 * reset is automatic, on the same cadence the board polls at.
 */

import { useEffect } from 'react';

const RESET_MS = 30_000;

export default function WallError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    // Logged, not displayed.
    console.error({ event: 'wall-display-render-failed', digest: error.digest });
    const retry = setTimeout(() => reset(), RESET_MS);
    return () => clearTimeout(retry);
  }, [error, reset]);

  return (
    <div className="wall-board flex h-screen w-screen flex-col items-center justify-center gap-[var(--s5)]">
      <p className="wall-standing-crest" aria-hidden="true">
        PPBF
      </p>
      <p className="wall-standing-line text-5xl">The board is reconnecting.</p>
    </div>
  );
}
