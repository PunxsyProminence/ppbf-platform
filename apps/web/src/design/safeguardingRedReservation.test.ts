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
const KEY_SEPARATOR = '\\u0000';

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
  { file: 'app/auth/link/page.tsx', channel: '--locked', identifier: 'error', sites: 2, reason: DEFECT },
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
