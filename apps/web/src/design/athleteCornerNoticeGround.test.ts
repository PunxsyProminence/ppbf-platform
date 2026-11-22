import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * MY CORNER'S HOLD AND RESTRICTION NOTICES STAND ON LEATHER (lane AS-8, Q-INK;
 * Overwatch Q-INK A on #2020: "Those notices must be readable; this is a
 * defect fix").
 *
 * TrainingHoldBanner and MedicalRestrictionNotice render into My Corner's one
 * wide cell that is not a panel (AthleteCorner's afterPain slot). They are
 * written in bone for a dark ground; on the corner's canvas they measured
 * 2.1:1 (the hold headline), 1.9:1 (the restriction sentence) and 1.7:1 (the
 * Restricted badge) in Chromium. The slot now takes the panels' leather, and
 * the hold's brass stamp the brass the sheet gives it on any dark mat. An
 * empty slot (no hold, no restriction) still draws nothing.
 *
 * This reads the stylesheet, not a rendered page: the measured ratios are in
 * the pull request (local Chromium, 392px).
 */

const THEME = readFileSync(
  path.resolve(__dirname, '../../../../design-system/current/ppbf-golden-era.css'),
  'utf8',
);

const SLOT = '.athlete-corner__wide:not(.athlete-corner__panel):not(:empty)';

/** The declarations of the first rule whose selector list names `selector`. */
function ruleFor(selector: string): string {
  for (const match of THEME.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = match[1].replace(/\/\*[\s\S]*?\*\//g, '').split(',').map((part) => part.trim());
    if (selectors.includes(selector)) return match[2];
  }
  throw new Error(`no rule names ${selector}`);
}

test('the slot shares the corner panels\' leather ground and bone ink', () => {
  const slot = ruleFor(SLOT);
  expect(slot).toBe(ruleFor('.athlete-corner__panel'));
  expect(slot).toMatch(/background-color:\s*#5a3820/);
  expect(slot).toMatch(/color:\s*var\(--bone-100\)/);
});

test('the hold stamp in the slot takes the dark-mat brass', () => {
  expect(ruleFor(`${SLOT} .stamp--brass`)).toMatch(/color:\s*var\(--brass-300\)/);
});

test('an empty slot still draws nothing: the leather rule does not match it', () => {
  expect(ruleFor('.athlete-corner__wide:empty')).toMatch(/display:\s*none/);
  // The leather rule sets display: flex; without :not(:empty) it would tie with
  // the :empty rule and win by coming later, drawing an empty box.
  expect(THEME).not.toMatch(/\.athlete-corner__wide:not\(\.athlete-corner__panel\)(?!:not\(:empty\))/);
});
