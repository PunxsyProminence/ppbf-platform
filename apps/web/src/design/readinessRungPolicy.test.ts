import { existsSync, readFileSync } from 'node:fs';
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
 * Verified by mutation: restoring `--locked` on any listed site fails this.
 */

const WEB = path.resolve(__dirname, '../..');

/*
 * `readinessBadgeTone` (CoachWorkspace.tsx) was the third site until
 * 2026-08-24. It existed only to badge the coach's "Athlete Floor Plans"
 * panel, and that panel is removed -- it presented plans auto-generated from
 * the unvalidated check-in readiness slider, under a client-supplied athlete
 * name, as individualized coaching input. The mapping went with its only
 * consumer; a new readiness-colouring surface must add itself here.
 */

/*
 * `readinessColor` (RoleSummaryPanels.tsx) was the second site until A-FIN-01
 * (2026-09-22), which removed the athlete readiness tile and with it the
 * mapping's only consumer. The mapping went too: no dormant mapping is kept
 * alive here merely to satisfy a source-text test. What replaced the tile
 * wears no rung in any state, and is guarded by render where it now lives,
 * in components/athleteWorkspace.test.tsx. Any future readiness-coloured
 * surface must add itself back to this guard.
 */
const SITES = [
  ['components/CoachWorkspace.tsx', 'readinessDotClass'],
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
  const lines = source
    .slice(at, at + 600)
    .split('\n')
    .filter((line) => /\b(GREEN|YELLOW|RED)\b/.test(line));

  /* THE WINDOW CAN GO EMPTY WITHOUT THE MAPPING GOING AWAY, and an empty window
     is the one input that satisfies `not.toMatch(/--locked/)` perfectly. The
     name is found -- the assertion above holds -- but the bands drift past the
     600-character window, or a refactor renames GREEN/YELLOW/RED to the band
     values the API already uses, and the filter keeps nothing. The guard then
     reports that readiness never wears the locked medical rung by reading no
     readiness mapping at all.

     Three bands, so three lines; the floor is that the window found any of them.
     Its sibling assertion (`still distinguishes the three bands`) would go red
     too, but only because it happens to be positive -- the reservation this file
     exists for should not depend on that. */
  expect({ site: `${file} / ${name}`, bandLines: lines.length > 0 })
    .toEqual({ site: `${file} / ${name}`, bandLines: true });

  return lines.join('\n');
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

/**
 * WHAT A SHRINKING REGISTRY COSTS, and why these two guards exist.
 *
 * Removing `RoleSummaryPanels.tsx / readinessColor` was correct -- its only
 * consumer went with the athlete readiness tile -- but it halved what this
 * file measures, and the repository noticed before anyone else did: the
 * safety-critical attendance guard failed the run for contributing two tests
 * against a floor of four, while the suite total went UP. A file that guards
 * less than it did, silently, is the exact failure `safetyCriticalSuites.json`
 * is pointed at.
 *
 * The answer is not to lower the floor and not to keep a dormant mapping alive
 * to be counted. It is to guard the two things the registry itself depends on:
 * that the removed surface stays removed, and that the surviving entry is real.
 */
describe('the registry that decides what is guarded', () => {
  /* Executable source only. The provenance comment above deliberately says
     `readinessColor` out loud, so a naive text search for the identifier finds
     the explanation and reports the fix as the violation -- the same trap
     bandLinesOf already documents. Comments are stripped before looking. */
  const executableSourceOf = (file: string): string =>
    readFileSync(path.join(WEB, file), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');

  it('RoleSummaryPanels does not quietly grow a readiness mapping again', () => {
    /* The removed site is the one nothing else covers: that file still has no
       test of its own. So the guard against its return cannot be a render
       assertion -- it has to be here, and it has to fail if a band-to-colour
       mapping reappears in executable code without being registered in SITES
       above. Reinstating the old `readinessColor` turns this red. */
    const source = executableSourceOf('components/RoleSummaryPanels.tsx');
    /* Widened on purpose. `SITES` is `as const`, so today its literal type
       proves this file is not in it and TypeScript calls the comparison
       unintentional -- which is true now and wrong the moment somebody
       registers a mapping here. The guard has to keep working across that
       change, so it asks the registry as data rather than as literal types. */
    const registry = SITES as ReadonlyArray<readonly [string, string]>;
    const registered = registry
      .filter(([file]) => file === 'components/RoleSummaryPanels.tsx')
      .map(([, name]) => name);

    const bandLines = source
      .split('\n')
      .filter((line) => /\b(GREEN|YELLOW|RED)\b/.test(line))
      .filter((line) => /(--|var\(|bg-|text-|border-|color|class)/i.test(line))
      .filter((line) => !registered.some((name) => line.includes(name)));

    expect({ file: 'components/RoleSummaryPanels.tsx', unregisteredBandColourLines: bandLines })
      .toEqual({ file: 'components/RoleSummaryPanels.tsx', unregisteredBandColourLines: [] });
  });

  it('every registered site is real: the file exists and still declares that mapping', () => {
    /* An empty registry, a renamed mapping or a moved file would each leave
       this suite passing while guarding nothing. bandLinesOf would not catch
       an EMPTY list at all -- it.each over [] runs zero tests and reports
       success. */
    expect(SITES.length).toBeGreaterThan(0);

    /* WORD BOUNDARIES, NOT `includes`. Found by mutation: renaming
       `readinessDotClass` to `readinessDotClassRenamed` left this guard green,
       because the new name contains the old one as a substring. A registry
       check that a rename satisfies is not a registry check. */
    const missing = SITES.filter(([file, name]) => {
      if (!existsSync(path.join(WEB, file))) return true;
      return !new RegExp(`\\b${name}\\b`).test(executableSourceOf(file));
    });

    expect({ registered: SITES.length, missing }).toEqual({ registered: SITES.length, missing: [] });
  });
});
