import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import { readDesignSystemCss, DESIGN_SYSTEM_ENTRY } from './readDesignSystemCss';

/**
 * THE SAFEGUARDING RED MAY NOT BE SPENT ON FAILURE AND EMPTINESS.
 *
 * Owner decision, 2026-08-19: `--locked` (#A81E22) is reserved for
 * MEDICALLY_NOT_ALLOWED — the top of the safety ladder, a person who may not
 * participate. The 2026-08-24 inventory (RED-TOKEN-INVENTORY) found ~231
 * sites wearing that red for load errors, empty states and "not on file"
 * placeholders, reached through FOUR channels: the direct tokens, the alias
 * tokens in app/globals.css, the `.alert--critical` class, and the bare
 * `.stamp` class. Every one of those teaches a coach's eye that the gate's
 * red is furniture, which is the training effect the reservation exists to
 * prevent. Owner approved this guard 2026-08-24 ("go option 2").
 *
 * THE RULE IS INTENT-MATCHED, NOT COUNT-BASED. #576 already rejected a
 * numeric ceiling: a legitimate new use of the red would train people to bump
 * the number, and the number says nothing about which use is wrong. Instead:
 *
 *   No element that reaches #A81E22 through ANY derived channel may sit
 *   within ±5 lines of a failure/emptiness identifier, unless an ALLOW_LIST
 *   entry below names the site and carries a reason.
 *
 * THE CHANNELS ARE DERIVED, NOT HARDCODED. The only constant here is the
 * seed colour, #A81E22 (and its rgb spelling 168,30,34). Everything else is
 * read out of the sheets the app actually loads — design-system/ppbf.css
 * resolved through its @imports (so the guard follows a theme swap), plus
 * app/globals.css for the app-side aliases:
 *
 *   - tokens whose document-wide :root definition is the seed colour, or
 *     resolves to it through var() chains (fixpoint, so any depth);
 *   - each derived rung's `-ink` / `-deep` pair, the pairing the ladder
 *     ships by contract (safetySemanticsSurviveTheThemeSwap.test.ts) —
 *     `--locked-ink` is a tint of the same reservation, not a new colour;
 *   - classes whose rule references a derived token or the seed, where the
 *     selector's subject is a single bare class (`.alert--critical`,
 *     `.stamp`). Classes whose NAME already contains a derived token
 *     (`badge--locked`) are left to the token match, so one line is not
 *     reported twice.
 *
 * THE WINDOW: same file, the 11 lines centred on the line carrying the red
 * channel (±5), measured on comment-stripped source. Comments are stripped by
 * a character state machine (code / line comment / block comment / string /
 * template / regex literal) that REPLACES comment characters with spaces, so
 * line numbers survive and a `//` inside a URL string literal is NOT eaten —
 * the exact bug that discredited an earlier count. JSX `{slash-star ...}`
 * needs no special case: the inner block comment is stripped and the residual
 * braces are inert. Strings are kept intact; class-channel matches must sit
 * INSIDE a string literal (a className), so prose about a "stamp" does not
 * count; token matches count anywhere in live code, which is the inventory's
 * own convention.
 *
 * THE ALLOW-LIST FREEZES THE DEFECT POPULATION IN BOTH DIRECTIONS. Every
 * entry is (file, channel, identifier, sites). A NEW site — a new key, or a
 * count above the entry's — fails naming the file, the channel and the
 * matched identifier. A site that was swept while its entry survived fails
 * as a STALE ENTRY, so sweeps must shrink the list and the list can never
 * rot. Entries marked LEGITIMATE are top-of-safety-ladder uses the proximity
 * heuristic happens to catch; everything else is an existing defect awaiting
 * the owner-approved sweep.
 *
 * WHAT THIS GUARD CANNOT CATCH — stated so nobody mistakes it for more:
 *
 *   1. Red applied without a channel: an inline style or a raw `#A81E22` /
 *      `rgba(168,30,34,…)` literal in TSX never says a token or class name.
 *      STILL TRUE OF THE PROXIMITY SCAN, no longer true of this file: the
 *      SEED LITERAL CHANNEL added 2026-08-25 (below the allow-list) catches
 *      the literal on its own, at zero tolerance, across app/, components/
 *      AND src/. It is a SEPARATE channel on purpose — a literal that shares
 *      a line with an allow-listed token would otherwise survive the sweep
 *      that deletes the entry, which is exactly what nearly happened to
 *      app/auth/link/page.tsx. The long note down there tells that story.
 *   2. Computed class names: `'badge--' + tone` never spells `badge--locked`
 *      in the source text.
 *   3. Proximity misses: an identifier six lines away, or in the parent that
 *      passes `message={loadError}` into a component that paints the red.
 *   4. CSS-only compositions: compound-selector rules (`.leather-tag
 *      .is-active`) and pseudo-state rules (`:hover`) are not derived as
 *      class channels — the subject extraction takes only simple class
 *      subjects. The :focus pin below covers focus rings specifically.
 *      (`.btn--danger` IS derived — its base rule paints a gradient through
 *      the seed hex, which a token grep never sees — but whether that use is
 *      legal at all is an unresolved owner decision this guard does not
 *      adjudicate: it has no proximity site today, and a future one needs an
 *      allow-list entry with a reason, not a ruling from a test.)
 *   5. The freeze is per (file, channel, identifier) count: removing one
 *      defect while adding another under the same key holds the count level.
 *   6. A stamp recolorer (`stamp--brass`, `stamp--green`) suppresses a bare
 *      `.stamp` match only on the SAME line; a wrapped className that puts
 *      the modifier on the next line reads as bare and would over-report.
 *
 * WATCHED TO FAIL, 2026-08-24, before first landing: (a) a fabricated
 * `alert--critical` beside a `loadError` in a clean component — failed
 * naming file, channel and identifier; (b) an allow-list entry deleted while
 * its sites remained — failed as un-allow-listed; (c) a real allow-listed
 * site switched to `alert--warning` with its entry kept — failed as a stale
 * entry; (d) `--stamp-restricted` pointed back at `var(--locked)` — the pin
 * below failed. A guard that has not been seen red is a hypothesis.
 *
 * ---------------------------------------------------------------------------
 * A FIFTH CHANNEL, ADDED 2026-08-25: THE COLOUR SPELLED OUT.
 *
 * Everything above derives its channels from TOKENS and CLASSES, and that is
 * the whole of its reach. A rule that writes the colour out --
 * `rgba(168,30,34,.34)` -- names no token and no class: no scope can override
 * it, and nothing above can see it. `.pap--ruled` painted a decorative
 * legal-pad margin line in exactly that literal, which is the reservation
 * spent on chrome, on every ruled sheet of paper in the app, invisible to the
 * one guard whose entire subject is that reservation. It is the same defect
 * class the brass ramp hit (#641, brassAlphaChannel.test.ts): a leak-proof
 * argument that only ever reaches rules going THROUGH a token.
 *
 * So the sheets are now read for the seed itself, in both spellings, and an
 * occurrence is legitimate ONLY where it DEFINES the reservation -- a
 * document-wide `:root` token that the derivation above already counts as a
 * red channel. Three declarations qualify today (`--locked`, `--locked-deep`,
 * `--stamp-red`) and the test names them, so a fourth place to write #A81E22
 * down has to be argued for rather than added. A rule-scoped custom property
 * (`.foo { --badge: #A81E22 }`) does NOT qualify: `rootDeclarations` treats
 * those as parameters rather than tokens on purpose, so the token channel
 * never sees them, so they must fail here.
 *
 * THE TWO FIXES FOR A HIT ARE NOT INTERCHANGEABLE. Chrome must STOP USING THE
 * RED -- `.pap--ruled` took the ink this sheet already uses for its
 * non-semantic rules (`rgba(70,110,150,...)`, the ink of its own horizontal
 * ruling), because converting decoration to `var(--locked)` would keep the
 * colour and only hide it from this file. A rule that is genuinely about the
 * reservation goes through the token instead, unchanged in colour:
 * `.btn--danger` and `.gauge-arc` were converted that way on 2026-08-25, the
 * second through `color-mix(in srgb, var(--stamp-red) 85%, transparent)`
 * because CSS cannot put an alpha on a hex token. Whether an ordinary
 * destructive button may wear the reservation at all is still the owner
 * question honesty item 4 above declines to answer; putting it on the token
 * changes nothing about the colour and makes the answer one line.
 *
 * THIS CLOSES THE CSS HALF OF HONESTY ITEM 1 AND NONE OF THE TSX HALF. A raw
 * literal in a `.tsx` file is still uncovered, and app/auth/link/page.tsx
 * carries one today (`bg-[rgba(168,30,34,0.06)]` on a sign-in refusal) --
 * reported, not swept, because it belongs to the owner-approved sweep this
 * file's allow-list freezes.
 *
 * WATCHED TO FAIL, 2026-08-25: (a) `rgba(168,30,34,.34)` put back into
 * `.pap--ruled` -- failed, naming the sheet, the selector and the
 * declaration; (b) the same literal written into a rule-scoped custom
 * property -- failed, because a scoped property is not a token; (c)
 * `.btn--danger` left on `var(--stamp-red)` -- PASSED, so the check does not
 * fire on the right answer. A guard that has not been seen red is a
 * hypothesis.
 */

const WEB = path.resolve(__dirname, '../..');
const GLOBALS_CSS = path.join(WEB, 'app', 'globals.css');
const SCANNED = [path.join(WEB, 'app'), path.join(WEB, 'components')];

/** The seed. The ONLY hardcoded fact about the reservation's colour. If a
 *  theme swap moves the reservation to a new value, the derivation sanity
 *  test below goes red and this constant is the one line to update. */
const SEED = '#a81e22';
const SEED_HEX = /#a81e22\b/i;
const SEED_RGB = /rgba?\(\s*168\s*,\s*30\s*,\s*34\b/;

const PROXIMITY = 5;

/** NUL cannot appear in a path, a token, a class or a probe name, so keys
 *  built with it can never be spoofed by a crafted file name. */
const KEY_SEPARATOR = '\u0000';

/* ------------------------------------------------------------------ CSS -- */

function stripCssComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, ' ');
}

const designCss = stripCssComments(readDesignSystemCss(DESIGN_SYSTEM_ENTRY));
const globalsCss = stripCssComments(readFileSync(GLOBALS_CSS, 'utf8'));

/**
 * Declarations in UNQUALIFIED, depth-0 `:root` blocks — the document-wide
 * token definitions. Adapted from safetySemanticsSurviveTheThemeSwap.test.ts,
 * and for the same reason: `@media print` re-declares rungs inside its own
 * `:root`, and a rule-scoped custom property (`.badge--locked { --badge:
 * var(--locked) }`) is a parameter, not a token. Counting either as a token
 * would make `--badge` — and with it every `.badge` — a red channel, and the
 * guard would drown in its own false positives.
 */
function rootDeclarations(stripped: string): string {
  const blocks: string[] = [];
  let depth = 0;
  let index = 0;

  while (index < stripped.length) {
    const character = stripped[index];

    if (character === '{') {
      depth += 1;
      index += 1;
      continue;
    }
    if (character === '}') {
      depth -= 1;
      index += 1;
      continue;
    }

    if (depth === 0 && stripped.startsWith(':root', index)) {
      const open = stripped.indexOf('{', index);
      if (open !== -1 && !stripped.slice(index, open).includes('}')) {
        let cursor = open + 1;
        let inner = 1;
        while (cursor < stripped.length && inner > 0) {
          if (stripped[cursor] === '{') inner += 1;
          if (stripped[cursor] === '}') inner -= 1;
          cursor += 1;
        }
        blocks.push(stripped.slice(open + 1, cursor - 1));
        index = cursor;
        continue;
      }
    }

    index += 1;
  }

  return blocks.join('\n');
}

const DESIGN_ROOT = rootDeclarations(designCss);
const GLOBALS_ROOT = rootDeclarations(globalsCss);

/** name -> every document-wide definition, design system first then the app
 *  sheet, in source order — the same order the browser cascades them. */
function collectTokenDefinitions(): Map<string, string[]> {
  const definitions = new Map<string, string[]>();
  for (const scope of [DESIGN_ROOT, GLOBALS_ROOT]) {
    for (const match of scope.matchAll(/(--[A-Za-z0-9-]+)\s*:\s*([^;]+)/g)) {
      const values = definitions.get(match[1]) ?? [];
      values.push(match[2].trim());
      definitions.set(match[1], values);
    }
  }
  return definitions;
}

const TOKEN_DEFINITIONS = collectTokenDefinitions();

function valueCarriesSeed(value: string): boolean {
  return SEED_HEX.test(value) || SEED_RGB.test(value);
}

function varReferences(value: string): string[] {
  return [...value.matchAll(/var\(\s*(--[A-Za-z0-9-]+)/g)].map((m) => m[1]);
}

/** Tokens that reach the seed colour: seeded by value, closed under var()
 *  chains to a fixpoint, then joined by their -ink / -deep ladder pairs. */
function deriveRedTokens(): Set<string> {
  const red = new Set<string>();

  for (const [name, values] of TOKEN_DEFINITIONS) {
    if (values.some(valueCarriesSeed)) red.add(name);
  }

  let grew = true;
  while (grew) {
    grew = false;
    for (const [name, values] of TOKEN_DEFINITIONS) {
      if (red.has(name)) continue;
      if (values.some((value) => varReferences(value).some((ref) => red.has(ref)))) {
        red.add(name);
        grew = true;
      }
    }
  }

  for (const name of [...red]) {
    for (const suffix of ['-ink', '-deep']) {
      if (TOKEN_DEFINITIONS.has(`${name}${suffix}`)) red.add(`${name}${suffix}`);
    }
  }

  return red;
}

const RED_TOKENS = deriveRedTokens();

/** The final colour a token resolves to, following last-definition-wins var()
 *  chains, as a lowercase hex — or null when it never lands on a hex. */
function resolveTokenHex(name: string, hops = 8): string | null {
  const values = TOKEN_DEFINITIONS.get(name);
  if (!values || hops === 0) return null;
  const value = values[values.length - 1];
  const reference = varReferences(value)[0];
  if (reference) return resolveTokenHex(reference, hops - 1);
  const hex = value.match(/#[0-9A-Fa-f]{6}\b/);
  return hex ? hex[0].toLowerCase() : null;
}

interface CssRule {
  selector: string;
  body: string;
}

/** Flat rule list. At-rule preludes never form a match (their "body" would
 *  contain braces), so `@media print { .x { … } }` yields the inner rule. */
function cssRules(stripped: string): CssRule[] {
  return [...stripped.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
    selector: m[1].trim(),
    body: m[2],
  }));
}

function ruleReachesRed(body: string): boolean {
  if (valueCarriesSeed(body)) return true;
  return varReferences(body).some((ref) => RED_TOKENS.has(ref));
}

/** The selector's subject — the compound the rule actually paints. */
function subjectOf(selector: string): string {
  const parts = selector.split(/[\s>+~]+/).filter(Boolean);
  return parts[parts.length - 1] ?? '';
}

/** Classes whose rule reaches the red and whose subject is one bare class.
 *  Names that already contain a red token's text are left to the token
 *  match. Compound and pseudo-class subjects are NOT derived — honesty
 *  item 4 above. */
function deriveRedClasses(): Set<string> {
  const classes = new Set<string>();
  for (const rule of [...cssRules(designCss), ...cssRules(globalsCss)]) {
    if (!ruleReachesRed(rule.body)) continue;
    for (const selector of rule.selector.split(',')) {
      const subject = subjectOf(selector.trim());
      const single = subject.match(/^\.([A-Za-z0-9_-]+)$/);
      if (!single) continue;
      const name = single[1];
      if ([...RED_TOKENS].some((token) => name.includes(token))) continue;
      classes.add(name);
    }
  }
  return classes;
}

const RED_CLASSES = deriveRedClasses();

/** `.stamp--X` modifiers that re-declare `color` away from the red: on the
 *  same line as `stamp`, they mean the mark is NOT #A81E22. */
function deriveStampRecolorers(): Set<string> {
  const recolorers = new Set<string>();
  for (const rule of [...cssRules(designCss), ...cssRules(globalsCss)]) {
    const subject = subjectOf(rule.selector.split(',')[0] ?? '');
    const modifier = subject.match(/^\.(stamp--[A-Za-z0-9-]+)$/);
    if (!modifier) continue;
    if (/(?:^|;|\s)color\s*:/.test(rule.body) && !ruleReachesRed(rule.body)) {
      recolorers.add(modifier[1]);
    }
  }
  return recolorers;
}

const STAMP_RECOLORERS = deriveStampRecolorers();

/* ------------------------------------------------------ LITERAL CHANNEL -- */

/** Every occurrence of the seed, in either spelling, anywhere in a sheet.
 *  Assembled from the two SEED patterns above rather than written out again,
 *  so the colour is still stated exactly ONCE in this file: a literal guard
 *  that hardcodes its own second copy of the literal is the joke that writes
 *  itself. */
const SEED_LITERAL = new RegExp(`${SEED_HEX.source}|${SEED_RGB.source}`, 'gi');

interface LiteralSite {
  /** Which sheet, spelled the way a reader would go and open it. */
  sheet: string;
  /** The rule that spends it, for the failure message. */
  selector: string;
  /** The declaration up to and including the literal, whitespace collapsed. */
  declaration: string;
  /** The custom property being declared, when the literal IS a declaration. */
  property: string | null;
}

/** The declaration an offset sits inside: back to the nearest `;`, `{` or
 *  `}`. CSS values carry no semicolons, so the boundary is exact. */
function declarationAt(css: string, index: number): string {
  const start = Math.max(
    css.lastIndexOf(';', index),
    css.lastIndexOf('{', index),
    css.lastIndexOf('}', index),
  );
  return css.slice(start + 1, index);
}

/** The selector of the rule an offset sits inside.
 *
 *  A LINE NUMBER IS DELIBERATELY NOT REPORTED. The design sheet this guard
 *  reads is ppbf.css resolved through its @imports, so its line numbers
 *  belong to a concatenation that exists in no file on disk and would send a
 *  reader to the wrong place in the wrong sheet. The selector and the
 *  declaration text are both greppable; a fabricated line number is not. */
function selectorAt(css: string, index: number): string {
  const brace = css.lastIndexOf('{', index);
  if (brace <= 0) return '(outside any rule)';
  const start = Math.max(
    css.lastIndexOf('}', brace),
    css.lastIndexOf('{', brace - 1),
    css.lastIndexOf(';', brace),
  );
  return css.slice(start + 1, brace).trim().replace(/\s+/g, ' ') || '(unnamed rule)';
}

function seedLiterals(css: string, sheet: string): LiteralSite[] {
  const sites: LiteralSite[] = [];
  for (const match of css.matchAll(SEED_LITERAL)) {
    const index = match.index ?? 0;
    const declaration = declarationAt(css, index);
    const property = declaration.match(/^\s*(--[A-Za-z0-9-]+)\s*:/);
    sites.push({
      sheet,
      selector: selectorAt(css, index),
      declaration: `${declaration}${match[0]}`.replace(/\s+/g, ' ').trim(),
      property: property ? property[1] : null,
    });
  }
  return sites;
}

const LITERAL_SITES = [
  ...seedLiterals(designCss, 'design-system/ppbf.css (resolved through its @imports)'),
  ...seedLiterals(globalsCss, 'apps/web/app/globals.css'),
];

/** A literal is legitimate ONLY where it DEFINES the reservation: a
 *  document-wide token this file already derives as a red channel. Deriving
 *  the exemption from RED_TOKENS rather than from a list of names means the
 *  exemption can never be wider than the channel the rest of the guard
 *  already polices — and a rule-scoped custom property (`.foo { --badge:
 *  #A81E22 }`) is excluded for free, because `rootDeclarations` treats those
 *  as parameters rather than tokens and they never enter RED_TOKENS. */
function definesTheReservation(site: LiteralSite): boolean {
  return site.property !== null && RED_TOKENS.has(site.property);
}

/* ------------------------------------------------------- SOURCE SCANNING -- */

/** Characters that make a following `/` open a regex literal rather than a
 *  division — the standard previous-significant-character heuristic. */
const REGEX_PRECEDERS = /[(,=:[!&|?{};+\-*%~^<>]/;

/**
 * Comment characters become spaces — never deleted — so every surviving
 * character keeps its line and column. Returns the stripped code and a mask
 * marking which characters sit inside a string literal.
 *
 * `'…'` and `"…"` terminate at a newline: valid JS forbids a raw newline in
 * them, and this bounds the blast radius of a stray apostrophe in JSX text
 * (don't, athlete's) to one line instead of the rest of the file. Template
 * literals span lines; their `${…}` interpolations are treated as string,
 * which only matters for comments inside an interpolation — kept, harmless.
 */
function stripTsComments(source: string): { code: string; stringMask: Uint8Array } {
  const out = source.split('');
  const mask = new Uint8Array(source.length);
  type State = 'code' | 'line' | 'block' | 'single' | 'double' | 'template' | 'regex';
  let state: State = 'code';
  let previousSignificant = '(';
  let inCharClass = false;

  for (let i = 0; i < source.length; i += 1) {
    const c = source[i];
    const n = source[i + 1];

    switch (state) {
      case 'code':
        if (c === '/' && n === '/') {
          out[i] = ' ';
          state = 'line';
        } else if (c === '/' && n === '*') {
          out[i] = ' ';
          state = 'block';
        } else if (c === "'") {
          mask[i] = 1;
          state = 'single';
        } else if (c === '"') {
          mask[i] = 1;
          state = 'double';
        } else if (c === '`') {
          mask[i] = 1;
          state = 'template';
        } else if (c === '/' && REGEX_PRECEDERS.test(previousSignificant)) {
          state = 'regex';
          inCharClass = false;
        }
        if (state === 'code' && !/\s/.test(c)) previousSignificant = c;
        break;

      case 'line':
        if (c === '\n') state = 'code';
        else out[i] = ' ';
        break;

      case 'block':
        if (c === '*' && n === '/') {
          out[i] = ' ';
          out[i + 1] = ' ';
          i += 1;
          state = 'code';
        } else if (c !== '\n') {
          out[i] = ' ';
        }
        break;

      case 'single':
      case 'double': {
        const closer = state === 'single' ? "'" : '"';
        if (c === '\n') {
          state = 'code';
        } else if (c === '\\') {
          mask[i] = 1;
          if (n !== undefined && n !== '\n') {
            mask[i + 1] = 1;
            i += 1;
          }
        } else {
          mask[i] = 1;
          if (c === closer) state = 'code';
        }
        break;
      }

      case 'template':
        if (c === '\\') {
          mask[i] = 1;
          if (n !== undefined) {
            mask[i + 1] = 1;
            i += 1;
          }
        } else {
          mask[i] = 1;
          if (c === '`') state = 'code';
        }
        break;

      case 'regex':
        if (c === '\n') {
          state = 'code';
        } else if (c === '\\') {
          i += 1;
        } else if (c === '[') {
          inCharClass = true;
        } else if (c === ']') {
          inCharClass = false;
        } else if (c === '/' && !inCharClass) {
          state = 'code';
          previousSignificant = c;
        }
        break;
    }
  }

  return { code: out.join(''), stringMask: mask };
}

function walk(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next') continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      found.push(...walk(full));
    } else if (/\.tsx?$/.test(full) && !/\.test\.tsx?$/.test(full) && !full.endsWith('.d.ts')) {
      found.push(full);
    }
  }
  return found.sort();
}

/** .ts is scanned alongside .tsx on purpose: components/uiStyles.ts and
 *  sessionBarControls.ts build className strings that .tsx files wear, and
 *  the alias channel's only live call sites are in a .ts file — a .tsx-only
 *  walk would derive that channel and then never see it used. */
const FILES = SCANNED.flatMap(walk);

/** Failure/emptiness vocabulary, tuned against the inventory's bucket-B
 *  listing so the guard fires on the defect population that exists today.
 *  First match wins per red line, so each site carries one identifier. */
const IDENTIFIER_PROBES: ReadonlyArray<{ name: string; probe: RegExp }> = [
  { name: 'error', probe: /error/i },
  { name: 'fail', probe: /fail/i },
  { name: 'reject', probe: /\breject(?:ed|ion|s)?\b/i },
  { name: 'overdue', probe: /\boverdue\b/i },
  { name: 'inactive', probe: /\binactive\b/i },
  { name: 'unavailable', probe: /\bunavailable\b/i },
  { name: 'incomplete', probe: /\bincomplete\b/i },
  { name: 'missing', probe: /\bmiss(?:ed|ing)\b/i },
  { name: 'not-on-file', probe: /\bnot on file\b/i },
  { name: 'not-recorded', probe: /\bnot recorded\b/i },
  { name: 'could-not', probe: /\bcould not\b/i },
  { name: 'unable-to', probe: /\bunable to\b/i },
];

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

interface Finding {
  sites: number;
}

/** key: file, channel, identifier joined by KEY_SEPARATOR -> red line count. */
function scan(): Map<string, Finding> {
  const findings = new Map<string, Finding>();

  const channels: Array<{ label: string; pattern: RegExp; insideStringOnly: boolean; stamp: boolean }> = [
    ...[...RED_TOKENS].sort().map((token) => ({
      label: token,
      pattern: new RegExp(`${escapeRegExp(token)}(?![A-Za-z0-9-])`, 'g'),
      insideStringOnly: false,
      stamp: false,
    })),
    ...[...RED_CLASSES].sort().map((name) => ({
      label: `.${name}`,
      pattern: new RegExp(`(?<![A-Za-z0-9_-])${escapeRegExp(name)}(?![A-Za-z0-9_-])`, 'g'),
      insideStringOnly: true,
      stamp: name === 'stamp',
    })),
  ];

  const recolorerPatterns = [...STAMP_RECOLORERS].map(
    (name) => new RegExp(`(?<![A-Za-z0-9_-])${escapeRegExp(name)}(?![A-Za-z0-9_-])`),
  );

  for (const file of FILES) {
    const { code, stringMask } = stripTsComments(readFileSync(file, 'utf8'));
    const lines = code.split('\n');
    const lineStarts: number[] = [];
    let offset = 0;
    for (const line of lines) {
      lineStarts.push(offset);
      offset += line.length + 1;
    }
    const relative = path.relative(WEB, file).split(path.sep).join('/');

    for (const channel of channels) {
      const matchedLines = new Set<number>();
      channel.pattern.lastIndex = 0;
      for (const match of code.matchAll(channel.pattern)) {
        const at = match.index ?? 0;
        if (channel.insideStringOnly && stringMask[at] !== 1) continue;
        let line = lineStarts.findIndex((start) => start > at);
        line = (line === -1 ? lines.length : line) - 1;
        if (channel.stamp && recolorerPatterns.some((p) => p.test(lines[line]))) continue;
        matchedLines.add(line);
      }

      for (const line of matchedLines) {
        const window = lines
          .slice(Math.max(0, line - PROXIMITY), line + PROXIMITY + 1)
          .join('\n');
        const hit = IDENTIFIER_PROBES.find(({ probe }) => probe.test(window));
        if (!hit) continue;
        const key = [relative, channel.label, hit.name].join(KEY_SEPARATOR);
        const finding = findings.get(key) ?? { sites: 0 };
        finding.sites += 1;
        findings.set(key, finding);
      }
    }
  }

  return findings;
}

const FINDINGS = scan();

/* ----------------------------------------------------------- ALLOW-LIST -- */

/** Existing defect, frozen: owner-approved sweep pending — see
 *  RED-TOKEN-INVENTORY. Sweeping a site MUST shrink or delete its entry. */
const DEFECT = 'existing defect, owner-approved sweep pending — see RED-TOKEN-INVENTORY';

/** The proximity heuristic caught a genuine top-of-ladder use. These are the
 *  reservation working as intended, not debt. */
const LEGITIMATE = 'LEGITIMATE — top of safety ladder';

interface AllowListEntry {
  file: string;
  channel: string;
  identifier: string;
  sites: number;
  reason: string;
}

const ALLOW_LIST: readonly AllowListEntry[] = [
  { file: 'app/activate/page.tsx', channel: '--locked', identifier: 'error', sites: 1, reason: DEFECT },
  { file: 'app/admin/activation-codes/page.tsx', channel: '--locked-ink', identifier: 'error', sites: 2, reason: DEFECT },
  { file: 'app/admin/athletes/page.tsx', channel: '--locked', identifier: 'inactive', sites: 1, reason: DEFECT },
  { file: 'app/admin/athletes/page.tsx', channel: '--locked-ink', identifier: 'could-not', sites: 1, reason: DEFECT },
  { file: 'app/admin/athletes/page.tsx', channel: '.alert--critical', identifier: 'error', sites: 1, reason: DEFECT },
  { file: 'app/admin/attendance/page.tsx', channel: '.alert--critical', identifier: 'error', sites: 1, reason: DEFECT },
  { file: 'app/admin/board-seats/page.tsx', channel: '.alert--critical', identifier: 'error', sites: 1, reason: DEFECT },
  { file: 'app/admin/coach-coverage/page.tsx', channel: '.alert--critical', identifier: 'error', sites: 2, reason: DEFECT },
  { file: 'app/admin/coach-coverage/page.tsx', channel: '.alert--critical', identifier: 'unavailable', sites: 1, reason: DEFECT },
  { file: 'app/admin/community-service/page.tsx', channel: '.alert--critical', identifier: 'error', sites: 1, reason: DEFECT },
  { file: 'app/admin/consent/page.tsx', channel: '--locked', identifier: 'error', sites: 1, reason: DEFECT },
  { file: 'app/admin/consent/page.tsx', channel: '.alert--critical', identifier: 'error', sites: 2, reason: DEFECT },
  { file: 'app/admin/credentials/page.tsx', channel: '.alert--critical', identifier: 'error', sites: 1, reason: DEFECT },
  { file: 'app/admin/customize/page.tsx', channel: '--locked', identifier: 'error', sites: 1, reason: DEFECT },
  { file: 'app/admin/data-quality/page.tsx', channel: '.alert--critical', identifier: 'error', sites: 1, reason: DEFECT },
  { file: 'app/admin/export/page.tsx', channel: '--locked-ink', identifier: 'error', sites: 1, reason: DEFECT },
  { file: 'app/admin/grants/page.tsx', channel: '--locked', identifier: 'overdue', sites: 1, reason: DEFECT },
  { file: 'app/admin/grants/page.tsx', channel: '.alert--critical', identifier: 'error', sites: 1, reason: DEFECT },
  { file: 'app/admin/memberships/page.tsx', channel: '.alert--critical', identifier: 'error', sites: 1, reason: DEFECT },
  { file: 'app/admin/organizations/page.tsx', channel: '--locked-ink', identifier: 'error', sites: 1, reason: DEFECT },
  { file: 'app/admin/organizations/test/page.tsx', channel: '--locked-ink', identifier: 'error', sites: 1, reason: DEFECT },
  { file: 'app/admin/page.tsx', channel: '--locked-ink', identifier: 'error', sites: 1, reason: DEFECT },
  { file: 'app/admin/payments/page.tsx', channel: '.alert--critical', identifier: 'error', sites: 1, reason: DEFECT },
  { file: 'app/admin/people/page.tsx', channel: '.alert--critical', identifier: 'error', sites: 1, reason: DEFECT },
  { file: 'app/admin/pin/page.tsx', channel: '--locked', identifier: 'inactive', sites: 1, reason: DEFECT },
  { file: 'app/admin/pin/page.tsx', channel: '.alert--critical', identifier: 'error', sites: 2, reason: DEFECT },
  { file: 'app/admin/platform/overview/page.tsx', channel: '.alert--critical', identifier: 'error', sites: 1, reason: DEFECT },
  { file: 'app/admin/platform/page.tsx', channel: '.alert--critical', identifier: 'error', sites: 1, reason: DEFECT },
  { file: 'app/admin/portrait-review/page.tsx', channel: '.alert--critical', identifier: 'error', sites: 1, reason: DEFECT },
  { file: 'app/admin/portrait-review/page.tsx', channel: '.stamp', identifier: 'reject', sites: 1, reason: DEFECT },
  { file: 'app/admin/program-phases/page.tsx', channel: '.alert--critical', identifier: 'error', sites: 1, reason: DEFECT },
  { file: 'app/admin/public-interest/page.tsx', channel: '.alert--critical', identifier: 'error', sites: 1, reason: DEFECT },
  { file: 'app/admin/shadow/page.tsx', channel: '--locked', identifier: 'reject', sites: 1, reason: DEFECT },
  { file: 'app/admin/shadow/page.tsx', channel: '.alert--critical', identifier: 'error', sites: 5, reason: DEFECT },
  { file: 'app/admin/video-review/page.tsx', channel: '--locked-ink', identifier: 'error', sites: 1, reason: DEFECT },
  { file: 'app/admin/volunteer-management/page.tsx', channel: '.alert--critical', identifier: 'error', sites: 1, reason: DEFECT },
  { file: 'app/athlete/progression-intelligence/page.tsx', channel: '--locked', identifier: 'incomplete', sites: 1, reason: DEFECT },
  { file: 'app/athlete/progression-intelligence/page.tsx', channel: '.alert--critical', identifier: 'error', sites: 1, reason: DEFECT },
  { file: 'app/athlete/sign-in/page.tsx', channel: '--locked', identifier: 'error', sites: 2, reason: DEFECT },
  { file: 'app/athlete/video-analysis/page.tsx', channel: '.alert--critical', identifier: 'error', sites: 2, reason: DEFECT },
  { file: 'app/audit/page.tsx', channel: '--locked', identifier: 'fail', sites: 2, reason: DEFECT },
  // 2026-08-25: the magic-link "Sign-in refused" panel moved to the restricted
  // rung -- a link that did not work is an authentication fact, not a medical
  // one -- taking both --locked sites (the border token and badge--locked)
  // with it. Swept, so the entry is deleted rather than shrunk, as this
  // guard's staleness half requires. The raw rgba(168,30,34,...) ground that
  // sat on the SAME line as the border token went with it; that literal was
  // never covered by this entry, which is what the seed-literal channel below
  // now exists to say out loud.
  { file: 'app/change-pin/page.tsx', channel: '.alert--critical', identifier: 'error', sites: 1, reason: DEFECT },
  { file: 'app/coach/attempt-log/page.tsx', channel: '--locked', identifier: 'missing', sites: 1, reason: DEFECT },
  { file: 'app/coach/attempt-log/page.tsx', channel: '.alert--critical', identifier: 'error', sites: 1, reason: DEFECT },
  { file: 'app/coach/behavior-standards/page.tsx', channel: '.alert--critical', identifier: 'error', sites: 1, reason: DEFECT },
  { file: 'app/coach/cards/page.tsx', channel: '.alert--critical', identifier: 'error', sites: 1, reason: DEFECT },
  { file: 'app/coach/cohorts/page.tsx', channel: '--locked', identifier: 'error', sites: 2, reason: DEFECT },
  { file: 'app/coach/cohorts/page.tsx', channel: '--locked-ink', identifier: 'error', sites: 2, reason: DEFECT },
  { file: 'app/coach/credentials/page.tsx', channel: '--locked', identifier: 'missing', sites: 1, reason: DEFECT },
  { file: 'app/coach/credentials/page.tsx', channel: '.alert--critical', identifier: 'error', sites: 1, reason: DEFECT },
  { file: 'app/coach/cue-library/page.tsx', channel: '.alert--critical', identifier: 'error', sites: 1, reason: DEFECT },
  { file: 'app/coach/disciplines/page.tsx', channel: '--locked', identifier: 'error', sites: 2, reason: DEFECT },
  { file: 'app/coach/disciplines/page.tsx', channel: '--locked-ink', identifier: 'error', sites: 2, reason: DEFECT },
  { file: 'app/coach/drills/page.tsx', channel: '--locked', identifier: 'error', sites: 2, reason: DEFECT },
  { file: 'app/coach/drills/page.tsx', channel: '--locked-ink', identifier: 'error', sites: 2, reason: DEFECT },
  { file: 'app/coach/intelligence/page.tsx', channel: '.alert--critical', identifier: 'error', sites: 1, reason: DEFECT },
  { file: 'app/coach/intervention-executions/page.tsx', channel: '.alert--critical', identifier: 'error', sites: 1, reason: DEFECT },
  { file: 'app/coach/intervention-protocols/page.tsx', channel: '.alert--critical', identifier: 'error', sites: 1, reason: DEFECT },
  { file: 'app/coach/intervention-review/page.tsx', channel: '.alert--critical', identifier: 'error', sites: 1, reason: DEFECT },
  { file: 'app/coach/one-percent-club/page.tsx', channel: '.alert--critical', identifier: 'error', sites: 1, reason: DEFECT },
  { file: 'app/coach/passbook-gaps/page.tsx', channel: '.alert--critical', identifier: 'error', sites: 1, reason: DEFECT },
  { file: 'app/coach/performance-analytics/page.tsx', channel: '.alert--critical', identifier: 'error', sites: 1, reason: DEFECT },
  { file: 'app/coach/session-scripts/page.tsx', channel: '--locked', identifier: 'error', sites: 3, reason: DEFECT },
  { file: 'app/coach/session-scripts/page.tsx', channel: '--locked', identifier: 'fail', sites: 1, reason: DEFECT },
  { file: 'app/coach/session-scripts/page.tsx', channel: '--locked', identifier: 'unavailable', sites: 1, reason: DEFECT },
  { file: 'app/coach/session-scripts/page.tsx', channel: '--locked-ink', identifier: 'error', sites: 3, reason: DEFECT },
  { file: 'app/coach/session-scripts/page.tsx', channel: '--locked-ink', identifier: 'fail', sites: 1, reason: DEFECT },
  { file: 'app/coach/session-scripts/page.tsx', channel: '--locked-ink', identifier: 'unavailable', sites: 1, reason: DEFECT },
  { file: 'app/coach/sports-medicine/page.tsx', channel: '--locked', identifier: 'unavailable', sites: 1, reason: LEGITIMATE },
  { file: 'app/coach/transfer-check/page.tsx', channel: '--locked', identifier: 'fail', sites: 1, reason: DEFECT },
  { file: 'app/coach/transfer-check/page.tsx', channel: '.alert--critical', identifier: 'error', sites: 1, reason: DEFECT },
  { file: 'app/coach/video-analysis/page.tsx', channel: '--locked-ink', identifier: 'error', sites: 5, reason: DEFECT },
  { file: 'app/coach/video-publications/page.tsx', channel: '--locked-ink', identifier: 'error', sites: 1, reason: DEFECT },
  { file: 'app/coach/workout-templates/page.tsx', channel: '--locked', identifier: 'error', sites: 2, reason: DEFECT },
  { file: 'app/coach/workout-templates/page.tsx', channel: '--locked-ink', identifier: 'error', sites: 2, reason: DEFECT },
  { file: 'app/dashboard/page.tsx', channel: '.alert--critical', identifier: 'fail', sites: 1, reason: DEFECT },
  { file: 'app/evidence/page.tsx', channel: '--locked', identifier: 'error', sites: 3, reason: DEFECT },
  { file: 'app/evidence/page.tsx', channel: '.stamp', identifier: 'error', sites: 2, reason: DEFECT },
  { file: 'app/evidence/page.tsx', channel: '.stamp', identifier: 'reject', sites: 1, reason: DEFECT },
  { file: 'app/knowledge-graph/page.tsx', channel: '--locked', identifier: 'error', sites: 2, reason: DEFECT },
  { file: 'app/knowledge-graph/page.tsx', channel: '--locked', identifier: 'reject', sites: 1, reason: DEFECT },
  { file: 'app/notices/page.tsx', channel: '--locked', identifier: 'error', sites: 1, reason: DEFECT },
  { file: 'app/operations/external-competition/page.tsx', channel: '.alert--critical', identifier: 'error', sites: 1, reason: DEFECT },
  { file: 'app/operations/wrestling-league/page.tsx', channel: '.alert--critical', identifier: 'error', sites: 1, reason: DEFECT },
  { file: 'app/parent/consent/page.tsx', channel: '.alert--critical', identifier: 'error', sites: 1, reason: DEFECT },
  { file: 'app/parent/progression-visibility/page.tsx', channel: '--locked', identifier: 'error', sites: 1, reason: DEFECT },
  { file: 'app/parent/progression-visibility/page.tsx', channel: '--locked', identifier: 'incomplete', sites: 1, reason: DEFECT },
  { file: 'app/parent/progression-visibility/page.tsx', channel: '.alert--critical', identifier: 'error', sites: 1, reason: DEFECT },
  { file: 'app/parent/safety/page.tsx', channel: '.alert--critical', identifier: 'error', sites: 1, reason: DEFECT },
  { file: 'app/rabbit-holes/page.tsx', channel: '--locked', identifier: 'error', sites: 1, reason: DEFECT },
  { file: 'app/research/page.tsx', channel: '--locked', identifier: 'error', sites: 2, reason: DEFECT },
  { file: 'app/research/page.tsx', channel: '--locked', identifier: 'reject', sites: 1, reason: DEFECT },
  { file: 'app/research/review/page.tsx', channel: '--locked', identifier: 'error', sites: 2, reason: DEFECT },
  { file: 'app/shadow/scout/page.tsx', channel: '--locked', identifier: 'fail', sites: 1, reason: DEFECT },
  { file: 'app/shadow/scout/page.tsx', channel: '.stamp', identifier: 'unavailable', sites: 2, reason: DEFECT },
  { file: 'app/source-control/publication-workflow/page.tsx', channel: '.alert--critical', identifier: 'error', sites: 1, reason: DEFECT },
  { file: 'app/staff-credentials/page.tsx', channel: '--locked', identifier: 'missing', sites: 1, reason: DEFECT },
  { file: 'app/staff-credentials/page.tsx', channel: '.alert--critical', identifier: 'error', sites: 1, reason: DEFECT },
  { file: 'components/AthleteWorkspace.tsx', channel: '.alert--critical', identifier: 'error', sites: 4, reason: DEFECT },
  { file: 'components/CoachRecognitionPad.tsx', channel: '--locked', identifier: 'fail', sites: 1, reason: DEFECT },
  { file: 'components/CoachRecognitionPad.tsx', channel: '--locked-ink', identifier: 'fail', sites: 1, reason: DEFECT },
  // 2026-08-24: the "Athlete Floor Plans" panel was removed (it presented
  // plans auto-generated from the unvalidated check-in readiness slider as
  // individualized work), taking its --locked error box with it: one
  // --locked site and three --locked-ink sites fewer, shrunk here in the
  // same change as this guard requires.
  { file: 'components/CoachWorkspace.tsx', channel: '--locked', identifier: 'error', sites: 4, reason: DEFECT },
  { file: 'components/CoachWorkspace.tsx', channel: '--locked', identifier: 'unable-to', sites: 1, reason: DEFECT },
  { file: 'components/CoachWorkspace.tsx', channel: '--locked', identifier: 'unavailable', sites: 1, reason: DEFECT },
  { file: 'components/CoachWorkspace.tsx', channel: '--locked-ink', identifier: 'error', sites: 12, reason: DEFECT },
  { file: 'components/CoachWorkspace.tsx', channel: '--locked-ink', identifier: 'incomplete', sites: 1, reason: DEFECT },
  { file: 'components/CoachWorkspace.tsx', channel: '--locked-ink', identifier: 'unable-to', sites: 1, reason: DEFECT },
  { file: 'components/CoachWorkspace.tsx', channel: '--locked-ink', identifier: 'unavailable', sites: 1, reason: DEFECT },
  { file: 'components/ParentDigest.tsx', channel: '.alert--critical', identifier: 'fail', sites: 1, reason: DEFECT },
  { file: 'components/ParentHub.tsx', channel: '--locked', identifier: 'error', sites: 1, reason: DEFECT },
  { file: 'components/ParentHub.tsx', channel: '.alert--critical', identifier: 'error', sites: 1, reason: DEFECT },
  { file: 'components/ProfileSettings.tsx', channel: '--locked-ink', identifier: 'error', sites: 3, reason: DEFECT },
  { file: 'components/SessionScriptLiveDelivery.tsx', channel: '--locked', identifier: 'error', sites: 2, reason: DEFECT },
  { file: 'components/SessionScriptLiveDelivery.tsx', channel: '--locked', identifier: 'unavailable', sites: 2, reason: DEFECT },
  { file: 'components/SessionScriptLiveDelivery.tsx', channel: '--locked-ink', identifier: 'error', sites: 3, reason: DEFECT },
  { file: 'components/SessionScriptLiveDelivery.tsx', channel: '--locked-ink', identifier: 'unavailable', sites: 2, reason: DEFECT },
  { file: 'components/ShadowCommandFeed.tsx', channel: '.alert--critical', identifier: 'error', sites: 1, reason: DEFECT },
  { file: 'components/uiStyles.ts', channel: '--locked', identifier: 'error', sites: 1, reason: DEFECT },
  { file: 'components/uiStyles.ts', channel: '--status-danger', identifier: 'error', sites: 3, reason: DEFECT },
  { file: 'components/uiStyles.ts', channel: '--status-danger', identifier: 'inactive', sites: 1, reason: DEFECT },
];

/* ------------------------------------------------ SEED LITERAL CHANNEL -- */

/**
 * A CHANNEL THE ALLOW-LIST COULD NEVER HAVE ACCOUNTED FOR.
 *
 * Honesty item 1 at the top of this file says it plainly: a raw `#A81E22` or
 * `rgba(168,30,34,…)` in TSX names no token and no class, so the derived
 * channels never see it. That was written as a known limit. What it also
 * created was a trap, and the trap is worse than the limit:
 *
 *   app/auth/link/page.tsx line 101 carried BOTH spellings on ONE line --
 *   `border-[color:var(--locked)]` (a derived channel, allow-listed) and
 *   `bg-[rgba(168,30,34,0.06)]` (invisible here). The allow-list entry named
 *   the file, so the file read as accounted for. It was not: the entry froze
 *   the token sites and said nothing at all about the literal.
 *
 *   Sweeping the tokens then removes the entry -- correctly, by the staleness
 *   half of the test above, which is doing its job. The literal stays behind,
 *   still painting the reservation's exact colour, and the last thing in the
 *   repository that pointed at that file is now gone. THE CLEANUP MEANT TO FIX
 *   THE SITE IS WHAT WOULD HIDE WHAT REMAINED OF IT.
 *
 * The entry was never cover, and that distinction matters for anyone reading
 * this later: it was incidental, non-load-bearing visibility. Deleting it hid
 * nothing that deletion caused. The literal was unseen from the day it landed.
 *
 * WHY AN INDEPENDENT SCAN, AND NOT A LIVENESS RULE ON THE ENTRY. The obvious
 * fix -- assert every allow-list entry still matches -- is already here: the
 * `stale` half of the test above IS that assertion, and it is exactly what
 * fires when the tokens are swept. Strengthening it could not have helped,
 * because the failure was never an entry that stopped matching. It was a
 * colour that was never a channel. So the fix has to be a channel, derived
 * from the one fact this file already hardcodes -- the seed -- and reached
 * without passing through a token or a class at all.
 *
 * THE RULE IS ZERO, NOT PROXIMITY. Every other channel here is proximity-
 * matched, because `var(--locked)` beside a load error is wrong while
 * `var(--locked)` beside a medical hold is right, and only the neighbourhood
 * tells them apart. The literal needs no such reading. It is wrong at the top
 * of the safety ladder too: it hardcodes the reservation's colour, so it does
 * not move when the ladder is re-themed (safetySemanticsSurviveTheThemeSwap),
 * it is not reachable by any sweep that greps tokens, and it defeats every
 * derived channel above by construction. A genuine MEDICALLY_NOT_ALLOWED
 * surface writes `var(--locked)`. Nothing writes the hex. Dropping proximity
 * also closes honesty item 3 for this channel specifically -- moving the word
 * "error" six lines away does not launder a literal.
 *
 * THE WALK IS WIDER THAN `SCANNED`. `apps/web/src/` holds real .tsx surfaces
 * (BoardViewportSwitcher, MediaAndCommsHub, FloorOperationsDesk, …) that the
 * proximity scan above has never covered. The literal channel takes app/,
 * components/ AND src/. Widening `SCANNED` itself would change the population
 * the frozen allow-list is measured against, which is a different change with
 * a different review; this addition is strictly on top of it.
 *
 * WHAT IT STILL DOES NOT COVER, so nobody reads it as more:
 *   - non-.tsx/.ts assets. app/icon.svg strokes the seal in #A81E22 and is
 *     left alone deliberately: that is the platform's brand mark at favicon
 *     scale, not a rung of the status ladder, and it is not this guard's
 *     ruling to make.
 *   - a computed literal (`'#' + 'A81E22'`), or one arriving from data.
 *   - the design system's own sheets, where the seed is DEFINED and must be.
 *
 * WATCHED TO FAIL, 2026-08-25, before landing. Each run is this one test
 * file, `npx jest --runInBand src/design/safeguardingRedReservation.test.ts`,
 * from apps/web:
 *
 *   (a) THE TRAP, WALKED INTO ON PURPOSE. app/auth/link/page.tsx with its
 *       tokens swept to --restricted, the raw rgba(168,30,34,0.06) ground
 *       left behind, and the --locked allow-list entry deleted as stale --
 *       which is precisely the state the sweep-and-cleanup sequence produces.
 *       Against the guard as it stood on origin/main (4fdfcd1d): 5/5 GREEN,
 *       with nothing anywhere naming the file. Against this section: RED,
 *       "app/auth/link/page.tsx:117 — rgb — …", proximity half still green,
 *       which is the demonstration that the two channels are independent.
 *   (b) A LEGITIMATE TOP-OF-LADDER PANEL -- var(--locked) border,
 *       badge--locked, var(--locked-ink) copy, colour reached only through
 *       tokens: GREEN. The channel does not fire on the right answer.
 *   (c) THE SPELLINGS. `#A81E22cc` (8-digit alpha, past SEED_HEX's word
 *       boundary) in an inline style, in src/, with no failure word and no
 *       token anywhere near it -- caught, which is four misses of the
 *       existing channels at once. `bg-[rgb(168_30_34)]` and
 *       `rgb(168 30 34)` -- caught.
 *   (d) PROSE. The same hex and rgba() in a comment and nothing else --
 *       GREEN, so the several files that document the reservation (this one
 *       included) are not reported as painting it.
 *   (e) THE LITERAL ALLOW-LIST, BOTH WAYS. An entry keyed on the probe's
 *       exact line: GREEN, the escape hatch works. Then the line reformatted
 *       (`#A81E22cc` -> `#a81e22CC`, same colour): RED twice over -- the line
 *       is no longer excused AND the entry is reported STALE. An entry here
 *       cannot quietly stop matching, which is the failure this whole section
 *       exists to make impossible.
 */

/** app/ and components/ (what `SCANNED` covers) plus src/, which no proximity
 *  channel has ever walked. */
const LITERAL_SCANNED = [...SCANNED, path.join(WEB, 'src')];
const LITERAL_FILES = LITERAL_SCANNED.flatMap(walk);

/** Every way the seed can be spelled in TS/TSX source. Deliberately its own
 *  set rather than a widening of SEED_HEX/SEED_RGB above, so this addition
 *  cannot move what the existing CSS derivation matches:
 *
 *    - hex with no word boundary, so the 8-digit alpha form `#A81E22cc` --
 *      the same red, and past `SEED_HEX`'s `\b` -- is caught;
 *    - rgb()/rgba() in the legacy comma form, the modern space form, and with
 *      the underscore Tailwind substitutes for a space inside an arbitrary
 *      value (`bg-[rgb(168_30_34)]`).
 */
const SEED_LITERAL_SPELLINGS: ReadonlyArray<{
  label: string;
  probe: RegExp;
  sample: string;
}> = [
  { label: 'hex', probe: /#a81e22/i, sample: 'style={{ color: "#A81E22cc" }}' },
  {
    label: 'rgb',
    probe: /rgba?\(\s*168\s*(?:[,_]|\s)\s*30\s*(?:[,_]|\s)\s*34\b/i,
    sample: 'className="bg-[rgba(168,30,34,0.06)]"',
  },
];

/** A token use of the reservation -- the RIGHT answer for a genuine
 *  top-of-ladder surface. No spelling above may fire on it. */
const LEGITIMATE_TOKEN_USE =
  'className="border-2 border-[color:var(--locked)] badge badge--locked"';

interface LiteralSite {
  file: string;
  line: number;
  spelling: string;
  text: string;
}

/** Comment-stripped, so the several files that DISCUSS #A81E22 in prose --
 *  this one, sports-medicine, simulator, schedule -- are not reported. The
 *  stripper replaces comment characters with spaces, so the line numbers it
 *  reports are the real ones. */
function scanSeedLiterals(): LiteralSite[] {
  const sites: LiteralSite[] = [];
  for (const file of LITERAL_FILES) {
    const { code } = stripTsComments(readFileSync(file, 'utf8'));
    const relative = path.relative(WEB, file).split(path.sep).join('/');
    code.split('\n').forEach((line, index) => {
      const hit = SEED_LITERAL_SPELLINGS.find(({ probe }) => probe.test(line));
      if (!hit) return;
      sites.push({ file: relative, line: index + 1, spelling: hit.label, text: line.trim() });
    });
  }
  return sites;
}

const LITERAL_SITES = scanSeedLiterals();

interface LiteralAllowListEntry {
  file: string;
  /** The matched source line, trimmed, EXACTLY as it stands. Keying on the
   *  literal's own text rather than on a token channel is the point: an entry
   *  here cannot quietly stop describing the thing it excuses. Reformat the
   *  line and the entry goes stale and fails loudly, which is the behaviour
   *  the token channel could not offer a colour it never derived. */
  text: string;
  reason: string;
}

/** Empty, and that is the finding, not an oversight: after the magic-link
 *  panel was swept there is no live seed literal left in app/, components/ or
 *  src/. A future entry needs an owner reason, not a convenience. */
const LITERAL_ALLOW_LIST: readonly LiteralAllowListEntry[] = [];

const LITERAL_GUIDANCE = [
  'The safeguarding red (#A81E22) is never written as a literal in TS/TSX.',
  'A raw hex or rgba() hardcodes the reservation: it survives a theme swap,',
  'no token sweep can find it, and every derived channel in this file misses',
  'it by construction. If the surface genuinely reports MEDICALLY_NOT_ALLOWED,',
  'write var(--locked) / badge--locked and let the ladder carry the colour.',
  'If it reports a failure, an empty state, or anything else, it is the',
  'restricted rung: var(--restricted) / badge--restricted, glyph ▲',
  '(the precedented substitution, PR #576; PR #609 on /schedule).',
].join('\n');

/* ---------------------------------------------------------------- TESTS -- */

const GUIDANCE = [
  'The safeguarding red (#A81E22) is reserved for the top of the safety',
  'ladder — a person who may not participate (owner decision 2026-08-19).',
  'A fetch that failed is not that. Use the non-safety vocabulary instead',
  '(the precedented substitution, PR #576): alert--critical → alert--warning;',
  'var(--locked) → var(--restricted); var(--locked-ink) → var(--restricted-ink);',
  'badge--locked → badge--restricted; bare stamp → stamp stamp--brass;',
  'glyph ✕ → ▲. If this element genuinely reports a top-of-ladder',
  'participation block, add an ALLOW_LIST entry marked LEGITIMATE instead.',
].join('\n');

describe('the safeguarding red reservation', () => {
  it('derives its channels from the loaded sheets, so a broken derivation cannot pass vacuously', () => {
    // A resolver returning '' or a moved seed colour would empty these sets
    // and every assertion below would pass in the direction that looks like
    // success. If a theme swap re-colours the reservation, update SEED at the
    // top of this file — that constant is the guard's single hardcoded fact.
    expect(designCss.length).toBeGreaterThan(50_000);
    expect(RED_TOKENS.size).toBeGreaterThan(0);
    expect(RED_TOKENS).toContain('--locked');
    expect(RED_TOKENS).toContain('--locked-ink');
    expect(RED_TOKENS).toContain('--stamp-red');
    // The alias channel: app/globals.css names that resolve to the seed.
    expect(RED_TOKENS).toContain('--safety-locked');
    expect(RED_TOKENS).toContain('--status-danger');
    // The class channels the inventory measured.
    expect(RED_CLASSES).toContain('alert--critical');
    expect(RED_CLASSES).toContain('stamp');
    // The recolorers that make a stamp NOT red, so suppression is real.
    expect(STAMP_RECOLORERS).toContain('stamp--brass');
    expect(STAMP_RECOLORERS).toContain('stamp--green');
    // The walk sees the tree it claims to police.
    expect(FILES.length).toBeGreaterThan(100);
    expect(FILES.some((file) => file.endsWith('CoachWorkspace.tsx'))).toBe(true);
  });

  it('holds every red/failure proximity to the allow-list, exactly, in both directions', () => {
    const allowed = new Map<string, AllowListEntry>();
    const duplicates: string[] = [];
    for (const entry of ALLOW_LIST) {
      const key = [entry.file, entry.channel, entry.identifier].join(KEY_SEPARATOR);
      if (allowed.has(key)) duplicates.push(`${entry.file} — ${entry.channel} — ${entry.identifier}`);
      allowed.set(key, entry);
    }

    const newSites: string[] = [];
    for (const [key, finding] of FINDINGS) {
      const [file, channel, identifier] = key.split(KEY_SEPARATOR);
      const entry = allowed.get(key);
      if (!entry) {
        newSites.push(
          `  ${file} — ${channel} within ±${PROXIMITY} lines of "${identifier}" (${finding.sites} site${finding.sites === 1 ? '' : 's'}, not allow-listed)`,
        );
      } else if (finding.sites > entry.sites) {
        newSites.push(
          `  ${file} — ${channel} within ±${PROXIMITY} lines of "${identifier}" (${finding.sites} sites, allow-list froze ${entry.sites})`,
        );
      }
    }

    const stale: string[] = [];
    for (const [key, entry] of allowed) {
      const finding = FINDINGS.get(key);
      if (!finding) {
        stale.push(`  ${entry.file} — ${entry.channel} — "${entry.identifier}" (listed ${entry.sites}, found 0)`);
      } else if (finding.sites < entry.sites) {
        stale.push(
          `  ${entry.file} — ${entry.channel} — "${entry.identifier}" (listed ${entry.sites}, found ${finding.sites})`,
        );
      }
    }

    const problems: string[] = [];
    if (duplicates.length) {
      problems.push(`Duplicate allow-list entries:\n${duplicates.join('\n')}`);
    }
    if (newSites.length) {
      problems.push(
        `NEW proximity between the safeguarding red and failure/emptiness vocabulary:\n${newSites
          .sort()
          .join('\n')}\n\n${GUIDANCE}`,
      );
    }
    if (stale.length) {
      problems.push(
        `STALE allow-list entries — the tree no longer matches them. A swept site must\nshrink or delete its entry in the same change, so this list can never rot:\n${stale
          .sort()
          .join('\n')}`,
      );
    }

    expect(problems.length === 0 ? true : problems.join('\n\n')).toBe(true);
  });

  it('lets no seed literal reach TS/TSX at all, on a channel no token sweep can delete', () => {
    // Non-vacuity first. A walk that found nothing, or probes that matched
    // nothing, would pass in the direction that looks like success -- the
    // exact failure mode the derivation test above exists to prevent.
    expect(LITERAL_FILES.length).toBeGreaterThan(FILES.length);
    expect(LITERAL_FILES.some((file) => file.includes(`${path.sep}src${path.sep}`))).toBe(true);
    expect(SEED_LITERAL_SPELLINGS.length).toBeGreaterThan(1);
    for (const { label, probe, sample } of SEED_LITERAL_SPELLINGS) {
      expect(`${label}: ${probe.test(sample)}`).toBe(`${label}: true`);
      // And it must not fire on the right answer: a genuine top-of-ladder
      // surface reaches the red through the token, and that is legal.
      expect(`${label}: ${probe.test(LEGITIMATE_TOKEN_USE)}`).toBe(`${label}: false`);
    }

    const allowed = new Map<string, LiteralAllowListEntry>();
    for (const entry of LITERAL_ALLOW_LIST) {
      allowed.set([entry.file, entry.text].join(KEY_SEPARATOR), entry);
    }

    const unallowed = LITERAL_SITES.filter(
      (site) => !allowed.has([site.file, site.text].join(KEY_SEPARATOR)),
    ).map((site) => `  ${site.file}:${site.line} — ${site.spelling} — ${site.text}`);

    // Liveness, the other half: an entry whose line no longer exists must
    // fail rather than sit here excusing nothing. Same contract the token
    // allow-list holds itself to, applied to a key that is the literal.
    const live = new Set(LITERAL_SITES.map((site) => [site.file, site.text].join(KEY_SEPARATOR)));
    const stale = [...allowed.values()]
      .filter((entry) => !live.has([entry.file, entry.text].join(KEY_SEPARATOR)))
      .map((entry) => `  ${entry.file} — ${entry.text}`);

    const problems: string[] = [];
    if (unallowed.length) {
      problems.push(
        `The safeguarding red written as a LITERAL in TS/TSX:\n${unallowed
          .sort()
          .join('\n')}\n\n${LITERAL_GUIDANCE}`,
      );
    }
    if (stale.length) {
      problems.push(
        `STALE seed-literal allow-list entries — the line they name is gone.\nDelete the entry in the same change that swept the literal:\n${stale
          .sort()
          .join('\n')}`,
      );
    }

    expect(problems.length === 0 ? true : problems.join('\n\n')).toBe(true);
  });
});

describe('the reservation is real in the sheets themselves', () => {
  it('resolves --stamp-restricted to the restricted rung, never the locked red', () => {
    // RESTRICTED must not render in LOCKED red (owner, 2026-08-24). Before
    // this pin, --stamp-restricted aliased var(--locked), so two adjacent
    // rungs of the ladder were byte-identical and the collapse was invisible
    // on screen.
    const stampRestricted = resolveTokenHex('--stamp-restricted');
    const restricted = resolveTokenHex('--restricted');
    expect(stampRestricted).not.toBeNull();
    expect(restricted).not.toBeNull();
    expect(stampRestricted).not.toBe(SEED);
    expect(stampRestricted).toBe(restricted);
    expect(RED_TOKENS.has('--stamp-restricted')).toBe(false);
  });

  it('lets no :focus rule reach the safeguarding red', () => {
    // Focus rings are chassis: they report where the keyboard is, never a
    // claim about a person. globals.css already fixed the base ring for that
    // reason; .tactical-input:focus and .stamp-button:focus-visible survived
    // in --safety-locked until 2026-08-24. The standard is var(--brass-700),
    // the one value the sheet documents as clearing 3:1 on every ground.
    const offenders: string[] = [];
    for (const rule of [...cssRules(designCss), ...cssRules(globalsCss)]) {
      if (!rule.selector.includes(':focus')) continue;
      if (ruleReachesRed(rule.body)) offenders.push(rule.selector.replace(/\s+/g, ' '));
    }
    expect(
      offenders.length === 0
        ? true
        : `:focus rules reaching the safeguarding red:\n  ${offenders.join('\n  ')}`,
    ).toBe(true);
  });

  it('freezes the alias channel: globals.css defines exactly the known aliases of the red', () => {
    // A new `--anything: var(--locked)` in globals.css is a new channel to
    // the reservation. The three below are the frozen survivors the sweep
    // will retire; nothing may join them.
    const aliasNames = new Set(
      [...GLOBALS_ROOT.matchAll(/(--[A-Za-z0-9-]+)\s*:/g)].map((m) => m[1]),
    );
    const redAliases = [...RED_TOKENS].filter((token) => aliasNames.has(token)).sort();
    expect(redAliases).toEqual(['--safety-locked', '--status-critical', '--status-danger']);
  });
});

describe('the safeguarding red is never spelled out as a literal', () => {
  const LITERAL_GUIDANCE = [
    'A rule that spells the colour out has no token in it. No scope can override',
    'it, and every channel this file derives — tokens, aliases, classes — walks',
    'straight past it. That is how .pap--ruled painted a decorative legal-pad',
    'margin rule in the reserved red until 2026-08-25.',
    '',
    'Decide what the rule is FOR, because the two answers are not the same:',
    '  • chrome / decoration → it must STOP USING THIS COLOUR. Take an ink the',
    '    sheet already uses for non-semantic work (.pap--ruled took its own',
    '    horizontal ruling ink). Converting decoration to var(--locked) keeps the',
    '    colour and only hides it from this guard, which is worse than the leak.',
    '  • a genuine top-of-safety-ladder use → go through the token, colour',
    '    unchanged: var(--locked) / var(--stamp-red), or',
    '    color-mix(in srgb, var(--stamp-red) N%, transparent) where an alpha is',
    '    needed, as .gauge-arc does.',
  ].join('\n');

  it('reads sheets that still write the reservation down, so this cannot pass vacuously', () => {
    // Three ways this check could pass while checking nothing: the resolver
    // returns '' (no sheet), the app sheet is missed, or the seed moved and
    // the scan matches nothing anywhere. Each is failed here, on the same
    // evidence the check itself runs on.
    expect(designCss.length).toBeGreaterThan(50_000);
    expect(globalsCss.length).toBeGreaterThan(10_000);
    expect(LITERAL_SITES.length).toBeGreaterThan(0);

    const defining = LITERAL_SITES.filter(definesTheReservation);
    expect(defining.length).toBeGreaterThan(0);

    // The places the reservation is legitimately written down, frozen by
    // name. A fourth one is not forbidden — it is a decision, and it should
    // be argued for in a diff to this line rather than added quietly.
    expect([...new Set(defining.map((site) => site.property))].sort()).toEqual([
      '--locked',
      '--locked-deep',
      '--stamp-red',
    ]);
  });

  it('lets no rule spend the reservation as a literal instead of reaching it through a token', () => {
    const offenders = LITERAL_SITES.filter((site) => !definesTheReservation(site));

    const report = offenders
      .map((site) => `  ${site.sheet}\n    ${site.selector} — ${site.declaration}`)
      .sort()
      .join('\n');

    expect(
      offenders.length === 0
        ? true
        : `The safeguarding red is spelled out as a literal in ${offenders.length} place(s):\n${report}\n\n${LITERAL_GUIDANCE}`,
    ).toBe(true);
  });
});
