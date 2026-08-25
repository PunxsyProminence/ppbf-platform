import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { readDesignSystemCss, DESIGN_SYSTEM_ENTRY } from './readDesignSystemCss';

/**
 * THE GUARD ON THE THING TWENTY GUARDS STAND ON.
 *
 * `readDesignSystemCss.ts` exists because `design-system/ppbf.css` stopped
 * being the design system on 2026-08-23 and became two `@import` lines.
 * Thirteen guards were `readFileSync`-ing it at the time. None of them broke.
 * They all kept passing, reading almost nothing, because a test that finds no
 * rule to check is a test that passes.
 *
 * Twenty-one test files now import this resolver. If it ever returned an empty
 * string -- a moved sheet, a regex that stops matching, a refactor that drops
 * the recursion -- every one of them would go green while checking nothing,
 * and the 2026-08-23 incident would repeat with no alarm at all. The resolver's
 * own docblock promises this file proves otherwise. Until now this file did not
 * exist, so the promise was the only thing holding.
 *
 * WHAT IS PROVEN HERE, and why each one is a mutation somebody could ship:
 *
 *   1. The resolution of the REAL entry is a whole sheet and carries rules that
 *      are not in the entry file's own text. Kills "return ''" and kills
 *      "stop resolving relative imports" -- the two ways every dependent guard
 *      goes vacuous at once.
 *   2. Deleting a real rule from a real imported sheet takes it out of the
 *      resolution. That is the claim the docblock makes; it is demonstrated on
 *      a byte-for-byte copy of the foundation sheet rather than asserted.
 *   3. Source order survives, at the position each import was written. Several
 *      dependents (plateVariant.test.ts entirely) assert cascade behaviour that
 *      is decided by order, not specificity. Kills "concatenate at the end".
 *   4. A cycle terminates and contributes nothing.
 *   5. Bare specifiers are left exactly as written.
 *   6. A missing sheet THROWS. It does not resolve to nothing. Silence is the
 *      failure mode this whole file exists to prevent.
 *
 * The fixtures are written to a temp directory. Nothing here mutates anything
 * in the repository -- the one test that needs a sheet to lose a rule copies
 * the real one first and edits the copy.
 */

/* ---------------------------------------------------------------------------
   Markers: rules that live in exactly one sheet of the real chain.

   ppbf.css imports foundation/ppbf-foundation.css, then current/ppbf-theme.css,
   which imports current/ppbf-golden-era.css. `.sr-only` is written only in the
   foundation and `.ge-floorboard` only in the Golden Era sheet -- verified by
   grep across design-system/ on 2026-08-25 -- so each one appearing in the
   resolution is proof that that specific file was opened and inlined, and their
   relative positions are proof of the order the entry asked for.
   --------------------------------------------------------------------------- */
const FOUNDATION_ONLY_RULE = '.sr-only {';
const THEME_ONLY_RULE = '.ge-floorboard {';

const REPO = path.resolve(__dirname, '../../../..');
const REAL_FOUNDATION = path.join(REPO, 'design-system/foundation/ppbf-foundation.css');

let fixtures: string;

function fixture(relative: string, contents: string): string {
  const full = path.join(fixtures, relative);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, contents, 'utf8');
  return full;
}

beforeAll(() => {
  fixtures = mkdtempSync(path.join(os.tmpdir(), 'ppbf-resolver-'));
});

afterAll(() => {
  rmSync(fixtures, { recursive: true, force: true });
});

describe('the resolver reads the real design system, not the file that names it', () => {
  const raw = readFileSync(DESIGN_SYSTEM_ENTRY, 'utf8');
  const resolved = readDesignSystemCss(DESIGN_SYSTEM_ENTRY);

  it('points at the entry every guard is meant to be reading', () => {
    // A path that quietly stopped resolving would make readFileSync throw, not
    // return nothing -- but only if somebody is actually calling it. Say so
    // here so the failure names the entry rather than a downstream selector.
    expect(path.basename(DESIGN_SYSTEM_ENTRY)).toBe('ppbf.css');
    expect(existsSync(DESIGN_SYSTEM_ENTRY)).toBe(true);
  });

  it('returns a whole sheet, not the two-line entry file', () => {
    // ppbf.css is ~1.5KB of comment and two imports; the chain behind it is
    // ~82KB. 60,000 is comfortably below the real figure and roughly forty
    // times above the entry file, so no amount of comment growth in ppbf.css
    // can satisfy this floor without the imports actually being followed.
    expect(raw.length).toBeLessThan(10_000);
    expect(resolved.length).toBeGreaterThan(60_000);
  });

  it('carries rules that exist nowhere in the entry file', () => {
    // The sharpest statement of the 2026-08-23 incident: these two rules are
    // what the browser applies and what the guards ask about, and a plain
    // readFileSync of ppbf.css finds neither of them.
    expect(raw).not.toContain(FOUNDATION_ONLY_RULE);
    expect(raw).not.toContain(THEME_ONLY_RULE);
    expect(resolved).toContain(FOUNDATION_ONLY_RULE);
    expect(resolved).toContain(THEME_ONLY_RULE);
  });

  it('follows an import inside an import', () => {
    // The Golden Era sheet is two hops down -- ppbf.css imports the theme, the
    // theme imports it -- so this is the recursion, not just the first level.
    expect(readFileSync(path.join(REPO, 'design-system/current/ppbf-theme.css'), 'utf8'))
      .not.toContain(THEME_ONLY_RULE);
    expect(resolved).toContain(THEME_ONLY_RULE);
  });

  it('keeps the foundation ahead of the theme, in the order ppbf.css wrote them', () => {
    // ppbf.css calls this order load-bearing: the theme lands second so it can
    // override the foundation's neutral defaults. A resolver that appended
    // instead of inlining could invert it, and every guard reading this string
    // would then be reading a cascade the browser never applies.
    const foundationAt = resolved.indexOf(FOUNDATION_ONLY_RULE);
    const themeAt = resolved.indexOf(THEME_ONLY_RULE);
    expect(foundationAt).toBeGreaterThan(-1);
    expect(themeAt).toBeGreaterThan(-1);
    expect(foundationAt).toBeLessThan(themeAt);
  });

  it('leaves no relative @import unresolved', () => {
    // Anything still spelled as a relative @import after resolution is a sheet
    // that was skipped, and every rule in it is a rule no guard can see.
    expect(resolved).not.toMatch(/@import\s+(?:url\()?["']\.\.?\//);
  });
});

describe('deleting a rule from an imported sheet turns the resolution red', () => {
  /* This is the claim readDesignSystemCss.ts's docblock makes about this file,
     so it is demonstrated rather than asserted, and on the real foundation
     sheet rather than a toy one. The sheet is copied first: a guard that edits
     the repository to prove a point is a worse problem than the one it tests. */
  let entry: string;
  let copy: string;
  let original: string;

  beforeAll(() => {
    original = readFileSync(REAL_FOUNDATION, 'utf8');
    copy = fixture('deletion/ppbf-foundation.css', original);
    entry = fixture(
      'deletion/entry.css',
      '/* stand-in for ppbf.css */\n@import "./ppbf-foundation.css";\n',
    );
  });

  it('starts from a real sheet with the real rule in it', () => {
    expect(original).toContain(FOUNDATION_ONLY_RULE);
    expect(readDesignSystemCss(entry)).toContain(FOUNDATION_ONLY_RULE);
  });

  it('loses the rule, and fails the assertion a guard would make, once it is deleted', () => {
    const at = original.indexOf(FOUNDATION_ONLY_RULE);
    const end = original.indexOf('}', at);
    writeFileSync(copy, original.slice(0, at) + original.slice(end + 1), 'utf8');

    const after = readDesignSystemCss(entry);
    expect(after).not.toContain(FOUNDATION_ONLY_RULE);

    // Stated as a failing expectation on purpose. "The string no longer
    // contains it" is what a resolver returning '' also satisfies; "the check
    // a dependent guard performs now throws" is the thing actually promised.
    expect(() => expect(after).toContain(FOUNDATION_ONLY_RULE)).toThrow();

    // And the loss came from the imported sheet, not from the entry going
    // empty: everything else the sheet holds is still here.
    expect(after.length).toBeGreaterThan(original.length - 500);
    expect(after).toContain('--split-minor');

    writeFileSync(copy, original, 'utf8');
    expect(readDesignSystemCss(entry)).toContain(FOUNDATION_ONLY_RULE);
  });
});

describe('every import is inlined at the position it was written', () => {
  /* The mutation this exists to catch is "collect the imports and concatenate
     them at the end", which reads plausibly, passes any contains-based check,
     and silently reverses the cascade for every guard that asserts about it. */
  let entry: string;

  beforeAll(() => {
    fixture('order/first.css', '.fixture-first { color: red; }\n');
    fixture('order/third.css', '.fixture-third { color: blue; }\n');
    fixture(
      'order/nested/second.css',
      '@import "../third.css";\n.fixture-second { color: green; }\n',
    );
    entry = fixture(
      'order/entry.css',
      [
        '.fixture-before { --a: 1; }',
        '@import "./first.css";',
        '.fixture-between { --b: 2; }',
        "@import './nested/second.css';",
        '.fixture-after { --c: 3; }',
        '',
      ].join('\n'),
    );
  });

  it('interleaves imported rules with the entry’s own, in written order', () => {
    const css = readDesignSystemCss(entry);
    const positions = [
      '.fixture-before',
      '.fixture-first',
      '.fixture-between',
      // third.css is imported by second.css BEFORE second's own rule, so it
      // lands ahead of it -- depth-first, in place, the way a browser flattens.
      '.fixture-third',
      '.fixture-second',
      '.fixture-after',
    ].map((marker) => {
      const at = css.indexOf(marker);
      expect(at).toBeGreaterThan(-1);
      return at;
    });

    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it('resolves a ../ specifier against the importing sheet, not the entry', () => {
    // second.css lives one directory down and asks for ../third.css. Resolved
    // against the entry instead, that path does not exist and the read throws;
    // resolved against second.css it is the file next to the entry.
    expect(readDesignSystemCss(entry)).toContain('.fixture-third');
  });

  it('replaces the import rule rather than keeping it alongside the body', () => {
    const css = readDesignSystemCss(entry);
    expect(css).not.toContain('@import "./first.css"');
    expect(css).not.toContain("@import './nested/second.css'");
  });

  it('handles single and double quotes alike', () => {
    // The entry above writes one of each. Both bodies are present above; this
    // pins that neither quoting style is the one that quietly stops matching.
    const css = readDesignSystemCss(entry);
    expect(css).toContain('.fixture-first');
    expect(css).toContain('.fixture-second');
  });
});

describe('a qualified import is resolved, never silently skipped', () => {
  it('follows layer(), media-qualified and url() forms', () => {
    fixture('qualified/layered.css', '.fixture-layered { --x: 1; }\n');
    fixture('qualified/screened.css', '.fixture-screened { --y: 1; }\n');
    fixture('qualified/wrapped.css', '.fixture-wrapped { --z: 1; }\n');
    const entry = fixture(
      'qualified/entry.css',
      [
        "@import './layered.css' layer(base);",
        '@import "./screened.css" screen and (min-width: 40em);',
        '@import url("./wrapped.css");',
        '',
      ].join('\n'),
    );

    const css = readDesignSystemCss(entry);
    // A sheet skipped because of how its import was qualified is a sheet no
    // guard can see, and nothing anywhere would report it.
    expect(css).toContain('.fixture-layered');
    expect(css).toContain('.fixture-screened');
    expect(css).toContain('.fixture-wrapped');
    expect(css).not.toContain('@import');
  });
});

describe('a cycle terminates and contributes nothing', () => {
  it('resolves without recursing until the stack gives out', () => {
    const a = fixture('cycle/a.css', '.fixture-cycle-a { --a: 1; }\n@import "./b.css";\n');
    fixture('cycle/b.css', '.fixture-cycle-b { --b: 1; }\n@import "./a.css";\n');

    const css = readDesignSystemCss(a);

    // Once each. A second visit contributing its rules again would double every
    // declaration in the cycle, and any guard counting occurrences would then be
    // counting the resolver's arithmetic rather than the sheet's.
    expect(css.match(/\.fixture-cycle-a/g)).toHaveLength(1);
    expect(css.match(/\.fixture-cycle-b/g)).toHaveLength(1);
    expect(css).not.toContain('@import');
  });

  it('does not let a cycle empty the sheet that contains it', () => {
    // The re-entry returns '' by design. That must be the re-entry only: if the
    // FIRST visit ever returned '' the cycle would swallow the whole chain, and
    // that is the vacuum this file exists to keep out of twenty-one guards.
    const a = fixture('cycle/self.css', '.fixture-self { --s: 1; }\n@import "./self.css";\n');
    expect(readDesignSystemCss(a)).toContain('.fixture-self');
  });
});

describe('bare specifiers are left exactly as written', () => {
  it('passes @import "tailwindcss" through untouched', () => {
    fixture('bare/local.css', '.fixture-local { --l: 1; }\n');
    const entry = fixture(
      'bare/entry.css',
      ['@import "tailwindcss";', '@import "./local.css";', ''].join('\n'),
    );

    const css = readDesignSystemCss(entry);
    // Tailwind resolves from node_modules through the bundler. Inlining its
    // whole output into a string a test greps would make every "is this class
    // defined" question meaningless, which is why it is left as a line of text.
    expect(css).toContain('@import "tailwindcss";');
    // And the bare branch must not switch resolution off for its neighbours.
    expect(css).toContain('.fixture-local');
  });
});

describe('a sheet that has moved is loud, not empty', () => {
  it('throws rather than resolving a missing entry to nothing', () => {
    expect(() => readDesignSystemCss(path.join(fixtures, 'not-a-sheet.css'))).toThrow();
  });

  it('throws rather than resolving a missing import to nothing', () => {
    const entry = fixture('missing/entry.css', '@import "./gone.css";\n');
    // The whole failure this repository was burned by is a guard reading less
    // than it thinks it is reading. A moved import must stop the suite, not
    // quietly shorten the string every guard is asserting against.
    expect(() => readDesignSystemCss(entry)).toThrow();
  });
});
