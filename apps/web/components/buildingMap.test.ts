// The corridor and the card catalog both read the building map, so a wrong
// entry here is a door that bounces you or a surface nobody can find. The
// role filtering in particular is a courtesy, not a boundary -- these tests
// pin the courtesy so it does not quietly start advertising the wrong doors.

import {
  BUILDING,
  EGG_ROOMS,
  OPEN,
  ROOM_ORDER,
  ROOM_LABEL,
  ROOM_BLURB,
  doorForPath,
  doorsByRoom,
  isRefusalSurface,
  pathAllowsEggs,
  roomAllowsEggs,
  searchDoors,
  visibleDoors,
} from './buildingMap';

describe('the building map itself', () => {
  it('has no duplicate hrefs', () => {
    const seen = new Map<string, number>();
    for (const d of BUILDING) seen.set(d.href, (seen.get(d.href) ?? 0) + 1);
    expect([...seen.entries()].filter(([, n]) => n > 1)).toEqual([]);
  });

  it('gives every door an absolute href and a non-empty label', () => {
    for (const d of BUILDING) {
      expect(d.href.startsWith('/')).toBe(true);
      expect(d.label.trim().length).toBeGreaterThan(0);
    }
  });

  it('places every door in a room that ROOM_ORDER knows about', () => {
    for (const d of BUILDING) expect(ROOM_ORDER).toContain(d.room);
  });

  it('labels and describes every room in ROOM_ORDER', () => {
    for (const room of ROOM_ORDER) {
      expect(ROOM_LABEL[room]).toBeTruthy();
      expect(ROOM_BLURB[room]).toBeTruthy();
    }
  });

  it('uses every room -- an empty room means a room nobody can reach', () => {
    for (const room of ROOM_ORDER) {
      expect(BUILDING.some((d) => d.room === room)).toBe(true);
    }
  });
});

describe('previously-orphaned admin/parent consoles are now doors', () => {
  // Grok's audit found activation-codes and video-review missing from the
  // header; a full check found the entire safeguarding cluster (escalations,
  // consent, portrait/video review, media-consent audit) and this session's
  // own new consoles were never added to the building map at all --
  // reachable only by typing the exact URL. Pinned so they can't quietly
  // drop out again.
  const expected = [
    '/admin/activation-codes',
    '/admin/feedback',
    '/admin/attendance',
    '/admin/escalations',
    '/admin/consent',
    '/admin/athlete-consent',
    '/admin/portrait-review',
    '/admin/video-review',
    '/admin/video-compliance',
    '/parent/consent',
  ];

  it('every previously-orphaned surface has a door', () => {
    const hrefs = BUILDING.map((d) => d.href);
    for (const href of expected) expect(hrefs).toContain(href);
  });

  it('an org-admin-only console (portrait/video review, media-consent audit) is not shown to a coach', () => {
    const hrefs = visibleDoors('coach').map((d) => d.href);
    expect(hrefs).not.toContain('/admin/portrait-review');
    expect(hrefs).not.toContain('/admin/video-compliance');
    expect(hrefs).not.toContain('/admin/athlete-consent');
  });

  it('a coach can still reach the escalations and consent queues admin/coach share', () => {
    const hrefs = visibleDoors('coach').map((d) => d.href);
    expect(hrefs).toContain('/admin/escalations');
    expect(hrefs).toContain('/admin/consent');
  });

  it('the guardian media-consent console is parent-only, not shown to an athlete', () => {
    expect(visibleDoors('parent').map((d) => d.href)).toContain('/parent/consent');
    expect(visibleDoors('athlete').map((d) => d.href)).not.toContain('/parent/consent');
  });
});

describe('visibleDoors', () => {
  it('shows a signed-out visitor only the ungated surfaces', () => {
    const doors = visibleDoors(null);
    expect(doors.length).toBeGreaterThan(0);
    for (const d of doors) expect(d.roles).toBe(OPEN);
  });

  it('never shows an athlete an admin-gated surface', () => {
    const hrefs = visibleDoors('athlete').map((d) => d.href);
    expect(hrefs).not.toContain('/admin');
    expect(hrefs).not.toContain('/admin/people');
    expect(hrefs).not.toContain('/evidence');
  });

  it('shows an athlete their own surfaces', () => {
    const hrefs = visibleDoors('athlete').map((d) => d.href);
    expect(hrefs).toContain('/athlete/dashboard');
    expect(hrefs).toContain('/schedule');
  });

  it('never shows a parent the coach queue', () => {
    const hrefs = visibleDoors('parent').map((d) => d.href);
    expect(hrefs).not.toContain('/coach/review-queue');
    expect(hrefs).toContain('/guardian');
  });

  // platform_owner is broader in breadth but strictly NARROWER in depth
  // (roleRoutes.ts), so it must not behave as a wildcard.
  it('does not treat platform_owner as a wildcard', () => {
    const hrefs = visibleDoors('platform_owner').map((d) => d.href);
    expect(hrefs).toContain('/admin');
    expect(hrefs).not.toContain('/athlete/dashboard');
    expect(hrefs).not.toContain('/guardian');
  });

  it('gives the board its seats and not the admin console', () => {
    const hrefs = visibleDoors('board').map((d) => d.href);
    expect(hrefs).toContain('/board');
    expect(hrefs).toContain('/board/treasurer');
    expect(hrefs).not.toContain('/admin');
  });

  /* ROOM-PURPOSE-DNA.md puts "Ask SHADOW chat" first under the board room's
     FORBIDDEN, and its differentiation checklist asks "Does board show chat?
     YES -> delete". Both SHADOW doors were `roles: OPEN`, so a board member's
     corridor and card catalog listed an After Hours room holding the two of
     them -- and both bounce on arrival: /shadow refuses the role where it
     stands, /shadow/scout redirects. Exactly the door this file's own header
     says the corridor must never advertise. */
  it('advertises neither SHADOW door to the board', () => {
    const hrefs = visibleDoors('board').map((d) => d.href);
    expect(hrefs).not.toContain('/shadow');
    expect(hrefs).not.toContain('/shadow/scout');
  });

  it('advertises neither SHADOW door to a board seat either', () => {
    const hrefs = visibleDoors('board-treasurer').map((d) => d.href);
    expect(hrefs).not.toContain('/shadow');
    expect(hrefs).not.toContain('/shadow/scout');
  });

  it('leaves the board no After Hours room at all', () => {
    expect(doorsByRoom('board').map((g) => g.room)).not.toContain('night');
  });

  // The other half of the same change: hiding a door from the board must not
  // have hidden it from the roles whose own gate lets them through it.
  it.each(['athlete', 'coach', 'parent', 'admin', 'staff', 'volunteer', 'platform_owner'] as const)(
    'still shows SHADOW chat to %s, whom SHADOW_CHAT_ROLES admits',
    (role) => {
      expect(visibleDoors(role).map((d) => d.href)).toContain('/shadow');
    },
  );

  it('shows the scout report to exactly the roles its own guard admits', () => {
    for (const role of ['admin', 'coach', 'platform_owner'] as const) {
      expect(visibleDoors(role).map((d) => d.href)).toContain('/shadow/scout');
    }
    for (const role of ['athlete', 'parent', 'staff', 'volunteer', 'board'] as const) {
      expect(visibleDoors(role).map((d) => d.href)).not.toContain('/shadow/scout');
    }
  });
});

/* OPERATIONS V1 (owner decision, 2026-08-21): ordinary roles land in their
   operational work and stop being offered the lab. These pin the narrowed
   visibility sets. Same rule as everywhere in this file: the hint is a
   courtesy, not a boundary -- every lab page keeps its own guard (or its
   deliberate lack of one), every lab API keeps its own access checks, and
   every door here stays reachable by URL. */
describe('the lab doors are offered to the admin desks only', () => {
  const LAB_DOORS = [
    '/retro-lab',
    '/simulator',
    '/knowledge-graph',
    '/source-control',
    '/source-control/publication-workflow',
  ];

  it.each(['admin', 'platform_owner'] as const)('%s keeps every lab door', (role) => {
    const hrefs = visibleDoors(role).map((d) => d.href);
    for (const href of LAB_DOORS) expect(hrefs).toContain(href);
  });

  it.each(['athlete', 'coach', 'parent', 'staff', 'volunteer', 'board'] as const)(
    '%s is not offered the lab',
    (role) => {
      const hrefs = visibleDoors(role).map((d) => d.href);
      for (const href of LAB_DOORS) expect(hrefs).not.toContain(href);
    },
  );

  it('a signed-out visitor is not offered the lab either', () => {
    const hrefs = visibleDoors(null).map((d) => d.href);
    for (const href of LAB_DOORS) expect(hrefs).not.toContain(href);
  });

  it('the research desks stay with the working roles and leave the athlete and parent corridors', () => {
    // Visibility narrower than the page's own member gate, on purpose:
    // research intake is staff-side lab work, not a family surface. The pages
    // still admit athlete and parent by URL -- see RESEARCH_GATE's comment.
    for (const role of ['coach', 'admin', 'platform_owner', 'staff', 'volunteer'] as const) {
      const hrefs = visibleDoors(role).map((d) => d.href);
      expect(hrefs).toContain('/research');
      expect(hrefs).toContain('/research/chat');
    }
    for (const role of ['athlete', 'parent', 'board'] as const) {
      const hrefs = visibleDoors(role).map((d) => d.href);
      expect(hrefs).not.toContain('/research');
      expect(hrefs).not.toContain('/research/chat');
    }
  });

  it('leaves the operational doors where they were', () => {
    // The narrowing must not swallow a working surface: the staff/volunteer
    // landing, the schedule, and the coach floor pages keep their audiences.
    expect(visibleDoors('staff').map((d) => d.href)).toContain('/workspace');
    expect(visibleDoors('volunteer').map((d) => d.href)).toContain('/workspace');
    expect(visibleDoors('athlete').map((d) => d.href)).toContain('/schedule');
    expect(visibleDoors('coach').map((d) => d.href)).toContain('/rabbit-holes');
    expect(visibleDoors('coach').map((d) => d.href)).toContain('/coach/workout-templates');
    expect(visibleDoors('athlete').map((d) => d.href)).not.toContain('/evidence');
    expect(visibleDoors('admin').map((d) => d.href)).toContain('/evidence');
  });
});

describe('doorsByRoom', () => {
  it('drops rooms with nothing in them rather than showing an empty hallway', () => {
    for (const group of doorsByRoom('athlete')) {
      expect(group.doors.length).toBeGreaterThan(0);
    }
  });

  it('keeps ROOM_ORDER', () => {
    const rooms = doorsByRoom(null).map((g) => g.room);
    const expected = ROOM_ORDER.filter((r) => rooms.includes(r));
    expect(rooms).toEqual(expected);
  });

  it('accounts for every visible door exactly once', () => {
    const grouped = doorsByRoom('coach').flatMap((g) => g.doors);
    expect(grouped.length).toBe(visibleDoors('coach').length);
    expect(new Set(grouped.map((d) => d.href)).size).toBe(grouped.length);
  });
});

describe('searchDoors', () => {
  it('returns everything visible for an empty query, so the catalog opens as a browse', () => {
    expect(searchDoors('coach', '').length).toBe(visibleDoors('coach').length);
    expect(searchDoors('coach', '   ').length).toBe(visibleDoors('coach').length);
  });

  it('never returns a door the role cannot see', () => {
    for (const q of ['admin', 'people', 'evidence', 'shadow', 'board', 'a', 'e']) {
      for (const d of searchDoors('athlete', q)) {
        expect(visibleDoors('athlete')).toContain(d);
      }
    }
  });

  it('ranks an exact label prefix first', () => {
    expect(searchDoors('coach', 'review')[0].href).toBe('/coach/review-queue');
  });

  it('matches on keywords, not just the label', () => {
    // "layer 10" appears only in the queue's keywords.
    expect(searchDoors('coach', 'layer 10')[0].href).toBe('/coach/review-queue');
    // "concussion" appears only in sports medicine's keywords. Searched as a
    // coach: the door was OPEN when this test was written, but the clearance
    // board now carries a coach/admin guard and the map's visibility hint
    // follows the guard.
    expect(searchDoors('coach', 'concussion')[0].href).toBe('/coach/sports-medicine');
  });

  it('matches a subsequence, so an abbreviation finds the surface', () => {
    expect(searchDoors('coach', 'revq').map((d) => d.href)).toContain('/coach/review-queue');
  });

  it('is case insensitive', () => {
    expect(searchDoors('coach', 'REVIEW')[0].href).toBe('/coach/review-queue');
  });

  it('prefers the shorter label on a tie', () => {
    // Both "Shadow" and "Shadow Console"/"Shadow Scout" match; the bare one wins.
    expect(searchDoors('platform_owner', 'shadow')[0].label).toBe('Shadow');
  });

  it('returns nothing for a query that matches nothing', () => {
    expect(searchDoors('coach', 'zzzzqqqxx')).toEqual([]);
  });

  it('does not crash on regex-special characters', () => {
    for (const q of ['(', '[', '*', '.*', '\\', '?', '+']) {
      expect(() => searchDoors('coach', q)).not.toThrow();
    }
  });
});

describe('doorForPath', () => {
  it('finds an exact match', () => {
    expect(doorForPath('/coach/review-queue')?.label).toBe('Review Queue');
  });

  it('falls back to the longest matching prefix for a nested route', () => {
    // /admin/organizations/test has no door of its own.
    expect(doorForPath('/admin/organizations/test')?.href).toBe('/admin/organizations');
  });

  it('prefers the longest prefix over a shorter one', () => {
    // Both /admin and /admin/platform are doors; the deeper one wins.
    expect(doorForPath('/admin/platform/overview')?.href).toBe('/admin/platform');
  });

  it('returns null for a path in no room', () => {
    expect(doorForPath('/nowhere-at-all')).toBeNull();
  });
});

/* ==========================================================================
   WHERE AN EASTER EGG MAY STAND

   The card catalog's bell and the gym's noticing lines are mounted globally by
   GlobalRoleHeader, so the predicate below is the only thing standing between
   a flourish and a governance screen, a clinic, or a deny.
   ========================================================================== */

describe('the rooms that may carry an egg', () => {
  it('says yes to the two rooms ROOM-PURPOSE-DNA.md says yes to, and no to the four that say NEVER', () => {
    expect([...EGG_ROOMS].sort()).toEqual(['floor', 'office']);
    for (const room of ROOM_ORDER) {
      expect(roomAllowsEggs(room)).toBe(room === 'office' || room === 'floor');
    }
  });

  it('reads the room off the path, which is all a globally-mounted egg knows', () => {
    expect(pathAllowsEggs('/dashboard')).toBe(true);        // office
    expect(pathAllowsEggs('/schedule')).toBe(true);         // floor -- primary home
    expect(pathAllowsEggs('/board')).toBe(false);           // board  -- NEVER
    expect(pathAllowsEggs('/research')).toBe(false);        // file   -- NEVER
    expect(pathAllowsEggs('/admin/escalations')).toBe(false); // clinic -- NEVER
    expect(pathAllowsEggs('/shadow')).toBe(false);          // night  -- NEVER on deny
  });

  it('says no in EVERY door of the four forbidden rooms, not just the ones named above', () => {
    for (const door of BUILDING) {
      if (door.room === 'office' || door.room === 'floor') continue;
      expect(pathAllowsEggs(door.href)).toBe(false);
    }
  });

  it('follows a nested route to the door it hangs off', () => {
    // No door of its own; the longest matching prefix is /board/treasurer.
    expect(pathAllowsEggs('/board/treasurer/2026')).toBe(false);
    expect(pathAllowsEggs('/admin/organizations/test')).toBe(true); // office
  });

  it('answers no for a path in no room at all, and for no path', () => {
    expect(pathAllowsEggs('/nowhere-at-all')).toBe(false);
    expect(pathAllowsEggs('')).toBe(false);
    expect(pathAllowsEggs(null)).toBe(false);
    expect(pathAllowsEggs(undefined)).toBe(false);
  });
});

describe('isRefusalSurface', () => {
  // P0.2: the deny screen is title + body + Dashboard + Logout ONLY, which is
  // a statement about the whole screen -- the global session bar included.
  it('is true for a role SHADOW refuses where it stands', () => {
    expect(isRefusalSurface('board', '/shadow')).toBe(true);
  });

  it('is false for a role that surface admits', () => {
    for (const role of ['coach', 'athlete', 'admin', 'platform_owner'] as const) {
      expect(isRefusalSurface(role, '/shadow')).toBe(false);
    }
  });

  it('is false on a door that redirects rather than refusing in place', () => {
    // /shadow/scout sends the wrong role to /shadow; nobody reads a refusal
    // standing on it, so nothing there needs its chrome stripped.
    expect(isRefusalSurface('athlete', '/shadow/scout')).toBe(false);
  });

  it('is false for a signed-out visitor, who already has the pre-auth bar', () => {
    expect(isRefusalSurface(null, '/shadow')).toBe(false);
  });

  it('is false on an ordinary surface and on a path in no room', () => {
    expect(isRefusalSurface('board', '/board')).toBe(false);
    expect(isRefusalSurface('board', '/dashboard')).toBe(false);
    expect(isRefusalSurface('board', '/nowhere-at-all')).toBe(false);
    expect(isRefusalSurface('board', null)).toBe(false);
  });

  it('marks /shadow, and marks nothing that has no audience to be outside of', () => {
    const marked = BUILDING.filter((d) => d.refusesInPlace);
    expect(marked.map((d) => d.href)).toContain('/shadow');
    // A door with no gate cannot refuse anybody, so marking one would be a
    // header that goes minimal for a session nothing is refusing.
    for (const door of marked) expect(door.roles).not.toBe(OPEN);
  });
});
