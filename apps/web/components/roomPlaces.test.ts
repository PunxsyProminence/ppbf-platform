import { BUILDING, visibleDoors } from './buildingMap';
import {
  HOME_HREF,
  LAB_HREFS,
  ROOM_PLACE,
  ROOM_PLACE_LABEL,
  ROOM_PLACE_ORDER,
  roomPlaceOf,
  searchGroupOf,
  searchGroups,
} from './roomPlaces';
import type { ClubRole } from './roleRoutes';

/**
 * AS-4 4a: every door's Room Map room, for Search's "All pages" (docs/ROOM-MAP.md;
 * scrub Q11 B; Overwatch QT = A and QU = A on #2029).
 */

const HREFS = BUILDING.map((door) => door.href);
const ROLES: ClubRole[] = ['athlete', 'coach', 'parent', 'admin', 'platform_owner', 'staff', 'volunteer', 'board'];

describe('the Room Map rooms', () => {
  it('are the seventeen rooms of the Room Map, each with a label', () => {
    expect(ROOM_PLACE_ORDER).toHaveLength(17);
    expect(new Set(ROOM_PLACE_ORDER).size).toBe(17);
    expect(Object.keys(ROOM_PLACE_LABEL).sort()).toEqual([...ROOM_PLACE_ORDER].sort());
  });

  it('place every door but Home in exactly one room, and name no route that is not a door', () => {
    const placed = Object.keys(ROOM_PLACE);
    for (const href of placed) expect(HREFS).toContain(href);
    for (const href of HREFS) {
      if (href === HOME_HREF) expect(roomPlaceOf(href)).toBeNull();
      else expect(roomPlaceOf(href)).not.toBeNull();
    }
    // One room per door: a door listed in two rooms would collapse to one key and
    // leave this count short.
    expect(placed).toHaveLength(HREFS.length - 1);
  });

  it('leave no room empty', () => {
    const used = new Set(Object.values(ROOM_PLACE));
    for (const place of ROOM_PLACE_ORDER) expect(used.has(place)).toBe(true);
  });

  it('follow the Room Map where it names the page, and QT where it does not', () => {
    expect(roomPlaceOf('/admin/door-register')).toBe('front-desk');
    expect(roomPlaceOf('/parent/safety')).toBe('family-room');
    expect(roomPlaceOf('/store')).toBe('window');
    expect(roomPlaceOf('/coach/drills')).toBe('drill-cabinet');
    expect(roomPlaceOf('/coach/intervention-review')).toBe('coach-office');
    expect(roomPlaceOf('/operations/wrestling-league')).toBe('operations');
    expect(roomPlaceOf('/notices')).toBe('back-office');
    expect(roomPlaceOf('/retro-lab')).toBe('workshop');
    // QT = A
    expect(roomPlaceOf('/coach/class')).toBe('floor');
    expect(roomPlaceOf('/coach/library')).toBe('drill-cabinet');
    expect(roomPlaceOf('/athlete/video-analysis')).toBe('locker');
    expect(roomPlaceOf('/coach/passbook')).toBe('book');
    expect(roomPlaceOf('/rabbit-holes')).toBe('file-room');
    expect(roomPlaceOf('/admin/system')).toBe('workshop');
    expect(roomPlaceOf('/admin/athletes')).toBe('front-desk');
    expect(roomPlaceOf('/admin/gear/vendors')).toBe('back-office');
  });

  it("give the five count-only rooms the doors whose paint room is theirs", () => {
    const paint: Record<string, string> = { clinic: 'clinic', file: 'file-room', board: 'board-room', teach: 'teach-shadow', night: 'after-hours' };
    for (const door of BUILDING) {
      if (door.room in paint) expect([door.href, roomPlaceOf(door.href)]).toEqual([door.href, paint[door.room]]);
    }
  });
});

describe('the Lab (QU = A)', () => {
  it('names only doors', () => {
    for (const href of LAB_HREFS) expect(HREFS).toContain(href);
  });

  it('holds its doors for the admin and the platform owner only', () => {
    for (const href of LAB_HREFS) {
      expect(searchGroupOf(href, 'admin')).toBe('lab');
      expect(searchGroupOf(href, 'platform_owner')).toBe('lab');
      for (const role of ['coach', 'staff', 'volunteer'] as ClubRole[]) expect(searchGroupOf(href, role)).not.toBe('lab');
    }
  });

  it('leaves a coach, staff or volunteer their research pages in the File Room', () => {
    expect(searchGroupOf('/research', 'coach')).toBe('file-room');
    expect(searchGroupOf('/research/chat', 'staff')).toBe('file-room');
    expect(searchGroupOf('/audit', 'coach')).toBe('file-room');
  });
});

describe('All pages, grouped', () => {
  it.each(ROLES)('%s: Home first, rooms in Room Map order, Lab last, each door once, no empty room', (role) => {
    const doors = visibleDoors(role);
    const groups = searchGroups(doors, role);
    const keys = groups.map((group) => group.key);
    const order = ['home', ...ROOM_PLACE_ORDER, 'lab'];
    expect(keys).toEqual(order.filter((key) => keys.includes(key as never)));
    for (const group of groups) expect(group.doors.length).toBeGreaterThan(0);
    expect(groups.flatMap((group) => group.doors).map((door) => door.href).sort()).toEqual(doors.map((door) => door.href).sort());
  });

  it('shows the Lab to the admin and the platform owner only', () => {
    expect(searchGroups(visibleDoors('admin'), 'admin').at(-1)?.key).toBe('lab');
    expect(searchGroups(visibleDoors('platform_owner'), 'platform_owner').at(-1)?.key).toBe('lab');
    for (const role of ['coach', 'staff', 'volunteer', 'parent', 'athlete', 'board'] as ClubRole[]) {
      expect(searchGroups(visibleDoors(role), role).map((group) => group.key)).not.toContain('lab');
    }
  });

  it('shows a parent only the rooms they can enter', () => {
    const keys = searchGroups(visibleDoors('parent'), 'parent').map((group) => group.key);
    expect(keys).toContain('family-room');
    expect(keys).not.toContain('clinic');
    expect(keys).not.toContain('back-office');
    expect(keys).not.toContain('board-room');
  });
});
