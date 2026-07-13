'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { roleRoutes, type ClubRole } from '@/components/roleRoutes';
import { createRoleSession, getPostLoginRoute, OPERATOR_PIN, readRoleSession, clearRoleSession } from '@/components/roleSession';

type ActiveTab = 'login' | 'announcement';

const ANNOUNCEMENT_STORAGE_KEY = 'ppbf-login-announcement';
const DEFAULT_ANNOUNCEMENT = 'Welcome to PPBF. Check in with your coach before floor activity.';

function getStoredAnnouncement(): string {
  if (typeof window === 'undefined') {
    return DEFAULT_ANNOUNCEMENT;
  }

  const savedAnnouncement = window.localStorage.getItem(ANNOUNCEMENT_STORAGE_KEY);
  return savedAnnouncement?.trim() ? savedAnnouncement : DEFAULT_ANNOUNCEMENT;
}

export default function LoginPage() {
  const router = useRouter();
  const [pin, setPin] = useState('');
  const [selectedRole, setSelectedRole] = useState<ClubRole>('athlete');
  const [error, setError] = useState('');
  const [activeTab, setActiveTab] = useState<ActiveTab>('login');
  const [announcement, setAnnouncement] = useState(getStoredAnnouncement);
  const [draftAnnouncement, setDraftAnnouncement] = useState(getStoredAnnouncement);
  const [adminPin, setAdminPin] = useState('');
  const [announcementError, setAnnouncementError] = useState('');
  const [announcementSavedAt, setAnnouncementSavedAt] = useState<string | null>(null);

  useEffect(() => {
    // Check URL params for logout/reset (client-side only)
    const params = new URLSearchParams(typeof window !== 'undefined' ? window.location.search : '');
    const shouldLogout = params.get('logout') === 'true' || params.get('reset') === 'true';
    if (shouldLogout) {
      clearRoleSession();
    }

    const session = readRoleSession();
    if (session && !shouldLogout) {
      router.replace(getPostLoginRoute(session));
    }

  }, [router]);

  function signIn() {
    const result = createRoleSession(selectedRole, pin);

    if (!result.ok) {
      setError(result.reason);
      return;
    }

    setError('');
    router.push(getPostLoginRoute(result.session));
  }

  function publishAnnouncement() {
    if (selectedRole !== 'admin') {
      setAnnouncementError('Select Admin role to publish announcements.');
      return;
    }

    if (adminPin.trim() !== OPERATOR_PIN) {
      setAnnouncementError('Invalid admin PIN.');
      return;
    }

    const next = draftAnnouncement.trim();
    if (!next) {
      setAnnouncementError('Announcement cannot be empty.');
      return;
    }

    setAnnouncement(next);
    window.localStorage.setItem(ANNOUNCEMENT_STORAGE_KEY, next);
    setAnnouncementError('');
    setAdminPin('');
    setAnnouncementSavedAt(new Date().toLocaleString());
  }

  return (
    <main className="min-h-screen bg-[var(--canvas-tan)] text-[var(--black)]">
      <div className="mx-auto grid min-h-screen w-full max-w-4xl place-items-center px-6 py-10 lg:px-10">
        <section className="w-full max-w-xl border-[3px] border-[var(--black)] bg-[var(--canvas-tan-light)] shadow-[var(--shadow-lg)]">
          <div className="border-b-[3px] border-[var(--black)] bg-[var(--canvas-tan-dark)] px-8 py-8">
            <p className="text-[10px] font-mono uppercase tracking-[0.4em] text-[var(--gray-dark)]">Member Access</p>
            <h1 className="mt-4 text-4xl font-black tracking-[0.1em] text-[var(--black)] md:text-5xl">The Bell</h1>
            <p className="mt-3 text-sm leading-relaxed text-[var(--gray-dark)]">Pick your corner, punch in your PIN, step into the ring.</p>
          </div>

          <div className="border-b-2 border-[var(--black)] bg-[var(--canvas-tan)] px-8 py-6">
            <div className="grid grid-cols-2 gap-3 border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] p-2">
              <button
                type="button"
                onClick={() => setActiveTab('login')}
                className={`px-4 py-3 text-xs font-black uppercase tracking-[0.2em] transition ${
                  activeTab === 'login' ? 'border-2 border-[var(--black)] bg-[var(--red-primary)] text-[var(--white)]' : 'border-2 border-[var(--black)] bg-[var(--canvas-tan)] text-[var(--gray-dark)] hover:bg-[var(--canvas-tan-dark)]'
                }`}
              >
                Login
              </button>
              <button
                type="button"
                onClick={() => setActiveTab('announcement')}
                className={`px-4 py-3 text-xs font-black uppercase tracking-[0.2em] transition ${
                  activeTab === 'announcement' ? 'border-2 border-[var(--black)] bg-[var(--red-primary)] text-[var(--white)]' : 'border-2 border-[var(--black)] bg-[var(--canvas-tan)] text-[var(--gray-dark)] hover:bg-[var(--canvas-tan-dark)]'
                }`}
              >
                Word
              </button>
            </div>
          </div>

          <div className="space-y-6 px-8 py-8">
            {activeTab === 'login' ? (
              <>
                <label className="block text-xs font-semibold uppercase tracking-[0.25em] text-[var(--gray-dark)]" htmlFor="role">
                  Your Role
                </label>
                <select
                  id="role"
                  value={selectedRole}
                  onChange={(event) => setSelectedRole(event.target.value as ClubRole)}
                  className="w-full border-2 border-[var(--black)] bg-[var(--canvas-tan)] px-4 py-3 text-[var(--black)] outline-none transition focus:border-[var(--red-primary)] focus:bg-[var(--canvas-tan-light)]"
                >
                  {roleRoutes.map((item) => (
                    <option key={item.role} value={item.role}>
                      {item.label}
                    </option>
                  ))}
                </select>

                <label className="block text-xs font-semibold uppercase tracking-[0.25em] text-[var(--gray-dark)]" htmlFor="pin">
                  PIN
                </label>
                <input
                  id="pin"
                  type="password"
                  inputMode="numeric"
                  value={pin}
                  onChange={(event) => setPin(event.target.value)}
                  placeholder="Enter PIN"
                  className="w-full border-2 border-[var(--black)] bg-[var(--canvas-tan)] px-4 py-3 text-[var(--black)] outline-none transition placeholder-[var(--gray-medium)] focus:border-[var(--red-primary)] focus:bg-[var(--canvas-tan-light)]"
                />

                {error ? <p className="text-sm text-[var(--red-primary)]">{error}</p> : null}

                <button
                  type="button"
                  onClick={signIn}
                  className="mt-4 inline-flex w-full items-center justify-center border-2 border-[var(--black)] bg-[var(--red-primary)] px-4 py-3 text-sm font-black uppercase tracking-[0.2em] text-[var(--white)] transition hover:bg-[var(--red-highlight)]"
                >
                  Sign In
                </button>
              </>
            ) : (
              <>
                <div className="border-2 border-[var(--black)] bg-[var(--canvas-tan)] p-4">
                  <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[var(--red-primary)]">Message</p>
                  <p className="mt-3 text-sm leading-6 text-[var(--black)]">{announcement}</p>
                  {announcementSavedAt ? (
                    <p className="mt-3 text-[11px] font-mono text-[var(--gray-medium)]">Updated: {announcementSavedAt}</p>
                  ) : null}
                </div>

                <p className="text-xs uppercase tracking-[0.18em] text-[var(--gray-medium)]">Admin only</p>

                <label className="block text-xs font-semibold uppercase tracking-[0.2em] text-[var(--black)]" htmlFor="announcement-draft">
                  Announcement
                </label>
                <textarea
                  id="announcement-draft"
                  value={draftAnnouncement}
                  onChange={(event) => setDraftAnnouncement(event.target.value)}
                  rows={4}
                  className="w-full border-2 border-[var(--black)] bg-[var(--canvas-tan)] px-4 py-3 text-[var(--black)] outline-none transition placeholder-[var(--gray-medium)] focus:border-[var(--red-primary)] focus:bg-[var(--canvas-tan-light)]"
                  placeholder="Type message for members..."
                />

                <label className="block text-xs font-semibold uppercase tracking-[0.2em] text-[var(--black)]" htmlFor="admin-pin">
                  Admin PIN
                </label>
                <input
                  id="admin-pin"
                  type="password"
                  inputMode="numeric"
                  value={adminPin}
                  onChange={(event) => setAdminPin(event.target.value)}
                  placeholder="Enter admin PIN"
                  className="w-full border-2 border-[var(--black)] bg-[var(--canvas-tan)] px-4 py-3 text-[var(--black)] outline-none transition placeholder-[var(--gray-medium)] focus:border-[var(--red-primary)] focus:bg-[var(--canvas-tan-light)]"
                />

                {announcementError ? <p className="text-sm text-[var(--red-primary)]">{announcementError}</p> : null}

                <button
                  type="button"
                  onClick={publishAnnouncement}
                  className="mt-2 inline-flex w-full items-center justify-center border-2 border-[var(--black)] bg-[var(--gray-dark)] px-4 py-3 text-sm font-black uppercase tracking-[0.2em] text-[var(--white)] transition hover:bg-[var(--black)]"
                >
                  Post
                </button>
              </>
            )}
          </div>
        </section>
      </div>
    </main>
  );
}