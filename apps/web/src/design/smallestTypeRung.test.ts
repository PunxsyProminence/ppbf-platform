import { readFileSync } from 'node:fs';
import path from 'node:path';

import { readComponentSource, WEB_ROOT } from './readComponentSource';
import { readDesignSystemCss, DESIGN_SYSTEM_ENTRY } from './readDesignSystemCss';

/**
 * NOTHING SMALLER THAN THE SMALLEST RUNG.
 *
 * The type ladder's bottom rung is --t-xs, 11.8px ("captions, mono labels").
 * F-020 found text at 10px on every page the audit opened. What every
 * signed-in page shares is the session bar, and two controls on it pinned
 * literal sizes under the ladder in legacy/ppbf-leather-brass.css: the
 * Jump button (.catalog-hint, 10px, its ⌘K at 9.5px) and the rooms button
 * (.corridor-trigger, 11px, its current-surface label at 10.5px). Both now
 * resolve --t-xs.
 *
 * Two checks, because the failure has two shapes.
 *
 *   1. THE SESSION BAR. Every rule in the resolved design system that sets a
 *      size on the bar's two controls, or anything named after them, must
 *      resolve at or above --t-xs. The class match is open on the right on
 *      purpose (`.catalog-hint` reaches `.catalog-hint kbd` and
 *      `.corridor-trigger-here`), the same reasoning as kioskTypeFloor's
 *      `reaches`: a modifier or child is a takeback route.
 *
 *   2. EVERYWHERE ELSE, A RATCHET. Roughly forty other places still pin a
 *      size under the ladder (admin gear, the store, the open corridor and
 *      catalog panels, the training card, the commands sheet). They are not on
 *      every page and are left for a follow-up, so they are FROZEN here, file
 *      by file. A new one fails. Fixing one fails too, until the frozen count
 *      is lowered, so the list can only shrink and never quietly regrows into
 *      the room it left.
 *
 * WHAT THIS DOES NOT SEE: a size computed at runtime, a size inherited from an
 * `em` or `%`, or text a third-party component draws. It reads literals.
 */

const SHEET = readDesignSystemCss(DESIGN_SYSTEM_ENTRY).replace(/\/\*[\s\S]*?\*\//g, ' ');
const REPO = path.resolve(WEB_ROOT, '..', '..');

/** Every custom property in the resolved sheet, last definition winning. */
const TOKENS = new Map<string, string>();
for (const [, name, value] of SHEET.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;}]+)[;}]/gi)) {
  TOKENS.set(name, value.trim());
}

function tokenPx(name: string): number | null {
  const value = TOKENS.get(name);
  const px = value?.match(/^([\d.]+)px$/);
  return px ? Number(px[1]) : null;
}

const FLOOR = tokenPx('--t-xs') ?? Number.NaN;

/**
 * The size a `font-size` or `font` declaration sets, in px, or null when it
 * names no size this file can read (a `font: inherit`, an `em`).
 */
function declaredPx(declaration: string): number | null {
  const [property, ...rest] = declaration.split(':');
  const value = rest.join(':').trim();
  /* In the `font` shorthand the size sits before the optional /line-height;
     a px line-height after the slash is not a size. */
  const sized = /^\s*font\s*$/i.test(property) ? value.split('/')[0] : value;
  const variable = sized.match(/var\(\s*(--[\w-]+)\s*\)/);
  if (variable) return tokenPx(variable[1]);
  const literal = sized.match(/([\d.]+)px/);
  if (literal) return Number(literal[1]);
  const rem = sized.match(/([\d.]+)rem/);
  if (rem) return Number(rem[1]) * 16;
  return null;
}

function sizeDeclarations(body: string): string[] {
  return body.split(';').filter((declaration) => /^\s*(?:font-size|font)\s*:/i.test(declaration));
}

const RULES = [...SHEET.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => ({
  selectors: match[1].trim().split(',').map((part) => part.trim().replace(/\s+/g, ' ')),
  body: match[2],
}));

/** The two controls every signed-in page carries in its session bar. */
const SESSION_BAR = ['.catalog-hint', '.corridor-trigger'];

/* ------------------------------------------------------------- the ratchet */

/** Every size under the floor a file pins as a literal. */
function underFloorInSource(code: string): number[] {
  const sizes: number[] = [];
  for (const [, n] of code.matchAll(/\btext-\[([\d.]+)px\]/g)) sizes.push(Number(n));
  for (const [, n] of code.matchAll(/\btext-\[([\d.]+)rem\]/g)) sizes.push(Number(n) * 16);
  for (const [, n] of code.matchAll(/\bfontSize:\s*['"]?([\d.]+)(?:px)?['"]?\s*[,}]/g)) sizes.push(Number(n));
  for (const [, n] of code.matchAll(/font-size:\s*([\d.]+)px/g)) sizes.push(Number(n));
  return sizes.filter((size) => size < FLOOR);
}

function underFloorInCss(css: string): number[] {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, ' ');
  return [...stripped.matchAll(/\{([^{}]*)\}/g)]
    .flatMap((match) => sizeDeclarations(match[1]))
    .map((declaration) => declaredPx(declaration))
    .filter((size): size is number => size !== null && size < FLOOR);
}

const CSS_FILES = [
  'design-system/foundation/ppbf-foundation.css',
  'design-system/current/ppbf-theme.css',
  'design-system/current/ppbf-golden-era.css',
  'design-system/legacy/ppbf-leather-brass.css',
  'apps/web/app/globals.css',
];

/**
 * Where text is still pinned under --t-xs, and how many times. Lower a number
 * when you fix one; never raise one, and never add a file.
 */
const FROZEN: Readonly<Record<string, number>> = {
  'apps/web/app/admin/gear/page.tsx': 14,
  'apps/web/app/admin/gear/vendors/page.tsx': 5,
  'apps/web/app/admin/import/page.tsx': 4,
  'apps/web/app/retro-lab/page.tsx': 3,
  'apps/web/app/store/[organizationId]/page.tsx': 4,
  'apps/web/app/store/page.tsx': 2,
  'apps/web/components/AnnouncementBanner.tsx': 1,
  'apps/web/components/AthleteWorkspace.tsx': 1,
  'apps/web/components/CoachWorkspace.tsx': 1,
  'apps/web/components/FeedbackBox.tsx': 2,
  'apps/web/components/PaymentSetupBubble.tsx': 2,
  'apps/web/components/RabbitHole.tsx': 1,
  'design-system/legacy/ppbf-leather-brass.css': 32,
  'apps/web/app/globals.css': 1,
};

function census(): Map<string, number> {
  const found = new Map<string, number>();
  for (const { relativePath, code } of readComponentSource()) {
    const count = underFloorInSource(code).length;
    if (count > 0) found.set(`apps/web/${relativePath.replace(/\\/g, '/')}`, count);
  }
  for (const file of CSS_FILES) {
    const count = underFloorInCss(readFileSync(path.join(REPO, file), 'utf8')).length;
    if (count > 0) found.set(file, count);
  }
  return found;
}

describe('nothing is set smaller than the smallest rung', () => {
  it('reads a real ladder, so nothing passes against NaN', () => {
    expect(FLOOR).toBe(11.8);
    expect(RULES.length).toBeGreaterThan(500);
  });

  it('holds the session bar at --t-xs or above, on every signed-in page', () => {
    const reaching = RULES.filter((rule) => rule.selectors.some(
      (selector) => SESSION_BAR.some((token) => selector.includes(token)),
    ));
    /* If the bar's rules move or are renamed this must notice, not pass. */
    expect(reaching.length).toBeGreaterThanOrEqual(4);

    const offenders = reaching.flatMap((rule) => sizeDeclarations(rule.body)
      .filter((declaration) => {
        const px = declaredPx(declaration);
        return px === null || px < FLOOR;
      })
      .map((declaration) => `${rule.selectors.join(', ')} { ${declaration.trim()} }`));

    expect(
      offenders.length === 0
        ? true
        : `the session bar rides every signed-in page; these set its text under --t-xs (${FLOOR}px) `
          + `or in a unit this guard cannot read (F-020):\n  ${offenders.join('\n  ')}`,
    ).toBe(true);
  });

  it('adds no new size under --t-xs anywhere, and the frozen list only shrinks', () => {
    const found = census();
    const problems: string[] = [];

    for (const [file, count] of found) {
      const frozen = FROZEN[file] ?? 0;
      if (count > frozen) {
        problems.push(`${file}: ${count} sizes under ${FLOOR}px, ${frozen} allowed. Use var(--t-xs) or larger.`);
      } else if (count < frozen) {
        problems.push(`${file}: now ${count}, frozen at ${frozen}. Good; lower FROZEN to ${count}.`);
      }
    }
    for (const [file, frozen] of Object.entries(FROZEN)) {
      if (!found.has(file)) problems.push(`${file}: now 0, frozen at ${frozen}. Good; remove it from FROZEN.`);
    }

    expect(problems).toEqual([]);
  });
});
