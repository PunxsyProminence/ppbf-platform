'use client';

import { useMemo, useSyncExternalStore } from 'react';
import { usePathname } from 'next/navigation';

import { openSearchAt, searchGroupLabel } from './CardCatalog';
import { getRoleSessionSnapshot, subscribeRoleSession } from './roleSession';
import { doorForPath } from './buildingMap';
import { searchGroupOf } from './roomPlaces';
import { useRoomNames } from '@/src/client/roomNames';

/**
 * THE CORRIDOR: WHERE YOU ARE STANDING.
 *
 * It was two things: a hallway menu of every room and the doors in it, and the
 * plate on the session bar saying which room you were in. AS-4 (U2-4c) keeps
 * the plate and moves the menu. Jason's S2-2 "A: Job bar + search" replaced the
 * ruling that both header menus stay (OD-2026-11-19-008): "the Rooms list
 * becomes 'All pages' inside Search". So the rooms are now Search's groups
 * (searchGroups, roomPlaces.ts: Home, the Room Map's rooms, then Lab for the
 * admin and the platform owner), and this plate names the one you are in, in
 * the same words. Pressing it opens Search at All pages, at that room.
 *
 * It holds no link. Every page is reached through Search or the job bar, each
 * of which offers only pages the person can open; cameraDocumentNavigation.test
 * keeps it that way.
 */
export default function Corridor() {
  const pathname = usePathname() ?? '';
  const session = useSyncExternalStore(subscribeRoleSession, getRoleSessionSnapshot, () => null);
  const role = session?.role ?? null;

  const here = useMemo(() => doorForPath(pathname), [pathname]);
  const group = here ? searchGroupOf(here.href, role) : null;
  // The room in the gym's own words, as Search names it (lane W4-9, RN-2).
  const roomNames = useRoomNames();

  // Signed out there is no Search to open, so there is no plate.
  if (!role) return null;

  const room = group ? searchGroupLabel(group, roomNames.place) : 'All pages';
  // The page's name as the menus show it (a card name reads the gym's word, RN-3).
  const hereLabel = here ? roomNames.door(here) : null;
  const where = here ? `${room}, ${hereLabel}` : room;

  return (
    <div className="corridor-root">
      <button
        type="button"
        className="corridor-trigger"
        // A page the map does not know is not a place: say only what it opens.
        aria-label={here ? `Where you are: ${where}. Opens All pages in Search.` : 'Open All pages in Search.'}
        onClick={() => openSearchAt(group)}
      >
        <span className="corridor-trigger-glyph" aria-hidden="true">▤</span>
        <span className="corridor-trigger-lbl">{room}</span>
        {/* The page's name steps off the phone: the page's own title says it,
            and keeping it made the room name beside it the part that was cut
            ("FRONT OF…"). */}
        {here && <span className="corridor-trigger-here hidden sm:inline">{hereLabel}</span>}
      </button>
    </div>
  );
}
