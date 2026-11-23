'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

import RoleSessionGate from '@/components/RoleSessionGate';
import ShadowChatButton from '@/components/ShadowChatButton';
import { usePilotSession } from '@/components/usePilotSession';
import { apiBase } from '@/lib/apiBase';
import { formatGymDateNumeric } from '@/src/lib/gymTime';

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
// SHADOW Chat has no card here: the ShadowChatButton in the header opens it
// (lane AS-10, AS10-6a, OFF-18; Overwatch Q14 A, a named removal).
const WORKSPACE_SURFACES: WorkspaceSurface[] = [
  {
    href: '/research/chat',
    label: 'The Library',
    description: "Search your organization's approved evidence. Answers come only from sources a reviewer approved.",
  },
  {
    href: '/research',
    label: 'Research Inbox',
    description: 'See open research requirements and log a knowledge gap when the Library has no answer.',
  },
  // Lane U2 (audit UX-A A-16): both admit staff and volunteers
  // (coach/credentials and coach/development allowedRoles); labels are their doors'.
  {
    href: '/coach/credentials',
    label: 'My Credentials',
    description: 'Your safeguarding and coaching credentials: what is on file, and uploading a new one.',
  },
  {
    href: '/coach/development',
    label: 'Your Coaching Growth',
    description: 'What you are working to get better at, in your own words.',
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
  return formatGymDateNumeric(parsed) ?? '';
}

function WorkspaceContent() {
  const session = usePilotSession();
  const [notices, setNotices] = useState<WorkspaceNotice[]>([]);
  const [noticesLoading, setNoticesLoading] = useState(true);
  const [noticesError, setNoticesError] = useState('');

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

  const roleLabel = session.role ? ROLE_LABELS[session.role] ?? session.role : '';

  return (
    /* Law 6: a staff/volunteer workspace is a staff surface -- ink leather,
       the front-office room, not the family canvas it wore before. */
    <main className="room room--office min-h-screen bg-[var(--hide-950)] text-[color:var(--bone-200)]">
      <div className="mx-auto flex min-h-screen w-full max-w-[1200px] flex-col gap-[var(--s6)] px-[var(--s5)] py-[var(--s6)]">
        <header className="flex flex-col gap-[var(--s4)] border-b-2 border-[color:var(--brass-700)] pb-[var(--s5)] md:flex-row md:items-end md:justify-between">
          <div>
            <p className="t-eyebrow">Workspace</p>
            <h1 className="t-command mt-[var(--s2)]" style={{ fontSize: 'var(--t-2xl)' }}>
              {roleLabel ? `${roleLabel} Workspace` : 'Workspace'}
            </h1>
            <p className="t-body mt-[var(--s3)] max-w-[64ch]">
              Your account is active at the gym. This page holds the notices you can see and the
              surfaces your role can open.
            </p>
          </div>
          {/* No Sign out of its own: the site header's Logout is on this page
              (lane AS-10, AS10-6a, OFF-18; Overwatch Q14 A, a named removal). */}
          <div className="flex flex-col items-start gap-[var(--s3)] md:items-end">
            <ShadowChatButton context="Workspace" />
          </div>
        </header>

        <section className="mat-leather rounded-[var(--r-lg)] border border-[color:rgb(var(--brass-400-rgb)_/_.22)] p-[var(--s5)]">
          <h2 className="t-command" style={{ fontSize: 'var(--t-md)' }}>Your Account</h2>
          {/* The role in words. The raw account and organization ids are not
              shown (lane AS-10, AS10-6a, OFF-18; Overwatch Q14 A): they meant
              nothing to the person reading, and the session route sends no
              name to show instead. No server change. */}
          <dl className="mt-[var(--s4)]">
            <div>
              <dt className="t-label">Role</dt>
              <dd className="t-body mt-[var(--s2)]">
                {session.loading ? 'Loading...' : roleLabel || 'Unknown'}
              </dd>
            </div>
          </dl>
        </section>

        <section className="mat-leather rounded-[var(--r-lg)] border border-[color:rgb(var(--brass-400-rgb)_/_.22)] p-[var(--s5)]">
          <h2 className="t-command" style={{ fontSize: 'var(--t-md)' }}>Gym Notices</h2>
          <p className="t-muted mt-[var(--s2)]">
            Posted by coaches, admins, and the board for your organization.
          </p>

          {noticesLoading ? (
            <p className="t-label mt-[var(--s4)]">Loading notices...</p>
          ) : noticesError ? (
            <p role="status" className="t-body mt-[var(--s4)] rounded-[var(--r-md)] border border-[color:rgb(var(--brass-400-rgb)_/_.28)] bg-[rgba(0,0,0,.26)] px-[var(--s4)] py-[var(--s3)]">
              {noticesError}
            </p>
          ) : notices.length === 0 ? (
            <p className="t-muted mt-[var(--s4)]">No notices have been posted yet.</p>
          ) : (
            <ul className="mt-[var(--s4)] space-y-[var(--s3)]">
              {/* Each notice is a paper slip tacked to the leather board. */}
              {notices.map((notice) => (
                <li key={notice.announcement_id} className="mat-paper rounded-[var(--r-sm)] p-[var(--s4)]">
                  <p className="t-typed text-[length:var(--t-sm)] leading-relaxed">{notice.message}</p>
                  <p className="mt-[var(--s2)] font-mono text-[length:var(--t-xs)] uppercase tracking-[0.12em] text-[color:var(--hide-600)]">
                    {notice.author_name} · {notice.author_role} · {formatNoticeDate(notice.created_at)}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="space-y-[var(--s4)]">
          <h2 className="t-command" style={{ fontSize: 'var(--t-md)' }}>What You Can Open</h2>
          <div className="grid gap-[var(--s4)] md:grid-cols-2">
            {WORKSPACE_SURFACES.map((surface) => (
              <article key={surface.href} className="mat-leather--raised flex flex-col justify-between rounded-[var(--r-lg)] p-[var(--s5)]">
                <div>
                  <h3 className="t-command" style={{ fontSize: 'var(--t-sm)' }}>{surface.label}</h3>
                  <p className="t-body mt-[var(--s3)]">{surface.description}</p>
                </div>
                <Link href={surface.href} className="btn btn--ghost mt-[var(--s4)] self-start">
                  Open {surface.label}
                </Link>
              </article>
            ))}
          </div>
        </section>

        <section className="mat-leather rounded-[var(--r-lg)] border border-[color:rgb(var(--brass-400-rgb)_/_.14)] p-[var(--s5)]">
          {/* The body underneath was already kind and procedural; only the
              heading was filing-cabinet language for "here is what your sign-in
              does not open". */}
          <h2 className="t-command" style={{ fontSize: 'var(--t-md)' }}>What Your Sign-In Does Not Open</h2>
          <p className="t-body mt-[var(--s3)] max-w-[64ch]">
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
