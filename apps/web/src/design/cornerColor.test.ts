import path from 'node:path';
import { readDesignSystemCss } from '../../src/design/readDesignSystemCss';

/**
 * THE CORNER MUST NEVER BE MISTAKEN FOR A SAFETY STATE.
 *
 * A member picks red corner or blue corner and it tints their own surfaces.
 * Law 2 has already spent the platform's entire saturated-colour budget on the
 * safety ladder -- which is red (--locked, "may not participate"), blue
 * (--monitor), orange (--restricted) and green (--cleared). So a literal red
 * corner in a literal red is, on this platform, indistinguishable from a
 * medical hold on a child.
 *
 * The corner tokens are the answer, and this file is the proof that they are
 * still the answer after somebody edits them. Every value below is read out of
 * design-system/ppbf.css rather than restated here, so a token that changes
 * without its consequences being checked fails the run.
 *
 * THREE PROPERTIES, MEASURED:
 *
 *   1. CHROMA. Every corner token is strictly below the least-saturated rung on
 *      the safety ladder. A corner can never be as saturated as any safety
 *      state -- it is a dye on leather, not a signal lamp.
 *
 *   2. DISTANCE. Every corner token is at least ΔE 20 (CIE76) from every rung
 *      and every -ink tint. Not "a bit different": a different colour.
 *
 *   3. BOTH GROUNDS. Law 6 gives the app ink leather and warm canvas. The edge
 *      used on each ground clears 3:1 against that ground (WCAG 1.4.11 for a
 *      graphical object -- the corner is a rope and a binding, never a text
 *      background), and the 6% wash leaves every text voice on that ground
 *      still clearing 4.5:1.
 */

const PPBF_CSS = path.resolve(__dirname, '../../../../design-system/ppbf.css');

function tokens(): Map<string, string> {
  const css = readDesignSystemCss(PPBF_CSS).replace(/\/\*[\s\S]*?\*\//g, '');
  const found = new Map<string, string>();
  for (const match of css.matchAll(/(--[a-z0-9-]+)\s*:\s*(#[0-9A-Fa-f]{6})\s*[;}]/g)) {
    found.set(match[1], match[2].toUpperCase());
  }
  return found;
}

const TOKENS = tokens();

function hex(name: string): string {
  const value = TOKENS.get(name);
  if (!value) throw new Error(`Missing design token: ${name}`);
  return value;
}

/* ---------------------------------------------------------- COLOUR MATHS -- */

function rgb(value: string): [number, number, number] {
  const raw = value.replace('#', '');
  return [0, 2, 4].map((i) => parseInt(raw.slice(i, i + 2), 16)) as [number, number, number];
}
function linear(channel: number): number {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}
function luminance(value: string): number {
  const [r, g, b] = rgb(value).map(linear);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
function lab(value: string): [number, number, number] {
  const [r, g, b] = rgb(value).map(linear);
  const x = (r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047;
  const y = r * 0.2126 + g * 0.7152 + b * 0.0722;
  const z = (r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883;
  const f = (t: number) => (t > (6 / 29) ** 3 ? Math.cbrt(t) : t / (3 * (6 / 29) ** 2) + 4 / 29);
  const [fx, fy, fz] = [f(x), f(y), f(z)];
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}
function chroma(value: string): number {
  const [, a, b] = lab(value);
  return Math.hypot(a, b);
}
function deltaE(a: string, b: string): number {
  const [l1, a1, b1] = lab(a);
  const [l2, a2, b2] = lab(b);
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2);
}
/** The 6% corner wash, composited over an opaque ground. */
function wash(accent: string, ground: string, fraction = 0.06): string {
  const [ar, ag, ab] = rgb(accent);
  const [gr, gg, gb] = rgb(ground);
  const mix = (a: number, g: number) => Math.round(a * fraction + g * (1 - fraction));
  return `#${[mix(ar, gr), mix(ag, gg), mix(ab, gb)]
    .map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase()}`;
}

/* -------------------------------------------------------------- SUBJECTS -- */

const CORNER_TOKENS = [
  '--corner-red-900', '--corner-red-700', '--corner-red-500', '--corner-red-300',
  '--corner-blue-900', '--corner-blue-700', '--corner-blue-500', '--corner-blue-300',
];

/** The rungs -- what Law 2 calls saturated colour. */
const LADDER_RUNGS = [
  '--cleared', '--monitor', '--restricted', '--locked',
  '--cleared-deep', '--monitor-deep', '--restricted-deep', '--locked-deep',
  '--stamp-red', '--stamp-green',
];
/** The -ink tints, which are the ladder's text colours on the ink ground. */
const LADDER_INKS = ['--cleared-ink', '--monitor-ink', '--restricted-ink', '--locked-ink'];

/** The two grounds, and the panel materials that stand on each. */
const INK_SURFACES = ['--hide-950', '--hide-900', '--hide-800'];
const CANVAS_SURFACES = ['--canvas-warm', '--paper', '--paper-2'];

/** Every text voice that could sit over a washed panel on each ground. */
const INK_VOICES = ['--bone-100', '--bone-200', '--bone-300', '--bone-400'];
const CANVAS_VOICES = ['#241B12', '#3A2E1D', '#6E5B3E', '#4A3B26'];

describe('the corner tokens exist and are real colours', () => {
  it.each(CORNER_TOKENS)('%s is declared', (token) => {
    expect(hex(token)).toMatch(/^#[0-9A-F]{6}$/);
  });

  it('gives the two corners visibly different dyes on each ground', () => {
    // If red and blue were close, the whole feature would be one corner.
    expect(deltaE(hex('--corner-red-300'), hex('--corner-blue-300'))).toBeGreaterThan(20);
    expect(deltaE(hex('--corner-red-700'), hex('--corner-blue-700'))).toBeGreaterThan(20);
  });
});

describe('a corner can never be as saturated as a safety state', () => {
  const ladderFloor = Math.min(...LADDER_RUNGS.map((token) => chroma(hex(token))));

  it('the ladder floor is where we think it is', () => {
    // Guards the guard: if the ladder is ever desaturated, this number moves
    // and the assertions below get stricter rather than silently passing.
    expect(ladderFloor).toBeGreaterThan(20);
    expect(ladderFloor).toBeLessThan(30);
  });

  it.each(CORNER_TOKENS)('%s sits below the ladder floor', (token) => {
    expect(chroma(hex(token))).toBeLessThan(ladderFloor);
  });
});

describe('a corner is a different colour from every safety value', () => {
  const SAFETY = [...LADDER_RUNGS, ...LADDER_INKS];

  it.each(CORNER_TOKENS)('%s is at least ΔE 20 from every rung and tint', (token) => {
    const nearest = SAFETY
      .map((safety) => ({ safety, distance: deltaE(hex(token), hex(safety)) }))
      .sort((a, b) => a.distance - b.distance)[0];
    expect({ token, nearest: nearest.safety, distance: Math.round(nearest.distance) })
      .toEqual({ token, nearest: nearest.safety, distance: expect.any(Number) });
    expect(nearest.distance).toBeGreaterThanOrEqual(20);
  });

  it('no corner token IS a safety token', () => {
    const safetyValues = new Set([...LADDER_RUNGS, ...LADDER_INKS].map((token) => hex(token)));
    for (const token of CORNER_TOKENS) {
      expect(safetyValues.has(hex(token))).toBe(false);
    }
  });
});

describe('the corner survives both grounds', () => {
  /* The -300 rung is the edge on ink leather; the -700 rung is the edge on warm
     canvas. Each is a graphical object -- a rope, a card binding, a plate bevel
     -- so 3:1 is the bar (WCAG 1.4.11), and each clears it comfortably. */
  describe.each([
    ['red', '--corner-red-300', '--corner-red-700'],
    ['blue', '--corner-blue-300', '--corner-blue-700'],
  ])('the %s corner', (_corner, inkEdge, canvasEdge) => {
    it.each(INK_SURFACES)(`its ink edge clears 3:1 against %s`, (surface) => {
      expect(contrast(hex(inkEdge), hex(surface))).toBeGreaterThanOrEqual(3);
    });

    it.each(CANVAS_SURFACES)(`its canvas edge clears 3:1 against %s`, (surface) => {
      expect(contrast(hex(canvasEdge), hex(surface))).toBeGreaterThanOrEqual(3);
    });
  });
});

describe('the 6% wash never costs a text voice its contrast', () => {
  const CASES: Array<[string, string, string, readonly string[]]> = [
    ['red on ink', '--corner-red-300', '--hide-900', INK_VOICES],
    ['blue on ink', '--corner-blue-300', '--hide-900', INK_VOICES],
    ['red on ink panel', '--corner-red-300', '--hide-800', INK_VOICES],
    ['blue on ink panel', '--corner-blue-300', '--hide-800', INK_VOICES],
  ];

  it.each(CASES)('%s keeps every ink voice above 4.5:1', (_label, accent, ground, voices) => {
    const washed = wash(hex(accent), hex(ground));
    for (const voice of voices) {
      expect({ voice, ratio: contrast(hex(voice), washed) >= 4.5 }).toEqual({ voice, ratio: true });
    }
  });

  it.each([
    ['red', '--corner-red-700'],
    ['blue', '--corner-blue-700'],
  ])('%s keeps every canvas voice above 4.5:1', (_label, accent) => {
    for (const ground of ['--canvas-warm', '--paper']) {
      const washed = wash(hex(accent), hex(ground));
      for (const voice of CANVAS_VOICES) {
        expect({ ground, voice, ok: contrast(voice, washed) >= 4.5 })
          .toEqual({ ground, voice, ok: true });
      }
    }
  });

  it('is stated as 6% in the stylesheet, so this test measures what ships', () => {
    const css = readDesignSystemCss(PPBF_CSS);
    expect(css).toMatch(/--corner-wash:\s*color-mix\(in srgb, var\(--corner-mid\) 6%, transparent\)/);
  });
});

describe('Law 3 -- the corner is never the only channel', () => {
  const css = readDesignSystemCss(PPBF_CSS);

  it('states both corner edges per ground, rather than one value for both', () => {
    // The status ladder's own convention. A single value cannot hold 3:1
    // against near-black AND cream, so a corner that is not restated is a
    // corner that is invisible on one of the two grounds.
    expect(css).toMatch(/\.on-canvas \.corner-scope\[data-corner="red"\]/);
    expect(css).toMatch(/\.on-canvas \.corner-scope\[data-corner="blue"\]/);
  });

  it('gives an unset corner the platform’s own chassis rather than a third colour', () => {
    expect(css).toMatch(/--corner-none-edge-ink:\s*var\(--patina-300\)/);
    expect(css).toMatch(/--corner-none-edge-canvas:\s*var\(--wood-700\)/);
  });

  it('shapes the corner swatch as a square, not the round dot the ladder uses', () => {
    // A round dot next to a name is the readiness vocabulary on this platform.
    // The corner marker is deliberately a different shape.
    const swatch = /\.fightcard-corner i \{[^}]*\}/.exec(css)?.[0] ?? '';
    expect(swatch).toContain('border-radius: 2px');
    expect(swatch).not.toContain('border-radius: 50%');
  });
});
