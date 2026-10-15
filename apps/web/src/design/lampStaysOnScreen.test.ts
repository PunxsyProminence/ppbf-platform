import { readComponentSource } from './readComponentSource';
import { readDesignSystemCss, DESIGN_SYSTEM_ENTRY } from './readDesignSystemCss';

/**
 * A HUNG LAMP MUST NOT WIDEN THE PAGE.
 *
 * `.lamp` is an 89px fixture whose `::after` throws a 233px pool of light,
 * centred under it, so the light hangs 72px past each side of the lamp's own
 * box. A lamp hung at `right-[8%]` therefore puts its light past the screen on
 * anything narrower than about 900px, and the page scrolls sideways. That was
 * the whole of F-023: eight admin pages were 417 / 495 / 779px wide at
 * 375 / 460 / 768 (#1503, measured in Chromium), fixed by hanging each lamp at
 * `right-[max(8%,73px)]`.
 *
 * #1503's browser check covers those nine admin pages and nothing else, so the
 * same lamp hung anywhere else brings the defect straight back --
 * /coach/sports-medicine still carried `right-[8%]` when this file was written.
 * This reads every lamp the app hangs, on every page, and asks one question of
 * each: can its light reach past the edge it hangs from?
 *
 * The overhang is READ FROM THE SHEET, not written here. If the pool or the
 * shade changes size, the margin every lamp needs changes with it.
 */

const SHEET = readDesignSystemCss(DESIGN_SYSTEM_ENTRY).replace(/\/\*[\s\S]*?\*\//g, ' ');

/**
 * The px widths every rule ending in `selector` declares. A room may restate
 * the pool for its own lamp (`.ge-frontoffice .lamp::after` is 208px), so the
 * guard takes the WIDEST pool and the NARROWEST shade rather than the first
 * rule it meets: a room that widened its light would otherwise go unseen.
 */
function widthsOf(selector: string): number[] {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\:]/g, '\\$&');
  const widths: number[] = [];
  for (const [, body] of SHEET.matchAll(new RegExp(`${escaped}\\s*(?:,[^{]*)?\\{([^}]*)\\}`, 'g'))) {
    const width = body.match(/(?:^|;|\s)width:\s*([\d.]+)px/);
    if (width) widths.push(Number(width[1]));
  }
  if (widths.length === 0) throw new Error(`no px width for ${selector} in the resolved design system`);
  return widths;
}

/** How far the pool of light reaches past each side of the lamp's own box. */
const OVERHANG = (Math.max(...widthsOf('.lamp::after')) - Math.min(...widthsOf('.lamp'))) / 2;

type Lamp = { readonly where: string; readonly tag: string };

/** Every element whose className carries the `lamp` class itself. */
function lamps(): Lamp[] {
  const found: Lamp[] = [];
  for (const { relativePath, code } of readComponentSource()) {
    /* A lamp whose class list is computed cannot be read here. Say so rather
       than skip it: a skipped lamp is a lamp nobody checked. */
    for (const match of code.matchAll(/className=\{[^}]*(?:^|[\s'"`])lamp(?=[\s'"`])[^}]*\}/g)) {
      const line = code.slice(0, match.index).split('\n').length;
      found.push({ where: `${relativePath.replace(/\\/g, '/')}:${line}`, tag: `computed ${match[0]}` });
    }
    for (const match of code.matchAll(/<[a-z]+\b[^>]*?className="([^"]*)"[^>]*?>/g)) {
      if (!/(?:^|\s)lamp(?:\s|$)/.test(match[1])) continue;
      const line = code.slice(0, match.index).split('\n').length;
      found.push({ where: `${relativePath.replace(/\\/g, '/')}:${line}`, tag: match[0] });
    }
  }
  return found;
}

/** Why this lamp's light can leave the screen, or null when it cannot. */
function escapes({ tag }: Lamp): string | null {
  if (tag.startsWith('computed ')) return 'its className is computed, so its placement cannot be read; use a string literal';
  /* Hung from the middle: the light is centred on the page and is narrower
     than any screen the app supports. */
  if (/left:\s*'50%'/.test(tag) && /translate:\s*'-50%/.test(tag)) return null;

  const edge = tag.match(/\b(left|right)-\[([^\]]+)\]/);
  if (!edge) return 'hung with no left- or right- offset this guard can read';

  const floor = edge[2].match(/^max\([^,]+,\s*([\d.]+)px\)$/);
  if (!floor) return `hung at ${edge[1]}-[${edge[2]}], which has no px floor, so on a narrow screen the light leaves it`;
  if (Number(floor[1]) < OVERHANG) {
    return `hung at ${edge[1]}-[${edge[2]}], but the light reaches ${OVERHANG}px past the lamp`;
  }
  return null;
}

describe('a hung lamp keeps its light on the screen', () => {
  const found = lamps();

  it('reads the real sheet and the real pages, so nothing passes on an empty list', () => {
    expect(OVERHANG).toBe(72);
    expect(found.length).toBeGreaterThanOrEqual(15);
  });

  it('every lamp is hung centred, or at least the overhang from its edge', () => {
    const offenders = found
      .map((lamp) => ({ lamp, why: escapes(lamp) }))
      .filter(({ why }) => why !== null)
      .map(({ lamp, why }) => `${lamp.where}  ${why}`);

    expect(
      offenders.length === 0
        ? true
        : `these lamps can push the page wider than a phone or tablet (F-023, #1503). Hang them at `
          + `right-[max(8%,${OVERHANG + 1}px)] or centred:\n  ${offenders.join('\n  ')}`,
    ).toBe(true);
  });
});
