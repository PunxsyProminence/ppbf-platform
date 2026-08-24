import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * READINESS TRIAGE IS NOT A MEDICAL REFUSAL.
 *
 * `readinessBoard.ts` defines its own bands as operational triage and says so
 * in the same sentence: "GREEN = train as planned, YELLOW = check in with the
 * athlete first, RED = adjust the plan", explicitly "not clinical judgments".
 *
 * `--locked` / `#A81E22` is reserved by Jason's locked decision of 2026-08-19
 * for MEDICALLY_NOT_ALLOWED alone -- a clinician saying no. Until 2026-08-24
 * three surfaces painted readiness RED with it, including the child's own
 * status tile: "adjust tonight's plan" wearing the same red as "a doctor has
 * barred this athlete", off a number a staff member typed at intake.
 *
 * WHY THIS IS A SOURCE GUARD RATHER THAN A RENDER ASSERTION, STATED PLAINLY.
 * The roster dot and the floor-plan badge are not reachable in the default
 * state of CoachWorkspace's component test, and RoleSummaryPanels has no test
 * file at all. A behavioural guard was attempted first and could not be made
 * to fail under mutation, which makes it worse than none -- so this reads the
 * mappings themselves. It catches the regression that actually happened (a
 * token swapped back) and would not catch a new surface introducing its own
 * mapping. That limit is the reason it names every known site explicitly.
 *
 * Verified by mutation: restoring `--locked` on any of the three fails this.
 */

const WEB = path.resolve(__dirname, '../..');

const SITES = [
  ['components/CoachWorkspace.tsx', 'readinessDotClass'],
  ['components/CoachWorkspace.tsx', 'readinessBadgeTone'],
  ['components/RoleSummaryPanels.tsx', 'readinessColor'],
] as const;

/**
 * The lines of a named mapping that actually decide a band's rung.
 *
 * COMMENTS ARE STRIPPED AND THE WINDOW IS NARROWED TO BAND LINES, both learned
 * the hard way in one run: a 600-character window around `readinessBadgeTone`
 * swallowed the `BadgeTone` type union (which legitimately contains 'locked'),
 * and the same window around `readinessColor` swallowed the comment explaining
 * why --locked was removed. Both read as violations. A guard that fires on the
 * prose describing the fix is worse than no guard -- it trains the next person
 * to delete it.
 */
function bandLinesOf(file: string, name: string): string {
  const source = readFileSync(path.join(WEB, file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  const at = source.indexOf(name);
  expect(at).toBeGreaterThan(-1);
  return source
    .slice(at, at + 600)
    .split('\n')
    .filter((line) => /\b(GREEN|YELLOW|RED)\b/.test(line))
    .join('\n');
}

describe('readiness never wears the locked medical rung', () => {
  it.each(SITES)('%s / %s does not map a readiness band to --locked', (file, name) => {
    const body = bandLinesOf(file, name);

    expect(body).not.toMatch(/--locked/);
    expect(body).not.toMatch(/'locked'/);
  });

  it.each(SITES)('%s / %s still distinguishes the three bands', (file, name) => {
    // The point is not to flatten readiness into one colour. Three ordered,
    // distinct steps remain -- cleared / monitor / restricted -- so a coach can
    // still tell the states apart at a glance.
    const body = bandLinesOf(file, name);

    expect(body).toMatch(/cleared/);
    expect(body).toMatch(/monitor/);
    expect(body).toMatch(/restricted/);
  });
});
