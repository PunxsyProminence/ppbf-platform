'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

import { apiBase } from '@/lib/apiBase';
import { DEFAULT_PIN_LENGTH } from '@/src/server/pilot/pinPolicy';

const PIN_PATTERN = /^\d{6}$/;

/**
 * Where an athlete lands on their first sign-in, still holding the starting
 * PIN the gym gave them. The server refuses every other route until this is
 * done (see requirePrincipal), so there is deliberately no way to skip it and
 * no navigation off this page other than completing it or signing out.
 */
export default function ChangePinPage() {
  const router = useRouter();
  const [currentPin, setCurrentPin] = useState('');
  const [newPin, setNewPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');

    if (!PIN_PATTERN.test(newPin)) {
      setError('Your new PIN must be exactly 6 digits.');
      return;
    }
    if (newPin !== confirmPin) {
      setError('The two new PINs do not match.');
      return;
    }
    if (newPin === currentPin) {
      setError('Your new PIN must be different from the one you were given.');
      return;
    }

    setBusy(true);
    try {
      const response = await fetch(`${apiBase()}/api/pilot/auth/change-pin`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ current_pin: currentPin, new_pin: newPin }),
      });
      const payload = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string };

      if (!response.ok || !payload.ok) {
        throw new Error(payload.error || 'Could not change your PIN');
      }

      // The server revoked every session for this account, including this
      // one, so there is nothing to navigate to while signed in.
      setDone(true);
      setTimeout(() => router.push('/login'), 1800);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : 'Could not change your PIN');
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      /* Ink ground (Law 6): change-pin is part of the sign-in chassis, same
         ground as /login's map row. Paper carries the message inside it. */
      <main className="grid min-h-screen place-items-center bg-[var(--hide-950)] px-[var(--s5)] text-[color:var(--bone-200)]">
        <div className="mat-leather w-full max-w-md rounded-[var(--r-lg)] border border-[color:rgba(212,175,74,.22)] p-[var(--s6)] text-center">
          {/* Law 3: the confirmation carries its glyph and uppercase label. */}
          <span className="badge badge--cleared">
            <i>✓</i>PIN updated
          </span>
          <h1 className="t-command mt-[var(--s4)]" style={{ fontSize: 'var(--t-xl)' }}>
            PIN updated
          </h1>
          <p className="t-body mt-[var(--s4)]">
            Sign in again with your new PIN. Taking you to the sign-in page...
          </p>
        </div>
      </main>
    );
  }

  return (
    <main className="grid min-h-screen place-items-center bg-[var(--hide-950)] px-[var(--s4)] py-[var(--s6)] text-[color:var(--bone-200)]">
      <div className="w-full max-w-md">
        <div className="frame">
          <span className="rivet rivet--tl" />
          <span className="rivet rivet--tr" />
          <span className="rivet rivet--bl" />
          <span className="rivet rivet--br" />
          {/* Leather rather than paper inside the frame: the ink-tuned .t-label,
              .t-eyebrow and .input read correctly against it, while .mat-paper
              only gets its type restated under .on-canvas — a ground this
              staff-side page must not take (Law 6). */}
          <div className="frame-in mat-leather" style={{ padding: 'var(--s6)' }}>
            <header>
              <p className="t-eyebrow tracking-[0.2em]">First sign-in</p>
              <h1 className="t-command mt-[var(--s3)]" style={{ fontSize: 'var(--t-xl)' }}>
                Choose your PIN
              </h1>
              <p className="t-body mt-[var(--s3)]">
                You are signed in with the starting PIN your gym gave you. Everyone gets the same one, so pick your own
                before you go any further. Nobody at the gym can see what you choose.
              </p>
            </header>

            <form onSubmit={submit} className="mt-[var(--s5)] space-y-[var(--s5)]">
              {error && (
                /* Law 3: glyph + uppercase label carry the refusal, so it
                   survives greyscale; the red is the third channel. */
                <div role="alert" className="alert alert--critical alert--tight">
                  <span className="alert-icon" aria-hidden="true">✕</span>
                  <div className="alert-body">
                    <p className="alert-title">PIN refused</p>
                    <p className="alert-msg">{error}</p>
                  </div>
                </div>
              )}

              <div className="field">
                <label htmlFor="current-pin" className="t-label">
                  The PIN you were given
                </label>
                {/* Law 5: an athlete does this on a shared tablet with wrapped
                    hands, so every PIN well clears --tap via the kiosk input. */}
                <input
                  id="current-pin"
                  type="password"
                  inputMode="numeric"
                  autoComplete="current-password"
                  required
                  value={currentPin}
                  maxLength={DEFAULT_PIN_LENGTH}
                  onChange={(event) => setCurrentPin(event.target.value.replace(/\D/g, '').slice(0, DEFAULT_PIN_LENGTH))}
                  className="input input--kiosk font-[family-name:var(--font-mono)] tracking-[0.3em]"
                />
              </div>

              <div className="field">
                <label htmlFor="new-pin" className="t-label">
                  Your new PIN
                </label>
                <p className="t-muted mb-[var(--s3)]">Exactly 6 digits. Do not use 123456.</p>
                <input
                  id="new-pin"
                  type="password"
                  inputMode="numeric"
                  autoComplete="new-password"
                  required
                  value={newPin}
                  maxLength={DEFAULT_PIN_LENGTH}
                  onChange={(event) => setNewPin(event.target.value.replace(/\D/g, '').slice(0, DEFAULT_PIN_LENGTH))}
                  className="input input--kiosk font-[family-name:var(--font-mono)] tracking-[0.3em]"
                />
              </div>

              <div className="field">
                <label htmlFor="confirm-pin" className="t-label">
                  Type your new PIN again
                </label>
                <input
                  id="confirm-pin"
                  type="password"
                  inputMode="numeric"
                  autoComplete="new-password"
                  required
                  value={confirmPin}
                  maxLength={DEFAULT_PIN_LENGTH}
                  onChange={(event) => setConfirmPin(event.target.value.replace(/\D/g, '').slice(0, DEFAULT_PIN_LENGTH))}
                  className="input input--kiosk font-[family-name:var(--font-mono)] tracking-[0.3em]"
                />
              </div>

              <button
                type="submit"
                disabled={busy || !currentPin || !newPin || !confirmPin}
                className="btn btn--kiosk disabled:cursor-not-allowed disabled:opacity-60 disabled:grayscale"
              >
                {busy ? 'Saving...' : 'Save My PIN'}
              </button>
            </form>
          </div>
        </div>
      </div>
    </main>
  );
}
