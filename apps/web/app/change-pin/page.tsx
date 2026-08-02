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
      <main className="grid min-h-screen place-items-center bg-[var(--canvas-tan)] px-6 text-[var(--black)]">
        <div className="max-w-md space-y-3 text-center">
          <h1 className="font-display text-3xl font-black">PIN updated</h1>
          <p className="text-sm leading-6 text-[var(--gray-dark)]">
            Sign in again with your new PIN. Taking you to the sign-in page...
          </p>
        </div>
      </main>
    );
  }

  return (
    <main className="grid min-h-screen place-items-center bg-[var(--canvas-tan)] px-4 py-8 text-[var(--black)]">
      <div className="w-full max-w-md space-y-5">
        <header className="rounded-2xl border border-[rgba(0,0,0,0.16)] bg-white p-6 shadow-[var(--shadow-md)]">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[var(--accent-quiet)]">First sign-in</p>
          <h1 className="mt-2 font-display text-3xl font-black tracking-tight">Choose your PIN</h1>
          <p className="mt-2 text-sm leading-6 text-[var(--gray-dark)]">
            You are signed in with the starting PIN your gym gave you. Everyone gets the same one, so pick your own
            before you go any further. Nobody at the gym can see what you choose.
          </p>
        </header>

        <form onSubmit={submit} className="space-y-4 rounded-2xl border border-[rgba(0,0,0,0.14)] bg-white p-6 shadow-[var(--shadow-sm)]">
          {error && (
            <p role="alert" className="flex items-start gap-2 rounded-xl border border-[var(--safety-locked)] bg-[color-mix(in_srgb,var(--safety-locked)_8%,white)] px-4 py-3 text-sm font-semibold text-[var(--safety-locked)]">
              <span aria-hidden="true">✕</span>
              <span>{error}</span>
            </p>
          )}

          <div>
            <label htmlFor="current-pin" className="block text-sm font-semibold">
              The PIN you were given
            </label>
            <input
              id="current-pin"
              type="password"
              inputMode="numeric"
              autoComplete="current-password"
              required
              value={currentPin}
              maxLength={DEFAULT_PIN_LENGTH}
              onChange={(event) => setCurrentPin(event.target.value.replace(/\D/g, '').slice(0, DEFAULT_PIN_LENGTH))}
              className="mt-2 min-h-[48px] w-full rounded-xl border border-[rgba(0,0,0,0.16)] px-3 font-mono tracking-[0.3em] focus-visible:border-[var(--accent)] focus-visible:outline-none focus-visible:shadow-[var(--focus)]"
            />
          </div>

          <div>
            <label htmlFor="new-pin" className="block text-sm font-semibold">
              Your new PIN
            </label>
            <p className="mt-1 text-xs text-[var(--gray-dark)]">Exactly 6 digits. Do not use 123456.</p>
            <input
              id="new-pin"
              type="password"
              inputMode="numeric"
              autoComplete="new-password"
              required
              value={newPin}
              maxLength={DEFAULT_PIN_LENGTH}
              onChange={(event) => setNewPin(event.target.value.replace(/\D/g, '').slice(0, DEFAULT_PIN_LENGTH))}
              className="mt-2 min-h-[48px] w-full rounded-xl border border-[rgba(0,0,0,0.16)] px-3 font-mono tracking-[0.3em] focus-visible:border-[var(--accent)] focus-visible:outline-none focus-visible:shadow-[var(--focus)]"
            />
          </div>

          <div>
            <label htmlFor="confirm-pin" className="block text-sm font-semibold">
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
              className="mt-2 min-h-[48px] w-full rounded-xl border border-[rgba(0,0,0,0.16)] px-3 font-mono tracking-[0.3em] focus-visible:border-[var(--accent)] focus-visible:outline-none focus-visible:shadow-[var(--focus)]"
            />
          </div>

          <button
            type="submit"
            disabled={busy || !currentPin || !newPin || !confirmPin}
            className="min-h-[50px] w-full rounded-xl border-2 border-[var(--accent-quiet)] bg-[var(--accent-strong)] px-4 text-sm font-black uppercase tracking-[0.14em] text-[var(--accent-ink)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? 'Saving...' : 'Save My PIN'}
          </button>
        </form>
      </div>
    </main>
  );
}
