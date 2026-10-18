import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * THE WALL-BOARD KIT (design-system/current/ppbf-golden-era.css section 011, lane L39).
 *
 * Two things here are function rather than look, and both fail silently:
 *
 *   1. Burn-in. A TV holds one layout for twelve hours. The boards' bodies stay dark and cream
 *      enamel fills only the signs and plates that carry .ge-enamel (about a tenth of the screen,
 *      measured; which elements carry it is held by wallHeaderPlate.test.tsx). The one place that
 *      could quietly undo that is a later rule painting `var(--enamel)` on something else, so the
 *      fill is held to .ge-enamel, in the kit and in the wall's own block.
 *   2. The bronze ramp leak. Brass at partial alpha reads `--brass-N-rgb`; a scope that moves a rung
 *      without its triple paints bronze solids beside legacy-gold hairlines. Each rung moves with
 *      its triple.
 */

const SHEET = readFileSync(path.resolve(__dirname, '../../../../design-system/current/ppbf-golden-era.css'), 'utf8');
const GLOBALS = readFileSync(path.resolve(__dirname, '../../app/globals.css'), 'utf8');

const KIT_MARKER = 'GOLDEN ERA 011 — THE WALL BOARD';
/** From the opening of the comment that names the section, so the comment strips cleanly. */
function section(css: string, marker: string): string {
  const at = css.indexOf(marker);
  return at < 0 ? '' : css.slice(css.lastIndexOf('/*', at));
}
const kit = section(SHEET, KIT_MARKER);
const wallBlock = section(GLOBALS, 'THE WALL ===');

/** Every rule in a sheet as selector text and body, comments stripped. */
function rules(css: string): { selector: string; body: string }[] {
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, '');
  return [...bare.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ selector: m[1].trim(), body: m[2] }));
}

describe('the wall-board kit', () => {
  it('found the section it is about to make claims about', () => {
    expect(SHEET.indexOf(KIT_MARKER)).toBeGreaterThan(-1);
    expect(kit.length).toBeGreaterThan(2_000);
    expect(wallBlock.length).toBeGreaterThan(2_000);
  });

  it('moves every brass rung on the scope together with its channel triple', () => {
    const scope = rules(kit).find((rule) => rule.selector === '.ge-wallboard');
    expect(scope).toBeDefined();
    for (const rung of [200, 300, 400, 500, 600, 700, 800, 900]) {
      expect(scope?.body).toMatch(new RegExp(`--brass-${rung}:\\s*#[0-9A-Fa-f]{6};`));
      expect(scope?.body).toMatch(new RegExp(`--brass-${rung}-rgb:\\s*\\d+\\s+\\d+\\s+\\d+;`));
    }
  });

  it('paints cream enamel only through .ge-enamel', () => {
    // By token (with or without a fallback) and by its literal value, outside the scope that defines it.
    const painting = [...rules(kit), ...rules(wallBlock)]
      .filter((rule) => rule.selector !== '.ge-wallboard')
      .filter((rule) => /var\(--enamel\s*[,)]|#E2D5B5/i.test(rule.body));
    // The cap itself must be found, or this passes against nothing.
    expect(painting.map((rule) => rule.selector)).toContain('.ge-wallboard .ge-enamel');
    for (const rule of painting) {
      expect({ selector: rule.selector, enamelOnly: /\.ge-enamel\b/.test(rule.selector) })
        .toEqual({ selector: rule.selector, enamelOnly: true });
    }
  });
});
