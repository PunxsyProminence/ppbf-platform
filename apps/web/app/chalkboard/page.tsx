'use client';

import Link from 'next/link';

import Chalkboard from '@/components/Chalkboard';
import RoleSessionGate from '@/components/RoleSessionGate';
import type { AnnouncementPlacement } from '@/components/AnnouncementBanner';

/**
 * /chalkboard -- the boards, from behind the desk.
 *
 * The board itself hangs on the dashboards, where the people who read it are.
 * But a board is only a board if somebody can walk up and change it, and the
 * dashboards it hangs on are role-gated to the people who read them: an athlete
 * workspace is athlete-only, a parent hub is parent-only. So a coach would
 * never once encounter the chalk.
 *
 * This is the staff side of the same object. Every board the app draws, in one
 * place, live, each one writable by the same component members see. Nothing new
 * is stored: it renders Chalkboard.tsx, which reads and writes
 * pilot.announcements through the endpoints /notices already uses.
 *
 * IT DOES NOT REPLACE /notices. That page is the full record -- every item ever
 * posted, its schedule window, its lifecycle, and the retire control. This is
 * the two-second version: read the board, rub it out, write the new line. A gym
 * needs both, and they are the same rows.
 */

const BOARDS: ReadonlyArray<{ placement: AnnouncementPlacement; where: string; who: string }> = [
  {
    placement: 'everywhere',
    where: 'Everywhere',
    who: 'Parents see this one. It is the only placement the parent hub draws, because the vocabulary names no parent surface.',
  },
  {
    placement: 'athlete_workspace',
    where: 'The athletes’ board',
    who: 'On every athlete’s own dashboard, under their fight card.',
  },
  {
    placement: 'coach_workspace',
    where: 'The coaches’ board',
    who: 'Coaches only. Nothing written here reaches a member.',
  },
];

function ChalkboardDesk() {
  return (
    <main className="room room--office min-h-screen">
      <div className="mx-auto w-full max-w-4xl px-[var(--s5)] py-[var(--s7)]">
        <header className="border-b-[3px] border-[color:var(--brass-700)] pb-[var(--s5)]">
          <p className="t-eyebrow">Gym Communications</p>
          <h1 className="mt-[var(--s3)] font-display text-[length:var(--t-xl)] text-[color:var(--bone-100)]">
            The boards
          </h1>
          <p className="mt-[var(--s4)] max-w-[62ch] text-[length:var(--t-sm)] leading-7 text-[color:var(--bone-300)]">
            One line each, in your own words, changed whenever you feel like it. Writing on a board rubs out
            whatever was on it for everybody who sees it — there is no history on the wall, and that is the point.
          </p>
        </header>

        <div className="mt-[var(--s6)] flex flex-col gap-[var(--s7)]">
          {BOARDS.map((board) => (
            <section key={board.placement}>
              <p className="text-[length:var(--t-md)] font-semibold text-[color:var(--bone-100)]">{board.where}</p>
              <p className="mt-[var(--s2)] max-w-[62ch] text-[length:var(--t-xs)] leading-6 text-[color:var(--bone-400)]">
                {board.who}
              </p>
              <Chalkboard placement={board.placement} className="mt-[var(--s4)]" />
            </section>
          ))}
        </div>

        <p className="mt-[var(--s7)] flex flex-wrap gap-[var(--s3)]">
          <Link href="/notices" className="btn btn--ghost">
            The full record, with windows and retiring
          </Link>
        </p>
      </div>
    </main>
  );
}

export default function ChalkboardPage() {
  /* Same roles /notices admits. The server is the real gate: the post endpoint
     requires a Microsoft-authenticated principal and derives the author role
     from the session, so nothing this page renders can widen who may write. */
  return (
    <RoleSessionGate allowedRoles={['coach', 'admin', 'platform_owner', 'board']}>
      <ChalkboardDesk />
    </RoleSessionGate>
  );
}
