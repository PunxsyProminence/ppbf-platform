import { readFileSync } from 'node:fs';
import path from 'node:path';

/* THE FONT ALIASES AND THE FONT VARIABLES HAVE TO LAND ON THE SAME ELEMENT.

   globals.css declares --font-stencil, --font-body, --font-mono, --font-ui and
   --font-data on `:root`, each one written in terms of a next/font variable
   (--font-tactical-display, --font-tactical-body, --font-geist-mono). `:root`
   IS <html>. While those three were set on <body> -- one element lower -- all
   five aliases resolved to the guaranteed-invalid value at the only place they
   were declared, and a custom property that is invalid at computed-value time
   takes down everything that reads it.

   That cost far more than a typeface. 37 rules in the design system are
   written as a `font:` SHORTHAND naming one of these aliases, and a shorthand
   whose value is invalid loses its size, weight and line-height along with the
   family. Measured in a browser before the repair: .t-eyebrow asked for 11px,
   .t-label 11px, .t-data 13px, .badge 11px and .stat-val 39.3px, and every one
   of them rendered at the body's 15px. 68 of 139 text elements sat at exactly
   15px, and a panel heading rendered ONE PIXEL larger than the paragraph
   beneath it.

   Nothing warns about this. The classes are present in the DOM, the fonts are
   downloaded, the page renders, and the type is silently flat.

   So the binding is pinned on both sides, BY NAME rather than by the shape of
   the code: every `variable:` next/font declares must be interpolated into the
   <html> tag, none may be left on <body>, and every :root alias must still
   reference the variables it is written in terms of. An earlier version of
   this file asserted JS identifiers instead, which meant renaming a variable
   in the next/font options -- the exact way this breaks -- kept it green. */

const REPO = path.resolve(__dirname, '../../../..');
const LAYOUT = path.join(REPO, 'apps/web/app/layout.tsx');
const GLOBALS = path.join(REPO, 'apps/web/app/globals.css');

const ALIASES = ['--font-stencil', '--font-body', '--font-mono', '--font-ui', '--font-data'] as const;

const layout = readFileSync(LAYOUT, 'utf8');
const globals = readFileSync(GLOBALS, 'utf8');

/** Comments stripped, so a tag named in prose is never mistaken for markup. */
function withoutComments(source: string): string {
  return source.replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
}

/** The opening tag of an element in the layout. */
function openingTag(tag: 'html' | 'body'): string {
  const match = withoutComments(layout).match(new RegExp(`<${tag}\\b[^>]*>`));
  if (!match) throw new Error(`no <${tag}> in apps/web/app/layout.tsx`);
  return match[0];
}

/**
 * What next/font is actually told to publish, read from the `variable:` options
 * rather than from the const names, together with the const that holds it.
 * `const tacticalBody = localFont({ ..., variable: "--font-tactical-body" })`
 * gives ['tacticalBody', '--font-tactical-body'].
 */
function declaredFontVariables(): Array<[holder: string, cssName: string]> {
  const source = withoutComments(layout);
  const found: Array<[string, string]> = [];
  const declaration = /const\s+([A-Za-z_$][\w$]*)\s*=\s*localFont\(\{([\s\S]*?)\}\);/g;

  for (const [, holder, options] of source.matchAll(declaration)) {
    const variable = options.match(/variable:\s*["'`](--[\w-]+)["'`]/);
    if (variable) found.push([holder, variable[1]]);
  }
  return found;
}

describe('the next/font variables are declared where the aliases can read them', () => {
  const declared = declaredFontVariables();

  it('finds the next/font declarations at all', () => {
    expect(
      declared.length >= 3
        ? true
        : `only ${declared.length} localFont({ ..., variable }) declaration(s) found in layout.tsx. `
          + 'If the font loading moved, this guard has to move with it.',
    ).toBe(true);
  });

  it('carries every declared font variable on <html>', () => {
    const html = openingTag('html');
    const missing = declared.filter(([holder]) => !html.includes(`${holder}.variable`));

    expect(
      missing.length === 0
        ? true
        : `<html> does not carry ${missing.map(([, name]) => name).join(', ')}. The :root aliases in `
          + 'globals.css read these, so anywhere below :root they resolve to nothing and every '
          + '`font:` shorthand naming an alias loses its size and weight too.',
    ).toBe(true);
  });

  it('leaves none of them stranded on <body>', () => {
    const body = openingTag('body');
    const stranded = declared.filter(([holder]) => body.includes(`${holder}.variable`));

    expect(
      stranded.length === 0
        ? true
        : `<body> still carries ${stranded.map(([, name]) => name).join(', ')}. :root cannot read a `
          + 'variable set below it.',
    ).toBe(true);
  });

  it('keeps every :root alias reading a variable that is actually declared', () => {
    const rootBlock = globals.slice(globals.indexOf(':root {'));
    const declaredNames = new Set(declared.map(([, name]) => name));
    const broken: string[] = [];

    for (const alias of ALIASES) {
      const line = rootBlock.match(new RegExp(`^\\s*${alias}:([^;]*);`, 'm'));
      if (!line) {
        broken.push(`${alias} is no longer declared on :root`);
        continue;
      }
      for (const [, referenced] of line[1].matchAll(/var\((--[\w-]+)/g)) {
        if (!declaredNames.has(referenced)) {
          broken.push(`${alias} reads ${referenced}, which no localFont() in layout.tsx publishes`);
        }
      }
    }

    expect(
      broken.length === 0 ? true : broken.join('\n  '),
    ).toBe(true);
  });
});
