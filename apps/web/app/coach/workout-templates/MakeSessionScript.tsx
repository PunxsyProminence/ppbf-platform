'use client';

import { useRef, useState } from 'react';
import Link from 'next/link';

import { apiBase } from '@/lib/apiBase';

// MAKE A SESSION SCRIPT from the open template (lane L1).
//
// One press: the template's steps, in its order, become a session script's
// timed blocks (the server does it in one transaction, or not at all). The
// script is then a plan under Session Scripts, where its minutes and block
// titles are changed and where it is delivered.
//
// THE SCREEN NEVER SAYS "NOTHING WAS MADE" UNLESS THE SERVER SAID SO, the rule
// Issue to athlete keeps on this page. Nothing stops a template being made
// into a script twice, so a coach wrongly told it failed would make a second:
//   - 201: made, always -- even when the body cannot be read;
//   - a refusal by one of the statuses this route refuses with (the list
//     below): nothing was made, and the reason is given;
//   - anything else -- no answer, a server fault, or another 4xx such as a
//     rate limit or a timeout from something in between, whatever its body
//     says -- is not known, and said so, with where to look before pressing
//     again. The rule Issue to athlete keeps on this page.
//
// NOT THE MEDICAL-STOP COLOUR. A refusal or an unknown answer here is an
// ordinary message: --locked means a medical stop and nothing else
// (AGENT_KERNEL.md, OD-2026-09-29-001), so the alert is brass and bone, and
// its words carry the meaning.

// What POST /api/pilot/session-scripts answers when it refuses before or
// inside its transaction: a bad body, signed out, not allowed, not found, not
// current or empty, a name or a length it cannot hold.
const REFUSAL_STATUSES: readonly number[] = [400, 401, 403, 404, 409, 422];

const NOT_MADE_BY_STATUS: Readonly<Record<number, string>> = {
  401: 'You are signed out, so no session script was made. Sign in and try again.',
  403: 'Your account may not make session scripts, so none was made.',
};

const NOT_MADE: Readonly<Record<string, string>> = {
  WORKOUT_TEMPLATE_NOT_FOUND: 'This template could not be found, so no session script was made.',
  WORKOUT_TEMPLATE_NOT_CURRENT: 'This template is no longer in use, so no session script was made.',
  WORKOUT_TEMPLATE_EMPTY: 'This template has no steps, so no session script was made.',
  WORKOUT_TEMPLATE_TOO_LONG: 'This template runs longer than a session script can hold, so no session script was made.',
  SESSION_SCRIPT_NAME_INVALID: 'The template name cannot be used as a plan name, so no session script was made.',
};

type Outcome =
  | { kind: 'made'; scriptId: string | null; name: string | null; blocks: number | null }
  | { kind: 'not_made'; message: string }
  | { kind: 'unknown' };

const ALERT = 'rounded-[var(--r-md)] border-2 border-[color:var(--brass-300)] bg-[rgba(0,0,0,.28)] px-[var(--s3)] py-[var(--s3)] text-[length:var(--t-md)] font-semibold text-[color:var(--bone-100)]';

export default function MakeSessionScript({
  templateId,
  onBusyChange,
}: {
  readonly templateId: string;
  /** Told while the request is running, so the page keeps this control on screen until it answers. */
  readonly onBusyChange?: (busy: boolean) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  // One request per press: `busy` disables the button only after a render.
  const inFlight = useRef(false);

  const make = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    onBusyChange?.(true);
    setOutcome(null);
    try {
      let response: Response;
      try {
        response = await fetch(`${apiBase()}/api/pilot/session-scripts`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ template_id: templateId }),
        });
      } catch {
        setOutcome({ kind: 'unknown' });
        return;
      }
      const payload = (await response.json().catch(() => null)) as {
        script?: { script_id?: unknown; name?: unknown; blocks?: unknown } | null;
        error?: unknown;
      } | null;
      if (response.status === 201) {
        const script = payload?.script;
        setOutcome({
          kind: 'made',
          scriptId: typeof script?.script_id === 'string' ? script.script_id : null,
          name: typeof script?.name === 'string' ? script.name : null,
          blocks: Array.isArray(script?.blocks) ? script.blocks.length : null,
        });
        return;
      }
      if (REFUSAL_STATUSES.includes(response.status)) {
        const code = typeof payload?.error === 'string' ? payload.error : '';
        setOutcome({
          kind: 'not_made',
          message: NOT_MADE[code] ?? NOT_MADE_BY_STATUS[response.status] ?? 'The server refused, so no session script was made.',
        });
        return;
      }
      setOutcome({ kind: 'unknown' });
    } finally {
      inFlight.current = false;
      setBusy(false);
      onBusyChange?.(false);
    }
  };

  return (
    <section data-surface="kiosk" aria-label="Make a session script" className="mt-[var(--s6)] border-t border-[color:rgb(var(--brass-400-rgb)_/_.22)] pt-[var(--s5)]">
      <h3 className="t-command text-[length:var(--t-md)]">Make a session script</h3>
      <p className="t-body mt-[var(--s2)] text-[color:var(--bone-300)]">
        Turns these blocks, in this order, into a timed plan you can run live. A block with no minutes
        is given 5. You set the minutes and block titles afterwards under Session Scripts.
      </p>

      {outcome?.kind !== 'made' && (
        <button
          type="button"
          onClick={() => void make()}
          disabled={busy}
          className="btn mt-[var(--s4)] disabled:cursor-not-allowed disabled:opacity-60"
        >
          {busy ? 'Making...' : 'Make a session script'}
        </button>
      )}

      {outcome?.kind === 'made' && (
        <div role="status" className="mt-[var(--s4)] rounded-[var(--r-md)] border border-[color:rgb(var(--brass-400-rgb)_/_.35)] bg-[rgba(0,0,0,.28)] p-[var(--s4)]">
          <p className="t-body text-[color:var(--brass-300)]">
            {outcome.name === null
              ? 'A session script was made, but its details could not be read here. It is under Session Scripts.'
              : `Made the session script ${outcome.name}${outcome.blocks === null ? '' : `: ${outcome.blocks} ${outcome.blocks === 1 ? 'block' : 'blocks'}`}.`}
          </p>
          <Link
            href={outcome.scriptId === null
              ? '/coach/session-scripts'
              : `/coach/session-scripts?script=${encodeURIComponent(outcome.scriptId)}`}
            className="btn mt-[var(--s3)]"
          >
            Open it in Session Scripts
          </Link>
        </div>
      )}

      {outcome?.kind === 'not_made' && (
        <p role="alert" className={`mt-[var(--s3)] ${ALERT}`}>{outcome.message}</p>
      )}

      {outcome?.kind === 'unknown' && (
        <div role="alert" className={`mt-[var(--s3)] ${ALERT}`}>
          <p>
            The answer did not arrive, so it is not known whether the session script was made. Look
            under Session Scripts before pressing again.
          </p>
          <Link href="/coach/session-scripts" className="btn btn--ghost mt-[var(--s3)]">
            Session Scripts
          </Link>
        </div>
      )}
    </section>
  );
}
