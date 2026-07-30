'use client';

import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { type ClubRole } from '@/components/roleRoutes';
import { apiBase } from '@/lib/apiBase';
import {
  clearRoleSession,
  createPersistentRoleSession,
  loadAuthoritativeRoleSession,
} from '@/components/roleSession';
import { createMicrosoftSignInHandler } from '@/src/client/loginPageHelpers';
import { useThemeOptional } from '@/components/ThemeProvider';

interface LoginAnnouncement {
  id: string;
  message: string;
  authorName: string;
  authorRole: ClubRole | 'system' | string;
  createdAt: string;
}

const DEFAULT_ANNOUNCEMENT: LoginAnnouncement = {
  id: 'system-default',
  message: 'Welcome to PPBF. Check in with your coach before floor activity. Safety first. Kids first.',
  authorName: 'System',
  authorRole: 'system',
  createdAt: 'Operational Baseline',
};

function formatAnnouncementTime(value: string): string {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    return value;
  }
  try {
    return new Date(parsed).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return value;
  }
}

type LoginMethod = 'microsoft' | 'pin';

function LoginPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { isRetro } = useThemeOptional();
  const [selectedMethod, setSelectedMethod] = useState<LoginMethod>('pin');
  const [loginAccountId, setLoginAccountId] = useState('');
  const [loginPin, setLoginPin] = useState('');
  const [loginBusy, setLoginBusy] = useState(false);
  const [loginError, setLoginError] = useState('');
  const [gymNotices, setGymNotices] = useState<LoginAnnouncement[]>([DEFAULT_ANNOUNCEMENT]);
  const [noticesLoading, setNoticesLoading] = useState(true);

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
      return 'This Microsoft account is not allowed to sign in as platform owner.';
    }

    return 'Microsoft sign-in failed. Please try again.';
  })();

  useEffect(() => {
    const controller = new AbortController();

    void (async () => {
      try {
        const response = await fetch(`${apiBase()}/api/pilot/announcements/public?limit=3`, {
          method: 'GET',
          credentials: 'include',
          signal: controller.signal,
        });

        if (!response.ok) {
          setGymNotices([DEFAULT_ANNOUNCEMENT]);
          return;
        }

        const payload = (await response.json()) as {
          ok?: boolean;
          announcements?: Array<{
            announcement_id: string;
            message: string;
            author_name: string;
            author_role: string;
            created_at: string;
          }>;
        };

        const rows = payload.announcements ?? [];
        if (!payload.ok || rows.length === 0) {
          setGymNotices([DEFAULT_ANNOUNCEMENT]);
          return;
        }

        setGymNotices(
          rows.map((row) => ({
            id: row.announcement_id,
            message: row.message,
            authorName: row.author_name,
            authorRole: row.author_role,
            createdAt: formatAnnouncementTime(row.created_at),
          })),
        );
      } catch (error) {
        if (controller.signal.aborted || (error instanceof Error && error.name === 'AbortError')) {
          return;
        }
        setGymNotices([DEFAULT_ANNOUNCEMENT]);
      } finally {
        if (!controller.signal.aborted) {
          setNoticesLoading(false);
        }
      }
    })();

    return () => controller.abort();
  }, []);

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

        createPersistentRoleSession(resolution.session.role);
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

      createPersistentRoleSession(resolution.session.role);
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

  if (isRetro) {
    return (
      <main className="min-h-screen bg-[var(--canvas-tan)] text-[var(--black)]">
        <div className="mx-auto grid min-h-[calc(100vh-3.5rem)] w-full max-w-5xl place-items-center px-4 py-8 lg:px-8">
          <section className="w-full max-w-3xl overflow-hidden border-[3px] border-[var(--black)] bg-[var(--paper)] shadow-[var(--shadow-lg)]">
            <div className="relative border-b-[3px] border-[var(--black)] bg-[linear-gradient(180deg,var(--brass-light),var(--brass),var(--brass-dark))] px-6 py-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="font-mono text-[10px] uppercase tracking-[0.4em] text-[var(--black)]">
                    Poor Mans Sport · Est. 1932
                  </p>
                  <h1 className="mt-1 font-display text-4xl uppercase tracking-[0.08em] text-[var(--black)] md:text-5xl">
                    The Bell
                  </h1>
                  <p className="mt-2 max-w-md font-mono text-xs uppercase leading-relaxed text-[var(--black)] opacity-80">
                    Member access · Evidence-based · Safety first
                  </p>
                </div>
                <div className="flex flex-col items-end gap-2">
                  <span className="stamp stamp--static stamp--cleared text-[10px]">CLEARED FOR ENTRY</span>
                  <Link
                    href="/public"
                    className="leather-tag no-underline text-[10px]"
                  >
                    Public Page
                  </Link>
                </div>
              </div>
            </div>

            <div className="grid gap-0 lg:grid-cols-[1.1fr_0.9fr]">
              <div className="space-y-0 border-b-[3px] border-[var(--black)] lg:border-b-0 lg:border-r-[3px]">
                <div className="flex border-b-[2px] border-[var(--black)]">
                  <button
                    type="button"
                    onClick={() => setSelectedMethod('pin')}
                    className={`flex-1 border-r-[2px] border-[var(--black)] py-3 font-mono text-[11px] uppercase tracking-[0.15em] transition ${
                      selectedMethod === 'pin'
                        ? 'bg-[var(--red-primary)] text-[var(--white)]'
                        : 'bg-[var(--canvas-tan-light)] text-[var(--black)] hover:bg-[var(--brass-light)]'
                    }`}
                  >
                    PIN Stamp
                  </button>
                  <button
                    type="button"
                    onClick={() => setSelectedMethod('microsoft')}
                    className={`flex-1 py-3 font-mono text-[11px] uppercase tracking-[0.15em] transition ${
                      selectedMethod === 'microsoft'
                        ? 'bg-[var(--red-primary)] text-[var(--white)]'
                        : 'bg-[var(--canvas-tan-light)] text-[var(--black)] hover:bg-[var(--brass-light)]'
                    }`}
                  >
                    Microsoft
                  </button>
                </div>

                <div className="p-5 sm:p-6">
                  {selectedMethod === 'microsoft' ? (
                    <div className="space-y-4">
                      <p className="font-mono text-xs uppercase tracking-wide text-[var(--gray-dark)]">
                        Sign in with your Microsoft account. Admin controls access.
                      </p>
                      {authErrorMessage && (
                        <div className="border-2 border-[var(--red-primary)] bg-[#f0d6d6] p-3">
                          <p className="font-mono text-sm text-[var(--red-primary)]">{authErrorMessage}</p>
                        </div>
                      )}
                      <button
                        type="button"
                        onClick={microsoftSignIn}
                        className="brass-plate w-full min-h-[52px] text-sm"
                      >
                        Continue with Microsoft
                      </button>
                    </div>
                  ) : (
                    <form
                      onSubmit={(e) => {
                        e.preventDefault();
                        void loginWithPin();
                      }}
                      className="space-y-4"
                    >
                      <p className="font-mono text-xs uppercase tracking-wide text-[var(--gray-dark)]">
                        Enter Account ID and PIN. Ask coach if you need a new one.
                      </p>
                      <div>
                        <label
                          className="block font-mono text-[10px] uppercase tracking-[0.2em] text-[var(--gray-dark)]"
                          htmlFor="login-account-id"
                        >
                          Account ID
                        </label>
                        <input
                          id="login-account-id"
                          type="text"
                          value={loginAccountId}
                          onChange={(event) => setLoginAccountId(event.target.value)}
                          placeholder="account-001"
                          autoComplete="username"
                          className="mt-1 min-h-[48px] w-full border-[3px] border-[var(--black)] bg-[var(--canvas-tan-light)] px-3 font-mono text-base text-[var(--black)] outline-none focus:border-[var(--red-primary)]"
                        />
                      </div>
                      <div>
                        <label
                          className="block font-mono text-[10px] uppercase tracking-[0.2em] text-[var(--gray-dark)]"
                          htmlFor="login-pin"
                        >
                          PIN
                        </label>
                        <input
                          id="login-pin"
                          type="password"
                          inputMode="numeric"
                          value={loginPin}
                          onChange={(event) => setLoginPin(event.target.value)}
                          placeholder="••••"
                          autoComplete="current-password"
                          className="mt-1 min-h-[48px] w-full border-[3px] border-[var(--black)] bg-[var(--canvas-tan-light)] px-3 font-mono text-base tracking-[0.3em] text-[var(--black)] outline-none focus:border-[var(--red-primary)]"
                        />
                      </div>
                      {loginError && (
                        <div className="border-2 border-[var(--red-primary)] bg-[#f0d6d6] p-3" role="alert">
                          <p className="font-mono text-sm text-[var(--red-primary)]">{loginError}</p>
                        </div>
                      )}
                      <button
                        type="submit"
                        disabled={loginBusy || !loginAccountId.trim() || !loginPin.trim()}
                        className="stamp stamp--cleared w-full min-h-[52px] text-sm disabled:opacity-50"
                      >
                        {loginBusy ? 'STAMPING…' : 'SIGN IN'}
                      </button>
                      <p className="font-mono text-[11px] text-[var(--gray-dark)]">
                        First time?{' '}
                        <Link href="/activate" className="font-bold text-[var(--red-primary)] underline">
                          Set up with activation code
                        </Link>
                      </p>
                    </form>
                  )}
                </div>
              </div>

              <aside className="bg-[var(--canvas-tan-dark)] p-5 sm:p-6">
                <div className="mb-3 flex items-center justify-between gap-2">
                  <p className="font-display text-sm uppercase tracking-wide text-[var(--paper)]">
                    Gym Notices
                  </p>
                  <span className="stamp stamp--static stamp--neutral text-[9px]">PINNED</span>
                </div>
                <div className="space-y-3">
                  {noticesLoading ? (
                    <p className="font-mono text-xs text-[var(--paper)] opacity-70">Loading ledger…</p>
                  ) : (
                    gymNotices.map((item) => (
                      <article
                        key={item.id}
                        className="border-2 border-[var(--black)] bg-[var(--paper)] p-3 shadow-[var(--shadow-sm)]"
                      >
                        <p className="text-sm leading-snug text-[var(--black)]">{item.message}</p>
                        <p className="mt-2 font-mono text-[10px] uppercase tracking-wide text-[var(--gray-dark)]">
                          {item.authorName} · {item.authorRole} · {item.createdAt}
                        </p>
                      </article>
                    ))
                  )}
                </div>
                <div className="mt-5 border-t-2 border-dashed border-[var(--paper)] pt-4">
                  <p className="font-mono text-[10px] uppercase leading-relaxed text-[var(--paper)] opacity-90">
                    Evidence. Not opinion.
                    <br />
                    Safety first. Kids first.
                  </p>
                  <Link
                    href="/athlete/sign-in"
                    className="mt-3 inline-flex leather-tag no-underline text-[10px]"
                  >
                    Simple Athlete PIN
                  </Link>
                </div>
              </aside>
            </div>
          </section>
        </div>
      </main>
    );
  }

  // Tactical fallback (explicit localStorage choice)
  return (
    <main className="min-h-screen bg-[var(--canvas-tan)] text-[var(--black)]">
      <div className="mx-auto grid min-h-screen w-full max-w-5xl place-items-center px-6 py-10 lg:px-10">
        <section className="w-full max-w-2xl overflow-hidden rounded-[28px] border border-[rgba(0,0,0,0.14)] bg-[var(--canvas-tan-light)] shadow-[var(--shadow-lg)]">
          <div className="border-b border-[rgba(0,0,0,0.14)] bg-[linear-gradient(135deg,var(--canvas-tan-dark),var(--canvas-tan-light))] px-8 py-8">
            <div className="flex items-center justify-between gap-3">
              <p className="text-[10px] font-mono uppercase tracking-[0.4em] text-[var(--gray-dark)]">Member Access</p>
              <Link
                href="/public"
                className="inline-flex min-h-[34px] items-center justify-center gap-3 rounded-full border border-[rgba(0,0,0,0.14)] bg-white px-3 text-[10px] font-mono font-bold uppercase tracking-[0.1em] text-[var(--black)] transition hover:bg-[var(--canvas-tan)]"
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
            <div className="grid gap-3 rounded-[24px] border border-[rgba(0,0,0,0.14)] bg-[var(--canvas-tan-light)] p-6 shadow-[var(--shadow-md)]">
              <p className="mb-2 text-xs font-semibold uppercase tracking-[0.2em] text-[var(--black)]">Choose Sign-In Method</p>
              <div className="grid gap-3 sm:grid-cols-2">
                <button
                  type="button"
                  onClick={() => setSelectedMethod('microsoft')}
                  className={`relative rounded-xl border-2 p-4 transition ${
                    selectedMethod === 'microsoft'
                      ? 'border-[var(--red-primary)] bg-[rgba(184,59,52,0.08)] shadow-[0_4px_12px_rgba(184,59,52,0.15)]'
                      : 'border-[rgba(0,0,0,0.12)] bg-white hover:border-[rgba(0,0,0,0.2)]'
                  }`}
                >
                  <div className="flex items-start gap-3">
                    <span className="text-2xl">☁️</span>
                    <div className="flex-1 text-left">
                      <p className={`text-xs font-black uppercase tracking-[0.15em] ${selectedMethod === 'microsoft' ? 'text-[var(--red-primary)]' : 'text-[var(--gray-dark)]'}`}>
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
                      ? 'border-[var(--red-primary)] bg-[rgba(184,59,52,0.08)] shadow-[0_4px_12px_rgba(184,59,52,0.15)]'
                      : 'border-[rgba(0,0,0,0.12)] bg-white hover:border-[rgba(0,0,0,0.2)]'
                  }`}
                >
                  <div className="flex items-start gap-3">
                    <span className="text-2xl">🔐</span>
                    <div className="flex-1 text-left">
                      <p className={`text-xs font-black uppercase tracking-[0.15em] ${selectedMethod === 'pin' ? 'text-[var(--red-primary)]' : 'text-[var(--gray-dark)]'}`}>
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
                {authErrorMessage && (
                  <div className="rounded-lg border border-[var(--red-primary)] bg-[rgba(184,59,52,0.05)] p-3">
                    <p className="text-sm text-[var(--red-primary)]">⚠️ {authErrorMessage}</p>
                  </div>
                )}
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
                className="grid gap-4 rounded-[24px] border-2 border-[var(--red-primary)] bg-white p-6 shadow-[var(--shadow-lg)]"
              >
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[var(--red-primary)]">Account PIN Sign In</p>
                  <p className="mt-2 text-sm leading-relaxed text-[var(--gray-dark)]">
                    Enter your Account ID and PIN. Ask your coach or admin if you do not have one.
                  </p>
                  <p className="mt-3 rounded-lg border border-[rgba(0,0,0,0.12)] bg-[var(--canvas-tan-light)] px-3 py-2 text-sm text-[var(--gray-dark)]">
                    First time here with an activation code?{' '}
                    <Link href="/activate" className="font-semibold text-[var(--red-primary)] underline">
                      Set up your account
                    </Link>
                  </p>
                </div>
                <div className="grid gap-3">
                  <div>
                    <label className="block text-xs font-semibold uppercase tracking-[0.25em] text-[var(--gray-dark)]" htmlFor="login-account-id-tactical">
                      Account ID
                    </label>
                    <input
                      id="login-account-id-tactical"
                      type="text"
                      value={loginAccountId}
                      onChange={(event) => setLoginAccountId(event.target.value)}
                      placeholder="account-001"
                      autoComplete="username"
                      className="mt-2 min-h-[48px] w-full rounded-xl border border-[rgba(0,0,0,0.14)] bg-white px-4 text-[var(--black)] outline-none transition placeholder:text-[var(--gray-medium)] focus:border-[var(--red-primary)] focus:ring-2 focus:ring-[rgba(184,59,52,0.15)]"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold uppercase tracking-[0.25em] text-[var(--gray-dark)]" htmlFor="login-pin-tactical">
                      PIN (4+ digits)
                    </label>
                    <input
                      id="login-pin-tactical"
                      type="password"
                      inputMode="numeric"
                      value={loginPin}
                      onChange={(event) => setLoginPin(event.target.value)}
                      placeholder="••••"
                      autoComplete="current-password"
                      className="mt-2 min-h-[48px] w-full rounded-xl border border-[rgba(0,0,0,0.14)] bg-white px-4 text-[var(--black)] outline-none transition placeholder:text-[var(--gray-medium)] focus:border-[var(--red-primary)] focus:ring-2 focus:ring-[rgba(184,59,52,0.15)]"
                    />
                  </div>
                  {loginError && (
                    <div className="rounded-lg border border-[var(--red-primary)] bg-[rgba(184,59,52,0.05)] p-3" role="alert">
                      <p className="text-sm text-[var(--red-primary)]">❌ {loginError}</p>
                    </div>
                  )}
                  <button
                    type="submit"
                    disabled={loginBusy || !loginAccountId.trim() || !loginPin.trim()}
                    className="inline-flex min-h-[52px] w-full items-center justify-center gap-2 rounded-xl border-2 border-[var(--red-primary)] bg-[var(--red-primary)] px-6 text-sm font-black uppercase tracking-[0.18em] text-white transition hover:bg-[var(--red-highlight)] hover:border-[var(--red-highlight)] disabled:cursor-not-allowed disabled:opacity-50 disabled:border-[rgba(0,0,0,0.14)] disabled:bg-[var(--gray-medium)] active:scale-[0.98]"
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
                  <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[var(--red-primary)]">💡 Need Help?</p>
                  <p className="mt-2 text-sm leading-6 text-[var(--gray-dark)]">
                    If you do not have an Account ID or PIN, or if you have forgotten your PIN, contact your gym admin or coach. They can create a new account or reset your PIN.
                  </p>
                  <Link
                    href="/athlete/sign-in"
                    className="mt-3 inline-flex min-h-[40px] items-center rounded-lg border border-[var(--red-primary)] px-3 py-2 text-xs font-semibold uppercase tracking-[0.12em] text-[var(--red-primary)]"
                  >
                    Open Simple Athlete PIN Sign-In
                  </Link>
                </div>
                <div className="rounded-lg border border-[rgba(0,0,0,0.12)] bg-white p-3">
                  <p className="mb-2 text-xs font-semibold text-[var(--black)]">📢 Gym Notice</p>
                  {noticesLoading ? (
                    <p className="text-sm text-[var(--gray-medium)]">Loading notices…</p>
                  ) : (
                    <div className="space-y-2">
                      {gymNotices.map((item) => (
                        <article key={item.id} className="rounded-2xl border border-[rgba(0,0,0,0.12)] bg-white px-4 py-3 shadow-[var(--shadow-sm)]">
                          <p className="text-sm leading-6 text-[var(--black)]">{item.message}</p>
                          <p className="mt-2 text-[11px] font-mono uppercase tracking-[0.08em] text-[var(--gray-medium)]">
                            By {item.authorName} ({item.authorRole}) - {item.createdAt}
                          </p>
                        </article>
                      ))}
                    </div>
                  )}
                </div>
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
