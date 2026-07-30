'use client';

import { Suspense, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

import { apiBase } from '@/lib/apiBase';
import { DEFAULT_PIN_LENGTH } from '@/src/server/pilot/pinPolicy';

// Single source of truth with the server policy: validatePinPolicy enforces
// this exact length, so a local copy could silently disagree with it.
const PIN_LENGTH = DEFAULT_PIN_LENGTH;
const CODE_LENGTH = 12;
const PIN_PATTERN = /^\d{6}$/;

type Stage = 'code' | 'pin' | 'done';

/**
 * Formats a partially-typed code into the XXXX-XXXX-XXXX shape shown on the
 * printed slip, so what the athlete sees on screen matches what they are
 * reading from. Dashes are cosmetic -- the server canonicalizes them away.
 */
function formatCodeInput(raw: string): string {
  const stripped = raw.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, CODE_LENGTH);
  const groups: string[] = [];
  for (let index = 0; index < stripped.length; index += 4) {
    groups.push(stripped.slice(index, index + 4));
  }
  return groups.join('-');
}

function countCodeCharacters(formatted: string): number {
  return formatted.replace(/-/g, '').length;
}

function ActivatePageContent() {
  const router = useRouter();

  const [stage, setStage] = useState<Stage>('code');
  const [code, setCode] = useState('');
  const [pin, setPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [accountId, setAccountId] = useState('');
  const [signedIn, setSignedIn] = useState(false);

  // The activation code is deliberately NOT accepted from the query string.
  // A one-time credential in a URL leaks into browser and proxy history,
  // Referer headers, and access logs, and is trivially forwarded to someone
  // else. Nothing in the app generates such a link: admin/people copies a bare
  // /activate URL and the code travels separately on the athlete's slip, so
  // requiring it to be entered here costs nothing and closes that exposure.

  const codeComplete = countCodeCharacters(code) === CODE_LENGTH;
  const pinValid = PIN_PATTERN.test(pin);
  const pinsMatch = pin === confirmPin;

  function goToPinStage(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');

    if (!codeComplete) {
      setError(`Your code is ${CODE_LENGTH} characters. Check the slip and try again.`);
      return;
    }

    setStage('pin');
  }

  async function submitActivation(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');

    if (!pinValid) {
      setError(`Your PIN must be exactly ${PIN_LENGTH} numbers.`);
      return;
    }

    if (!pinsMatch) {
      setError('The two PINs do not match.');
      return;
    }

    setSubmitting(true);
    try {
      const response = await fetch(`${apiBase()}/api/pilot/auth/activate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ code, pin }),
      });

      const payload = (await response.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        account_id?: string;
        signed_in?: boolean;
      };

      if (!response.ok || !payload.ok) {
        // A rejected PIN is correctable in place; a rejected code means the
        // athlete has to start over with a different slip.
        const message = payload.error || 'We could not activate your account.';
        if (!message.startsWith('PIN')) {
          setStage('code');
          setPin('');
          setConfirmPin('');
        }
        throw new Error(message);
      }

      setAccountId(payload.account_id || '');
      setSignedIn(Boolean(payload.signed_in));
      setStage('done');

      if (payload.signed_in) {
        router.refresh();
      }
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : 'We could not activate your account.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="min-h-screen bg-[var(--canvas-tan)] px-4 py-10 text-[var(--black)] sm:px-6">
      <div className="mx-auto w-full max-w-md space-y-6">
        <header className="space-y-3 text-center">
          <p className="text-xs font-mono uppercase tracking-[0.3em] text-[var(--red-primary)]">Set Up Your Account</p>
          <h1 className="font-display text-3xl font-black tracking-tight">Activate Your PPBF Account</h1>
          {stage !== 'done' && (
            <p className="text-sm leading-6 text-[var(--gray-dark)]">
              Your gym gave you a one-time code. Enter it, then choose a {PIN_LENGTH}-digit PIN only you know.
            </p>
          )}
        </header>

        {stage !== 'done' && (
          <ol className="flex items-center justify-center gap-3 text-xs font-semibold uppercase tracking-[0.12em]">
            <li className={stage === 'code' ? 'text-[var(--red-primary)]' : 'text-[var(--gray-dark)]'}>
              1. Your code
            </li>
            <li aria-hidden="true" className="text-[var(--gray-dark)]">→</li>
            <li className={stage === 'pin' ? 'text-[var(--red-primary)]' : 'text-[var(--gray-dark)]'}>
              2. Your PIN
            </li>
          </ol>
        )}

        {error && (
          <p
            role="alert"
            className="rounded-xl border border-[var(--red-primary)] bg-[rgba(184,59,52,0.06)] px-4 py-3 text-sm font-semibold text-[var(--red-primary)]"
          >
            {error}
          </p>
        )}

        {stage === 'code' && (
          <form
            onSubmit={goToPinStage}
            className="space-y-4 rounded-2xl border border-[rgba(0,0,0,0.14)] bg-white p-5 shadow-[var(--shadow-md)]"
          >
            <div>
              <label htmlFor="activation-code" className="block text-sm font-semibold">
                Activation code
              </label>
              <p className="mt-1 text-xs text-[var(--gray-dark)]">
                12 characters, like ABCD-2345-EFGH. Capital letters and numbers only.
              </p>
              <input
                id="activation-code"
                type="text"
                inputMode="text"
                autoCapitalize="characters"
                autoComplete="one-time-code"
                spellCheck={false}
                value={code}
                onChange={(event) => setCode(formatCodeInput(event.target.value))}
                placeholder="ABCD-2345-EFGH"
                className="mt-2 min-h-[52px] w-full rounded-xl border border-[rgba(0,0,0,0.16)] bg-white px-3 text-center font-mono text-lg tracking-[0.15em] focus:border-[var(--red-primary)] focus:outline-none focus:ring-2 focus:ring-[rgba(184,59,52,0.2)]"
              />
              <p className="mt-2 text-right text-xs text-[var(--gray-dark)]">
                {countCodeCharacters(code)} / {CODE_LENGTH}
              </p>
            </div>

            <button
              type="submit"
              disabled={!codeComplete}
              className="min-h-[52px] w-full rounded-xl border-2 border-[var(--red-primary)] bg-[var(--red-primary)] px-4 text-sm font-black uppercase tracking-[0.14em] text-white transition hover:bg-[var(--red-highlight)] disabled:cursor-not-allowed disabled:opacity-50"
            >
              Continue
            </button>
          </form>
        )}

        {stage === 'pin' && (
          <form
            onSubmit={submitActivation}
            className="space-y-4 rounded-2xl border border-[rgba(0,0,0,0.14)] bg-white p-5 shadow-[var(--shadow-md)]"
          >
            <div className="rounded-xl border border-[rgba(0,0,0,0.1)] bg-[var(--canvas-tan-light)] px-3 py-2">
              <p className="text-xs text-[var(--gray-dark)]">
                Code <span className="font-mono font-semibold text-[var(--black)]">{code}</span>
              </p>
            </div>

            <div>
              <label htmlFor="new-pin" className="block text-sm font-semibold">
                Choose your PIN
              </label>
              <p className="mt-1 text-xs text-[var(--gray-dark)]">
                {PIN_LENGTH} numbers. Do not use your birthday. Nobody at the gym can see this.
              </p>
              <input
                id="new-pin"
                type="password"
                inputMode="numeric"
                autoComplete="new-password"
                value={pin}
                onChange={(event) => setPin(event.target.value.replace(/\D/g, '').slice(0, PIN_LENGTH))}
                placeholder="••••••"
                className="mt-2 min-h-[52px] w-full rounded-xl border border-[rgba(0,0,0,0.16)] px-3 text-center font-mono text-lg tracking-[0.35em] focus:border-[var(--red-primary)] focus:outline-none focus:ring-2 focus:ring-[rgba(184,59,52,0.2)]"
              />
            </div>

            <div>
              <label htmlFor="confirm-pin" className="block text-sm font-semibold">
                Type it again
              </label>
              <input
                id="confirm-pin"
                type="password"
                inputMode="numeric"
                autoComplete="new-password"
                value={confirmPin}
                onChange={(event) => setConfirmPin(event.target.value.replace(/\D/g, '').slice(0, PIN_LENGTH))}
                placeholder="••••••"
                className="mt-2 min-h-[52px] w-full rounded-xl border border-[rgba(0,0,0,0.16)] px-3 text-center font-mono text-lg tracking-[0.35em] focus:border-[var(--red-primary)] focus:outline-none focus:ring-2 focus:ring-[rgba(184,59,52,0.2)]"
              />
              {confirmPin.length > 0 && !pinsMatch && (
                <p className="mt-2 text-xs font-semibold text-[var(--red-primary)]">These do not match yet.</p>
              )}
            </div>

            <button
              type="submit"
              disabled={submitting || !pinValid || !pinsMatch}
              className="min-h-[52px] w-full rounded-xl border-2 border-[var(--red-primary)] bg-[var(--red-primary)] px-4 text-sm font-black uppercase tracking-[0.14em] text-white transition hover:bg-[var(--red-highlight)] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {submitting ? 'Activating...' : 'Activate My Account'}
            </button>

            <button
              type="button"
              onClick={() => {
                setStage('code');
                setError('');
              }}
              className="min-h-[44px] w-full text-sm font-semibold text-[var(--gray-dark)] underline"
            >
              Back to my code
            </button>
          </form>
        )}

        {stage === 'done' && (
          <section className="space-y-5 rounded-2xl border-2 border-[#4caf50] bg-[rgba(76,175,80,0.06)] p-6 text-center">
            <p className="text-4xl" aria-hidden="true">✓</p>
            <h2 className="font-display text-2xl font-black">You&apos;re all set</h2>

            {accountId && (
              <div className="rounded-xl border border-[rgba(0,0,0,0.12)] bg-white px-4 py-3">
                <p className="text-xs uppercase tracking-[0.14em] text-[var(--gray-dark)]">Your sign-in ID</p>
                <p className="mt-1 font-mono text-base font-bold break-all">{accountId}</p>
                <p className="mt-2 text-xs text-[var(--gray-dark)]">
                  Write this down. You will need it with your PIN every time you sign in.
                </p>
              </div>
            )}

            {signedIn ? (
              <>
                <p className="text-sm leading-6 text-[var(--gray-dark)]">You are already signed in.</p>
                <Link
                  href="/athlete/dashboard"
                  className="inline-flex min-h-[52px] w-full items-center justify-center rounded-xl border-2 border-[var(--red-primary)] bg-[var(--red-primary)] px-6 text-sm font-black uppercase tracking-[0.14em] text-white transition hover:bg-[var(--red-highlight)]"
                >
                  Go To My Dashboard
                </Link>
              </>
            ) : (
              <>
                <p className="text-sm leading-6 text-[var(--gray-dark)]">
                  Your PIN is set. Sign in with your ID and your new PIN.
                </p>
                <Link
                  href="/login"
                  className="inline-flex min-h-[52px] w-full items-center justify-center rounded-xl border-2 border-[var(--red-primary)] bg-[var(--red-primary)] px-6 text-sm font-black uppercase tracking-[0.14em] text-white transition hover:bg-[var(--red-highlight)]"
                >
                  Go To Sign In
                </Link>
              </>
            )}
          </section>
        )}

        {stage !== 'done' && (
          <p className="text-center text-xs leading-6 text-[var(--gray-dark)]">
            Lost your code or it stopped working? Ask your gym admin for a new one.{' '}
            <Link href="/login" className="font-semibold underline">
              Already activated? Sign in
            </Link>
          </p>
        )}
      </div>
    </main>
  );
}

export default function ActivatePage() {
  // Suspense boundary kept for static rendering of this client page.
  return (
    <Suspense fallback={null}>
      <ActivatePageContent />
    </Suspense>
  );
}
