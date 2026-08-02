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

type LoginMethod = 'microsoft' | 'pin';

function LoginPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [selectedMethod, setSelectedMethod] = useState<LoginMethod>('pin');
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

  return (
    <main className="min-h-screen bg-[var(--canvas-tan)] text-[var(--black)]">
      <div className="mx-auto grid min-h-screen w-full max-w-5xl place-items-center px-6 py-10 lg:px-10">
        <section className="w-full max-w-2xl overflow-hidden rounded-[28px] border border-[rgba(0,0,0,0.14)] bg-[var(--canvas-tan-light)] shadow-[var(--shadow-lg)]">
          <div className="border-b border-[rgba(0,0,0,0.14)] bg-[linear-gradient(135deg,var(--canvas-tan-dark),var(--canvas-tan-light))] px-8 py-8">
            <div className="flex items-center justify-between gap-3">
              <p className="text-[10px] font-mono uppercase tracking-[0.4em] text-[var(--gray-dark)]">Member Access</p>
              <Link
                href="/public"
                className="inline-flex min-h-[44px] items-center justify-center gap-3 rounded-full border border-[rgba(0,0,0,0.14)] bg-white px-3 text-[10px] font-mono font-bold uppercase tracking-[0.1em] text-[var(--black)] transition hover:bg-[var(--canvas-tan)]"
              >
                Public Page
              </Link>
            </div>
            <h1 className="mt-4 text-4xl font-black tracking-[0.1em] text-[var(--black)] md:text-5xl">The Bell</h1>
            <p className="mt-3 text-sm leading-relaxed text-[var(--gray-dark)]">
              Sign in with your Account ID and PIN, or continue with Microsoft. You will land on the right dashboard for your role.
            </p>
          </div>

          <div className="space-y-6 px-8 py-8">
            {/* Sign-in failures arrive as a full-page redirect, which resets the
                tab to PIN. While this banner lived inside the Microsoft panel a
                rejected user saw an empty PIN form and no reason at all. */}
            {authErrorMessage && (
              <div className="rounded-lg border border-[var(--safety-locked)] bg-[color-mix(in_srgb,var(--safety-locked)_8%,white)] p-3" role="alert">
                <p className="text-sm text-[var(--safety-locked)]">⚠️ {authErrorMessage}</p>
              </div>
            )}

            <div className="grid gap-3 rounded-[24px] border border-[rgba(0,0,0,0.14)] bg-[var(--canvas-tan-light)] p-6 shadow-[var(--shadow-md)]">
              <p className="mb-2 text-xs font-semibold uppercase tracking-[0.2em] text-[var(--black)]">Choose Sign-In Method</p>
              <div className="grid gap-3 sm:grid-cols-2">
                <button
                  type="button"
                  onClick={() => setSelectedMethod('microsoft')}
                  className={`relative rounded-xl border-2 p-4 transition ${
                    selectedMethod === 'microsoft'
                      ? 'border-[var(--accent)] bg-[color-mix(in_srgb,var(--accent)_10%,white)] shadow-[0_4px_12px_color-mix(in_srgb,var(--accent)_22%,transparent)]'
                      : 'border-[rgba(0,0,0,0.12)] bg-white hover:border-[rgba(0,0,0,0.2)]'
                  }`}
                >
                  <div className="flex items-start gap-3">
                    <span className="text-2xl">☁️</span>
                    <div className="flex-1 text-left">
                      <p className={`text-xs font-black uppercase tracking-[0.15em] ${selectedMethod === 'microsoft' ? 'text-[var(--accent-quiet)]' : 'text-[var(--gray-dark)]'}`}>
                        Microsoft
                      </p>
                      <p className="mt-1 text-[11px] leading-relaxed text-[var(--gray-medium)]">Sign in with your Microsoft account</p>
                    </div>
                    {selectedMethod === 'microsoft' && <span className="text-xl">✓</span>}
                  </div>
                </button>
                <button
                  type="button"
                  onClick={() => setSelectedMethod('pin')}
                  className={`relative rounded-xl border-2 p-4 transition ${
                    selectedMethod === 'pin'
                      ? 'border-[var(--accent)] bg-[color-mix(in_srgb,var(--accent)_10%,white)] shadow-[0_4px_12px_color-mix(in_srgb,var(--accent)_22%,transparent)]'
                      : 'border-[rgba(0,0,0,0.12)] bg-white hover:border-[rgba(0,0,0,0.2)]'
                  }`}
                >
                  <div className="flex items-start gap-3">
                    <span className="text-2xl">🔐</span>
                    <div className="flex-1 text-left">
                      <p className={`text-xs font-black uppercase tracking-[0.15em] ${selectedMethod === 'pin' ? 'text-[var(--accent-quiet)]' : 'text-[var(--gray-dark)]'}`}>
                        PIN
                      </p>
                      <p className="mt-1 text-[11px] leading-relaxed text-[var(--gray-medium)]">Sign in with Account ID and PIN</p>
                    </div>
                    {selectedMethod === 'pin' && <span className="text-xl">✓</span>}
                  </div>
                </button>
              </div>
            </div>

            {selectedMethod === 'microsoft' && (
              <div className="grid gap-4 rounded-[24px] border-2 border-[var(--gray-dark)] bg-white p-6 shadow-[var(--shadow-lg)]">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[var(--black)]">Microsoft Sign In</p>
                  <p className="mt-2 text-sm leading-relaxed text-[var(--gray-dark)]">
                    Click below to sign in securely with your Microsoft account. Your organization admin manages who can access the platform.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={microsoftSignIn}
                  className="inline-flex min-h-[52px] w-full items-center justify-center gap-3 rounded-xl border-2 border-[var(--gray-dark)] bg-[var(--gray-dark)] px-6 text-sm font-black uppercase tracking-[0.18em] text-white transition hover:bg-[var(--black)] hover:border-[var(--black)] active:scale-[0.98]"
                >
                  <span>☁️</span>
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
                className="grid gap-4 rounded-[24px] border-2 border-[var(--accent)] bg-white p-6 shadow-[var(--shadow-lg)]"
              >
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[var(--accent-quiet)]">Account PIN Sign In</p>
                  <p className="mt-2 text-sm leading-relaxed text-[var(--gray-dark)]">
                    Enter your Account ID and PIN. Ask your coach or admin if you do not have one.
                  </p>
                  <p className="mt-3 rounded-lg border border-[rgba(0,0,0,0.12)] bg-[var(--canvas-tan-light)] px-3 py-2 text-sm text-[var(--gray-dark)]">
                    First time here with an activation code?{' '}
                    <Link href="/activate" className="font-semibold text-[var(--accent-quiet)] underline">
                      Set up your account
                    </Link>
                  </p>
                </div>
                <div className="grid gap-3">
                  <div>
                    <label className="block text-xs font-semibold uppercase tracking-[0.25em] text-[var(--gray-dark)]" htmlFor="login-account-id">
                      Account ID
                    </label>
                    <input
                      id="login-account-id"
                      type="text"
                      value={loginAccountId}
                      onChange={(event) => setLoginAccountId(event.target.value)}
                      placeholder="account-001"
                      autoComplete="username"
                      className="mt-2 min-h-[48px] w-full rounded-xl border border-[rgba(0,0,0,0.14)] bg-white px-4 text-[var(--black)] outline-none transition placeholder:text-[var(--gray-medium)] focus-visible:border-[var(--accent)] focus-visible:shadow-[var(--focus)]"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold uppercase tracking-[0.25em] text-[var(--gray-dark)]" htmlFor="login-pin">
                      PIN (4+ digits)
                    </label>
                    <input
                      id="login-pin"
                      type="password"
                      inputMode="numeric"
                      value={loginPin}
                      onChange={(event) => setLoginPin(event.target.value)}
                      placeholder="••••"
                      autoComplete="current-password"
                      className="mt-2 min-h-[48px] w-full rounded-xl border border-[rgba(0,0,0,0.14)] bg-white px-4 text-[var(--black)] outline-none transition placeholder:text-[var(--gray-medium)] focus-visible:border-[var(--accent)] focus-visible:shadow-[var(--focus)]"
                    />
                  </div>
                  {loginError && (
                    <div className="rounded-lg border border-[var(--safety-locked)] bg-[color-mix(in_srgb,var(--safety-locked)_8%,white)] p-3" role="alert">
                      <p className="text-sm text-[var(--safety-locked)]">❌ {loginError}</p>
                    </div>
                  )}
                  <button
                    type="submit"
                    disabled={loginBusy || !loginAccountId.trim() || !loginPin.trim()}
                    /* The disabled state carries its own pair rather than
                       dimming the enabled one. The label is ink because it sits
                       on brass; the disabled fill is --gray-medium, and ink on
                       that is 1.68:1 -- an empty PIN field would have left the
                       button unreadable. Bone on the same fill is 7.3:1. */
                    className="inline-flex min-h-[52px] w-full items-center justify-center gap-2 rounded-xl border-2 border-[var(--accent-quiet)] bg-[var(--accent-strong)] px-6 text-sm font-black uppercase tracking-[0.18em] text-[var(--accent-ink)] transition hover:bg-[var(--brass-400)] hover:border-[var(--accent)] disabled:cursor-not-allowed disabled:border-[rgba(0,0,0,0.14)] disabled:bg-[var(--gray-medium)] disabled:text-[var(--bone-300)] active:scale-[0.98]"
                  >
                    {loginBusy ? (
                      <>
                        <span>⏳</span>
                        Signing In...
                      </>
                    ) : (
                      <>
                        <span>🔐</span>
                        Sign In
                      </>
                    )}
                  </button>
                </div>
              </form>
            )}

            <div className="rounded-[24px] border border-[rgba(0,0,0,0.14)] bg-[var(--canvas-tan-light)] p-6 shadow-[var(--shadow-sm)]">
              <div className="space-y-4">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[var(--accent-quiet)]">💡 Need Help?</p>
                  <p className="mt-2 text-sm leading-6 text-[var(--gray-dark)]">
                    If you do not have an Account ID or PIN, or if you have forgotten your PIN, contact your gym admin or coach. They can create a new account or reset your PIN.
                  </p>
                  <Link
                    href="/athlete/sign-in"
                    className="mt-3 inline-flex min-h-[44px] items-center rounded-lg border border-[var(--accent)] px-3 py-2 text-xs font-semibold uppercase tracking-[0.12em] text-[var(--accent-quiet)]"
                  >
                    Open Simple Athlete PIN Sign-In
                  </Link>
                </div>
                <AnnouncementBanner placement="gym_notices" source="public" heading="📢 Gym Notice" limit={3} />
              </div>
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={<main className="min-h-screen bg-[var(--canvas-tan)]" />}>
      <LoginPageContent />
    </Suspense>
  );
}
