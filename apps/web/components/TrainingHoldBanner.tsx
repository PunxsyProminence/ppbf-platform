'use client';

import React, { useEffect, useState } from 'react';

import { apiBase } from '@/lib/apiBase';
import RefusalStamp from './RefusalStamp';

/**
 * The athlete-facing face of a training hold (capability #82).
 *
 * Self-contained like ProfileHeader: fetches its own data and renders nothing
 * when a read established there is no active hold, so mounting it is a single
 * insertion into the workspace.
 *
 * A read that FAILED is a third state, not "no hold". It must never dress
 * itself up as "you are held" -- and it used to render nothing at all, which
 * is exactly what an athlete with no hold sees, so a held child whose check
 * could not be read saw an ordinary training day. Owner decision, 2026-10-01
 * (Jason, asked what an athlete sees when the hold check cannot be read:
 * "Talk to your Coach about todays training"): that one line, and nothing
 * else -- no stamp, no red, no account of what went wrong.
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

/* The route's athlete-facing projection, checked before anything renders it.
   RefusalStamp THROWS on a blank explanation or name (a hold that reads as
   blank is worse than none), so a partial object here would take the
   athlete's whole screen down instead of telling them to talk to their coach.
   A `hold` that is not this is an unread hold. */
function isAthleteFacingHold(value: unknown): value is AthleteFacingHold {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const hold = value as Record<string, unknown>;
  return (
    typeof hold.scope === 'string' && hold.scope in SCOPE_HEADLINE
    && typeof hold.athlete_explanation === 'string' && hold.athlete_explanation.trim().length > 0
    && typeof hold.placed_by_name === 'string' && hold.placed_by_name.trim().length > 0
    && (hold.lift_condition_text === null || hold.lift_condition_text === undefined || typeof hold.lift_condition_text === 'string')
  );
}

const HOLD_UNREAD_LINE = 'Talk to your coach about today’s training.';

export default function TrainingHoldBanner() {
  const [hold, setHold] = useState<AthleteFacingHold | null>(null);
  // Silence is only a statement once a read has established it: 'loaded'
  // with no hold is the one state in which rendering nothing means "no hold".
  const [readState, setReadState] = useState<'loading' | 'loaded' | 'unavailable'>('loading');

  useEffect(() => {
    const controller = new AbortController();
    (async () => {
      try {
        const response = await fetch(`${apiBase()}/api/pilot/training-holds`, {
          credentials: 'include',
          signal: controller.signal,
        });
        if (!response.ok) {
          setReadState('unavailable');
          return;
        }
        const payload = (await response.json()) as { hold?: AthleteFacingHold | null } | null;
        // The route always answers with a `hold` key, null or the hold. A 200
        // that does not carry one answered some other question, and is not a
        // statement that there is no hold.
        if (!payload || typeof payload !== 'object' || !('hold' in payload)) {
          setReadState('unavailable');
          return;
        }
        // Null is "no hold". Anything else has to BE a hold: every field the
        // stamp renders, present and of the right type.
        if (payload.hold !== null && !isAthleteFacingHold(payload.hold)) {
          setReadState('unavailable');
          return;
        }
        if (payload.hold) setHold(payload.hold);
        setReadState('loaded');
      } catch {
        // An unreachable API is not a hold -- and not "no hold" either. The
        // abort on unmount is neither: nobody is left to tell.
        if (!controller.signal.aborted) setReadState('unavailable');
      }
    })();
    return () => controller.abort();
  }, []);

  if (readState === 'unavailable') {
    return (
      <section data-hold-read="unavailable">
        <p className="t-body">{HOLD_UNREAD_LINE}</p>
      </section>
    );
  }

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
