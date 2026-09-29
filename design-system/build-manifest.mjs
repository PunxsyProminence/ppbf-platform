#!/usr/bin/env node
/**
 * Generates manifest.json — the machine-readable index of this design system.
 *
 * The point: any tool (Claude Design, another agent, a docs site) should be able
 * to fetch ONE file and know the whole system — every preview, what it covers,
 * every token, and the entry points — without crawling 18 HTML files and
 * guessing.
 *
 * GENERATED, NOT HAND-WRITTEN, on purpose. A hand-maintained index drifts the
 * first time someone adds a preview and forgets, and a stale index is worse
 * than none because it is believed. Re-run after changing previews or tokens:
 *
 *   node design-system/build-manifest.mjs
 *
 * Exits non-zero if a preview is missing its @dsCard marker, so CI can catch a
 * preview that would be invisible to the Design System pane.
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const GROUPS = ['foundations', 'components', 'screens'];

/* ---- previews: read the @dsCard marker each one carries on line 1 -------- */
function parseCard(html) {
  const m = html.match(/<!--\s*@dsCard\s+([^>]*?)-->/);
  if (!m) return null;
  const attrs = {};
  for (const a of m[1].matchAll(/(\w+)="([^"]*)"/g)) attrs[a[1]] = a[2];
  return attrs;
}

const previews = [];
const missing = [];
for (const group of GROUPS) {
  for (const file of readdirSync(join(ROOT, group)).filter((f) => f.endsWith('.html')).sort()) {
    const path = `${group}/${file}`;
    const html = readFileSync(join(ROOT, path), 'utf8');
    const card = parseCard(html);
    if (!card) { missing.push(path); continue; }
    previews.push({
      path,
      group: card.group ?? group,
      name: card.name ?? file.replace(/\.html$/, ''),
      subtitle: card.subtitle ?? '',
      bytes: statSync(join(ROOT, path)).size,
    });
  }
}

/* ---- stylesheets: the chain the browser loads, starting at ppbf.css ------ */
/* The visual reset of 2026-08-23 turned ppbf.css into two import lines, so
   reading it alone would produce an empty manifest. This used to name two
   sheets by hand -- the foundation and the retired Leather & Brass sheet --
   and so never read the Golden Era sheet that is the current look, and every
   token declared only there was missing. It now follows the imports from
   ppbf.css the way the browser does, so whatever current/ppbf-theme.css
   points at is read without an edit here.

   LOAD ORDER. An import's rules come before the importing sheet's own rules,
   so each sheet is listed after everything it imports: foundation, then the
   legacy fonts and the Leather & Brass sheet, then Golden Era, then the theme
   seam. A token declared in more than one sheet resolves to the last one, as
   it does in the browser. Same import pattern as
   apps/web/src/design/readDesignSystemCss.ts; only relative specifiers are
   followed, and a cycle contributes nothing on its second visit. */
const IMPORT_RULE = /@import\s+(?:url\()?["']([^"']+)["']\)?[^;]*;/g;

/* Comments removed, strings kept intact, so a quoted data URI that happens to
   contain slashes and asterisks is not read as a comment. */
function stripComments(css) {
  let out = '';
  let quote = null;
  for (let i = 0; i < css.length; i++) {
    const c = css[i];
    if (quote) {
      out += c;
      if (c === '\\') { out += css[i + 1] ?? ''; i++; } else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; out += c; continue; }
    if (c === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2);
      i = end === -1 ? css.length : end + 1;
      out += ' ';
      continue;
    }
    out += c;
  }
  return out;
}

function loadChain(file, seen = new Set(), sheets = []) {
  if (seen.has(file)) return sheets;
  seen.add(file);
  const css = stripComments(readFileSync(file, 'utf8'));
  for (const m of css.matchAll(IMPORT_RULE)) {
    const specifier = m[1];
    if (specifier.startsWith('./') || specifier.startsWith('../')) {
      loadChain(join(dirname(file), specifier), seen, sheets);
    }
  }
  sheets.push({ path: relative(ROOT, file).split(sep).join('/'), css });
  return sheets;
}

/* What each sheet is, from where it sits. The retired Leather & Brass sheets
   under legacy/ still load -- Golden Era is built on top of them -- so they are
   listed, and labelled as what they are. */
function roleOf(p) {
  if (p === 'ppbf.css') return 'entry';
  if (p === 'current/ppbf-theme.css') return 'seam';
  if (p.startsWith('current/')) return 'current';
  if (p.startsWith('foundation/')) return 'foundation';
  if (p.startsWith('legacy/')) return 'legacy';
  return 'unclassified';
}
const ROLE_NOTES = {
  entry: 'The one stylesheet pages load; imports only.',
  foundation: 'Structure, accessibility and responsive mechanics. No look.',
  legacy: 'Retired Leather & Brass (2026-08-23, legacy/README.md). Still loaded: the Golden Era sheet imports the Leather & Brass sheet as its base, and that sheet imports the legacy fonts.',
  current: 'Golden Era V1, the current look (../docs/GOLDEN-ERA-V1-CONTRACT.md).',
  seam: 'The theme seam: the one import that decides the look.',
  unclassified: 'Not under foundation/, current/ or legacy/.',
};

const sheets = loadChain(join(ROOT, 'ppbf.css'));

/* ---- tokens: the custom properties of every top-level :root block -------- */
/* TOP-LEVEL ONLY. The regex this replaced swept in the :root inside the
   legacy sheet's print block, so the manifest recorded the print override of
   --cleared, --monitor and --restricted as their values. Declarations are
   split on semicolons rather than read one per line, because the legacy
   sheet packs several onto one line and the old line-anchored match kept only
   the first (design-system/README.md, "Token count"). */
function topLevelRules(css) {
  const rules = [];
  let depth = 0;
  let start = 0;
  let prelude = '';
  let bodyStart = 0;
  let quote = null;
  for (let i = 0; i < css.length; i++) {
    const c = css[i];
    if (quote) {
      if (c === '\\') i++; else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === '{') {
      if (depth === 0) { prelude = css.slice(start, i).trim(); bodyStart = i + 1; }
      depth++;
    } else if (c === '}') {
      depth--;
      if (depth === 0) { rules.push({ prelude, body: css.slice(bodyStart, i) }); start = i + 1; }
    } else if (c === ';' && depth === 0) {
      start = i + 1;
    }
  }
  return rules;
}

function declarations(body) {
  const out = [];
  let parens = 0;
  let quote = null;
  let start = 0;
  for (let i = 0; i <= body.length; i++) {
    const c = body[i];
    if (quote) {
      if (c === '\\') i++; else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === '(') parens++;
    else if (c === ')') parens--;
    else if ((c === ';' && parens === 0) || i === body.length) {
      const decl = body.slice(start, i).trim();
      const colon = decl.indexOf(':');
      if (decl.startsWith('--') && colon > 0) out.push([decl.slice(0, colon).trim(), decl.slice(colon + 1).trim()]);
      start = i + 1;
    }
  }
  return out;
}

const tokens = {};
const stylesheets = [];
for (const sheet of sheets) {
  const declared = new Set();
  for (const rule of topLevelRules(sheet.css)) {
    if (rule.prelude !== ':root') continue;
    for (const [name, raw] of declarations(rule.body)) {
      declared.add(name);
      // The generated feTurbulence data URIs are enormous and carry no meaning as
      // text; record that they exist rather than inlining kilobytes of base64.
      tokens[name] = raw.startsWith('url("data:image/svg+xml')
        ? '<generated SVG data URI>'
        : raw.replace(/\s+/g, ' ');
    }
  }
  const role = roleOf(sheet.path);
  stylesheets.push({ path: sheet.path, role, note: ROLE_NOTES[role], tokensDeclared: declared.size });
}

const names = Object.keys(tokens);
const byPrefix = (p) => names.filter((t) => t.startsWith(p)).length;

/* ---- rooms: the room grounds, read from the stylesheets ------------------ */
const css = sheets.map((s) => s.css).join('\n');
const rooms = [...css.matchAll(/^\.room--(\w+)\s*\{/gm)].map((m) => m[1])
  .filter((v, i, a) => a.indexOf(v) === i);

/* ---- fonts --------------------------------------------------------------- */
const fontsCss = readFileSync(join(ROOT, 'legacy/legacy-fonts.css'), 'utf8');
const faces = [...fontsCss.matchAll(/font-family:\s*'([^']+)'/g)].map((m) => m[1]);
const fontFiles = readdirSync(join(ROOT, 'fonts')).filter((f) => f.endsWith('.woff2')).sort();
const fontBytes = fontFiles.reduce((n, f) => n + statSync(join(ROOT, 'fonts', f)).size, 0);

/* ---- assemble ------------------------------------------------------------ */
const manifest = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  name: 'PPBF Design System — Golden Era V1',
  description:
    "The design system for the Punxsy Prominence Boxing and Fitness platform. The active look is Golden Era V1 (../docs/GOLDEN-ERA-V1-CONTRACT.md): current/ppbf-theme.css imports current/ppbf-golden-era.css, which imports the retired Leather & Brass sheet (legacy/ppbf-leather-brass.css) as its base and overrides part of it. Laws 1, 4, 6 and 8 below are retired (OD-2026-09-28-009); laws 2, 3, 5 and 7 stand. build-manifest.mjs hardcodes the laws and the display voice. It generates the stylesheets, rooms and tokens by following the import chain from ppbf.css in the order the browser loads it, so a token declared in more than one sheet has the value of the last one, and it reads top-level :root blocks only, so print and other media overrides are not recorded.",
  license: 'MIT',
  generatedBy: 'design-system/build-manifest.mjs',

  entryPoints: {
    stylesheet: 'ppbf.css',
    fonts: 'legacy/legacy-fonts.css',
    sound: 'ppbf-sound.js',
    gallery: 'index.html',
    documentation: 'README.md',
  },

  // Everything resolves relative to design-system/. There are no absolute paths
  // and nothing is fetched from a CDN, so the folder is portable as long as the
  // directory structure is preserved.
  paths: {
    previewsReference: '../ppbf.css',
    stylesheetImports: './legacy/legacy-fonts.css',
    fontsReference: 'fonts/*.woff2',
    absolutePaths: 'none',
    externalRequests: 'none',
  },

  laws: [
    'Brass is the chassis, never the message.',
    'Saturated colour means safety or status. Nothing else may use it.',
    'Colour is never the only channel — glyph + uppercase label, always.',
    'Six voices, each with a job. Display is wood type, not stencil.',
    'Kiosk-first sizing — 55px targets, 19.1px type on the gym floor.',
    'Every screen is a room, and every panel in it is a real object.',
    'Refusal is a stamp, not an error toast.',
    'Proportion descends from φ. Nothing is sized by eye.',
  ],

  // In load order: each sheet after the sheets it imports.
  stylesheets,

  rooms: rooms.map((r) => ({ class: `room--${r}`, name: r })),

  type: {
    displayVoice: 'Alfa Slab One',
    faces,
    files: fontFiles,
    totalBytes: fontBytes,
    licence: 'SIL OFL 1.1 — all faces free and self-hosted, no CDN',
  },

  tokenCounts: {
    total: names.length,
    type: byPrefix('--t-'),
    // --s1 .. --s8 only. A bare '--s' prefix also counted --stamp-*, --split-*,
    // --slate-board and --shadow-*.
    space: names.filter((t) => /^--s\d+$/.test(t)).length,
    motionDurations: byPrefix('--m-'),
    motionEasings: byPrefix('--e-'),
    fonts: byPrefix('--font-'),
  },

  tokens,
  previews,

  counts: {
    previews: previews.length,
    foundations: previews.filter((p) => p.group === 'Foundations').length,
    components: previews.filter((p) => p.group === 'Components').length,
    screens: previews.filter((p) => p.group === 'Screens').length,
  },
};

writeFileSync(join(ROOT, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

const rel = relative(process.cwd(), join(ROOT, 'manifest.json'));
console.log(
  `wrote ${rel} — ${previews.length} previews, ${names.length} tokens from ${stylesheets.length} stylesheets, `
  + `${faces.length} faces (${(fontBytes / 1024).toFixed(1)} KiB)`,
);

if (missing.length) {
  console.error(
    `\nERROR: ${missing.length} preview(s) carry no @dsCard marker on line 1, so the Design\n`
    + `System pane would show no card for them:\n`
    + missing.map((m) => `  ${m}`).join('\n'),
  );
  process.exit(1);
}
