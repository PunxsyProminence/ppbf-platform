'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

import {
  persistAuthoritativeRoleSession,
  loadAuthoritativeRoleSession,
} from '@/components/roleSession';
import { apiBase } from '@/lib/apiBase';
import { DEFAULT_PIN_LENGTH } from '@/src/server/pilot/pinPolicy';

interface LoginPayload {
  ok?: boolean;
  role?: string;
  athlete_id?: string | null;
  error?: string;
}

export default function AthletePinSignInPage() {
  const router = useRouter();
  const [accountId, setAccountId] = useState('');
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');

    if (!accountId.trim() || !pin.trim()) {
      setError('Athlete Account ID and PIN are required.');
      return;
    }

    setSubmitting(true);
    try {
      const response = await fetch(`${apiBase()}/api/pilot/auth/login`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          account_id: accountId.trim(),
          pin: pin.trim(),
        }),
      });

      const payload = (await response.json().catch(() => ({}))) as LoginPayload;

      if (!response.ok || !payload.ok) {
        throw new Error(payload.error || 'Sign in failed.');
      }

      if (payload.role !== 'athlete') {
        throw new Error('This sign-in page is for athlete accounts only.');
      }

      const resolution = await loadAuthoritativeRoleSession(`${apiBase()}/api/pilot/auth/session`);
      // Every athlete starts on the gym-issued PIN with must_change_pin set, so
      // this is the FIRST sign-in of every account, not an error. /login and
      // RoleSessionGate both send this state to /change-pin; without the same
      // branch here the athlete looped on "please sign in again" forever.
      if (!resolution.ok && resolution.reason === 'pin_change_required') {
        router.replace('/change-pin');
        return;
      }
      if (!resolution.ok || resolution.session.role !== 'athlete') {
        throw new Error('The athlete session could not be verified. Please sign in again.');
      }

      persistAuthoritativeRoleSession(resolution.session);
      router.replace(resolution.destination);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : 'Sign in failed.');
    } finally {
      setSubmitting(false);
    }
  }

  /* The gym floor, which is what Law 5 is about: an athlete standing at a
     shared tablet with wrapped hands, bad overhead light and a queue behind
     them. This page was built at desk sizes -- 48px fields, a 50px button,
     text-xs labels -- all of it under the 55px --tap floor and the 19.1px
     kiosk type minimum. Everything an athlete touches here is now --tap or
     larger, and nothing they have to read is below --t-md.

     Ground is canvas rather than ink on purpose, and not only for warmth: a
     near-black panel under gym lights is a mirror. The card is paper, which is
     also what Law 6 allows -- white is not one of the five materials, and the
     rounded-2xl/rounded-xl geometry it came with is off the Fibonacci radius
     scale entirely.

     The controls are ppbf.css's own .btn--kiosk / .input--kiosk, wrapped in
     .on-canvas so the sheet re-tunes them for the warm ground. Those classes
     already shipped in the bundle and nothing used them; this is the first
     route on canvas ground, which is also what surfaced the .btn--ghost gap
     fixed alongside this.

     Not taken here: .mechanical-lock, the sheet's 56px keypad, is the right
     component for a floor PIN but swapping a text field for a keypad changes
     the interaction, not the styling.

     One cascade trap worth knowing before reaching for the .t-* voices on a
     kiosk. globals.css imports ppbf.css *after* Tailwind, so any ppbf class
     carrying its own font-size beats a Tailwind size utility no matter what
     the markup asks for. .t-body pins 14px and .t-label / .t-eyebrow pin 11px
     through the `font:` shorthand -- all three below the 19.1px floor, and all
     three silently. The first pass here used .t-body with text-[length:...]
     and rendered at 14px. .t-command carries no size, so it still composes. */
  return (
    <main className="on-canvas grid min-h-screen place-items-center px-[var(--s5)] py-[var(--s6)]">
      <div className="mat-paper w-full max-w-[520px] rounded-[var(--r-lg)] border border-[color:rgba(0,0,0,.16)] p-[var(--s6)]">
        <p className="font-mono text-[length:var(--t-sm)] uppercase tracking-[0.22em] text-[color:var(--brass-800)]">
          Athlete sign in
        </p>
        <h1 className="t-command mt-[var(--s3)] text-[length:var(--t-xl)]">PIN login</h1>
        <p className="mt-[var(--s4)] text-[length:var(--t-md)] leading-[1.55] text-[color:var(--hide-800)]">
          Use your athlete Account ID and {DEFAULT_PIN_LENGTH}-digit PIN.
        </p>

        <form className="mt-[var(--s6)] flex flex-col gap-[var(--s5)]" onSubmit={submit}>
          <label className="field" htmlFor="athlete-account-id">
            <span className="mb-[var(--s3)] block font-mono text-[length:var(--t-sm)] uppercase tracking-[0.14em] text-[color:var(--hide-800)]">
              Athlete Account ID
            </span>
            <input
              id="athlete-account-id"
              type="text"
              value={accountId}
              onChange={(event) => setAccountId(event.target.value)}
              autoComplete="username"
              className="input input--kiosk"
              placeholder="athlete-account-id"
            />
          </label>

          <label className="field" htmlFor="athlete-pin">
            <span className="mb-[var(--s3)] block font-mono text-[length:var(--t-sm)] uppercase tracking-[0.14em] text-[color:var(--hide-800)]">
              PIN
            </span>
            <input
              id="athlete-pin"
              type="password"
              inputMode="numeric"
              // The PIN is exactly DEFAULT_PIN_LENGTH digits, and the field now
              // says so instead of only the label above it: inputMode is a
              // keyboard hint, not a constraint, so this box accepted letters
              // and any length while the copy promised six digits.
              maxLength={DEFAULT_PIN_LENGTH}
              value={pin}
              onChange={(event) => setPin(event.target.value.replace(/\D/g, '').slice(0, DEFAULT_PIN_LENGTH))}
              autoComplete="current-password"
              className="input input--kiosk font-[family-name:var(--font-mono)] tracking-[0.4em]"
              placeholder={`${DEFAULT_PIN_LENGTH} digits`}
            />
          </label>

          {error && (
            /* Law 3 -- the glyph carries the state as well as the colour, so
               this still reads as a refusal in greyscale or to a colour-blind
               athlete. It was previously colour and copy alone. */
            <p
              role="alert"
              className="flex items-start gap-[var(--s3)] rounded-[var(--r-sm)] border-2 border-[color:var(--locked)] bg-[color-mix(in_srgb,var(--locked)_12%,var(--paper))] px-[var(--s4)] py-[var(--s4)] text-[length:var(--t-sm)] text-[color:var(--hide-950)]"
            >
              <span aria-hidden="true" className="font-bold text-[color:var(--locked)]">✕</span>
              <span>{error}</span>
            </p>
          )}

          <button type="submit" disabled={submitting} className="btn btn--kiosk disabled:cursor-not-allowed disabled:opacity-50">
            {submitting ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </div>
    </main>
  );
}
