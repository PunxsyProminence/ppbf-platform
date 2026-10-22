import { DESIGN_SYSTEM_ENTRY, readDesignSystemCss } from './readDesignSystemCss';

/**
 * PARENT PORTAL WALK 2026-10-19, ITEM 11: the top bar showed a "⌘K" chip on a
 * phone. A phone has no ⌘ key, and the button's word, "Jump", was the part the
 * phone width hid. It is the other way round now: below 620px the keyboard chord
 * goes and the word stays.
 *
 * jsdom compiles no CSS, so the rule is read from the resolved sheet, the way
 * smallestTypeRung.test.ts reads its rules.
 */
const SHEET = readDesignSystemCss(DESIGN_SYSTEM_ENTRY).replace(/\/\*[\s\S]*?\*\//g, ' ');

/** The bodies of every `@media (max-width: 620px) { ... }` block that names the Jump button. */
function phoneBlocks(): string[] {
  const blocks: string[] = [];
  for (const match of SHEET.matchAll(/@media\s*\(max-width:\s*620px\)\s*\{([^{}]*\{[^{}]*\}\s*)+\}/g)) {
    if (match[0].includes('.catalog-hint')) blocks.push(match[0]);
  }
  return blocks;
}

test('below 620px the keyboard chord is hidden', () => {
  const hides = phoneBlocks().some((block) => /\.catalog-hint\s+kbd\s*\{[^}]*display:\s*none/.test(block));
  expect(hides).toBe(true);
});

test('below 620px the word "Jump" is not hidden', () => {
  const hidesLabel = phoneBlocks().some((block) => /\.catalog-hint-lbl\s*\{[^}]*display:\s*none/.test(block));
  expect(hidesLabel).toBe(false);
  // And nothing elsewhere in the sheet hides it unconditionally.
  expect(/(^|[}\s])\.catalog-hint-lbl\s*\{[^}]*display:\s*none/.test(SHEET.replace(/@media[^{]*\{[\s\S]*?\}\s*\}/g, ''))).toBe(false);
});
