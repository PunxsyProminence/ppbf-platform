import { readFileSync } from 'node:fs';
import path from 'node:path';
import { readDesignSystemCss } from '../../src/design/readDesignSystemCss';

/**
 * A DARK PANEL IS DARK EVERYWHERE, OR IT IS A BUG SOMEWHERE.
 *
 * Law 6 gives the app two grounds, so the sheet has to answer the same
 * question in several places: what ink does a voice take, what colour is a
 * link, what colour is a stamp -- each answered once for light ground and once
 * for dark material. Each of those answers carries its own hand-written list of
 * which materials count as dark.
 *
 * Those lists drifted, and the drift shipped. `.mat-wood` and `.mat-wood--dark`
 * were in NONE of them -- wood is a dark material the sheet never classified as
 * one -- and the `.on-canvas` voice block named three materials where the stamp
 * and link rules named five.
 *
 * The consequence was live: a sign-in board on .mat-wood--dark standing inside
 * an .on-canvas page took canvas's DARK ink on every voice, because the block
 * that exists to prevent exactly that did not name wood. Heading, body copy,
 * section labels and plaque all rendered dark-on-dark. 536 component suites
 * passed. A screenshot showed it in one look.
 *
 * This test does not pin a list -- a pinned list is a fourth place to forget.
 * It derives the set from each site and requires them to agree, so adding a
 * material to one place and not the others fails here instead of on a screen.
 */

const SHEET = readDesignSystemCss(path.join(__dirname, '../../../../design-system/ppbf.css'))
  .replace(/\/\*[\s\S]*?\*\//g, '');
const GLOBALS = readFileSync(path.join(__dirname, '../../app/globals.css'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '');

/** Materials named as `<material> <descendant>` across a rule's selector list. */
function materialsQualifying(css: string, descendant: string): Set<string> {
  const found = new Set<string>();
  const escaped = descendant.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const rule of css.matchAll(/([^{}]*)\{/g)) {
    for (const selector of rule[1].split(',')) {
      const match = selector.trim().match(new RegExp(`^(\\.mat-[a-z-]+)\\s+${escaped}$`));
      if (match) found.add(match[1]);
    }
  }
  return found;
}

/** Materials named inside the `.on-canvas :is(...)` dark-panel block. */
function materialsInOnCanvasIs(): Set<string> {
  const found = new Set<string>();
  for (const block of SHEET.matchAll(/\.on-canvas\s+:is\(([^)]*)\)/g)) {
    for (const material of block[1].split(',')) found.add(material.trim());
  }
  return found;
}

const sorted = (set: Set<string>) => [...set].sort();

describe('every site that classifies a dark material agrees which ones they are', () => {
  const byStamp = materialsQualifying(SHEET, '.stamp');
  const byLink = materialsQualifying(GLOBALS, 'a');
  const byOnCanvas = materialsInOnCanvasIs();

  it('finds a real set at each site, or it is comparing nothing', () => {
    expect(byStamp.size).toBeGreaterThan(4);
    expect(byLink.size).toBeGreaterThan(4);
    expect(byOnCanvas.size).toBeGreaterThan(4);
  });

  /* The .on-canvas block is the one that was short, and the one whose absence
     is invisible until somebody puts that material on a warm page. */
  it('the on-canvas dark-panel block names every material the stamp rules do', () => {
    expect(sorted(byOnCanvas)).toEqual(sorted(byStamp));
  });

  it('the link rules name every material the stamp rules do', () => {
    expect(sorted(byLink)).toEqual(sorted(byStamp));
  });

  /* Wood is called out by name because it is the one that was missing from all
     three, and because "we forgot a whole material" is a different mistake from
     "these lists drifted by one". */
  it.each(['.mat-wood', '.mat-wood--dark'])('treats %s as the dark material it is', (material) => {
    expect(byStamp.has(material)).toBe(true);
    expect(byLink.has(material)).toBe(true);
    expect(byOnCanvas.has(material)).toBe(true);
  });
});
