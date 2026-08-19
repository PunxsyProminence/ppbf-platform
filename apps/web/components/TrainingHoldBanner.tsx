'use client';

import React, { useEffect, useState } from 'react';

import { apiBase } from '@/lib/apiBase';
import RefusalStamp from './RefusalStamp';

/**
 * The athlete-facing face of a training hold (capability #82).
 *
 * Self-contained like ProfileHeader: fetches its own data, renders nothing
 * when there is no active hold (or when the fetch fails -- an error here
 * must never dress itself up as "you are held"), so mounting it is a single
 * insertion into the workspace.
 *
 * The language contract: this shows ONLY the athlete-safe projection the
 * training-holds route builds -- the explanation written for the athlete,
 * who placed it, and what earns the lift. Never the staff reason, never the
 * category, and NON-PUNITIVE by construction: the copy frames the pause as
 * care with a path back, not a sanction. A hold a child reads as a
 * punishment teaches them not to report the thing that caused it.
 *
 * Owner decision, 2026-08-19: an individual coach's name IS now included --
 * "so they have a point of contact to investigate why". Until this date the
 * projection deliberately withheld it (see git history on this file); the
 * mark now renders through the real <RefusalStamp kind="training_hold" />
 * rather than the bare glyph/label constants that stood in while coachName
 * had nowhere real to come from.
 */

interface AthleteFacingHold {
  scope: 'all_training' | 'contact_only' | 'conditioning_only';
  athlete_explanation: string;
  lift_condition_text: string;
  placed_at: string;
  expires_at: string | null;
  placed_by_name: string;
}

const SCOPE_HEADLINE: Record<AthleteFacingHold['scope'], string> = {
  all_training: 'Training is paused for you right now',
  contact_only: 'Contact work is paused for you right now',
  conditioning_only: 'Conditioning is paused for you right now',
};

export default function TrainingHoldBanner() {
  const [hold, setHold] = useState<AthleteFacingHold | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    (async () => {
      try {
        const response = await fetch(`${apiBase()}/api/pilot/training-holds`, {
          credentials: 'include',
          signal: controller.signal,
        });
        if (!response.ok) return;
        const payload = (await response.json()) as { hold?: AthleteFacingHold | null };
        if (payload.hold) setHold(payload.hold);
      } catch {
        // Render nothing on failure: an unreachable API is not a hold.
      }
    })();
    return () => controller.abort();
  }, []);

  if (!hold) return null;

  return (
    <section className="space-y-[var(--s3)]">
      <h2 className="t-command" style={{ fontSize: 'var(--t-lg)' }}>
        {SCOPE_HEADLINE[hold.scope] ?? SCOPE_HEADLINE.all_training}
      </h2>
      <RefusalStamp
        kind="training_hold"
        coachExplanation={hold.athlete_explanation}
        coachName={hold.placed_by_name}
        // The route only requires an explanation, never a lift condition --
        // an honest fallback that still points at a real point of contact,
        // never a fabricated condition standing in for one that was never
        // written.
        endsWhen={hold.lift_condition_text || `Ask ${hold.placed_by_name} what has to happen next.`}
      />
    </section>
  );
}
