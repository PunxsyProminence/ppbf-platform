'use client';

import { Suspense, useEffect, useState, type ReactElement } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { type ClubRole } from '@/components/roleRoutes';
import { apiBase } from '@/lib/apiBase';
import { createPersistentRoleSession, getPostLoginRoute, readRoleSession, clearRoleSession } from '@/components/roleSession';
import {
  createMicrosoftSignInHandler,
  getPilotLoginRedirectPath,
  getTabButtonClass,
  mapPilotLoginRoleToClubRole,
  validateAnnouncementPublishInput,
} from '@/src/client/loginPageHelpers';

type ActiveTab = 'login' | 'register' | 'announcement';

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
  accountType: string;
  setAccountType: (type: string) => void;
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

function AccountTypeDropdown({
  accountType,
  setAccountType,
}: {
  accountType: string;
  setAccountType: (type: string) => void;
}) {
  const accountTypes = [
    { value: 'coach', label: '👨‍🏫 Coach', description: 'Training coach' },
    { value: 'athlete', label: '🥊 Athlete', description: 'Member athlete' },
    { value: 'parent', label: '👨‍👧 Parent', description: 'Parent/guardian' },
    { value: 'admin', label: '⚙️ Administrator', description: 'System admin' },
  ];

  return (
    <div className="space-y-2">
      <label className="block text-xs font-semibold uppercase tracking-[0.25em] text-[var(--gray-dark)]">
        Account Type
      </label>
      <select
        value={accountType}
        onChange={(e) => setAccountType(e.target.value)}
        className="w-full min-h-[48px] rounded-xl border border-[rgba(0,0,0,0.14)] bg-white px-4 py-3 text-sm font-semibold text-[var(--black)] outline-none transition appearance-none cursor-pointer focus:border-[var(--red-primary)] focus:ring-2 focus:ring-[rgba(184,59,52,0.15)]"
        style={{
          backgroundImage:
            "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath fill='%23333' d='M6 9L1 4h10z'/%3E%3C/svg%3E\")",
          backgroundRepeat: 'no-repeat',
          backgroundPosition: 'right 1rem center',
          paddingRight: '2.5rem',
        }}
      >
        <option value="">Select account type...</option>
        {accountTypes.map(({ value, label }) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </select>
      {accountType && (
        <p className="text-[11px] text-[var(--gray-medium)] italic">
          {accountTypes.find((t) => t.value === accountType)?.description}
        </p>
      )}
    </div>
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
        <div className="grid gap-4 rounded-[24px] border-2 border-[var(--red-primary)] bg-white p-6 shadow-[var(--shadow-lg)]">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[var(--red-primary)]">Account PIN Sign In</p>
            <p className="mt-2 text-sm text-[var(--gray-dark)] leading-relaxed">
              Enter your Account ID and PIN. Ask your coach or admin if you don&apos;t have one.
            </p>
          </div>

          <AccountTypeDropdown accountType={props.accountType} setAccountType={props.setAccountType} />

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
                placeholder={props.accountType === 'coach' ? 'coach-001' : props.accountType === 'athlete' ? 'ath-001' : 'admin-001'}
                className="mt-2 min-h-[48px] w-full rounded-xl border border-[rgba(0,0,0,0.14)] bg-white px-4 text-[var(--black)] outline-none transition placeholder:text-[var(--gray-medium)] focus:border-[var(--red-primary)] focus:ring-2 focus:ring-[rgba(184,59,52,0.15)]"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold uppercase tracking-[0.25em] text-[var(--gray-dark)]" htmlFor="login-pin">
                PIN (4-8 digits)
              </label>
              <input
                id="login-pin"
                type="password"
                inputMode="numeric"
                value={props.loginPin}
                onChange={(event) => props.setLoginPin(event.target.value)}
                placeholder="••••"
                className="mt-2 min-h-[48px] w-full rounded-xl border border-[rgba(0,0,0,0.14)] bg-white px-4 text-[var(--black)] outline-none transition placeholder:text-[var(--gray-medium)] focus:border-[var(--red-primary)] focus:ring-2 focus:ring-[rgba(184,59,52,0.15)]"
              />
            </div>

            {props.loginError && (
              <div className="rounded-lg border border-[var(--red-primary)] bg-[rgba(184,59,52,0.05)] p-3">
                <p className="text-sm text-[var(--red-primary)]">❌ {props.loginError}</p>
              </div>
            )}

            <button
              type="button"
              disabled={props.loginBusy || !props.loginAccountId.trim() || !props.loginPin.trim()}
              onClick={() => void props.loginWithPin()}
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
        </div>
      )}

      {/* Announcements Section */}
      <div className="rounded-[24px] border border-[rgba(0,0,0,0.14)] bg-[var(--canvas-tan-light)] p-6 shadow-[var(--shadow-sm)]">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[var(--red-primary)]">📢 Latest Updates</p>
        <p className="mt-2 text-sm leading-6 text-[var(--gray-dark)]">
          Announcements from coaches and admins appear below. Check in before floor activity.
        </p>
        <div className="mt-4 grid gap-3">
          {props.announcements.slice(0, 3).map((item) => (
            <AnnouncementCard key={item.id} item={item} />
          ))}
        </div>
      </div>
    </div>
  );
}

function RegisterTabContent() {
  return (
    <div className="border-2 border-[var(--black)] bg-[var(--canvas-tan)] p-4">
      <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[var(--red-primary)]">Registration</p>
      <p className="mt-3 text-sm leading-6 text-[var(--black)]">
        New organizations and user accounts are created inside Organization Provisioning. Sign in with an admin Account ID and PIN first,
        then open the provisioning workspace to add organizations, admins, coaches, athletes, and parents.
      </p>
      <Link
        href="/admin/organizations"
        className="mt-4 inline-flex w-full min-h-[44px] items-center justify-center border-2 border-[var(--black)] bg-[var(--red-primary)] px-4 text-xs font-black uppercase tracking-[0.12em] text-[var(--white)] transition hover:bg-[var(--red-highlight)]"
      >
        Open Organization Provisioning
      </Link>
    </div>
  );
}

interface AnnouncementTabProps {
  announcements: LoginAnnouncement[];
  announcementAuthorName: string;
  setAnnouncementAuthorName: (value: string) => void;
  draftAnnouncement: string;
  setDraftAnnouncement: (value: string) => void;
  announcementPin: string;
  setAnnouncementPin: (value: string) => void;
  announcementError: string;
  announcementSavedAt: string | null;
  publishAnnouncement: () => Promise<void>;
}

function AnnouncementTabContent(props: Readonly<AnnouncementTabProps>) {
  return (
    <>
      <div className="border-2 border-[var(--black)] bg-[var(--canvas-tan)] p-4">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[var(--red-primary)]">Message Feed</p>
        <div className="mt-3 grid gap-3">
          {props.announcements.map((item) => (
            <AnnouncementCard key={item.id} item={item} />
          ))}
        </div>
      </div>

      <p className="text-xs uppercase tracking-[0.18em] text-[var(--gray-medium)]">Coach, Admin, and Board can publish</p>

      <label className="block text-xs font-semibold uppercase tracking-[0.2em] text-[var(--black)]" htmlFor="announcement-author-name">
        Your Name
      </label>
      <input
        id="announcement-author-name"
        type="text"
        value={props.announcementAuthorName}
        onChange={(event) => props.setAnnouncementAuthorName(event.target.value)}
        placeholder="Name shown on announcement"
        className="w-full border-2 border-[var(--black)] bg-[var(--canvas-tan)] px-4 py-3 text-[var(--black)] outline-none transition placeholder-[var(--gray-medium)] focus:border-[var(--red-primary)] focus:bg-[var(--canvas-tan-light)]"
      />

      <label className="block text-xs font-semibold uppercase tracking-[0.2em] text-[var(--black)]" htmlFor="announcement-draft">
        Announcement
      </label>
      <textarea
        id="announcement-draft"
        value={props.draftAnnouncement}
        onChange={(event) => props.setDraftAnnouncement(event.target.value)}
        rows={4}
        className="w-full border-2 border-[var(--black)] bg-[var(--canvas-tan)] px-4 py-3 text-[var(--black)] outline-none transition placeholder-[var(--gray-medium)] focus:border-[var(--red-primary)] focus:bg-[var(--canvas-tan-light)]"
        placeholder="Type message for members..."
      />

      <label className="block text-xs font-semibold uppercase tracking-[0.2em] text-[var(--black)]" htmlFor="announcement-pin">
        Access PIN
      </label>
      <input
        id="announcement-pin"
        type="password"
        inputMode="numeric"
        value={props.announcementPin}
        onChange={(event) => props.setAnnouncementPin(event.target.value)}
        placeholder="Enter access PIN"
        className="w-full border-2 border-[var(--black)] bg-[var(--canvas-tan)] px-4 py-3 text-[var(--black)] outline-none transition placeholder-[var(--gray-medium)] focus:border-[var(--red-primary)] focus:bg-[var(--canvas-tan-light)]"
      />

      {props.announcementError ? <p className="text-sm text-[var(--red-primary)]">{props.announcementError}</p> : null}
      {props.announcementSavedAt ? <p className="text-[11px] font-mono text-[var(--gray-medium)]">Last posted: {props.announcementSavedAt}</p> : null}

      <button
        type="button"
        onClick={() => void props.publishAnnouncement()}
        className="mt-2 inline-flex w-full items-center justify-center border-2 border-[var(--black)] bg-[var(--gray-dark)] px-4 py-3 text-sm font-black uppercase tracking-[0.2em] text-[var(--white)] transition hover:bg-[var(--black)]"
      >
        Post
      </button>
    </>
  );
}

function LoginPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [selectedRole] = useState<ClubRole>('athlete');
  const [activeTab, setActiveTab] = useState<ActiveTab>('login');
  const [selectedMethod, setSelectedMethod] = useState<LoginMethod>('pin');
  const [accountType, setAccountType] = useState('');
  const [announcements, setAnnouncements] = useState<LoginAnnouncement[]>([DEFAULT_ANNOUNCEMENT]);
  const [draftAnnouncement, setDraftAnnouncement] = useState('');
  const [announcementAuthorName, setAnnouncementAuthorName] = useState('');
  const [announcementPin, setAnnouncementPin] = useState('');
  const [announcementError, setAnnouncementError] = useState('');
  const [announcementSavedAt, setAnnouncementSavedAt] = useState<string | null>(null);
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
      void fetch(`${apiBase()}/api/pilot/auth/logout`, { method: 'POST' });
    }

    const session = readRoleSession();
    if (!session || shouldLogout) {
      return;
    }

    if (session.role === 'athlete') {
      void (async () => {
        const response = await fetch(`${apiBase()}/api/pilot/auth/session`, { method: 'POST' });
        const payload = (await response.json().catch(() => ({ authenticated: false }))) as { authenticated?: boolean };
        if (payload.authenticated) {
          router.replace(getPostLoginRoute(session));
          return;
        }
        clearRoleSession();
      })();
      return;
    }

    router.replace(getPostLoginRoute(session));

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

  async function publishAnnouncement() {
    const validationError = validateAnnouncementPublishInput({
      selectedRole,
      announcementPin,
      draftAnnouncement,
      announcementAuthorName,
    });

    if (validationError) {
      setAnnouncementError(validationError);
      return;
    }

    const response = await fetch(`${apiBase()}/api/pilot/announcements/post`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: draftAnnouncement.trim(),
        author_name: announcementAuthorName.trim(),
        author_role: selectedRole,
        access_pin: announcementPin.trim(),
      }),
    });

    if (!response.ok) {
      const payload = (await response.json().catch(() => ({ error: 'Failed to post announcement.' }))) as { error?: string };
      setAnnouncementError(payload.error || 'Failed to post announcement.');
      return;
    }

    const payload = (await response.json()) as {
      announcement?: {
        announcement_id: string;
        message: string;
        author_name: string;
        author_role: ClubRole;
        created_at: string;
      };
    };

    const created = payload.announcement;
    if (!created) {
      setAnnouncementError('Announcement response missing record.');
      return;
    }

    const record: LoginAnnouncement = {
      id: created.announcement_id,
      message: created.message,
      authorName: created.author_name,
      authorRole: created.author_role,
      createdAt: new Date(created.created_at).toLocaleString(),
    };

    setAnnouncements((current) => [record, ...current].slice(0, 12));
    setAnnouncementError('');
    setAnnouncementPin('');
    setDraftAnnouncement('');
    setAnnouncementSavedAt(record.createdAt);
  }

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
      const response = await fetch(`${apiBase()}/api/pilot/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          account_id: acctId, 
          pin: pinCode,
          account_type: accountType || undefined,
        }),
      });

      const result = (await response.json().catch(() => ({ error: 'Login failed' }))) as {
        error?: string;
        role?: string;
      };

      if (!response.ok || !result.role) {
        setLoginError(result.error || 'Invalid account ID or PIN.');
        return;
      }

      createPersistentRoleSession(mapPilotLoginRoleToClubRole(result.role));
      router.replace(getPilotLoginRedirectPath(result.role));
    } finally {
      setLoginBusy(false);
    }
  }

  const microsoftSignIn = createMicrosoftSignInHandler(apiBase());

  const tabContentMap: Record<ActiveTab, ReactElement> = {
    login: (
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
        accountType={accountType}
        setAccountType={setAccountType}
      />
    ),
    register: <RegisterTabContent />,
    announcement: (
      <AnnouncementTabContent
        announcements={announcements}
        announcementAuthorName={announcementAuthorName}
        setAnnouncementAuthorName={setAnnouncementAuthorName}
        draftAnnouncement={draftAnnouncement}
        setDraftAnnouncement={setDraftAnnouncement}
        announcementPin={announcementPin}
        setAnnouncementPin={setAnnouncementPin}
        announcementError={announcementError}
        announcementSavedAt={announcementSavedAt}
        publishAnnouncement={publishAnnouncement}
      />
    ),
  };

  const activeTabContent = tabContentMap[activeTab];

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
              Sign in with Account ID/PIN or Microsoft. Admins can add organizations and user accounts after login.
            </p>
          </div>

          <div className="border-b border-[rgba(0,0,0,0.14)] bg-[var(--canvas-tan)] px-8 py-6">
            <div className="grid grid-cols-3 gap-3 rounded-2xl border border-[rgba(0,0,0,0.12)] bg-white p-2 shadow-[var(--shadow-sm)]">
              <button
                type="button"
                onClick={() => setActiveTab('login')}
                className={`px-4 py-3 text-xs font-black uppercase tracking-[0.2em] transition ${getTabButtonClass(activeTab === 'login')}`}
              >
                Login
              </button>
              <button
                type="button"
                onClick={() => setActiveTab('register')}
                className={`px-4 py-3 text-xs font-black uppercase tracking-[0.2em] transition ${getTabButtonClass(activeTab === 'register')}`}
              >
                Register
              </button>
              <button
                type="button"
                onClick={() => setActiveTab('announcement')}
                className={`px-4 py-3 text-xs font-black uppercase tracking-[0.2em] transition ${getTabButtonClass(activeTab === 'announcement')}`}
              >
                Word
              </button>
            </div>
          </div>

          <div className="space-y-6 px-8 py-8">
            {activeTabContent}
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