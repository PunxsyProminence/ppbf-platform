'use client';

import { useEffect, useState, type ReactElement } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { type ClubRole } from '@/components/roleRoutes';
import { apiBase } from '@/lib/apiBase';
import { getPostLoginRoute, readRoleSession, clearRoleSession } from '@/components/roleSession';
import { createMicrosoftSignInHandler, getTabButtonClass, validateAnnouncementPublishInput } from '@/src/client/loginPageHelpers';

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
    <article className="border border-[var(--black)] bg-[var(--canvas-tan-light)] px-3 py-2">
      <p className="text-sm leading-6 text-[var(--black)]">{item.message}</p>
      <p className="mt-2 text-[11px] font-mono uppercase tracking-[0.08em] text-[var(--gray-medium)]">
        By {item.authorName} ({item.authorRole}) - {item.createdAt}
      </p>
    </article>
  );
}

interface LoginTabProps {
  announcements: LoginAnnouncement[];
  signInWithMicrosoft: () => void;
}

function LoginTabContent(props: Readonly<LoginTabProps>) {
  return (
    <>
      <div className="border-2 border-[var(--black)] bg-[var(--canvas-tan)] p-4">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[var(--red-primary)]">Announcements</p>
        <div className="mt-3 grid gap-3">
          {props.announcements.slice(0, 3).map((item) => (
            <AnnouncementCard key={item.id} item={item} />
          ))}
        </div>
      </div>

      <p className="text-sm leading-6 text-[var(--gray-dark)]">Sign in with Microsoft to access the platform admin tools.</p>

      <button
        type="button"
        onClick={props.signInWithMicrosoft}
        className="inline-flex w-full items-center justify-center border-2 border-[var(--black)] bg-[var(--gray-dark)] px-4 py-3 text-sm font-black uppercase tracking-[0.2em] text-[var(--white)] transition hover:bg-[var(--black)]"
      >
        Sign In With Microsoft
      </button>
    </>
  );
}

interface RegisterTabProps {
  registerAccountId: string;
  setRegisterAccountId: (value: string) => void;
  registerAthleteId: string;
  setRegisterAthleteId: (value: string) => void;
  registerPin: string;
  setRegisterPin: (value: string) => void;
  registerError: string;
  registerSuccess: string;
  registerBusy: boolean;
  registerAthlete: () => Promise<void>;
}

function RegisterTabContent(props: Readonly<RegisterTabProps>) {
  return (
    <>
      <div className="border-2 border-[var(--black)] bg-[var(--canvas-tan)] p-4">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[var(--red-primary)]">Registration</p>
        <p className="mt-3 text-sm leading-6 text-[var(--black)]">Creates an athlete account through the existing backend account API.</p>
      </div>

      <label className="block text-xs font-semibold uppercase tracking-[0.25em] text-[var(--gray-dark)]" htmlFor="register-account-id">
        Account ID
      </label>
      <input
        id="register-account-id"
        type="text"
        value={props.registerAccountId}
        onChange={(event) => props.setRegisterAccountId(event.target.value)}
        placeholder="athlete-account-id"
        className="w-full border-2 border-[var(--black)] bg-[var(--canvas-tan)] px-4 py-3 text-[var(--black)] outline-none transition placeholder-[var(--gray-medium)] focus:border-[var(--red-primary)] focus:bg-[var(--canvas-tan-light)]"
      />

      <label className="block text-xs font-semibold uppercase tracking-[0.25em] text-[var(--gray-dark)]" htmlFor="register-athlete-id">
        Athlete ID
      </label>
      <input
        id="register-athlete-id"
        type="text"
        value={props.registerAthleteId}
        onChange={(event) => props.setRegisterAthleteId(event.target.value)}
        placeholder="athlete-id"
        className="w-full border-2 border-[var(--black)] bg-[var(--canvas-tan)] px-4 py-3 text-[var(--black)] outline-none transition placeholder-[var(--gray-medium)] focus:border-[var(--red-primary)] focus:bg-[var(--canvas-tan-light)]"
      />

      <label className="block text-xs font-semibold uppercase tracking-[0.25em] text-[var(--gray-dark)]" htmlFor="register-pin">
        PIN
      </label>
      <input
        id="register-pin"
        type="password"
        inputMode="numeric"
        value={props.registerPin}
        onChange={(event) => props.setRegisterPin(event.target.value)}
        placeholder="Create PIN"
        className="w-full border-2 border-[var(--black)] bg-[var(--canvas-tan)] px-4 py-3 text-[var(--black)] outline-none transition placeholder-[var(--gray-medium)] focus:border-[var(--red-primary)] focus:bg-[var(--canvas-tan-light)]"
      />

      {props.registerError ? <p className="text-sm text-[var(--red-primary)]">{props.registerError}</p> : null}
      {props.registerSuccess ? <p className="text-sm text-[var(--olive-dark)]">{props.registerSuccess}</p> : null}

      <button
        type="button"
        disabled={props.registerBusy}
        onClick={() => void props.registerAthlete()}
        className="mt-4 inline-flex w-full items-center justify-center border-2 border-[var(--black)] bg-[var(--red-primary)] px-4 py-3 text-sm font-black uppercase tracking-[0.2em] text-[var(--white)] transition hover:bg-[var(--red-highlight)] disabled:cursor-not-allowed disabled:opacity-70"
      >
        {props.registerBusy ? 'Registering...' : 'Register Athlete'}
      </button>
    </>
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

export default function LoginPage() {
  const router = useRouter();
  const [selectedRole, setSelectedRole] = useState<ClubRole>('athlete');
  const [activeTab, setActiveTab] = useState<ActiveTab>('login');
  const [announcements, setAnnouncements] = useState<LoginAnnouncement[]>([DEFAULT_ANNOUNCEMENT]);
  const [draftAnnouncement, setDraftAnnouncement] = useState('');
  const [announcementAuthorName, setAnnouncementAuthorName] = useState('');
  const [announcementPin, setAnnouncementPin] = useState('');
  const [announcementError, setAnnouncementError] = useState('');
  const [announcementSavedAt, setAnnouncementSavedAt] = useState<string | null>(null);
  const [registerAccountId, setRegisterAccountId] = useState('');
  const [registerAthleteId, setRegisterAthleteId] = useState('');
  const [registerPin, setRegisterPin] = useState('');
  const [registerError, setRegisterError] = useState('');
  const [registerSuccess, setRegisterSuccess] = useState('');
  const [registerBusy, setRegisterBusy] = useState(false);

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

  async function registerAthlete() {
    const accountId = registerAccountId.trim();
    const athleteIdValue = registerAthleteId.trim();
    const pinValue = registerPin.trim();

    if (!accountId || !athleteIdValue || !pinValue) {
      setRegisterError('Account ID, Athlete ID, and PIN are required.');
      setRegisterSuccess('');
      return;
    }

    setRegisterBusy(true);
    setRegisterError('');
    setRegisterSuccess('');

    try {
      const response = await fetch(`${apiBase()}/api/pilot/admin/athlete-accounts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          account_id: accountId,
          athlete_id: athleteIdValue,
          pin: pinValue,
        }),
      });

      if (!response.ok) {
        const result = (await response.json().catch(() => ({ error: 'Registration failed' }))) as { error?: string };
        setRegisterError(result.error || 'Registration failed');
        return;
      }

      setRegisterSuccess('Athlete account created. You can now sign in with Athlete role.');
      setRegisterAccountId('');
      setRegisterAthleteId('');
      setRegisterPin('');
      setSelectedRole('athlete');
    } finally {
      setRegisterBusy(false);
    }
  }

  const microsoftSignIn = createMicrosoftSignInHandler(apiBase());

  const tabContentMap: Record<ActiveTab, ReactElement> = {
    login: (
      <LoginTabContent
        announcements={announcements}
        signInWithMicrosoft={microsoftSignIn}
      />
    ),
    register: (
      <RegisterTabContent
        registerAccountId={registerAccountId}
        setRegisterAccountId={setRegisterAccountId}
        registerAthleteId={registerAthleteId}
        setRegisterAthleteId={setRegisterAthleteId}
        registerPin={registerPin}
        setRegisterPin={setRegisterPin}
        registerError={registerError}
        registerSuccess={registerSuccess}
        registerBusy={registerBusy}
        registerAthlete={registerAthlete}
      />
    ),
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
      <div className="mx-auto grid min-h-screen w-full max-w-4xl place-items-center px-6 py-10 lg:px-10">
        <section className="w-full max-w-xl border-[3px] border-[var(--black)] bg-[var(--canvas-tan-light)] shadow-[var(--shadow-lg)]">
          <div className="border-b-[3px] border-[var(--black)] bg-[var(--canvas-tan-dark)] px-8 py-8">
            <div className="flex items-center justify-between gap-3">
              <p className="text-[10px] font-mono uppercase tracking-[0.4em] text-[var(--gray-dark)]">Member Access</p>
              <Link
                href="/public"
                className="inline-flex min-h-[34px] items-center justify-center border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] px-3 text-[10px] font-mono font-bold uppercase tracking-[0.1em] text-[var(--black)] transition hover:bg-[var(--canvas-tan)]"
              >
                Public Page
              </Link>
            </div>
            <h1 className="mt-4 text-4xl font-black tracking-[0.1em] text-[var(--black)] md:text-5xl">The Bell</h1>
            <p className="mt-3 text-sm leading-relaxed text-[var(--gray-dark)]">Pick your corner and sign in with Microsoft to enter the platform.</p>
          </div>

          <div className="border-b-2 border-[var(--black)] bg-[var(--canvas-tan)] px-8 py-6">
            <div className="grid grid-cols-3 gap-3 border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] p-2">
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