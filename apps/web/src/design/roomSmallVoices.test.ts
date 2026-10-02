import path from 'node:path';
import { readDesignSystemCss } from './readDesignSystemCss';

/**
 * SMALL VOICES READ ON LIT LEATHER, IN THE FILE ROOM AND THE BOARD ROOM.
 *
 * The leather materials are not a flat dark ground. Each carries a warm
 * highlight toward its top-left corner, screened over its gradient, and under
 * that highlight the ground is a mid brown. The three small voices were tuned
 * against dark hide, and on the lit part they did not read: measured on
 * rendered pixels on 2026-10-02, signed in, the eyebrow at 2.6-4.4:1 and the
 * label and muted voices at 3.0-4.1:1, on every file-room and board-room page.
 * Nothing had caught it, because a contrast figure against "leather" is a
 * figure against the dark end of a gradient the text does not sit on.
 *
 * So this computes the LIT ground from what the sheet declares -- the lightest
 * stop of the material's own gradient with its own highlight screened over it
 * -- and requires each small voice, in those two rooms, to read against that.
 * The model was checked against pixels before it was trusted: it gives a
 * relative luminance of 0.112 for raised leather, and the screenshot measured
 * 0.113.
 *
 * WHAT THIS DOES NOT PIN. Not a colour, not a rung, not a material's recipe.
 * A redesign may change the leather, the highlight or the ink; this only asks
 * that whatever ink these voices take reads on whatever the lit part of the
 * material turns out to be. If the materials stop being built from a gradient
 * and a highlight, the two parsers below find nothing and say so by failing,
 * and this file is rewritten against the new material -- by reading pixels
 * again first.
 *
 * THE MODEL IS A LITTLE KIND, SO IT IS HELD TO A LITTLE MORE. Against pixels the
 * lit ground measured up to 0.125 on one page (the grain overlay lightens it),
 * so the stock-leather cases add that difference to the ground before taking
 * the ratio. The brightest 5% of grain pixels still fall under the floor; a
 * ratio is about the ground a word sits on, not its lightest speck.
 *
 * TWO SCREENS IN THESE ROOMS RESTYLE THEIR OWN LEATHER. The Research Inbox
 * (`.ge-file`) and the Board Hub (`.ge-board`) redefine the brass ramp to a
 * darker bronze, darken their leather, and state their own inks for some of
 * these voices. A token resolved at the document root is therefore the wrong
 * ink on those two screens. The second half of this file resolves each voice
 * and each ground INSIDE the scope: every ink the scope could give the voice
 * (its own rule, and the room rule with the scope's tokens) against the
 * brightest leather that scope declares. /board cannot be rendered locally
 * (the synthetic data has no board account), so for that screen this
 * arithmetic is the only check there is.
 *
 * WHAT IT CANNOT SEE. Declared values, not a rendered page: a plate showing
 * through, a voice placed on some other ground (a plaque, a stat tile, paper),
 * a later rule that outranks the ones read here, and any page outside these
 * two rooms. `npm run sweep` and a person looking are what cover those.
 */

const SHEET = readDesignSystemCss(path.join(__dirname, '../../../../design-system/ppbf.css'))
  .replace(/\/\*[\s\S]*?\*\//g, '');

type Rgb = [number, number, number];

const hex = (value: string): Rgb => {
  const h = value.replace('#', '');
  const full = h.length === 3 ? [...h].map((c) => c + c).join('') : h;
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16)) as Rgb;
};
const luminance = ([r, g, b]: Rgb) => {
  const lin = (c: number) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
};
const contrast = (a: Rgb, b: Rgb) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

/** The body of the rule whose selector is exactly `selector`. */
function ruleBody(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = SHEET.match(new RegExp(`(?:^|\\})\\s*${escaped}\\s*\\{([^}]*)\\}`, 'm'));
  return match ? match[1] : '';
}

/** The brightest the material gets: its gradient's lightest stop with its
 *  highlight screened over it at the highlight's own alpha. */
function litGround(material: string): Rgb | null {
  const body = ruleBody(material);
  const stops = [...(body.match(/linear-gradient\(([^;]*)\)/)?.[1] ?? '').matchAll(/#[0-9a-fA-F]{3,6}\b/g)]
    .map((m) => hex(m[0]));
  const highlight = body.match(/radial-gradient\([^)]*?rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*([\d.]+)\s*\)\s*,\s*transparent/);
  if (stops.length === 0 || !highlight) return null;
  const base = stops.reduce((a, b) => (luminance(a) >= luminance(b) ? a : b));
  const alpha = Number(highlight[4]);
  const light = [Number(highlight[1]), Number(highlight[2]), Number(highlight[3])];
  // Screen blend of the highlight at `alpha` over the base.
  return base.map((c, i) => Math.round(c + light[i] * alpha - (c * light[i] * alpha) / 255)) as Rgb;
}

/** A token's value as the document root declares it. */
function rootToken(name: string): Rgb | null {
  const match = SHEET.match(new RegExp(`${name}\\s*:\\s*(#[0-9a-fA-F]{3,6})\\b`));
  return match ? hex(match[1]) : null;
}

/** The ink the two rooms give a voice on dark leather: the colour declared by
 *  the rule that names both rooms and that voice. */
function roomInk(voice: string): Rgb | null {
  for (const [, selector, body] of SHEET.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    if (!selector.includes('.room--file') || !selector.includes('.room--board')) continue;
    if (!new RegExp(`\\${voice}\\b`).test(selector)) continue;
    const colour = body.match(/(?:^|;)\s*color\s*:\s*([^;]+)/)?.[1].trim();
    if (!colour) continue;
    const token = colour.match(/^var\((--[a-z0-9-]+)\)$/)?.[1];
    return token ? rootToken(token) : colour.startsWith('#') ? hex(colour) : null;
  }
  return null;
}

/* ---- inside a scope ------------------------------------------------------ */

const RULES: Array<[selector: string, body: string]> =
  [...SHEET.matchAll(/([^{}]+)\{([^}]*)\}/g)].map((m) => [m[1].trim(), m[2]]);

/** A token as `scope` declares it on its own rule, else as the root does. */
function scopeToken(scope: string, name: string): string | null {
  const own = RULES.find(([selector, body]) => selector === scope && new RegExp(`${name}\\s*:`).test(body));
  const from = own ? own[1] : SHEET;
  return from.match(new RegExp(`${name}\\s*:\\s*([^;}]+)`))?.[1].trim() ?? null;
}

/** A declared colour as RGB, resolving var() and color-mix() inside `scope`. */
function colour(value: string, scope: string): Rgb | null {
  const v = value.trim();
  if (v.startsWith('#')) return hex(v);
  const token = v.match(/^var\((--[a-z0-9-]+)\)$/)?.[1];
  if (token) {
    const declared = scopeToken(scope, token);
    return declared ? colour(declared, scope) : null;
  }
  const mix = v.match(/^color-mix\(in srgb,\s*(.+?)\s+(\d+)%\s*,\s*(.+?)\)$/);
  if (mix) {
    const a = colour(mix[1], scope);
    const b = colour(mix[3], scope);
    const share = Number(mix[2]) / 100;
    return a && b ? (a.map((c, i) => Math.round(c * share + b[i] * (1 - share))) as Rgb) : null;
  }
  return null;
}

/** Every ink `scope` could give `voice` on its leather: the scope's own rules
 *  for that voice, and the room rule read with the scope's tokens. */
function scopeInks(scope: string, voice: string): Rgb[] {
  const voiceClass = new RegExp(`\\${voice}(?![a-z0-9-])`);
  const declared = RULES
    .filter(([selector]) => voiceClass.test(selector)
      && (selector.includes(scope) || (selector.includes('.room--file') && selector.includes('.room--board'))))
    .filter(([selector]) => !/\.mat-paper|\.on-plaster|\.on-canvas\s/.test(selector.split(':not')[0].split(':where(:not')[0]))
    .map(([, body]) => body.match(/(?:^|;)\s*color\s*:\s*([^;]+)/)?.[1])
    .filter((value): value is string => Boolean(value));
  return declared.map((value) => colour(value, scope)).filter((rgb): rgb is Rgb => rgb !== null);
}

/** The brightest leather `scope` declares: for each of its leather rules, the
 *  lightest gradient stop with the rule's highlight screened over it. */
function scopeLitGround(scope: string): Rgb | null {
  const grounds: Rgb[] = [];
  for (const [selector, body] of RULES) {
    if (!selector.startsWith(scope) || !selector.includes('.mat-leather')) continue;
    const stops = [...body.matchAll(/#[0-9a-fA-F]{6}\b/g)].map((m) => hex(m[0]));
    if (!/linear-gradient/.test(body) || stops.length === 0) continue;
    const base = stops.reduce((a, b) => (luminance(a) >= luminance(b) ? a : b));
    const highlight = body.match(/rgb\(var\((--[a-z0-9-]+-rgb)\)\s*\/\s*([\d.]+)\)/);
    if (!highlight) { grounds.push(base); continue; }
    const triple = (scopeToken(scope, highlight[1]) ?? '').split(/\s+/).map(Number);
    const alpha = Number(highlight[2]);
    grounds.push(triple.length === 3
      ? (base.map((c, i) => Math.round(c + triple[i] * alpha - (c * triple[i] * alpha) / 255)) as Rgb)
      : base);
  }
  return grounds.length ? grounds.reduce((a, b) => (luminance(a) >= luminance(b) ? a : b)) : null;
}

const MATERIALS = ['.mat-leather', '.mat-leather--raised'];
const SCOPES = ['.ge-file', '.ge-board'];
/** Measured ground minus modelled ground, at its worst (see the header). */
const MODEL_ALLOWANCE = 0.015;
const contrastOnLit = (ink: Rgb, lit: Rgb) =>
  (luminance(ink) + 0.05) / (luminance(lit) + MODEL_ALLOWANCE + 0.05);
const VOICES = ['.t-eyebrow', '.t-label', '.t-muted'];
const FLOOR = 4.5; // all three are small text

describe('small voices read on lit leather in the file room and the board room', () => {
  it.each(MATERIALS)('%s declares a gradient and a highlight this can read', (material) => {
    // If the material is rebuilt some other way, this is the line that says
    // the model below no longer describes it.
    expect(litGround(material)).not.toBeNull();
  });

  it('the model can tell an ink that fails: the old eyebrow and caption rungs do not read on lit leather', () => {
    const lit = litGround('.mat-leather--raised') as Rgb;
    expect(contrast(rootToken('--brass-400') as Rgb, lit)).toBeLessThan(FLOOR);
    expect(contrast(rootToken('--bone-400') as Rgb, lit)).toBeLessThan(FLOOR);
  });

  describe.each(MATERIALS)('on %s', (material) => {
    it.each(VOICES)('%s reads at 4.5:1 or better', (voice) => {
      const ink = roomInk(voice);
      const lit = litGround(material);
      expect(ink).not.toBeNull();
      expect(lit).not.toBeNull();
      expect(contrastOnLit(ink as Rgb, lit as Rgb)).toBeGreaterThanOrEqual(FLOOR);
    });
  });
});

describe('the two screens that restyle their own leather keep these voices readable', () => {
  describe.each(SCOPES)('inside %s', (scope) => {
    it('declares leather this can read', () => {
      expect(scopeLitGround(scope)).not.toBeNull();
    });

    it.each(VOICES)('every ink %s can take reads at 4.5:1 or better on the brightest leather there', (voice) => {
      const lit = scopeLitGround(scope) as Rgb;
      const inks = scopeInks(scope, voice);
      // The room rule always applies, so there is always at least one.
      expect(inks.length).toBeGreaterThan(0);
      const ratios = inks.map((ink) => Number(contrast(ink, lit).toFixed(2)));
      expect(Math.min(...ratios)).toBeGreaterThanOrEqual(FLOOR);
    });
  });

  it('the scoped model can tell an ink that fails: bronze brass-200 on stock raised leather', () => {
    // The hole a reviewer found: the scopes' darker bronze would not read on
    // leather that had NOT been darkened. This is that case, and it must fail.
    const bronze = colour('var(--brass-200)', '.ge-file') as Rgb;
    expect(contrastOnLit(bronze, litGround('.mat-leather--raised') as Rgb)).toBeLessThan(FLOOR);
  });
});
