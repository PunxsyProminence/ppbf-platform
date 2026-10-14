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
 *  - administrators get the existing guide sections, narrowed to the ones that
 *    are theirs (the platform owner also keeps the builder-facing ones);
 *  - everyone else gets short plain-words help written for their own role.
 * A role this file does not know gets the smallest set ('basic').
 */
export type HelpAudience = 'platform_owner' | 'gym_admin' | 'coach' | 'athlete' | 'parent' | 'board' | 'basic';

export function helpAudienceFor(role: PilotRole | string | null | undefined): HelpAudience {
  if (!role) return 'basic';
  const r = role as PilotRole;
  if (roleEquals(r, 'platform_owner')) return 'platform_owner';
  if (roleEquals(r, 'organization_admin')) return 'gym_admin';
  if (roleEquals(r, 'coach') || roleEquals(r, 'staff')) return 'coach';
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

const GYM_ADMIN_SECTIONS = [
  'start-here',
  'mission-control-overview',
  'admin-guide',
  'revenue-guide',
  'coach-guide',
  'shadow-guide',
  'planned-capabilities-guide',
] as const;

/** Section ids per administrator audience. `null` means "every section". */
export function builderHelpFor(audience: HelpAudience): BuilderHelpSelection | null {
  if (audience === 'platform_owner') return null;
  if (audience === 'gym_admin') {
    return {
      // No master-tutorial cards: their status stamps are builder labels.
      cards: [],
      guides: GYM_ADMIN_SECTIONS.filter((id) => id !== 'planned-capabilities-guide'),
      planned: ['planned-ai-video', 'planned-compliance', 'planned-progression', 'planned-publication'],
    };
  }
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

// PROPOSED copy (owner to confirm). Every sentence restates what the existing
// guide sections already say about that role's screens; none adds a feature.
const PLAIN_HELP: Record<Exclude<HelpAudience, 'platform_owner' | 'gym_admin'>, PlainHelp> = {
  athlete: {
    heading: 'Help for athletes',
    intro: 'Where things are in your PPBF workspace.',
    anchor: 'athlete-guide',
    topics: [
      { title: 'Your workspace', text: 'Your dashboard shows your goals, tasks, readiness and progress.' },
      { title: 'Progression and My Video', text: 'These show real records from your gym. Automatic video analysis is not built yet.' },
      { title: 'SHADOW', text: 'SHADOW is a chat helper that explains and drafts. It does not replace your coach.' },
    ],
  },
  parent: {
    heading: 'Help for parents and guardians',
    intro: "Where to find what your athlete's coaches send you.",
    anchor: 'parent-guide',
    topics: [
      { title: 'Messages', text: "Tasks from a coach that have a due date show on the Messages tab. This week's tasks, and anything still open from earlier, also show on the Parent Floor." },
      { title: 'Assignments', text: 'Home assignments from the coaches show on the Assignments tab.' },
      { title: 'Observations', text: 'What you write down is kept and read back to you on the Observations tab.' },
      { title: 'Progress', text: 'The Progress tab shows milestones your athlete has earned and a count of recorded progression.' },
      { title: 'Not built yet', text: 'Family goals, resources and replying to a coach have no feed behind them yet.' },
    ],
  },
  coach: {
    heading: 'Help for coaches and staff',
    intro: 'Where things are in the coach workspace.',
    anchor: 'coach-guide',
    topics: [
      { title: 'Coach workspace', text: 'Your athletes, film study on released video, and the coaching workflows are opened from the coach workspace.' },
      { title: 'Not built yet', text: 'The review queue and automatic video scoring (skill, punch, footwork) are planned. Pages that say so have nothing behind them yet.' },
      { title: 'SHADOW', text: 'SHADOW is a chat helper that explains and drafts. The decision stays with you.' },
    ],
  },
  board: {
    heading: 'Help for board members',
    intro: 'Where things are in the board workspace.',
    anchor: 'board-guide',
    topics: [
      { title: 'Governance', text: 'The board workspace holds policy, strategy, resolutions, committees and oversight.' },
      { title: 'Compliance', text: 'The compliance register shows real records. Automatic compliance monitoring is planned.' },
      { title: 'SHADOW', text: 'SHADOW chat is not available to the board role.' },
    ],
  },
  basic: {
    heading: 'Help',
    intro: 'You are signed in to PPBF.',
    anchor: 'start-here',
    topics: [
      { title: 'Your workspace', text: "Your pages open from the screen you landed on." },
    ],
  },
};

export function plainHelpFor(audience: HelpAudience): PlainHelp | null {
  if (audience === 'platform_owner' || audience === 'gym_admin') return null;
  return PLAIN_HELP[audience];
}
