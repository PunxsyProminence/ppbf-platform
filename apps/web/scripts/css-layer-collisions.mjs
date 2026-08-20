#!/usr/bin/env node
/* ───────────────────────────────────────────────────────────────────────────
   CSS layer collision scanner — finds Tailwind utilities that never apply.

   WHY THIS EXISTS

   `design-system/ppbf.css` and most of `apps/web/app/globals.css` are
   UNLAYERED. Tailwind v4 puts its utilities in `@layer utilities`. In the
   cascade, an unlayered rule beats a layered one whatever the selectors say —
   specificity is never consulted, because layer order is decided first.

   So any element that carries both a ppbf.css class and a Tailwind utility
   naming the same CSS property renders the ppbf value. The utility is inert
   while still reading as correct in the JSX. Three that were found by eye:

     .stamp { position: relative }   defeated `absolute` on the sign-in board
     .btn--lever { min-height:38px } defeated `min-h-[44px]` on /parent/consent
     .room { background-color }      defeated `bg-[var(--hide-950)]` on <main>

   Nothing in the unit suite can see this. A test asserting `className`
   contains "absolute" passes on a stamp that renders bottom-LEFT.

   WHAT IT DOES

     1. Parses ppbf.css + globals.css into (selector, property, value) triples,
        keeping layer / media / pseudo context and expanding shorthands.
        Rules inside `@layer` are excluded: they cannot cause this defect.
     2. Parses every app .tsx with the TypeScript compiler API and statically
        resolves each `className` to the SET of class strings it can produce —
        module constants, `+` concatenation, template literals, ternaries,
        `&&`, helper functions returning template literals, `.join(' ')`.
        Anything it cannot resolve is COUNTED, never silently dropped.
     3. Maps each Tailwind token to the CSS properties it sets and resolves its
        value, following `var(--x)` through the :root / @theme token tables.
     4. Compares VALUES, not just property names, and files each collision in
        exactly one of three buckets: HARMLESS / DEAD / BROKEN.

   USAGE

     node scripts/css-layer-collisions.mjs                 # human report
     node scripts/css-layer-collisions.mjs --json          # machine-readable
     node scripts/css-layer-collisions.mjs --markdown FILE # write the report
     node scripts/css-layer-collisions.mjs --bucket BROKEN # one bucket only
     node scripts/css-layer-collisions.mjs --self-test     # classifier guards

   It reads and reports. It never edits CSS or application code.
   ─────────────────────────────────────────────────────────────────────────── */

import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ts = require('typescript');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.resolve(HERE, '..');
const REPO_ROOT = path.resolve(WEB_ROOT, '../..');

const PPBF_CSS = path.join(REPO_ROOT, 'design-system/ppbf.css');
const GLOBALS_CSS = path.join(WEB_ROOT, 'app/globals.css');

/* ══════════════════════════════════════════════════════════ 1. CSS PARSING ══ */

/* Comments are blanked rather than removed so every byte offset — and so every
   line number in the report — still points at the real line in the real file. */
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

/* Split on `sep` at bracket/paren/quote depth zero. Used for selector lists,
   declaration lists and Tailwind variant prefixes alike. */
function splitTop(input, sep) {
  const parts = [];
  let depth = 0;
  let buf = '';
  let quote = null;
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (quote) {
      buf += ch;
      if (ch === '\\') { buf += input[++i] ?? ''; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; buf += ch; continue; }
    if (ch === '(' || ch === '[') depth += 1;
    if (ch === ')' || ch === ']') depth -= 1;
    if (ch === sep && depth === 0) { parts.push(buf); buf = ''; continue; }
    buf += ch;
  }
  parts.push(buf);
  return parts;
}

/* Every shorthand this codebase actually writes, expanded to the longhands it
   sets. Without this, `.btn--lever { padding: 0 var(--s4) }` never registers
   as a collision with `px-[var(--s4)]`, and `background: <gradient>` never
   registers as one with `bg-[var(--x)]` — even though the shorthand resets
   background-color to transparent and so genuinely defeats it.

   `edges` marks the 1-to-4-value box shorthands, whose per-side values we can
   actually compute; everything else expands with an unknown value and is
   compared on property name only (and reported as value-unknown). */
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
  overflow: { edges2: ['overflow-x', 'overflow-y'] },
  'text-decoration': { opaque: ['text-decoration-line', 'text-decoration-style', 'text-decoration-color', 'text-decoration-thickness'] },
  'list-style': { opaque: ['list-style-type', 'list-style-position', 'list-style-image'] },
  transition: { opaque: ['transition-property', 'transition-duration', 'transition-timing-function', 'transition-delay'] },
  animation: { opaque: ['animation-name', 'animation-duration', 'animation-timing-function', 'animation-delay', 'animation-iteration-count', 'animation-direction', 'animation-fill-mode', 'animation-play-state'] },
  'grid-area': { opaque: ['grid-row-start', 'grid-column-start', 'grid-row-end', 'grid-column-end'] },
};

const UNKNOWN_VALUE = Symbol('unknown-shorthand-part');

function expandDeclaration(prop, value) {
  const shorthand = SHORTHANDS[prop];
  if (!shorthand) return [[prop, value]];

  /* Box shorthands are only splittable when the value is a plain list of
     space-separated parts. A `calc(...)` or `var(...)` with internal spaces is
     handled because splitTop respects paren depth. */
  const parts = splitTop(value.trim(), ' ').map((p) => p.trim()).filter(Boolean);

  if (shorthand.edges && parts.length >= 1 && parts.length <= 4) {
    const [t, r = t, b = t, l = r] = parts;
    return [
      [shorthand.edges[0], t],
      [shorthand.edges[1], r],
      [shorthand.edges[2], b],
      [shorthand.edges[3], l],
    ];
  }
  if (shorthand.corners && parts.length >= 1 && parts.length <= 4 && !value.includes('/')) {
    const [a, b2 = a, c = a, d = b2] = parts;
    return [
      [shorthand.corners[0], a],
      [shorthand.corners[1], b2],
      [shorthand.corners[2], c],
      [shorthand.corners[3], d],
    ];
  }
  if (shorthand.edges2 && parts.length >= 1 && parts.length <= 2) {
    const [a, b2 = a] = parts;
    return [[shorthand.edges2[0], a], [shorthand.edges2[1], b2]];
  }
  const longhands = shorthand.opaque ?? shorthand.edges ?? shorthand.edges2 ?? shorthand.corners;
  return longhands.map((lh) => [lh, UNKNOWN_VALUE]);
}

function parseCss(file) {
  const raw = readFileSync(file, 'utf8');
  const src = blankComments(raw);
  const lineOf = lineIndexer(src);
  const rules = [];
  let pos = 0;

  function readDeclBlock(ctx, selectors, blockStartLine) {
    const decls = [];
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
      if (ch === ';') {
        pushDecl(decls, buf, lineOf(bufStart));
        buf = '';
        pos += 1;
        bufStart = pos;
        continue;
      }
      if (ch === '{') {
        /* A nested rule or nested at-rule inside a declaration block. */
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
    pushDecl(decls, buf, lineOf(bufStart));
    if (selectors && decls.length) {
      for (const selector of selectors) {
        rules.push({ file, selector, decls, line: blockStartLine, ...ctx });
      }
    }
  }

  function pushDecl(decls, buf, line) {
    const text = buf.trim();
    if (!text) return;
    const idx = text.indexOf(':');
    if (idx <= 0) return;
    const prop = text.slice(0, idx).trim().toLowerCase();
    let value = text.slice(idx + 1).trim();
    let important = false;
    if (/!\s*important$/i.test(value)) {
      important = true;
      value = value.replace(/!\s*important$/i, '').trim();
    }
    if (!prop || !value) return;
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

  function handleBlock(ctx, prelude, preludeLine, parentSelectors) {
    if (prelude.startsWith('@')) {
      const name = prelude.split(/[\s({]/)[0].toLowerCase();
      if (name === '@media' || name === '@supports' || name === '@container') {
        const next = { ...ctx };
        if (name === '@media') next.media = [...ctx.media, prelude.replace(/^@media\s*/i, '').trim()];
        else next.conditions = [...ctx.conditions, prelude];
        readDeclBlock(next, parentSelectors ?? null, preludeLine);
        return;
      }
      if (name === '@layer') {
        const layerName = prelude.replace(/^@layer\s*/i, '').trim() || '(anonymous)';
        readDeclBlock({ ...ctx, layer: layerName }, parentSelectors ?? null, preludeLine);
        return;
      }
      if (name === '@theme' || name === '@font-face' || name === '@property') {
        readDeclBlock({ ...ctx, atRule: name }, [prelude], preludeLine);
        return;
      }
      skipBlock();
      return;
    }
    const selectors = splitTop(prelude, ',').map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
    readDeclBlock(ctx, selectors, preludeLine);
  }

  /* Top level. */
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

/* ═════════════════════════════════════════════════════ 2. SELECTOR ANALYSIS ══ */

const COMBINATOR = /^[>+~]$/;

function splitCompounds(selector) {
  const parts = [];
  let buf = '';
  let depth = 0;
  for (let i = 0; i < selector.length; i += 1) {
    const ch = selector[i];
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

const COMPOUND_TOKEN = /(::?[-\w]+(?:\([^)]*\))?)|(\[[^\]]*\])|(\.[-\w\\]+)|(#[-\w]+)|(\*)|(&)|([-\w]+)/g;

function analyzeSelector(selector) {
  const compounds = splitCompounds(selector);
  const subject = compounds[compounds.length - 1] ?? '';
  const classes = [];
  const pseudoClasses = [];
  const attrs = [];
  let pseudoElement = null;
  let ids = 0;
  let tags = 0;
  let allClasses = 0;
  let allAttrs = 0;
  let allPseudoClasses = 0;
  let allTags = 0;
  let allIds = 0;

  for (const compound of compounds) {
    const isSubject = compound === subject && compounds.indexOf(compound) === compounds.length - 1;
    COMPOUND_TOKEN.lastIndex = 0;
    let m;
    while ((m = COMPOUND_TOKEN.exec(compound)) !== null) {
      const [tok] = m;
      if (tok.startsWith('::')) {
        allTags += 1;
        if (isSubject) pseudoElement = tok;
      } else if (tok.startsWith(':')) {
        const bare = tok.split('(')[0];
        if (bare === ':before' || bare === ':after' || bare === ':first-line' || bare === ':first-letter') {
          allTags += 1;
          if (isSubject) pseudoElement = tok;
        } else if (bare === ':not' || bare === ':is' || bare === ':where') {
          if (bare !== ':where') allPseudoClasses += 1;
          if (isSubject) pseudoClasses.push(tok);
          /* Classes named inside :is()/:not() are conditions, not the subject's
             own classes, so they are deliberately not added to `classes`. */
        } else {
          allPseudoClasses += 1;
          if (isSubject) pseudoClasses.push(tok);
        }
      } else if (tok.startsWith('[')) {
        allAttrs += 1;
        if (isSubject) attrs.push(tok);
      } else if (tok.startsWith('.')) {
        allClasses += 1;
        if (isSubject) classes.push(tok.slice(1).replace(/\\/g, ''));
      } else if (tok.startsWith('#')) {
        allIds += 1;
        ids += 1;
      } else if (tok === '*' || tok === '&') {
        /* zero specificity */
      } else {
        allTags += 1;
        if (isSubject) tags += 1;
      }
    }
  }

  return {
    selector,
    classes,
    pseudoClasses,
    attrs,
    pseudoElement,
    tagInSubject: tags > 0,
    hasAncestor: compounds.length > 1,
    hasIds: ids > 0 || allIds > 0,
    specificity: [allIds, allClasses + allAttrs + allPseudoClasses, allTags],
  };
}

function specLess(a, b) {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] < b[i];
  }
  return false;
}

/* ═══════════════════════════════════════════════════ 3. CUSTOM PROPERTIES ══ */

/* Token tables. `:root` and `@theme` are the two places this app declares
   custom properties that a utility can resolve against. Later declarations of
   the same name win, which is why this walks the rules in source order and
   overwrites. Grounds like `.on-canvas` restate a handful of tokens; those are
   collected separately so a resolution can say "context-dependent" rather than
   silently picking one. */
function collectVars(ruleSets) {
  const globals = new Map();
  const scoped = new Map();
  for (const rule of ruleSets) {
    if (rule.layer) continue;
    const isGlobal =
      rule.atRule === '@theme' ||
      /^:root$/.test(rule.selector) ||
      /^html$/.test(rule.selector) ||
      /^:root\s*,/.test(rule.selector);
    for (const d of rule.decls) {
      if (!d.prop.startsWith('--')) continue;
      const name = d.prop.replace(/\\\./g, '.');
      if (isGlobal) globals.set(name, d.value);
      else {
        if (!scoped.has(name)) scoped.set(name, new Set());
        scoped.get(name).add(d.value);
      }
    }
  }
  return { globals, scoped };
}

function resolveVars(value, vars, depth = 0) {
  if (typeof value !== 'string' || depth > 12 || !value.includes('var(')) return value;
  const out = value.replace(/var\(\s*(--[-\w.\\]+)\s*(?:,([^()]*(?:\([^()]*\)[^()]*)*))?\)/g, (whole, name, fallback) => {
    const key = name.replace(/\\/g, '');
    if (vars.globals.has(key)) return vars.globals.get(key);
    if (fallback != null && fallback.trim()) return fallback.trim();
    return whole;
  });
  if (out === value) return out;
  return resolveVars(out, vars, depth + 1);
}

/* ═══════════════════════════════════════════════ 4. VALUE NORMALISATION ══ */

const NAMED_COLORS = {
  transparent: 'rgba(0,0,0,0)',
  white: '#ffffff',
  black: '#000000',
  currentcolor: 'currentcolor',
  inherit: 'inherit',
};

function normalizeColor(v) {
  let s = v.trim().toLowerCase();
  if (NAMED_COLORS[s]) s = NAMED_COLORS[s];
  const hex = /^#([0-9a-f]{3,8})$/.exec(s);
  if (hex) {
    let h = hex[1];
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    if (h.length === 4) h = h.split('').map((c) => c + c).join('');
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
  /* rem is only ever authored against a 16px root here; nothing sets html
     font-size. Converting makes `1rem` and `16px` compare equal. */
  s = s.replace(/(^|[\s,(])(-?[\d.]+)rem\b/g, (_m, pre, n) => `${pre}${parseFloat(n) * 16}px`);
  s = s.replace(/(^|[\s,(])(-?[\d.]+)px\b/g, (_m, pre, n) => `${pre}${parseFloat(n)}px`);
  if (/^-?0(px|rem|em|%|vh|vw)?$/.test(s)) return '0';
  if (/^#|^rgba?\(|^hsla?\(/.test(s) || NAMED_COLORS[s]) return normalizeColor(s);
  return s;
}

/* ══════════════════════════════════════════════ 5. TAILWIND TOKEN MAPPING ══ */

/* Arbitrary-value prefixes: `<prefix>-[<value>]`. The property list is what
   Tailwind emits for that prefix. Ordering matters — longest prefix wins — so
   this is sorted by length at lookup time. */
const ARBITRARY_PREFIXES = {
  'min-h': ['min-height'],
  'min-w': ['min-width'],
  'max-h': ['max-height'],
  'max-w': ['max-width'],
  h: ['height'],
  w: ['width'],
  size: ['width', 'height'],
  p: ['padding-top', 'padding-right', 'padding-bottom', 'padding-left'],
  px: ['padding-left', 'padding-right'],
  py: ['padding-top', 'padding-bottom'],
  pt: ['padding-top'],
  pr: ['padding-right'],
  pb: ['padding-bottom'],
  pl: ['padding-left'],
  ps: ['padding-inline-start'],
  pe: ['padding-inline-end'],
  m: ['margin-top', 'margin-right', 'margin-bottom', 'margin-left'],
  mx: ['margin-left', 'margin-right'],
  my: ['margin-top', 'margin-bottom'],
  mt: ['margin-top'],
  mr: ['margin-right'],
  mb: ['margin-bottom'],
  ml: ['margin-left'],
  gap: ['row-gap', 'column-gap'],
  'gap-x': ['column-gap'],
  'gap-y': ['row-gap'],
  'space-x': ['margin-left'],
  'space-y': ['margin-top'],
  top: ['top'],
  right: ['right'],
  bottom: ['bottom'],
  left: ['left'],
  inset: ['top', 'right', 'bottom', 'left'],
  'inset-x': ['left', 'right'],
  'inset-y': ['top', 'bottom'],
  z: ['z-index'],
  bg: ['background-color'],
  text: ['color'],
  border: ['border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width'],
  'border-t': ['border-top-width'],
  'border-r': ['border-right-width'],
  'border-b': ['border-bottom-width'],
  'border-l': ['border-left-width'],
  'border-x': ['border-left-width', 'border-right-width'],
  'border-y': ['border-top-width', 'border-bottom-width'],
  outline: ['outline-width'],
  ring: ['box-shadow'],
  rounded: ['border-top-left-radius', 'border-top-right-radius', 'border-bottom-right-radius', 'border-bottom-left-radius'],
  'rounded-t': ['border-top-left-radius', 'border-top-right-radius'],
  'rounded-b': ['border-bottom-right-radius', 'border-bottom-left-radius'],
  'rounded-l': ['border-top-left-radius', 'border-bottom-left-radius'],
  'rounded-r': ['border-top-right-radius', 'border-bottom-right-radius'],
  shadow: ['box-shadow'],
  'drop-shadow': ['filter'],
  opacity: ['opacity'],
  tracking: ['letter-spacing'],
  leading: ['line-height'],
  font: ['font-family'],
  'grid-cols': ['grid-template-columns'],
  'grid-rows': ['grid-template-rows'],
  'col-span': ['grid-column'],
  'row-span': ['grid-row'],
  col: ['grid-column'],
  row: ['grid-row'],
  basis: ['flex-basis'],
  flex: ['flex-grow', 'flex-shrink', 'flex-basis'],
  grow: ['flex-grow'],
  shrink: ['flex-shrink'],
  order: ['order'],
  aspect: ['aspect-ratio'],
  translate: ['translate'],
  'translate-x': ['translate'],
  'translate-y': ['translate'],
  rotate: ['rotate'],
  scale: ['scale'],
  transform: ['transform'],
  transition: ['transition-property', 'transition-duration', 'transition-timing-function'],
  duration: ['transition-duration'],
  ease: ['transition-timing-function'],
  delay: ['transition-delay'],
  fill: ['fill'],
  stroke: ['stroke'],
  from: ['--tw-gradient-from'],
  to: ['--tw-gradient-to'],
  via: ['--tw-gradient-via'],
  content: ['content'],
  'backdrop-blur': ['backdrop-filter'],
  blur: ['filter'],
  columns: ['columns'],
  'list-image': ['list-style-image'],
  'accent': ['accent-color'],
  'caret': ['caret-color'],
  'decoration': ['text-decoration-color'],
  'underline-offset': ['text-underline-offset'],
  'indent': ['text-indent'],
  'align': ['vertical-align'],
  'origin': ['transform-origin'],
  'will-change': ['will-change'],
  'grid-flow': ['grid-auto-flow'],
  'auto-cols': ['grid-auto-columns'],
  'auto-rows': ['grid-auto-rows'],
};

/* The data-type hints Tailwind v4 accepts inside an arbitrary value, and the
   property each one re-points the utility at. `text-[color:...]` is a colour;
   `text-[length:...]` is a font size; a bare `text-[var(--x)]` is AMBIGUOUS and
   Tailwind emits NOTHING for it — that is tracked separately as its own defect,
   because it is dead for a different reason than the layer collision. */
const TYPE_HINTS = {
  text: { color: ['color'], length: ['font-size'] },
  bg: { color: ['background-color'], image: ['background-image'], url: ['background-image'], length: ['background-size'], position: ['background-position'] },
  border: { color: ['border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color'], length: ['border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width'] },
  'border-t': { color: ['border-top-color'], length: ['border-top-width'] },
  'border-r': { color: ['border-right-color'], length: ['border-right-width'] },
  'border-b': { color: ['border-bottom-color'], length: ['border-bottom-width'] },
  'border-l': { color: ['border-left-color'], length: ['border-left-width'] },
  'border-x': { color: ['border-left-color', 'border-right-color'], length: ['border-left-width', 'border-right-width'] },
  'border-y': { color: ['border-top-color', 'border-bottom-color'], length: ['border-top-width', 'border-bottom-width'] },
  outline: { color: ['outline-color'], length: ['outline-width'] },
  font: { family: ['font-family'], weight: ['font-weight'] },
  decoration: { color: ['text-decoration-color'], length: ['text-decoration-thickness'] },
  fill: { color: ['fill'] },
  stroke: { color: ['stroke'], length: ['stroke-width'] },
};

/* Bare-value colour prefixes: for these, a bracket value that LOOKS like a
   colour and has no hint still resolves unambiguously in Tailwind v4. */
const COLOR_LIKE = /^(#|rgba?\(|hsla?\(|oklch\(|color-mix\(|transparent$|currentcolor$)/i;

const STATIC_UTILITIES = {
  /* display + position — the properties that break layouts */
  block: { display: 'block' },
  'inline-block': { display: 'inline-block' },
  inline: { display: 'inline' },
  flex: { display: 'flex' },
  'inline-flex': { display: 'inline-flex' },
  grid: { display: 'grid' },
  'inline-grid': { display: 'inline-grid' },
  table: { display: 'table' },
  contents: { display: 'contents' },
  hidden: { display: 'none' },
  static: { position: 'static' },
  fixed: { position: 'fixed' },
  absolute: { position: 'absolute' },
  relative: { position: 'relative' },
  sticky: { position: 'sticky' },
  isolate: { isolation: 'isolate' },

  /* sizing */
  'w-full': { width: '100%' },
  'w-auto': { width: 'auto' },
  'w-screen': { width: '100vw' },
  'w-fit': { width: 'fit-content' },
  'w-min': { width: 'min-content' },
  'w-max': { width: 'max-content' },
  'h-full': { height: '100%' },
  'h-auto': { height: 'auto' },
  'h-screen': { height: '100vh' },
  'h-fit': { height: 'fit-content' },
  'min-h-screen': { 'min-height': '100vh' },
  'min-h-full': { 'min-height': '100%' },
  'min-h-0': { 'min-height': '0' },
  'min-w-0': { 'min-width': '0' },
  'min-w-full': { 'min-width': '100%' },
  'max-w-full': { 'max-width': '100%' },
  'max-w-none': { 'max-width': 'none' },
  'max-w-screen': { 'max-width': '100vw' },
  'max-h-full': { 'max-height': '100%' },
  'max-h-screen': { 'max-height': '100vh' },
  'size-full': { width: '100%', height: '100%' },

  /* flex + grid */
  'flex-row': { 'flex-direction': 'row' },
  'flex-col': { 'flex-direction': 'column' },
  'flex-wrap': { 'flex-wrap': 'wrap' },
  'flex-nowrap': { 'flex-wrap': 'nowrap' },
  'flex-1': { 'flex-grow': '1', 'flex-shrink': '1', 'flex-basis': '0%' },
  'flex-auto': { 'flex-grow': '1', 'flex-shrink': '1', 'flex-basis': 'auto' },
  'flex-none': { 'flex-grow': '0', 'flex-shrink': '0', 'flex-basis': 'auto' },
  'flex-initial': { 'flex-grow': '0', 'flex-shrink': '1', 'flex-basis': 'auto' },
  grow: { 'flex-grow': '1' },
  'grow-0': { 'flex-grow': '0' },
  shrink: { 'flex-shrink': '1' },
  'shrink-0': { 'flex-shrink': '0' },
  'items-start': { 'align-items': 'flex-start' },
  'items-center': { 'align-items': 'center' },
  'items-end': { 'align-items': 'flex-end' },
  'items-baseline': { 'align-items': 'baseline' },
  'items-stretch': { 'align-items': 'stretch' },
  'justify-start': { 'justify-content': 'flex-start' },
  'justify-center': { 'justify-content': 'center' },
  'justify-end': { 'justify-content': 'flex-end' },
  'justify-between': { 'justify-content': 'space-between' },
  'justify-around': { 'justify-content': 'space-around' },
  'justify-evenly': { 'justify-content': 'space-evenly' },
  'justify-items-center': { 'justify-items': 'center' },
  'self-start': { 'align-self': 'flex-start' },
  'self-center': { 'align-self': 'center' },
  'self-end': { 'align-self': 'flex-end' },
  'self-stretch': { 'align-self': 'stretch' },
  'content-center': { 'align-content': 'center' },
  'place-items-center': { 'align-items': 'center', 'justify-items': 'center' },
  'place-content-center': { 'align-content': 'center', 'justify-content': 'center' },

  /* typography */
  italic: { 'font-style': 'italic' },
  'not-italic': { 'font-style': 'normal' },
  underline: { 'text-decoration-line': 'underline' },
  'line-through': { 'text-decoration-line': 'line-through' },
  'no-underline': { 'text-decoration-line': 'none' },
  uppercase: { 'text-transform': 'uppercase' },
  lowercase: { 'text-transform': 'lowercase' },
  capitalize: { 'text-transform': 'capitalize' },
  'normal-case': { 'text-transform': 'none' },
  truncate: { overflow: 'hidden', 'text-overflow': 'ellipsis', 'white-space': 'nowrap' },
  'text-left': { 'text-align': 'left' },
  'text-center': { 'text-align': 'center' },
  'text-right': { 'text-align': 'right' },
  'text-justify': { 'text-align': 'justify' },
  'whitespace-nowrap': { 'white-space': 'nowrap' },
  'whitespace-pre-line': { 'white-space': 'pre-line' },
  'whitespace-pre-wrap': { 'white-space': 'pre-wrap' },
  'break-words': { 'overflow-wrap': 'break-word' },
  'break-all': { 'word-break': 'break-all' },
  'tabular-nums': { 'font-variant-numeric': 'tabular-nums' },
  'align-middle': { 'vertical-align': 'middle' },
  'list-none': { 'list-style-type': 'none' },
  'list-disc': { 'list-style-type': 'disc' },
  'list-decimal': { 'list-style-type': 'decimal' },

  /* overflow / misc */
  'overflow-hidden': { 'overflow-x': 'hidden', 'overflow-y': 'hidden' },
  'overflow-auto': { 'overflow-x': 'auto', 'overflow-y': 'auto' },
  'overflow-visible': { 'overflow-x': 'visible', 'overflow-y': 'visible' },
  'overflow-x-auto': { 'overflow-x': 'auto' },
  'overflow-y-auto': { 'overflow-y': 'auto' },
  'overflow-x-hidden': { 'overflow-x': 'hidden' },
  'overflow-y-hidden': { 'overflow-y': 'hidden' },
  'cursor-pointer': { cursor: 'pointer' },
  'cursor-not-allowed': { cursor: 'not-allowed' },
  'cursor-default': { cursor: 'default' },
  'select-none': { 'user-select': 'none' },
  'select-all': { 'user-select': 'all' },
  'pointer-events-none': { 'pointer-events': 'none' },
  'pointer-events-auto': { 'pointer-events': 'auto' },
  'appearance-none': { appearance: 'none' },
  'resize-none': { resize: 'none' },
  'resize-y': { resize: 'vertical' },
  'sr-only': { position: 'absolute', width: '1px', height: '1px', padding: '0', overflow: 'hidden' },
  'border-collapse': { 'border-collapse': 'collapse' },
  'border-separate': { 'border-collapse': 'separate' },
  'table-fixed': { 'table-layout': 'fixed' },
  'table-auto': { 'table-layout': 'auto' },
  'mx-auto': { 'margin-left': 'auto', 'margin-right': 'auto' },
  'ml-auto': { 'margin-left': 'auto' },
  'mr-auto': { 'margin-right': 'auto' },
  'my-auto': { 'margin-top': 'auto', 'margin-bottom': 'auto' },
  'inset-0': { top: '0', right: '0', bottom: '0', left: '0' },
  'grayscale': { filter: 'grayscale(1)' },
  'antialiased': { '-webkit-font-smoothing': 'antialiased' },
  'shadow-none': { 'box-shadow': 'none' },
  'outline-none': { 'outline-style': 'none' },
  'rounded-full': { 'border-top-left-radius': '3.40282e38px', 'border-top-right-radius': '3.40282e38px', 'border-bottom-right-radius': '3.40282e38px', 'border-bottom-left-radius': '3.40282e38px' },
  'border-0': { 'border-top-width': '0', 'border-right-width': '0', 'border-bottom-width': '0', 'border-left-width': '0' },
  'border-none': { 'border-top-style': 'none', 'border-right-style': 'none', 'border-bottom-style': 'none', 'border-left-style': 'none' },
  border: { 'border-top-width': '1px', 'border-right-width': '1px', 'border-bottom-width': '1px', 'border-left-width': '1px' },
  'border-2': { 'border-top-width': '2px', 'border-right-width': '2px', 'border-bottom-width': '2px', 'border-left-width': '2px' },
  'border-4': { 'border-top-width': '4px', 'border-right-width': '4px', 'border-bottom-width': '4px', 'border-left-width': '4px' },
  'border-t': { 'border-top-width': '1px' },
  'border-b': { 'border-bottom-width': '1px' },
  'border-l': { 'border-left-width': '1px' },
  'border-r': { 'border-right-width': '1px' },
  'border-dashed': { 'border-top-style': 'dashed', 'border-right-style': 'dashed', 'border-bottom-style': 'dashed', 'border-left-style': 'dashed' },
  'transition': { 'transition-property': 'color,background-color,border-color,outline-color,text-decoration-color,fill,stroke,opacity,box-shadow,transform,translate,scale,rotate,filter,backdrop-filter', 'transition-duration': '150ms' },
  'transition-none': { 'transition-property': 'none' },
  'transition-colors': { 'transition-property': 'color,background-color,border-color' },
  'transition-transform': { 'transition-property': 'transform,translate,scale,rotate' },
  'transition-opacity': { 'transition-property': 'opacity' },
  'transition-all': { 'transition-property': 'all' },
};

const FONT_WEIGHTS = {
  thin: '100', extralight: '200', light: '300', normal: '400', medium: '500',
  semibold: '600', bold: '700', extrabold: '800', black: '900',
};

const TEXT_SIZE_RUNGS = new Set(['xs', 'sm', 'base', 'md', 'lg', 'xl', '2xl', '3xl', '4xl', '5xl', '6xl', '7xl', '8xl', '9xl']);
const RADIUS_RUNGS = new Set(['none', 'xs', 'sm', 'md', 'lg', 'xl', '2xl', '3xl', '4xl', 'full']);

const SPACING_PREFIXES = {
  p: ['padding-top', 'padding-right', 'padding-bottom', 'padding-left'],
  px: ['padding-left', 'padding-right'],
  py: ['padding-top', 'padding-bottom'],
  pt: ['padding-top'], pr: ['padding-right'], pb: ['padding-bottom'], pl: ['padding-left'],
  m: ['margin-top', 'margin-right', 'margin-bottom', 'margin-left'],
  mx: ['margin-left', 'margin-right'], my: ['margin-top', 'margin-bottom'],
  mt: ['margin-top'], mr: ['margin-right'], mb: ['margin-bottom'], ml: ['margin-left'],
  gap: ['row-gap', 'column-gap'], 'gap-x': ['column-gap'], 'gap-y': ['row-gap'],
  w: ['width'], h: ['height'], 'min-h': ['min-height'], 'min-w': ['min-width'],
  'max-w': ['max-width'], 'max-h': ['max-height'], size: ['width', 'height'],
  top: ['top'], right: ['right'], bottom: ['bottom'], left: ['left'],
  inset: ['top', 'right', 'bottom', 'left'],
};

function splitVariants(token) {
  const parts = splitTop(token, ':');
  const base = parts.pop();
  return { variants: parts.filter(Boolean), base };
}

/* Returns { properties, value, note } or null when the token is not a utility
   this scanner understands. `value === null` means "property known, value not
   computable" — the collision is then reported on property name only. */
function mapUtility(rawBase, vars) {
  let base = rawBase;
  let negative = false;
  if (base.startsWith('!')) base = base.slice(1);
  if (base.endsWith('!')) base = base.slice(0, -1);
  if (base.startsWith('-')) { negative = true; base = base.slice(1); }
  if (!base) return null;

  const bracket = /^([-\w]+(?:-[-\w]+)*?)-\[(.*)\]$/.exec(base);
  if (bracket) {
    let [, prefix, inner] = bracket;
    inner = inner.replace(/_/g, ' ');
    let hint = null;
    const hintMatch = /^([a-z-]+):(.*)$/.exec(inner);
    if (hintMatch && TYPE_HINTS[prefix] && TYPE_HINTS[prefix][hintMatch[1]]) {
      hint = hintMatch[1];
      inner = hintMatch[2];
    }
    let properties = null;
    if (hint) properties = TYPE_HINTS[prefix][hint];
    else if (prefix === 'bg' && /^(url|linear-gradient|radial-gradient|conic-gradient|image-set)\(/i.test(inner)) properties = ['background-image'];
    else properties = ARBITRARY_PREFIXES[prefix] ?? null;
    if (!properties) return { unmapped: true, base };

    /* Tailwind v4 cannot disambiguate `text-[var(--x)]` between a length and a
       colour and emits nothing at all. Same for a bare `border-[var(--x)]`.
       That utility is dead before the cascade is consulted. */
    const ambiguous =
      !hint &&
      TYPE_HINTS[prefix] &&
      /^var\(/i.test(inner.trim()) &&
      Object.keys(TYPE_HINTS[prefix]).length > 1 &&
      !COLOR_LIKE.test(inner.trim());

    const resolved = resolveVars(inner, vars);
    return {
      properties,
      value: negative ? `-${resolved}` : resolved,
      raw: inner,
      arbitrary: true,
      ambiguous: Boolean(ambiguous),
    };
  }

  /* `bg-(--x)` / `text-(length:--x)` shorthand for var() in Tailwind v4. */
  const paren = /^([-\w]+(?:-[-\w]+)*?)-\((.*)\)$/.exec(base);
  if (paren) {
    const [, prefix, innerRaw] = paren;
    let inner = innerRaw;
    let hint = null;
    const hintMatch = /^([a-z-]+):(.*)$/.exec(inner);
    if (hintMatch && TYPE_HINTS[prefix]?.[hintMatch[1]]) { hint = hintMatch[1]; inner = hintMatch[2]; }
    const properties = hint ? TYPE_HINTS[prefix][hint] : ARBITRARY_PREFIXES[prefix];
    if (!properties) return { unmapped: true, base };
    return { properties, value: resolveVars(`var(${inner})`, vars), raw: inner, arbitrary: true, ambiguous: false };
  }

  if (STATIC_UTILITIES[base]) {
    return { properties: Object.keys(STATIC_UTILITIES[base]), valueMap: STATIC_UTILITIES[base] };
  }

  /* font-<weight> / font-<family> */
  const fontM = /^font-(.+)$/.exec(base);
  if (fontM) {
    if (FONT_WEIGHTS[fontM[1]]) return { properties: ['font-weight'], value: FONT_WEIGHTS[fontM[1]] };
    const famVar = `--font-${fontM[1]}`;
    if (vars.globals.has(famVar)) return { properties: ['font-family'], value: resolveVars(`var(${famVar})`, vars) };
    return { properties: ['font-family'], value: null };
  }

  /* text-<size rung> vs text-<colour> */
  const textM = /^text-(.+)$/.exec(base);
  if (textM) {
    const rung = textM[1];
    if (TEXT_SIZE_RUNGS.has(rung)) {
      const v = vars.globals.get(`--text-${rung}`);
      return { properties: ['font-size'], value: v ? resolveVars(v, vars) : null };
    }
    const colourVar = vars.globals.get(`--color-${rung}`);
    if (colourVar) return { properties: ['color'], value: resolveVars(colourVar, vars) };
    if (NAMED_COLORS[rung]) return { properties: ['color'], value: NAMED_COLORS[rung] };
    return { unmapped: true, base };
  }

  const bgM = /^bg-(.+)$/.exec(base);
  if (bgM) {
    const colourVar = vars.globals.get(`--color-${bgM[1]}`);
    if (colourVar) return { properties: ['background-color'], value: resolveVars(colourVar, vars) };
    if (NAMED_COLORS[bgM[1]]) return { properties: ['background-color'], value: NAMED_COLORS[bgM[1]] };
    if (/^(cover|contain|center|top|bottom|left|right|fixed|local|scroll|no-repeat|repeat)$/.test(bgM[1])) {
      return { properties: ['background-size'], value: null };
    }
    return { unmapped: true, base };
  }

  const roundedM = /^rounded(?:-(t|b|l|r|tl|tr|bl|br))?(?:-(.+))?$/.exec(base);
  if (roundedM && (roundedM[1] || roundedM[2] || base === 'rounded')) {
    const rung = roundedM[2] ?? 'sm';
    if (RADIUS_RUNGS.has(rung)) {
      const v = rung === 'none' ? '0' : rung === 'full' ? '3.40282e38px' : vars.globals.get(`--radius-${rung}`);
      const props = ARBITRARY_PREFIXES[`rounded${roundedM[1] ? `-${roundedM[1]}` : ''}`] ?? ARBITRARY_PREFIXES.rounded;
      return { properties: props, value: v ? resolveVars(v, vars) : null };
    }
  }

  /* Numeric spacing scale: p-4, gap-3, mt-2, min-h-12, w-1/2 … */
  const spaceM = /^([a-z]+(?:-[a-z]+)?)-((?:\d+(?:\.\d+)?)|px|auto|full|screen|min|max|fit|(?:\d+\/\d+))$/.exec(base);
  if (spaceM && SPACING_PREFIXES[spaceM[1]]) {
    const props = SPACING_PREFIXES[spaceM[1]];
    const rung = spaceM[2];
    let value = null;
    if (rung === 'px') value = '1px';
    else if (rung === 'auto') value = 'auto';
    else if (rung === 'full') value = '100%';
    else if (rung === 'screen') value = props[0].includes('h') ? '100vh' : '100vw';
    else if (/^\d+\/\d+$/.test(rung)) {
      const [a, b] = rung.split('/').map(Number);
      value = `${Math.round((a / b) * 1000000) / 10000}%`;
    } else {
      const v = vars.globals.get(`--spacing-${rung}`);
      value = v ? resolveVars(v, vars) : null;
    }
    return { properties: props, value: value != null && negative ? `-${value}` : value };
  }

  /* z-10, opacity-60, order-2, grid-cols-3, col-span-2, leading-6, duration-150 */
  const numM = /^([a-z]+(?:-[a-z]+)*)-(\d+(?:\.\d+)?)$/.exec(base);
  if (numM) {
    const [, prefix, n] = numM;
    if (prefix === 'z') return { properties: ['z-index'], value: negative ? `-${n}` : n };
    if (prefix === 'opacity') return { properties: ['opacity'], value: String(Number(n) / 100) };
    if (prefix === 'order') return { properties: ['order'], value: negative ? `-${n}` : n };
    if (prefix === 'grid-cols') return { properties: ['grid-template-columns'], value: `repeat(${n},minmax(0,1fr))` };
    if (prefix === 'grid-rows') return { properties: ['grid-template-rows'], value: `repeat(${n},minmax(0,1fr))` };
    if (prefix === 'col-span') return { properties: ['grid-column'], value: `span ${n}/span ${n}` };
    if (prefix === 'row-span') return { properties: ['grid-row'], value: `span ${n}/span ${n}` };
    if (prefix === 'duration') return { properties: ['transition-duration'], value: `${n}ms` };
    if (prefix === 'delay') return { properties: ['transition-delay'], value: `${n}ms` };
    if (prefix === 'leading') {
      const v = vars.globals.get(`--spacing-${n}`);
      return { properties: ['line-height'], value: v ? resolveVars(v, vars) : null };
    }
    if (prefix === 'basis') {
      const v = vars.globals.get(`--spacing-${n}`);
      return { properties: ['flex-basis'], value: v ? resolveVars(v, vars) : null };
    }
    if (prefix === 'shadow' || prefix === 'ring') return { properties: ['box-shadow'], value: null };
  }

  if (/^(leading|tracking)-[a-z]+$/.test(base)) {
    const [prefix, rung] = base.split('-');
    const varName = prefix === 'leading' ? `--leading-${rung}` : `--tracking-${rung}`;
    const v = vars.globals.get(varName);
    return { properties: [prefix === 'leading' ? 'line-height' : 'letter-spacing'], value: v ? resolveVars(v, vars) : null };
  }

  if (/^(shadow|ring|outline)-/.test(base)) return { properties: [base.startsWith('outline') ? 'outline-color' : 'box-shadow'], value: null };

  return { unmapped: true, base };
}

/* ══════════════════════════════════════════════ 6. JSX className RESOLUTION ══ */

const MAX_VARIANTS = 48;

function cartesian(listOfSets) {
  let acc = [''];
  for (const set of listOfSets) {
    const next = [];
    for (const prefix of acc) {
      for (const s of set) {
        next.push(prefix + s);
        if (next.length > MAX_VARIANTS) return { values: next.slice(0, MAX_VARIANTS), truncated: true };
      }
    }
    acc = next;
  }
  return { values: acc, truncated: false };
}

const UNRESOLVED = Symbol('unresolved');

function createResolver(sourceFile, moduleExports, resolveImport) {
  /* name -> array of possible strings, or UNRESOLVED */
  const bindings = new Map();
  const functions = new Map();
  const importAliases = new Map(); // localName -> {module, exported}

  function record(name, node) {
    if (!bindings.has(name)) bindings.set(name, node);
  }

  function walkDeclarations(node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      if (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)) {
        functions.set(node.name.text, node.initializer);
      } else {
        record(node.name.text, node.initializer);
      }
    }
    if (ts.isFunctionDeclaration(node) && node.name) functions.set(node.name.text, node);
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
    if (!node || depth > 24) return UNRESOLVED;
    if (ts.isParenthesizedExpression(node)) return evaluate(node.expression, depth + 1);
    if (ts.isAsExpression(node) || ts.isSatisfiesExpression?.(node) || ts.isTypeAssertionExpression?.(node)) {
      return evaluate(node.expression, depth + 1);
    }
    if (ts.isNonNullExpression(node)) return evaluate(node.expression, depth + 1);
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return [node.text];
    if (ts.isNumericLiteral(node)) return [node.text];
    if (node.kind === ts.SyntaxKind.TrueKeyword) return ['true'];
    if (node.kind === ts.SyntaxKind.FalseKeyword) return ['false'];
    if (node.kind === ts.SyntaxKind.NullKeyword || node.kind === ts.SyntaxKind.UndefinedKeyword) return [''];

    if (ts.isTemplateExpression(node)) {
      const pieces = [[node.head.text]];
      for (const span of node.templateSpans) {
        const part = evaluate(span.expression, depth + 1);
        if (part === UNRESOLVED) return UNRESOLVED;
        pieces.push(part);
        pieces.push([span.literal.text]);
      }
      const { values } = cartesian(pieces);
      return values;
    }

    if (ts.isBinaryExpression(node)) {
      const op = node.operatorToken.kind;
      if (op === ts.SyntaxKind.PlusToken) {
        const l = evaluate(node.left, depth + 1);
        const r = evaluate(node.right, depth + 1);
        if (l === UNRESOLVED || r === UNRESOLVED) return UNRESOLVED;
        return cartesian([l, r]).values;
      }
      if (op === ts.SyntaxKind.AmpersandAmpersandToken) {
        const r = evaluate(node.right, depth + 1);
        if (r === UNRESOLVED) return UNRESOLVED;
        return ['', ...r];
      }
      if (op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.QuestionQuestionToken) {
        const l = evaluate(node.left, depth + 1);
        const r = evaluate(node.right, depth + 1);
        if (l === UNRESOLVED || r === UNRESOLVED) return UNRESOLVED;
        return [...l, ...r];
      }
      return UNRESOLVED;
    }

    if (ts.isConditionalExpression(node)) {
      const a = evaluate(node.whenTrue, depth + 1);
      const b = evaluate(node.whenFalse, depth + 1);
      if (a === UNRESOLVED || b === UNRESOLVED) return UNRESOLVED;
      return [...a, ...b];
    }

    if (ts.isIdentifier(node)) {
      const name = node.text;
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

    /* MAP[key] / MAP.key — union of every value the object literal can yield. */
    if (ts.isElementAccessExpression(node) || ts.isPropertyAccessExpression(node)) {
      const objName = ts.isIdentifier(node.expression) ? node.expression.text : null;
      const init = objName ? bindings.get(objName) : null;
      if (init && ts.isObjectLiteralExpression(init)) {
        const out = [];
        for (const p of init.properties) {
          if (ts.isPropertyAssignment(p)) {
            const v = evaluate(p.initializer, depth + 1);
            if (v === UNRESOLVED) return UNRESOLVED;
            out.push(...v);
          } else return UNRESOLVED;
        }
        return out;
      }
      return UNRESOLVED;
    }

    /* [a, b].filter(Boolean).join(' ') and friends. */
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'join') {
        const sep = node.arguments[0] && ts.isStringLiteral(node.arguments[0]) ? node.arguments[0].text : ',';
        let target = callee.expression;
        while (ts.isCallExpression(target) && ts.isPropertyAccessExpression(target.expression)
               && ['filter', 'map', 'flat', 'concat'].includes(target.expression.name.text)) {
          if (target.expression.name.text !== 'filter') return UNRESOLVED;
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
          return cartesian(pieces).values;
        }
        return UNRESOLVED;
      }
      /* A local helper returning a class string: inline its body. Parameters
         stay unbound, so any expression that depends on one falls through to
         UNRESOLVED rather than being invented — but `cond ? 'a' : 'b'` inside
         the body still resolves to both branches, which is what
         SignInPanel's methodButton() needs. */
      if (ts.isIdentifier(callee) && functions.has(callee.text)) {
        const fn = functions.get(callee.text);
        if (evaluating.has(`fn:${callee.text}`)) return UNRESOLVED;
        evaluating.add(`fn:${callee.text}`);
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
        evaluating.delete(`fn:${callee.text}`);
        return result;
      }
      return UNRESOLVED;
    }

    return UNRESOLVED;
  }

  return { evaluate, bindings, functions };
}

/* ══════════════════════════════════════════════════════════ 7. THE SCAN ══ */

function walkFiles(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next' || entry === 'coverage' || entry === '.git') continue;
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walkFiles(full, out);
    else if (/\.tsx$/.test(entry) && !/\.test\.tsx$/.test(entry) && !/\.stories\.tsx$/.test(entry)) out.push(full);
  }
  return out;
}

/* Module-level exported string constants, so `import { BAND } from './x'`
   resolves across files instead of counting as unresolved. */
function collectModuleExports(files) {
  const cache = new Map();
  const sources = new Map();
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    sources.set(file, ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX));
  }
  function exportsOf(file) {
    if (cache.has(file)) return cache.get(file);
    const map = new Map();
    cache.set(file, map);
    const sf = sources.get(file);
    if (!sf) return map;
    const resolver = createResolver(sf, null, null);
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
  }
  return { exportsOf, sources };
}

function tokensOf(classString) {
  return classString.split(/\s+/).filter(Boolean);
}

function main() {
  const argv = process.argv.slice(2);
  const has = (f) => argv.includes(`--${f}`);
  const arg = (f) => { const i = argv.indexOf(`--${f}`); return i === -1 ? null : argv[i + 1]; };

  if (has('self-test')) return selfTest();

  /* --- CSS side ---------------------------------------------------------- */
  const ppbfRules = parseCss(PPBF_CSS);
  const globalRules = parseCss(GLOBALS_CSS);
  const vars = collectVars([...ppbfRules, ...globalRules]);

  /* The unlayered cascade: ppbf.css entirely (it declares no @layer at all),
     plus every rule in globals.css that sits OUTSIDE its two `@layer base`
     blocks. globals.css @imports ppbf.css at its top, so it is later in source
     order — which is how it wins ties. Both sheets can defeat a utility, and a
     collision report that only looked at ppbf.css would attribute a globals.css
     override to the wrong file. */
  const unlayered = [];
  for (const [order, rule] of [...ppbfRules, ...globalRules].entries()) {
    if (rule.layer) continue;
    if (rule.atRule) continue;
    const info = analyzeSelector(rule.selector);
    if (info.pseudoElement) continue;   /* ::before cannot defeat a utility on the element */
    if (!info.classes.length) continue; /* bare element/`*` rules lose to any class utility */
    unlayered.push({ ...rule, info, order });
  }

  /* class -> property -> winning declaration (highest specificity, then last). */
  const byClass = new Map();
  for (const rule of unlayered) {
    const conditional =
      rule.info.hasAncestor ||
      rule.info.pseudoClasses.length > 0 ||
      rule.info.attrs.length > 0 ||
      rule.media.length > 0 ||
      rule.info.classes.length > 1;
    for (const d of rule.decls) {
      if (d.prop.startsWith('--')) continue;
      for (const [prop, value] of expandDeclaration(d.prop, d.value)) {
        for (const cls of rule.info.classes) {
          if (!byClass.has(cls)) byClass.set(cls, new Map());
          const slot = byClass.get(cls);
          const key = `${prop}|${conditional ? rule.info.pseudoClasses.join('') + rule.info.attrs.join('') + rule.media.join('') : ''}`;
          const candidate = {
            cls, prop, value, important: d.important, line: d.line, file: rule.file,
            selector: rule.selector, media: rule.media, conditional,
            pseudoClasses: rule.info.pseudoClasses, attrs: rule.info.attrs,
            requiresAncestor: rule.info.hasAncestor,
            requiresSiblingClass: rule.info.classes.length > 1 ? rule.info.classes.filter((c) => c !== cls) : [],
            specificity: rule.info.specificity, order: rule.order, shorthandOf: d.prop,
          };
          const prev = slot.get(key);
          if (!prev) { slot.set(key, candidate); continue; }
          if (prev.important && !candidate.important) continue;
          if (!prev.important && candidate.important) { slot.set(key, candidate); continue; }
          if (specLess(prev.specificity, candidate.specificity)) { slot.set(key, candidate); continue; }
          if (!specLess(candidate.specificity, prev.specificity) && candidate.order >= prev.order) slot.set(key, candidate);
        }
      }
    }
  }

  /* --- JSX side ---------------------------------------------------------- */
  const roots = [path.join(WEB_ROOT, 'app'), path.join(WEB_ROOT, 'components'), path.join(WEB_ROOT, 'src')]
    .filter((p) => { try { return statSync(p).isDirectory(); } catch { return false; } });
  const files = roots.flatMap((r) => walkFiles(r)).sort();
  const { exportsOf, sources } = collectModuleExports(files);

  const stats = {
    files: files.length,
    classNameSites: 0,
    resolvedSites: 0,
    unresolvedSites: 0,
    unresolvedDetail: [],
    variantStrings: 0,
    unmappedTokens: new Map(),
    ambiguousArbitrary: [],
  };

  const collisions = [];
  const seen = new Set();

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
    const resolver = createResolver(sf, null, resolveImport);

    const visit = (node) => {
      if (ts.isJsxAttribute(node) && ts.isIdentifier(node.name) && (node.name.text === 'className' || node.name.text === 'class')) {
        const parent = node.parent?.parent;
        const tag = parent && (ts.isJsxSelfClosingElement(parent) || ts.isJsxOpeningElement(parent))
          ? parent.tagName.getText(sf) : '?';
        const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
        stats.classNameSites += 1;

        /* Inline `style={{...}}` on the same element wins over every sheet, so
           a property set there cannot be a layer casualty. */
        const inlineProps = new Set();
        const attrs = node.parent;
        for (const a of attrs.properties) {
          if (ts.isJsxAttribute(a) && ts.isIdentifier(a.name) && a.name.text === 'style' && a.initializer
              && ts.isJsxExpression(a.initializer) && a.initializer.expression
              && ts.isObjectLiteralExpression(a.initializer.expression)) {
            for (const p of a.initializer.expression.properties) {
              if (ts.isPropertyAssignment(p)) {
                const key = ts.isIdentifier(p.name) || ts.isStringLiteral(p.name) ? p.name.text : null;
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
            expression: node.initializer?.getText(sf).slice(0, 120).replace(/\s+/g, ' ') ?? '(none)',
          });
        } else {
          stats.resolvedSites += 1;
          stats.variantStrings += values.length;
          for (const variant of values) {
            examine({ variant, file, line, tag, inlineProps });
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }

  function examine({ variant, file, line, tag, inlineProps }) {
    const tokens = tokensOf(variant);
    const ppbfClasses = tokens.filter((t) => byClass.has(t) && !t.includes(':') && !t.includes('['));
    if (!ppbfClasses.length) return;

    for (const token of tokens) {
      if (ppbfClasses.includes(token)) continue;
      const { variants, base } = splitVariants(token);
      const mapped = mapUtility(base, vars);
      if (!mapped) continue;
      if (mapped.unmapped) {
        /* Only count a token as unmapped if it could plausibly be a utility —
           a bare word with no dash that is not in the static table is much more
           likely to be a project class than a Tailwind utility. */
        if (base.includes('-') || base.includes('[')) {
          stats.unmappedTokens.set(base, (stats.unmappedTokens.get(base) ?? 0) + 1);
        }
        continue;
      }
      if (mapped.ambiguous) {
        stats.ambiguousArbitrary.push({ file: path.relative(REPO_ROOT, file), line, tag, token });
        continue;
      }

      const stateVariants = variants.filter((v) => !/^(sm|md|lg|xl|2xl|max-sm|max-md|max-lg|print)$/.test(v));
      const breakpointVariants = variants.filter((v) => /^(sm|md|lg|xl|2xl|max-sm|max-md|max-lg|print)$/.test(v));

      const props = mapped.properties ?? Object.keys(mapped.valueMap ?? {});
      for (const prop of props) {
        if (inlineProps.has(prop) || inlineProps.has(prop.replace(/^(padding|margin)-(top|right|bottom|left)$/, '$1'))) continue;
        const utilValue = mapped.valueMap ? mapped.valueMap[prop] : mapped.value;

        for (const cls of ppbfClasses) {
          const slot = byClass.get(cls);
          for (const [key, decl] of slot) {
            if (!key.startsWith(`${prop}|`)) continue;
            /* A ppbf rule that needs an ancestor, or a sibling class this
               element does not carry, is not proven to apply here. */
            if (decl.requiresAncestor) continue;
            if (decl.requiresSiblingClass.length && !decl.requiresSiblingClass.every((c) => tokens.includes(c))) continue;

            /* State matching. `.btn--lever:hover` only defeats `hover:` — and
               an unprefixed utility only meets an unconditional ppbf rule. */
            const declStates = decl.pseudoClasses.map((p) => p.replace(/^:+/, '').split('(')[0]);
            const utilStates = stateVariants.map((v) => v.replace(/^(group|peer)-/, ''));
            const stateMatch = declStates.length === 0
              ? utilStates.length === 0
              : declStates.every((s) => utilStates.includes(s));
            if (!stateMatch) continue;
            if (decl.attrs.length) continue; /* [aria-busy] etc. — element-state dependent, not statically decidable */

            const cssValue = normalizeValue(decl.value);
            const tw = normalizeValue(utilValue);
            const id = `${file}:${line}:${cls}:${prop}:${token}`;
            if (seen.has(id)) continue;
            seen.add(id);

            collisions.push({
              file: path.relative(REPO_ROOT, file),
              line,
              tag,
              variant: variant.length > 160 ? `${variant.slice(0, 160)}…` : variant,
              ppbfClass: cls,
              ppbfSelector: decl.selector,
              ppbfFile: path.relative(REPO_ROOT, decl.file),
              ppbfLine: decl.line,
              ppbfShorthand: decl.shorthandOf,
              property: prop,
              ppbfValueRaw: decl.value === UNKNOWN_VALUE ? '(shorthand, value not decomposable)' : decl.value,
              ppbfValue: cssValue,
              utility: token,
              utilityValueRaw: utilValue,
              utilityValue: tw,
              arbitrary: Boolean(mapped.arbitrary),
              breakpointOnly: breakpointVariants.length > 0,
              breakpoints: breakpointVariants,
              states: stateVariants,
              ppbfMedia: decl.media,
              important: decl.important,
            });
          }
        }
      }
    }
  }

  for (const c of collisions) c.bucket = classify(c);

  const buckets = { HARMLESS: [], DEAD: [], BROKEN: [] };
  for (const c of collisions) buckets[c.bucket].push(c);

  const report = {
    generatedFrom: { ppbf: path.relative(REPO_ROOT, PPBF_CSS), globals: path.relative(REPO_ROOT, GLOBALS_CSS) },
    stats: {
      filesScanned: stats.files,
      classNameSites: stats.classNameSites,
      resolvedSites: stats.resolvedSites,
      unresolvedSites: stats.unresolvedSites,
      classStringVariants: stats.variantStrings,
      ppbfClassesWithDeclarations: byClass.size,
      collisions: collisions.length,
      HARMLESS: buckets.HARMLESS.length,
      DEAD: buckets.DEAD.length,
      BROKEN: buckets.BROKEN.length,
      unmappedTokenKinds: stats.unmappedTokens.size,
      unmappedTokenSites: [...stats.unmappedTokens.values()].reduce((a, b) => a + b, 0),
      ambiguousArbitrarySites: stats.ambiguousArbitrary.length,
    },
    buckets,
    unresolved: stats.unresolvedDetail,
    unmapped: [...stats.unmappedTokens.entries()].sort((a, b) => b[1] - a[1]),
    ambiguous: stats.ambiguousArbitrary,
  };

  if (has('json')) { process.stdout.write(`${JSON.stringify(report, null, 2)}\n`); return; }
  const md = renderMarkdown(report);
  const target = arg('markdown');
  if (target) { writeFileSync(target, md); process.stderr.write(`wrote ${target}\n`); }
  else process.stdout.write(md);
}

/* ═════════════════════════════════════════════════════════ 8. CLASSIFIER ══ */

/* Properties where losing the utility moves something on screen: where a box
   is, how big it is, whether it is laid out at all. A wrong colour is a defect
   too, but the design system is the authority on colour by construction — a
   ppbf class winning a colour is the system working. A ppbf class winning a
   POSITION is the system silently overruling a layout instruction. */
const GEOMETRY_PROPERTIES = new Set([
  'position', 'display', 'top', 'right', 'bottom', 'left', 'z-index',
  'min-height', 'min-width', 'max-width', 'max-height', 'width', 'height',
  'flex-direction', 'flex-wrap', 'align-items', 'justify-content', 'align-self',
  'grid-template-columns', 'grid-template-rows', 'grid-column', 'grid-row',
  'overflow-x', 'overflow-y', 'flex-grow', 'flex-shrink', 'flex-basis',
  'row-gap', 'column-gap',
  'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
]);

/* A utility that merely restates the browser default for a property the ppbf
   class deliberately owns is not a lost instruction. */
const DEFAULTISH = new Set(['static', 'normal', 'auto', 'none', 'visible', 'stretch', 'row', 'nowrap', '0']);

export function classify(c) {
  /* Same value on both sides: the cascade decided nothing. */
  if (c.ppbfValue != null && c.utilityValue != null && c.ppbfValue === c.utilityValue) return 'HARMLESS';

  /* One side not decomposable (a `background:` or `transition:` shorthand, a
     `shadow-*` rung with no computable value). Property-level collision only:
     real, but no evidence a specific instruction was lost. */
  if (c.ppbfValue == null || c.utilityValue == null) return 'DEAD';

  if (GEOMETRY_PROPERTIES.has(c.property) && !DEFAULTISH.has(c.utilityValue)) return 'BROKEN';

  return 'DEAD';
}

/* ═══════════════════════════════════════════════════════════ 9. RENDERING ══ */

function renderMarkdown(report) {
  const s = report.stats;
  const L = [];
  L.push('# CSS layer collisions — Tailwind utilities defeated by unlayered rules');
  L.push('');
  L.push('_Generated by `apps/web/scripts/css-layer-collisions.mjs`. Re-run with_');
  L.push('`node scripts/css-layer-collisions.mjs --markdown <file>` _from `apps/web`._');
  L.push('');
  L.push('| | |');
  L.push('|---|---|');
  L.push(`| Files scanned (.tsx, tests excluded) | ${s.filesScanned} |`);
  L.push(`| \`className\` sites | ${s.classNameSites} |`);
  L.push(`| …statically resolved | ${s.resolvedSites} |`);
  L.push(`| …**unresolved** (counted, not skipped) | ${s.unresolvedSites} |`);
  L.push(`| Distinct class strings after ternary expansion | ${s.classStringVariants} |`);
  L.push(`| ppbf/globals classes carrying declarations | ${s.ppbfClassesWithDeclarations} |`);
  L.push(`| **Collisions** | **${s.collisions}** |`);
  L.push(`| — HARMLESS | ${s.HARMLESS} |`);
  L.push(`| — DEAD | ${s.DEAD} |`);
  L.push(`| — BROKEN | ${s.BROKEN} |`);
  L.push(`| Tailwind tokens the map does not cover | ${s.unmappedTokenKinds} kinds / ${s.unmappedTokenSites} sites |`);
  L.push(`| Ambiguous arbitrary values (Tailwind emits nothing) | ${s.ambiguousArbitrarySites} |`);
  L.push('');

  const section = (name, blurb, items, full) => {
    L.push(`## ${name} — ${items.length}`);
    L.push('');
    L.push(blurb);
    L.push('');
    if (!items.length) { L.push('_None._'); L.push(''); return; }
    if (full) {
      for (const c of items) {
        L.push(`### \`${c.file}\`:${c.line} — \`<${c.tag}>\``);
        L.push('');
        L.push(`- **Property**: \`${c.property}\``);
        L.push(`- **Wins**: \`${c.ppbfSelector}\` → \`${c.ppbfShorthand}: ${c.ppbfValueRaw}\` (${c.ppbfFile}:${c.ppbfLine}) → \`${c.ppbfValue}\``);
        L.push(`- **Loses**: \`${c.utility}\` → \`${c.utilityValueRaw}\` → \`${c.utilityValue}\``);
        if (c.breakpointOnly) L.push(`- **Scope**: only at \`${c.breakpoints.join(', ')}\`; the ppbf rule applies at every width, so the utility is defeated inside its own breakpoint too.`);
        if (c.states.length) L.push(`- **State**: \`${c.states.join(', ')}\``);
        L.push(`- **What a user sees**: ${userVisible(c)}`);
        L.push(`- Class string: \`${c.variant}\``);
        L.push('');
      }
      return;
    }
    L.push('| file:line | element | ppbf class → value | utility → value | property |');
    L.push('|---|---|---|---|---|');
    for (const c of items) {
      L.push(`| \`${c.file}\`:${c.line} | \`${c.tag}\` | \`.${c.ppbfClass}\` → \`${c.ppbfValue ?? '?'}\` | \`${c.utility}\` → \`${c.utilityValue ?? '?'}\` | \`${c.property}\` |`);
    }
    L.push('');
  };

  section('BROKEN', 'The utility was a deliberate geometry or layout instruction with a value that differs from the ppbf value. It never applied. This is the bug list.', report.buckets.BROKEN, true);
  section('DEAD', 'The utility never applied, but the ppbf value is the design system doing its job (colour, surface, type) or the ppbf side is a shorthand whose value cannot be decomposed. Removing the utility changes nothing on screen; keeping it is a second, wrong answer to "what does this element look like".', report.buckets.DEAD, false);
  section('HARMLESS', 'Both sides resolve to the same computed value. The cascade decided nothing.', report.buckets.HARMLESS, false);

  L.push(`## Unresolved class strings — ${report.unresolved.length}`);
  L.push('');
  L.push('`className` expressions the resolver could not reduce to a set of literal strings. Each is a site this scan did NOT see; the collision counts above are a floor, not a total.');
  L.push('');
  if (report.unresolved.length) {
    L.push('| file:line | element | expression |');
    L.push('|---|---|---|');
    for (const u of report.unresolved) L.push(`| \`${u.file}\`:${u.line} | \`${u.tag}\` | \`${u.expression.replace(/\|/g, '\\|')}\` |`);
    L.push('');
  } else { L.push('_None._'); L.push(''); }

  L.push(`## Ambiguous arbitrary values — ${report.ambiguous.length}`);
  L.push('');
  L.push('A DIFFERENT defect that turned up on the way: Tailwind v4 cannot tell whether `text-[var(--x)]` is a length or a colour and emits nothing at all for it. These are dead before the cascade is consulted, so they are not counted as collisions.');
  L.push('');
  if (report.ambiguous.length) {
    L.push('| file:line | element | token |');
    L.push('|---|---|---|');
    for (const a of report.ambiguous) L.push(`| \`${a.file}\`:${a.line} | \`${a.tag}\` | \`${a.token}\` |`);
    L.push('');
  } else { L.push('_None._'); L.push(''); }

  L.push(`## Tokens the utility map does not cover — ${report.unmapped.length}`);
  L.push('');
  L.push('Reported rather than swallowed. Each is a token that looked like a utility but has no property mapping, so it was not compared against anything.');
  L.push('');
  if (report.unmapped.length) {
    L.push('| token | sites |');
    L.push('|---|---|');
    for (const [t, n] of report.unmapped.slice(0, 200)) L.push(`| \`${t}\` | ${n} |`);
    L.push('');
  } else { L.push('_None._'); L.push(''); }

  return L.join('\n');
}

function userVisible(c) {
  const p = c.property;
  const a = c.utilityValue;
  const b = c.ppbfValue;
  if (p === 'position') return `The element is positioned \`${b}\` instead of \`${a}\`, so anything offset against it lands in the wrong place.`;
  if (p === 'min-height') return `The control is ${b} tall where the source asks for ${a}.`;
  if (p === 'min-width') return `The element is at least ${b} wide where the source asks for ${a}.`;
  if (p === 'display') return `The element lays out as \`${b}\` instead of \`${a}\`, so its children stack the wrong way.`;
  if (p === 'width' || p === 'height') return `The box is ${b} where the source asks for ${a}.`;
  if (p.startsWith('padding')) return `${p.replace('padding-', '')} padding is ${b} instead of ${a}.`;
  if (p.startsWith('margin')) return `${p.replace('margin-', '')} margin is ${b} instead of ${a}.`;
  if (p === 'row-gap' || p === 'column-gap') return `Items sit ${b} apart instead of ${a}.`;
  if (p === 'align-items' || p === 'justify-content') return `Children align \`${b}\` instead of \`${a}\`.`;
  if (p === 'grid-template-columns') return `The grid uses \`${b}\` columns instead of \`${a}\`.`;
  if (p === 'z-index') return `The element stacks at ${b} instead of ${a}.`;
  if (p.startsWith('overflow')) return `Content overflows \`${b}\` instead of \`${a}\`.`;
  if (p === 'top' || p === 'right' || p === 'bottom' || p === 'left') return `The ${p} offset is ${b} instead of ${a}.`;
  return `\`${p}\` renders as \`${b}\` instead of the \`${a}\` the source asks for.`;
}

/* ════════════════════════════════════════════════════════ 10. SELF TEST ══ */

/* These are the classifier's contract, written so each one FAILS if the rule
   it guards is inverted. Run: node scripts/css-layer-collisions.mjs --self-test */
function selfTest() {
  const cases = [
    ['equal values are harmless', { property: 'min-height', ppbfValue: '100vh', utilityValue: '100vh' }, 'HARMLESS'],
    ['lost position is broken', { property: 'position', ppbfValue: 'relative', utilityValue: 'absolute' }, 'BROKEN'],
    ['lost min-height is broken', { property: 'min-height', ppbfValue: '38px', utilityValue: '44px' }, 'BROKEN'],
    ['lost background colour is dead', { property: 'background-color', ppbfValue: '#2e1d0e', utilityValue: '#14100d' }, 'DEAD'],
    ['undecomposable shorthand is dead', { property: 'background-color', ppbfValue: null, utilityValue: '#14100d' }, 'DEAD'],
    ['default-ish utility is dead', { property: 'position', ppbfValue: 'relative', utilityValue: 'static' }, 'DEAD'],
  ];
  let failed = 0;
  for (const [name, input, expected] of cases) {
    const got = classify(input);
    const ok = got === expected;
    if (!ok) failed += 1;
    process.stdout.write(`${ok ? 'ok  ' : 'FAIL'}  ${name} — expected ${expected}, got ${got}\n`);
  }
  process.stdout.write(`\n${cases.length - failed}/${cases.length} passed\n`);
  process.exitCode = failed ? 1 : 0;
}

main();
