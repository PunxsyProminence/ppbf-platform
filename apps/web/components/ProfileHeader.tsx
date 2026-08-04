'use client';

import React, { useEffect, useState } from 'react';
import FightCard from './FightCard';
import type { FightCardPayload } from './profileClient';
import { apiBase } from '@/lib/apiBase';

/**
 * A member's own card, at the top of their own workspace.
 *
 * Self-contained on purpose. It fetches its own data and renders nothing at all
 * until it has some, so dropping it into an existing workspace is one import
 * and one element -- no new state, no new effect, and no new failure mode in
 * the host component. A workspace whose profile read fails looks exactly like a
 * workspace that never had one.
 *
 * The rope above the card is the corner post's tape: the member's corner, as a
 * graphical object rather than a colour on any text, and the one large area of
 * the dye on the screen. Everything below it is the workspace as it was.
 */
export default function ProfileHeader({ className = '' }: { readonly className?: string }) {
  const [card, setCard] = useState<FightCardPayload | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(`${apiBase()}/api/pilot/profile/me`, {
          credentials: 'include',
          signal: controller.signal,
        });
        if (!response.ok) return;
        const payload = (await response.json()) as { card?: FightCardPayload | null };
        setCard(payload.card ?? null);
      } catch {
        // Nothing renders. The workspace is unaffected.
      }
    })();
    return () => controller.abort();
  }, []);

  if (!card) return null;

  return (
    <div className={`corner-scope space-y-[var(--s4)] ${className}`} data-corner={card.corner}>
      <div className="corner-rope" aria-hidden="true" />
      <FightCard card={card} own />
    </div>
  );
}
