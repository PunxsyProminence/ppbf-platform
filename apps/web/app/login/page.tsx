'use client';

import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import AnnouncementBanner from '@/components/AnnouncementBanner';
import { apiBase } from '@/lib/apiBase';
import {
  clearRoleSession,
  persistAuthoritativeRoleSession,
  loadAuthoritativeRoleSession,
} from '@/components/roleSession';
import { createMicrosoftSignInHandler } from '@/src/client/loginPageHelpers';
import { DEFAULT_PIN_LENGTH } from '@/src/server/pilot/pinPolicy';

type LoginMethod = 'microsoft' | 'pin';

function LoginPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  // Microsoft, not PIN. PIN sign-in admits only athletes -- credentialPolicy
  // says so and loginWithAccountIdAndPin enforces it -- and athletes have their
  // own door at /athlete/sign-in. Opening on the PIN tab meant every coach,
  // parent and staff member met a form that could not authenticate them, and a
  // refusal that blamed their credential instead of the door.
  const [selectedMethod, setSelectedMethod] = useState<LoginMethod>('microsoft');
  const [loginAccountId, setLoginAccountId] = useState('');
  const [loginPin, setLoginPin] = useState('');
  const [loginBusy, setLoginBusy] = useState(false);
  const [loginError, setLoginError] = useState('');

  const authErrorMessage = (() => {
    const error = searchParams.get('error');
    if (!error) {
      return '';
    }

    if (error === 'not-invited') {
      return 'This Microsoft account is not invited or not active.';
    }

    if (error === 'auth-state-expired') {
      return 'Your sign-in session expired or the browser blocked the login cookies. Please try again.';
    }

    if (error === 'auth-forbidden') {
      return 'This account signed in, but its role has no workspace yet. Ask your organization admin to finish setting it up.';
    }

    // RoleSessionGate emits these two; without a case they fell through to the
    // Microsoft message even when the user had signed in with a PIN.
    if (error === 'privileged_auth_required') {
      return 'That area requires a Microsoft sign-in. Please continue with Microsoft.';
    }

    if (error === 'unsupported_role') {
      return 'Your account role cannot open that area.';
    }

    return 'Microsoft sign-in failed. Please try again.';
  })();

  useEffect(() => {
    const params = new URLSearchParams(typeof window !== 'undefined' ? window.location.search : '');
    const shouldLogout = params.get('logout') === 'true' || params.get('reset') === 'true';

    if (shouldLogout) {
      clearRoleSession();
      void fetch(`${apiBase()}/api/pilot/auth/logout`, {
        method: 'POST',
        credentials: 'include',
      });
      return;
    }

    const controller = new AbortController();

    void (async () => {
      try {
        const resolution = await loadAuthoritativeRoleSession(
          `${apiBase()}/api/pilot/auth/session`,
          { signal: controller.signal },
        );
        if (controller.signal.aborted) {
          return;
        }

        if (!resolution.ok) {
          if (resolution.reason === 'pin_change_required') {
            router.replace('/change-pin');
            return;
          }
          if (resolution.reason !== 'server_error') {
            clearRoleSession();
          }
          return;
        }

        persistAuthoritativeRoleSession(resolution.session);
        router.replace(resolution.destination);
      } catch (error) {
        if (controller.signal.aborted || (error instanceof Error && error.name === 'AbortError')) {
          return;
        }
      }
    })();

    return () => controller.abort();
  }, [router]);

  async function loginWithPin() {
    const acctId = loginAccountId.trim();
    const pinCode = loginPin.trim();

    if (!acctId || !pinCode) {
      setLoginError('Account ID and PIN are required.');
      return;
    }

    // Caught here so a wrong-length PIN is named as a wrong length. The server
    // answers every failure with the same "Invalid account ID or PIN", and this
    // label used to read "4+ digits" -- so someone who followed it and entered
    // four was told their PIN was wrong, retried the same four, and hit the
    // rate limiter. The policy is exactly DEFAULT_PIN_LENGTH digits.
    if (!new RegExp(`^\\d{${DEFAULT_PIN_LENGTH}}$`).test(pinCode)) {
      setLoginError(`Your PIN is exactly ${DEFAULT_PIN_LENGTH} digits.`);
      return;
    }

    setLoginBusy(true);
    setLoginError('');

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);

      const response = await fetch(`${apiBase()}/api/pilot/auth/login`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          account_id: acctId,
          pin: pinCode,
        }),
        signal: controller.signal,
      });

      clearTimeout(timeout);

      const result = (await response.json().catch(() => ({ error: 'Login failed' }))) as {
        error?: string;
        role?: string;
        has_master_shadow_access?: boolean;
      };

      if (response.status === 429) {
        setLoginError('Too many login attempts. Please wait a few minutes before trying again.');
        return;
      }

      if (!response.ok || !result.role) {
        setLoginError(result.error || 'Invalid account ID or PIN. Please try again or contact an admin.');
        return;
      }

      const resolution = await loadAuthoritativeRoleSession(`${apiBase()}/api/pilot/auth/session`);
      if (!resolution.ok) {
        if (resolution.reason === 'pin_change_required') {
          router.replace('/change-pin');
          return;
        }
        if (resolution.reason !== 'server_error') {
          clearRoleSession();
        }
        setLoginError('The server session could not be verified. Please sign in again.');
        return;
      }

      persistAuthoritativeRoleSession(resolution.session);
      router.replace(resolution.destination);
    } catch (error) {
      if (error instanceof Error) {
        if (error.name === 'AbortError') {
          setLoginError('Login request timed out. Check your internet connection and try again.');
        } else {
          setLoginError('Network error. Check your connection and try again.');
        }
      } else {
        setLoginError('An unexpected error occurred. Please try again.');
      }
    } finally {
      setLoginBusy(false);
    }
  }

  const microsoftSignIn = createMicrosoftSignInHandler(apiBase());

  /* Law 1: a selected tab is a control in the "on" position — chassis state,
     not a claim about anybody. The chosen method wears brass; the other wears
     the ghost treatment. This is what the red used to do, and the red is the
     safety gate's colour (Law 2), so it cannot also mean "you tapped this". */
  const methodButton = (method: LoginMethod) =>
    `btn ${selectedMethod === method ? '' : 'btn--ghost'} w-full justify-start text-left`;

  return (
    /* Law 6, warm ground: this is the family-facing side of the platform —
       the same canvas Guardian Portal and Public Onboarding stand on, not the
       ink leather the staff consoles use. .on-canvas paints its own ground and
       restates every component that was tuned against leather, so it goes on
       the full-bleed wrapper rather than being scoped to children. */
    <main className="on-canvas min-h-screen">
      <div className="mx-auto w-full max-w-[840px] px-[var(--s5)] py-[var(--s7)]">
        <header className="mb-[var(--s6)] flex flex-wrap items-end justify-between gap-[var(--s4)]">
          <div>
            <div className="t-eyebrow">Member Access</div>
            <h1 className="t-painted mt-[var(--s3)]" style={{ fontSize: 'var(--t-2xl)' }}>
              The Bell
            </h1>
            <p className="t-body mt-[var(--s4)] max-w-[52ch]">
              Sign in with Account ID/PIN or Microsoft. You will land on the right dashboard for your role.
            </p>
          </div>
          <Link href="/public" className="btn btn--ghost">
            Public Page
          </Link>
        </header>

        <div className="frame">
          <span className="rivet rivet--tl" />
          <span className="rivet rivet--tr" />
          <span className="rivet rivet--bl" />
          <span className="rivet rivet--br" />
          <div className="frame-in mat-paper" style={{ padding: 'var(--s6)' }}>
            {/* Sign-in failures arrive as a full-page redirect, which resets the
                tab to PIN. While this banner lived inside the Microsoft panel a
                rejected user saw an empty PIN form and no reason at all. */}
            {/* Law 3: the glyph and the uppercase label carry the state, so a
                refusal still reads in greyscale and to a colour-blind user —
                the red is the third channel, never the only one. This replaces
                an emoji, which is neither a system glyph nor legible at 11px. */}
            {authErrorMessage && (
              <div
                className="mb-[var(--s5)] rounded-[var(--r-md)] border-2 border-[color:var(--locked)] bg-[rgba(168,30,34,0.06)] p-[var(--s4)]"
                role="alert"
              >
                <span className="badge badge--locked">
                  <i>✕</i>Sign-in refused
                </span>
                <p className="t-body mt-[var(--s3)]">{authErrorMessage}</p>
              </div>
            )}

            <fieldset className="mb-[var(--s6)] border-0 p-0">
              <legend className="t-label mb-[var(--s4)]">Choose Sign-In Method</legend>
              <div className="grid gap-[var(--s4)] sm:grid-cols-2">
                <button
                  type="button"
                  onClick={() => setSelectedMethod('microsoft')}
                  aria-pressed={selectedMethod === 'microsoft'}
                  className={methodButton('microsoft')}
                >
                  {selectedMethod === 'microsoft' ? '✓ ' : ''}Microsoft
                </button>
                <button
                  type="button"
                  onClick={() => setSelectedMethod('pin')}
                  aria-pressed={selectedMethod === 'pin'}
                  className={methodButton('pin')}
                >
                  {selectedMethod === 'pin' ? '✓ ' : ''}Account ID / PIN
                </button>
              </div>
            </fieldset>

            {selectedMethod === 'microsoft' && (
              <div className="grid gap-[var(--s5)]">
                <div>
                  <h2 className="t-command" style={{ fontSize: 'var(--t-lg)' }}>
                    Microsoft Sign In
                  </h2>
                  <p className="t-body mt-[var(--s3)]">
                    Continue below to sign in securely with your Microsoft account. Your organization admin manages who can access the platform.
                  </p>
                </div>
                <button type="button" onClick={microsoftSignIn} className="btn btn--kiosk">
                  Continue With Microsoft
                </button>
              </div>
            )}

            {selectedMethod === 'pin' && (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void loginWithPin();
                }}
                className="grid gap-[var(--s5)]"
              >
                <div>
                  <h2 className="t-command" style={{ fontSize: 'var(--t-lg)' }}>
                    Account PIN Sign In
                  </h2>
                  <p className="t-body mt-[var(--s3)]">
                    Enter your Account ID and PIN. Ask your coach or admin if you do not have one.
                  </p>
                  <p className="t-body mt-[var(--s4)] rounded-[var(--r-sm)] border border-[rgba(0,0,0,0.14)] bg-[var(--paper-2)] px-[var(--s4)] py-[var(--s3)]">
                    First time here with an activation code?{' '}
                    <Link href="/activate" className="font-semibold text-[color:var(--brass-800)] underline">
                      Set up your account
                    </Link>
                  </p>
                </div>
                <div className="grid gap-[var(--s4)]">
                  {/* Law 5: --tap and --t-md are the gym-floor floor. An athlete
                      signs in on a shared tablet with sweaty hands, so the PIN
                      pair gets kiosk sizing even though the desk could go
                      smaller — the old 48px/16px pair cleared neither. */}
                  <div className="field">
                    <label className="t-label" htmlFor="login-account-id">
                      Account ID
                    </label>
                    <input
                      id="login-account-id"
                      type="text"
                      value={loginAccountId}
                      onChange={(event) => setLoginAccountId(event.target.value)}
                      placeholder="account-001"
                      autoComplete="username"
                      className="input input--kiosk"
                    />
                  </div>
                  <div className="field">
                    <label className="t-label" htmlFor="login-pin">
                      PIN ({DEFAULT_PIN_LENGTH} digits)
                    </label>
                    <input
                      id="login-pin"
                      type="password"
                      inputMode="numeric"
                      value={loginPin}
                      // Non-digits dropped and the value capped, so the field
                      // cannot hold something the policy will reject. The old
                      // field took any length and any character, and the server
                      // refused it with a message about the wrong thing.
                      onChange={(event) =>
                        setLoginPin(event.target.value.replace(/\D/g, '').slice(0, DEFAULT_PIN_LENGTH))
                      }
                      maxLength={DEFAULT_PIN_LENGTH}
                      placeholder={'•'.repeat(DEFAULT_PIN_LENGTH)}
                      autoComplete="current-password"
                      className="input input--kiosk"
                    />
                  </div>
                  {loginError && (
                    <div
                      className="rounded-[var(--r-md)] border-2 border-[color:var(--locked)] bg-[rgba(168,30,34,0.06)] p-[var(--s4)]"
                      role="alert"
                    >
                      <span className="badge badge--locked">
                        <i>✕</i>Sign-in refused
                      </span>
                      <p className="t-body mt-[var(--s3)]">{loginError}</p>
                    </div>
                  )}
                  <button
                    type="submit"
                    disabled={loginBusy || !loginAccountId.trim() || !loginPin.trim()}
                    /* A brass face at reduced opacity still reads as a live
                       control. Desaturating it too drops it off the chassis
                       entirely, which is what "not yet" should look like. */
                    className="btn btn--kiosk disabled:cursor-not-allowed disabled:opacity-60 disabled:grayscale"
                  >
                    {loginBusy ? 'Signing In…' : 'Sign In'}
                  </button>
                </div>
              </form>
            )}

          </div>
        </div>

        {/* Help and gym notices sit outside the frame: the framed paper is the
            thing you fill in, and this is what's tacked up next to it. */}
        <section className="mt-[var(--s6)] grid gap-[var(--s5)] md:grid-cols-[var(--split-major)_var(--split-minor)]">
          <div>
            <h2 className="t-command" style={{ fontSize: 'var(--t-md)' }}>
              Need Help?
            </h2>
            <p className="t-body mt-[var(--s3)] max-w-[54ch]">
              If you do not have an Account ID or PIN, or if you have forgotten your PIN, contact your gym admin or
              coach. They can create a new account or reset your PIN.
            </p>
            <Link href="/athlete/sign-in" className="btn btn--ghost mt-[var(--s4)]">
              Open Simple Athlete PIN Sign-In
            </Link>
          </div>
          <div>
            <h2 className="t-label mb-[var(--s3)]">Gym Notice</h2>
            <AnnouncementBanner placement="gym_notices" source="public" limit={3} />
          </div>
        </section>
      </div>
    </main>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={<main className="on-canvas min-h-screen" />}>
      <LoginPageContent />
    </Suspense>
  );
}
