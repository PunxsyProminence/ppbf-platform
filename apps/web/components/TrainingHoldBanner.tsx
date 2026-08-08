'use client';

import React, { useEffect, useState } from 'react';

import { apiBase } from '@/lib/apiBase';

/**
 * The athlete-facing face of a training hold (capability #82).
 *
 * Self-contained like ProfileHeader: fetches its own data, renders nothing
 * when there is no active hold (or when the fetch fails -- an error here
 * must never dress itself up as "you are held"), so mounting it is a single
 * insertion into the workspace.
 *
 * The language contract: this shows ONLY the athlete-safe projection the
 * training-holds route builds -- the explanation written for the athlete
 * and what earns the lift. Never the staff reason, never the category, and
 * NON-PUNITIVE by construction: the copy frames the pause as care with a
 * path back, not a sanction. A hold a child reads as a punishment teaches
 * them not to report the thing that caused it.
 */

interface AthleteFacingHold {
  scope: 'all_training' | 'contact_only' | 'conditioning_only';
  athlete_explanation: string;
  lift_condition_text: string;
  placed_at: string;
  expires_at: string | null;
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
    <section
      role="status"
      className="mat-paper rounded-[var(--r-md)] border-2 border-[color:var(--brass-700)] p-[var(--s5)] space-y-[var(--s3)]"
    >
      <p className="t-eyebrow">A note from your coaches</p>
      <h2 className="t-command" style={{ fontSize: 'var(--t-lg)' }}>
        {SCOPE_HEADLINE[hold.scope] ?? SCOPE_HEADLINE.all_training}
      </h2>
      <p className="text-[length:var(--t-md)] leading-relaxed">{hold.athlete_explanation}</p>
      {hold.lift_condition_text ? (
        <p className="text-[length:var(--t-md)] leading-relaxed">
          <span className="font-bold">The way back: </span>
          {hold.lift_condition_text}
        </p>
      ) : null}
      <p className="text-[length:var(--t-md)] leading-relaxed opacity-80">
        This is not a punishment — it is your coaches looking out for you. Talk to your coach or the gym
        admin if anything about it is unclear.
      </p>
    </section>
  );
}
