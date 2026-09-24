import { readFileSync } from 'node:fs';
import path from 'node:path';
import { readDesignSystemCss } from '../../src/design/readDesignSystemCss';

/**
 * The type ladder must never go DOWN as the name goes up.
 *
 * globals.css aliases Tailwind's own theme variable names (--text-xs through
 * --text-4xl) onto the design system's phi ladder, and its :root block is
 * UNLAYERED, so it beats Tailwind's `@layer theme` for every name it sets and
 * leaves every name it does not.
 *
 * That asymmetry inverted the scale. --text-4xl was aliased to --t-3xl (50px),
 * which is the top of ppbf.css's ladder, while --text-5xl stayed at Tailwind's
 * 48px. Every `text-4xl md:text-5xl` heading in the app -- a common responsive
 * pair -- therefore got SMALLER when the viewport got larger.
 *
 * A test rather than a comment because the failure is invisible in review: both
 * files look right on their own, and the bug lives only in the relationship
 * between them.
 */

const GLOBALS = path.resolve(__dirname, '../../app/globals.css');
const DESIGN_SYSTEM = path.resolve(__dirname, '../../../../design-system/ppbf.css');

function declarations(css: string): Map<string, string> {
  const found = new Map<string, string>();
  // Comments first. Both stylesheets discuss their own token names in prose --
  // "it previously stopped at --text-4xl, which left --text-5xl on Tailwind's
  // default" -- and a naive scan reads those as declarations, swallowing the
  // real ones that follow. That cost a debugging round: the test reported
  // --text-xs missing from a file that plainly declares it.
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');

  // Later declarations win, which matches how the cascade resolves a repeated
  // custom property inside one :root block.
  for (const match of withoutComments.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;}]+)[;}]/gi)) {
    found.set(match[1], match[2].trim());
  }
  return found;
}

function resolvePx(name: string, tokens: Map<string, string>, seen = new Set<string>()): number {
  if (seen.has(name)) {
    throw new Error(`Cyclic custom property: ${name}`);
  }
  seen.add(name);

  const raw = tokens.get(name);
  if (raw === undefined) {
    throw new Error(`Missing custom property: ${name}`);
  }

  const varRef = raw.match(/^var\((--[a-z0-9-]+)\)$/i);
  if (varRef) {
    return resolvePx(varRef[1], tokens, seen);
  }

  const px = raw.match(/^([\d.]+)px$/);
  if (px) {
    return Number.parseFloat(px[1]);
  }

  const rem = raw.match(/^([\d.]+)rem$/);
  if (rem) {
    return Number.parseFloat(rem[1]) * 16;
  }

  // The top of the ladder is generated rather than listed: the rungs nothing
  // uses today are continued as `calc(var(--t-5xl) * var(--root-phi) * ...)`
  // so they stay monotonic without inventing named sizes no screen asks for.
  // Only multiplication of var() references and numbers appears here, which is
  // all this evaluates -- anything else should fail loudly rather than be
  // guessed at.
  const calc = raw.match(/^calc\(([^)]*(?:\([^)]*\)[^)]*)*)\)$/i);
  if (calc) {
    return calc[1]
      .split('*')
      .map((term) => {
        const trimmed = term.trim();
        const ref = trimmed.match(/^var\((--[a-z0-9-]+)\)$/i);
        if (ref) {
          return resolvePx(ref[1], tokens, new Set(seen));
        }
        const literal = Number.parseFloat(trimmed);
        if (Number.isNaN(literal)) {
          throw new Error(`Cannot evaluate calc term in ${name}: ${trimmed}`);
        }
        return literal;
      })
      .reduce((product, value) => product * value, 1);
  }

  // A bare unitless number, which --root-phi and the other ratios are.
  const unitless = raw.match(/^[\d.]+$/);
  if (unitless) {
    return Number.parseFloat(raw);
  }

  throw new Error(`Cannot resolve ${name} to px: ${raw}`);
}

describe('type ladder', () => {
  const tokens = declarations(
    `${readDesignSystemCss(DESIGN_SYSTEM)}\n${readFileSync(GLOBALS, 'utf8')}`,
  );

  // Only the sizes globals.css actually sets. Anything it does not set falls
  // through to Tailwind's default, and mixing the two is exactly the defect.
  const LADDER = [
    '--text-xs',
    '--text-sm',
    '--text-lg',
    '--text-xl',
    '--text-2xl',
    '--text-3xl',
    '--text-4xl',
    '--text-5xl',
    '--text-6xl',
    '--text-7xl',
    '--text-8xl',
    '--text-9xl',
  ];

  it('never gets smaller as the step gets larger', () => {
    const sizes = LADDER.map((name) => ({ name, px: resolvePx(name, tokens) }));

    for (let i = 1; i < sizes.length; i += 1) {
      const previous = sizes[i - 1];
      const current = sizes[i];
      // Named in the failure so the report says which pair inverted rather
      // than only that something did.
      expect({ step: current.name, px: current.px, mustExceed: previous.name })
        .toMatchObject({ px: expect.any(Number) });
      expect(current.px).toBeGreaterThan(previous.px);
    }
  });

  // The specific pair that broke, asserted by name so a future edit that
  // reintroduces it fails with an obvious message.
  it('keeps text-5xl above text-4xl, the responsive pair that inverted', () => {
    expect(resolvePx('--text-5xl', tokens)).toBeGreaterThan(resolvePx('--text-4xl', tokens));
  });

  // Negative control: the helper must actually be reading real values. If the
  // parser silently returned nothing, every assertion above would pass on an
  // empty list.
  it('resolves through the alias chain to the design system', () => {
    expect(resolvePx('--text-4xl', tokens)).toBe(50);
    expect(resolvePx('--text-lg', tokens)).toBe(19.1);
  });
});
