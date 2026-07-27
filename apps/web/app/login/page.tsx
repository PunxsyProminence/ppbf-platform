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

interface LoginAnnouncement {
  id: string;
  message: string;
  authorName: string;
  authorRole: ClubRole | 'system';
  createdAt: string;
}

const DEFAULT_ANNOUNCEMENT: LoginAnnouncement = {
  id: 'system-default',
  message: 'Welcome to PPBF. Check in with your coach before floor activity.',
  authorName: 'System',
  authorRole: 'system',
  createdAt: 'Operational Baseline',
};

function AnnouncementCard({ item }: Readonly<{ item: LoginAnnouncement }>) {
  return (
    <article className="rounded-2xl border border-[rgba(0,0,0,0.12)] bg-white px-4 py-3 shadow-[var(--shadow-sm)]">
      <p className="text-sm leading-6 text-[var(--black)]">{item.message}</p>
      <p className="mt-2 text-[11px] font-mono uppercase tracking-[0.08em] text-[var(--gray-medium)]">
        By {item.authorName} ({item.authorRole}) - {item.createdAt}
      </p>
    </article>
  );
}

type LoginMethod = 'microsoft' | 'pin';

interface LoginTabProps {
  announcements: LoginAnnouncement[];
  signInWithMicrosoft: () => void;
  loginAccountId: string;
  setLoginAccountId: (value: string) => void;
  loginPin: string;
  setLoginPin: (value: string) => void;
  loginBusy: boolean;
  loginError: string;
  loginWithPin: () => Promise<void>;
  authErrorMessage: string;
  selectedMethod: LoginMethod;
  setSelectedMethod: (method: LoginMethod) => void;
}

function SignInMethodButton({
  isActive,
  onClick,
  icon,
  label,
  description,
}: {
  isActive: boolean;
  onClick: () => void;
  icon: string;
  label: string;
  description: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`relative rounded-xl border-2 p-4 transition ${
        isActive
          ? 'border-[var(--red-primary)] bg-[rgba(184,59,52,0.08)] shadow-[0_4px_12px_rgba(184,59,52,0.15)]'
          : 'border-[rgba(0,0,0,0.12)] bg-white hover:border-[rgba(0,0,0,0.2)]'
      }`}
    >
      <div className="flex items-start gap-3">
        <span className="text-2xl">{icon}</span>
        <div className="flex-1 text-left">
          <p className={`text-xs font-black uppercase tracking-[0.15em] ${isActive ? 'text-[var(--red-primary)]' : 'text-[var(--gray-dark)]'}`}>
            {label}
          </p>
          <p className="mt-1 text-[11px] leading-relaxed text-[var(--gray-medium)]">{description}</p>
        </div>
        {isActive && <span className="text-xl">✓</span>}
      </div>
    </button>
  );
}

function LoginTabContent(props: Readonly<LoginTabProps>) {
  return (
    <div className="space-y-6">
      {/* IMPROVED: Sign-In Method Selector */}
      <div className="grid gap-3 rounded-[24px] border border-[rgba(0,0,0,0.14)] bg-[var(--canvas-tan-light)] p-6 shadow-[var(--shadow-md)]">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[var(--black)] mb-2">Choose Sign-In Method</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <SignInMethodButton
            isActive={props.selectedMethod === 'microsoft'}
            onClick={() => props.setSelectedMethod('microsoft')}
            icon="☁️"
            label="Microsoft"
            description="Sign in with your Microsoft account"
          />
          <SignInMethodButton
            isActive={props.selectedMethod === 'pin'}
            onClick={() => props.setSelectedMethod('pin')}
            icon="🔐"
            label="PIN"
            description="Sign in with Account ID & PIN"
          />
        </div>
      </div>

      {/* Microsoft Sign-In Method */}
      {props.selectedMethod === 'microsoft' && (
        <div className="grid gap-4 rounded-[24px] border-2 border-[var(--gray-dark)] bg-white p-6 shadow-[var(--shadow-lg)]">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[var(--black)]">Microsoft Sign In</p>
            <p className="mt-2 text-sm text-[var(--gray-dark)] leading-relaxed">
              Click below to sign in securely with your Microsoft account. Your organization admin manages who can access the platform.
            </p>
          </div>

          {props.authErrorMessage && (
            <div className="rounded-lg border border-[var(--red-primary)] bg-[rgba(184,59,52,0.05)] p-3">
              <p className="text-sm text-[var(--red-primary)]">⚠️ {props.authErrorMessage}</p>
            </div>
          )}

          <button
            type="button"
            onClick={props.signInWithMicrosoft}
            className="inline-flex min-h-[52px] w-full items-center justify-center gap-3 rounded-xl border-2 border-[var(--gray-dark)] bg-[var(--gray-dark)] px-6 text-sm font-black uppercase tracking-[0.18em] text-white transition hover:bg-[var(--black)] hover:border-[var(--black)] active:scale-[0.98]"
          >
            <span>☁️</span>
            Continue With Microsoft
          </button>
        </div>
      )}

      {/* PIN Sign-In Method */}
      {props.selectedMethod === 'pin' && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void props.loginWithPin();
          }}
          className="grid gap-4 rounded-[24px] border-2 border-[var(--red-primary)] bg-white p-6 shadow-[var(--shadow-lg)]"
        >
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[var(--red-primary)]">Account PIN Sign In</p>
            <p className="mt-2 text-sm text-[var(--gray-dark)] leading-relaxed">
              Enter your Account ID and PIN. Ask your coach or admin if you don&apos;t have one.
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
              <label className="block text-xs font-semibold uppercase tracking-[0.25em] text-[var(--gray-dark)]" htmlFor="login-account-id">
                Account ID
              </label>
              <input
                id="login-account-id"
                type="text"
                value={props.loginAccountId}
                onChange={(event) => props.setLoginAccountId(event.target.value)}
                placeholder="account-001"
                autoComplete="username"
                className="mt-2 min-h-[48px] w-full rounded-xl border border-[rgba(0,0,0,0.14)] bg-white px-4 text-[var(--black)] outline-none transition placeholder:text-[var(--gray-medium)] focus:border-[var(--red-primary)] focus:ring-2 focus:ring-[rgba(184,59,52,0.15)]"
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
                value={props.loginPin}
                onChange={(event) => props.setLoginPin(event.target.value)}
                placeholder="••••"
                autoComplete="current-password"
                className="mt-2 min-h-[48px] w-full rounded-xl border border-[rgba(0,0,0,0.14)] bg-white px-4 text-[var(--black)] outline-none transition placeholder:text-[var(--gray-medium)] focus:border-[var(--red-primary)] focus:ring-2 focus:ring-[rgba(184,59,52,0.15)]"
              />
            </div>

            {props.loginError && (
              <div className="rounded-lg border border-[var(--red-primary)] bg-[rgba(184,59,52,0.05)] p-3" role="alert">
                <p className="text-sm text-[var(--red-primary)]">❌ {props.loginError}</p>
              </div>
            )}

            <button
              type="submit"
              disabled={props.loginBusy || !props.loginAccountId.trim() || !props.loginPin.trim()}
              className="inline-flex min-h-[52px] w-full items-center justify-center gap-2 rounded-xl border-2 border-[var(--red-primary)] bg-[var(--red-primary)] px-6 text-sm font-black uppercase tracking-[0.18em] text-white transition hover:bg-[var(--red-highlight)] hover:border-[var(--red-highlight)] disabled:cursor-not-allowed disabled:opacity-50 disabled:border-[rgba(0,0,0,0.14)] disabled:bg-[var(--gray-medium)] active:scale-[0.98]"
            >
              {props.loginBusy ? (
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

      {/* Help & Recovery */}
      <div className="rounded-[24px] border border-[rgba(0,0,0,0.14)] bg-[var(--canvas-tan-light)] p-6 shadow-[var(--shadow-sm)]">
        <div className="space-y-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[var(--red-primary)]">💡 Need Help?</p>
            <p className="mt-2 text-sm leading-6 text-[var(--gray-dark)]">
              If you don&apos;t have an Account ID or PIN, or if you&apos;ve forgotten your PIN, contact your gym admin or coach. They can create a new account or reset your PIN.
            </p>
            <Link
              href="/athlete/sign-in"
              className="mt-3 inline-flex min-h-[40px] items-center rounded-lg border border-[var(--red-primary)] px-3 py-2 text-xs font-semibold uppercase tracking-[0.12em] text-[var(--red-primary)]"
            >
              Open Simple Athlete PIN Sign-In
            </Link>
          </div>
          <div className="rounded-lg border border-[rgba(0,0,0,0.12)] bg-white p-3">
            <p className="text-xs font-semibold text-[var(--black)] mb-2">📢 Latest Updates</p>
            <div className="space-y-2">
              {props.announcements.slice(0, 2).map((item) => (
                <AnnouncementCard key={item.id} item={item} />
              ))}
            </div>
            {props.announcements.length === 0 && (
              <p className="text-xs text-[var(--gray-medium)] italic">No announcements yet</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function LoginPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [selectedMethod, setSelectedMethod] = useState<LoginMethod>('pin');
  const [announcements, setAnnouncements] = useState<LoginAnnouncement[]>([DEFAULT_ANNOUNCEMENT]);
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
      return 'This Microsoft account is not allowed to sign in as platform owner.';
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

  useEffect(() => {
    void (async () => {
      const response = await fetch(`${apiBase()}/api/pilot/announcements/get`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ limit: 12 }),
      });

      if (!response.ok) {
        return;
      }

      const payload = (await response.json().catch(() => ({ ok: false }))) as {
        ok?: boolean;
        announcements?: Array<{
          announcement_id: string;
          message: string;
          author_name: string;
          author_role: ClubRole | 'system';
          created_at: string;
        }>;
      };

      if (!payload.ok || !Array.isArray(payload.announcements) || payload.announcements.length === 0) {
        return;
      }

      const normalized: LoginAnnouncement[] = payload.announcements.map((item) => ({
        id: item.announcement_id,
        message: item.message,
        authorName: item.author_name,
        authorRole: item.author_role,
        createdAt: new Date(item.created_at).toLocaleString(),
      }));

      setAnnouncements(normalized);
    })();
  }, []);

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
      const timeout = setTimeout(() => controller.abort(), 10000); // 10 second timeout

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

  return (
    <main className="min-h-screen bg-[var(--canvas-tan)] text-[var(--black)]">
      <div className="mx-auto grid min-h-screen w-full max-w-5xl place-items-center px-6 py-10 lg:px-10">
        <section className="w-full max-w-2xl overflow-hidden rounded-[28px] border border-[rgba(0,0,0,0.14)] bg-[var(--canvas-tan-light)] shadow-[var(--shadow-lg)]">
          <div className="border-b border-[rgba(0,0,0,0.14)] bg-[linear-gradient(135deg,var(--canvas-tan-dark),var(--canvas-tan-light))] px-8 py-8">
            <div className="flex items-center justify-between gap-3">
              <p className="text-[10px] font-mono uppercase tracking-[0.4em] text-[var(--gray-dark)]">Member Access</p>
              <Link
                href="/public"
                className="inline-flex min-h-[34px] items-center justify-center rounded-full border border-[rgba(0,0,0,0.14)] bg-white px-3 text-[10px] font-mono font-bold uppercase tracking-[0.1em] text-[var(--black)] transition hover:bg-[var(--canvas-tan)]"
              >
                Public Page
              </Link>
            </div>
            <h1 className="mt-4 text-4xl font-black tracking-[0.1em] text-[var(--black)] md:text-5xl">The Bell</h1>
            <p className="mt-3 text-sm leading-relaxed text-[var(--gray-dark)]">
              Sign in with your Account ID and PIN, or continue with Microsoft. You&apos;ll land on the right dashboard for your role.
            </p>
          </div>

          <div className="space-y-6 px-8 py-8">
            <LoginTabContent
              announcements={announcements}
              signInWithMicrosoft={microsoftSignIn}
              loginAccountId={loginAccountId}
              setLoginAccountId={setLoginAccountId}
              loginPin={loginPin}
              setLoginPin={setLoginPin}
              loginBusy={loginBusy}
              loginError={loginError}
              loginWithPin={loginWithPin}
              authErrorMessage={authErrorMessage}
              selectedMethod={selectedMethod}
              setSelectedMethod={setSelectedMethod}
            />
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
