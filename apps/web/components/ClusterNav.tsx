'use client';

// ChromeLink, not next/link: this line sits on /teach-shadow/capture, a camera
// document, where a soft navigation would carry the camera grant off the page
// (cameraDocumentNavigation.test.ts).
import ChromeLink from './ChromeLink';
import { usePathname } from 'next/navigation';
import { useSyncExternalStore } from 'react';
import { visibleDoors } from './buildingMap';
import { getRoleSessionSnapshot, subscribeRoleSession } from './roleSession';

/**
 * ONE LINE THAT TIES A CLUSTER OF COACH PAGES TOGETHER (lane U2, audit UX-A
 * A-11; Jason 2026-10-17, "A: Cross-link now (Recommended)": no merges, each
 * group gets a shared one-line sub-nav).
 *
 * Several pages each do one part of one job -- who needs me, sparring,
 * interventions, film, planning -- and none said the others existed. Each
 * page of a group renders this line, naming every page in the group.
 *
 * Labels and roles come from the building map's own door for each page, so
 * the line and the catalog cannot name a page two ways, and a reader is shown
 * only the pages their role may open (clusterNav.test.tsx checks each door's
 * roles against the page's own gate).
 */

export const COACH_CLUSTERS = {
  'who-needs-me': [
    '/coach/intelligence',
    '/coach/performance-analytics',
    '/coach/passbook-gaps',
    // Lane W4-6, SC-2 (Overwatch, W4-6 Q5 A).
    '/coach/stopped-coming',
    '/coach/athlete-intelligence',
    '/coach/decision-loop',
  ],
  // The clinic's records of one athlete (app scrub CS-02, lane AS-5).
  clinic: ['/coach/sports-medicine', '/coach/athlete-safety', '/coach/sparring-exposure'],
  interventions: ['/coach/intervention-protocols', '/coach/intervention-executions', '/coach/intervention-review'],
  film: ['/coach/video-analysis', '/coach/video-publications', '/coach/video-publications/library'],
  // Teach Shadow is its own room, not part of Film Study (app scrub CS-13;
  // lane AS4-4D4E, Q3 = A on #2128).
  'teach-shadow': [
    '/teach-shadow',
    '/teach-shadow/capture',
    '/teach-shadow/cut',
    '/teach-shadow/annotation',
    '/teach-shadow/agreement',
  ],
  // Class plans and Library were menu-only, linked only to each other (app
  // scrub CF-10; lane AS4-4D4E).
  planning: [
    '/coach/workout-templates',
    '/coach/class-plans',
    '/coach/library',
    '/coach/session-scripts',
    '/coach/cards',
    '/coach/development-blocks',
    '/coach/floor-groups',
  ],
} as const;

export type CoachCluster = keyof typeof COACH_CLUSTERS;

const CLUSTER_NAMES: Record<CoachCluster, string> = {
  'who-needs-me': 'Who needs you',
  // The room's own name (buildingMap ROOM_LABEL) and the coach home's heading.
  clinic: 'Clinic',
  interventions: 'Interventions',
  film: 'Film',
  'teach-shadow': 'Teach Shadow',
  planning: 'Planning',
};

export default function ClusterNav({ cluster }: { readonly cluster: CoachCluster }) {
  const pathname = usePathname();
  const session = useSyncExternalStore(subscribeRoleSession, getRoleSessionSnapshot, () => null);
  const role = session?.role ?? null;
  // The corridor's own visibility rule, so the line and the corridor agree.
  const doors = role ? visibleDoors(role) : [];
  const pages = COACH_CLUSTERS[cluster]
    .map((href) => doors.find((door) => door.href === href))
    .filter((door) => door !== undefined);
  // A line with only the page you are on links nowhere.
  if (pages.length < 2) return null;
  return (
    <nav aria-label={CLUSTER_NAMES[cluster]} className="mt-[var(--s3)]">
      <ul className="flex flex-wrap items-center gap-x-[var(--s4)] gap-y-[var(--s2)] t-label">
        <li className="text-[color:var(--bone-400)]">{CLUSTER_NAMES[cluster]}:</li>
        {pages.map((door) =>
          door!.href === pathname ? (
            <li key={door!.href}>
              <span aria-current="page" className="text-[color:var(--bone-100)]">{door!.label}</span>
            </li>
          ) : (
            <li key={door!.href}>
              {/* tap-link: 55px where the page is a kiosk surface (app/globals.css;
                  app scrub CF-17, CS-11). On a desk page it changes nothing. */}
              <ChromeLink href={door!.href} className="tap-link underline">
                {door!.label}
              </ChromeLink>
            </li>
          ),
        )}
      </ul>
    </nav>
  );
}
