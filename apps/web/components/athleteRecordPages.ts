/* THE PAGES OF AN ATHLETE'S RECORD THAT A LINK CAN OPEN ON ONE ATHLETE
 * (lane AS-11, app scrub CF-15 and CF-23).
 *
 * A link that names one athlete opens its page on that athlete through the
 * page-memory hand-off in decisionLoopArrival.ts: no athlete id goes in any
 * page address (Overwatch ruling on #1474, Q2 = C; lane AS-11 Q3 = A). A
 * hand-off names the page it is for, and only that page takes it, so the link
 * and the page read the same constant from here. */

import { ATHLETE_SAFETY_PAGE } from './decisionLoopArrival';

/** One athlete's Passbook, the athlete page (lane AS-11 Q1 = A). */
export const PASSBOOK_PAGE = '/coach/passbook';

/** Progression Intelligence, where a drill is assigned to an athlete's gap. */
export const PROGRESSION_INTELLIGENCE_PAGE = '/coach/progression-intelligence';

/** Development Plans, the athlete's plan ("plan", lane AS-11 Q2 = A). */
export const DEVELOPMENT_PLANS_PAGE = '/coach/development-blocks';

/** Jump Test and Skill Ratings, the athlete's tests ("tests"). */
export const ASSESSMENTS_PAGE = '/coach/assessments';

/** Athlete Intelligence, what has been computed for the athlete. */
export const ATHLETE_INTELLIGENCE_PAGE = '/coach/athlete-intelligence';

/** Coach Cards ("cards"). Its door and its gate are coach only. */
export const COACH_CARDS_PAGE = '/coach/cards';

/** The Work, the athlete's interventions ("interventions"). */
export const THE_WORK_PAGE = '/coach/intervention-executions';

/** The pages Passbook's line opens on its athlete, in the order of the
    approved plan (lane AS-11 Q2 = A). Athlete Safety is lane AS-5's page and
    keeps its key in decisionLoopArrival.ts; it is linked, not duplicated. */
export const ATHLETE_RECORD_PAGES = [
  ATHLETE_SAFETY_PAGE,
  DEVELOPMENT_PLANS_PAGE,
  ASSESSMENTS_PAGE,
  COACH_CARDS_PAGE,
  THE_WORK_PAGE,
  PROGRESSION_INTELLIGENCE_PAGE,
  ATHLETE_INTELLIGENCE_PAGE,
] as const;
