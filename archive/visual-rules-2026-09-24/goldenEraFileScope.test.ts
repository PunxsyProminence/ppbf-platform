import { readFileSync } from 'node:fs';
import path from 'node:path';

import { readDesignSystemCss, DESIGN_SYSTEM_ENTRY } from './readDesignSystemCss';

/**
 * GOLDEN ERA 010 — THE FILE (Research Inbox, /research).
 *
 * Three contracts live here, and the last two are the ones that matter.
 *
 * 1. THE TOKEN SCOPE. `.ge-file` redefines the brass ramp to aged bronze so
 *    every shared component this route renders — the panel keylines, `.btn`,
 *    `.btn--ghost`, `.plaque`, `.input`/`.select`/`.textarea`, `.t-eyebrow`,
 *    the brass pins through the intake cards, the focus ring — resolves Golden
 *    Era metal together. A property override leaks wherever it is forgotten; a
 *    token override cannot. Same seam `.ge-bell`, `.ge-floorboard` and the
 *    other seven scopes use.
 *
 * 2. THE SCOPE STAYS INSIDE ITSELF, AND OFF THE THINGS IT MAY NOT TOUCH. Six
 *    structural properties, each of which a plausible edit would break:
 *
 *      - every selector in the block starts at `.ge-file`, so no rule can
 *        reach another route — and the file room has six other doors on the
 *        same wall (/research/chat, /research/review, /evidence,
 *        /knowledge-graph, /simulator, /audit), none of which this pass ships;
 *      - every rule that names a `.t-*` voice is anchored at `> header`. On
 *        most surfaces the rule is "name the material you stand on"; on THIS
 *        one that is not enough, because the paper is nested INSIDE the
 *        leather — the answer-a-gap panel is a `.mat-paper` inside a
 *        `.mat-leather--raised` inside a `.mat-leather` — so
 *        `.ge-file .mat-leather .t-eyebrow` (0,3,0) would reach straight
 *        through `.mat-paper .t-eyebrow` (0,2,0) and print bronze on cream.
 *        The masthead is the one region of this route that carries no paper,
 *        so it is the only place a voice may be restated;
 *      - no rule names `.mat-paper` at all. This route's paper is real — the
 *        intake cards, the answer panel, the torn empty-state notes — and the
 *        sheet's own light-ground ink restatement already answers it. A
 *        previous scope's `.mat-paper` brass tint was REMOVED rather than
 *        relax lightGroundVoices.test.ts, and the same answer holds here;
 *      - every rule that names `.mat-leather` excludes `[role="alert"]`. Both
 *        projection failures on this route are `role="alert"` panels whose
 *        border IS `var(--locked)`, and this sheet is unlayered, so a bare
 *        `border-color` here would out-rank that utility and repaint #A81E22
 *        in bronze — a safety-semantics change wearing a visual change's
 *        clothes;
 *      - no rule names `.stamp`, `.badge` or `.room`. Safeguarding ink and the
 *        Law 2 status ladder are not a visual pass's to restyle, and the wall
 *        is the committed plate's job, not this scope's;
 *      - the block declares no `--bone-*`, `--hide-*`, `--paper`, `--plate` or
 *        reserved-red token. A bone rung is a platform-wide promise about
 *        contrast (cornerColor.test.ts reads the LAST declaration of a token
 *        as its value), and `--plate` is a locked room inventory with its own
 *        guard. Only the brass ramp moves.
 *
 * 3. THE REAL CONTROL SET SURVIVES THE MOCKUP. The approved 010 reference
 *    (REFERENCE_APPROVED.jpg, HANDOFF.md "VISUAL_APPROVED (desktop) — Jason
 *    2026-08-25") draws a board headed RESEARCH ARCHIVE, with a SEARCH
 *    DOSSIER… field under it, an ATHLETE FILE DRAWERS column carrying three
 *    brass drawer plates reading ALEX / JORDAN / SAM, and a DOSSIER CARDS
 *    panel of overlapping parchment.
 *
 *    None of that exists behind /research. There is no search, no filter and
 *    no query parameter — the page performs two fixed projection GETs — and
 *    the surface is not filed by athlete: the projection is organization-
 *    scoped and the requirement records carry a free-text source entity, not a
 *    roster link. Implementing the image literally would rename the surface,
 *    ship a search box with no endpoint, and put three children's names on a
 *    page that never read them. So the MATERIALS are applied to the controls
 *    that are really there and the difference is reported to the owner as an
 *    information-architecture question with its own PR, its own API and its
 *    own tests.
 *
 *    The same image omits almost everything this route really does: the
 *    review-state summary, the operational-requirements form, the answer-a-gap
 *    submission flow with its answer-state ladder, the general-research intake
 *    with its classification correction, and the projection-unavailable
 *    refusal. A visual pass is exactly when a real control goes quietly
 *    missing, so both halves are pinned below.
 *
 * MUTATION CHECK: set a `--brass-NNN` line in the `.ge-file` block to its
 * legacy value, drop one of its triples, disagree a triple with its hex, spell
 * a brass literal, drop the class from the page, add a bare `.ge-file .t-body`
 * rule, add a `.ge-file .mat-paper` rule, drop the `[role="alert"]` exclusion,
 * add a `.ge-file .stamp` or `.ge-file .room` rule, let a selector escape the
 * scope, delete a control or invent a search box — each turns this suite red.
 */

const BRASS_RUNGS = ['200', '300', '400', '500', '600', '700', '800', '900'] as const;

const css = readDesignSystemCss(DESIGN_SYSTEM_ENTRY);

/** The Golden Era sheet on its own, for assertions about THIS block's text. */
const THEME = readFileSync(
  path.resolve(__dirname, '../../../../design-system/current/ppbf-golden-era.css'),
  'utf8',
);

const PAGE = readFileSync(
  path.resolve(__dirname, '../../app/research/page.tsx'),
  'utf8',
);

/** The bare `.ge-file { … }` token rule, not its descendant rules. */
function scopeBody(source: string): string | null {
  const match = source.match(/^\.ge-file\s*\{([^}]*)\}/m);
  return match ? match[1] : null;
}

function legacyRung(source: string, rung: string): string | null {
  const withoutScope = source.replace(/^\.ge-file\s*\{[^}]*\}/m, '');
  const m = withoutScope.match(new RegExp(`--brass-${rung}\\s*:\\s*(#[0-9A-Fa-f]{3,8})`, 'i'));
  return m ? m[1].toLowerCase() : null;
}

/**
 * The 010 block's DECLARATIONS, comments removed.
 *
 * Comments come out FIRST, before the block is located, because the block's own
 * header names the reserved red in order to say it does not use it, names
 * `.mat-paper` in order to say it does not touch it, and because "GOLDEN ERA
 * 010" itself sits inside that header — slicing first would strand an
 * unterminated comment. The block ends where the next scope begins, which is
 * `.ge-bell` (001 follows 010 in source order).
 */
function fileBlock(): string {
  const declarations = THEME.replace(/\/\*[\s\S]*?\*\//g, '');
  const start = declarations.indexOf('.ge-file');
  const end = declarations.indexOf('.ge-bell');
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return declarations.slice(start, end);
}

/** Split a selector list on top-level commas only — `:is(a, b)` is one part. */
function splitSelectors(list: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const character of list) {
    if (character === '(') depth += 1;
    if (character === ')') depth -= 1;
    if (character === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += character;
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter(Boolean);
}

/** Every rule in the 010 block as [selector, body], one entry per selector. */
function fileRules(): Array<[string, string]> {
  // The media query's own brace is removed so the flat rule scan below reaches
  // the rules inside it; the orphaned closing brace is inert to the scan.
  const flat = fileBlock().replace(/@media[^{]*\{/g, '');
  const rules: Array<[string, string]> = [];
  for (const rule of flat.matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
    for (const selector of splitSelectors(rule[1])) {
      rules.push([selector, rule[2]]);
    }
  }
  return rules;
}

const selectors = () => fileRules().map(([selector]) => selector);

/** `.mat-leather` itself, never `.mat-leather--raised`. */
const NAMES_LEATHER = /\.mat-leather(?![-a-z])/;

/**
 * Every `<button>` / `<Link>` label on a surface, whitespace-collapsed.
 *
 * Lifted from goldenEraBoardScope.test.ts, and read from the JSX rather than a
 * rendered tree for the same reason: a control behind a state this test would
 * have to fake is exactly the kind that disappears unnoticed in a visual pass,
 * and it is still a real control. A conditional label arrives as one entry
 * carrying both branches, which is why assertions match on containment.
 */
function controlLabels(source: string): string[] {
  const labels: string[] = [];
  for (const tag of ['button', 'Link'] as const) {
    const open = new RegExp(`<${tag}\\b`, 'g');
    for (let found = open.exec(source); found !== null; found = open.exec(source)) {
      /* Where the opening tag ends cannot be "the next >": a JSX handler is
         full of arrows and comparisons. Depth-counted braces and quote state
         are what actually distinguish the tag's own > from one inside an
         attribute expression. */
      let depth = 0;
      let quote = '';
      let cursor = found.index + tag.length + 1;
      for (; cursor < source.length; cursor += 1) {
        const character = source[cursor];
        if (quote) {
          if (character === quote) quote = '';
        } else if (character === '"' || character === "'" || character === '`') {
          quote = character;
        } else if (character === '{') {
          depth += 1;
        } else if (character === '}') {
          depth -= 1;
        } else if (character === '>' && depth === 0) {
          break;
        }
      }
      const close = source.indexOf(`</${tag}>`, cursor);
      if (close === -1) continue;
      labels.push(source.slice(cursor + 1, close).replace(/\s+/g, ' ').trim());
    }
  }
  return labels;
}

const LABELS = controlLabels(PAGE);

describe('golden-era file scope', () => {
  test('the bronze ramp is on the .ge-file class scope, not :root', () => {
    expect(scopeBody(css)).not.toBeNull();
    for (const block of css.match(/:root\s*\{[^}]*\}/g) ?? []) {
      expect(block).not.toContain('#E7C88A');
    }
  });

  test.each(BRASS_RUNGS)('brass rung %s is redefined on the scope and differs from legacy', (rung) => {
    const body = scopeBody(css);
    expect(body).not.toBeNull();
    const scoped = (body as string).match(new RegExp(`--brass-${rung}\\s*:\\s*(#[0-9A-Fa-f]{3,8})`, 'i'));
    expect(scoped).not.toBeNull();
    expect((scoped as RegExpMatchArray)[1].toLowerCase()).not.toEqual(legacyRung(css, rung));
  });

  test.each(BRASS_RUNGS)('rung %s carries its own channel triple, and the two agree', (rung) => {
    // brassAlphaChannel.test.ts owns this platform-wide; it is restated here
    // because a rung that moves without its triple splits THIS scope down the
    // middle — solid bronze beside inherited-gold hairlines — and the guard
    // for that should go red in the suite that owns the surface too.
    const body = scopeBody(css) as string;
    const hex = body.match(new RegExp(`--brass-${rung}\\s*:\\s*(#[0-9A-Fa-f]{6})`, 'i'));
    const triple = body.match(new RegExp(`--brass-${rung}-rgb\\s*:\\s*(\\d+)\\s+(\\d+)\\s+(\\d+)\\s*;`));
    expect(hex).not.toBeNull();
    expect(triple).not.toBeNull();
    const declared = [1, 2, 3].map((i) => Number((triple as RegExpMatchArray)[i]));
    const expected = [1, 3, 5].map((i) => parseInt((hex as RegExpMatchArray)[1].slice(i, i + 2), 16));
    expect(declared).toEqual(expected);
  });

  test('the research inbox route carries the scope class', () => {
    expect(PAGE).toMatch(/className="[^"]*\bge-file\b[^"]*"/);
  });

  test('the scope class is the only markup this pass added to the route', () => {
    // The class rides a wrapper because RoleStandaloneView owns this route's
    // <main> and declares .room room--file there; the shell wraps 68 pages, so
    // putting the scope on it would leak onto every one of them. Same seam
    // .ge-floorboard and .ge-locker already use. Exactly one wrapper, and it
    // carries nothing but the class.
    expect(PAGE).toContain('<div className="ge-file">');
    // Exactly one ELEMENT carries it. Counting raw occurrences would count the
    // explanatory comment above the wrapper too, which is not markup.
    expect(PAGE.match(/className="[^"]*\bge-file\b[^"]*"/g) ?? []).toHaveLength(1);
    // The route still hands its room to the shell rather than restating it.
    expect(PAGE).toContain('room="file"');
    expect(PAGE).not.toContain('room--file"');
  });
});

describe('the 010 block stays inside its scope and off what it may not touch', () => {
  test('parses a real set of rules, so the checks below are not vacuous', () => {
    expect(fileRules().length).toBeGreaterThan(10);
  });

  test('every selector in the block starts at .ge-file', () => {
    expect(selectors().filter((selector) => !selector.startsWith('.ge-file'))).toEqual([]);
  });

  test('every rule that restates a voice is anchored at the masthead', () => {
    // The paper on this route is nested inside the leather, so naming a
    // material is NOT enough here: `.ge-file .mat-leather .t-eyebrow` reaches
    // through `.mat-paper .t-eyebrow` on specificity. `> header` is the one
    // region of this surface that carries no paper.
    const bare = selectors()
      .filter((selector) => /\.t-[a-z]/.test(selector))
      .filter((selector) => !selector.includes('> header'));
    expect(bare).toEqual([]);
  });

  test('no rule names .mat-paper', () => {
    // This route's paper is real and the sheet already answers its ink. A
    // scope's brass tint on that ground was removed once rather than relax
    // lightGroundVoices.test.ts; it is not being reintroduced here.
    expect(selectors().filter((selector) => selector.includes('.mat-paper'))).toEqual([]);
    expect(fileBlock()).not.toContain('.mat-paper');
  });

  test('every rule that names .mat-leather excludes the reserved-red refusal panel', () => {
    // Both projection failures render role="alert" with
    // border-[color:var(--locked)]. This sheet is unlayered, so an unqualified
    // border-color here would beat that utility and repaint #A81E22.
    const offenders = selectors()
      .filter((selector) => NAMES_LEATHER.test(selector))
      .filter((selector) => !selector.includes('[role="alert"]'));
    expect(offenders).toEqual([]);
  });

  test('no rule reaches a .stamp or a .badge', () => {
    // Safeguarding ink is not a visual pass's to restyle, and Law 2's status
    // ladder is not decorative.
    expect(selectors().filter((selector) => /\.stamp|\.badge/.test(selector))).toEqual([]);
  });

  test('the block never restates the room, its wall or its light', () => {
    // The plate carries the room. Nothing here redraws .room--file's cork,
    // retunes .room::before, or moves the --plate inventory.
    expect(selectors().filter((selector) => /\.room/.test(selector))).toEqual([]);
    expect(fileBlock()).not.toContain('--plate');
  });

  test('the block declares no token but the brass ramp', () => {
    const declared = new Set<string>();
    for (const [, body] of fileRules()) {
      for (const match of body.matchAll(/(--[a-z0-9-]+)\s*:/g)) declared.add(match[1]);
    }
    const foreign = [...declared].filter((token) => !token.startsWith('--brass-'));
    // Local helpers held on a rule for reuse within it are fine — they resolve
    // the ramp and paint nothing outside the scope. A platform vocabulary
    // token is not: a bone rung is a promise about contrast everywhere, and a
    // --plate URL is a locked room inventory with its own guard.
    for (const token of foreign) {
      expect({ token, platform: /^--(bone|hide|wood|paper|plate|locked|stamp|corner|cleared|monitor|restricted)/.test(token) })
        .toEqual({ token, platform: false });
    }
  });

  test('the scoped block never uses reserved medical red', () => {
    const block = fileBlock();
    expect(block).not.toMatch(/#A81E22/i);
    expect(block).not.toMatch(/--locked\b/);
    expect(block).not.toMatch(/--stamp-red\b/);
    expect(block).not.toMatch(/--locked-ink\b/);
  });

  test('the block spells no brass literal, so the scope can actually reach it', () => {
    // brassAlphaChannel.test.ts owns this app-wide. Restated on the block
    // because a literal is the one kind of gold a token scope cannot override,
    // and this scope's whole leak-proof argument rests on it.
    const block = fileBlock();
    for (const legacy of ['#D4AF4A', '#E8CE7A', '#F2E2A8', '#B8912F', '#A98126', '#8C6B1F', '#6B4E12', '#4A340B']) {
      expect(block).not.toMatch(new RegExp(legacy, 'i'));
    }
    expect(block).not.toMatch(/rgba?\(\s*212\s*,\s*175\s*,\s*74/);
  });
});

describe('the 010 mockup did not delete or invent research controls', () => {
  /** Sections and states the reference omits and that must not vanish with it. */
  const REAL_SECTIONS = [
    'Research Intake',
    'Research Inbox',
    'Review State Summary',
    'Research Intake Cards',
    'Operational Research Requirements',
    'General Research Intake',
    'Registered general research',
    'Projection Unavailable',
    'Empty State',
  ] as const;

  /** The record fields each intake card really prints. */
  const REAL_CARD_FIELDS = [
    'Requirement',
    'Knowledge Gap',
    'Evidence Label',
    'Source Status',
  ] as const;

  /** The answer-state ladder #345 added, which the reference draws none of. */
  const REAL_ANSWER_STATES = [
    'Needs Evidence',
    'Sources Submitted',
    'Evidence Under Review',
    'Partially Answered',
    'Resolved',
  ] as const;

  /** Every field the two forms really offer. */
  const REAL_FIELDS = [
    'Source event name',
    'Source entity type',
    'Source entity id',
    'Research requirement',
    'Knowledge gap',
    'Library source',
    'DOI / PMID',
    'Provider',
    'Why this source answers it',
    'Classification domain',
    'Original filename',
    'Correct classification',
  ] as const;

  test.each(REAL_SECTIONS)('the section %s is still rendered', (heading) => {
    expect(PAGE).toContain(heading);
  });

  test.each(REAL_CARD_FIELDS)('the intake card still prints %s', (field) => {
    expect(PAGE).toContain(`>${field}</dt>`);
  });

  test.each(REAL_ANSWER_STATES)('the answer state %s is still on the ladder', (label) => {
    expect(PAGE).toContain(`label: '${label}'`);
  });

  test.each(REAL_FIELDS)('the form field %s is still offered', (label) => {
    expect(PAGE).toContain(label);
  });

  test('the five review states stay five distinct facts', () => {
    // 'Unknown' is the sheet's administrative rung, not a fifth outcome
    // wearing a safety colour; a visual pass must not collapse it into one of
    // the four the queue really produces.
    for (const state of ['Pending Review', 'Approved', 'Rejected', 'Promoted', 'Unknown']) {
      expect(PAGE).toContain(`label: '${state}'`);
    }
    expect(PAGE).toContain("className: 'badge badge--filed'");
  });

  test('the failed-read refusal is still its own state', () => {
    // A projection that could not be read is not an empty archive. Both
    // states, and the reserved-red panel that carries the first, survive.
    expect(PAGE).toContain('badge badge--locked');
    expect(PAGE).toContain('border-[color:var(--locked)]');
    expect(PAGE).toContain('No SHADOW research projection items exist');
  });

  test('every real control still exists, in both wordings where it has two', () => {
    for (const label of [
      'Q&amp;A Research Chat',
      'Evidence Review',
      'Publish Stage',
      'Move to Evidence',
      'Save Requirement',
      'Cancel',
      'Answer this gap',
    ]) {
      expect(LABELS).toContain(label);
    }
    for (const fragment of ['Mark Resolved', 'Submit source', 'Register general research', 'Resolving...']) {
      expect(LABELS.some((label) => label.includes(fragment))).toBe(true);
    }
  });

  test('the control count is unchanged', () => {
    // A count, not just a membership list: a label can be pinned above and an
    // eleventh control still appear, or a duplicate mask a deletion.
    expect(LABELS).toHaveLength(10);
  });

  test('no control was invented from the reference image', () => {
    // Drawn on the reference board, backed by nothing on this route. Matched
    // against control LABELS as well as the source so that ordinary words in
    // real copy cannot mask a genuinely invented button.
    for (const invented of ['Search', 'Search Dossier', 'SEARCH DOSSIER…', 'Open Drawer', 'ALEX', 'JORDAN', 'SAM']) {
      expect(LABELS).not.toContain(invented);
    }
    expect(PAGE).not.toContain('Search Dossier');
    expect(PAGE).not.toContain('placeholder="Search');
    expect(PAGE).not.toContain('type="search"');
  });

  test('no athlete drawer bank was invented', () => {
    // The reference files this surface by athlete. The projection is
    // organization-scoped and this page reads no roster, so a per-athlete
    // drawer would be three children's names on a page that never fetched
    // them.
    for (const invented of ['Athlete File Drawers', 'ATHLETE FILE DRAWERS', 'Dossier Cards', 'DOSSIER CARDS']) {
      expect(PAGE).not.toContain(invented);
    }
  });

  test('the surface was not renamed to the reference title', () => {
    // The reference heads the board RESEARCH ARCHIVE. This page is the
    // Research Inbox, and a stylesheet does not rename a surface.
    expect(PAGE).not.toContain('Research Archive');
    expect(PAGE).not.toContain('RESEARCH ARCHIVE');
    expect(PAGE).toContain('Research Inbox');
  });

  test('the route still hands its own gate and roles to the shell unchanged', () => {
    // FUNCTIONAL_CHANGES: NONE has to mean the role set too — a visual pass
    // that quietly widened or narrowed this list would change who can read the
    // research projection.
    expect(PAGE).toContain(
      "allowedRoles={['athlete', 'coach', 'parent', 'admin', 'platform_owner', 'staff', 'volunteer']}",
    );
  });
});
