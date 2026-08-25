import { readFileSync } from 'node:fs';
import path from 'node:path';

import { readDesignSystemCss, DESIGN_SYSTEM_ENTRY } from './readDesignSystemCss';

/**
 * GOLDEN ERA 009 — THE CLINIC (Sports Medicine clearance board,
 * /coach/sports-medicine).
 *
 * This is the highest-stakes surface in the application. It carries
 * participation clearance and it is the only write surface in the product that
 * can place or lift a medical training hold on a child. Three contracts live
 * here, and the last two are the ones that matter.
 *
 * 1. THE TOKEN SCOPE. `.ge-clinic` redefines the brass ramp to aged bronze so
 *    every shared component this route renders — the panel keylines, `.btn`,
 *    `.btn--ghost`, `.t-eyebrow`, the input borders, the focus ring — resolves
 *    Golden Era metal together. A property override leaks wherever it is
 *    forgotten; a token override cannot. Same seam `.ge-bell`, `.ge-board` and
 *    the other seven scopes use. Beside it the scope declares its own steel,
 *    which is this room's material and no other room's.
 *
 * 2. THE SCOPE STAYS INSIDE ITSELF, AND OFF THE THINGS IT MAY NOT TOUCH. Six
 *    structural properties, each of which a plausible edit would break:
 *
 *      - every selector in the block starts at `.ge-clinic`, so no rule can
 *        reach another route;
 *      - every rule that names a `.t-*` voice also names the material it is
 *        standing on. That is not tidiness. A BARE voice rule here out-orders
 *        the legacy sheet's material restatements on source order and would
 *        repaint a voice on a ground it was never measured against;
 *      - no rule names `.stamp` or `.badge`. Every athlete row carries both:
 *        the training-hold stamp, the refusal stamp a bounced write leaves,
 *        and a `.badge` whose `--locked` variant is the reserved safeguarding
 *        red that means MEDICALLY_NOT_ALLOWED and nothing else. `.badge` is
 *        included because the BASE rule is how `badge--locked` composes its
 *        ground — restyling `.badge` reaches the reserved red without ever
 *        naming it;
 *      - no rule names `.room` or `.lamp`, and the block never names `--plate`.
 *        The plate carries the room. The wall, the light and the hung banker's
 *        shade are the photograph's, and a visual scope that starts relighting
 *        a room has left its own surface;
 *      - the block declares no `--bone-*`, `--hide-*`, `--paper`, `--plate` or
 *        reserved-red token. A bone rung is a platform-wide promise about
 *        contrast (cornerColor.test.ts reads the LAST declaration of a token as
 *        its value), and `--plate` is a locked room inventory with its own
 *        guard. Only the brass ramp and the scope-local `--ge-*` helpers move;
 *      - every steel rung puts blue above green. The approved handoff asks for
 *        "clinical neutral greys/whites (no mint tint)", and a green-leaning
 *        grey is the exact drift it names. Checked as arithmetic on the
 *        declared channels so the instruction is a property of the values
 *        rather than a note in a comment.
 *
 * 3. THE REAL CONTROL SET SURVIVES THE MOCKUP. The approved 009 reference
 *    (REFERENCE_APPROVED.jpg, HANDOFF.md "VISUAL_APPROVED (desktop) — Jason
 *    2026-08-25") draws a board headed "Golden Era CLINIC" carrying a
 *    "Readiness Checks" panel with three toggle switches labelled Body / Mind /
 *    Focus, an "Injury Notes" column of handwritten notes, a "Pain Honesty Log"
 *    with two more toggles, and a "Stamps" column of eight plaques reading
 *    CLEARED.
 *
 *    None of that exists behind /coach/sports-medicine. There is no toggle,
 *    switch or boolean control anywhere on the route; no readiness model and no
 *    body/mind/focus axis; and no injury note or pain log, because the owner
 *    decision recorded at the top of the page constrains this surface to
 *    clearance state and athlete-safe hold text ONLY — no diagnoses, no
 *    clinical notes, no restriction detail. Implementing the image literally
 *    would rename the surface and ship five controls with nothing behind them
 *    on the page that gates participation. So the MATERIALS are applied to the
 *    controls that are really there and the difference is reported to the owner
 *    as an information-architecture question with its own PR, its own API and
 *    its own tests.
 *
 *    The same image omits almost everything this route really does: the roster,
 *    the six clearance states, the "no record" and "unknown is not cleared"
 *    copy, the two hold scopes, the place-hold form with the sentence the
 *    athlete reads, the lift path and the refusal. Every one of those is real
 *    and every one stays. A visual pass is exactly when a real control goes
 *    quietly missing, so both halves are pinned below.
 *
 * MUTATION CHECK: set a `--brass-NNN` line in the `.ge-clinic` block to its
 * legacy value, drop its `-rgb` triple, disagree a triple with its hex, spell a
 * brass literal, drop the class from the page, let a rule escape the scope, add
 * a rule reaching `.room`, `.lamp`, `.stamp` or `.badge`, add a bare
 * `.ge-clinic .t-body` rule, tilt a steel rung green, delete a hold scope, or
 * invent a toggle — each turns this suite red.
 */

const BRASS_RUNGS = ['200', '300', '400', '500', '600', '700', '800', '900'] as const;

const css = readDesignSystemCss(DESIGN_SYSTEM_ENTRY);

/** The Golden Era sheet on its own, for assertions about THIS block's text. */
const THEME = readFileSync(
  path.resolve(__dirname, '../../../../design-system/current/ppbf-golden-era.css'),
  'utf8',
);

const PAGE = readFileSync(
  path.resolve(__dirname, '../../app/coach/sports-medicine/page.tsx'),
  'utf8',
);

/** The bare `.ge-clinic { … }` token rule, not its descendant rules. */
function scopeBody(source: string): string | null {
  const match = source.match(/^\.ge-clinic\s*\{([^}]*)\}/m);
  return match ? match[1] : null;
}

function legacyRung(source: string, rung: string): string | null {
  const withoutScope = source.replace(/^\.ge-clinic\s*\{[^}]*\}/m, '');
  const m = withoutScope.match(new RegExp(`--brass-${rung}\\s*:\\s*(#[0-9A-Fa-f]{3,8})`, 'i'));
  return m ? m[1].toLowerCase() : null;
}

/**
 * The 009 block's DECLARATIONS, comments removed.
 *
 * Comments come out FIRST, before the block is located, because the block's own
 * header names the reserved red and the classes it refuses to touch in order to
 * say it does not touch them, and because "GOLDEN ERA 009" itself sits inside
 * that header — slicing first would strand an unterminated comment.
 *
 * The block runs to the next top-level golden-era scope, or to the end of the
 * sheet when it is the last one. It is last today; the forward search is there
 * so appending a tenth scope after it silently narrows this block instead of
 * silently widening it into someone else's rules.
 */
function clinicBlock(): string {
  const declarations = THEME.replace(/\/\*[\s\S]*?\*\//g, '');
  const start = declarations.indexOf('.ge-clinic');
  expect(start).toBeGreaterThan(-1);
  const rest = declarations.slice(start + 1);
  const next = rest.search(/^\.ge-(?!clinic)[a-z]/m);
  return next === -1 ? declarations.slice(start) : declarations.slice(start, start + 1 + next);
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

/** Every rule in the 009 block as [selector, body], one entry per selector. */
function clinicRules(): Array<[string, string]> {
  // The media query's own brace is removed so the flat rule scan below reaches
  // the rules inside it; the orphaned closing brace is inert to the scan.
  const flat = clinicBlock().replace(/@media[^{]*\{/g, '');
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

describe('golden-era clinic scope', () => {
  test('the bronze ramp is on the .ge-clinic class scope, not :root', () => {
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

  test.each(BRASS_RUNGS)('brass rung %s ships its channel triple, and it agrees with the hex', (rung) => {
    // brassAlphaChannel.test.ts owns this rule sheet-wide. It is restated here
    // because the split it prevents is invisible on THIS surface specifically:
    // every input border, the tray keylines and the board's own bright bead are
    // painted `rgb(var(--brass-N-rgb) / a)`, so a rung that moved without its
    // triple would leave the clinic's chrome half bronze and half legacy gold.
    const body = scopeBody(css) as string;
    const hex = body.match(new RegExp(`--brass-${rung}\\s*:\\s*#([0-9A-Fa-f]{6})`, 'i'));
    const triple = body.match(new RegExp(`--brass-${rung}-rgb\\s*:\\s*(\\d+)\\s+(\\d+)\\s+(\\d+)\\s*;`));
    expect(hex).not.toBeNull();
    expect(triple).not.toBeNull();
    const raw = (hex as RegExpMatchArray)[1];
    const expected = [0, 2, 4].map((i) => parseInt(raw.slice(i, i + 2), 16));
    const declared = (triple as RegExpMatchArray).slice(1, 4).map(Number);
    expect(declared).toEqual(expected);
  });

  test('the clearance board route carries the scope class', () => {
    expect(PAGE).toMatch(/className="[^"]*\bge-clinic\b[^"]*"/);
  });

  test('the scope class is the only markup this pass added to the route', () => {
    // The class rides on the wrapper div that already existed inside
    // RoleStandaloneView's room element. A second wrapper would show up here.
    expect(PAGE).toContain('<div className="ge-clinic">');
    expect(PAGE).toContain('room="clinic"');
  });
});

describe('the 009 block stays inside its scope and off what it may not touch', () => {
  test('parses a real set of rules, so the checks below are not vacuous', () => {
    expect(clinicRules().length).toBeGreaterThan(10);
  });

  test('every selector in the block starts at .ge-clinic', () => {
    const escapees = clinicRules()
      .map(([selector]) => selector)
      .filter((selector) => !selector.startsWith('.ge-clinic'));
    expect(escapees).toEqual([]);
  });

  test('every rule that restates a voice names the material it stands on', () => {
    // A bare `.ge-clinic .t-*` rule out-orders the legacy sheet's material
    // restatements on source order and repaints a voice on a ground it was
    // never measured against. Naming a material keeps each restatement where
    // its contrast was actually computed.
    const bare = clinicRules()
      .map(([selector]) => selector)
      .filter((selector) => /\.t-[a-z]/.test(selector))
      .filter((selector) => !/\.mat-/.test(selector));
    expect(bare).toEqual([]);
  });

  test('no rule reaches a .stamp or a .badge', () => {
    // Safeguarding ink is not a visual pass's to restyle, and the status it
    // carries is not decorative. `.badge` is here with `.stamp` because
    // `badge--locked` composes its ground from the BASE rule: restyling
    // `.badge` reaches the reserved red without ever naming it.
    const offenders = clinicRules()
      .map(([selector]) => selector)
      .filter((selector) => /\.stamp|\.badge/.test(selector));
    expect(offenders).toEqual([]);
  });

  test('the block declares no token but the brass ramp and its own steel', () => {
    const declared = new Set<string>();
    for (const [, body] of clinicRules()) {
      for (const match of body.matchAll(/(--[a-z0-9-]+)\s*:/g)) declared.add(match[1]);
    }
    const foreign = [...declared].filter((token) => !token.startsWith('--brass-'));
    // Scope-local `--ge-*` helpers are fine — they resolve the ramp or this
    // room's own steel and paint nothing outside the scope. A platform
    // vocabulary token is not: a bone rung is a promise about contrast
    // everywhere, and a --plate URL is a locked room inventory with its own
    // guard.
    for (const token of foreign) {
      expect({ token, platform: /^--(bone|hide|wood|paper|plate|locked|stamp|corner|cleared|monitor|restricted)/.test(token) })
        .toEqual({ token, platform: false });
    }
  });

  test('the scoped block never uses reserved medical red', () => {
    const block = clinicBlock();
    expect(block).not.toMatch(/#A81E22/i);
    expect(block).not.toMatch(/--locked\b/);
    expect(block).not.toMatch(/--locked-ink\b/);
    expect(block).not.toMatch(/--stamp-red\b/);
  });

  test('the block never restates the room, its wall, its light or its fixture', () => {
    // The plate carries the room. Nothing here redraws .room--clinic's wall,
    // retunes .room::before, moves the --plate inventory, or touches the hung
    // banker's shade the clinic light comes from.
    const selectors = clinicRules().map(([selector]) => selector);
    expect(selectors.filter((selector) => /\.room/.test(selector))).toEqual([]);
    expect(selectors.filter((selector) => /\.lamp/.test(selector))).toEqual([]);
    expect(clinicBlock()).not.toContain('--plate');
  });

  test('the wrapper the scope class sits on is never positioned', () => {
    // `.lamp` is position:absolute and resolves against the nearest positioned
    // ancestor, which is `.room`. Positioning `.ge-clinic` itself would
    // re-anchor the room's hung lamp to the page column — moving a light
    // fixture, which this scope may not do. The board INSIDE it is positioned;
    // the wrapper is not.
    for (const [selector, body] of clinicRules()) {
      if (selector.trim() !== '.ge-clinic') continue;
      expect({ selector, positioned: /(^|;|\s)position\s*:/.test(body) })
        .toEqual({ selector, positioned: false });
    }
  });

  test('every steel rung is a neutral cool grey, never a mint one', () => {
    // The approved handoff asks for "clinical neutral greys/whites (no mint
    // tint)". Blue at or above green is what makes that a property of the
    // declared channels rather than a claim in a comment, and the spread cap is
    // what keeps "grey" from drifting into a tinted colour.
    const body = scopeBody(css) as string;
    const rungs = [...body.matchAll(/(--ge-steel-\d+)\s*:\s*#([0-9A-Fa-f]{6})/gi)];
    expect(rungs.length).toBeGreaterThan(2);
    for (const [, name, raw] of rungs) {
      const [r, g, b] = [0, 2, 4].map((i) => parseInt(raw.slice(i, i + 2), 16));
      expect({ name, coolNotMint: b >= g }).toEqual({ name, coolNotMint: true });
      expect({ name, neutral: Math.max(r, g, b) - Math.min(r, g, b) <= 20 })
        .toEqual({ name, neutral: true });
    }
  });
});

describe('the 009 mockup did not delete or invent clinic controls', () => {
  /** Every control the route really offers, in the words it offers them. */
  const REAL_CONTROLS = [
    'Place a training hold',
    'Place hold',
    'Cancel',
    'Lift this hold',
    'Progression Intelligence',
    'Performance Analytics',
  ] as const;

  /** Sections, states and copy the reference omits and that must not vanish. */
  const REAL_COPY = [
    'Sports Medicine',
    'Clearance Board',
    'No clearance record on file',
    'Unknown is not cleared',
    'Active Training Hold',
    'Lifts when:',
    'What this athlete reads (required)',
    'What lifts it — the path back',
    'Staff note (optional',
    'Lift note (optional)',
    'No athletes on your roster',
  ] as const;

  /** The six clearance states, each of which is a different fact. */
  const REAL_CLEARANCE_LABELS = [
    'cleared',
    'restricted',
    'not cleared',
    'pending',
    'no record',
    'unavailable',
  ] as const;

  test.each(REAL_CONTROLS)('the control %s is still offered', (label) => {
    expect(LABELS.some((found) => found.includes(label))).toBe(true);
  });

  test('the control count is unchanged', () => {
    // A count, not just a membership list: a label can be pinned above and a
    // seventh control still appear, or a duplicate mask a deletion.
    expect(LABELS).toHaveLength(REAL_CONTROLS.length);
  });

  test.each(REAL_COPY)('the copy %s is still rendered', (copy) => {
    expect(PAGE).toContain(copy);
  });

  test.each(REAL_CLEARANCE_LABELS)('the clearance state %s is still a distinct label', (label) => {
    expect(PAGE).toContain(`label: '${label}'`);
  });

  test('the two hold scopes the platform actually enforces are both still offered', () => {
    // And only those two. `conditioning_only` was withdrawn because nothing
    // enforced it and the server refuses it; a visual pass is not where it
    // comes back.
    expect(PAGE).toContain("value: 'all_training'");
    expect(PAGE).toContain("value: 'contact_only'");
    expect(PAGE).not.toContain("value: 'conditioning_only'");
  });

  test('the reserved red still marks not_cleared, and nothing else on the page', () => {
    // The one safety semantic this surface turns on. `not_cleared` means a
    // clinician looked at this child and said no, and it is the only state that
    // wears `badge--locked`. Every other action state sits one rung down on
    // --restricted, which is the correction this page already carries.
    expect(PAGE).toMatch(/not_cleared:\s*\{\s*className:\s*'badge badge--locked'/);
    expect(PAGE.match(/badge--locked/g) ?? []).toHaveLength(1);
  });

  test('both stamps on this route are still brass rather than red', () => {
    // A refused write is CANNOT_BE_DONE, and a training hold is non-punitive.
    // Neither may wear the colour that means a child may not participate.
    expect(PAGE).toContain('stamp stamp--brass stamp--flat stamp--kiosk');
    expect(PAGE).toContain('stamp stamp--brass stamp--flat');
    expect(PAGE).not.toContain('stamp stamp--red');
  });

  test('no control was invented from the reference image', () => {
    // The reference draws three engraved plaques reading Body / Mind / Focus
    // beside toggle switches. No readiness model exists behind this route.
    // Matched against control LABELS rather than raw source so that ordinary
    // words inside real copy cannot mask a genuinely invented button.
    for (const invented of ['Body', 'Mind', 'Focus', 'CLEARED', 'Cleared']) {
      expect(LABELS).not.toContain(invented);
    }
  });

  test('no toggle or switch was invented from the reference image', () => {
    // Five of them in the image, none on the route. A toggle here would imply a
    // coach can flip a clearance or a hold directly; holds are placed through a
    // form the server validates, and clearance is set by the office.
    expect(PAGE).not.toContain('type="checkbox"');
    expect(PAGE).not.toContain('role="switch"');
    expect(PAGE).not.toMatch(/\btoggle\b/i);
  });

  test('the reference panels this platform holds no records for were not invented', () => {
    // The owner decision at the top of the page constrains this surface to
    // clearance state and athlete-safe hold text ONLY — no diagnoses, no
    // clinical notes, no restriction detail. An injury-note or pain-log panel
    // here would not just be empty chrome, it would contradict the constraint
    // the surface exists to enforce.
    for (const invented of ['Readiness Checks', 'Injury Notes', 'Pain Honesty Log']) {
      expect(PAGE).not.toContain(invented);
    }
  });

  test('the surface was not renamed to the reference title', () => {
    // The reference heads the board "Golden Era CLINIC". This page is the
    // Clearance Board, and a stylesheet does not rename a surface.
    expect(PAGE).not.toContain('Golden Era CLINIC');
    expect(PAGE).toContain('Clearance Board');
  });
});
