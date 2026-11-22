import type { BoardSeatSlug } from '../app/board/boardWorkspaceConfig';
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
 * Hub tab whose heading carries the stage 2 words. Where a quoted word is a
 * door's own label (Duplicate Guardians, Payment Accounts, Media Consent Audit,
 * Load Gym Content, Waivers & Consent), the mapping is by that label; other
 * readings are marked as inferences where they are made. Each role's Home is the
 * page that role lands on today (getPilotRoleDestination). Items with no page yet are
 * left out, never invented (Overwatch named the first four):
 *   coach    Who needs you (one list); Groups and pathways (Today's Floor,
 *            Adult Pathway and Cohorts exist, but none is that page); Lessons (no
 *            page is titled so).
 *            The athlete page's "reviews" and "what the athlete logged" have no
 *            page of their own; its "film" is Film, in More.
 * Until the athlete page (AS-11) holds them, the athlete page's parts are
 * today's coach pages, listed under Athletes after Passbook.
 *   admin    New member flow; Morning check has no page of its own: it is on
 *            Gym Office, which is Home (AS10-3, #2038), and Safety lists the
 *            pages it counts but Staff Credentials, which is in Members & staff;
 *            Gym TVs (pairing) has no page of its own: it is on
 *            Gym Setup, in Classes & floor.
 *   platform owner  "a gym switcher" for Home: no such page, so Home is Omega,
 *            as the approved names say ("Home (Omega)").
 * The parent's "digest" is on Parent Hub's Overview, which is Home, and
 * "achievements" is the Progress tab ("Progress & Achievements").
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

/**
 * For a board member: boardSeat is the session's landing seat (RoleSession.boardSeat) and picks their
 * Home; boardSeats are every seat they hold (BoardRoleGate's useBoardSession().seats). Pass both where
 * both are known. The held seats, when passed, are the truth: a landing seat they no longer list (a
 * stale cached session) gives Board Hub as Home, never the lost seat; null means none held. With only
 * the landing seat (boardSeats left out), it counts as held (the session derives it from the seats
 * held). With only the seats, Home is Board Hub:
 * which seat a member lands on is decided on the server, and is not guessed here. Unlike visibleDoors,
 * the bar always applies the seat rule, so a call with no viewer shows a board member no seat.
 */
export interface JobBarViewer extends DoorViewer {
  boardSeat?: BoardSeatSlug | null;
}

export interface JobBar {
  readonly sections: readonly JobSection[];
  /** Stage 2's "More" for the coach and the parent: pages off the bar, drawn by 4b. */
  readonly more: readonly JobItem[];
}

const pages = (...hrefs: string[]): JobItem[] => hrefs.map((href) => ({ href }));
const hubTab = (tab: string): JobItem => ({ href: '/parent/dashboard', tab });

/**
 * A board member's Home is their own seat's workspace, where their session lands; with no seat it is
 * Board Hub, the same page as the Board hub section.
 */
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
      // "roster > athlete page (record from Passbook, plan, tests, mental skills, progression, attempts,
      // transfer, cards ...)": Passbook (the athlete page, AS-11), then today's pages for its parts;
      // "Interventions"; "Team (Standards, 1% Club)"; "Competitions"
      {
        label: 'Athletes',
        items: pages(
          '/coach/passbook',
          '/coach/development-blocks', '/coach/assessments', '/coach/mental-skills',
          '/coach/progression-intelligence', '/coach/attempt-log', '/coach/transfer-check', '/coach/cards',
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
      // "roster with clearance and holds > Athlete safety page": Clearance Board, then Athlete Safety (the
      // page AS5-2 built, #2030; Injury Record and Medical Restrictions are sections of it); "Sparring and
      // limits page" (today: Sparring Record, Sparring Caps, Athlete Limits); "Safety queue (escalations and
      // flags)"; "Media consent audit"; "Waivers"
      {
        label: 'Safety',
        items: pages(
          '/coach/sports-medicine', '/coach/athlete-safety',
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
      // "schedule and register, attendance, parent support tasks" (the Parent Floor tab)
      { label: 'This week', items: [...pages('/schedule'), hubTab('attendance'), hubTab('parent-floor')] },
      // "digest (Home's Overview), assignments, achievements (the Progress tab), goals and family goals
      // (the Family Goals tab), their plan, mental skills, full record (read as Progress Visibility, an
      // inference), film, your notes (Observations)"
      {
        label: 'Progress',
        items: [
          hubTab('progress'), hubTab('home-assignments'), hubTab('family-goals'), hubTab('observations'),
          ...pages('/parent/development-blocks', '/parent/mental-skills', '/parent/progression-visibility', '/parent/video'),
        ],
      },
      // "coach messages and replies, "Tell the coach" (today's Report a Barrier)": Report a Barrier is on
      // the Parent Floor tab, which This week also opens for the support tasks
      { label: 'Messages', items: [hubTab('messages'), hubTab('parent-floor')] },
    ],
    // "Resources, help, print, Wall of Names, Ask SHADOW"
    more: [hubTab('resources'), ...pages('/help', '/print', '/names', '/shadow')],
  },
  admin: {
    sections: [
      { label: 'Home', items: pages('/admin/people') },
      // "roster with search, athlete records, Sign-in codes, Load a roster, Duplicate guardians, Data
      // deletion, Enquiries; Staff (coverage, credentials, volunteers)". The roster with search is Home;
      // Enquiries is read as Public Interest (the public page's interest form), and Sign-in codes as
      // Activation Codes and Reset Athlete Sign-In: inferences.
      {
        label: 'Members & staff',
        items: pages(
          '/admin/athletes', '/admin/activation-codes', '/admin/pin', '/admin/import', '/admin/data-quality',
          '/admin/data-deletion', '/admin/public-interest',
          '/admin/coach-coverage', '/admin/credentials', '/admin/volunteer-management',
        ),
      },
      // "Morning check and each queue". The morning check is on Gym Office, which is Home (AS10-3, #2038):
      // its Safety strip opens Safety Review (Escalations and Safety Flags are two of its feeds), and its
      // "Needs review" list counts the office's queues (QUEUES in GymOfficeQueues.tsx), listed here in its
      // order. Staff Credentials is one of them but stays in Members & staff, where stage 2 puts
      // "credentials". Compliance Center is kept: an inference that it is a compliance queue. The waiver queue is
      // Waiver Compliance; Waivers & Consent (the records) stays in Search, in Back Office.
      {
        label: 'Safety',
        items: pages(
          '/admin/safety-review', '/admin/escalations', '/admin/safety-flags',
          '/admin/waiver-status', '/admin/athlete-consent', '/admin/video-compliance', '/admin/video-review',
          '/admin/portrait-review', '/admin/feedback', '/admin/shadow-reviews',
          '/admin/compliance-center',
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
      // equipment, suppliers; export; community service; floor hours; audit trace; board seats".
      // Audit Trace is here and also in Search's Lab: the bar and Search are grouped apart.
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
      // "the onboarding wizard", read as Get Your Gym Online (an inference)
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
export function jobBarFor(role: ClubRole | null, viewer: JobBarViewer = {}): JobBar | null {
  if (!role) return null;
  const bar = JOB_BARS[role];
  if (!bar) return null;
  // Passed (even null, "holds none") the held seats are the truth and fail closed; left out, the landing
  // seat counts as held.
  const boardSeats =
    viewer.boardSeats !== undefined ? (viewer.boardSeats ?? []) : viewer.boardSeat ? [viewer.boardSeat] : [];
  const landing = viewer.boardSeat && boardSeats.includes(viewer.boardSeat) ? viewer.boardSeat : null;
  const open = new Set(visibleDoors(role, { ...viewer, boardSeats }).map((door) => door.href));
  const resolve = (item: JobItem): JobItem =>
    item.href === BOARD_HOME ? { href: landing ? `/board/${landing}` : '/board' } : item;
  const keep = (items: readonly JobItem[]): JobItem[] => items.map(resolve).filter((item) => open.has(item.href));
  return {
    sections: bar.sections
      .map((section) => ({ label: section.label, items: keep(section.items) }))
      .filter((section) => section.items.length > 0),
    more: keep(bar.more),
  };
}
