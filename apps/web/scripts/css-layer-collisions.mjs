#!/usr/bin/env node
/* ---------------------------------------------------------------------------
   CSS layer collision scanner - finds Tailwind utilities that never apply.

   WHY THIS EXISTS

   `design-system/ppbf.css` and most of `apps/web/app/globals.css` are
   UNLAYERED. Tailwind v4 puts every utility inside `@layer utilities`. In the
   cascade, layer order is resolved BEFORE specificity, and an unlayered rule
   beats a layered one - so a one-class ppbf selector defeats any utility on
   the same property, however the two selectors compare.

   Compile the app's own CSS and you can watch it happen:

       @layer theme, base, components, utilities;
       @layer utilities { .min-h-\[44px\] { min-height: 44px } }
       ...
       .btn--lever { min-height: 38px }        <- unlayered, and it wins

   So an element carrying both a ppbf class and a Tailwind utility naming the
   same property renders the ppbf value. The utility is inert while still
   reading as correct in the JSX. Three found by eye before this existed:

     .stamp { position: relative }   defeated `absolute` on the sign-in board
     .btn--lever { min-height:38px } defeated `min-h-[44px]` on /parent/consent
     .room { background-color }      defeated `bg-[var(--hide-950)]` on <main>

   No unit test can see this. A test asserting `className` contains "absolute"
   passes on a stamp that renders bottom-LEFT.

   HOW IT WORKS

     1. Parses ppbf.css + globals.css into (selector, property, value) triples
        with their real line numbers, keeping layer / media / pseudo context
        and expanding shorthands. Rules inside `@layer` are excluded - they
        cannot cause this defect.
     2. Parses every app .tsx with the TypeScript compiler API and statically
        resolves each `className` to the SET of class strings it can produce:
        module constants (including across files), `+` concatenation, template
        literals, ternaries, `&&`, `??`, object lookups, `.join(' ')`, and
        local helper functions that return a class string. Anything it cannot
        resolve is COUNTED and listed, never silently dropped.
     3. Asks TAILWIND ITSELF what each token compiles to, by running the
        installed v4 compiler over the app's real globals.css. That is ground
        truth rather than a hand-written property map, and it is why this
        scanner disagrees with a regex-and-a-lookup-table first cut: it knows
        `space-y-6` targets CHILDREN, that `bg-gradient-to-br` sets
        background-image, that `border-l-4` also sets border-left-style, that
        `animate-fadeIn` compiles to nothing at all, and that a project class
        like `badge--filed` is not a utility.
     4. Compares VALUES, not just property names, resolving `var()` through the
        compiled `:root` - which already merges the app's `@theme` overrides,
        so `--spacing-4` is 13px here, not Tailwind's 16px.
     5. Files each collision in exactly one bucket: HARMLESS / DEAD / BROKEN.

   USAGE

     node scripts/css-layer-collisions.mjs                  # human report
     node scripts/css-layer-collisions.mjs --json           # machine-readable
     node scripts/css-layer-collisions.mjs --markdown FILE  # write the report
     node scripts/css-layer-collisions.mjs --self-test      # classifier guards

   It reads and reports. It never edits CSS or application code.
   --------------------------------------------------------------------------- */

import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ts = require('typescript');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.resolve(HERE, '..');
const REPO_ROOT = path.resolve(WEB_ROOT, '../..');
const NODE_MODULES = path.join(REPO_ROOT, 'node_modules');

const PPBF_CSS = path.join(REPO_ROOT, 'design-system/ppbf.css');
const GLOBALS_CSS = path.join(WEB_ROOT, 'app/globals.css');
const CSS_BASE = path.join(WEB_ROOT, 'app');

/* ============================================================ 1. CSS PARSING */

/* Comments are blanked rather than removed so every byte offset - and so every
   line number in the report - still points at the real line in the real file. */
function blankComments(src) {
  let out = '';
  for (let i = 0; i < src.length; i += 1) {
    if (src[i] === '/' && src[i + 1] === '*') {
      let j = src.indexOf('*/', i + 2);
      if (j === -1) j = src.length - 2;
      out += src.slice(i, j + 2).replace(/[^\n]/g, ' ');
      i = j + 1;
    } else if (src[i] === '"' || src[i] === "'") {
      const q = src[i];
      let j = i + 1;
      while (j < src.length && src[j] !== q) {
        if (src[j] === '\\') j += 1;
        j += 1;
      }
      out += src.slice(i, j + 1);
      i = j;
    } else {
      out += src[i];
    }
  }
  return out;
}

function lineIndexer(src) {
  const starts = [0];
  for (let i = 0; i < src.length; i += 1) if (src[i] === '\n') starts.push(i + 1);
  return (offset) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
}

/* Split on `sep` at bracket/paren/quote depth zero - selector lists,
   declaration lists and Tailwind variant prefixes all need this. */
function splitTop(input, sep) {
  const parts = [];
  let depth = 0;
  let buf = '';
  let quote = null;
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (quote) {
      buf += ch;
      if (ch === '\\') { buf += input[i + 1] ?? ''; i += 1; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; buf += ch; continue; }
    if (ch === '\\') { buf += ch + (input[i + 1] ?? ''); i += 1; continue; }
    if (ch === '(' || ch === '[') depth += 1;
    if (ch === ')' || ch === ']') depth -= 1;
    if (ch === sep && depth === 0) { parts.push(buf); buf = ''; continue; }
    buf += ch;
  }
  parts.push(buf);
  return parts;
}

/* Every shorthand this codebase writes, expanded to the longhands it sets.
   Without this, `.btn--lever { padding: 0 var(--s4) }` never registers against
   `px-[var(--s4)]`, and `background: <gradient>` never registers against
   `bg-[var(--x)]` - even though the shorthand resets background-color and so
   genuinely defeats it.

   `edges`/`edges2`/`corners` are the shorthands whose per-side values can be
   computed; `opaque` ones expand with an unknown value and are compared on
   property name only, which the report says out loud. */
const SHORTHANDS = {
  padding: { edges: ['padding-top', 'padding-right', 'padding-bottom', 'padding-left'] },
  margin: { edges: ['margin-top', 'margin-right', 'margin-bottom', 'margin-left'] },
  inset: { edges: ['top', 'right', 'bottom', 'left'] },
  'border-width': { edges: ['border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width'] },
  'border-color': { edges: ['border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color'] },
  'border-style': { edges: ['border-top-style', 'border-right-style', 'border-bottom-style', 'border-left-style'] },
  gap: { edges2: ['row-gap', 'column-gap'] },
  'border-radius': { corners: ['border-top-left-radius', 'border-top-right-radius', 'border-bottom-right-radius', 'border-bottom-left-radius'] },
  border: { opaque: ['border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width', 'border-top-style', 'border-right-style', 'border-bottom-style', 'border-left-style', 'border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color'] },
  'border-top': { opaque: ['border-top-width', 'border-top-style', 'border-top-color'] },
  'border-right': { opaque: ['border-right-width', 'border-right-style', 'border-right-color'] },
  'border-bottom': { opaque: ['border-bottom-width', 'border-bottom-style', 'border-bottom-color'] },
  'border-left': { opaque: ['border-left-width', 'border-left-style', 'border-left-color'] },
  background: { opaque: ['background-color', 'background-image', 'background-position', 'background-size', 'background-repeat', 'background-attachment', 'background-origin', 'background-clip'] },
  font: { opaque: ['font-style', 'font-weight', 'font-size', 'line-height', 'font-family'] },
  flex: { opaque: ['flex-grow', 'flex-shrink', 'flex-basis'] },
  'flex-flow': { opaque: ['flex-direction', 'flex-wrap'] },
  'grid-template': { opaque: ['grid-template-rows', 'grid-template-columns', 'grid-template-areas'] },
  'place-items': { edges2: ['align-items', 'justify-items'] },
  'place-content': { edges2: ['align-content', 'justify-content'] },
  'place-self': { edges2: ['align-self', 'justify-self'] },
  overflow: { edges2: ['overflow-x', 'overflow-y'] },
  'text-decoration': { opaque: ['text-decoration-line', 'text-decoration-style', 'text-decoration-color', 'text-decoration-thickness'] },
  'list-style': { opaque: ['list-style-type', 'list-style-position', 'list-style-image'] },
  transition: { opaque: ['transition-property', 'transition-duration', 'transition-timing-function', 'transition-delay'] },
  animation: { opaque: ['animation-name', 'animation-duration', 'animation-timing-function', 'animation-delay', 'animation-iteration-count', 'animation-direction', 'animation-fill-mode', 'animation-play-state'] },
  'grid-area': { opaque: ['grid-row-start', 'grid-column-start', 'grid-row-end', 'grid-column-end'] },
  'grid-column': { opaque: ['grid-column-start', 'grid-column-end'] },
  'grid-row': { opaque: ['grid-row-start', 'grid-row-end'] },
};

const UNKNOWN_VALUE = ' unknown';

function expandDeclaration(prop, value) {
  const shorthand = SHORTHANDS[prop];
  if (!shorthand) return [[prop, value]];
  const parts = splitTop(String(value).trim(), ' ').map((p) => p.trim()).filter(Boolean);

  if (shorthand.edges && parts.length >= 1 && parts.length <= 4) {
    const [t, r = t, b = t, l = r] = parts;
    return [[shorthand.edges[0], t], [shorthand.edges[1], r], [shorthand.edges[2], b], [shorthand.edges[3], l]];
  }
  if (shorthand.corners && parts.length >= 1 && parts.length <= 4 && !String(value).includes('/')) {
    const [a, b2 = a, c = a, d = b2] = parts;
    return [[shorthand.corners[0], a], [shorthand.corners[1], b2], [shorthand.corners[2], c], [shorthand.corners[3], d]];
  }
  if (shorthand.edges2 && parts.length >= 1 && parts.length <= 2) {
    const [a, b2 = a] = parts;
    return [[shorthand.edges2[0], a], [shorthand.edges2[1], b2]];
  }
  const longhands = shorthand.opaque ?? shorthand.edges ?? shorthand.edges2 ?? shorthand.corners;
  return longhands.map((lh) => [lh, UNKNOWN_VALUE]);
}

let SEQ = 0;

/* Parses CSS into flat rules. Handles nesting (`&`), nested at-rules, and the
   at-rules this project uses (@layer, @media, @supports, @theme, @property). */
function parseCssText(raw, file) {
  const src = blankComments(raw);
  const lineOf = lineIndexer(src);
  const rules = [];
  let pos = 0;

  function combine(parents, child) {
    if (!parents) return [child];
    return parents.map((p) => (child.includes('&') ? child.replace(/&/g, p) : `${p} ${child}`));
  }

  function pushDecl(decls, buf, startOffset) {
    const text = buf.trim();
    if (!text) return;
    /* The buffer starts immediately after the `{` or `;`, which is usually
       still on the PREVIOUS line. Skipping the leading whitespace is what makes
       a reported line number land on the declaration a reader is looking for
       rather than one line above it. */
    const line = lineOf(startOffset + (buf.length - buf.trimStart().length));
    const idx = text.indexOf(':');
    if (idx <= 0) return;
    const prop = text.slice(0, idx).trim().toLowerCase();
    let value = text.slice(idx + 1).trim();
    let important = false;
    if (/!\s*important$/i.test(value)) { important = true; value = value.replace(/!\s*important$/i, '').trim(); }
    if (!prop || !value || /\s/.test(prop)) return;
    decls.push({ prop, value, important, line });
  }

  function skipBlock() {
    let depth = 1;
    while (pos < src.length && depth > 0) {
      if (src[pos] === '{') depth += 1;
      else if (src[pos] === '}') depth -= 1;
      pos += 1;
    }
  }

  function readBlock(ctx, selectors, blockLine) {
    const decls = [];
    const seq = SEQ++;
    let buf = '';
    let bufStart = pos;
    while (pos < src.length) {
      const ch = src[pos];
      if (ch === '"' || ch === "'") {
        const q = ch;
        let j = pos + 1;
        while (j < src.length && src[j] !== q) { if (src[j] === '\\') j += 1; j += 1; }
        buf += src.slice(pos, j + 1);
        pos = j + 1;
        continue;
      }
      if (ch === '(') {
        let depth = 0;
        let j = pos;
        while (j < src.length) {
          if (src[j] === '(') depth += 1;
          else if (src[j] === ')') { depth -= 1; if (depth === 0) break; }
          j += 1;
        }
        buf += src.slice(pos, j + 1);
        pos = j + 1;
        continue;
      }
      if (ch === '}') { pos += 1; break; }
      if (ch === ';') { pushDecl(decls, buf, bufStart); buf = ''; pos += 1; bufStart = pos; continue; }
      if (ch === '{') {
        const prelude = buf.trim();
        const preludeLine = lineOf(bufStart);
        pos += 1;
        handleBlock(ctx, prelude, preludeLine, selectors);
        buf = '';
        bufStart = pos;
        continue;
      }
      buf += ch;
      pos += 1;
    }
    pushDecl(decls, buf, bufStart);
    if (selectors && decls.length) {
      for (const selector of selectors) rules.push({ file, selector, decls, line: blockLine, seq, ...ctx });
    }
  }

  function handleBlock(ctx, prelude, preludeLine, parentSelectors) {
    if (prelude.startsWith('@')) {
      const name = prelude.split(/[\s({]/)[0].toLowerCase();
      if (name === '@media' || name === '@supports' || name === '@container') {
        const next = { ...ctx };
        if (name === '@media') next.media = [...ctx.media, prelude.replace(/^@media\s*/i, '').trim()];
        else next.conditions = [...ctx.conditions, prelude];
        readBlock(next, parentSelectors ?? null, preludeLine);
        return;
      }
      if (name === '@layer') {
        const layerName = prelude.replace(/^@layer\s*/i, '').trim() || '(anonymous)';
        readBlock({ ...ctx, layer: layerName }, parentSelectors ?? null, preludeLine);
        return;
      }
      if (name === '@theme' || name === '@font-face' || name === '@property') {
        readBlock({ ...ctx, atRule: name }, [prelude], preludeLine);
        return;
      }
      skipBlock();
      return;
    }
    const raws = splitTop(prelude, ',').map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
    const selectors = raws.flatMap((s) => combine(parentSelectors, s));
    readBlock(ctx, selectors, preludeLine);
  }

  let buf = '';
  let bufStart = 0;
  const rootCtx = { layer: null, media: [], conditions: [], atRule: null };
  while (pos < src.length) {
    const ch = src[pos];
    if (ch === ';') { buf = ''; pos += 1; bufStart = pos; continue; }
    if (ch === '{') {
      const prelude = buf.trim();
      const preludeLine = lineOf(bufStart);
      pos += 1;
      handleBlock(rootCtx, prelude, preludeLine, null);
      buf = '';
      bufStart = pos;
      continue;
    }
    buf += ch;
    pos += 1;
  }
  return rules;
}

const parseCssFile = (file) => parseCssText(readFileSync(file, 'utf8'), file);

/* ====================================================== 2. SELECTOR ANALYSIS */

const COMBINATOR = /^[>+~]$/;

function splitCompounds(selector) {
  const parts = [];
  let buf = '';
  let depth = 0;
  for (let i = 0; i < selector.length; i += 1) {
    const ch = selector[i];
    if (ch === '\\') { buf += ch + (selector[i + 1] ?? ''); i += 1; continue; }
    if (ch === '(' || ch === '[') depth += 1;
    if (ch === ')' || ch === ']') depth -= 1;
    if (depth === 0 && (ch === ' ' || COMBINATOR.test(ch))) {
      if (buf) parts.push(buf);
      buf = '';
      continue;
    }
    buf += ch;
  }
  if (buf) parts.push(buf);
  return parts;
}

const COMPOUND_TOKEN = /(::?[-\w]+(?:\((?:[^()]|\([^()]*\))*\))?)|(\[[^\]]*\])|(\.(?:\\.|[-\w])+)|(#[-\w]+)|(\*)|(&)|([-\w]+)/g;

const unescapeClass = (s) => s.replace(/\\(.)/g, '$1');

function analyzeSelector(selector) {
  const compounds = splitCompounds(selector);
  const lastIndex = compounds.length - 1;
  const classes = [];
  const pseudoClasses = [];
  const attrs = [];
  let pseudoElement = null;
  let allClasses = 0;
  let allAttrs = 0;
  let allPseudoClasses = 0;
  let allTags = 0;
  let allIds = 0;

  compounds.forEach((compound, index) => {
    const isSubject = index === lastIndex;
    COMPOUND_TOKEN.lastIndex = 0;
    let m;
    while ((m = COMPOUND_TOKEN.exec(compound)) !== null) {
      const tok = m[0];
      if (tok.startsWith('::')) {
        allTags += 1;
        if (isSubject) pseudoElement = tok;
      } else if (tok.startsWith(':')) {
        const bare = tok.split('(')[0];
        if ([':before', ':after', ':first-line', ':first-letter'].includes(bare)) {
          allTags += 1;
          if (isSubject) pseudoElement = tok;
        } else if (bare === ':where') {
          if (isSubject) pseudoClasses.push(tok);
        } else {
          allPseudoClasses += 1;
          if (isSubject) pseudoClasses.push(tok);
        }
      } else if (tok.startsWith('[')) {
        allAttrs += 1;
        if (isSubject) attrs.push(tok);
      } else if (tok.startsWith('.')) {
        allClasses += 1;
        if (isSubject) classes.push(unescapeClass(tok.slice(1)));
      } else if (tok.startsWith('#')) {
        allIds += 1;
      } else if (tok === '*' || tok === '&') {
        /* zero specificity */
      } else {
        allTags += 1;
      }
    }
  });

  return {
    selector,
    classes,
    pseudoClasses,
    attrs,
    pseudoElement,
    hasAncestor: compounds.length > 1,
    specificity: [allIds, allClasses + allAttrs + allPseudoClasses, allTags],
  };
}

function specLess(a, b) {
  for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return a[i] < b[i];
  return false;
}

/* ====================================================== 3. CUSTOM PROPERTIES */

const GLOBAL_SELECTORS = /^(:root|:host|html|\*|::before|::after|::backdrop)$/;

function collectVars(ruleSets) {
  const globals = new Map();
  for (const rule of ruleSets) {
    const isGlobal = rule.atRule === '@theme' || GLOBAL_SELECTORS.test(rule.selector.trim());
    if (!isGlobal) continue;
    /* Dark-mode and print restatements are context-dependent, so they are not
       folded into the one global table. */
    if (rule.media.length || rule.conditions.length) continue;
    for (const d of rule.decls) {
      if (!d.prop.startsWith('--')) continue;
      globals.set(d.prop.replace(/\\/g, ''), d.value);
    }
  }
  for (const rule of ruleSets) {
    if (rule.atRule !== '@property') continue;
    const name = rule.selector.replace(/^@property\s*/i, '').trim();
    const init = rule.decls.find((d) => d.prop === 'initial-value');
    if (name.startsWith('--') && init && !globals.has(name)) globals.set(name, init.value);
  }
  return { globals };
}

function resolveVars(value, vars, depth = 0) {
  if (typeof value !== 'string' || depth > 16 || !value.includes('var(')) return value;
  const out = value.replace(/var\(\s*(--[-\w.\\]+)\s*(?:,((?:[^()]|\((?:[^()]|\([^()]*\))*\))*))?\)/g, (whole, name, fallback) => {
    const key = name.replace(/\\/g, '');
    if (vars.globals.has(key)) return vars.globals.get(key);
    if (fallback != null && fallback.trim()) return fallback.trim();
    return whole;
  });
  if (out === value) return out;
  return resolveVars(out, vars, depth + 1);
}

/* ==================================================== 4. VALUE NORMALISATION */

const NAMED_COLORS = { transparent: 'rgba(0,0,0,0)', white: '#ffffff', black: '#000000' };

/* Folds `calc(4px*32)`, `calc(32*4px)` and `calc(13px+8px)` into a single px
   length. Anything with mixed units, division by a variable, or a nested
   unresolved var is left exactly as it is rather than guessed at. */
function foldCalc(input) {
  let s = input;
  for (let pass = 0; pass < 6; pass += 1) {
    const next = s.replace(/calc\(\s*(-?[\d.]+)(px)?\s*([*+\-/])\s*(-?[\d.]+)(px)?\s*\)/g, (whole, a, ua, op, b, ub) => {
      const x = parseFloat(a);
      const y = parseFloat(b);
      if ((op === '*' && ua && ub) || (op === '/' && ub)) return whole;      /* px*px, /px: not a length */
      if ((op === '+' || op === '-') && Boolean(ua) !== Boolean(ub)) return whole; /* mixed units */
      const unit = ua || ub ? 'px' : '';
      const value = op === '*' ? x * y : op === '/' ? (y === 0 ? NaN : x / y) : op === '+' ? x + y : x - y;
      if (!Number.isFinite(value)) return whole;
      return `${Math.round(value * 10000) / 10000}${unit}`;
    });
    if (next === s) break;
    s = next;
  }
  return s;
}

function normalizeColor(s) {
  const hex = /^#([0-9a-f]{3,8})$/.exec(s);
  if (hex) {
    let h = hex[1];
    if (h.length === 3 || h.length === 4) h = h.split('').map((c) => c + c).join('');
    if (h.length === 8 && h.slice(6) === 'ff') h = h.slice(0, 6);
    return `#${h}`;
  }
  const fn = /^(rgba?|hsla?)\(([^)]*)\)$/.exec(s);
  if (fn) {
    const nums = fn[2].split(/[,\s/]+/).filter(Boolean).map((n) => {
      const f = parseFloat(n);
      return Number.isNaN(f) ? n : String(Math.round(f * 1000) / 1000);
    });
    if (fn[1].startsWith('rgb') && nums.length === 4 && nums[3] === '1') nums.pop();
    if (nums.length === 4) return `${fn[1].replace(/a?$/, 'a')}(${nums.join(',')})`;
    if (fn[1].startsWith('rgb') && nums.length === 3) {
      const [r, g, b] = nums.map(Number);
      if ([r, g, b].every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) {
        return `#${[r, g, b].map((n) => n.toString(16).padStart(2, '0')).join('')}`;
      }
    }
    return `${fn[1].replace(/a$/, '')}(${nums.join(',')})`;
  }
  return s;
}

function normalizeValue(v) {
  if (v === UNKNOWN_VALUE || v == null) return null;
  let s = String(v).trim().toLowerCase().replace(/\s+/g, ' ');
  s = s.replace(/\s*([,/])\s*/g, '$1');
  s = s.replace(/^["']|["']$/g, '');
  /* Nothing in this app sets a root font-size, so rem is always 16px; the
     conversion is what makes `1rem` and `16px` compare equal. */
  s = s.replace(/(^|[\s,(])(-?[\d.]+)rem\b/g, (_m, pre, n) => `${pre}${parseFloat(n) * 16}px`);
  s = s.replace(/(^|[\s,(])(-?[\d.]+)px\b/g, (_m, pre, n) => `${pre}${parseFloat(n)}px`);
  /* Tailwind's numeric scale compiles to `calc(var(--spacing) * 32)`, which is
     a real length once --spacing is substituted. Folding the arithmetic is what
     lets `w-32` compare against a plain `128px`. */
  s = foldCalc(s);
  if (/^-?0(px|rem|em|%|vh|vw)?$/.test(s)) return '0';
  if (NAMED_COLORS[s]) return normalizeColor(NAMED_COLORS[s]);
  if (/^#|^rgba?\(|^hsla?\(/.test(s)) return normalizeColor(s);
  return s;
}

/* =========================================== 5. TAILWIND AS UTILITY ORACLE */

/* Instead of guessing what a token means, ask the compiler that will actually
   ship it. Every distinct token found in the source goes in; whatever comes
   back out of `@layer utilities` is what that token really does. Tokens that
   produce nothing are not utilities at all, and are reported as such rather
   than matched against a lookup table that would invent a property for them. */
async function compileUtilities(tokens) {
  const { compile } = await import(path.join(NODE_MODULES, 'tailwindcss/dist/lib.mjs'));
  const loadStylesheet = async (id, base) => {
    let p;
    if (id === 'tailwindcss') p = path.join(NODE_MODULES, 'tailwindcss/index.css');
    else if (id.startsWith('tailwindcss/')) p = path.join(NODE_MODULES, id);
    else p = path.resolve(base, id);
    return { path: p, base: path.dirname(p), content: readFileSync(p, 'utf8') };
  };
  const compiler = await compile(readFileSync(GLOBALS_CSS, 'utf8'), {
    base: CSS_BASE,
    onDependency() {},
    loadStylesheet,
    loadModule: async () => ({}),
  });
  return compiler.build([...tokens]);
}

/* Turns the compiled sheet into: token -> [{ property, value, states, attrs,
   media, self }]. `self` is false when the utility targets descendants - which
   is how `space-y-6`, whose real selector is
   `.space-y-6 > :not(:last-child)`, correctly stops being reported as a
   collision on the element's own margin. */
function extractUtilityEffects(compiledCss, tokens) {
  const rules = parseCssText(compiledCss, '<tailwind>');
  const vars = collectVars(rules);
  const wanted = new Set(tokens);
  const effects = new Map();
  const emitted = new Set();

  for (const rule of rules) {
    if (rule.layer !== 'utilities') continue;
    const info = analyzeSelector(rule.selector);
    const local = new Map();
    for (const d of rule.decls) if (d.prop.startsWith('--')) local.set(d.prop, d.value);
    const localVars = { globals: new Map([...vars.globals, ...local]) };

    /* The token can appear anywhere in the compiled selector, not only as the
       subject: `space-y-6` compiles to
       `:where(.space-y-6 > :not(:last-child))`. Finding it there is what lets
       the report say "this compiles, but it targets children" instead of the
       false "Tailwind emits nothing for it". */
    const hit = allClassesIn(rule.selector).find((c) => wanted.has(c));
    if (!hit) continue;
    emitted.add(hit);
    const self = info.classes.includes(hit) && !info.hasAncestor && !info.pseudoElement;

    for (const d of rule.decls) {
      if (d.prop.startsWith('--')) continue;
      for (const [prop, value] of expandDeclaration(d.prop, d.value)) {
        if (!effects.has(hit)) effects.set(hit, []);
        effects.get(hit).push({
          property: prop,
          shorthandOf: d.prop,
          rawValue: value,
          value: value === UNKNOWN_VALUE ? null : resolveVars(value, localVars),
          states: info.pseudoClasses.map((p) => p.replace(/^:+/, '').split('(')[0]).filter((p) => p !== 'where'),
          attrs: info.attrs,
          media: rule.media.filter((m) => !/hover\s*:\s*hover/.test(m)),
          self,
          important: d.important,
        });
      }
    }
  }
  return { effects, vars, emitted };
}

const ALL_CLASSES = /\.((?:\\.|[-\w])+)/g;
function allClassesIn(selector) {
  ALL_CLASSES.lastIndex = 0;
  const out = [];
  let m;
  while ((m = ALL_CLASSES.exec(selector)) !== null) out.push(unescapeClass(m[1]));
  return out;
}

/* ==================================================== 6. className RESOLUTION */

const MAX_VARIANTS = 64;
const UNRESOLVED = Symbol('unresolved');

/* Substituted for an interpolation that cannot be resolved, so the LITERAL
   tokens around it are still measured instead of the whole site being thrown
   away. `room room--${room}` yields `room` and `room--x-unresolved-x`; the
   first is real, the second matches no ppbf class and no Tailwind utility, so
   it can only ever be silent. Every site this happens to is counted as
   partially resolved and listed. */
const PARTIAL = 'x-unresolved-x';

/* Variadic class-string joiners. `cx` is this repo's, in
   components/uiStyles.ts; the others are here so a later `clsx`/`cn` import
   does not silently become an unresolved site. */
const JOINER_NAMES = new Set(['cx', 'cn', 'clsx', 'classNames', 'classnames']);

const mark = (arr, partial) => { if (partial) arr.partial = true; return arr; };

function cartesian(listOfSets) {
  let acc = [''];
  for (const set of listOfSets) {
    const next = [];
    for (const prefix of acc) {
      for (const s of set) {
        next.push(prefix + s);
        if (next.length > MAX_VARIANTS) return next.slice(0, MAX_VARIANTS);
      }
    }
    acc = next;
  }
  return acc;
}

function createResolver(sourceFile, resolveImport) {
  const bindings = new Map();
  const functions = new Map();
  const importAliases = new Map();

  function walkDeclarations(node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      if (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)) {
        if (!functions.has(node.name.text)) functions.set(node.name.text, node.initializer);
      } else if (!bindings.has(node.name.text)) {
        bindings.set(node.name.text, node.initializer);
      }
    }
    if (ts.isFunctionDeclaration(node) && node.name && !functions.has(node.name.text)) functions.set(node.name.text, node);
    if (ts.isImportDeclaration(node) && node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings)) {
      const spec = node.moduleSpecifier;
      if (ts.isStringLiteral(spec)) {
        for (const el of node.importClause.namedBindings.elements) {
          importAliases.set(el.name.text, { module: spec.text, exported: (el.propertyName ?? el.name).text });
        }
      }
    }
    ts.forEachChild(node, walkDeclarations);
  }
  walkDeclarations(sourceFile);

  const evaluating = new Set();

  function evaluate(node, depth = 0) {
    if (!node || depth > 32) return UNRESOLVED;
    if (ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node) || ts.isAsExpression(node)) {
      return evaluate(node.expression, depth + 1);
    }
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return [node.text];
    if (ts.isNumericLiteral(node)) return [node.text];
    if (node.kind === ts.SyntaxKind.TrueKeyword) return ['true'];
    if (node.kind === ts.SyntaxKind.FalseKeyword) return ['false'];
    if (node.kind === ts.SyntaxKind.NullKeyword) return [''];

    if (ts.isTemplateExpression(node)) {
      const pieces = [[node.head.text]];
      let partial = false;
      for (const span of node.templateSpans) {
        let part = evaluate(span.expression, depth + 1);
        if (part === UNRESOLVED) { part = [PARTIAL]; partial = true; }
        else if (part.partial) partial = true;
        pieces.push(part, [span.literal.text]);
      }
      return mark(cartesian(pieces), partial);
    }

    if (ts.isBinaryExpression(node)) {
      const op = node.operatorToken.kind;
      if (op === ts.SyntaxKind.PlusToken) {
        const l = evaluate(node.left, depth + 1);
        const r = evaluate(node.right, depth + 1);
        if (l === UNRESOLVED || r === UNRESOLVED) return UNRESOLVED;
        return cartesian([l, r]);
      }
      if (op === ts.SyntaxKind.AmpersandAmpersandToken) {
        const r = evaluate(node.right, depth + 1);
        return r === UNRESOLVED ? UNRESOLVED : ['', ...r];
      }
      if (op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.QuestionQuestionToken) {
        const l = evaluate(node.left, depth + 1);
        const r = evaluate(node.right, depth + 1);
        if (l === UNRESOLVED || r === UNRESOLVED) return UNRESOLVED;
        return [...l, ...r];
      }
      return UNRESOLVED;
    }

    /* One resolvable branch is worth keeping even when its sibling is not:
       RoleStandaloneView's <main> picks between three class strings on a prop
       this scanner cannot see, and two of the three are plain literals. */
    if (ts.isConditionalExpression(node)) {
      const a = evaluate(node.whenTrue, depth + 1);
      const b = evaluate(node.whenFalse, depth + 1);
      if (a === UNRESOLVED && b === UNRESOLVED) return UNRESOLVED;
      if (a === UNRESOLVED) return mark([...b], true);
      if (b === UNRESOLVED) return mark([...a], true);
      return mark([...a, ...b], a.partial || b.partial);
    }

    if (ts.isIdentifier(node)) {
      const name = node.text;
      if (name === 'undefined') return [''];
      if (evaluating.has(name)) return UNRESOLVED;
      if (bindings.has(name)) {
        evaluating.add(name);
        const v = evaluate(bindings.get(name), depth + 1);
        evaluating.delete(name);
        return v;
      }
      if (importAliases.has(name) && resolveImport) {
        const { module, exported } = importAliases.get(name);
        const v = resolveImport(module, exported);
        if (v) return v;
      }
      return UNRESOLVED;
    }

    /* MAP[key] / MAP.key - the union of everything the object literal can
       yield, because the key is usually a runtime role or status. */
    if (ts.isElementAccessExpression(node) || ts.isPropertyAccessExpression(node)) {
      const objName = ts.isIdentifier(node.expression) ? node.expression.text : null;
      const init = objName ? bindings.get(objName) : null;
      if (init && ts.isObjectLiteralExpression(init)) {
        const out = [];
        for (const p of init.properties) {
          if (!ts.isPropertyAssignment(p)) return UNRESOLVED;
          const v = evaluate(p.initializer, depth + 1);
          if (v === UNRESOLVED) return UNRESOLVED;
          out.push(...v);
        }
        return out;
      }
      return UNRESOLVED;
    }

    if (ts.isCallExpression(node)) {
      const callee = node.expression;

      /* cx(a, cond && b, c) - the repo's variadic joiner. Each argument is
         evaluated on its own and the results are joined with a space, so a
         single unresolvable argument costs one token rather than the whole
         site. */
      if (ts.isIdentifier(callee) && JOINER_NAMES.has(callee.text)) {
        const pieces = [];
        let partial = false;
        for (const [i, a] of node.arguments.entries()) {
          if (ts.isSpreadElement(a)) { partial = true; continue; }
          let v = evaluate(a, depth + 1);
          if (v === UNRESOLVED) { v = [PARTIAL]; partial = true; }
          else if (v.partial) partial = true;
          if (i > 0) pieces.push([' ']);
          pieces.push(v);
        }
        if (!pieces.length) return [''];
        return mark(cartesian(pieces), partial);
      }

      /* [a, b].filter(Boolean).join(' ') and friends */
      if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'join') {
        const sep = node.arguments[0] && ts.isStringLiteral(node.arguments[0]) ? node.arguments[0].text : ',';
        let target = callee.expression;
        while (ts.isCallExpression(target) && ts.isPropertyAccessExpression(target.expression)
               && target.expression.name.text === 'filter') {
          target = target.expression.expression;
        }
        if (ts.isArrayLiteralExpression(target)) {
          const pieces = [];
          for (const [i, el] of target.elements.entries()) {
            if (ts.isSpreadElement(el)) return UNRESOLVED;
            const v = evaluate(el, depth + 1);
            if (v === UNRESOLVED) return UNRESOLVED;
            if (i > 0) pieces.push([sep]);
            pieces.push(v);
          }
          return cartesian(pieces);
        }
        return UNRESOLVED;
      }
      /* A local helper returning a class string: inline it. Parameters stay
         unbound, so anything depending on one falls through to UNRESOLVED
         rather than being invented - but `cond ? 'a' : 'b'` inside the body
         still yields both branches, which is what SignInPanel's
         `methodButton(method)` needs. */
      if (ts.isIdentifier(callee) && functions.has(callee.text)) {
        const key = `fn:${callee.text}`;
        if (evaluating.has(key)) return UNRESOLVED;
        const fn = functions.get(callee.text);
        evaluating.add(key);
        let result = UNRESOLVED;
        if (ts.isArrowFunction(fn) && fn.body && !ts.isBlock(fn.body)) {
          result = evaluate(fn.body, depth + 1);
        } else if (fn.body && ts.isBlock(fn.body)) {
          const returns = [];
          const collect = (n) => {
            if (ts.isReturnStatement(n) && n.expression) returns.push(n.expression);
            if (!ts.isFunctionDeclaration(n) && !ts.isArrowFunction(n) && !ts.isFunctionExpression(n)) ts.forEachChild(n, collect);
          };
          ts.forEachChild(fn.body, collect);
          const out = [];
          let ok = returns.length > 0;
          for (const r of returns) {
            const v = evaluate(r, depth + 1);
            if (v === UNRESOLVED) { ok = false; break; }
            out.push(...v);
          }
          result = ok ? out : UNRESOLVED;
        }
        evaluating.delete(key);
        return result;
      }
      return UNRESOLVED;
    }

    return UNRESOLVED;
  }

  return { evaluate };
}

/* ================================================================ 7. SCAN */

/* `.tsx` files are the ones scanned for `className` sites. `.ts` files are
   loaded too, but only so an `import { UI, cx } from './uiStyles'` resolves to
   real strings instead of counting as unresolved. */
function walkFiles(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (['node_modules', '.next', 'coverage', '.git'].includes(entry)) continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walkFiles(full, out);
    else if (/\.tsx?$/.test(entry) && !/\.(test|spec|stories)\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

const isScanned = (file) => file.endsWith('.tsx');

function loadSources(files) {
  const sources = new Map();
  for (const file of files) {
    sources.set(file, ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX));
  }
  return sources;
}

/* Exported module-level string constants, so `import { BAND } from './x'`
   resolves across files instead of counting as unresolved. */
function makeExportIndex(sources) {
  const cache = new Map();
  return function exportsOf(file) {
    if (cache.has(file)) return cache.get(file);
    const map = new Map();
    cache.set(file, map);
    const sf = sources.get(file);
    if (!sf) return map;
    const resolver = createResolver(sf, null);
    const visit = (node) => {
      if (ts.isVariableStatement(node) && node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) {
        for (const d of node.declarationList.declarations) {
          if (ts.isIdentifier(d.name) && d.initializer) {
            const v = resolver.evaluate(d.initializer);
            if (v !== UNRESOLVED) map.set(d.name.text, v);
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
    return map;
  };
}

async function main() {
  const argv = process.argv.slice(2);
  const has = (f) => argv.includes(`--${f}`);
  const arg = (f) => { const i = argv.indexOf(`--${f}`); return i === -1 ? null : argv[i + 1]; };

  if (has('self-test')) return selfTest();

  /* --- CSS: the unlayered cascade ---------------------------------------- */
  const ppbfRules = parseCssFile(PPBF_CSS);
  const globalRules = parseCssFile(GLOBALS_CSS);

  /* ppbf.css declares no @layer at all. globals.css @imports it at the top and
     is therefore later in source order, so globals.css wins ties - which is
     why both sheets are read here. A report that looked only at ppbf.css would
     name the wrong file for every property globals.css restates. */
  const unlayered = [];
  let layeredClassRules = 0;
  for (const rule of [...ppbfRules, ...globalRules]) {
    if (rule.atRule) continue;
    const info = analyzeSelector(rule.selector);
    if (!info.classes.length) continue;   /* bare element / `*` rules lose to any class utility */
    if (rule.layer) { layeredClassRules += 1; continue; }
    if (info.pseudoElement) continue;     /* ::before cannot defeat a utility on the element */
    unlayered.push({ ...rule, info });
  }

  /* --- JSX ---------------------------------------------------------------- */
  const roots = [path.join(WEB_ROOT, 'app'), path.join(WEB_ROOT, 'components'), path.join(WEB_ROOT, 'src')]
    .filter((p) => { try { return statSync(p).isDirectory(); } catch { return false; } });
  const allFiles = roots.flatMap((r) => walkFiles(r)).sort();
  const files = allFiles.filter(isScanned);
  const sources = loadSources(allFiles);
  const exportsOf = makeExportIndex(sources);

  const stats = {
    files: files.length,
    supportFiles: allFiles.length - files.length,
    classNameSites: 0,
    resolvedSites: 0,
    partialSites: 0,
    unresolvedSites: 0,
    unresolvedDetail: [],
    partialDetail: [],
    variantStrings: 0,
  };

  /* Pass one: resolve every className to concrete strings and bank the token
     set, so Tailwind is asked exactly once about exactly the tokens that
     actually appear. */
  const sites = [];
  const allTokens = new Set();

  for (const file of files) {
    const sf = sources.get(file);
    const resolveImport = (moduleSpec, exported) => {
      if (!moduleSpec.startsWith('.') && !moduleSpec.startsWith('@/')) return null;
      const rel = moduleSpec.startsWith('@/') ? path.join(WEB_ROOT, moduleSpec.slice(2)) : path.resolve(path.dirname(file), moduleSpec);
      for (const ext of ['.tsx', '.ts', '/index.tsx', '/index.ts']) {
        const candidate = rel + ext;
        if (sources.has(candidate)) {
          const m = exportsOf(candidate);
          if (m.has(exported)) return m.get(exported);
        }
      }
      return null;
    };
    const resolver = createResolver(sf, resolveImport);

    const visit = (node) => {
      if (ts.isJsxAttribute(node) && ts.isIdentifier(node.name) && (node.name.text === 'className' || node.name.text === 'class')) {
        const owner = node.parent?.parent;
        const tag = owner && (ts.isJsxSelfClosingElement(owner) || ts.isJsxOpeningElement(owner)) ? owner.tagName.getText(sf) : '?';
        const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
        stats.classNameSites += 1;

        /* An inline `style={{...}}` on the same element outranks every sheet,
           so a property set there cannot be a layer casualty. */
        const inlineProps = new Set();
        for (const a of node.parent.properties) {
          if (ts.isJsxAttribute(a) && ts.isIdentifier(a.name) && a.name.text === 'style' && a.initializer
              && ts.isJsxExpression(a.initializer) && a.initializer.expression
              && ts.isObjectLiteralExpression(a.initializer.expression)) {
            for (const p of a.initializer.expression.properties) {
              if (ts.isPropertyAssignment(p)) {
                const key = (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) ? p.name.text : null;
                if (key) inlineProps.add(key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`));
              }
            }
          }
        }

        let values;
        if (node.initializer && ts.isStringLiteral(node.initializer)) values = [node.initializer.text];
        else if (node.initializer && ts.isJsxExpression(node.initializer) && node.initializer.expression) {
          const v = resolver.evaluate(node.initializer.expression);
          values = v === UNRESOLVED ? UNRESOLVED : v;
        } else values = UNRESOLVED;

        if (values === UNRESOLVED) {
          stats.unresolvedSites += 1;
          stats.unresolvedDetail.push({
            file: path.relative(REPO_ROOT, file), line, tag,
            expression: (node.initializer?.getText(sf) ?? '(none)').slice(0, 140).replace(/\s+/g, ' '),
          });
        } else {
          stats.resolvedSites += 1;
          if (values.partial) {
            stats.partialSites += 1;
            stats.partialDetail.push({
              file: path.relative(REPO_ROOT, file), line, tag,
              expression: (node.initializer?.getText(sf) ?? '(none)').slice(0, 140).replace(/\s+/g, ' '),
            });
          }
          const uniq = [...new Set(values.map((v) => v.trim().replace(/\s+/g, ' ')))].filter(Boolean);
          stats.variantStrings += uniq.length;
          for (const variant of uniq) {
            const tokens = variant.split(' ').filter(Boolean);
            for (const t of tokens) allTokens.add(t);
            sites.push({ file, line, tag, variant, tokens, inlineProps });
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }

  /* --- Ask Tailwind what those tokens really do --------------------------- */
  const compiled = await compileUtilities(allTokens);
  const { effects, vars, emitted } = extractUtilityEffects(compiled, allTokens);
  /* Three different things, deliberately not merged:
       - not a utility at all (Tailwind emits nothing);
       - a utility that compiles but only ever styles DESCENDANTS or sets
         `--tw-*` plumbing, so it cannot be defeated on this element;
       - a utility that styles the element, which is the only kind that can
         collide. */
  const notUtilities = [...allTokens].filter((t) => !emitted.has(t));
  /* Of the tokens that are not utilities, the interesting ones are those that
     no rule in either sheet mentions at ALL - not as a subject, not under an
     ancestor, not on a ::before. Those style nothing, by any route. */
  const namedInCss = new Set([...ppbfRules, ...globalRules].flatMap((r) => allClassesIn(r.selector)));
  const descendantOnly = [...emitted].filter((t) => !(effects.get(t) ?? []).some((e) => e.self)).sort();

  /* --- Index the unlayered side by class --------------------------------- */
  const byClass = new Map();
  for (const rule of unlayered) {
    for (const d of rule.decls) {
      if (d.prop.startsWith('--')) continue;
      for (const [prop, value] of expandDeclaration(d.prop, d.value)) {
        for (const cls of rule.info.classes) {
          if (!byClass.has(cls)) byClass.set(cls, []);
          byClass.get(cls).push({
            cls, prop, value, important: d.important, line: d.line, file: rule.file,
            selector: rule.selector, media: rule.media,
            pseudoClasses: rule.info.pseudoClasses.map((p) => p.replace(/^:+/, '').split('(')[0]).filter((p) => p !== 'where'),
            attrs: rule.info.attrs,
            requiresAncestor: rule.info.hasAncestor,
            siblingClasses: rule.info.classes.filter((c) => c !== cls),
            specificity: rule.info.specificity, seq: rule.seq, shorthandOf: d.prop,
          });
        }
      }
    }
  }
  const ppbfClassNames = new Set(byClass.keys());

  /* --- Match -------------------------------------------------------------- */
  const collisions = [];
  const seen = new Set();

  for (const site of sites) {
    /* A token counts as a ppbf class here when it carries unlayered
       declarations and is NOT itself a Tailwind utility. `.sr-only` exists in
       both worlds; the ppbf copy simply wins, and a class cannot collide with
       itself. */
    const ppbfClasses = site.tokens.filter((t) => ppbfClassNames.has(t) && !emitted.has(t));
    if (!ppbfClasses.length) continue;

    for (const token of site.tokens) {
      const utilEffects = effects.get(token);
      if (!utilEffects) continue;
      if (ppbfClasses.includes(token)) continue;

      for (const eff of utilEffects) {
        if (!eff.self) continue;                  /* targets descendants, e.g. space-y-* */
        if (eff.attrs.length) continue;           /* [data-...] utility state, not statically decidable */
        if (site.inlineProps.has(eff.property)) continue;
        if (site.inlineProps.has(eff.property.replace(/^(padding|margin)-(top|right|bottom|left)$/, '$1'))) continue;

        {
          /* ONE winner per element + property, not one per class. An element
             carrying `room room--office` has two unlayered rules setting
             background-color, but only one of them actually paints - so
             reporting both would count the same defeated utility twice. The
             winner is chosen across every ppbf class on the element by
             !important, then specificity, then source order, which is the
             cascade's own tie-break. */
          let winner = null;
          for (const cls of ppbfClasses) {
            for (const decl of byClass.get(cls)) {
              if (decl.prop !== eff.property) continue;
              if (decl.requiresAncestor) continue;
              if (decl.siblingClasses.length && !decl.siblingClasses.every((c) => site.tokens.includes(c))) continue;
              if (decl.attrs.length) continue;
              /* The ppbf rule must apply wherever the utility does. An
                 unconditional ppbf rule (no pseudo-class) therefore defeats
                 BOTH a plain utility and a `hover:` one - the hover utility is
                 dead at every moment including hover. A ppbf `:hover` rule is
                 NOT counted against a plain utility, because the plain utility
                 still renders at rest and only yields during hover, which is
                 normally the point. */
              if (!decl.pseudoClasses.every((s) => eff.states.includes(s))) continue;
              if (decl.media.length && !decl.media.every((m) => eff.media.includes(m))) continue;
              if (!winner) { winner = decl; continue; }
              if (winner.important !== decl.important) { if (decl.important) winner = decl; continue; }
              if (specLess(winner.specificity, decl.specificity)) { winner = decl; continue; }
              if (!specLess(decl.specificity, winner.specificity) && decl.seq >= winner.seq) winner = decl;
            }
          }
          if (!winner) continue;

          const id = `${site.file}:${site.line}:${eff.property}:${token}`;
          if (seen.has(id)) continue;
          seen.add(id);

          const ppbfResolved = winner.value === UNKNOWN_VALUE ? null : resolveVars(winner.value, vars);
          const utilResolved = eff.value;
          collisions.push({
            file: path.relative(REPO_ROOT, site.file),
            line: site.line,
            tag: site.tag,
            variant: site.variant.length > 200 ? `${site.variant.slice(0, 200)}...` : site.variant,
            ppbfClass: winner.cls,
            otherPpbfClassesOnElement: ppbfClasses.filter((c) => c !== winner.cls),
            utilityVarUnresolved: typeof utilResolved === 'string' && /var\(--/.test(utilResolved)
              ? [...utilResolved.matchAll(/var\((--[-\w]+)/g)].map((m) => m[1])
              : [],
            ppbfSelector: winner.selector,
            ppbfFile: path.relative(REPO_ROOT, winner.file),
            ppbfLine: winner.line,
            ppbfShorthand: winner.shorthandOf,
            ppbfImportant: winner.important,
            ppbfMedia: winner.media,
            property: eff.property,
            ppbfValueRaw: winner.value === UNKNOWN_VALUE
              ? `(from the \`${winner.shorthandOf}\` shorthand - per-longhand value not decomposable)`
              : winner.value,
            ppbfValue: normalizeValue(ppbfResolved),
            utility: token,
            utilityShorthand: eff.shorthandOf,
            utilityValueRaw: eff.rawValue === UNKNOWN_VALUE ? `(from the \`${eff.shorthandOf}\` shorthand)` : eff.rawValue,
            utilityValue: normalizeValue(eff.value),
            utilityStates: eff.states,
            utilityMedia: eff.media,
          });
        }
      }
    }
  }

  for (const c of collisions) c.bucket = classify(c);
  const buckets = { HARMLESS: [], DEAD: [], BROKEN: [] };
  for (const c of collisions) buckets[c.bucket].push(c);
  const order = (a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.property.localeCompare(b.property);
  for (const k of Object.keys(buckets)) buckets[k].sort(order);

  const report = {
    sources: {
      ppbf: path.relative(REPO_ROOT, PPBF_CSS),
      globals: path.relative(REPO_ROOT, GLOBALS_CSS),
      tailwind: JSON.parse(readFileSync(path.join(NODE_MODULES, 'tailwindcss/package.json'), 'utf8')).version,
    },
    stats: {
      filesScanned: stats.files,
      supportFilesLoaded: stats.supportFiles,
      classNameSites: stats.classNameSites,
      resolvedSites: stats.resolvedSites,
      partiallyResolvedSites: stats.partialSites,
      unresolvedSites: stats.unresolvedSites,
      classStringVariants: stats.variantStrings,
      distinctTokens: allTokens.size,
      tokensTailwindEmits: emitted.size,
      tokensTailwindIgnores: notUtilities.length,
      tokensDescendantOnly: descendantOnly.length,
      unlayeredClassRules: unlayered.length,
      layeredClassRulesExcluded: layeredClassRules,
      classesCarryingUnlayeredDeclarations: byClass.size,
      collisions: collisions.length,
      HARMLESS: buckets.HARMLESS.length,
      DEAD: buckets.DEAD.length,
      BROKEN: buckets.BROKEN.length,
    },
    buckets,
    unresolved: stats.unresolvedDetail,
    partiallyResolved: stats.partialDetail,
    notUtilities: notUtilities
      .filter((t) => !t.includes(PARTIAL))
      .map((t) => ({ token: t, inCss: namedInCss.has(t) }))
      .sort((a, b) => Number(a.inCss) - Number(b.inCss) || a.token.localeCompare(b.token)),
    descendantOnly,
    /* A second, independent defect surfaced on the way: a utility naming a
       custom property that no sheet ever defines. `--tw-*` is Tailwind's own
       machinery and `--font-geist-*` is injected at runtime by next/font on
       <html>, so neither is a finding; anything else is dead before the
       cascade is consulted. */
    undefinedVars: (() => {
      const out = new Map();
      for (const c of collisions) {
        for (const v of c.utilityVarUnresolved) {
          if (v.startsWith('--tw-') || v.startsWith('--font-geist')) continue;
          if (!out.has(v)) out.set(v, []);
          out.get(v).push(`${c.file}:${c.line} (${c.utility})`);
        }
      }
      return [...out.entries()].map(([name, at]) => ({ name, sites: [...new Set(at)] }));
    })(),
    deadByProperty: Object.entries(
      buckets.DEAD.reduce((acc, c) => { acc[c.property] = (acc[c.property] ?? 0) + 1; return acc; }, {}),
    ).sort((a, b) => b[1] - a[1]),
  };

  if (has('json')) { process.stdout.write(`${JSON.stringify(report, null, 2)}\n`); return; }
  const md = renderMarkdown(report);
  const target = arg('markdown');
  if (target) { writeFileSync(target, md); process.stderr.write(`wrote ${target}\n`); }
  else process.stdout.write(md);
}

/* =========================================================== 8. CLASSIFIER */

/* Properties where losing the utility MOVES something: where a box sits, how
   big it is, whether it is laid out at all. A wrong colour is a defect too,
   but the design system is the authority on colour by construction - a ppbf
   class winning a colour is the system working as designed. A ppbf class
   winning a POSITION is the system silently overruling a layout instruction
   somebody wrote on purpose. That is the line between DEAD and BROKEN. */
const GEOMETRY_PROPERTIES = new Set([
  'position', 'display', 'top', 'right', 'bottom', 'left', 'z-index',
  'min-height', 'min-width', 'max-width', 'max-height', 'width', 'height',
  'flex-direction', 'flex-wrap', 'align-items', 'justify-content', 'align-self',
  'grid-template-columns', 'grid-template-rows',
  'overflow-x', 'overflow-y', 'flex-grow', 'flex-shrink', 'flex-basis',
  'row-gap', 'column-gap',
  'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
]);

/* A utility restating the initial value of a property the ppbf class
   deliberately owns is not a lost instruction - it is noise that happens to
   disagree. */
const DEFAULTISH = new Set(['static', 'normal', 'auto', 'none', 'visible', 'stretch', 'row', 'nowrap', '0']);

/* `min-*` and `max-*` state a BOUND, not a value, so "different" is not the
   same as "lost". A utility asking `min-h-[44px]` on a control the design
   system already floors at 46px got what it asked for: at least 44px. The
   utility is redundant, not defeated in effect, and calling it BROKEN would
   bury the real cases. The reverse — a 44px request against a 38px ppbf floor,
   which is the /parent/consent Grant Consent button — is a floor that does not
   hold, and that IS the bug. */
const FLOOR_PROPERTIES = new Set(['min-height', 'min-width']);
const CEILING_PROPERTIES = new Set(['max-height', 'max-width']);

const pxOf = (v) => {
  const m = /^(-?[\d.]+)px$/.exec(String(v ?? ''));
  return m ? parseFloat(m[1]) : (String(v) === '0' ? 0 : null);
};

export function classify(c) {
  /* Both sides land on the same computed value: the cascade decided nothing. */
  if (c.ppbfValue != null && c.utilityValue != null && c.ppbfValue === c.utilityValue) return 'HARMLESS';

  const ppbfPx = pxOf(c.ppbfValue);
  const utilPx = pxOf(c.utilityValue);
  if (ppbfPx != null && utilPx != null) {
    if (FLOOR_PROPERTIES.has(c.property) && ppbfPx >= utilPx) return 'HARMLESS';
    if (CEILING_PROPERTIES.has(c.property) && ppbfPx <= utilPx) return 'HARMLESS';
  }
  /* One side is a shorthand whose per-longhand value cannot be decomposed
     (`background:`, `transition:`, `font:`). A property-level collision is
     real, but there is no evidence a specific value was lost. */
  if (c.ppbfValue == null || c.utilityValue == null) return 'DEAD';
  if (GEOMETRY_PROPERTIES.has(c.property) && !DEFAULTISH.has(c.utilityValue)) return 'BROKEN';
  return 'DEAD';
}

/* ============================================================ 9. RENDERING */

const esc = (s) => String(s).replace(/\|/g, '\\|');

/* Names the longhand that actually collided, and says so when it came out of a
   shorthand - otherwise `.alert { margin: var(--s5) 0 }` prints as
   "margin: var(--s5)", which is a declaration nobody wrote. */
const declText = (shorthand, property, value) =>
  (shorthand === property
    ? `\`${property}: ${value}\``
    : `\`${property}: ${value}\` (from the \`${shorthand}\` shorthand)`);

function renderMarkdown(report) {
  const s = report.stats;
  const L = [];
  L.push('# CSS layer collisions: Tailwind utilities that never apply');
  L.push('');
  L.push('_Generated by `apps/web/scripts/css-layer-collisions.mjs`. Regenerate with:_');
  L.push('');
  L.push('```');
  L.push('cd apps/web && node scripts/css-layer-collisions.mjs --markdown ../../docs/current/CSS-LAYER-COLLISIONS.md');
  L.push('```');
  L.push('');
  L.push('**Nothing here was seen rendered.** Every value below is computed from');
  L.push('`' + report.sources.ppbf + '`, `' + report.sources.globals + '`, and the');
  L.push('output of the installed Tailwind compiler (v' + report.sources.tailwind + ') run over the');
  L.push('app\'s real CSS. No browser was opened and no page was loaded.');
  L.push('');
  L.push('## The defect');
  L.push('');
  L.push('Tailwind v4 emits `@layer theme, base, components, utilities;` and puts every');
  L.push('utility inside `@layer utilities`. `ppbf.css` declares no layer at all, and');
  L.push('`globals.css` layers only two `@layer base` blocks. Layer order is resolved');
  L.push('*before* specificity, and unlayered beats layered, so a single-class ppbf');
  L.push('selector defeats any utility naming the same property regardless of how the');
  L.push('selectors compare. The utility still reads as correct in the JSX.');
  L.push('');
  L.push('| | |');
  L.push('|---|---|');
  L.push(`| Files scanned (\`.tsx\`, tests excluded) | ${s.filesScanned} |`);
  L.push(`| \`.ts\` files loaded so imports resolve (not scanned) | ${s.supportFilesLoaded} |`);
  L.push(`| \`className\` sites | ${s.classNameSites} |`);
  L.push(`| ...statically resolved | ${s.resolvedSites} |`);
  L.push(`| ...of those, **partially** resolved (one branch or interpolation lost) | ${s.partiallyResolvedSites} |`);
  L.push(`| ...**unresolved** (counted and listed, never skipped) | ${s.unresolvedSites} |`);
  L.push(`| Distinct class strings after ternary/template expansion | ${s.classStringVariants} |`);
  L.push(`| Distinct tokens seen | ${s.distinctTokens} |`);
  L.push(`| ...that Tailwind actually compiles to CSS | ${s.tokensTailwindEmits} |`);
  L.push(`| ...of those, ones that only style DESCENDANTS or \`--tw-*\` plumbing | ${s.tokensDescendantOnly} |`);
  L.push(`| ...that Tailwind emits nothing for (project classes, typos) | ${s.tokensTailwindIgnores} |`);
  L.push(`| Unlayered class-bearing CSS rules | ${s.unlayeredClassRules} |`);
  L.push(`| Class-bearing rules inside \`@layer\` (excluded, cannot cause this) | ${s.layeredClassRulesExcluded} |`);
  L.push(`| Classes carrying unlayered declarations | ${s.classesCarryingUnlayeredDeclarations} |`);
  L.push(`| **Collisions** | **${s.collisions}** |`);
  L.push(`| - BROKEN | **${s.BROKEN}** |`);
  L.push(`| - DEAD | ${s.DEAD} |`);
  L.push(`| - HARMLESS | ${s.HARMLESS} |`);
  L.push('');
  L.push('## The three seed examples, re-checked');
  L.push('');
  L.push('This scan was commissioned off three instances found by eye. Two of them no');
  L.push('longer exist on `main`, which matters: the *class* is alive, the *examples* are');
  L.push('not, and a reader who greps for them and finds nothing should not conclude the');
  L.push('defect was imagined.');
  L.push('');
  L.push('- **`.stamp` vs `absolute` on the sign-in board.** Not present. The whole styled');
  L.push('  board was reverted in #520 (`5e94aae6`), which deleted the');
  L.push('  `stamp ... absolute -bottom-[18px] right-[24px]` span. That commit message');
  L.push('  states the mechanism in full, so it is where the defect was first written down.');
  L.push('- **`.btn--lever` vs `min-h-[44px]` on `/parent/consent`.** Fixed in #525');
  L.push('  (`a11ea7c1`), the tip of `main` this scan runs against; the button is now');
  L.push('  `.btn .btn--kiosk` and the page carries a comment explaining why. But the');
  L.push('  pattern it was an instance of is still live at **25 other call sites**, all');
  L.push('  listed under BROKEN below - `/parent/consent` was fixed, the defect was not.');
  L.push('- **`.room` vs `bg-[var(--hide-950)]` on `<main>`.** Still live at 84 sites.');
  L.push('  `RoleStandaloneView` drops the utility on its room branch and says so in a');
  L.push('  comment, but the pages that paint a room directly still carry it. Filed DEAD,');
  L.push('  not BROKEN: the room\'s ground is the intended one.');
  L.push('');
  L.push('## How the edge cases were treated');
  L.push('');
  L.push('- **Token meaning is not guessed.** Every distinct token found in the source is');
  L.push('  handed to the installed Tailwind v4 compiler running over the real');
  L.push('  `globals.css`, and whatever comes back out of `@layer utilities` is what that');
  L.push('  token does. That is how `space-y-6` is correctly excluded (its real selector');
  L.push('  is `.space-y-6 > :not(:last-child)`, so it never touches the element itself),');
  L.push('  how `border-l-4` is known to set `border-left-style` as well as the width, and');
  L.push('  how project classes such as `badge--filed` are known not to be utilities.');
  L.push('- **Breakpoint prefixes.** `sm:min-h-[...]` compiles to');
  L.push('  `@media (width >= 40rem) { min-height: ... }`. The ppbf rule is unlayered at');
  L.push('  *every* width, so the prefixed utility is defeated inside its own breakpoint');
  L.push('  too. It is counted, and each entry states the width it was supposed to take');
  L.push('  effect at. A prefixed utility is a strictly narrower loss than an unprefixed');
  L.push('  one, which is why the scope is printed rather than merged away.');
  L.push('- **State prefixes.** `hover:` / `focus-visible:` / `disabled:` compile to real');
  L.push('  pseudo-class selectors, and matching is done on those. An *unconditional* ppbf');
  L.push('  rule defeats a `hover:` utility (the hover style never appears, at any moment),');
  L.push('  so that counts. A ppbf `:hover` rule is **not** counted against an unprefixed');
  L.push('  utility: the utility still renders at rest and only yields during hover, which');
  L.push('  is usually the intent.');
  L.push('- **Shorthands, both sides.** `padding: 0 var(--s4)` is expanded to four');
  L.push('  longhands before comparison, so it registers against `px-[var(--s4)]`.');
  L.push('  Shorthands whose per-longhand value cannot be decomposed (`background:`,');
  L.push('  `transition:`, `font:`) collide on property name only and are filed DEAD, never');
  L.push('  BROKEN, because there is no evidence a specific value was lost.');
  L.push('- **Inline `style={{...}}`** on the same element outranks both sheets, so a');
  L.push('  property set there is excluded. It is not a layer casualty.');
  L.push('- **Ancestor-scoped ppbf rules** (`.mat-leather .stamp`) and rules needing a');
  L.push('  second class the element does not carry are not counted: they are not proven');
  L.push('  to apply at that call site.');
  L.push('- **`globals.css` is read as well as `ppbf.css`.** It `@import`s ppbf.css at its');
  L.push('  top, so it is later in source order and wins ties; a report naming only');
  L.push('  ppbf.css would attribute those overrides to the wrong file.');
  L.push('');

  const detail = (c) => {
    const L2 = [];
    L2.push(`#### \`${c.file}\`:${c.line} - \`<${c.tag}>\` - \`${c.property}\``);
    L2.push('');
    L2.push(`- **Wins (unlayered)**: \`${c.ppbfSelector}\` at ${c.ppbfFile}:${c.ppbfLine} - ${declText(c.ppbfShorthand, c.property, c.ppbfValueRaw)} - computes to \`${c.ppbfValue}\``);
    L2.push(`- **Loses (\`@layer utilities\`)**: \`${c.utility}\` - ${declText(c.utilityShorthand, c.property, c.utilityValueRaw)} - computes to \`${c.utilityValue}\``);
    if (c.otherPpbfClassesOnElement.length) L2.push(`- **Also on this element**: \`${c.otherPpbfClassesOnElement.map((x) => `.${x}`).join('`, `')}\` - none of them wins this property.`);
    if (c.utilityMedia.length) L2.push(`- **Scope**: the utility only asks to apply at \`${c.utilityMedia.join(' and ')}\`; the ppbf rule applies at every width, so it is defeated there too.`);
    if (c.utilityStates.length) L2.push(`- **State**: \`${c.utilityStates.join(', ')}\` - and the ppbf rule is unconditional, so this state never renders.`);
    L2.push(`- **What a user sees**: ${userVisible(c)}`);
    L2.push(`- **Element class string**: \`${c.variant}\``);
    L2.push('');
    return L2;
  };

  L.push(`## BROKEN - ${report.buckets.BROKEN.length}`);
  L.push('');
  L.push('A geometry or layout instruction whose value differs from the ppbf value. It was');
  L.push('written on purpose and it never applied. This is the bug list.');
  L.push('');
  if (!report.buckets.BROKEN.length) { L.push('_None._'); L.push(''); } else {
    let currentFile = null;
    for (const c of report.buckets.BROKEN) {
      if (c.file !== currentFile) { currentFile = c.file; L.push(`### \`${currentFile}\``); L.push(''); }
      L.push(...detail(c));
    }
  }

  const table = (items) => {
    const L2 = ['| file:line | element | property | unlayered rule -> value | utility -> value |', '|---|---|---|---|---|'];
    for (const c of items) {
      L2.push(`| \`${c.file}\`:${c.line} | \`${c.tag}\` | \`${c.property}\` | \`${esc(c.ppbfSelector)}\` -> \`${esc(c.ppbfValue ?? '-')}\` | \`${esc(c.utility)}\` -> \`${esc(c.utilityValue ?? '-')}\` |`);
    }
    L2.push('');
    return L2;
  };

  L.push(`## DEAD - ${report.buckets.DEAD.length}`);
  L.push('');
  L.push('The utility never applies, but the ppbf value is the design system doing its job');
  L.push('(colour, surface, type, motion), or the ppbf side is a shorthand whose value');
  L.push('cannot be decomposed. Deleting the utility changes nothing on screen. Keeping it');
  L.push('leaves a second, wrong answer to "what does this element look like" sitting in');
  L.push('the source, which is how the map and the wall drift apart.');
  L.push('');
  L.push('This bucket is not uniform, and the shape of it is the interesting part:');
  L.push('');
  L.push('| property | sites |');
  L.push('|---|---|');
  for (const [p, n] of report.deadByProperty) L.push(`| \`${p}\` | ${n} |`);
  L.push('');
  L.push('Colour is the overwhelming majority, and that is the bucket boundary doing its');
  L.push('job rather than a shrug: the design system is the declared authority on colour');
  L.push('(Laws 1-4), so a ppbf class winning `color` is the system working as designed and');
  L.push('the utility beside it is a duplicate opinion. A reviewer may still want to');
  L.push('promote some of these by hand - a `text-[color:var(--bone-300)]` written to make');
  L.push('secondary text quieter, losing to `.t-body`, flattens a deliberate type');
  L.push('hierarchy even though nothing becomes illegible. That is a judgement about');
  L.push('intent, which is exactly what this scanner refuses to guess.');
  L.push('');
  if (!report.buckets.DEAD.length) { L.push('_None._'); L.push(''); } else L.push(...table(report.buckets.DEAD));

  L.push(`## HARMLESS - ${report.buckets.HARMLESS.length}`);
  L.push('');
  L.push('Both sides resolve to the same computed value. The cascade decided nothing and');
  L.push('nothing is lost. `.room { min-height: 100vh }` against `min-h-screen` is the');
  L.push('archetype: the ppbf comment says it was written to match Tailwind exactly.');
  L.push('');
  if (!report.buckets.HARMLESS.length) { L.push('_None._'); L.push(''); } else L.push(...table(report.buckets.HARMLESS));

  L.push(`## Unresolved class strings - ${report.unresolved.length}`);
  L.push('');
  L.push('`className` expressions the resolver could not reduce to literal strings. Each');
  L.push('is a site this scan did NOT see, so the counts above are a floor, not a total.');
  L.push('');
  if (report.unresolved.length) {
    L.push('| file:line | element | expression |');
    L.push('|---|---|---|');
    for (const u of report.unresolved) L.push(`| \`${u.file}\`:${u.line} | \`${u.tag}\` | \`${esc(u.expression)}\` |`);
    L.push('');
  } else { L.push('_None._'); L.push(''); }

  L.push(`## Partially resolved class strings - ${report.partiallyResolved.length}`);
  L.push('');
  L.push('Sites where SOME of the class string resolved. A ternary branch that depends on');
  L.push('a prop, or a `${...}` interpolation the scanner cannot see, is replaced with an');
  L.push('inert placeholder so the literal tokens around it are still measured. These are');
  L.push('counted here rather than in the clean total, because a collision inside the lost');
  L.push('fragment would not have been seen.');
  L.push('');
  if (report.partiallyResolved.length) {
    L.push('| file:line | element | expression |');
    L.push('|---|---|---|');
    for (const u of report.partiallyResolved) L.push(`| \`${u.file}\`:${u.line} | \`${u.tag}\` | \`${esc(u.expression)}\` |`);
    L.push('');
  } else { L.push('_None._'); L.push(''); }

  L.push(`## Utilities naming a custom property nothing defines - ${report.undefinedVars.length}`);
  L.push('');
  L.push('A SECOND, independent defect that surfaced on the way, and not counted as a');
  L.push('collision. These utilities compile, but the `var()` inside them resolves to');
  L.push('nothing, so they are dead before the cascade is even consulted - the layer');
  L.push('problem is not what is wrong with them. Tailwind\'s own `--tw-*` machinery and');
  L.push('the `--font-geist-*` faces that `next/font` injects on `<html>` at runtime are');
  L.push('excluded; what is left is a name no sheet in this repo declares.');
  L.push('');
  if (report.undefinedVars.length) {
    for (const v of report.undefinedVars) {
      L.push(`- \`${v.name}\` - ${v.sites.length} site(s): ${v.sites.map((sx) => `\`${sx}\``).join(', ')}`);
    }
    L.push('');
  } else { L.push('_None._'); L.push(''); }

  L.push(`## Utilities that compile but cannot collide here - ${report.descendantOnly.length}`);
  L.push('');
  L.push('These DO compile. They are excluded from the collision counts because they do');
  L.push('not style the element that carries them: `space-y-6` becomes');
  L.push('`:where(.space-y-6 > :not(:last-child))` and sets margins on CHILDREN, and the');
  L.push('gradient stops set only `--tw-*` custom properties. A property-name scanner that');
  L.push('read these as element styles would report a `.room { margin }` collision that');
  L.push('cannot happen.');
  L.push('');
  L.push('```');
  L.push(report.descendantOnly.filter((t) => !t.includes(PARTIAL)).join(' '));
  L.push('```');
  L.push('');

  L.push(`## Tokens Tailwind emits nothing for - ${report.notUtilities.length}`);
  L.push('');
  L.push('Reported rather than swallowed, because a token that looks like a utility and');
  L.push('compiles to nothing is dead before the cascade is even consulted, and a scanner');
  L.push('that quietly dropped it would be hiding a different defect than the one it was');
  L.push('sent to find.');
  L.push('');
  const orphans = report.notUtilities.filter((t) => !t.inCss);
  const projectClasses = report.notUtilities.filter((t) => t.inCss);
  L.push(`**${orphans.length} of them are named by no rule in either stylesheet**, so they style`);
  L.push('nothing by any route - not as a subject, not under an ancestor, not on a');
  L.push('pseudo-element. Each is either a class whose CSS was removed, or a typo:');
  L.push('');
  L.push('```');
  L.push(orphans.map((t) => t.token).join(' ') || '(none)');
  L.push('```');
  L.push('');
  L.push(`The other ${projectClasses.length} are real project classes that ppbf.css or globals.css does`);
  L.push('name - `.btn`, `.room`, `.stamp`, the wall and print families and so on. They are');
  L.push('not listed here: they are the design system, and the ones among them that carry');
  L.push('unlayered declarations already appear throughout the three buckets above. The');
  L.push('count is given so the token accounting adds up, and `--json` carries the full');
  L.push('list for anyone who wants it.');
  L.push('');
  return L.join('\n');
}

function userVisible(c) {
  const p = c.property;
  const asked = c.utilityValue;
  const got = c.ppbfValue;
  const where = c.utilityMedia.length ? ` (at ${c.utilityMedia.join(' and ')})` : '';
  if (p === 'position') return `The element is positioned \`${got}\` instead of \`${asked}\`, so anything offset against it, or against its nearest positioned ancestor, lands somewhere else on the page.`;
  if (p === 'min-height') return `The control is ${got} tall${where} where the source asks for ${asked}${asked === '44px' || asked === '55px' ? ', which is a tap-target floor being missed' : ''}.`;
  if (p === 'min-width') return `The box is at least ${got} wide${where} where the source asks for ${asked}.`;
  if (p === 'max-width') return `Content wraps at ${got}${where} instead of ${asked}, so the measure is wrong.`;
  if (p === 'display') return `The element lays out as \`${got}\` instead of \`${asked}\`${where}, so its children stack the wrong way.`;
  if (p === 'width' || p === 'height') return `The box is ${got}${where} where the source asks for ${asked}.`;
  if (p.startsWith('padding')) return `The ${p.replace('padding-', '')} padding is ${got}${where} instead of ${asked}.`;
  if (p.startsWith('margin')) return `The ${p.replace('margin-', '')} margin is ${got}${where} instead of ${asked}.`;
  if (p === 'row-gap' || p === 'column-gap') return `Items sit ${got} apart${where} instead of ${asked}.`;
  if (p === 'align-items' || p === 'justify-content' || p === 'align-self') return `Children align \`${got}\`${where} instead of \`${asked}\`.`;
  if (p === 'flex-direction') return `The row runs \`${got}\`${where} instead of \`${asked}\`.`;
  if (p === 'grid-template-columns') return `The grid uses \`${got}\`${where} instead of \`${asked}\`.`;
  if (p === 'z-index') return `The element stacks at ${got} instead of ${asked}, so it sits on the wrong side of its neighbours.`;
  if (p.startsWith('overflow')) return `Content overflows \`${got}\` instead of \`${asked}\`, so a scroller is missing or an unwanted one appears.`;
  if (['top', 'right', 'bottom', 'left'].includes(p)) return `The ${p} offset is ${got}${where} instead of ${asked}.`;
  return `\`${p}\` renders as \`${got}\`${where} instead of the \`${asked}\` the source asks for.`;
}

/* ============================================================= 10. SELF TEST */

/* The classifier's contract, written so each case fails if the rule it guards
   is inverted or deleted. Run:
       node scripts/css-layer-collisions.mjs --self-test
   Mutation-tested, and the results are recorded because a guard nobody has
   watched fail is a hypothesis:

     inverting the equal-values branch        -> 3/15   red
     emptying GEOMETRY_PROPERTIES             -> 8/15   red
     disabling the floor rule                 -> 14/15  red
     disabling the ceiling rule               -> 14/15  red
     dropping the null-value branch           -> 14/15  red
     emptying DEFAULTISH                      -> 14/15  red
     making pxOf() refuse every value         -> 14/15  red
     bound rules leaking to any property      -> 14/15  red
     `ppbfPx >= utilPx` -> `ppbfPx > utilPx`  -> 15/15  GREEN

   That last one is an EQUIVALENT mutant, not a hole, and the reason is worth
   writing down rather than papering over: the `=` half of `>=` is unreachable.
   Two lengths that compare numerically equal have already normalised to the
   same string (rem is folded to px, calc() is folded, `0px` to `0`), so the
   equal-values branch above returns HARMLESS before either bound rule is
   consulted. The `>=` is kept because it stays correct if that branch ever
   changes, but no test can pin it today, and pretending otherwise would be
   the exact failure mode this comment exists to prevent. */
function selfTest() {
  const cases = [
    ['equal values are HARMLESS', { property: 'min-height', ppbfValue: '100vh', utilityValue: '100vh' }, 'HARMLESS'],
    ['equal colours are HARMLESS', { property: 'background-color', ppbfValue: '#14100d', utilityValue: '#14100d' }, 'HARMLESS'],
    ['a lost position is BROKEN', { property: 'position', ppbfValue: 'relative', utilityValue: 'absolute' }, 'BROKEN'],
    ['a floor that does NOT hold is BROKEN', { property: 'min-height', ppbfValue: '38px', utilityValue: '44px' }, 'BROKEN'],
    ['a floor already exceeded is HARMLESS', { property: 'min-height', ppbfValue: '46px', utilityValue: '44px' }, 'HARMLESS'],
    ['a ceiling already below is HARMLESS', { property: 'max-width', ppbfValue: '400px', utilityValue: '520px' }, 'HARMLESS'],
    ['a ceiling that does NOT hold is BROKEN', { property: 'max-width', ppbfValue: '900px', utilityValue: '520px' }, 'BROKEN'],
    ['a non-bound geometry difference is still BROKEN', { property: 'height', ppbfValue: '46px', utilityValue: '44px' }, 'BROKEN'],
    ['a floor in units that cannot be compared is NOT waved through', { property: 'min-height', ppbfValue: '100vh', utilityValue: '44px' }, 'BROKEN'],
    ['a bound rule does not leak onto a non-bound property', { property: 'padding-top', ppbfValue: '46px', utilityValue: '44px' }, 'BROKEN'],
    ['a lost padding is BROKEN', { property: 'padding-left', ppbfValue: '13px', utilityValue: '21px' }, 'BROKEN'],
    ['a lost background colour is DEAD', { property: 'background-color', ppbfValue: '#2e1d0e', utilityValue: '#14100d' }, 'DEAD'],
    ['a lost font-family is DEAD', { property: 'font-family', ppbfValue: 'oswald', utilityValue: 'courier' }, 'DEAD'],
    ['an undecomposable shorthand is DEAD, not BROKEN', { property: 'min-height', ppbfValue: null, utilityValue: '44px' }, 'DEAD'],
    ['a default-ish utility value is DEAD', { property: 'position', ppbfValue: 'relative', utilityValue: 'static' }, 'DEAD'],
  ];
  let failed = 0;
  for (const [name, input, expected] of cases) {
    const got = classify(input);
    if (got !== expected) failed += 1;
    process.stdout.write(`${got === expected ? 'ok  ' : 'FAIL'}  ${name} - expected ${expected}, got ${got}\n`);
  }
  process.stdout.write(`\n${cases.length - failed}/${cases.length} passed\n`);
  process.exitCode = failed ? 1 : 0;
}

await main();
