/**
 * @jest-environment jsdom
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import type { ReactElement, ReactNode } from 'react';

import { render } from '@testing-library/react';

import AthleteLayout from '../../app/athlete/layout';
import { readDesignSystemCss } from '../../src/design/readDesignSystemCss';
import { stripSourceComments } from './readComponentSource';

/**
 * The gym-floor tap floor has two halves, and each is useless without the
 * other: a CSS rule scoped to [data-surface="kiosk"], and a marker that
 * actually puts that attribute on the athlete subtree.
 *
 * Written because the first attempt at this shipped only half. I wrote a rule
 * for `.mat-kiosk`, a class that exists nowhere in the codebase -- so it
 * compiled, reviewed cleanly, and protected nothing. A stylesheet cannot tell
 * you its selector matches no element, and neither can a typechecker.
 *
 * So this asserts BOTH ends and that they agree on the same string.
 */

const GLOBALS = path.resolve(__dirname, '../../app/globals.css');
const PPBF = path.resolve(__dirname, '../../../../design-system/ppbf.css');
const SURFACE_ATTRIBUTE = 'data-surface';
const SURFACE_VALUE = 'kiosk';

describe('kiosk tap floor', () => {
  const css = readFileSync(GLOBALS, 'utf8');

  it('marks the athlete subtree with the attribute the stylesheet targets', () => {
    const { container } = render(<AthleteLayout><button type="button">Check In</button></AthleteLayout>);

    const marker = container.querySelector(`[${SURFACE_ATTRIBUTE}="${SURFACE_VALUE}"]`);
    expect(marker).not.toBeNull();
    // The control the rule is for is inside it, not a sibling.
    expect(marker?.querySelector('button')).not.toBeNull();
  });

  it('does not add a layout box around athlete pages', () => {
    const { container } = render(<AthleteLayout><button type="button">Check In</button></AthleteLayout>);
    const marker = container.querySelector(`[${SURFACE_ATTRIBUTE}="${SURFACE_VALUE}"]`);

    // display:contents, via Tailwind's `contents` utility. Without it every
    // athlete page gains a box it was not designed inside.
    expect(marker?.className).toContain('contents');
  });

  it('raises controls to --tap rather than the 44px desk floor', () => {
    const rule = css.match(/\[data-surface="kiosk"\][\s\S]*?\{([^}]*)\}/);
    expect(rule).not.toBeNull();
    expect(rule?.[1]).toContain('var(--tap)');
    // 55px, not 44: a child in gloves is not a person at a desk.
    expect(rule?.[1]).not.toContain('44px');
  });

  it('states the floor for .btn in the unlayered sheet, where it can win', () => {
    // The globals.css rule above is inside `@layer base`, so `.btn` in the
    // unlayered ppbf.css beat it and every athlete button rendered 44px while
    // its class string asked for var(--tap). The other half of the floor has to
    // live in ppbf.css or it does not apply at all.
    const ppbf = readDesignSystemCss(PPBF);
    const rule = ppbf.match(/\[data-surface="kiosk"\]\s+\.btn\s*\{([^}]*)\}/);

    expect(rule).not.toBeNull();
    expect(rule?.[1]).toContain('min-height: var(--tap)');
    // Not layered: the rule is worthless the moment it is wrapped in a layer.
    expect(ppbf).not.toMatch(/@layer[^{]*\{[^}]*\[data-surface="kiosk"\]\s+\.btn/);
  });

  it('floors .btn anchors, which the element-list rule cannot reach', () => {
    // globals.css lists `button`, `select`, `input[...]` -- never `a`. Half the
    // athlete floor's tap targets are router Links carrying `.btn`, so a rule
    // written per element type left them at 44px however it was layered.
    // Asserted against a rendered anchor rather than by reading the selector,
    // because a selector matching nothing is the exact bug this file exists for.
    const { container } = render(
      <AthleteLayout>
        <a href="/schedule" className="btn btn--ghost">Schedule</a>
      </AthleteLayout>,
    );

    expect(container.querySelector(`[${SURFACE_ATTRIBUTE}="${SURFACE_VALUE}"] .btn`)).not.toBeNull();
    expect(container.querySelector<HTMLAnchorElement>('a.btn')?.tagName).toBe('A');
  });

  it('covers the control types an athlete actually touches', () => {
    // The session-duration field is an input[type=number] and sat at 36px
    // through three sweeps, so a button-only rule would miss the exact control
    // that prompted this.
    const selector = css.slice(css.indexOf('[data-surface="kiosk"]'), css.indexOf('min-height: var(--tap)'));

    for (const control of ['button', 'select', 'input[type="number"]', 'input[type="text"]']) {
      expect(selector).toContain(control);
    }
  });

  it('covers inputs with no type, and email fields (UXB-08)', () => {
    // <input> with no type attribute is a text box but matches no
    // input[type=...] selector, so live-session fields sat at the browser's
    // default height. Email is on the 44px list and was missing from this one.
    const selector = css.slice(css.indexOf('[data-surface="kiosk"]'), css.indexOf('min-height: var(--tap)'));

    expect(selector).toContain('[data-surface="kiosk"] input:not([type])');
    expect(selector).toContain('[data-surface="kiosk"] input[type="email"]');
  });
});

/**
 * The gym-floor pages a coach or athlete uses standing up, mid-session (UXB-08).
 * Each must mark its subtree through a route layout, or it keeps the 44px desk
 * floor. Dropping a layout, or swapping its body for one without the marker,
 * fails here by name.
 */
const FLOOR_ROUTES = [
  'activate', // ATH-14: a PIN athlete's first screen on the tablet (lane U1, SC2-4)
  'change-pin', // ATH-14: the PIN change that follows it
  'coach/environment/intake-router', // coach home: CoachWorkspace and Needs You
  'coach/sports-medicine',
  'coach/sparring-exposure',
  'coach/attempt-log',
  'coach/assessments',
  'coach/test-day',
  // Injury Record and Medical Restrictions (OD-2026-11-17-009 ruling 4, OW25-37 A)
  // are sections of Athlete Safety now (lane AS-5); their old addresses redirect.
  'coach/athlete-safety',
  'coach/sparring-caps', // app scrub CS-11 (lane AS-5)
  'coach/drills', // OD-2026-11-17-009 ruling 4 (OW25-37 A)
  'coach/behavior-standards', // app scrub CF-24 (lane U1, SC2-2)
  'coach/cue-library', // app scrub CF-24 (lane U1, SC2-2)
  'coach/transfer-check', // app scrub CF-24 (lane U1, SC2-2)
  'coach/passbook', // app scrub CF-24 (lane U1, SC2-2)
  'coach/passbook-gaps', // app scrub CF-24 (lane U1, SC2-2)
  'coach/one-percent-club', // app scrub CF-24 (lane U1, SC2-2)
  'coach/mental-skills', // app scrub CF-24 (lane U1, SC2-2)
  'coach/development-blocks', // app scrub CF-24 (lane U1, SC2-2)
  'coach/class', // the class screen (lane U2-6a)
  'coach/workout-templates', // app scrub CF-24 remainder: the whole page, not only Issue and Make a plan (lane SWP, SWP-2; Q3 = A on #2046)
  'shadow',
  'parent/safety',
] as const;

describe('gym-floor pages carry the kiosk surface', () => {
  it.each(FLOOR_ROUTES)('/%s has a layout that marks its page as kiosk', (route) => {
    const layoutPath = path.resolve(__dirname, '../../app', route, 'layout.tsx');
    // The page must still live here, or the layout guards an empty folder.
    expect(existsSync(path.resolve(__dirname, '../../app', route, 'page.tsx')) ? route : `${route}: no page.tsx`).toBe(route);
    expect(existsSync(layoutPath) ? route : `${route}: no layout.tsx`).toBe(route);

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Layout = (require(layoutPath) as { default: (props: { children: ReactNode }) => ReactElement }).default;
    const { container } = render(<Layout><button type="button">Open</button></Layout>);
    const marker = container.querySelector(`[${SURFACE_ATTRIBUTE}="${SURFACE_VALUE}"]`);

    expect(marker).not.toBeNull();
    expect(marker?.querySelector('button')).not.toBeNull();
    expect(marker?.className).toContain('contents');
  });
});

/**
 * Workout Templates went onto the kiosk surface whole (app scrub CF-24
 * remainder; lane SWP, SWP-2). The surface lifts the six voice classes and the
 * controls the stylesheet names, but two things on this page it cannot reach:
 *
 *  - a size written as a utility on an element that wears no voice class
 *    (`<p className="text-[length:var(--t-sm)]">`, an `<h4 className="t-command
 *    text-[length:var(--t-sm)]">`): `.t-command` sets no size, so the utility
 *    is the size, and it is 15px;
 *  - a `<summary>`, which is a control but is not in the kiosk tap selector
 *    list (app/globals.css, design-system/foundation/ppbf-foundation.css), so it
 *    is as tall as its text.
 *
 * Found in review (#2067), and each measured in Chromium by the reviewer:
 *
 *  - `.input` / `.select` / `.textarea` declare `min-height: 46px` UNLAYERED
 *    (design-system/legacy/ppbf-leather-brass.css:901), which beats both kiosk
 *    tap rules (one in `@layer base`, one at `:where()` zero weight). Only the
 *    `input--kiosk` modifier (:911) lifts them, so every one must wear it.
 *  - `.plaque` sets `font: 650 13px` unlayered (:1260) and no kiosk rule lifts
 *    it; a utility cannot beat it, so it takes an inline size.
 *  - a bare `<span>` with no size and no voice class falls through to the
 *    body's 15px: the "(not checked)" draft words beside a heading.
 *
 * Scoped to this folder on purpose: other floor pages still carry sub-floor
 * sizes (activate, sports-medicine, attempt-log, assessments, shadow,
 * parent/safety, counted 2026-11-21), and those files are other lanes'.
 */
describe('Workout Templates on the gym floor', () => {
  const FOLDER = path.resolve(__dirname, '../../app/coach/workout-templates');
  const SOURCES = readdirSync(FOLDER)
    .filter((name) => name.endsWith('.tsx') && !name.endsWith('.test.tsx'))
    .map((name) => ({ name, code: stripSourceComments(readFileSync(path.join(FOLDER, name), 'utf8')) }));
  const SUB_FLOOR = /var\(\s*--t-(?:sm|xs)\s*\)|\btext-(?:xs|sm|base)\b/;
  /** A literal size, in a utility or an inline style, read as px (a rem or em at 16px). */
  const LITERAL_SIZE = /text-\[(?:length:)?\s*([\d.]+)(px|rem|em)\s*\]|fontSize\s*:\s*['"`]?([\d.]+)(px|rem|em)?/g;
  const KIOSK_TYPE_FLOOR_PX = 19.1;
  const subFloorLiterals = (line: string): string[] =>
    [...line.matchAll(LITERAL_SIZE)]
      .filter((match) => {
        const value = Number(match[1] ?? match[3]);
        const unit = match[2] ?? match[4] ?? 'px';
        return (unit === 'px' ? value : value * 16) < KIOSK_TYPE_FLOOR_PX;
      })
      .map((match) => match[0]);

  it('reads the page, its two parts and its layout, so nothing below passes on no files', () => {
    expect(SOURCES.map((source) => source.name).sort()).toEqual(
      ['MakeSessionScript.tsx', 'TemplateEditForm.tsx', 'layout.tsx', 'page.tsx'],
    );
  });

  it.each(['page.tsx', 'MakeSessionScript.tsx', 'TemplateEditForm.tsx'])(
    '%s sets no type below --t-md (19.1px)',
    (name) => {
      const code = SOURCES.find((source) => source.name === name)?.code ?? '';
      const lines = code.split('\n').filter((line) => SUB_FLOOR.test(line) || subFloorLiterals(line).length > 0);
      expect(lines.map((line) => line.trim())).toEqual([]);
    },
  );

  it('gives every <summary> the 55px tap floor, which the kiosk stylesheet does not', () => {
    const summaries = SOURCES.flatMap((source) =>
      [...source.code.matchAll(/<summary\b[^>]*>/g)].map((match) => `${source.name}: ${match[0]}`));
    expect(summaries.length).toBeGreaterThan(0);
    expect(summaries.filter((tag) => !tag.includes('min-h-[var(--tap)]'))).toEqual([]);
  });

  it('reads a literal size below the floor, in a utility or inline, and passes one at or above it', () => {
    expect(subFloorLiterals('className="text-[length:13px]"')).toEqual(['text-[length:13px]']);
    expect(subFloorLiterals('className="text-[0.9rem]"')).toEqual(['text-[0.9rem]']);
    expect(subFloorLiterals('style={{ fontSize: 13 }}')).toEqual(['fontSize: 13']);
    expect(subFloorLiterals("style={{ fontSize: '12px' }}")).toEqual(["fontSize: '12px"]);
    expect(subFloorLiterals('className="text-[length:24px]" style={{ fontSize: 20 }}')).toEqual([]);
  });

  it('puts every .input, .select and .textarea on input--kiosk: their unlayered 46px beats both kiosk tap rules', () => {
    const fields = SOURCES.flatMap((source) =>
      [...source.code.matchAll(/className=(?:"([^"]*)"|'([^']*)'|\{`([^`]*)`\})/g)]
        .map((match) => match[1] ?? match[2] ?? match[3] ?? '')
        .filter((classes) => /(?:^|\s)(?:input|select|textarea)(?:\s|$)/.test(classes))
        .map((classes) => `${source.name}: ${classes}`));
    expect(fields.length).toBeGreaterThan(0);
    expect(fields.filter((field) => !/(?:^|\s)input--kiosk(?:\s|$)/.test(field))).toEqual([]);
  });

  it('sizes every .plaque inline at --t-md: its unlayered 13px shorthand beats any utility', () => {
    const plaques = SOURCES.flatMap((source) =>
      [...source.code.matchAll(/<\w+\b[^>]*className="[^"]*\bplaque\b[^"]*"[^>]*>/g)]
        .map((match) => `${source.name}: ${match[0]}`));
    expect(plaques.length).toBeGreaterThan(0);
    expect(plaques.filter((tag) => !/fontSize:\s*'var\(--t-md\)'/.test(tag))).toEqual([]);
  });

  it('gives the "(not checked)" draft words a size of their own: a bare span beside a heading is 15px', () => {
    const page = SOURCES.find((source) => source.name === 'page.tsx')?.code ?? '';
    const marks = page.split('\n').filter((line) => line.includes('{DRAFT_NOT_CHECKED}'));
    expect(marks.length).toBeGreaterThan(0);
    expect(marks.filter((line) => !/\bt-body\b|\bt-label\b|var\(--t-md\)/.test(line)).map((line) => line.trim())).toEqual([]);
  });
});
