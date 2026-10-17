'use client';

import Link from 'next/link';
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
    '/coach/athlete-intelligence',
    '/coach/decision-loop',
  ],
  sparring: ['/coach/sparring-caps', '/coach/sparring-exposure', '/athlete/dashboard/sparring', '/coach/athlete-limits'],
  interventions: ['/coach/intervention-protocols', '/coach/intervention-executions', '/coach/intervention-review'],
  film: [
    '/coach/video-analysis',
    '/coach/video-publications',
    '/coach/video-publications/library',
    '/teach-shadow',
    '/teach-shadow/capture',
    '/teach-shadow/cut',
    '/teach-shadow/annotation',
    '/teach-shadow/agreement',
  ],
  planning: [
    '/coach/workout-templates',
    '/coach/session-scripts',
    '/coach/cards',
    '/coach/development-blocks',
    '/coach/floor-groups',
  ],
} as const;

export type CoachCluster = keyof typeof COACH_CLUSTERS;

const CLUSTER_NAMES: Record<CoachCluster, string> = {
  'who-needs-me': 'Who needs you',
  sparring: 'Sparring',
  interventions: 'Interventions',
  film: 'Film',
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
              <Link href={door!.href} className="underline">
                {door!.label}
              </Link>
            </li>
          ),
        )}
      </ul>
    </nav>
  );
}
