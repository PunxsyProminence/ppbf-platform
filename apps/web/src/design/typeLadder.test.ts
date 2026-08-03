import { readFileSync } from 'node:fs';
import path from 'node:path';

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
  // Later declarations win, which matches how the cascade resolves a repeated
  // custom property inside one :root block.
  for (const match of css.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;}]+)[;}]/gi)) {
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

  throw new Error(`Cannot resolve ${name} to px: ${raw}`);
}

describe('type ladder', () => {
  const tokens = declarations(
    `${readFileSync(DESIGN_SYSTEM, 'utf8')}\n${readFileSync(GLOBALS, 'utf8')}`,
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
