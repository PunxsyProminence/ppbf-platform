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

function colourFor(selector: string): { value: string; at: number } | null {
  let last: { value: string; at: number } | null = null;
  for (const rule of rules()) {
    if (!rule.selectors.includes(selector)) continue;
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

  it('the light-ground rule is stated before the dark-mat restatement, so leather on canvas stays light brass', () => {
    const light = colourFor('.on-canvas .stamp--brass');
    const leather = colourFor('.mat-leather .stamp--brass');
    expect(light).not.toBeNull();
    expect(leather).not.toBeNull();
    expect((light as { at: number }).at).toBeLessThan((leather as { at: number }).at);
  });
});
