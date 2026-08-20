'use client';

import { useMemo, useState, useSyncExternalStore } from 'react';
import Link from 'next/link';

import RoleSessionGate from '@/components/RoleSessionGate';
import {
  ROOM_BLURB,
  ROOM_LABEL,
  doorsByRoom,
  visibleDoors,
} from '@/components/buildingMap';
import { getRoleSessionSnapshot, subscribeRoleSession } from '@/components/roleSession';
import type { ClubRole } from '@/components/roleRoutes';

/**
 * THE DOOR REGISTER — a map of the building, NOT a window into an account.
 *
 * The owner wanted to read through what each role's navigation looks like
 * without signing in as those people. There are two ways to build that and
 * only one of them is this file:
 *
 *   (a) impersonation -- mint or widen a principal, call the APIs as that
 *       role, render what comes back. That is the authorization chokepoint,
 *       and this feature is deliberately nowhere near it.
 *   (b) STRUCTURE ONLY -- read the route metadata that already exists in
 *       buildingMap.ts (path, label, room, which roles hold the door) and
 *       show it grouped by role. Nothing is fetched, nothing is impersonated,
 *       and no athlete, guardian or staff record appears anywhere.
 *
 * This is (b), and the following are load-bearing rather than incidental:
 *
 *   - THIS PAGE PERFORMS NO FETCH. Not to /api/pilot/*, not to anything. The
 *     whole register is a pure function of a module-level constant, so there
 *     is no request to get wrong and no response to leak. Pinned by
 *     page.test.tsx, which fails the render if `fetch` is called at all and
 *     also reads this source for the word.
 *   - IT NEVER TOUCHES THE READER'S SESSION. Previewing a role is `useState`
 *     on this page and nothing else. roleSession.ts holds the authoritative
 *     client session as a module-level cache behind the HttpOnly server
 *     cookie, and this page only ever READS the snapshot -- so the corridor,
 *     the session bar and every API the reader talks to are all unchanged by
 *     what is picked here. Pinned by comparing that snapshot BY REFERENCE
 *     across previewing every role, which a re-mint of the same role fails.
 *   - `roles` IN buildingMap.ts IS A VISIBILITY HINT, NEVER AN AUTHORIZATION
 *     DECISION (that file's own header). So is every row on this page. What
 *     this register shows is what the CORRIDOR would offer that role; the
 *     page guard and then the API remain the authority. A row here is a claim
 *     about the catalog, not a grant.
 *
 * THE CLICKABLE RULE, which is the part most likely to mislead somebody.
 *
 * A link on this page opens the real route WITH THE READER'S OWN PERMISSIONS.
 * There is no such thing as following a link "as the coach". So a door is a
 * link only when the reader's OWN session can see it -- the same
 * visibleDoors() predicate the corridor uses -- and plain text otherwise. The
 * two cases are also named in words in their own column, because an admin who
 * believes they are looking at a coach's screen when they are looking at their
 * own is worse than not having this page at all.
 */

/**
 * The signed-out reader, as a preview subject.
 *
 * visibleDoors(null) is a first-class case in buildingMap.ts -- it answers
 * with the OPEN surfaces, which is exactly what a visitor with no session
 * sees. It is offered here because "what does somebody who is not signed in
 * find" is a real question about the building, and the alternative is the
 * owner guessing.
 */
const SIGNED_OUT = 'signed-out' as const;
type Subject = ClubRole | typeof SIGNED_OUT;

/**
 * Who the register can be read for, in the order the front desk thinks about
 * the gym: the people who train, then the people who run it.
 *
 * The eight board SEAT roles in roleRoutes.ts are deliberately absent. No door
 * in buildingMap.ts names one: a seat holder's session role is 'board' with
 * the seat carried alongside it (roleSession.ts), so offering "Treasurer" here
 * would answer with the ungated surfaces only and teach the reader that a
 * treasurer sees almost nothing. page.test.tsx derives the roles the map
 * actually names and fails if this list stops covering them, so a door that
 * starts naming a seat becomes somebody's decision instead of a silent gap.
 */
const SUBJECTS: readonly Subject[] = [
  'athlete', 'parent', 'coach', 'staff', 'volunteer', 'admin', 'board', 'platform_owner', SIGNED_OUT,
];

const SUBJECT_LABEL: Record<Subject, string> = {
  athlete: 'Athlete',
  parent: 'Parent',
  coach: 'Coach',
  staff: 'Staff',
  volunteer: 'Volunteer',
  admin: 'Admin',
  board: 'Board',
  platform_owner: 'Platform Owner',
  'board-president': 'President',
  'board-chair': 'Chair',
  'board-vice-chair': 'Vice Chair',
  'board-treasurer': 'Treasurer',
  'board-secretary': 'Secretary',
  'board-safety-director': 'Safety Director',
  'board-community-director': 'Community Director',
  'board-at-large': 'At Large',
  [SIGNED_OUT]: 'Nobody signed in',
};

/** A line of context for the subjects whose audience is easy to read wrongly. */
const SUBJECT_NOTE: Partial<Record<Subject, string>> = {
  platform_owner:
    'Broader across the building and strictly narrower inside a record: Omega is refused '
    + 'every athlete-scoped record, so it is not a wildcard and holds fewer doors than an '
    + 'admin in several rooms.',
  board:
    'The eight seats all sign in as Board. A seat is carried alongside the role, not as a '
    + 'role of its own, so the register is the same for every seat.',
  [SIGNED_OUT]:
    'What a visitor finds with no session at all — the ungated surfaces, and nothing else.',
};

/** The role for the map's own lookup: the signed-out subject is a null session. */
function subjectRole(subject: Subject): ClubRole | null {
  return subject === SIGNED_OUT ? null : subject;
}

export default function DoorRegisterPage() {
  /* The reader's own session, read the way the corridor and the card catalog
     read it -- from the store, not from a request. This decides which rows are
     links and nothing else. */
  const session = useSyncExternalStore(subscribeRoleSession, getRoleSessionSnapshot, () => null);
  const viewerRole = session?.role ?? null;

  /* The previewed role. Local state, and local state only: previewing does not
     touch the stored session, so the corridor, the session bar and every API
     the reader talks to are all unchanged by what is picked here. */
  const [subject, setSubject] = useState<Subject | null>(null);

  const groups = useMemo(
    () => (subject === null ? [] : doorsByRoom(subjectRole(subject))),
    [subject],
  );

  /* Which doors the READER can open, by the same predicate the corridor uses,
     so this page never offers a door the corridor would not. */
  const openToViewer = useMemo(
    () => new Set(visibleDoors(viewerRole).map((door) => door.href)),
    [viewerRole],
  );

  const doorCount = groups.reduce((total, group) => total + group.doors.length, 0);

  return (
    <RoleSessionGate allowedRoles={['admin', 'platform_owner']}>
      <main className="room room--office min-h-screen bg-[var(--hide-950)] px-[var(--s4)] py-[var(--s6)] text-[color:var(--bone-200)] sm:px-[var(--s5)]">
        <div className="mx-auto w-full max-w-5xl space-y-[var(--s5)]">
          {/* The desk lamp — the office's own fixture, over the desk you are
              standing at (Room DNA: plank wall, desk lamp, paper forms). */}
          <header className="relative mat-leather rounded-[var(--r-lg)] border border-[color:rgba(212,175,74,.22)] p-[var(--s5)]">
            <span className="lamp" aria-hidden="true" style={{ left: '50%', translate: '-50% 0' }} />
            <p className="t-eyebrow">Admin Workspace</p>
            <h1 className="t-command mt-[var(--s3)]" style={{ fontSize: 'var(--t-xl)' }}>Door Register</h1>
            <p className="t-body mt-[var(--s3)] max-w-3xl">
              Every door in the building, filed by the room it opens onto. Pick a role to read the
              register the way that role would find it — the rooms it enters, and the label, path
              and room of each door it holds.
            </p>
            <p className="t-body mt-[var(--s3)] max-w-3xl">
              This is the map of the building, not a way into anybody&rsquo;s account. It lists
              routes and nothing else: no athlete, guardian or staff record is read here, and
              nothing is requested on a previewed role&rsquo;s behalf.
            </p>
            <div className="mt-[var(--s4)] flex flex-wrap gap-[var(--s3)]">
              <Link href="/admin" className="btn btn--ghost">Back to Admin</Link>
            </div>
          </header>

          {/* The form on the desk. Levers rather than a <select>, because the
              set is small and the whole point of the page is to move between
              roles quickly; aria-pressed carries which one is pulled, the same
              way the tab rail on /admin/people states its current tab. */}
          <section className="mat-leather rounded-[var(--r-lg)] border border-[color:rgba(212,175,74,.14)] p-[var(--s5)]">
            <h2 className="t-eyebrow" id="register-subject-label">Read the register for</h2>
            <div
              role="group"
              aria-labelledby="register-subject-label"
              className="mt-[var(--s3)] flex flex-wrap gap-[var(--s3)]"
            >
              {SUBJECTS.map((option) => (
                <button
                  key={option}
                  type="button"
                  aria-pressed={subject === option}
                  onClick={() => setSubject(option)}
                  className={`btn--lever min-h-[44px] ${
                    subject === option ? 'border-[color:var(--brass-400)] text-[color:var(--bone-100)]' : ''
                  }`}
                >
                  {SUBJECT_LABEL[option]}
                </button>
              ))}
            </div>

            {subject !== null && SUBJECT_NOTE[subject] ? (
              <p className="t-body mt-[var(--s4)] max-w-3xl" style={{ fontSize: 'var(--t-sm)' }}>
                {SUBJECT_NOTE[subject]}
              </p>
            ) : null}
          </section>

          {subject === null ? (
            /* The desk before anybody has asked for anything. The DNA's own
               named motion for an office surface with nothing on it yet. */
            <div className="mat-leather rounded-[var(--r-lg)]">
              <div className="empty">
                <div className="empty-glyph" aria-hidden="true">▤</div>
                <div className="empty-title">No role picked yet</div>
                <p className="empty-msg mx-auto">
                  Choose a role above and the register opens on the doors that role holds, room by
                  room. Nothing is looked up until you do.
                </p>
                <div className="empty-action">
                  <button type="button" onClick={() => setSubject('coach')} className="btn--lever min-h-[44px]">
                    Start with Coach
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <>
              {/* Stated before the register rather than after it, because it is
                  the one thing a reader can get wrong here. */}
              <section className="mat-leather rounded-[var(--r-lg)] border border-[color:rgba(212,175,74,.14)] p-[var(--s5)]">
                <h2 className="t-eyebrow">About the links below</h2>
                <p className="t-body mt-[var(--s3)] max-w-3xl">
                  A link opens the real page <strong>with your own permissions</strong>, never with{' '}
                  {SUBJECT_LABEL[subject]}&rsquo;s. There is no way to walk through a door as somebody
                  else, and this page does not pretend there is. So a door is a link only when your
                  own session can reach it; every other door is printed as plain text, and the
                  <span className="t-data"> Opens for you</span> column says which is which.
                </p>
              </section>

              <section className="mat-paper overflow-x-auto rounded-[var(--r-lg)] p-[var(--s5)]">
                <div className="mb-[var(--s3)] flex flex-wrap items-center gap-[var(--s3)]">
                  <span className="stamp stamp--brass stamp--flat stamp--sm">Structure only</span>
                  <span className="t-label">
                    {doorCount} {doorCount === 1 ? 'door' : 'doors'} across{' '}
                    {groups.length} {groups.length === 1 ? 'room' : 'rooms'}
                  </span>
                </div>

                {/* Which rooms this role stands in, said once. ROOM_BLURB is a
                    sentence about the ROOM, not about the door, so it belongs
                    here rather than repeated down forty rows of the sheet.
                    There is no empty branch under this: every role sees at
                    least the OPEN surfaces, so a register is never blank. */}
                <dl className="mb-[var(--s4)] grid gap-[var(--s2)] sm:grid-cols-2">
                  {groups.map((group) => (
                    <div key={group.room} className="flex flex-wrap items-baseline gap-[var(--s2)]">
                      <dt className="t-label">
                        {ROOM_LABEL[group.room]} · {group.doors.length}
                      </dt>
                      <dd className="t-body" style={{ fontSize: 'var(--t-sm)' }}>
                        {ROOM_BLURB[group.room]}
                      </dd>
                    </div>
                  ))}
                </dl>

                {/* One ruled sheet, not six. .ledger is the office's own record
                    -- "every row is auditable" -- and a register is one book:
                    the rooms are <tbody> groups inside it, in ROOM_ORDER, so
                    the grouping buildingMap.ts already carries is what orders
                    the page. The Room column then repeats that per row on
                    purpose, so a single row lifted out of the sheet still says
                    which room it belongs to. */}
                <table className="ledger">
                  <caption className="text-left">
                    Doors open to {SUBJECT_LABEL[subject]}
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">Room</th>
                      <th scope="col">Door</th>
                      <th scope="col">Path</th>
                      <th scope="col">Opens for you</th>
                    </tr>
                  </thead>
                  {groups.map((group) => (
                    <tbody key={group.room}>
                      {group.doors.map((door) => {
                        const readerCanOpen = openToViewer.has(door.href);
                        return (
                          <tr key={door.href}>
                            <td>{ROOM_LABEL[group.room]}</td>
                            <td>
                              {readerCanOpen ? (
                                /* Ink stated rather than inherited. ppbf.css
                                   styles a bare anchor for .on-canvas only, so
                                   a link on .mat-paper falls through to the
                                   host app's `a` rule -- which is the safety
                                   ladder's red. --brass-800 is the same ink
                                   that sheet already gives a link on a light
                                   ground; it is not a new value. */
                                <Link
                                  href={door.href}
                                  className="text-[color:var(--brass-800)] underline"
                                >
                                  {door.label}
                                </Link>
                              ) : (
                                door.label
                              )}
                              {door.hint ? <span className="ledger-id block">{door.hint}</span> : null}
                            </td>
                            <td className="rule-v">{door.href}</td>
                            <td className="rule-v">
                              {readerCanOpen ? 'Yes — with your own access' : 'No — not a door you hold'}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  ))}
                </table>
              </section>
            </>
          )}
        </div>
      </main>
    </RoleSessionGate>
  );
}
