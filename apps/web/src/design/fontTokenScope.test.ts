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

   That cost far more than a typeface. Roughly three dozen rules in the design
   system are written as a `font:` SHORTHAND naming one of these aliases, and a
   shorthand whose value is invalid loses its size, weight and line-height
   along with the family. Measured in a browser on the coach workspace before
   the repair: .t-eyebrow asked for 11px, .t-label 11px, .t-data 13px, .badge
   11px and .stat-val 39.3px, and every one of them rendered at the body's
   15px. 68 of 139 text elements sat at exactly 15px, and a panel heading
   rendered ONE PIXEL larger than the paragraph beneath it. With no size
   difference left, the only things separating one block from the next were a
   box outline and uppercase letters.

   Nothing warns about this. The classes are present in the DOM, the fonts are
   downloaded, the page renders, and the type is silently flat. So the scope is
   pinned here on both sides: the variables go on <html>, and the aliases stay
   on :root. Move either one and this fails. */

const REPO = path.resolve(__dirname, '../../../..');
const LAYOUT = path.join(REPO, 'apps/web/app/layout.tsx');
const GLOBALS = path.join(REPO, 'apps/web/app/globals.css');

const FONT_VARIABLES = ['--font-tactical-display', '--font-tactical-body', '--font-geist-mono'] as const;
const ALIASES = ['--font-stencil', '--font-body', '--font-mono', '--font-ui', '--font-data'] as const;

/** The opening tag of an element in the layout, comments stripped. */
function openingTag(source: string, tag: 'html' | 'body'): string {
  const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '');
  const match = withoutComments.match(new RegExp(`<${tag}\\b[^>]*>`));
  if (!match) throw new Error(`no <${tag}> in apps/web/app/layout.tsx`);
  return match[0];
}

describe('the next/font variables are declared where the aliases can read them', () => {
  const layout = readFileSync(LAYOUT, 'utf8');

  it('puts every next/font variable on <html>', () => {
    const html = openingTag(layout, 'html');
    const missing = FONT_VARIABLES.filter((name) => {
      const holder = name.replace('--font-', '').replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase());
      return !html.includes(`${holder}.variable`);
    });

    expect(
      missing.length === 0
        ? true
        : `<html> is missing ${missing.join(', ')}. The :root aliases in globals.css `
          + 'read these, so on <body> they resolve to nothing and every `font:` '
          + 'shorthand that names an alias loses its size and weight too.',
    ).toBe(true);
  });

  it('does not leave the font variables on <body>', () => {
    const body = openingTag(layout, 'body');
    const stranded = FONT_VARIABLES.filter((name) => {
      const holder = name.replace('--font-', '').replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase());
      return body.includes(`${holder}.variable`);
    });

    expect(
      stranded.length === 0
        ? true
        : `<body> still carries ${stranded.join(', ')}. :root cannot read a variable set below it.`,
    ).toBe(true);
  });

  it('keeps the aliases on :root, where the variables now are', () => {
    const globals = readFileSync(GLOBALS, 'utf8');
    const rootBlock = globals.slice(globals.indexOf(':root {'));

    const missing = ALIASES.filter((alias) => !rootBlock.includes(`${alias}:`));

    expect(
      missing.length === 0
        ? true
        : `${missing.join(', ')} left the :root block. If an alias moves, the variables `
          + 'it reads have to move with it.',
    ).toBe(true);
  });
});
