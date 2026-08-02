'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

import RoleSessionGate from '@/components/RoleSessionGate';
import ShadowChatButton from '@/components/ShadowChatButton';
import { clearRoleSession } from '@/components/roleSession';
import { usePilotSession } from '@/components/usePilotSession';
import { revokeShadowSession } from '@/client/shadowLogout';
import { apiBase } from '@/lib/apiBase';

interface WorkspaceNotice {
  announcement_id: string;
  message: string;
  author_name: string;
  author_role: string;
  created_at: string;
}

interface WorkspaceSurface {
  href: string;
  label: string;
  description: string;
}

// Every entry is checked against the role allowlist of the API it depends on:
// SHADOW chat, sessions and feedback name 'staff' and 'volunteer' explicitly,
// and the Library/research reads run on SHADOW_PROJECTION_READ_ROLES, which
// includes both through ORGANIZATION_MEMBER_ROLES. Anything backed by a route
// that would answer 403 -- athlete records, the class scheduler, video, intake,
// admin and board surfaces -- stays off this list on purpose.
const WORKSPACE_SURFACES: WorkspaceSurface[] = [
  {
    href: '/shadow',
    label: 'SHADOW Chat',
    description: 'Ask about your role, gym doctrine, and what SHADOW can and cannot support. Saved conversations are kept on the server under your account.',
  },
  {
    href: '/research/chat',
    label: 'The Library',
    description: "Search your organization's approved evidence. Answers come only from sources a reviewer approved.",
  },
  {
    href: '/research',
    label: 'Research Intake',
    description: 'See open research requirements and log a knowledge gap when the Library has no answer.',
  },
  {
    href: '/help',
    label: 'Help Center',
    description: 'How the platform is laid out and what each workspace is for.',
  },
];

const ROLE_LABELS: Record<string, string> = {
  staff: 'Staff',
  volunteer: 'Volunteer',
};

function formatNoticeDate(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? '' : parsed.toLocaleDateString();
}

function WorkspaceContent() {
  const router = useRouter();
  const session = usePilotSession();
  const [notices, setNotices] = useState<WorkspaceNotice[]>([]);
  const [noticesLoading, setNoticesLoading] = useState(true);
  const [noticesError, setNoticesError] = useState('');
  const [signingOut, setSigningOut] = useState(false);

  useEffect(() => {
    const controller = new AbortController();

    void (async () => {
      try {
        const response = await fetch(`${apiBase()}/api/pilot/announcements/get`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ limit: 5 }),
          signal: controller.signal,
        });

        if (controller.signal.aborted) {
          return;
        }

        if (!response.ok) {
          setNoticesError('Gym notices are temporarily unavailable.');
          setNoticesLoading(false);
          return;
        }

        const payload = (await response.json()) as { announcements?: WorkspaceNotice[] };
        setNotices(Array.isArray(payload.announcements) ? payload.announcements : []);
        setNoticesLoading(false);
      } catch (error) {
        if (controller.signal.aborted || (error instanceof Error && error.name === 'AbortError')) {
          return;
        }
        setNoticesError('Gym notices are temporarily unavailable.');
        setNoticesLoading(false);
      }
    })();

    return () => {
      controller.abort();
    };
  }, []);

  async function handleSignOut() {
    setSigningOut(true);
    try {
      await revokeShadowSession(apiBase());
    } catch {
      // The server session is the only thing that grants access; if revoking
      // it failed, say so by leaving the page in place rather than clearing
      // the local cache and pretending the account is signed out.
      setSigningOut(false);
      return;
    }
    clearRoleSession();
    router.replace('/login');
  }

  const roleLabel = session.role ? ROLE_LABELS[session.role] ?? session.role : '';

  return (
    <main className="min-h-screen bg-[var(--canvas-tan)] text-[var(--black)]">
      <div className="mx-auto flex min-h-screen w-full max-w-6xl flex-col gap-8 px-6 py-10 lg:px-10">
        <header className="flex flex-col gap-4 border-b-[3px] border-[var(--black)] pb-6 md:flex-row md:items-end md:justify-between">
          <div className="space-y-3">
            <p className="text-xs font-mono uppercase tracking-[0.35em] text-[var(--red-primary)]">Workspace</p>
            <h1 className="font-display text-4xl font-black tracking-tight md:text-5xl">
              {roleLabel ? `${roleLabel} Workspace` : 'Workspace'}
            </h1>
            <p className="max-w-3xl text-base leading-7 text-[var(--gray-dark)]">
              Your account is active at the gym. This page holds the notices you can see and the
              surfaces your role can open.
            </p>
          </div>
          <div className="flex flex-col items-start gap-3 md:items-end">
            <ShadowChatButton context="Workspace" />
            <button
              type="button"
              onClick={() => void handleSignOut()}
              disabled={signingOut}
              className="min-h-[44px] border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] px-4 text-xs font-mono font-bold uppercase tracking-[0.12em] text-[var(--black)] transition hover:bg-[var(--canvas-tan-dark)] disabled:opacity-50"
            >
              {signingOut ? 'Signing out...' : 'Sign out'}
            </button>
          </div>
        </header>

        <section className="border-[3px] border-[var(--black)] bg-[var(--canvas-tan-light)] p-5 shadow-[var(--shadow-sm)]">
          <h2 className="font-display text-xl font-black">Your account</h2>
          <dl className="mt-4 grid gap-4 md:grid-cols-3">
            <div>
              <dt className="text-[11px] font-mono uppercase tracking-[0.15em] text-[var(--gray-dark)]">Signed in as</dt>
              <dd className="mt-1 break-all text-sm font-bold text-[var(--black)]">
                {session.loading ? 'Loading...' : session.accountId ?? 'Unknown'}
              </dd>
            </div>
            <div>
              <dt className="text-[11px] font-mono uppercase tracking-[0.15em] text-[var(--gray-dark)]">Role</dt>
              <dd className="mt-1 text-sm font-bold text-[var(--black)]">
                {session.loading ? 'Loading...' : roleLabel || 'Unknown'}
              </dd>
            </div>
            <div>
              <dt className="text-[11px] font-mono uppercase tracking-[0.15em] text-[var(--gray-dark)]">Organization</dt>
              <dd className="mt-1 break-all text-sm font-bold text-[var(--black)]">
                {session.loading ? 'Loading...' : session.organizationId ?? 'Unknown'}
              </dd>
            </div>
          </dl>
        </section>

        <section className="border-[3px] border-[var(--black)] bg-[var(--canvas-tan-light)] p-5 shadow-[var(--shadow-sm)]">
          <h2 className="font-display text-xl font-black">Gym notices</h2>
          <p className="mt-2 text-sm leading-6 text-[var(--gray-dark)]">
            Posted by coaches, admins, and the board for your organization.
          </p>

          {noticesLoading ? (
            <p className="mt-4 font-mono text-xs uppercase tracking-[0.12em] text-[var(--gray-dark)]">Loading notices...</p>
          ) : noticesError ? (
            <p role="status" className="mt-4 border-2 border-[var(--black)] bg-[var(--canvas-tan)] px-3 py-2 text-sm text-[var(--black)]">
              {noticesError}
            </p>
          ) : notices.length === 0 ? (
            <p className="mt-4 text-sm text-[var(--gray-dark)]">No notices have been posted yet.</p>
          ) : (
            <ul className="mt-4 space-y-3">
              {notices.map((notice) => (
                <li key={notice.announcement_id} className="border-2 border-[var(--black)] bg-[var(--canvas-tan)] p-4">
                  <p className="text-sm leading-6 text-[var(--black)]">{notice.message}</p>
                  <p className="mt-2 text-[11px] font-mono uppercase tracking-[0.12em] text-[var(--gray-dark)]">
                    {notice.author_name} · {notice.author_role} · {formatNoticeDate(notice.created_at)}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="space-y-4">
          <h2 className="font-display text-xl font-black">What you can open</h2>
          <div className="grid gap-4 md:grid-cols-2">
            {WORKSPACE_SURFACES.map((surface) => (
              <article key={surface.href} className="flex flex-col justify-between border-[3px] border-[var(--black)] bg-[var(--canvas-tan-light)] p-5 shadow-[var(--shadow-sm)]">
                <div>
                  <h3 className="font-display text-lg font-black text-[var(--black)]">{surface.label}</h3>
                  <p className="mt-2 text-sm leading-6 text-[var(--gray-dark)]">{surface.description}</p>
                </div>
                <Link
                  href={surface.href}
                  className="mt-4 inline-flex min-h-[44px] items-center justify-center border-2 border-[var(--black)] bg-[var(--canvas-tan)] px-4 text-xs font-mono font-bold uppercase tracking-[0.12em] text-[var(--black)] transition hover:bg-[var(--olive-dark)] hover:text-[var(--white)]"
                >
                  Open {surface.label}
                </Link>
              </article>
            ))}
          </div>
        </section>

        <section className="border-[3px] border-[var(--black)] bg-[var(--canvas-tan)] p-5">
          <h2 className="font-display text-xl font-black">Outside this role</h2>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-[var(--gray-dark)]">
            Athlete records, class scheduling and attendance, video, intake review, and the admin and
            board consoles are not part of staff or volunteer access. If your work needs one of them,
            ask an organization admin to change your role rather than opening a page that will refuse
            you.
          </p>
        </section>
      </div>
    </main>
  );
}

export default function WorkspacePage() {
  return (
    <RoleSessionGate allowedRoles={['staff', 'volunteer']}>
      <WorkspaceContent />
    </RoleSessionGate>
  );
}
