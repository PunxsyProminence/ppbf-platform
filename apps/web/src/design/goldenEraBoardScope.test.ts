import { readFileSync } from 'node:fs';
import path from 'node:path';

import { readDesignSystemCss, DESIGN_SYSTEM_ENTRY } from './readDesignSystemCss';

/**
 * GOLDEN ERA 008 — THE BOARD (Board Hub, /board).
 *
 * Three contracts live here, and the last two are the ones that matter.
 *
 * 1. THE TOKEN SCOPE. `.ge-board` redefines the brass ramp to aged bronze so
 *    every shared component this route renders — the panel keylines, the
 *    `.btn--ghost` seat links, `.t-eyebrow`, `.stat-note`, the focus ring —
 *    resolves Golden Era metal together. A property override leaks wherever it
 *    is forgotten; a token override cannot. Same seam `.ge-bell`,
 *    `.ge-floorboard` and the other six scopes use.
 *
 * 2. THE SCOPE STAYS INSIDE ITSELF, AND OFF THE THINGS IT MAY NOT TOUCH. Four
 *    structural properties, each of which a plausible edit would break:
 *
 *      - every selector in the block starts at `.ge-board`, so no rule can
 *        reach another route;
 *      - every rule that names a `.t-*` voice also names the material it is
 *        standing on. That is not tidiness. `.ge-board .t-command` and
 *        `.on-plaster .t-command` are both (0,2,0) and this sheet is imported
 *        after the legacy one, so a BARE voice rule here wins on source order
 *        and prints bone display type onto the parchment masthead — the light
 *        ground `on-plaster` exists to answer;
 *      - no rule names `.stamp`. Both card families on this route carry one
 *        (the seat directory's "Seat held" governance refusal and the aggregate
 *        panel's "Suppressed" k-anonymity withholding), and on a dark material
 *        the sheet resolves that mark to `--locked-ink`. Restyling
 *        it — or re-grounding the card under it — is a safety-semantics change
 *        wearing a visual change's clothes;
 *      - the block declares no `--bone-*`, `--hide-*`, `--paper`, `--plate` or
 *        locked-red token. A bone rung is a platform-wide promise about
 *        contrast (cornerColor.test.ts reads the LAST declaration of a token as
 *        its value), and `--plate` is a locked room inventory with its own
 *        guard. Only the brass ramp moves.
 *
 * 3. THE REAL CONTROL SET SURVIVES THE MOCKUP. The approved 008 reference
 *    (REFERENCE_APPROVED.jpg, HANDOFF.md "VISUAL_APPROVED (desktop) — Jason
 *    2026-08-25") draws a parchment board headed BOARD RESOLUTIONS, carrying a
 *    numbered agenda (Call to Order / Approval of Minutes / Old Business), a
 *    stack of POLICY REVIEW cards, and five engraved plaques reading VOTE /
 *    VOTE APPROVE / APPROVE.
 *
 *    None of that exists behind /board. There is no resolution record, no
 *    motion, no ballot, no approval action, no meeting minute and no
 *    policy-review queue — the seat workspace lists the last two among the
 *    records this platform explicitly does not hold. Implementing the image
 *    literally would rename the surface and ship five governance controls with
 *    nothing behind them, on the one page in the building where that is least
 *    acceptable. So the MATERIALS are applied to the controls that are really
 *    there and the difference is reported to the owner as an
 *    information-architecture question with its own PR, its own API and its own
 *    tests.
 *
 *    The same image omits almost everything this route really does: the
 *    aggregate boundary statement, the six organization-level figures with
 *    their three distinct states, the eight-seat directory, and the seat-held
 *    refusal. A visual pass is exactly when a real control goes quietly
 *    missing, so both halves are pinned below.
 *
 * MUTATION CHECK: set a `--brass-NNN` line in the `.ge-board` block to its
 * legacy value, drop the class from the page, add a bare `.ge-board .t-body`
 * rule, add a `.ge-board .stamp` rule, delete a seat, or invent a VOTE control
 * — each turns this suite red.
 */

const css = readDesignSystemCss(DESIGN_SYSTEM_ENTRY);

/* THE MEDICAL-STOP NAMES: --locked, its --locked-* rungs, and every custom
   property whose every declaration resolves to one of them. Read from the
   sheets rather than listed, because app/globals.css aliases --locked as
   --safety-locked, --status-critical and --status-danger, and a check on the
   bare name waves all three through. ("Every declaration", so a slot such as
   `--badge`, which only the locked variant of .badge fills with --locked, is
   not counted.) */
const GLOBALS_CSS = readFileSync(path.resolve(__dirname, '../../app/globals.css'), 'utf8');
const MEDICAL_STOP_TOKENS: readonly string[] = (() => {
  const values = new Map<string, string[]>();
  for (const [, name, value] of `${css}\n${GLOBALS_CSS}`
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .matchAll(/(?<![\w-])(--[\w-]+)\s*:\s*([^;{}]*)/g)) {
    values.set(name, [...(values.get(name) ?? []), value]);
  }
  const tokens = new Set([...values.keys()].filter((name) => /^--locked(?:-|$)/.test(name)));
  const resolvesToStop = (value: string) =>
    [...value.matchAll(/var\(\s*(--[\w-]+)/g)].some(([, ref]) => tokens.has(ref));
  for (let grew = true; grew;) {
    grew = false;
    for (const [name, all] of values) {
      if (tokens.has(name) || !all.every(resolvesToStop)) continue;
      tokens.add(name);
      grew = true;
    }
  }
  return [...tokens].sort();
})();

/** The medical-stop names `text` refers to, matched as whole property names. */
function medicalStopReferences(text: string): string[] {
  return MEDICAL_STOP_TOKENS.filter((token) => new RegExp(`(?<![\\w-])${token}(?![\\w-])`).test(text));
}

/** The Golden Era sheet on its own, for assertions about THIS block's text. */
const THEME = readFileSync(
  path.resolve(__dirname, '../../../../design-system/current/ppbf-golden-era.css'),
  'utf8',
);

const PAGE = readFileSync(
  path.resolve(__dirname, '../../app/board/page.tsx'),
  'utf8',
);
const DIRECTORY = readFileSync(
  path.resolve(__dirname, '../../app/board/BoardSeatDirectory.tsx'),
  'utf8',
);
const SUMMARY = readFileSync(
  path.resolve(__dirname, '../../app/board/BoardSummaryPanel.tsx'),
  'utf8',
);
const CONFIG = readFileSync(
  path.resolve(__dirname, '../../app/board/boardWorkspaceConfig.ts'),
  'utf8',
);

/**
 * The 008 block's DECLARATIONS, comments removed.
 *
 * Comments come out FIRST, before the block is located, because the block's own
 * header names the locked red in order to say it does not use it, and because
 * "GOLDEN ERA 008" itself sits inside that header — slicing first would strand
 * an unterminated comment. The block ends where the next scope begins, which is
 * `.ge-scripts` (004A follows 008 in source order).
 */
function boardBlock(): string {
  const declarations = THEME.replace(/\/\*[\s\S]*?\*\//g, '');
  const start = declarations.indexOf('.ge-board');
  const end = declarations.indexOf('.ge-scripts');
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

/** Every rule in the 008 block as [selector, body], one entry per selector. */
function boardRules(): Array<[string, string]> {
  // The media query's own brace is removed so the flat rule scan below reaches
  // the rules inside it; the orphaned closing brace is inert to the scan.
  const flat = boardBlock().replace(/@media[^{]*\{/g, '');
  const rules: Array<[string, string]> = [];
  for (const rule of flat.matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
    for (const selector of splitSelectors(rule[1])) {
      rules.push([selector, rule[2]]);
    }
  }
  return rules;
}

/**
 * Every `<button>` / `<Link>` label on a surface, whitespace-collapsed.
 *
 * Lifted from goldenEraScriptsScope.test.ts, and read from the JSX rather than
 * a rendered tree for the same reason: a control behind a state this test would
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

const LABELS = [...controlLabels(PAGE), ...controlLabels(DIRECTORY), ...controlLabels(SUMMARY)];

/* 2026-10-02 (OD-2026-10-02-004, OD-2026-10-02-007): nothing about the look
   binds, so the cases here that pinned this screen's look were removed -- the
   bronze ramp and its channel triples, the scope class, selector shape, "only
   markup this pass added", control counts and "not renamed". What remains
   guards meaning and function: the --locked token, stamps and badges, gates
   and refusals, real controls still present, nothing invented. Where the
   header above describes a removed case it is history, kept as the record of
   why the case was written. */

describe('the 008 block stays inside its scope and off what it may not touch', () => {
  test('parses a real set of rules, so the checks below are not vacuous', () => {
    expect(boardRules().length).toBeGreaterThan(10);
  });

  test('every rule that restates a voice names the material it stands on', () => {
    // A bare `.ge-board .t-*` rule out-orders `.on-plaster .t-*` and repaints
    // the parchment masthead in leather ink. Naming a material keeps each
    // restatement on the ground it was measured against.
    const bare = boardRules()
      .map(([selector]) => selector)
      .filter((selector) => /\.t-[a-z]/.test(selector))
      .filter((selector) => !/\.mat-|\.stat\b/.test(selector));
    expect(bare).toEqual([]);
  });

  test('no rule reaches a .stamp', () => {
    // Safeguarding ink is not a visual pass's to restyle, and the status it
    // carries is not decorative.
    const offenders = boardRules()
      .map(([selector]) => selector)
      .filter((selector) => selector.includes('.stamp'));
    expect(offenders).toEqual([]);
  });

  test('the block declares no token but the brass ramp', () => {
    const declared = new Set<string>();
    for (const [, body] of boardRules()) {
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

  // --locked means a medical stop, which a board restyle has no business
  // reaching for. Red itself is not reserved (OD-2026-09-29-001), so the hue
  // and --stamp-red are not refused here.
  test('the scoped block never uses the --locked medical-stop token', () => {
    const block = boardBlock();
    expect(block).not.toMatch(/--locked\b/);
    expect(MEDICAL_STOP_TOKENS)
      .toEqual(expect.arrayContaining(['--locked', '--safety-locked', '--status-critical', '--status-danger']));
    expect(medicalStopReferences(block)).toEqual([]);
  });

});

describe('the 008 mockup did not delete or invent board controls', () => {
  /** Every seat the directory really offers, from the config it renders. */
  const REAL_SEATS = [
    'President',
    'Board Chair',
    'Vice Chair',
    'Treasurer',
    'Secretary',
    'Program & Safety Director',
    'Community & Development Director',
    'Director-at-Large',
  ] as const;

  /** Sections and states the reference omits and that must not vanish with it. */
  const REAL_SECTIONS = [
    'Board Workspace',
    'Board Hub',
    'Aggregate boundary',
    'Board Hub Aggregate',
    'Organization-level figures',
    'Board Seat',
    'Role Description',
    'Primary Responsibilities',
  ] as const;

  /** The six organization-level figures. */
  const REAL_FIGURES = [
    'Active Athletes',
    'Training Sessions (30 Days)',
    'Coach Reviews (30 Days)',
    'Goals Active',
    'Goals Completed',
    'Goals Other Status',
  ] as const;

  test.each(REAL_SEATS)('the seat %s is still offered', (label) => {
    expect(CONFIG).toContain(`seatLabel: '${label}'`);
  });

  test.each(REAL_SECTIONS)('the section %s is still rendered', (heading) => {
    expect(`${PAGE}${DIRECTORY}${SUMMARY}`).toContain(heading);
  });

  test.each(REAL_FIGURES)('the aggregate figure %s is still rendered', (label) => {
    expect(SUMMARY).toContain(label);
  });

  test('the three aggregate states stay three different facts', () => {
    // A suppressed figure exists and is withheld; "No records" means nothing
    // was recorded. Neither may collapse into a zero, and a board reading "0"
    // would take it for a measurement.
    expect(SUMMARY).toContain("value: 'Suppressed'");
    expect(SUMMARY).toContain("value: 'No records'");
    expect(SUMMARY).toContain('Measured; at least');
  });

  test('the seat-held refusal is still ink on the page', () => {
    expect(DIRECTORY).toContain('stamp stamp--flat');
    expect(DIRECTORY).toContain('Seat held');
  });

  test('the aggregate boundary statement is still the shared constant', () => {
    expect(PAGE).toContain('BOARD_AGGREGATE_BOUNDARY_STATEMENT');
  });

  test('the real seat link still exists, in both of its wordings', () => {
    expect(LABELS.some((label) => label.includes('Open Your Workspace'))).toBe(true);
    expect(LABELS.some((label) => label.includes('Open Governance Workspace'))).toBe(true);
  });

  test('no control was invented from the reference image', () => {
    // Drawn as five engraved plaques on the reference board, backed by nothing
    // on this route. Matched against control LABELS rather than raw source, so
    // the ordinary words "approve"/"approved" inside real aggregate copy
    // ("Approved 62% (8 of 13)") cannot mask a genuinely invented button.
    const INVENTED = ['VOTE', 'VOTE APPROVE', 'APPROVE', 'Vote', 'Approve'];
    for (const label of INVENTED) {
      expect(LABELS).not.toContain(label);
    }
  });

  test('the reference agenda and card stack were not invented', () => {
    // The platform holds no meeting record and no policy-review queue; the seat
    // workspace says so in as many words. An agenda drawn here would contradict
    // a claim the product makes one click away.
    const source = `${PAGE}${DIRECTORY}${SUMMARY}`;
    for (const invented of ['Call to Order', 'Approval of Minutes', 'Old Business', 'Policy Review']) {
      expect(source).not.toContain(invented);
    }
  });

});
