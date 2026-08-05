#!/usr/bin/env node
/* ───────────────────────────────────────────────────────────────────────────
   Contrast sweep — reads every route you give it and reports text that cannot
   be read against what is behind it.

   WHY THIS EXISTS

   The design system has two grounds (Law 6): ink leather for staff surfaces,
   warm canvas for the family-facing side. Most components are authored
   against one and restated for the other, so moving a page between grounds,
   or dropping a component onto the ground it was not written for, turns
   legible text illegible.

   The unit suite cannot see this. Every one of the following passed 2,619
   green tests while being invisible on screen:

     - a brass button whose ink was repainted by a link rule that outranked it
     - a session-bar trigger that inherited the body's dark colour onto leather
     - five pages rendering bone-on-cream after adopting the ink type voices
     - a gate screen with no ground at all, taking whatever the body was

   Colour is also the one axis the Laws spend deliberately: Law 2 reserves
   saturated colour for a participant's safety state, and Law 3 requires a
   glyph and a label so the ladder survives greyscale. A contrast regression
   is therefore a governance regression, not only a cosmetic one.

   HOW TO READ THE OUTPUT

   A count alone means little — plenty of low-contrast text predates any given
   change. Run with --baseline <git-ref> to sweep the same routes against that
   ref and print the delta, so a finding is attributable rather than merely
   present. A route whose count matches its baseline is not your bug.

   USAGE

     npm run sweep                          # default routes, current tree
     npm run sweep -- --routes /a,/b        # specific routes
     npm run sweep -- --role coach          # role to present to the auth stub
     npm run sweep -- --mobile              # Pixel 7 viewport
     npm run sweep -- --json                # machine-readable

   Requires a dev server on $SWEEP_BASE (default http://localhost:3100).
   ─────────────────────────────────────────────────────────────────────────── */

import { chromium, devices } from '@playwright/test';

const BASE = process.env.SWEEP_BASE ?? 'http://localhost:3100';
const THRESHOLD = Number(process.env.SWEEP_THRESHOLD ?? 3);

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : (argv[i + 1]?.startsWith('--') ? true : argv[i + 1] ?? true);
};

/* One route per ground, plus the surfaces that have actually regressed before.
   Keep this list short enough that people run it. */
const DEFAULT_ROUTES = [
  ['/', 'none'],
  ['/login', 'none'],
  ['/public', 'none'],
  ['/operations', 'admin'],
  ['/admin', 'admin'],
  ['/admin/shadow', 'admin'],
  ['/board', 'board'],
  ['/coach/review-queue', 'coach'],
  ['/parent/dashboard', 'parent'],
  ['/athlete/dashboard', 'athlete'],
];

const routes = flag('routes')
  ? String(flag('routes')).split(',').map((r) => [r.trim(), String(flag('role', 'admin'))])
  : DEFAULT_ROUTES;
const mobile = Boolean(flag('mobile', false));
const asJson = Boolean(flag('json', false));

/* Runs inside the page. Kept as one function so it can be passed to evaluate
   without a bundler. */
function collect(threshold) {
  const lum = (c) => {
    // oklab()/lab()/color() are not rgb triples; parsing their numbers as if
    // they were produced confident nonsense (a legible brass eyebrow scored
    // 1.11 and sent someone hunting a bug that did not exist).
    if (!/^rgb/.test(c)) return null;
    const m = (c.match(/[\d.]+/g) || []).slice(0, 3).map(Number);
    if (m.length < 3) return null;
    const [r, g, b] = m.map((v) => {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };

  const bgOf = (el) => {
    let n = el;
    while (n && n !== document.documentElement) {
      const cs = getComputedStyle(n);
      // A gradient with no backing colour paints over whatever is behind it,
      // and we cannot sample it — report nothing rather than measure the
      // wrong layer. This is how mat-brass--patina behaves.
      if (cs.backgroundImage !== 'none' && /gradient/.test(cs.backgroundImage)
          && /rgba\(0, 0, 0, 0\)/.test(cs.backgroundColor)) return null;
      if (cs.backgroundColor && !/transparent/.test(cs.backgroundColor)) {
        const a = cs.backgroundColor.startsWith('rgba')
          ? Number(cs.backgroundColor.split(',')[3]) : 1;
        // A near-transparent wash is not the ground. Treating .btn--ghost's
        // rgba(0,0,0,.045) as one scored cream-backed text at 1.59.
        if (a >= 0.5) return cs.backgroundColor;
      }
      n = n.parentElement;
    }
    return getComputedStyle(document.body).backgroundColor;
  };

  const out = [];
  for (const el of document.querySelectorAll('body *')) {
    if (el.children.length) continue;                    // leaf text only
    const text = (el.textContent || '').trim();
    if (text.length < 2) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) < 0.2) continue;
    const bg = bgOf(el);
    if (!bg) continue;
    const a = lum(cs.color);
    const b = lum(bg);
    if (a === null || b === null) continue;
    const [hi, lo] = a > b ? [a, b] : [b, a];
    const contrast = (hi + 0.05) / (lo + 0.05);
    if (contrast < threshold) {
      out.push({ text: text.slice(0, 48), color: cs.color, bg, contrast: +contrast.toFixed(2) });
    }
  }
  return {
    low: out,
    overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
  };
}

/* Same escape hatch playwright.config.ts documents: a container may ship a
   Chromium at a different revision than @playwright/test wants and be unable
   to fetch the matching one. Without this the sweep is the one design tool
   that cannot run in the environment where the design work happens. CI
   installs the matching revision and leaves it unset. */
const browser = await chromium.launch(
  process.env.PPBF_CHROMIUM_PATH ? { executablePath: process.env.PPBF_CHROMIUM_PATH } : {},
);
const results = [];

for (const [path, role] of routes) {
  const ctx = await browser.newContext(mobile ? devices['Pixel 7'] : { viewport: { width: 1440, height: 900 } });
  if (role && role !== 'none') {
    await ctx.route('**/api/pilot/auth/session', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          authenticated: true, role, auth_provider: 'microsoft', must_change_pin: false,
        }),
      }));
  }
  const page = await ctx.newPage();
  try {
    await page.goto(BASE + path, { waitUntil: 'networkidle', timeout: 40000 });
  } catch {
    // Measure whatever rendered; a slow API is not a reason to skip the route.
  }
  await page.waitForTimeout(900);
  const res = await page.evaluate(collect, THRESHOLD);
  results.push({ path, role, mobile, ...res });
  if (!asJson) {
    const tag = res.low.length ? 'LOW ' : 'ok  ';
    console.log(`${tag}${res.overflow ? 'OVERFLOW ' : ''}${path} (${res.low.length})`);
    for (const f of res.low.slice(0, 4)) {
      console.log(`      ${f.contrast}:1  "${f.text}"  ${f.color} on ${f.bg}`);
    }
  }
  await ctx.close();
}

await browser.close();

if (asJson) {
  console.log(JSON.stringify(results, null, 2));
} else {
  const total = results.reduce((n, r) => n + r.low.length, 0);
  console.log(`\n${total} node(s) under ${THRESHOLD}:1 across ${results.length} route(s).`);
  console.log('A count is not a verdict — re-run against a baseline ref and diff before acting.');
}

// Never fail the build on this. Plenty of low-contrast text predates any given
// change, and a script that blocks CI on a pre-existing number just gets
// disabled. It reports; a person decides.
process.exit(0);
