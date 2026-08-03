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
import { join, dirname, relative } from 'node:path';
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

/* ---- tokens: pull the custom properties straight out of the stylesheet --- */
const css = readFileSync(join(ROOT, 'ppbf.css'), 'utf8');
const rootBlock = css.slice(css.indexOf(':root {'), css.indexOf('\n}', css.indexOf(':root {')));
const tokens = {};
for (const m of rootBlock.matchAll(/^\s*(--[\w-]+):\s*([^;]+);/gm)) {
  const name = m[1];
  // The generated feTurbulence data URIs are enormous and carry no meaning as
  // text; record that they exist rather than inlining kilobytes of base64.
  const value = m[2].trim();
  tokens[name] = value.startsWith('url("data:image/svg+xml')
    ? '<generated SVG data URI>'
    : value.replace(/\s+/g, ' ');
}

const byPrefix = (p) => Object.keys(tokens).filter((t) => t.startsWith(p)).length;

/* ---- rooms: the six grounds, read from the stylesheet -------------------- */
const rooms = [...css.matchAll(/^\.room--(\w+)\s*\{/gm)].map((m) => m[1])
  .filter((v, i, a) => a.indexOf(v) === i);

/* ---- fonts --------------------------------------------------------------- */
const fontsCss = readFileSync(join(ROOT, 'fonts.css'), 'utf8');
const faces = [...fontsCss.matchAll(/font-family:\s*'([^']+)'/g)].map((m) => m[1]);
const fontFiles = readdirSync(join(ROOT, 'fonts')).filter((f) => f.endsWith('.woff2')).sort();
const fontBytes = fontFiles.reduce((n, f) => n + statSync(join(ROOT, 'fonts', f)).size, 0);

/* ---- assemble ------------------------------------------------------------ */
const manifest = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  name: 'PPBF Design System — Leather & Brass',
  description:
    'A skeuomorphic design system for the Punxsutawney Prominence Boxing Foundation platform. '
    + 'The platform is a building; every screen is a room, and every panel in it is a real object. '
    + 'Zero external assets: all texture is generated from SVG feTurbulence data URIs and layered '
    + 'gradients, so a floor kiosk renders with no network.',
  license: 'MIT',
  generatedBy: 'design-system/build-manifest.mjs',

  entryPoints: {
    stylesheet: 'ppbf.css',
    fonts: 'fonts.css',
    sound: 'ppbf-sound.js',
    gallery: 'index.html',
    documentation: 'README.md',
  },

  // Everything resolves relative to design-system/. There are no absolute paths
  // and nothing is fetched from a CDN, so the folder is portable as long as the
  // directory structure is preserved.
  paths: {
    previewsReference: '../ppbf.css',
    stylesheetImports: './fonts.css',
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

  rooms: rooms.map((r) => ({ class: `room--${r}`, name: r })),

  type: {
    displayVoice: 'Alfa Slab One',
    faces,
    files: fontFiles,
    totalBytes: fontBytes,
    licence: 'SIL OFL 1.1 — all faces free and self-hosted, no CDN',
  },

  tokenCounts: {
    total: Object.keys(tokens).length,
    type: byPrefix('--t-'),
    space: byPrefix('--s'),
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
  `wrote ${rel} — ${previews.length} previews, ${Object.keys(tokens).length} tokens, `
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
