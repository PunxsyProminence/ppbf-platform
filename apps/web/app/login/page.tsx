'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { roleRoutes, type ClubRole } from '@/components/roleRoutes';
import { createRoleSession, getPostLoginRoute, OPERATOR_PIN, readRoleSession } from '@/components/roleSession';

type ActiveTab = 'login' | 'announcement';

const ANNOUNCEMENT_STORAGE_KEY = 'ppbf-login-announcement';
const DEFAULT_ANNOUNCEMENT = 'Welcome to PPBF. Check in with your coach before floor activity.';

export default function LoginPage() {
  const router = useRouter();
  const [pin, setPin] = useState('');
  const [selectedRole, setSelectedRole] = useState<ClubRole>('athlete');
  const [error, setError] = useState('');
  const [activeTab, setActiveTab] = useState<ActiveTab>('login');
  const [announcement, setAnnouncement] = useState(DEFAULT_ANNOUNCEMENT);
  const [draftAnnouncement, setDraftAnnouncement] = useState(DEFAULT_ANNOUNCEMENT);
  const [adminPin, setAdminPin] = useState('');
  const [announcementError, setAnnouncementError] = useState('');
  const [announcementSavedAt, setAnnouncementSavedAt] = useState<string | null>(null);

  useEffect(() => {
    const session = readRoleSession();
    if (session) {
      router.replace(getPostLoginRoute(session));
    }

    const savedAnnouncement = window.localStorage.getItem(ANNOUNCEMENT_STORAGE_KEY);
    if (savedAnnouncement && savedAnnouncement.trim()) {
      setAnnouncement(savedAnnouncement);
      setDraftAnnouncement(savedAnnouncement);
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
    <main className="min-h-screen bg-[radial-gradient(circle_at_20%_15%,_rgba(239,68,68,0.22),_transparent_34%),radial-gradient(circle_at_80%_90%,_rgba(245,158,11,0.16),_transparent_40%),linear-gradient(180deg,#150a08_0%,#22120d_46%,#100b09_100%)] text-amber-50">
      <div className="mx-auto grid min-h-screen w-full max-w-4xl place-items-center px-6 py-10 lg:px-10">
        <section className="w-full max-w-xl overflow-hidden rounded-[2rem] border-2 border-amber-200/25 bg-[#140d0c]/85 shadow-[0_0_0_1px_rgba(251,191,36,0.25),0_22px_70px_rgba(0,0,0,0.55)] backdrop-blur-sm">
          <div className="border-b border-amber-200/20 bg-[linear-gradient(90deg,rgba(127,29,29,0.9)_0%,rgba(153,27,27,0.95)_42%,rgba(120,53,15,0.95)_100%)] px-6 py-5">
            <p className="text-[11px] font-mono uppercase tracking-[0.35em] text-amber-100/90">PPBF Fight Card Access</p>
            <h1 className="mt-2 text-3xl font-black tracking-tight text-amber-50 md:text-4xl">Member Login</h1>
            <p className="mt-2 text-sm text-amber-100/80">Choose your corner, enter your PIN, and step straight into your dashboard.</p>
          </div>

          <div className="border-b border-amber-200/15 bg-black/25 px-6 py-3">
            <div className="grid grid-cols-2 gap-2 rounded-xl border border-amber-200/15 bg-black/20 p-1">
              <button
                type="button"
                onClick={() => setActiveTab('login')}
                className={`rounded-lg px-3 py-2 text-xs font-black uppercase tracking-[0.18em] transition ${
                  activeTab === 'login' ? 'bg-amber-300 text-[#2a130c]' : 'text-amber-100/75 hover:text-amber-50'
                }`}
              >
                Login
              </button>
              <button
                type="button"
                onClick={() => setActiveTab('announcement')}
                className={`rounded-lg px-3 py-2 text-xs font-black uppercase tracking-[0.18em] transition ${
                  activeTab === 'announcement' ? 'bg-amber-300 text-[#2a130c]' : 'text-amber-100/75 hover:text-amber-50'
                }`}
              >
                Announcement
              </button>
            </div>
          </div>

          <div className="space-y-5 px-6 py-6">
            {activeTab === 'login' ? (
              <>
                <label className="block text-xs font-semibold uppercase tracking-[0.2em] text-amber-100/85" htmlFor="role">
                  Role
                </label>
                <select
                  id="role"
                  value={selectedRole}
                  onChange={(event) => setSelectedRole(event.target.value as ClubRole)}
                  className="w-full rounded-xl border border-amber-200/25 bg-black/35 px-4 py-3 text-amber-50 outline-none transition focus:border-amber-300/70"
                >
                  {roleRoutes.map((item) => (
                    <option key={item.role} value={item.role}>
                      {item.label}
                    </option>
                  ))}
                </select>

                <label className="block text-xs font-semibold uppercase tracking-[0.2em] text-amber-100/85" htmlFor="pin">
                  Operator PIN
                </label>
                <input
                  id="pin"
                  type="password"
                  inputMode="numeric"
                  value={pin}
                  onChange={(event) => setPin(event.target.value)}
                  placeholder="Enter PIN"
                  className="w-full rounded-xl border border-amber-200/25 bg-black/35 px-4 py-3 text-amber-50 outline-none transition placeholder:text-amber-100/45 focus:border-amber-300/70"
                />

                {error ? <p className="text-sm text-rose-300">{error}</p> : null}

                <button
                  type="button"
                  onClick={signIn}
                  className="mt-2 inline-flex w-full items-center justify-center rounded-xl border border-amber-200/40 bg-[linear-gradient(180deg,#f59e0b_0%,#d97706_100%)] px-4 py-3 text-sm font-black uppercase tracking-[0.2em] text-[#1f130d] transition hover:brightness-110"
                >
                  Sign In
                </button>
              </>
            ) : (
              <>
                <div className="rounded-xl border border-amber-200/20 bg-black/30 p-4">
                  <p className="text-xs font-semibold uppercase tracking-[0.2em] text-amber-100/75">Current Announcement</p>
                  <p className="mt-3 text-sm leading-6 text-amber-50/90">{announcement}</p>
                  {announcementSavedAt ? (
                    <p className="mt-3 text-[11px] font-mono text-amber-100/60">Updated: {announcementSavedAt}</p>
                  ) : null}
                </div>

                <p className="text-xs uppercase tracking-[0.18em] text-amber-100/70">Admin publish controls</p>

                <label className="block text-xs font-semibold uppercase tracking-[0.2em] text-amber-100/85" htmlFor="announcement-draft">
                  Announcement Text
                </label>
                <textarea
                  id="announcement-draft"
                  value={draftAnnouncement}
                  onChange={(event) => setDraftAnnouncement(event.target.value)}
                  rows={4}
                  className="w-full rounded-xl border border-amber-200/25 bg-black/35 px-4 py-3 text-amber-50 outline-none transition placeholder:text-amber-100/45 focus:border-amber-300/70"
                  placeholder="Type announcement for members..."
                />

                <label className="block text-xs font-semibold uppercase tracking-[0.2em] text-amber-100/85" htmlFor="admin-pin">
                  Admin PIN
                </label>
                <input
                  id="admin-pin"
                  type="password"
                  inputMode="numeric"
                  value={adminPin}
                  onChange={(event) => setAdminPin(event.target.value)}
                  placeholder="Enter admin PIN"
                  className="w-full rounded-xl border border-amber-200/25 bg-black/35 px-4 py-3 text-amber-50 outline-none transition placeholder:text-amber-100/45 focus:border-amber-300/70"
                />

                {announcementError ? <p className="text-sm text-rose-300">{announcementError}</p> : null}

                <button
                  type="button"
                  onClick={publishAnnouncement}
                  className="mt-2 inline-flex w-full items-center justify-center rounded-xl border border-amber-200/35 bg-amber-200/10 px-4 py-3 text-sm font-black uppercase tracking-[0.2em] text-amber-100 transition hover:border-amber-200/55 hover:bg-amber-200/20"
                >
                  Publish Announcement
                </button>
              </>
            )}
          </div>
        </section>
      </div>
    </main>
  );
}