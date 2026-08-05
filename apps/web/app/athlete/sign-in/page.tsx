'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

import {
  createPersistentRoleSession,
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
      if (!resolution.ok || resolution.session.role !== 'athlete') {
        throw new Error('The athlete session could not be verified. Please sign in again.');
      }

      createPersistentRoleSession(resolution.session.role);
      router.replace(resolution.destination);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : 'Sign in failed.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="grid min-h-screen place-items-center bg-[var(--canvas-tan)] px-4 py-8 text-[var(--black)]">
      <div className="w-full max-w-md border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] p-6 shadow-[var(--shadow-md)]">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[var(--red-primary)]">Athlete Sign In</p>
        <h1 className="mt-2 text-2xl font-black tracking-tight">PIN Login</h1>
        <p className="mt-2 text-sm text-[var(--gray-dark)]">Use your athlete Account ID and 6-digit PIN.</p>

        <form className="mt-5 space-y-4" onSubmit={submit}>
          <div>
            <label htmlFor="athlete-account-id" className="block text-xs font-semibold uppercase tracking-[0.15em] text-[var(--gray-dark)]">
              Athlete Account ID
            </label>
            <input
              id="athlete-account-id"
              type="text"
              value={accountId}
              onChange={(event) => setAccountId(event.target.value)}
              autoComplete="username"
              className="mt-1 min-h-[48px] w-full border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] px-3"
              placeholder="athlete-account-id"
            />
          </div>

          <div>
            <label htmlFor="athlete-pin" className="block text-xs font-semibold uppercase tracking-[0.15em] text-[var(--gray-dark)]">
              PIN
            </label>
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
              className="mt-1 min-h-[48px] w-full border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] px-3 font-[family-name:var(--font-mono)] tracking-[0.4em]"
              placeholder={`${DEFAULT_PIN_LENGTH} digits`}
            />
          </div>

          {error && (
            <p className="tactical-alert-critical text-sm" role="alert">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={submitting}
            className="min-h-[50px] w-full border-2 border-[var(--red-primary)] bg-[var(--red-primary)] px-4 text-sm font-black uppercase tracking-[0.16em] text-white disabled:cursor-not-allowed disabled:opacity-50"
          >
            {submitting ? 'Signing in...' : 'Sign In'}
          </button>
        </form>
      </div>
    </main>
  );
}
