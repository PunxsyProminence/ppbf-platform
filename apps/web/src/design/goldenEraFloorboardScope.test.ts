import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * GOLDEN ERA 002 — THE FLOOR BOARD (Coach Workspace).
 *
 * Two separate contracts live here, and the second is the one that matters.
 *
 * 1. THE TOKEN SCOPE. `.ge-floorboard` redefines the brass ramp to aged bronze
 *    so the shared components on this route (the .mat-leather tab rail, the tab
 *    buttons, the .t-command / .t-eyebrow voices) resolve Golden Era metal
 *    together. A property override leaks wherever it is forgotten; a token
 *    override cannot. Same seam `.ge-bell` uses.
 *
 * 2. THE REAL TAB SET SURVIVES THE MOCKUP. The locked 002 reference draws a tab
 *    bar reading MORNING READ / FLOOR / DECISION LOOP / SCRIPTS / DRILLS /
 *    RECOGNITION / VIDEO / INTEL. That is NOT this component's navigation:
 *    DECISION LOOP, SCRIPTS, DRILLS and RECOGNITION are separate routes
 *    (/coach/decision-loop, /coach/session-scripts, /coach/drills,
 *    /coach/recognition), and MORNING READ has nothing behind it at all.
 *    Implementing the image literally would delete six real tabs (Dashboard,
 *    Development, Goals, Tasks, Assessments, Athlete Reviews) and invent four
 *    controls with no backing.
 *
 *    A visual pass is exactly when that kind of deletion happens quietly, so it
 *    is pinned: the nine real tabs must still be there, and the invented labels
 *    must NOT appear in the tab list. If the owner later decides the coach
 *    workspace really should absorb those routes, that is an
 *    information-architecture change with its own PR and its own tests — not a
 *    side effect of restyling.
 *
 * MUTATION CHECK: delete a `--brass-NNN` line from the `.ge-floorboard` block,
 * or drop the class from the page, or rename a real tab to a mockup label —
 * each turns this suite red.
 */

const WORKSPACE = readFileSync(
  path.resolve(__dirname, '../../components/CoachWorkspace.tsx'),
  'utf8',
);

/* 2026-10-02 (OD-2026-10-02-004, OD-2026-10-02-007): nothing about the look
   binds, so the cases here that pinned this screen's look were removed -- the
   bronze ramp and its channel triples, the scope class, selector shape, "only
   markup this pass added", control counts and "not renamed". What remains
   guards meaning and function: the --locked token, stamps and badges, gates
   and refusals, real controls still present, nothing invented. Where the
   header above describes a removed case it is history, kept as the record of
   why the case was written. */

describe('the 002 mockup did not delete or invent coach tabs', () => {
  // Every tab that really exists on current main.
  const REAL_TABS = [
    'Dashboard',
    'Floor',
    'Development',
    'Goals',
    'Tasks',
    'Assessments',
    'Film Study',
    'Athlete Reviews',
    'SHADOW Intel',
  ] as const;

  /** The COACH_TABS array only, so a label appearing elsewhere in the file
   *  (a heading, a comment) cannot satisfy or break these assertions. */
  function tabBlock(): string {
    const m = WORKSPACE.match(/const COACH_TABS = \[([\s\S]*?)\] as const/);
    expect(m).not.toBeNull();
    return (m as RegExpMatchArray)[1];
  }

  test.each(REAL_TABS)('the real tab %s still exists', (label) => {
    expect(tabBlock()).toContain(`label: '${label}'`);
  });

  test('no tab was invented from the reference image', () => {
    // Drawn in the locked mockup but backed by nothing here: four are separate
    // routes, and Morning Read does not exist at all.
    const INVENTED = ['Morning Read', 'Decision Loop', 'Scripts', 'Drills', 'Recognition'];
    for (const label of INVENTED) {
      expect(tabBlock()).not.toContain(`label: '${label}'`);
    }
  });

});
