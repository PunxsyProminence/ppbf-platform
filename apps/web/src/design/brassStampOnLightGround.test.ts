import path from 'node:path';
import { readDesignSystemCss } from '../../src/design/readDesignSystemCss';

/**
 * THE BRASS STAMP READS ON THE LIGHT GROUNDS, AND LEATHER STILL WINS ON LEATHER.
 *
 * `.stamp--brass` is --brass-600, and the sheet restates it to --brass-300 only
 * for the dark mats. On paper and canvas it stayed --brass-600: the
 * training-hold stamp on /parent/safety measured 2.6:1 to 2.8:1 on a local
 * render (2026-11-21), under the 3:1 floor for large bold text, and the sign-in
 * refusal, the door register, the operations ledger and the medical-restriction
 * "Not saved" stamp were in the same place (AS9-5, Overwatch Q-D = A). The
 * light grounds take --brass-800, the brass the sheet already gives a voice on
 * paper (.mat-paper .working).
 *
 * ORDER IS HALF THE RULE. The light-ground rule and the dark-mat restatement
 * have the same specificity (one class, then the stamp), so where both match --
 * a leather card standing on the canvas -- the one stated LATER wins. The
 * light-ground rule must come first, or a stamp on leather on the family ground
 * would turn dark brass on dark leather.
 */

const SHEET = readDesignSystemCss(path.join(__dirname, '../../../../design-system/ppbf.css'))
  .replace(/\/\*[\s\S]*?\*\//g, '');

/** Every rule as [selectors, declarations, position in the resolved sheet]. */
function rules(): Array<{ selectors: string[]; body: string; at: number }> {
  const found: Array<{ selectors: string[]; body: string; at: number }> = [];
  for (const match of SHEET.matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
    found.push({
      selectors: match[1].split(',').map((s) => s.trim().replace(/\s+/g, ' ')),
      body: match[2],
      at: match.index ?? -1,
    });
  }
  return found;
}

/** Brace depth at a position: 0 is the top level, anything else is inside an
    at-rule such as @media, where a rule can be present and inert. */
function depthAt(at: number): number {
  let depth = 0;
  for (const ch of SHEET.slice(0, at)) {
    if (ch === '{') depth += 1;
    else if (ch === '}') depth -= 1;
  }
  return depth;
}

/* The colour a selector's last TOP-LEVEL rule declares. A rule inside an
   at-rule (@media, @layer) is skipped: one wrapped in an inert query does not
   paint the screen, and a later print-only restatement does not change it. */
function colourFor(selector: string): { value: string; at: number } | null {
  let last: { value: string; at: number } | null = null;
  for (const rule of rules()) {
    if (!rule.selectors.includes(selector) || depthAt(rule.at) !== 0) continue;
    const colour = rule.body.match(/(?:^|;)\s*color\s*:\s*([^;]+)/);
    if (colour) last = { value: colour[1].trim(), at: rule.at };
  }
  return last;
}

describe('.stamp--brass on the light grounds', () => {
  it.each(['.mat-paper .stamp--brass', '.on-canvas .stamp--brass'])('%s takes --brass-800', (selector) => {
    expect(colourFor(selector)?.value).toBe('var(--brass-800)');
  });

  it('leather keeps its own --brass-300', () => {
    expect(colourFor('.mat-leather .stamp--brass')?.value).toBe('var(--brass-300)');
  });

  it.each(['.mat-paper .stamp--brass', '.on-canvas .stamp--brass'])(
    '%s is stated before the dark-mat restatement, so a leather card on a light ground stays light brass',
    (selector) => {
      const light = colourFor(selector);
      const leather = colourFor('.mat-leather .stamp--brass');
      expect(light).not.toBeNull();
      expect(leather).not.toBeNull();
      expect((light as { at: number }).at).toBeLessThan((leather as { at: number }).at);
    },
  );

  it.each(['.mat-paper .stamp--brass', '.on-canvas .stamp--brass'])('%s is stated at the top level, not only inside an at-rule', (selector) => {
    expect(colourFor(selector)).not.toBeNull();
  });
});

/* THE INJURY LINE'S VOICE ON THE LIGHT GROUNDS (the same Q-D = A change).
   MyInjuries' "who reported / expected back" line is .t-muted. On the parent
   Safety page two restatements match it at the same specificity, and the later
   one, `.on-canvas .t-muted`, is the one that paints it; the paper one answers a
   paper panel off the canvas. Each must stay an ink, not a bone rung written
   for leather, or the line goes back to about 2:1 on paper. */
/** Relative luminance of a #rrggbb colour. */
function luminance(hex: string): number {
  const channel = (i: number) => {
    const v = parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

/* The bone rungs as the sheet declares them, so a bone ink written as a hex is
   caught as well as one written as a token. */
const BONE_HEXES = new Set(
  [...SHEET.matchAll(/--bone-\d+\s*:\s*(#[0-9a-fA-F]{6})/g)].map((m) => m[1].toLowerCase()),
);

describe('.t-muted on the light grounds', () => {
  it('reads the bone rungs from the sheet, or it is comparing nothing', () => {
    expect(BONE_HEXES.size).toBeGreaterThan(3);
  });

  it.each(['.mat-paper .t-muted', '.on-canvas .t-muted'])('%s is an ink at 4.5:1 or better on the darker paper, not a bone rung', (selector) => {
    const muted = colourFor(selector);
    expect(muted).not.toBeNull();
    const value = (muted as { value: string }).value.toLowerCase();
    expect(value).not.toMatch(/--bone-/);
    expect(BONE_HEXES.has(value)).toBe(false);
    // A literal ink, measured against the foot of the paper gradient (#E7DBBD),
    // the lighter-ink end of every paper and canvas panel.
    expect(value).toMatch(/^#[0-9a-f]{6}$/);
    const ink = luminance(value);
    const paper = luminance('#e7dbbd');
    expect((paper + 0.05) / (ink + 0.05)).toBeGreaterThanOrEqual(4.5);
  });
});
