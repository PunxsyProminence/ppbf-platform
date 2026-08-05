import type { Metadata } from 'next';

import RoleSessionGate from '@/components/RoleSessionGate';
import WallOfNames from '@/components/WallOfNames';

/**
 * /names -- the Wall of Names.
 *
 * The route is the object, like /wall is. "The names" is what a coach says out
 * loud, and it is short enough to type.
 *
 * BEHIND A SESSION, which /wall deliberately is not. The television has no
 * keyboard and is bolted to a wall in one room; this is a page on the open
 * internet, so it takes the stricter option. Every signed-in role may read it,
 * because the payload is initials and years and carries no per-person fact at
 * all -- see app/api/pilot/wall-of-names/route.ts.
 */
export const metadata: Metadata = {
  title: 'The Wall of Names',
  description: 'Everyone who has come through Punxsy Prominence Boxing and Fitness.',
  // A record for the people in this gym, not a document for a search engine.
  robots: { index: false, follow: false },
};

export default function WallOfNamesPage() {
  return (
    <RoleSessionGate
      allowedRoles={[
        'athlete',
        'coach',
        'parent',
        'admin',
        'platform_owner',
        'staff',
        'volunteer',
        'board',
      ]}
    >
      <WallOfNames />
    </RoleSessionGate>
  );
}
