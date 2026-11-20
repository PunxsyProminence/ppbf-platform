'use client';

import Link from 'next/link';
import { useSyncExternalStore } from 'react';
import { visibleDoors, type Door } from './buildingMap';
import { ATHLETE_RECORD_PAGES, PASSBOOK_PAGE } from './athleteRecordPages';
import { handOffArrivalAthlete, isPlainClick } from './decisionLoopArrival';
import { getRoleSessionSnapshot, subscribeRoleSession } from './roleSession';

/**
 * THE REST OF ONE ATHLETE'S RECORD, ONE TAP FROM THEIR PASSBOOK (lane AS-11,
 * app scrub CF-15; Q1 = A: Passbook is the athlete page, Q2 = A: the pages it
 * names).
 *
 * Each link opens its page on this athlete. The athlete travels in page
 * memory, keyed to the page the link opens, and only on a plain click; no
 * athlete id goes in an address (#1474 Q2 = C; AS-11 Q3 = A). The page that
 * arrives chooses the athlete only if its own roster, which the server
 * answers, lists them.
 *
 * Labels and roles are the building map's own door for each page, as
 * ClusterNav does it, so a label is the page's own name and a role is shown
 * only the pages it may open (an admin is not shown Coach Cards). The line
 * has no words of its own: it is named by the heading that carries the
 * athlete's name (`labelledBy`).
 */
export default function AthleteRecordLinks({
  athleteId,
  labelledBy,
}: {
  readonly athleteId: string;
  readonly labelledBy: string;
}) {
  const session = useSyncExternalStore(subscribeRoleSession, getRoleSessionSnapshot, () => null);
  const role = session?.role ?? null;
  const doors = role ? visibleDoors(role) : [];
  const pages = ATHLETE_RECORD_PAGES.map((href) => doors.find((door) => door.href === href)).filter(
    (door): door is Door => door !== undefined,
  );
  if (pages.length === 0) return null;
  return (
    <nav aria-labelledby={labelledBy} className="mt-[var(--s4)]">
      <ul className="flex flex-wrap gap-[var(--s3)]">
        {pages.map((door) => (
          <li key={door.href}>
            {/* Links skip the app's tap floor (globals.css), so each one
                carries the gym-floor height and the kiosk type size itself. */}
            <Link
              href={door.href}
              className="btn btn--ghost min-h-[var(--tap)] text-[length:var(--t-md)]"
              onClick={(event) => {
                if (isPlainClick(event)) handOffArrivalAthlete(athleteId, door.href);
              }}
            >
              {door.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/**
 * AN ATHLETE'S NAME THAT OPENS THEIR PASSBOOK, the athlete page (lane AS-11
 * Q4 = A: the Morning Read's reads, What We Learned and The Work). The same
 * hand-off as the line above: page memory, a plain click, never the address.
 * A link skips the app's tap floor, so this one carries the gym-floor height
 * and the kiosk type size itself.
 */
export function AthleteNameLink({ athleteId, name }: { readonly athleteId: string; readonly name: string }) {
  return (
    <Link
      href={PASSBOOK_PAGE}
      className="inline-flex min-h-[var(--tap)] items-center font-semibold text-[length:var(--t-md)] text-[color:var(--bone-100)] underline"
      onClick={(event) => {
        if (isPlainClick(event)) handOffArrivalAthlete(athleteId, PASSBOOK_PAGE);
      }}
    >
      {name}
    </Link>
  );
}
