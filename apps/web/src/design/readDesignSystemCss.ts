import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * READ THE DESIGN SYSTEM AS THE BROWSER SEES IT.
 *
 * Until 2026-08-23, `design-system/ppbf.css` was the whole design system --
 * one 3,575-line sheet -- so a test could `readFileSync` it and be reading
 * every rule that existed. Thirteen test files did exactly that.
 *
 * The visual reset split that sheet into a neutral foundation, a swappable
 * theme, and the retired aesthetic archived under `legacy/`. `ppbf.css` kept
 * its path but is now two `@import` lines. A plain `readFileSync` of it
 * therefore returns almost nothing, and every one of those thirteen guards
 * would quietly stop guarding: they look for rules, the rules would not be in
 * the text, and a test that finds no rule to check is a test that passes.
 *
 * That is precisely the failure `designSystemClasses.test.ts` was written
 * about -- "a merge deleted 1,562 lines of ppbf.css and nothing noticed". So
 * the guards are not pointed somewhere else and they are not relaxed. They are
 * taught to resolve the imports, which is what a browser does with the same
 * file. `readDesignSystemCssResolvesImports.test.ts` proves the resolution
 * still goes red when a rule is genuinely deleted.
 *
 * SOURCE ORDER IS PRESERVED. Each import is inlined AT THE POSITION it was
 * written, not appended, because several of these guards assert cascade
 * behaviour that is decided by source order rather than specificity
 * (`plateVariant.test.ts` is entirely about that). Concatenating in any other
 * order would make those assertions read a sheet the browser never sees.
 *
 * Bare specifiers such as `@import "tailwindcss"` are left as written: they
 * resolve from node_modules through the bundler, not from disk relative to the
 * sheet, and pulling Tailwind's full output into a string a test greps would
 * make every "is this class defined" question meaningless.
 */

/** `@import "…";` or `@import '…';`, with optional whitespace. Layer/media
 *  qualified imports are matched too, so one is never silently skipped. */
const IMPORT_RULE = /@import\s+(?:url\()?["']([^"']+)["']\)?[^;]*;/g;

function isRelative(specifier: string): boolean {
  return specifier.startsWith('./') || specifier.startsWith('../');
}

/**
 * Returns the CSS at `entry` with every relative `@import` inlined in place,
 * recursively.
 *
 * `seen` breaks import cycles. A cycle is not an error here -- the second
 * visit simply contributes nothing, which matches what a browser does -- but
 * without it a cycle would recurse until the stack gave out.
 */
export function readDesignSystemCss(entry: string, seen: Set<string> = new Set()): string {
  const resolved = path.resolve(entry);
  if (seen.has(resolved)) {
    return '';
  }
  seen.add(resolved);

  const source = readFileSync(resolved, 'utf8');
  const directory = path.dirname(resolved);

  return source.replace(IMPORT_RULE, (whole, specifier: string) => {
    if (!isRelative(specifier)) {
      return whole;
    }
    return readDesignSystemCss(path.join(directory, specifier), seen);
  });
}

/**
 * The entry point every guard should read. Resolves to
 * `design-system/ppbf.css` from anywhere under `apps/web`, so a test does not
 * have to count `..` segments and get them wrong.
 */
export const DESIGN_SYSTEM_ENTRY = path.resolve(__dirname, '../../../../design-system/ppbf.css');
