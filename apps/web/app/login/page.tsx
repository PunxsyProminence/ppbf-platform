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
    <main className="min-h-screen bg-[#0a0a0a] text-[#e8d7c6]">
      <div className="mx-auto grid min-h-screen w-full max-w-4xl place-items-center px-6 py-10 lg:px-10">
        <section className="w-full max-w-xl border-4 border-[#0a0a0a] bg-[#1a1a1a] shadow-2xl shadow-black/80">
          <div className="border-b-4 border-[#8b4444] bg-[#0f0f0f] px-8 py-8">
            <p className="text-[10px] font-mono uppercase tracking-[0.4em] text-[#d4a574]">Member Access</p>
            <h1 className="mt-4 text-4xl font-black tracking-[0.1em] text-[#e8d7c6] md:text-5xl">The Bell</h1>
            <p className="mt-3 text-sm leading-relaxed text-[#b0a095]">Pick your corner, punch in your PIN, step into the ring.</p>
          </div>

          <div className="border-b-2 border-[#5a2a2a] bg-[#0a0a0a] px-8 py-6">
            <div className="grid grid-cols-2 gap-3 border-2 border-[#8b4444] bg-[#0f0f0f] p-2">
              <button
                type="button"
                onClick={() => setActiveTab('login')}
                className={`px-4 py-3 text-xs font-black uppercase tracking-[0.2em] transition ${
                  activeTab === 'login' ? 'border-2 border-[#d4a574] bg-[#5a2a2a] text-[#e8d7c6]' : 'border-2 border-[#5a2a2a] bg-[#2a1a1a] text-[#b0a095] hover:text-[#e8d7c6]'
                }`}
              >
                Login
              </button>
              <button
                type="button"
                onClick={() => setActiveTab('announcement')}
                className={`px-4 py-3 text-xs font-black uppercase tracking-[0.2em] transition ${
                  activeTab === 'announcement' ? 'border-2 border-[#d4a574] bg-[#5a2a2a] text-[#e8d7c6]' : 'border-2 border-[#5a2a2a] bg-[#2a1a1a] text-[#b0a095] hover:text-[#e8d7c6]'
                }`}
              >
                Word
              </button>
            </div>
          </div>

          <div className="space-y-6 px-8 py-8">
            {activeTab === 'login' ? (
              <>
                <label className="block text-xs font-semibold uppercase tracking-[0.25em] text-[#b0a095]" htmlFor="role">
                  Your Role
                </label>
                <select
                  id="role"
                  value={selectedRole}
                  onChange={(event) => setSelectedRole(event.target.value as ClubRole)}
                  className="w-full border-2 border-[#8b4444] bg-[#0f0f0f] px-4 py-3 text-[#e8d7c6] outline-none transition focus:border-[#d4a574] focus:bg-[#1a1a1a]"
                >
                  {roleRoutes.map((item) => (
                    <option key={item.role} value={item.role}>
                      {item.label}
                    </option>
                  ))}
                </select>

                <label className="block text-xs font-semibold uppercase tracking-[0.25em] text-[#b0a095]" htmlFor="pin">
                  PIN
                </label>
                <input
                  id="pin"
                  type="password"
                  inputMode="numeric"
                  value={pin}
                  onChange={(event) => setPin(event.target.value)}
                  placeholder="Enter PIN"
                  className="w-full border-2 border-[#8b4444] bg-[#0f0f0f] px-4 py-3 text-[#e8d7c6] outline-none transition placeholder-[#6a5a4a] focus:border-[#d4a574] focus:bg-[#1a1a1a]"
                />

                {error ? <p className="text-sm text-[#a0714f]">{error}</p> : null}

                <button
                  type="button"
                  onClick={signIn}
                  className="mt-4 inline-flex w-full items-center justify-center border-2 border-[#8b4444] bg-[#5a2a2a] px-4 py-3 text-sm font-black uppercase tracking-[0.2em] text-[#e8d7c6] transition hover:border-[#d4a574] hover:bg-[#6b3a3a] hover:text-[#f0e8d8]"
                >
                  Sign In
                </button>
              </>
            ) : (
              <>
                <div className="border-2 border-[#8b0000] bg-[#0f0f0f] p-4">
                  <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[#c85a17]">Message</p>
                  <p className="mt-3 text-sm leading-6 text-[#c0c0c0]">{announcement}</p>
                  {announcementSavedAt ? (
                    <p className="mt-3 text-[11px] font-mono text-[#8a8a8a]">Updated: {announcementSavedAt}</p>
                  ) : null}
                </div>

                <p className="text-xs uppercase tracking-[0.18em] text-[#8a8a8a]">Admin only</p>

                <label className="block text-xs font-semibold uppercase tracking-[0.2em] text-[#c0c0c0]" htmlFor="announcement-draft">
                  Announcement
                </label>
                <textarea
                  id="announcement-draft"
                  value={draftAnnouncement}
                  onChange={(event) => setDraftAnnouncement(event.target.value)}
                  rows={4}
                  className="w-full border-2 border-[#8b0000] bg-[#0f0f0f] px-4 py-3 text-[#e5e5e5] outline-none transition placeholder-[#666666] focus:border-[#dc2626] focus:bg-[#1a1a1a]"
                  placeholder="Type message for members..."
                />

                <label className="block text-xs font-semibold uppercase tracking-[0.2em] text-[#c0c0c0]" htmlFor="admin-pin">
                  Admin PIN
                </label>
                <input
                  id="admin-pin"
                  type="password"
                  inputMode="numeric"
                  value={adminPin}
                  onChange={(event) => setAdminPin(event.target.value)}
                  placeholder="Enter admin PIN"
                  className="w-full border-2 border-[#8b0000] bg-[#0f0f0f] px-4 py-3 text-[#e5e5e5] outline-none transition placeholder-[#666666] focus:border-[#dc2626] focus:bg-[#1a1a1a]"
                />

                {announcementError ? <p className="text-sm text-[#ff6b6b]">{announcementError}</p> : null}

                <button
                  type="button"
                  onClick={publishAnnouncement}
                  className="mt-2 inline-flex w-full items-center justify-center border-2 border-[#8b0000] bg-[#1a1a1a] px-4 py-3 text-sm font-black uppercase tracking-[0.2em] text-[#c0c0c0] transition hover:border-[#dc2626] hover:bg-[#2a1a1a] hover:text-[#e5e5e5]"
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