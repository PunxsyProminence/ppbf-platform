'use client';

import React, { useEffect, useState } from 'react';

import { apiBase } from '@/lib/apiBase';
import { TRAINING_HOLD_GLYPH, TRAINING_HOLD_LABEL } from './RefusalStamp';

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
 *
 * The mark itself -- the "‖ TRAINING HOLD" glyph and label -- is drawn from
 * RefusalStamp's shared constants rather than being restated here, so the
 * gym-floor room and the clinic room's own Sports Medicine board show the
 * exact same brass, non-punitive mark for the exact same real thing (Room
 * DNA: the stamp is room-invariant, only the chrome around it changes).
 *
 * This does NOT call <RefusalStamp kind="training_hold" .../> directly.
 * That kind's contract (see RefusalStamp.tsx and refusalStamp.test.tsx)
 * requires a real coachName -- "the actual name of whoever placed the
 * hold... never a placeholder like 'Coach'" -- and throws rather than
 * render one blank. The training-holds route's athlete-safe projection
 * (app/api/pilot/training-holds/route.ts, athleteFacing()) deliberately
 * never returns an individual coach's identity to an athlete or guardian --
 * confirmed against three independent surfaces that all agree: this
 * banner, the parent safety page, and even the coach-facing Sports
 * Medicine clearance board (whose own header comment records an owner
 * decision, 2026-08-15, to show "athlete-safe explanations ONLY"). There is
 * no real coachName anywhere in this data model to hand the stamp, and
 * inventing one -- even an institutional stand-in like "Your Coaches" --
 * would be exactly the placeholder RefusalStamp's own contract forbids.
 * Reusing the exported glyph/label constants gets the visual consolidation
 * this capability actually needs without fabricating data or reopening
 * whether an individual coach's name should ever reach a minor's screen,
 * which is a doctrine question for the owner, not this refactor.
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
    <section role="status" data-refusal-stamp="training_hold" className="space-y-[var(--s3)]">
      {/* The shared brass, non-punitive mark (RefusalStamp.tsx) -- the same
          glyph and label the clinic room's Sports Medicine board now shows
          for the same real thing. Deliberately .stamp--flat: a coach's note,
          not a refusal slammed onto the page. */}
      <span className="stamp stamp--brass stamp--flat stamp--kiosk">
        <i aria-hidden="true">{TRAINING_HOLD_GLYPH}</i>
        <span>{TRAINING_HOLD_LABEL}</span>
      </span>
      <div className="mat-paper rounded-[var(--r-md)] border-2 border-[color:var(--brass-700)] p-[var(--s5)] space-y-[var(--s3)]">
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
      </div>
    </section>
  );
}
