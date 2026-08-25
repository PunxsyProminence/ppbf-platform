import { readFileSync } from 'node:fs';
import path from 'node:path';

import { readDesignSystemCss, DESIGN_SYSTEM_ENTRY } from './readDesignSystemCss';

/**
 * GOLDEN ERA 004A — SESSION SCRIPTS (the coach's clipboard).
 *
 * Two separate contracts live here, and the second is the one that matters.
 *
 * 1. THE TOKEN SCOPE. `.ge-scripts` redefines the brass ramp to aged bronze so
 *    the shared components on this route (.btn, .btn--ghost, .plaque, the brass
 *    keylines, the .t-command / .t-eyebrow voices) resolve Golden Era metal
 *    together. A property override leaks wherever it is forgotten; a token
 *    override cannot. Same seam `.ge-bell` and `.ge-floorboard` use.
 *
 * 2. THE REAL CONTROL SET SURVIVES THE MOCKUP. The locked 004A reference draws
 *    a rail of bronze buttons reading NEW SCRIPT / LOAD / ASSIGN DRILL / SAVE /
 *    PRINT FLOOR CARD, and a header row reading Date / Group-Floor / Focus of
 *    the day. NONE of those exist on this route: session scripts are authored
 *    upstream and this surface reads them, starts a live delivery and records
 *    what happened. Implementing the image literally would invent five controls
 *    with no server behind them.
 *
 *    The same image omits most of what the route really does -- the live
 *    delivery console (pause, previous, next, go-to-block, log an intervention,
 *    end session), the past-deliveries history, and the failed-read notices
 *    that are deliberately distinct from "empty". A visual pass is exactly when
 *    controls get quietly dropped to match a picture, so the real set is pinned
 *    here by label, and the invented labels are pinned as absent.
 *
 *    If the owner later decides this surface really should author, save or
 *    print scripts, that is a functional change with its own PR, its own API
 *    and its own tests -- not a side effect of restyling.
 *
 * MUTATION CHECK: set a `--brass-NNN` line in the `.ge-scripts` block to its
 * legacy value (e.g. `--brass-500: #B8912F`), or drop the class from the page,
 * or delete a control, and this suite goes red.
 */

const BRASS_RUNGS = ['200', '300', '400', '500', '600', '700', '800', '900'] as const;

const css = readDesignSystemCss(DESIGN_SYSTEM_ENTRY);

/** The Golden Era sheet on its own, for assertions about THIS block's text. */
const THEME = readFileSync(
  path.resolve(__dirname, '../../../../design-system/current/ppbf-golden-era.css'),
  'utf8',
);

const PAGE = readFileSync(
  path.resolve(__dirname, '../../app/coach/session-scripts/page.tsx'),
  'utf8',
);
const LIVE = readFileSync(
  path.resolve(__dirname, '../../components/SessionScriptLiveDelivery.tsx'),
  'utf8',
);

/** The bare `.ge-scripts { … }` token rule, not its descendant rules. */
function scopeBody(source: string): string | null {
  const match = source.match(/^\.ge-scripts\s*\{([^}]*)\}/m);
  return match ? match[1] : null;
}

function legacyRung(source: string, rung: string): string | null {
  const withoutScope = source.replace(/^\.ge-scripts\s*\{[^}]*\}/m, '');
  const m = withoutScope.match(new RegExp(`--brass-${rung}\\s*:\\s*(#[0-9A-Fa-f]{3,8})`, 'i'));
  return m ? m[1].toLowerCase() : null;
}

/**
 * Every `<button>` / `<Link>` label on a surface, whitespace-collapsed.
 *
 * Read from the JSX rather than from a rendered tree on purpose: a control
 * behind a state this test would have to fake -- a live run, a failed read, an
 * open settle form -- is exactly the kind that disappears unnoticed in a visual
 * pass, and it is still a real control. A conditional label such as
 * `{busy ? 'Starting...' : 'Start live delivery'}` arrives as one entry
 * carrying both, which is why the assertions match on containment.
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

const LABELS = [...controlLabels(PAGE), ...controlLabels(LIVE)];

describe('golden-era session scripts scope', () => {
  test('the bronze ramp is on the .ge-scripts class scope, not :root', () => {
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

  test('the session scripts route carries the scope class', () => {
    expect(PAGE).toMatch(/className="[^"]*\bge-scripts\b[^"]*"/);
  });

  /* The reserved medical/safeguarding red is not decorative chrome. The
     project-wide reservation has its own guard; this one only states that the
     004A block never reached for it while restyling a coaching surface. */
  test('the scoped block never uses reserved medical red', () => {
    /* Read from the theme file rather than from the resolved sheet: resolution
       inlines this file at its @import position, so slicing the resolved text
       would drag in everything the theme states after it. */
    /* Comments come out FIRST, before the block is located, because the
       block's own header NAMES the three reserved things in order to say it
       does not use them -- and because 'GOLDEN ERA 004A' itself sits inside
       that header, so slicing first would strand an unterminated comment. A
       guard that cannot tell a declaration from a prohibition would forbid
       writing the prohibition down. */
    const declarations = THEME.replace(/\/\*[\s\S]*?\*\//g, '');
    const start = declarations.indexOf('.ge-scripts');
    expect(start).toBeGreaterThan(-1);
    const block = declarations.slice(start);
    expect(block).not.toMatch(/#A81E22/i);
    expect(block).not.toMatch(/--locked\b/);
    expect(block).not.toMatch(/--stamp-red\b/);
  });
});

describe('the 004A mockup did not delete or invent session-script controls', () => {
  /** Every control this route really has, across the page and the live console. */
  const REAL_CONTROLS = [
    // The page itself.
    'Back to drill library',
    'Open plan',
    'Showing plan',
    'Start live delivery',
    'Starting...',
    // The live delivery console the reference does not draw at all.
    'Pause session',
    'Resume session',
    'Previous block',
    'Next block',
    'Go to this block',
    'Retry loading the plan',
    'Log an intervention...',
    'Log intervention',
    'Done logging',
    'End session...',
    'Record as completed',
    'Record as abandoned',
    'Keep delivering',
  ] as const;

  /** Sections the reference omits and that must not be styled away with it. */
  const REAL_SECTIONS = ['Scripts', 'The plan', 'Past deliveries', 'Current block'] as const;

  test.each(REAL_CONTROLS)('the real control %s still exists', (label) => {
    expect(LABELS.some((rendered) => rendered.includes(label))).toBe(true);
  });

  test.each(REAL_SECTIONS)('the section %s is still rendered', (heading) => {
    expect(`${PAGE}${LIVE}`).toContain(heading);
  });

  test('no control was invented from the reference image', () => {
    // Drawn on the reference's button rail, backed by nothing on this route.
    // Matched against control LABELS rather than raw source, so the ordinary
    // words "load" and "save" inside real copy ("Loading...", "could not be
    // loaded") cannot mask a genuinely invented button.
    const INVENTED = ['New Script', 'Load', 'Assign Drill', 'Save', 'Print Floor Card'];
    for (const label of INVENTED) {
      expect(LABELS).not.toContain(label);
    }
  });

  test('the reference header fields were not invented', () => {
    // The image heads the sheet with Date / Group-Floor / Focus of the day.
    // None is a field this route holds, and a date on a script would contradict
    // the page's own rule that a script is minutes-from-start, never a clock.
    for (const field of ['Group/Floor', 'Focus of the day']) {
      expect(`${PAGE}${LIVE}`).not.toContain(field);
    }
  });

  test('the control count is unchanged', () => {
    // A count, not just a membership list: a label can be pinned above and a
    // second control carrying the same words still be deleted underneath it.
    expect(controlLabels(PAGE)).toHaveLength(3);
    expect(controlLabels(LIVE)).toHaveLength(12);
  });
});
