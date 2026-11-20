/* THE PAGES OF AN ATHLETE'S RECORD THAT A LINK CAN OPEN ON ONE ATHLETE
 * (lane AS-11, app scrub CF-15 and CF-23).
 *
 * A link that names one athlete opens its page on that athlete through the
 * page-memory hand-off in decisionLoopArrival.ts: no athlete id goes in any
 * page address (Overwatch ruling on #1474, Q2 = C; lane AS-11 Q3 = A). A
 * hand-off names the page it is for, and only that page takes it, so the link
 * and the page read the same constant from here. */

/** One athlete's Passbook, the athlete page (lane AS-11 Q1 = A). */
export const PASSBOOK_PAGE = '/coach/passbook';

/** Progression Intelligence, where a drill is assigned to an athlete's gap. */
export const PROGRESSION_INTELLIGENCE_PAGE = '/coach/progression-intelligence';
