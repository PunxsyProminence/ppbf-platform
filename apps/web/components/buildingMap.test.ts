// The corridor and the card catalog both read the building map, so a wrong
// entry here is a door that bounces you or a surface nobody can find. The
// role filtering in particular is a courtesy, not a boundary -- these tests
// pin the courtesy so it does not quietly start advertising the wrong doors.

import {
  BUILDING,
  OPEN,
  ROOM_ORDER,
  ROOM_LABEL,
  ROOM_BLURB,
  doorForPath,
  doorsByRoom,
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
