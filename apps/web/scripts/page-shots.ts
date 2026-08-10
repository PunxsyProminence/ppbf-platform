#!/usr/bin/env tsx
/* ───────────────────────────────────────────────────────────────────────────
   Page shots — photographs every surface in the building and lays the prints
   out on one contact sheet.

   WHY THIS EXISTS

   There are getting on for a hundred routes and no way to look at them.
   Judging a design change meant starting the dev server and clicking through
   every one by hand, once per viewport, remembering to switch roles on the
   way — so in practice nobody did it, and a change was judged on the two or
   three surfaces the author happened to have open. The design system's own
   previews do not close this gap: design-system/*.html are hand-authored
   mockups of the language, not photographs of the pages that shipped, and the
   two drift apart silently.

   Counts are deliberately absent from this header. The first version wrote
   "68 routes" in four places and main added twelve the same week.

   THIS IS NOT A PIXEL BASELINE, AND MUST NOT BECOME ONE.

   playwright.config.ts and the header of e2e/public-homepage.spec.ts record,
   at length, why screenshot assertions were removed: Chromium revisions shape
   glyphs differently, moving wrap points 23-38px per section, and a real
   regression is about the same size as that noise. No tolerance separates
   them.

   That argument is about ASSERTING pixels. It has nothing to say about
   capturing them for a person to look at, which is what this does — nothing
   here compares two images or fails on a difference, and nothing here belongs
   in CI. A human opens the sheet and sees every page at once. If someone later
   wants to diff these prints automatically, the container must pin the browser
   revision first; read those two files before trying.

   WHAT IT READS

   Routes come off the filesystem, so a new page appears on the sheet the day
   it lands. Everything else about a route — its label, its room, the roles
   that may see it — comes from components/buildingMap.ts, which the corridor
   and the card catalog already read. One registry, not two.

   A route the map does not name is captured anyway and flagged UNLISTED.
   That is a finding, not an error: the map is what the corridor advertises, so
   an unlisted surface is one nobody can navigate to. The run prints how many.

   USAGE

     npm run shots                          # every route, desktop + mobile
     npm run shots -- --routes /board,/help # just these
     npm run shots -- --desktop             # skip the mobile pass
     npm run shots -- --room board          # one room
     npm run shots -- --open                # print the sheet's file:// URL

   Starts a dev server if one is not already up, and stops the one it started.
   ─────────────────────────────────────────────────────────────────────────── */

import { spawn, execSync, type ChildProcess } from 'node:child_process';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium, devices, type Browser, type Page } from '@playwright/test';

import {
  OPEN,
  ROOM_LABEL,
  ROOM_ORDER,
  doorForPath,
  type Door,
  type Room,
} from '../components/buildingMap';
import type { ClubRole } from '../components/roleRoutes';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.resolve(HERE, '..');
const APP_DIR = path.join(WEB_ROOT, 'app');

const PORT = Number(process.env.SHOTS_PORT ?? 3100);
const BASE = process.env.SHOTS_BASE ?? `http://localhost:${PORT}`;
const OUT_DIR = process.env.SHOTS_OUT ?? path.join(WEB_ROOT, 'page-shots');

/* Same reasoning as playwright.config.ts: a container may ship a Chromium at a
   different revision than @playwright/test wants and be unable to fetch the
   matching one. Point PPBF_CHROMIUM_PATH at it. */
const localChromium = process.env.PPBF_CHROMIUM_PATH;

const argv = process.argv.slice(2);
const flag = (name: string): string | true | null => {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return null;
  const next = argv[i + 1];
  return !next || next.startsWith('--') ? true : next;
};
const str = (name: string): string | null => {
  const v = flag(name);
  return typeof v === 'string' ? v : null;
};

// ── viewports ──────────────────────────────────────────────────────────────

interface Viewport {
  id: 'desktop' | 'mobile';
  label: string;
  context: Parameters<Browser['newContext']>[0];
}

const VIEWPORTS: Viewport[] = [
  { id: 'desktop', label: 'Desktop · 1440', context: { viewport: { width: 1440, height: 900 } } },
  { id: 'mobile', label: 'Mobile · Pixel 7', context: { ...devices['Pixel 7'] } },
];

// ── roles ──────────────────────────────────────────────────────────────────

/** The role a route is photographed as. 'none' presents a signed-out visitor. */
type ShotRole = ClubRole | 'none';

/* Which role opens a door, when the door names several. The map lists roles as
   a set with no ranking, but a photograph has to pick one — so pick the role
   the surface was built for rather than whichever sorts first. A door not
   named here uses its first listed role, which is how the map already reads to
   a person scanning it. */
const PREFERRED_ROLE: readonly ClubRole[] = ['coach', 'athlete', 'parent', 'board', 'admin', 'staff'];

/* Routes the building map does not name, and what to open them as. Everything
   here is a threshold surface — sign-in, activation, the PIN change — which a
   signed-in session either redirects away from or renders in a state no real
   visitor sees. Photographing them signed-out is the honest picture.

   A route that is merely UNLISTED does not belong here; it gets its role
   inferred from its path like any other, and keeps the flag so the sheet still
   reports that the corridor cannot reach it. */
const SIGNED_OUT_ROUTES = new Set([
  '/',
  '/login',
  '/activate',
  '/launch',
  '/athlete/sign-in',
  '/change-pin',
]);

/* Last resort for an unlisted route with no door to inherit from: the first
   path segment usually names the role that surface serves. */
const ROLE_BY_PREFIX: ReadonlyArray<readonly [string, ClubRole]> = [
  ['/admin', 'admin'],
  ['/board', 'board'],
  ['/coach', 'coach'],
  ['/athlete', 'athlete'],
  ['/parent', 'parent'],
  ['/guardian', 'parent'],
  ['/workspace', 'staff'],
];

function resolveRole(route: string, door: Door | null): ShotRole {
  if (SIGNED_OUT_ROUTES.has(route)) return 'none';
  if (door && door.roles !== OPEN) {
    const named = door.roles as readonly ClubRole[];
    return PREFERRED_ROLE.find((r) => named.includes(r)) ?? named[0];
  }
  // An OPEN door renders for anyone, but several open surfaces still read the
  // session to decide what to show. Presenting the path's own role gets the
  // populated view rather than the empty one.
  const prefixed = ROLE_BY_PREFIX.find(([prefix]) => route === prefix || route.startsWith(`${prefix}/`));
  return prefixed ? prefixed[1] : 'none';
}

/* The session payload the app's own client would have received. Shaped against
   app/api/pilot/auth/session/route.ts and validated by
   resolveAuthoritativeRoleSession in components/roleSession.ts, which refuses
   anything less: a non-athlete role without auth_provider 'microsoft' resolves
   to privileged_auth_required and the gate bounces to /login, which would put
   a picture of the login page under 40 different route names. */
function sessionPayload(role: Exclude<ShotRole, 'none'>, route: string) {
  const seat = role === 'board' ? seatForRoute(route) : null;
  return {
    authenticated: true,
    account_id: 'page-shots-account',
    role,
    organization_id: 'page-shots-organization',
    athlete_id: role === 'athlete' ? 'page-shots-athlete' : null,
    auth_provider: 'microsoft',
    must_change_pin: false,
    // A seat is display identity layered on the 'board' role, never a role of
    // its own. Presenting the seat the route is about is what makes
    // /board/treasurer photograph as the treasurer's workspace instead of
    // redirecting to the aggregate hub.
    ...(seat ? { board_seat: seat, board_seats: [{ seat }] } : {}),
  };
}

const BOARD_SEATS = new Set([
  'president', 'chair', 'vice-chair', 'treasurer',
  'secretary', 'safety-director', 'community-director', 'at-large',
]);

function seatForRoute(route: string): string | null {
  const slug = route.startsWith('/board/') ? route.slice('/board/'.length) : '';
  return BOARD_SEATS.has(slug) ? slug : null;
}

// ── route discovery ────────────────────────────────────────────────────────

/**
 * Every route the app serves, read off the filesystem so new pages self-enrol.
 *
 * `skipped` collects the dynamic routes this cannot photograph. They are
 * reported rather than dropped in silence: a sheet that quietly omits a
 * surface reads as complete coverage when it is not.
 */
async function discoverRoutes(dir: string, skipped: string[], prefix = ''): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const routes: string[] = [];

  if (entries.some((e) => e.isFile() && e.name === 'page.tsx')) {
    routes.push(prefix === '' ? '/' : prefix);
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const { name } = entry;
    // api/ serves no page, and _-prefixed folders are private by convention.
    if (name === 'api' || name.startsWith('_') || name.startsWith('.')) continue;

    // A dynamic segment needs a real parameter to render, and inventing one
    // photographs a 404 or somebody else's organization. Giving these real
    // coverage means seeding an id per segment, which is a fixtures question
    // rather than a screenshot one -- so they are named in the output and left
    // for whoever wants to answer it.
    if (name.startsWith('[')) {
      skipped.push(`${prefix}/${name}`);
      continue;
    }

    // Route groups are organisational and contribute nothing to the URL.
    const segment = name.startsWith('(') && name.endsWith(')') ? '' : `/${name}`;
    routes.push(...await discoverRoutes(path.join(dir, name), skipped, prefix + segment));
  }

  return routes;
}

// ── dev server ─────────────────────────────────────────────────────────────

async function isUp(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
    return res.status < 500;
  } catch {
    return false;
  }
}

async function startServer(): Promise<ChildProcess | null> {
  if (await isUp(BASE)) {
    console.log(`Using the dev server already on ${BASE}.`);
    return null;
  }

  console.log(`Starting a dev server on port ${PORT} (nothing was listening)...`);
  const child = spawn('npm', ['run', 'dev', '--', '--port', String(PORT)], {
    cwd: WEB_ROOT,
    stdio: 'ignore',
    // Detached so the whole process group can be signalled: `next dev` forks a
    // worker, and killing only the npm wrapper leaves the port held.
    detached: true,
  });

  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('The dev server exited before it began serving.');
    if (await isUp(BASE)) {
      console.log('Dev server ready.');
      // Unreferenced so a thrown error can still end this process. Without it
      // node keeps the loop alive for the child's sake and the script hangs
      // instead of reporting what went wrong. It is still killed explicitly.
      child.unref();
      return child;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }

  stopServer(child);
  throw new Error(`The dev server did not come up on ${BASE} within 120s.`);
}

function stopServer(child: ChildProcess | null) {
  if (!child?.pid) return;
  try {
    if (process.platform === 'win32') {
      // Windows doesn't support negative PIDs. Use taskkill to terminate the process tree.
      execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' });
    } else {
      // POSIX: negative PID targets the process group (npm wrapper + Next.js workers).
      process.kill(-child.pid, 'SIGTERM');
    }
  } catch {
    // Already gone. Nothing to clean up.
  }
}

// ── capture ────────────────────────────────────────────────────────────────

interface Shot {
  route: string;
  label: string;
  room: Room;
  /** The route has no door of its own — the corridor cannot reach it. */
  unlisted: boolean;
  role: ShotRole;
  viewport: Viewport['id'];
  file: string | null;
  /** Where the page ended up, when a guard sent it somewhere else. */
  landedOn: string | null;
  /** Content wider than the viewport — a horizontal scrollbar on a real screen. */
  overflow: boolean;
  heightPx: number | null;
  error: string | null;
}

const slugFor = (route: string) => (route === '/' ? 'index' : route.slice(1).replace(/\//g, '__'));

async function capture(
  page: Page,
  route: string,
  door: Door | null,
  role: ShotRole,
  viewport: Viewport,
): Promise<Shot> {
  const shot: Shot = {
    route,
    label: door?.label ?? route,
    room: door?.room ?? 'office',
    unlisted: !door,
    role,
    viewport: viewport.id,
    file: null,
    landedOn: null,
    overflow: false,
    heightPx: null,
    error: null,
  };

  try {
    await page.goto(BASE + route, { waitUntil: 'networkidle', timeout: 45_000 });
  } catch (error) {
    // Photograph whatever rendered. A route whose API hangs still has a
    // design worth looking at, and reporting nothing would hide it.
    // Still, track the failure so the sheet signals a problem.
    shot.error = error instanceof Error ? error.message : String(error);
  }

  // Client gates resolve the session in an effect, then swap the page. Without
  // this the sheet is 68 pictures of a loading skeleton.
  await page.waitForTimeout(1200);

  try {
    const landed = new URL(page.url()).pathname;
    if (landed !== route) shot.landedOn = landed;

    const metrics = await page.evaluate(() => ({
      overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      height: document.documentElement.scrollHeight,
    }));
    shot.overflow = metrics.overflow;
    shot.heightPx = metrics.height;

    const file = path.join(viewport.id, `${slugFor(route)}.png`);
    await page.screenshot({ path: path.join(OUT_DIR, file), fullPage: true });
    shot.file = file;
  } catch (error) {
    shot.error = error instanceof Error ? error.message : String(error);
  }

  return shot;
}

// ── the contact sheet ──────────────────────────────────────────────────────

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function renderGallery(shots: Shot[], capturedAt: string): string {
  /* The sheet renders against the real ppbf.css rather than a copy of its
     values, for the same reason every preview in design-system/ does: a second
     set of numbers is a second thing to drift. Resolved from OUT_DIR because
     SHOTS_OUT (via OUT_DIR) can be relocated within WEB_ROOT, and a hardcoded
     ../../.. renders it unstyled from any other directory. OUT_DIR must be a
     subdirectory of WEB_ROOT for safety (prevents accidental deletion of broader
     directories if SHOTS_OUT is misconfigured). */
  const stylesheet = path
    .relative(OUT_DIR, path.resolve(WEB_ROOT, '../../design-system/ppbf.css'))
    .split(path.sep)
    .join('/');

  const byRoom = ROOM_ORDER
    .map((room) => ({ room, shots: shots.filter((s) => s.room === room) }))
    .filter((g) => g.shots.length > 0);

  const viewports = [...new Set(shots.map((s) => s.viewport))];
  const flagged = shots.filter((s) => s.landedOn || s.overflow || s.error);

  const card = (s: Shot) => {
    const flags = [
      s.error ? '<b class="flag flag--bad">ERROR</b>' : '',
      s.landedOn ? `<b class="flag flag--bad">→ ${escapeHtml(s.landedOn)}</b>` : '',
      s.overflow ? '<b class="flag flag--warn">OVERFLOW</b>' : '',
      s.unlisted ? '<b class="flag flag--note">UNLISTED</b>' : '',
    ].filter(Boolean).join('');

    const plate = s.file
      ? `<a class="plate" href="${escapeHtml(s.file)}" target="_blank" rel="noreferrer">
           <img loading="lazy" src="${escapeHtml(s.file)}" alt="${escapeHtml(s.label)}">
         </a>`
      : `<div class="plate plate--empty">no print<span>${escapeHtml(s.error ?? 'not captured')}</span></div>`;

    return `<figure class="shot" data-room="${s.room}" data-viewport="${s.viewport}"
        data-flagged="${s.landedOn || s.overflow || s.error ? 'yes' : 'no'}">
      ${plate}
      <figcaption>
        <h3>${escapeHtml(s.label)}</h3>
        <code>${escapeHtml(s.route)}</code>
        <p class="meta">
          <span class="role">${escapeHtml(s.role === 'none' ? 'signed out' : s.role)}</span>
          <span class="vp">${escapeHtml(s.viewport)}</span>
          ${s.heightPx ? `<span class="h">${s.heightPx}px tall</span>` : ''}
        </p>
        ${flags ? `<p class="flags">${flags}</p>` : ''}
      </figcaption>
    </figure>`;
  };

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>PPBF — Page Shots</title>
<link rel="stylesheet" href="${escapeHtml(stylesheet)}">
<style>
  body { margin: 0; background: var(--hide-950); }
  .sheet { max-width: 1560px; margin: 0 auto; padding: var(--s6); }
  h1 { font-family: var(--font-stencil); text-transform: uppercase; font-size: var(--t-2xl);
       letter-spacing: .05em; color: var(--bone-100); margin: 0 0 var(--s3);
       text-shadow: 0 2px 0 rgba(0,0,0,.6), 0 0 22px rgba(232,206,122,.14); }
  .lede { font-size: var(--t-sm); line-height: 1.62; color: var(--bone-300); max-width: 68ch; margin: 0 0 var(--s5); }
  .lede b { color: var(--brass-300); }
  h2 { font-family: var(--font-stencil); text-transform: uppercase; font-size: var(--t-md);
       letter-spacing: .08em; color: var(--brass-300); margin: var(--s7) 0 var(--s5);
       padding-bottom: var(--s3); border-bottom: 1px solid rgba(212,175,74,.28); }
  h2 span { color: var(--bone-400); font-size: var(--t-xs); letter-spacing: .04em; margin-left: var(--s3); }

  .controls { display: flex; flex-wrap: wrap; gap: var(--s3); align-items: center;
              padding: var(--s4) var(--s5); margin-bottom: var(--s5);
              border-radius: var(--r-lg); background: linear-gradient(135deg, var(--hide-800), var(--hide-900));
              border: 1px solid rgba(212,175,74,.18); box-shadow: 0 4px 12px rgba(0,0,0,.4);
              position: sticky; top: 0; z-index: 5; }
  .controls > label { font: 650 10.5px/1 var(--font-data); letter-spacing: .12em;
                      text-transform: uppercase; color: var(--bone-400); margin-right: var(--s2); }
  .controls button { min-height: 34px; padding: 0 var(--s4); cursor: pointer;
                     border-radius: var(--r-sm); border: 1px solid rgba(212,175,74,.3);
                     background: rgba(0,0,0,.25); color: var(--bone-200);
                     font: 650 var(--t-xs)/1 var(--font-stencil); letter-spacing: .06em;
                     text-transform: uppercase; }
  .controls button[aria-pressed="true"] { color: var(--hide-950);
    background: linear-gradient(180deg, var(--brass-200), var(--brass-500) 55%, var(--brass-800)); }
  .controls .spacer { flex: 1; }
  .controls input[type="search"] { min-height: 34px; min-width: 200px; padding: 0 var(--s3);
    border-radius: var(--r-sm); border: 1px solid rgba(212,175,74,.3);
    background: rgba(0,0,0,.3); color: var(--bone-100); font: var(--t-sm) var(--font-data); }

  .grid { display: grid; gap: var(--s5); grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); }
  .shot { margin: 0; border-radius: var(--r-lg); overflow: hidden;
          background: linear-gradient(135deg, var(--hide-800), var(--hide-900));
          border: 1px solid rgba(212,175,74,.18); box-shadow: 0 4px 12px rgba(0,0,0,.4); }
  .shot[hidden] { display: none; }
  /* A fixed window onto a full-page print: every card is the same size, and the
     top of the page — the part that decides how a surface reads — is what
     shows. Click through for the whole thing. */
  .plate { display: block; height: 208px; overflow: hidden; background: var(--hide-950);
           border-bottom: 1px solid rgba(212,175,74,.18); }
  .plate img { display: block; width: 100%; height: auto; }
  .plate--empty { display: flex; flex-direction: column; align-items: center; justify-content: center;
                  gap: var(--s2); color: var(--bone-400);
                  font: 650 var(--t-xs) var(--font-stencil); letter-spacing: .08em; text-transform: uppercase; }
  .plate--empty span { font: 11px var(--font-data); text-transform: none; letter-spacing: 0;
                       opacity: .7; max-width: 80%; text-align: center; }
  figcaption { padding: var(--s4) var(--s4) var(--s5); }
  figcaption h3 { margin: 0 0 var(--s2); font-family: var(--font-stencil); font-size: var(--t-sm);
                  color: var(--bone-100); letter-spacing: .03em; }
  figcaption code { font: 12px var(--font-data); color: var(--brass-300); overflow-wrap: anywhere; }
  .meta { margin: var(--s3) 0 0; display: flex; flex-wrap: wrap; gap: var(--s2); }
  .meta span { font: 650 10px/1 var(--font-data); letter-spacing: .1em; text-transform: uppercase;
               color: var(--bone-400); border: 1px solid rgba(212,175,74,.2);
               border-radius: var(--r-sm); padding: 4px 7px; }
  .flags { margin: var(--s3) 0 0; display: flex; flex-wrap: wrap; gap: var(--s2); }
  .flag { font: 650 10px/1 var(--font-data); letter-spacing: .1em; text-transform: uppercase;
          border-radius: var(--r-sm); padding: 4px 7px; }
  /* Law 2: saturated colour is the safety ladder and nothing else. These are
     the ladder's own rungs used for their own meaning — a broken surface, a
     surface to watch — not decoration borrowed for a category. Law 3: each
     carries its word, so the sheet still reads in greyscale. */
  .flag--bad  { background: rgba(178,58,44,.22); color: var(--locked); border: 1px solid rgba(178,58,44,.5); }
  .flag--warn { background: rgba(199,142,42,.18); color: var(--monitor); border: 1px solid rgba(199,142,42,.45); }
  .flag--note { background: rgba(0,0,0,.3); color: var(--bone-400); border: 1px solid rgba(212,175,74,.2); }
  .empty { color: var(--bone-400); font: var(--t-sm) var(--font-data); padding: var(--s6) 0; }
</style>
</head>
<body class="ppbf">
<div class="sheet">
  <h1>Page Shots</h1>
  <p class="lede">
    Every surface in the building, photographed at ${escapeHtml(capturedAt)}.
    <b>${shots.length}</b> print${shots.length === 1 ? '' : 's'} across
    <b>${new Set(shots.map((s) => s.route)).size}</b> route${new Set(shots.map((s) => s.route)).size === 1 ? '' : 's'},
    grouped by room and captured as the role that opens each door.
    <b>${flagged.length}</b> need${flagged.length === 1 ? 's' : ''} a look.
    These are prints for a person to judge, not a baseline — nothing compares them.
    Click any plate for the full-length page.
  </p>

  <div class="controls">
    <label>Viewport</label>
    ${viewports.map((v, i) => `<button data-viewport="${v}" aria-pressed="${i === 0}">${v}</button>`).join('')}
    <label style="margin-left:var(--s4)">Show</label>
    <button data-filter="all" aria-pressed="true">All</button>
    <button data-filter="flagged" aria-pressed="false">Needs a look</button>
    <span class="spacer"></span>
    <input type="search" id="q" placeholder="Filter by name or path" aria-label="Filter surfaces">
  </div>

  ${byRoom.map(({ room, shots: group }) => `
  <section data-room-section="${room}">
    <h2>${escapeHtml(ROOM_LABEL[room])}<span>${new Set(group.map((s) => s.route)).size} surfaces</span></h2>
    <div class="grid">${group.map(card).join('')}</div>
  </section>`).join('')}

  <p class="empty" id="nothing" hidden>Nothing matches that filter.</p>
</div>

<script>
  const state = { viewport: ${JSON.stringify(viewports[0] ?? 'desktop')}, filter: 'all', q: '' };
  const shots = [...document.querySelectorAll('.shot')];

  function apply() {
    const q = state.q.trim().toLowerCase();
    let shown = 0;
    for (const el of shots) {
      const text = el.querySelector('figcaption').textContent.toLowerCase();
      const ok = el.dataset.viewport === state.viewport
        && (state.filter === 'all' || el.dataset.flagged === 'yes')
        && (!q || text.includes(q));
      el.hidden = !ok;
      if (ok) shown++;
    }
    // A room with nothing left in it should not leave a heading behind.
    for (const section of document.querySelectorAll('[data-room-section]')) {
      section.hidden = !section.querySelector('.shot:not([hidden])');
    }
    document.getElementById('nothing').hidden = shown > 0;
  }

  // Scoped to .controls on purpose: every .shot also carries data-viewport, so
  // a bare [data-viewport] selector picks up all 136 figures and turns each
  // card into a toggle.
  function wireToggles(key, onPick) {
    const buttons = [...document.querySelectorAll('.controls button[data-' + key + ']')];
    for (const btn of buttons) {
      btn.addEventListener('click', () => {
        onPick(btn.dataset[key]);
        for (const b of buttons) b.setAttribute('aria-pressed', String(b === btn));
        apply();
      });
    }
  }

  wireToggles('viewport', (v) => { state.viewport = v; });
  wireToggles('filter', (f) => { state.filter = f; });

  document.getElementById('q').addEventListener('input', (e) => {
    state.q = e.target.value;
    apply();
  });

  apply();
</script>
</body>
</html>`;
}

// ── run ────────────────────────────────────────────────────────────────────

async function main() {
  const only = str('routes')?.split(',').map((r) => r.trim()).filter(Boolean) ?? null;
  const room = str('room');
  const viewports = VIEWPORTS.filter((v) => {
    if (flag('desktop')) return v.id === 'desktop';
    if (flag('mobile')) return v.id === 'mobile';
    return true;
  });

  const dynamic: string[] = [];
  let routes = (await discoverRoutes(APP_DIR, dynamic)).sort();
  if (only) routes = routes.filter((r) => only.includes(r));
  if (room) routes = routes.filter((r) => (doorForPath(r)?.room ?? 'office') === room);

  if (routes.length === 0) {
    console.error('No routes matched. Check --routes / --room.');
    process.exitCode = 1;
    return;
  }

  const unlisted = routes.filter((r) => !doorForPath(r));
  console.log(`${routes.length} route(s) × ${viewports.length} viewport(s) = ${routes.length * viewports.length} print(s).`);
  if (unlisted.length) {
    console.log(`${unlisted.length} not in the building map, so the corridor cannot reach them: ${unlisted.join(', ')}`);
  }
  if (dynamic.length) {
    console.log(`${dynamic.length} dynamic route(s) not photographed, each needs a real id: ${dynamic.sort().join(', ')}`);
  }

  // A stale print of a route that no longer exists is worse than no print --
  // it reads as current. Start the sheet from empty every run.
  // Sanity check: ensure OUT_DIR is actually inside the web root to prevent
  // accidental deletion of broader directories if SHOTS_OUT is misconfigured.
  const resolvedOut = path.resolve(OUT_DIR);
  const resolvedWeb = path.resolve(WEB_ROOT);
  const relative = path.relative(resolvedWeb, resolvedOut);
  if (relative.startsWith('..') || path.isAbsolute(relative) || relative === '') {
    throw new Error(`SHOTS_OUT must be a subdirectory of WEB_ROOT (${resolvedWeb}), got ${resolvedOut}`);
  }
  await rm(OUT_DIR, { recursive: true, force: true });
  for (const v of viewports) await mkdir(path.join(OUT_DIR, v.id), { recursive: true });

  const server = await startServer();
  // An interrupted run must not leave the dev server it started holding the
  // port, or the next run finds something already listening and photographs a
  // stale build without saying so.
  const onSignal = () => { stopServer(server); process.exit(130); };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  const shots: Shot[] = [];
  // Launched inside the try: a Chromium that will not start is the most likely
  // failure here, and throwing outside it left the dev server this script had
  // just spawned running with nothing to stop it.
  let browser: Browser | null = null;

  try {
    browser = await chromium.launch(localChromium ? { executablePath: localChromium } : {});

    for (const viewport of viewports) {
      for (const route of routes) {
        const door = doorForPath(route);
        const role = resolveRole(route, door);

        const context = await browser.newContext(viewport.context);
        if (role !== 'none') {
          await context.route('**/api/pilot/auth/session', (r) => r.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify(sessionPayload(role, route)),
          }));
        }

        const page = await context.newPage();
        const shot = await capture(page, route, door, role, viewport);
        shots.push(shot);
        await context.close();

        const mark = shot.error ? 'ERR ' : shot.landedOn ? '→   ' : shot.overflow ? 'OVF ' : 'ok  ';
        console.log(`${mark}[${viewport.id}] ${route}${shot.landedOn ? ` landed on ${shot.landedOn}` : ''}`);
      }
    }
  } finally {
    await browser?.close();
    stopServer(server);
  }

  const capturedAt = new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  await writeFile(path.join(OUT_DIR, 'gallery.html'), renderGallery(shots, capturedAt), 'utf8');
  await writeFile(
    path.join(OUT_DIR, 'shots.json'),
    JSON.stringify({ capturedAt, base: BASE, shots }, null, 2),
    'utf8',
  );

  const sheet = path.join(OUT_DIR, 'gallery.html');
  const redirected = shots.filter((s) => s.landedOn).length;
  const overflowing = shots.filter((s) => s.overflow).length;
  const failed = shots.filter((s) => s.error).length;

  console.log(`\n${shots.length} print(s) — ${redirected} redirected, ${overflowing} overflowing, ${failed} failed.`);
  console.log(`Contact sheet: ${sheet}`);
  if (flag('open')) console.log(`file://${sheet}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
