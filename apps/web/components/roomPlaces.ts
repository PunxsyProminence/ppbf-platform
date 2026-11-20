import type { Door } from './buildingMap';
import type { ClubRole } from './roleRoutes';

/**
 * THE ROOM MAP'S ROOMS, FOR SEARCH (AS-4, U2-4a).
 *
 * Search's empty query shows "All pages" grouped by the 17 rooms of the Room Map
 * (docs/ROOM-MAP.md, approved 2026-09-26; scrub Q11 B: "All 17 rooms from the
 * Room Map"). This is a NEW field, kept apart from a door's `room` in
 * buildingMap.ts: that one is a copy of the page's paint and drives the easter
 * eggs, and it is not changed here.
 *
 * Where each door goes: the Room Map's own lists where it names the page; for
 * its five count-only rooms (Clinic, File Room, Board Room, Teach Shadow, After
 * Hours) the doors whose `room` is that room; and for every door the Room Map
 * does not name, Overwatch's QT = A on #2029. Home (/dashboard, "The Bell", the
 * way in) is in no room; Search lists it first.
 */
export type RoomPlace =
  | 'front-desk'
  | 'family-room'
  | 'window'
  | 'floor'
  | 'drill-cabinet'
  | 'film-room'
  | 'locker'
  | 'coach-office'
  | 'book'
  | 'clinic'
  | 'file-room'
  | 'board-room'
  | 'teach-shadow'
  | 'after-hours'
  | 'operations'
  | 'back-office'
  | 'workshop';

/** The Room Map's order: the public side, training, working, quiet, away, behind the scenes. */
export const ROOM_PLACE_ORDER: readonly RoomPlace[] = [
  'front-desk',
  'family-room',
  'window',
  'floor',
  'drill-cabinet',
  'film-room',
  'locker',
  'coach-office',
  'book',
  'clinic',
  'file-room',
  'board-room',
  'teach-shadow',
  'after-hours',
  'operations',
  'back-office',
  'workshop',
];

/** The Room Map's names for its rooms. */
export const ROOM_PLACE_LABEL: Record<RoomPlace, string> = {
  'front-desk': 'Front Desk',
  'family-room': 'The Family Room',
  window: 'The Window',
  floor: 'The Floor',
  'drill-cabinet': 'Drill Cabinet',
  'film-room': 'The Film Room',
  locker: 'The Locker',
  'coach-office': "Coach's Office",
  book: 'The Book',
  clinic: 'Clinic',
  'file-room': 'File Room',
  'board-room': 'Board Room',
  'teach-shadow': 'Teach Shadow',
  'after-hours': 'After Hours',
  operations: 'Operations',
  'back-office': 'Back Office',
  workshop: 'The Workshop',
};

/** Each room's doors, by href. A door belongs to one room (roomPlaces.test.ts checks). */
export const ROOM_PLACE_DOORS: Readonly<Record<RoomPlace, readonly string[]>> = {
  'front-desk': [
    '/admin/people', '/admin/door-register', '/admin/pin', '/admin/activation-codes', '/admin/attendance',
    '/admin/volunteer-management', '/admin/coach-coverage', '/admin/credentials', '/staff-credentials', '/profile',
    '/print', '/admin/import', '/workspace', '/admin/athletes',
  ],
  'family-room': [
    '/parent/dashboard', '/parent/consent', '/parent/safety', '/parent/progression-visibility',
    '/parent/development-blocks', '/parent/video', '/parent/mental-skills',
  ],
  window: ['/', '/help', '/store'],
  floor: [
    '/wall', '/names', '/schedule', '/athlete/dashboard', '/athlete/dashboard/sparring',
    '/coach/environment/intake-router', '/coach/session-scripts', '/coach/workout-templates',
    '/coach/behavior-standards', '/coach/one-percent-club', '/chalkboard', '/coach/class', '/coach/class-plans',
    '/coach/test-day', '/coach/floor-groups', '/coach/sparring-exposure',
  ],
  'drill-cabinet': ['/coach/drills', '/coach/cue-library', '/coach/library'],
  'film-room': [
    '/coach/video-analysis', '/coach/video-analysis/capture', '/coach/video-publications', '/coach/visualization',
    '/coach/video-publications/library',
  ],
  locker: ['/athlete/progression-intelligence', '/athlete/development-blocks', '/athlete/mental-skills', '/athlete/video-analysis'],
  'coach-office': [
    '/coach/decision-loop', '/coach/recognition', '/coach/cards', '/coach/intelligence', '/coach/attempt-log',
    '/coach/athlete-intelligence', '/coach/progression-intelligence', '/coach/performance-analytics',
    '/coach/intervention-protocols', '/coach/intervention-executions', '/coach/intervention-review',
    '/coach/adult-pathway', '/coach/disciplines', '/coach/parent-resources', '/coach/mental-skills', '/coach/assessments',
  ],
  book: [
    '/coach/passbook-gaps', '/coach/transfer-check', '/coach/credentials', '/coach/development-blocks',
    '/coach/development', '/coach/cohorts', '/coach/passbook',
  ],
  clinic: [
    '/admin/feedback', '/admin/safety-flags', '/admin/escalations', '/admin/athlete-consent', '/admin/waiver-status',
    '/admin/safety-review', '/admin/video-compliance', '/coach/sports-medicine', '/coach/injuries',
    '/coach/sparring-caps', '/coach/medical-restrictions', '/coach/athlete-limits', '/admin/compliance-center',
  ],
  'file-room': [
    '/simulator', '/research', '/research/chat', '/research/review', '/evidence', '/knowledge-graph', '/audit',
    '/rabbit-holes',
  ],
  'board-room': [
    '/admin/board-seats', '/board', '/board/president', '/board/chair', '/board/vice-chair', '/board/treasurer',
    '/board/secretary', '/board/safety-director', '/board/community-director', '/board/at-large',
    '/board/compliance-monitoring', '/board/escalation-monitoring', '/board/aggregates',
  ],
  'teach-shadow': [
    '/teach-shadow', '/teach-shadow/capture', '/teach-shadow/cut', '/teach-shadow/annotation', '/teach-shadow/agreement',
  ],
  'after-hours': ['/shadow', '/shadow/scout', '/admin/shadow'],
  operations: ['/operations', '/operations/external-competition', '/operations/wrestling-league'],
  'back-office': [
    '/admin/grants', '/admin/payments', '/admin/memberships', '/admin/organizations', '/admin/customize',
    '/admin/public-interest', '/admin/data-quality', '/admin/floor-hours', '/admin/community-service',
    '/admin/consent', '/notices', '/admin/setup', '/admin/content-import', '/admin/data-deletion', '/admin/quotes',
    '/admin/program-phases', '/admin/export', '/admin/gear', '/admin/gear/vendors',
  ],
  workshop: [
    '/admin', '/admin/platform', '/admin/platform/overview', '/admin/shadow-reviews', '/admin/video-review',
    '/admin/calibration/adjudicate', '/admin/calibration/review', '/admin/portrait-review', '/retro-lab',
    '/admin/system',
  ],
};

/** Each door's Room Map room, by href. Home (/dashboard) has none. */
export const ROOM_PLACE: Readonly<Record<string, RoomPlace>> = Object.fromEntries(
  ROOM_PLACE_ORDER.flatMap((place) => ROOM_PLACE_DOORS[place].map((href) => [href, place] as const)),
);

/** The door that stands for Home: in no room, listed first in Search. */
export const HOME_HREF = '/dashboard';

export function roomPlaceOf(href: string): RoomPlace | null {
  return ROOM_PLACE[href] ?? null;
}

/**
 * THE LAB (Overwatch QU = A on #2029; stage-1 BOA-08, and stage 2's admin Lab:
 * "Capabilities, System, Door Register, SHADOW admin console, research and
 * evidence pages, simulator, retro lab"). Admin and platform owner find these in
 * Search under "Lab", last. Any other role that can open one keeps it in its
 * Room Map room, so nobody loses a page from Search.
 */
export const LAB_HREFS: ReadonlySet<string> = new Set([
  '/simulator', '/research', '/research/chat', '/research/review', '/evidence', '/knowledge-graph', '/audit',
  '/admin/shadow', '/retro-lab', '/admin/door-register', '/admin/system', '/admin/calibration/adjudicate',
  '/admin/calibration/review', '/admin',
]);

export const LAB_ROLES: readonly ClubRole[] = ['admin', 'platform_owner'];

export const LAB_LABEL = 'Lab';

export type SearchGroupKey = 'home' | RoomPlace | 'lab';

export interface SearchGroup {
  key: SearchGroupKey;
  label: string;
  doors: Door[];
}

/** Where a door sits in Search for this role: Home, its room, or (admin and platform owner) Lab. */
export function searchGroupOf(href: string, role: ClubRole | null): SearchGroupKey | null {
  if (href === HOME_HREF) return 'home';
  if (role && LAB_ROLES.includes(role) && LAB_HREFS.has(href)) return 'lab';
  return roomPlaceOf(href);
}

/**
 * "All pages" for one person: the doors they can see (pass visibleDoors' answer),
 * grouped Home first, then the Room Map's rooms in order, then Lab. A room with
 * none of their doors is left out ("Only rooms the role can enter").
 */
export function searchGroups(doors: readonly Door[], role: ClubRole | null): SearchGroup[] {
  const keys: SearchGroupKey[] = ['home', ...ROOM_PLACE_ORDER, 'lab'];
  const label = (key: SearchGroupKey): string =>
    key === 'home' ? 'Home' : key === 'lab' ? LAB_LABEL : ROOM_PLACE_LABEL[key];
  return keys
    .map((key) => ({ key, label: label(key), doors: doors.filter((door) => searchGroupOf(door.href, role) === key) }))
    .filter((group) => group.doors.length > 0);
}
