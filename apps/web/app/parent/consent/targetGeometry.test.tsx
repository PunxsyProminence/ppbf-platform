/**
 * @jest-environment jsdom
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import type { ReactNode } from 'react';
import { render, screen } from '@testing-library/react';

import GuardianMediaConsentPage from './page';

/**
 * RESOLVED GEOMETRY, NOT CLASS STRINGS.
 *
 * The bug this file exists to stop passed every className assertion you could
 * write. `.btn--lever min-h-[44px]` contains the string "min-h-[44px]" and
 * rendered 38px, because design-system/ppbf.css is UNLAYERED while Tailwind's
 * utilities sit in `@layer utilities`, and an unlayered rule beats a layered
 * one whatever the selectors say. A test that greps the class list would have
 * gone green on the broken page. So this one does not grep: it parses both
 * stylesheets, records which rules are layered, matches them against the real
 * elements the page renders, and computes which declaration actually wins.
 *
 * Nothing here was seen in a browser -- the geometry below is computed from the
 * cascade, from the same two files the app ships.
 */

const PPBF = path.resolve(__dirname, '../../../../../design-system/ppbf.css');
const GLOBALS = path.resolve(__dirname, '../../globals.css');

/* Tailwind v4 emits `@layer theme, base, components, utilities;` at the top of
   its entry, which is what makes every utility loseable. */
const UTILITY_LAYER = 'utilities';

interface CssRule {
  readonly selector: string;
  readonly declarations: Readonly<Record<string, string>>;
  readonly layer: string | null;
  readonly conditional: boolean;
  readonly origin: string;
  readonly order: number;
}

function stripComments(css: string): string {
  // Both sheets carry long prose comments that quote selectors and braces.
  // They have to go before anything else looks at a `{`.
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

function parseDeclarations(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const piece of body.split(';')) {
    const colon = piece.indexOf(':');
    if (colon === -1) continue;
    const property = piece.slice(0, colon).trim().toLowerCase();
    const value = piece.slice(colon + 1).trim();
    if (property && value) out[property] = value;
  }
  return out;
}

/** A flat parse of a non-nested sheet: enough for these two, and it says so. */
function parseSheet(css: string, origin: string, startOrder: number): CssRule[] {
  const text = stripComments(css);
  const rules: CssRule[] = [];
  const stack: string[] = [];
  let prelude = '';
  let order = startOrder;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '{') {
      const head = prelude.trim();
      prelude = '';
      if (head.startsWith('@')) {
        stack.push(head);
        continue;
      }
      const close = text.indexOf('}', i);
      const body = text.slice(i + 1, close === -1 ? text.length : close);
      // A nested block would break this parse rather than mis-report; neither
      // sheet uses CSS nesting today and the assertion below keeps it honest.
      expect(body).not.toContain('{');
      rules.push({
        selector: head,
        declarations: parseDeclarations(body),
        layer: stack.find((at) => at.startsWith('@layer'))?.replace(/^@layer\s+/, '').trim() ?? null,
        conditional: stack.some((at) => /^@(media|supports|container)/.test(at)),
        origin,
        order: (order += 1),
      });
      i = close === -1 ? text.length : close;
      continue;
    }
    if (ch === '}') {
      prelude = '';
      stack.pop();
      continue;
    }
    if (ch === ';') {
      // A statement at-rule -- `@import`, `@layer a, b;` -- ends here and opens
      // nothing. Without this the `@import` at the top of ppbf.css glues itself
      // to the `:root` that follows and the token block disappears.
      prelude = '';
      continue;
    }
    prelude += ch;
  }
  return rules;
}

/* Source order after @import inlining: globals.css imports tailwindcss, then
   ppbf.css, and only then states its own rules. */
const PPBF_RULES = parseSheet(readFileSync(PPBF, 'utf8'), 'ppbf.css', 0);
const AUTHOR_RULES = [
  ...PPBF_RULES,
  ...parseSheet(readFileSync(GLOBALS, 'utf8'), 'globals.css', PPBF_RULES.length + 1),
];

function specificity(selector: string): number {
  const ids = (selector.match(/#[\w-]+/g) ?? []).length;
  const classes = (selector.match(/\.[\w-]+|\[[^\]]+\]|:(?!:)[\w-]+/g) ?? []).length;
  const elements = (selector.match(/(^|[\s>+~])[a-z][\w-]*/gi) ?? []).length;
  return ids * 10000 + classes * 100 + elements;
}

/** Which comma-separated part of a selector list this element matches, if any. */
function matchingPart(element: Element, selector: string): string | null {
  let best: string | null = null;
  for (const part of selector.split(',')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    try {
      if (!element.matches(trimmed)) continue;
    } catch {
      continue; // pseudo-elements and anything jsdom will not evaluate
    }
    if (best === null || specificity(trimmed) > specificity(best)) best = trimmed;
  }
  return best;
}

/* The three Tailwind utilities this page uses to state geometry. Modelled here
   because they are generated, not written in either sheet -- and modelled as
   LAYERED, which is the whole point. */
function utilityDeclaration(className: string, property: string): string | null {
  const arbitrary = new RegExp(`(?:^|\\s)${property === 'min-height' ? 'min-h' : property === 'height' ? 'h' : 'w'}-\\[([^\\]]+)\\]`);
  const hit = className.match(arbitrary);
  if (hit) return hit[1].replace(/_/g, ' ');
  if (property === 'width' && /(?:^|\s)w-full(?:\s|$)/.test(className)) return '100%';
  return null;
}

interface Resolution {
  readonly value: string | null;
  readonly from: string;
  readonly layered: boolean;
}

function resolve(element: Element, property: string): Resolution {
  const matches = AUTHOR_RULES.filter(
    (rule) => !rule.conditional && rule.declarations[property] !== undefined && matchingPart(element, rule.selector),
  );

  const unlayered = matches.filter((rule) => rule.layer === null);
  if (unlayered.length > 0) {
    // Unlayered author rules outrank every layer, so the utility never gets a
    // vote. Within them: specificity, then source order.
    const winner = unlayered.reduce((best, rule) => {
      const a = specificity(matchingPart(element, rule.selector) as string);
      const b = specificity(matchingPart(element, best.selector) as string);
      return a > b || (a === b && rule.order > best.order) ? rule : best;
    });
    return { value: winner.declarations[property], from: `${winner.origin} ${winner.selector.split(',')[0].trim()}`, layered: false };
  }

  const utility = utilityDeclaration(element.className || '', property);
  if (utility !== null) return { value: utility, from: `@layer ${UTILITY_LAYER}`, layered: true };

  const layered = matches.filter((rule) => rule.layer !== null);
  if (layered.length > 0) {
    const winner = layered.reduce((best, rule) => (rule.order > best.order ? rule : best));
    return { value: winner.declarations[property], from: `${winner.origin} @layer ${winner.layer}`, layered: true };
  }
  return { value: null, from: 'initial', layered: false };
}

/** :root tokens, so an assertion can talk in pixels rather than in var names. */
const TOKENS: Record<string, string> = (() => {
  const root = AUTHOR_RULES.filter((rule) => rule.selector.trim() === ':root' && !rule.conditional);
  const out: Record<string, string> = {};
  for (const rule of root) Object.assign(out, rule.declarations);
  return out;
})();

function toPx(value: string | null): number {
  if (value === null) return 0;
  const token = value.match(/^var\((--[\w-]+)\)$/);
  if (token) return toPx(TOKENS[token[1]] ?? null);
  const px = value.match(/^([\d.]+)px$/);
  return px ? Number(px[1]) : 0;
}

/* ------------------------------------------------------------------ render */

jest.mock('@/components/RoleSessionGate', () => ({
  __esModule: true,
  default: ({ children }: { readonly children: ReactNode }) => children,
}));

// Unlike the mock in page.test.tsx this one forwards className -- the escape
// hatch's geometry is one of the three things under test.
jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ children, href, className }: { readonly children: ReactNode; readonly href: string; readonly className?: string }) => (
    <a href={href} className={className}>{children}</a>
  ),
}));

const NEEDS_CONSENT = [
  {
    athlete_id: 'ath-1',
    athlete_name: 'Mia Cortez',
    consent_ok: false,
    guardian_count: 1,
    missing_guardian_count: 1,
    per_guardian: [{ parent_id: 'p1', you: true, status: null, covers_video: null, public_use_allowed: null, signed_at: null }],
  },
];

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
  jest.clearAllMocks();
});

async function renderConsentPage() {
  global.fetch = jest
    .fn()
    .mockResolvedValue({ ok: true, json: async () => ({ ok: true, items: NEEDS_CONSENT }) } as Response) as unknown as typeof fetch;
  const view = render(<GuardianMediaConsentPage />);
  await screen.findByText('Consent needed');
  return view;
}

/* ------------------------------------------------------------- the resolver */

describe('the cascade resolver these assertions stand on', () => {
  it('reproduces the defect it was written to catch', () => {
    // The shape of the #498 trap: a geometry utility behind an unlayered rule
    // that speaks for the same property. If the resolver cannot see the sheet
    // win here, nothing below means anything.
    //
    // This used to assert `.btn--lever min-h-[44px]` -> 38px, which was the
    // literal class string that shipped broken. `.btn--lever` is 44px now (38
    // is under the WCAG target floor and every lever call site had been asking
    // for 44 and losing), so that pairing agrees and no longer demonstrates
    // anything. The mechanism is unchanged, so the probe moves to a pairing
    // that still exhibits it rather than being deleted.
    const broken = document.createElement('textarea');
    broken.className = 'textarea min-h-[84px]';
    document.body.append(broken);

    const resolved = resolve(broken, 'min-height');
    expect(resolved.value).toBe('46px');
    // The resolver names a rule by the first part of its selector list, and
    // this one is `.input, .select, .textarea` -- so the textarea's height
    // arrives under the name `.input`.
    expect(resolved.from).toContain('ppbf.css .input');
    expect(resolved.layered).toBe(false);
    broken.remove();
  });

  it('holds the lever at the WCAG target floor', () => {
    // The rule that used to be this file's example of the bug. It is now the
    // thing being protected: if `.btn--lever` slips back under 44px, the levers
    // on the admin screens go sub-floor again and their `min-h-[44px]` utility
    // will not save them.
    const lever = document.createElement('button');
    lever.className = 'btn--lever min-h-[44px] disabled:opacity-50';
    document.body.append(lever);

    const resolved = resolve(lever, 'min-height');
    expect(resolved.from).toContain('.btn--lever');
    expect(resolved.layered).toBe(false);
    expect(toPx(resolved.value)).toBeGreaterThanOrEqual(44);
    lever.remove();
  });

  it('lets a utility win when no unlayered rule speaks for the property', () => {
    const label = document.createElement('label');
    label.className = 't-body min-h-[var(--tap)]';
    document.body.append(label);

    expect(resolve(label, 'min-height').value).toBe('var(--tap)');
    label.remove();
  });

  it('reads the tokens the page states its sizes in', () => {
    expect(toPx('var(--tap)')).toBe(55);
    expect(toPx('var(--s5)')).toBe(21);
  });
});

/* ------------------------------------------------------------- the controls */

describe('guardian media consent: rendered target geometry', () => {
  it('gives each consent checkbox a target at or above the tap token', async () => {
    const { container } = await renderConsentPage();
    const boxes = container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
    expect(boxes).toHaveLength(2);

    for (const box of Array.from(boxes)) {
      // The label wraps the input, so the label's box is the target -- which is
      // the rule globals.css already states for checkboxes.
      const label = box.closest('label');
      expect(label).not.toBeNull();

      const target = toPx(resolve(label as Element, 'min-height').value);
      expect(target).toBeGreaterThanOrEqual(44);
      expect(target).toBe(55);

      // And the mark itself is no longer the browser's ~13px default.
      expect(toPx(resolve(box, 'height').value)).toBe(21);
      expect(toPx(resolve(box, 'width').value)).toBe(21);
    }
  });

  it('resolves the decision button above the WCAG floor, from an unlayered rule', async () => {
    await renderConsentPage();
    const grant = screen.getByRole('button', { name: 'Grant Consent' });

    const resolved = resolve(grant, 'min-height');
    expect(toPx(resolved.value)).toBeGreaterThanOrEqual(44);
    expect(toPx(resolved.value)).toBe(55);
    // The height is decided in the unlayered sheet, so no future utility --
    // and no ppbf.css rule -- can quietly shadow it the way .btn--lever did.
    expect(resolved.layered).toBe(false);
    expect(resolved.from).toContain('ppbf.css');
  });

  it('never lets the escape hatch out-rank the decision', async () => {
    await renderConsentPage();
    const grant = screen.getByRole('button', { name: 'Grant Consent' });
    const back = screen.getByRole('link', { name: 'Back to Parent Hub' });

    const grantHeight = toPx(resolve(grant, 'min-height').value);
    const backHeight = toPx(resolve(back, 'min-height').value);
    expect(grantHeight).toBeGreaterThan(backHeight);

    // Width is the half that actually reversed: 230x44 leaving vs 156x38
    // deciding. The decision spans the child's card at every viewport; the
    // escape hatch keeps its intrinsic width, so it can never be wider again.
    expect(resolve(grant, 'width').value).toBe('100%');
    expect(resolve(back, 'width').value).toBeNull();
  });

  it('leaves no inert geometry utility anywhere on the page', async () => {
    const { container } = await renderConsentPage();
    const inert: string[] = [];

    for (const element of Array.from(container.querySelectorAll<HTMLElement>('[class]'))) {
      for (const property of ['min-height', 'height', 'width'] as const) {
        const asked = utilityDeclaration(element.className, property);
        if (asked === null) continue;
        const won = resolve(element, property);
        if (won.value !== asked) inert.push(`<${element.tagName.toLowerCase()} class="${element.className}"> asks ${property}:${asked}, gets ${won.value} from ${won.from}`);
      }
    }

    // This is the assertion the old page failed: it asked for 44px and got 38.
    expect(inert).toEqual([]);
  });

  it('has no media query that would change these three answers', async () => {
    const { container } = await renderConsentPage();
    const controls = [
      ...Array.from(container.querySelectorAll('input[type="checkbox"]')),
      ...Array.from(container.querySelectorAll('label')),
      ...Array.from(container.querySelectorAll('button')),
      ...Array.from(container.querySelectorAll('a')),
    ];

    const conditional = AUTHOR_RULES.filter(
      (rule) =>
        rule.conditional &&
        (rule.declarations['min-height'] !== undefined || rule.declarations.height !== undefined || rule.declarations.width !== undefined) &&
        controls.some((element) => matchingPart(element, rule.selector)),
    );

    // Everything above is computed for the base viewport. If a @media block
    // ever starts speaking for one of these controls, that reasoning stops
    // being complete and this goes red first.
    expect(conditional.map((rule) => `${rule.origin} ${rule.selector}`)).toEqual([]);
  });
});

/* ---------------------------------------------------- semantics stay put */

describe('geometry only', () => {
  it('keeps the video checkbox pre-checked and the public-use checkbox not', async () => {
    const { container } = await renderConsentPage();
    const [video, publicUse] = Array.from(container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'));

    // Pre-existing owner decision, deliberately untouched by the size fix.
    expect(video.checked).toBe(true);
    expect(publicUse.checked).toBe(false);
  });
});
