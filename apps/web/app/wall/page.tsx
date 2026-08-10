import type { Metadata } from 'next';

import WallDisplay from '@/components/WallDisplay';

/**
 * /wall -- the gym's television.
 *
 * The name is the object, not the technology. "The wall" is already a noun in
 * this building (words on the wall, the wall of names on the Phase 2 list) and
 * it is what a coach will say out loud: put it up on the wall. /floor-display
 * describes a peripheral; /wall describes a place. It is also short enough to
 * type into a TV browser's address bar with a remote control, which is the
 * actual setup ritual for this route and is not a small consideration when the
 * alternative is thirteen more characters on an on-screen keyboard.
 *
 * There is no session gate here on purpose -- see app/api/pilot/wall/route.ts
 * for why, and for what the payload is allowed to contain because of it.
 */
export const metadata: Metadata = {
  title: 'The Wall',
  description: 'Punxsy Prominence Boxing and Fitness — the board on the gym floor.',
  // A display, not a document. Nothing here should be indexed, and the names
  // on it are gated for the room they are in, not for a search result.
  robots: { index: false, follow: false },
};

export default function WallPage() {
  return <WallDisplay />;
}
