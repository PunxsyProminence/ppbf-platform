import type { PilotRole } from './contracts';
import { roleEquals } from './roleAlias';

/* /help SHOWS A READER THEIR OWN ROLE'S HELP, AND NOTHING ELSE (F-064).
 *
 * It used to render the builder's master tutorial for everyone: Coach, Board,
 * Admin, Revenue, Dev Lab and Tester guides, with labels such as "FRONT-END
 * SAFE". A parent read all of it. The choice is made here, on the server,
 * before anything is rendered, so another role's sections are never in the
 * page that reaches the browser.
 *
 * Two shapes:
 *  - the platform owner keeps the existing master tutorial (builder material);
 *  - everyone else gets short plain-words help for their own role, each
 *    sentence tied to code.
 * A role this file does not know gets the smallest set ('basic').
 */
export type HelpAudience = 'platform_owner' | 'gym_admin' | 'coach' | 'athlete' | 'parent' | 'board' | 'basic';

export function helpAudienceFor(role: PilotRole | string | null | undefined): HelpAudience {
  if (!role) return 'basic';
  const r = role as PilotRole;
  if (roleEquals(r, 'platform_owner')) return 'platform_owner';
  if (roleEquals(r, 'organization_admin')) return 'gym_admin';
  // staff and volunteer seats get 'basic': nothing in the code ties the coach
  // workspace to them (F-064 review).
  if (roleEquals(r, 'coach')) return 'coach';
  if (roleEquals(r, 'athlete')) return 'athlete';
  if (roleEquals(r, 'parent')) return 'parent';
  if (roleEquals(r, 'board')) return 'board';
  return 'basic';
}

export interface BuilderHelpSelection {
  readonly cards: readonly string[];
  readonly guides: readonly string[];
  readonly planned: readonly string[];
}

/** Section ids per audience. `null` means "every section" (platform owner
 *  only: the master tutorial is builder material). Every other audience gets
 *  the plain help below, whose sentences are each tied to code. */
export function builderHelpFor(audience: HelpAudience): BuilderHelpSelection | null {
  if (audience === 'platform_owner') return null;
  return { cards: [], guides: [], planned: [] };
}

export interface PlainHelpTopic {
  readonly title: string;
  readonly text: string;
}

export interface PlainHelp {
  readonly heading: string;
  readonly intro: string;
  /** Anchor the in-app help buttons link to (getHelpAnchorForContext). */
  readonly anchor: string;
  readonly topics: readonly PlainHelpTopic[];
}

// PROPOSED copy (owner to confirm). Each sentence is tied to code on main as of
// the F-064 review; "when in doubt say less" -- planned/not-built claims were
// dropped unless a screen itself says so.
const PLAIN_HELP: Record<Exclude<HelpAudience, 'platform_owner'>, PlainHelp> = {
  athlete: {
    heading: 'Help for athletes',
    intro: 'Where things are in your PPBF workspace.',
    anchor: 'athlete-guide',
    topics: [
      // app/athlete/dashboard/page.tsx mounts AthleteWorkspace: check-ins, session notes, goals.
      { title: 'Your workspace', text: 'Your dashboard is your athlete workspace: check-ins, session notes and goals.' },
      // app/athlete/video-analysis/page.tsx: h1 "My Film", streams video with coach notes.
      { title: 'My Film', text: 'My Film is where you watch film and read the notes your coach left on it.' },
      // app/athlete/progression-intelligence/page.tsx: h1 "My Progression", lists assigned gaps and a log.
      { title: 'My Progression', text: 'My Progression shows the progression work assigned to you, and you log it there.' },
      // app/api/pilot/shadow/chat/route.ts:563 admits the athlete role.
      { title: 'SHADOW', text: 'SHADOW is a chat helper you can ask questions in.' },
    ],
  },
  parent: {
    heading: 'Help for parents and guardians',
    intro: "Where to find what your athlete's coaches send you.",
    anchor: 'parent-guide',
    topics: [
      // components/ParentHub.tsx:1383-1395 (Parent Floor usage text).
      { title: 'Parent Floor', text: "What the gym has asked of you this week, and anything still open from earlier weeks. Tick a task Done when it is done, and report a barrier at home or with getting here." },
      // components/ParentHub.tsx:1473-1480 (Home Assignments description).
      { title: 'Home Assignments', text: "What your child's coach has set them to work on: drills, and workouts in the coach's order." },
      // components/ParentHub.tsx:1498-1503 (Parent Observations description).
      { title: 'Observations', text: "Write down what you notice at home. It is saved to your child's record at the gym." },
      // components/ParentHub.tsx:1571-1576 and the reply box at ~1660-1690; POST /api/pilot/parent/message-replies.
      { title: 'Messages', text: "Messages from your child's coaches are on the Messages tab, and you can reply to them there." },
      // components/ParentHub.tsx:1776-1795 renders AthleteAchievements audience="family".
      { title: 'Progress', text: "The Progress tab shows your child's achievements, worded for families." },
    ],
  },
  coach: {
    heading: 'Help for coaches',
    intro: 'Where things are in the coach workspace.',
    anchor: 'coach-guide',
    topics: [
      // Directories under app/coach: drills, workout-templates, behavior-standards,
      // decision-loop, video-analysis (h1 "Video Analysis").
      { title: 'Coach workspace', text: 'The coach workspace opens your drills, workout templates, behavior standards, the Decision Loop and the video console.' },
      // app/api/pilot/shadow/chat/route.ts:563 admits the coach role.
      { title: 'SHADOW', text: 'SHADOW is a chat helper you can ask questions in.' },
    ],
  },
  board: {
    heading: 'Help for board members',
    intro: 'Where things are in the board workspace.',
    anchor: 'board-guide',
    topics: [
      // app/board/boardWorkspaceConfig.ts BOARD_AGGREGATE_BOUNDARY_STATEMENT.
      { title: 'What the board sees', text: 'Board access is organization-level and aggregate-only. Small groups are hidden, and missing data shows as unavailable.' },
      { title: 'What stays outside the board role', text: 'Athlete records, messages, notes, intake records, video and safety review are outside this role.' },
      // app/api/pilot/shadow/chat/route.ts:563 does not list the board role.
      { title: 'SHADOW', text: 'SHADOW chat is not available to the board role.' },
    ],
  },
  gym_admin: {
    heading: 'Help for gym administrators',
    intro: 'Where things are for the gym administrator.',
    anchor: 'admin-guide',
    topics: [
      // app/help/page.tsx: /admin admits the gym admin and the platform owner only (admin/page.tsx).
      // Lane U2: the gym admin's home is the Gym Office (/admin/people, Jason 2026-10-17).
      { title: 'Gym Office', text: 'The Gym Office is your home page: people and sign-ins. Every back link returns there.' },
      { title: 'Capabilities', text: 'Capabilities is the record of what this gym can do. Open it from the link at the top of this page.' },
      // app/operations/page.tsx:228 allowedRoles OPERATIONS_ROLES (gym admin and platform owner).
      { title: 'Operations', text: 'Operations is the administration page for the gym administrator and the platform owner.' },
      // app/api/pilot/shadow/chat/route.ts:563 admits organization_admin.
      { title: 'SHADOW', text: 'SHADOW is a chat helper you can ask questions in.' },
    ],
  },
  basic: {
    heading: 'Help',
    intro: 'You are signed in to PPBF.',
    anchor: 'start-here',
    topics: [
      { title: 'Your workspace', text: 'Your pages open from the screen you landed on.' },
    ],
  },
};

export function plainHelpFor(audience: HelpAudience): PlainHelp | null {
  if (audience === 'platform_owner') return null;
  return PLAIN_HELP[audience];
}
