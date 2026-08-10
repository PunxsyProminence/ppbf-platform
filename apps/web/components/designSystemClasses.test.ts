// A merge deleted 1,562 lines of ppbf.css and nothing noticed. Tests do not
// assert CSS, the build does not care, and a browser silently ignores a class
// with no rule behind it -- so the app went on rendering `room--office`,
// `.corridor-panel` and `.tcard-stamp` against an empty stylesheet, and every
// check stayed green.
//
// This closes that hole. It reads the classes the app actually references from
// the design system's own namespaces and asserts each one is defined in a real
// stylesheet -- ppbf.css or the app's globals.css. It is deliberately narrow:
// only prefixes the design system owns, so Tailwind utilities and one-off app
// classes cannot produce noise.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const REPO = join(__dirname, '..', '..', '..');
const CSS = join(REPO, 'design-system', 'ppbf.css');

/* The app's own sheet is a legitimate second home for design-system-namespaced
   classes: globals.css defines .btn--compact and the [data-surface="kiosk"]
   restatements next to it. Reading only ppbf.css reported those as orphans on
   the first run against main -- a false positive, and the kind that gets a
   guard switched off rather than fixed. Both sheets count as "defined"; the
   assertions further down still pin the specific things that must live in
   ppbf.css itself. */
const APP_CSS = join(REPO, 'apps', 'web', 'app', 'globals.css');

/* Namespaces owned by the design system. A class starting with one of these
   MUST be defined in one of the two sheets -- if it is not, either a stylesheet
   lost it or the markup has a typo, and both are bugs. Kept explicit rather
   than inferred so adding a namespace is a deliberate act. */
const OWNED_PREFIXES = [
  'room--',
  'corridor-',
  'catalog-',
  'commands-',
  'tcard-',
  'alert--',
  'btn--',
  'mat-',
  'pap--',
  'seal--',
  'stamp--',
  'badge--',
  'light--',
  'light-at--',
];

function definedClasses(css: string): Set<string> {
  const out = new Set<string>();
  // Strip comments first so a class name mentioned in prose is not counted as
  // defined -- that would let the guard pass on a stylesheet that only talks
  // about the rule it lost.
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const m of stripped.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) out.add(m[1]);
  return out;
}

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next' || entry === 'test-results') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, acc);
    else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) acc.push(full);
  }
  return acc;
}

/**
 * Every design-system class the app names, with the file that names it.
 *
 * Scanned out of className/class attributes only. Two things are deliberately
 * skipped, both of which the first run surfaced as false positives:
 *
 *  - ids. `id="catalog-results"` shares the namespace but is not a class, and
 *    demanding a rule for it would push people toward writing dead CSS.
 *  - template-literal fragments. `` `room--${room}` `` and
 *    `` `tcard-seal-${count}` `` tokenise to `room--` and `tcard-seal-`, which
 *    are prefixes rather than classes. The composed values they produce are
 *    covered by the explicit room and component assertions below, which is the
 *    honest way to check a name that only exists at runtime.
 */
function referencedClasses(): Map<string, string[]> {
  const refs = new Map<string, string[]>();
  const CLASS_ATTR = /class(?:Name)?\s*=\s*(?:"([^"]*)"|'([^']*)'|\{([^}]*)\})/g;

  for (const file of sourceFiles(join(REPO, 'apps', 'web'))) {
    const src = readFileSync(file, 'utf8');
    for (const attr of src.matchAll(CLASS_ATTR)) {
      const body = attr[1] ?? attr[2] ?? attr[3] ?? '';
      for (const m of body.matchAll(/[\w-]+/g)) {
        const token = m[0];
        if (token.endsWith('-')) continue;                       // template fragment
        if (!OWNED_PREFIXES.some((p) => token.startsWith(p))) continue;
        if (token === 'room--') continue;
        const at = refs.get(token) ?? [];
        if (!at.includes(file)) at.push(file);
        refs.set(token, at);
      }
    }
  }
  return refs;
}

describe('the app only names design-system classes that exist', () => {
  const css = readFileSync(CSS, 'utf8');
  const appCss = readFileSync(APP_CSS, 'utf8');
  // Defined in either sheet. The room/component assertions below still require
  // ppbf.css specifically, so this cannot hide a loss from the design system.
  const defined = new Set([...definedClasses(css), ...definedClasses(appCss)]);
  const referenced = referencedClasses();

  it('finds the stylesheet and parses classes out of it', () => {
    expect(css.length).toBeGreaterThan(10_000);
    expect(defined.size).toBeGreaterThan(200);
  });

  it('actually finds references to check, so a silent no-op cannot pass', () => {
    // If this drops to zero the guard has stopped guarding -- a refactor moved
    // the classes, or the scanner broke.
    expect(referenced.size).toBeGreaterThan(10);
  });

  it('defines every design-system class the app references', () => {
    const missing: string[] = [];
    for (const [cls, files] of referenced) {
      if (!defined.has(cls)) {
        missing.push(`${cls}  <- ${files.map((f) => f.replace(REPO + '/', '')).join(', ')}`);
      }
    }
    expect(missing).toEqual([]);
  });

  /* The six rooms are load-bearing enough to name individually: Law 6 is the
     architecture, and losing one is not a styling nit.

     This asserts the DEFINING rule, not merely that the token appears. Checking
     the token was the first version and it was useless: deleting `.room--office
     {` still left `room--office` present in `.corridor-room.room--office` and
     in the print block's ::before list, so the guard passed on a stylesheet
     that had lost the room. Verified by deleting the rule and watching this
     fail. */
  it('keeps the defining rule for all six rooms', () => {
    const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
    for (const room of ['office', 'floor', 'board', 'file', 'clinic', 'night']) {
      // A rule whose selector is exactly .room--X (optionally with siblings in
      // a selector list), not .something.room--X or .room--X::before.
      const defining = new RegExp(`(^|,|\\}|\\s)\\.room--${room}\\s*(,[^{]*)?\\{`, 'm');
      expect(defining.test(stripped)).toBe(true);
    }
  });

  it('keeps the motion scale and its easings defined', () => {
    for (const t of ['--m-instant', '--m-quick', '--m-base', '--m-settle', '--m-travel', '--m-swing',
                     '--e-stamp', '--e-settle', '--e-drawer', '--e-lever', '--e-swing']) {
      expect(css).toContain(`${t}:`);
    }
  });

  it('keeps the navigation and card components defined', () => {
    for (const c of ['corridor-panel', 'corridor-door', 'catalog-field', 'catalog-row',
                     'commands-sheet', 'tcard-stamp', 'tcard-seals']) {
      expect(defined.has(c)).toBe(true);
    }
  });

  /* A brace swallowed at a merge boundary produced a stylesheet browsers
     accepted and Turbopack rejected. Cheap to assert here so it fails in the
     suite rather than at build time. */
  it('is brace-balanced', () => {
    const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const open = (stripped.match(/\{/g) ?? []).length;
    const close = (stripped.match(/\}/g) ?? []).length;
    expect(open - close).toBe(0);
  });
});
