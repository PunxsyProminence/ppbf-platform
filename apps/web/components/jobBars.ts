import { visibleDoors, type DoorViewer } from './buildingMap';
import type { ClubRole } from './roleRoutes';

/**
 * EACH ROLE'S JOB BAR (AS-4, U2-4a). Data only: 4b draws it, a rail of tags on a
 * tablet or desk and a plain bar on a phone (scrub Q13 A).
 *
 * The source is the App Scrub stage 2 file, section 3.3, which Jason approved
 * with S2-2 "A: Job bar + search (Recommended)" after sketches
 * (OD-2026-11-19-008). The file is not in this repo; Overwatch quoted its job
 * bars and section contents on #2029 (2026-11-20, QS = A corrected to the
 * source). Each item below is an existing door, named by its href, or a Parent
 * Hub tab named by the same word the stage 2 file uses. Items with no page yet
 * are left out, never invented:
 *   coach    Who needs you (one list); Groups and pathways; Lessons.
 *   parent   digest, achievements, your notes (This week's "parent support tasks").
 *   admin    New member flow; Morning check; Gym TVs (pairing).
 * Stage 2's athlete bar is superseded by Q14 A (OD-2026-11-19-017), so there is
 * none here. Tell Us, Logout and the safety badge stay in the header.
 *
 * Display only, like every menu: an item shows only when visibleDoors gives the
 * person its door. No page's gate is decided here.
 */

/** A page in a section: a door's href, and for Parent Hub the tab it opens on (4e reads it). */
export interface JobItem {
  readonly href: string;
  readonly tab?: string;
}

/** One section of the bar. One item is a link; more than one opens a small sheet (4b). */
export interface JobSection {
  readonly label: string;
  readonly items: readonly JobItem[];
}

export interface JobBar {
  readonly sections: readonly JobSection[];
  /** Stage 2's "More" for the coach and the parent: pages off the bar, drawn by 4b. */
  readonly more: readonly JobItem[];
}

const pages = (...hrefs: string[]): JobItem[] => hrefs.map((href) => ({ href }));
const hubTab = (tab: string): JobItem => ({ href: '/parent/dashboard', tab });

/** A board member's Home is their own seat's workspace, where their session lands; Board Hub with no seat. */
export const BOARD_HOME = 'board-home';

const STAFF_BAR: JobBar = {
  sections: [
    { label: 'Home', items: pages('/workspace') },
    // "my credentials, my development"
    { label: 'Growth', items: pages('/coach/credentials', '/coach/development') },
    // "Ask SHADOW, Ask the library, research inbox, help, Certified and cleared"
    { label: 'More', items: pages('/shadow', '/research/chat', '/research', '/help', '/staff-credentials') },
  ],
  more: [],
};

export const JOB_BARS: Partial<Record<ClubRole, JobBar>> = {
  coach: {
    sections: [
      { label: 'Home', items: pages('/coach/environment/intake-router') },
      // "today's classes > Class screen; Schedule; Test day; Guided visualization"
      { label: 'Class', items: pages('/coach/class', '/schedule', '/coach/test-day', '/coach/visualization') },
      // "roster > athlete page" (Passbook, the athlete page: AS-11); "Interventions"; "Team (Standards,
      // 1% Club)"; "Competitions"
      {
        label: 'Athletes',
        items: pages(
          '/coach/passbook',
          '/coach/intervention-protocols', '/coach/intervention-executions', '/coach/intervention-review',
          '/coach/behavior-standards', '/coach/one-percent-club',
          '/operations/external-competition', '/operations/wrestling-league',
        ),
      },
      // "Class plans, Templates, Session plans, Drills and cues, Library, Program phases"; "Issue work to a
      // program" is a step on Workout Templates
      {
        label: 'Plan',
        items: pages(
          '/coach/class-plans', '/coach/workout-templates', '/coach/session-scripts', '/coach/drills',
          '/coach/cue-library', '/coach/library', '/admin/program-phases',
        ),
      },
      // "roster with clearance and holds > Athlete safety page" (today: Clearance Board, Injury Record,
      // Medical Restrictions); "Sparring and limits page" (today: Sparring Record, Sparring Caps, Athlete
      // Limits); "Safety queue (escalations and flags)"; "Media consent audit"; "Waivers"
      {
        label: 'Safety',
        items: pages(
          '/coach/sports-medicine', '/coach/injuries', '/coach/medical-restrictions',
          '/coach/sparring-exposure', '/coach/sparring-caps', '/coach/athlete-limits',
          '/admin/escalations', '/admin/safety-flags', '/admin/athlete-consent', '/admin/consent',
        ),
      },
    ],
    // "Film, Teach Shadow, Your growth, Ask SHADOW, Ask the library, For families, Boards and notices, Help,
    // Print, Wall of Names"
    more: pages(
      '/coach/video-analysis', '/coach/video-analysis/capture', '/coach/video-publications',
      '/coach/video-publications/library', '/teach-shadow', '/coach/development', '/shadow', '/research/chat',
      '/coach/parent-resources', '/chalkboard', '/notices', '/help', '/print', '/names',
    ),
  },
  parent: {
    sections: [
      { label: 'Home', items: pages('/parent/dashboard') },
      // "Safety and consent page per child"
      { label: 'Safety', items: pages('/parent/safety', '/parent/consent') },
      // "schedule and register, attendance"
      { label: 'This week', items: [...pages('/schedule'), hubTab('attendance')] },
      // "assignments, goals, their plan, mental skills, full record, film, family goals"
      {
        label: 'Progress',
        items: [
          hubTab('progress'), hubTab('home-assignments'), hubTab('family-goals'),
          ...pages('/parent/development-blocks', '/parent/mental-skills', '/parent/progression-visibility', '/parent/video'),
        ],
      },
      // "coach messages and replies, "Tell the coach""
      { label: 'Messages', items: [hubTab('messages')] },
    ],
    // "Resources, help, print, Wall of Names, Ask SHADOW"
    more: [hubTab('resources'), ...pages('/help', '/print', '/names', '/shadow')],
  },
  admin: {
    sections: [
      { label: 'Home', items: pages('/admin/people') },
      // "roster with search, athlete records, Sign-in codes, Load a roster, Duplicate guardians, Data
      // deletion, Enquiries; Staff (coverage, credentials, volunteers)". The roster with search is Home.
      {
        label: 'Members & staff',
        items: pages(
          '/admin/athletes', '/admin/activation-codes', '/admin/pin', '/admin/import', '/admin/data-quality',
          '/admin/data-deletion', '/admin/public-interest',
          '/admin/coach-coverage', '/admin/credentials', '/admin/volunteer-management',
        ),
      },
      // "Morning check and each queue"
      {
        label: 'Safety',
        items: pages(
          '/admin/safety-review', '/admin/escalations', '/admin/safety-flags', '/admin/feedback',
          '/admin/waiver-status', '/admin/athlete-consent', '/admin/video-compliance', '/admin/compliance-center',
        ),
      },
      // "Schedule, attendance, program phases, setup, competitions"
      {
        label: 'Classes & floor',
        items: pages(
          '/schedule', '/admin/attendance', '/admin/program-phases', '/admin/setup',
          '/operations', '/operations/external-competition', '/operations/wrestling-league',
        ),
      },
      // "customize, quotes, notices, chalkboard, gym content; grants, memberships, payment accounts,
      // equipment, suppliers; export; community service; floor hours; audit trace; board seats"
      {
        label: 'Office',
        items: pages(
          '/admin/customize', '/admin/quotes', '/notices', '/chalkboard', '/admin/content-import',
          '/admin/grants', '/admin/memberships', '/admin/payments', '/admin/gear', '/admin/gear/vendors',
          '/admin/export', '/admin/community-service', '/admin/floor-hours', '/audit', '/admin/board-seats',
        ),
      },
    ],
    more: [],
  },
  // "Each section is today's page; other seats' doors leave the menu (BOA-05)."
  board: {
    sections: [
      { label: 'Home', items: pages(BOARD_HOME) },
      { label: 'Aggregates', items: pages('/board/aggregates') },
      { label: 'Escalations', items: pages('/board/escalation-monitoring') },
      { label: 'Compliance', items: pages('/board/compliance-monitoring') },
      { label: 'Board hub', items: pages('/board') },
    ],
    more: [],
  },
  staff: STAFF_BAR,
  volunteer: STAFF_BAR,
  platform_owner: {
    sections: [
      { label: 'Home', items: pages('/admin/platform') },
      // "All gyms overview", today's /admin/platform/overview
      { label: 'Gyms', items: pages('/admin/platform/overview') },
      // "the onboarding wizard"
      { label: 'Onboard', items: pages('/admin/organizations') },
      { label: 'System', items: pages('/admin/system') },
    ],
    more: [],
  },
};

/**
 * One person's bar: each item kept only when visibleDoors gives them its door,
 * board seats by the session's seat; a section left with nothing is dropped.
 * Null for a role with no bar (athlete, or no session).
 */
export function jobBarFor(role: ClubRole | null, viewer: DoorViewer = {}): JobBar | null {
  if (!role) return null;
  const bar = JOB_BARS[role];
  if (!bar) return null;
  const open = new Set(visibleDoors(role, viewer).map((door) => door.href));
  const resolve = (item: JobItem): JobItem =>
    item.href === BOARD_HOME ? { href: viewer.boardSeat ? `/board/${viewer.boardSeat}` : '/board' } : item;
  const keep = (items: readonly JobItem[]): JobItem[] => items.map(resolve).filter((item) => open.has(item.href));
  return {
    sections: bar.sections
      .map((section) => ({ label: section.label, items: keep(section.items) }))
      .filter((section) => section.items.length > 0),
    more: keep(bar.more),
  };
}
