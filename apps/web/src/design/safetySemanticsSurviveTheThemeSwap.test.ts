import path from 'node:path';

import { readDesignSystemCss, DESIGN_SYSTEM_ENTRY } from './readDesignSystemCss';

/**
 * THE SAFETY LADDER IS A CONTRACT ON THE THEME, NOT A LOOK.
 *
 * Owner decision, 2026-08-23, on the visual reset:
 *
 *   "Preserve the semantic meanings: locked, restricted, monitor, cleared.
 *    Do NOT preserve their old Leather & Brass visual colors merely for
 *    compatibility. The new PPBF visual system will supply the actual palette.
 *    Every safety/status state must retain a non-color channel: text +
 *    icon/glyph/state label."
 *
 * So the four names are load-bearing and their four VALUES are not. Whatever
 * design-system/current/ points at must define all four, and must keep the
 * second channel that carries the same information without colour. This test
 * is what makes that a requirement on the incoming theme rather than a hope.
 *
 * IT ASSERTS NO COLOUR, DELIBERATELY. The same decision says "do not invent
 * the replacement palette before the new Grok design-system board is
 * approved", so pinning a hex here would be inventing exactly that, one test
 * at a time. It checks that each token is DEFINED and non-empty; what it
 * resolves to is the new system's business.
 *
 * WHY IT READS THE RESOLVED SHEET. The tokens live in the theme today and will
 * live in a different theme tomorrow. Reading design-system/ppbf.css through
 * readDesignSystemCss follows whatever chain the app actually loads, so this
 * keeps working across the swap instead of pointing at a file that is about to
 * be replaced -- which is the whole failure mode the reset is guarding.
 *
 * `--locked` carries an extra restriction that is NOT this file's to enforce:
 * Jason's locked decision of 2026-08-19 reserves it for MEDICALLY_NOT_ALLOWED
 * alone among refusal stamps. refusalStamp.test.ts owns that.
 */

const SAFETY_TOKENS = ['--cleared', '--monitor', '--restricted', '--locked'] as const;

const css = readDesignSystemCss(DESIGN_SYSTEM_ENTRY);

const STRIPPED = css.replace(/\/\*[\s\S]*?\*\//g, '');

/**
 * Everything declared in an UNQUALIFIED `:root` block -- the document-wide
 * definitions, which is what "this token exists" has to mean.
 *
 * Searching the whole sheet instead was this test's first version and it had a
 * hole big enough to walk through: `@media print` re-declares three rungs
 * inside its own `:root`, so deleting `--restricted` from the base ladder
 * outright still left a match and the test stayed green. A theme that defined
 * the ladder only under `@media print`, or only inside `.on-canvas`, would
 * have passed while every screen rendered without it.
 *
 * The scan tracks brace depth so a `:root` nested inside an at-rule is skipped
 * rather than counted -- depth 0 is the only place a definition applies
 * everywhere.
 */
function rootDeclarations(): string {
  const blocks: string[] = [];
  let depth = 0;
  let index = 0;

  while (index < STRIPPED.length) {
    const character = STRIPPED[index];

    if (character === '{') {
      depth += 1;
      index += 1;
      continue;
    }
    if (character === '}') {
      depth -= 1;
      index += 1;
      continue;
    }

    if (depth === 0 && STRIPPED.startsWith(':root', index)) {
      const open = STRIPPED.indexOf('{', index);
      // A selector list may put :root beside something else; both still apply
      // document-wide, so the block counts either way.
      if (open !== -1 && !STRIPPED.slice(index, open).includes('}')) {
        let cursor = open + 1;
        let inner = 1;
        while (cursor < STRIPPED.length && inner > 0) {
          if (STRIPPED[cursor] === '{') inner += 1;
          if (STRIPPED[cursor] === '}') inner -= 1;
          cursor += 1;
        }
        blocks.push(STRIPPED.slice(open + 1, cursor - 1));
        index = cursor;
        continue;
      }
    }

    index += 1;
  }

  return blocks.join('\n');
}

const ROOT_DECLARATIONS = rootDeclarations();

/** The last document-wide definition of a custom property. */
function definitionOf(token: string): string | null {
  const matches = [
    ...ROOT_DECLARATIONS.matchAll(new RegExp(`${token}\\s*:\\s*([^;}]+)[;}]`, 'g')),
  ];
  if (!matches.length) return null;
  return matches[matches.length - 1][1].trim();
}

describe('the safety ladder survives a change of look', () => {
  it('reads a stylesheet with rules in it, so a broken resolver cannot pass this file', () => {
    // Without this, a resolver that returned '' would make every assertion
    // below vacuous in the direction that looks like success.
    expect(css.length).toBeGreaterThan(50_000);
    expect(path.basename(DESIGN_SYSTEM_ENTRY)).toBe('ppbf.css');
  });

  it.each(SAFETY_TOKENS)('%s is defined by whatever theme is loaded', (token) => {
    const value = definitionOf(token);
    expect(value === null ? `${token} is not defined by the loaded design system` : value)
      .not.toBe(`${token} is not defined by the loaded design system`);
    expect((value ?? '').length).toBeGreaterThan(0);
  });

  /* WHAT THIS FILE USED TO ALSO DEMAND, and why it no longer does.

     Owner decision 2026-09-24, via the designer's list: "3 agreed" -- keep the
     outcome, drop the prescribed implementation. Four assertions were removed:

       - every token must ship an `X-ink` pair;
       - a class literally named `.badge` must exist;
       - some `.badge` rule must carry `text-transform: uppercase`;
       - every token must have a `badge--<name>` variant.

     Each of those dictates a component name, a token naming convention or a
     typographic treatment. None of them is the fact. The fact is that a coach
     can tell one state from another WITHOUT decoding colour -- on a wall screen
     in sunlight, in greyscale, or colour blind.

     Two reasons they went rather than being kept as a belt-and-braces:
     they blocked the design outright (defining the rungs on an unqualified
     :root prevents scoping a palette to a new surface, and the coach board is
     being rebuilt with two layouts), and they could not actually prove the
     thing they claimed -- a `.badge` that is uppercase and renders an empty
     string satisfied all four while conveying nothing.

     The outcome is now asserted where it can really be observed: in the
     rendered document. See "a RED readiness band never wears the medical-stop
     rung" in components/coachWorkspaceHonesty.test.tsx, which checks the band
     appears as a WORD on screen, not only as a painted disc.

     WHAT STAYS HERE is the one CSS-level fact a render test cannot reach: swap
     the theme and every safety state must still be defined by whatever sheet is
     now loaded. A state that resolves to nothing is invisible, and no component
     test catches that because jsdom does not apply the stylesheet. */
});
