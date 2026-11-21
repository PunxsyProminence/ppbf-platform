'use client';

import { useMemo, useSyncExternalStore } from 'react';
import { usePathname } from 'next/navigation';

import { openSearchAt, searchGroupLabel } from './CardCatalog';
import { getRoleSessionSnapshot, subscribeRoleSession } from './roleSession';
import { doorForPath } from './buildingMap';
import { searchGroupOf } from './roomPlaces';

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

  // Signed out there is no Search to open, so there is no plate.
  if (!role) return null;

  const room = group ? searchGroupLabel(group) : 'All pages';
  const where = here ? `${room}, ${here.label}` : room;

  return (
    <div className="corridor-root">
      <button
        type="button"
        className="corridor-trigger"
        aria-label={`Where you are: ${where}. Opens All pages in Search.`}
        onClick={() => openSearchAt(group)}
      >
        <span className="corridor-trigger-glyph" aria-hidden="true">▤</span>
        <span className="corridor-trigger-lbl">{room}</span>
        {/* The page's name steps off the phone: the page's own title says it,
            and keeping it made the room name beside it the part that was cut
            ("FRONT OF…"). */}
        {here && <span className="corridor-trigger-here hidden sm:inline">{here.label}</span>}
      </button>
    </div>
  );
}
