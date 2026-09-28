import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import nextConfig from '../next.config';
import { CAMERA_DOCUMENT_ROUTES, isCameraDocument, requiresDocumentLoad } from './cameraDocuments';

/*
 * A RECORDER MUST BE ARRIVED AT WITH A FULL PAGE LOAD.
 *
 * Permissions-Policy is delivered with a DOCUMENT. next.config.ts serves
 * camera=(self) on exactly two paths, and the whole two-document arrangement
 * rests on that. But `<Link>` does not fetch a document -- the App Router
 * patches the current one -- so a coach who reaches a recorder by clicking a
 * link is still inside the page they started on, which was served camera=().
 * getUserMedia is then refused, and the recorder tells the coach to check
 * their browser permissions for a refusal the app sent itself.
 *
 * WHY THIS NEEDS A TEST AND NOT A COMMENT. `<Link>` is the correct choice for
 * every other href in this application and the obvious thing to reach for. The
 * failure is invisible in review, invisible in a unit test of either page, and
 * produces no error anywhere -- just a camera that never opens, on the one
 * screen whose entire purpose is to open one. It is also how the first version
 * of this recorder shipped: the capture route was linked from the Film Study
 * home with `<Link>` from the day it was written, which is why no camera was
 * ever observed opening.
 */

const WEB = path.resolve(__dirname, '..');
const SCANNED = [path.join(WEB, 'app'), path.join(WEB, 'components')];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.tsx?$/.test(full) && !/\.test\.tsx?$/.test(full)) out.push(full);
  }
  return out;
}

const SOURCES = SCANNED.flatMap(walk);

function relative(file: string): string {
  return path.relative(WEB, file).split(path.sep).join('/');
}

test('the scan reads the application, so its silence means something', () => {
  // A walk that found nothing would make every assertion below pass while
  // examining no code at all.
  expect(SOURCES.length).toBeGreaterThan(100);
  expect(SOURCES.some((file) => relative(file) === 'app/teach-shadow/capture/page.tsx')).toBe(true);
});

test('the routes granted a camera are exactly the ones navigation treats as documents', async () => {
  /*
   * The two lists are maintained in different files for different reasons --
   * one configures a header, one decides how a link behaves -- and neither is
   * derived from the other, so they can drift. Adding a third capture route to
   * next.config.ts without adding it here would grant the camera to a page
   * that can only ever be reached by a soft navigation, which is the same as
   * not granting it.
   */
  const rules = await nextConfig.headers!();
  const granted = rules
    .filter((rule) => rule.headers.some((h) => h.key === 'Permissions-Policy' && h.value.includes('camera=(self)')))
    .map((rule) => rule.source)
    .sort();

  expect(granted).toEqual([...CAMERA_DOCUMENT_ROUTES].sort());
});

test('nothing reaches a recorder through a client-side navigation', () => {
  const offenders: string[] = [];

  for (const file of SOURCES) {
    const source = readFileSync(file, 'utf8');
    // <Link ...> up to its closing angle bracket, however many props deep.
    for (const match of source.matchAll(/<Link\b[^>]*>/g)) {
      const href = /href=["']([^"']+)["']/.exec(match[0]);
      if (href && isCameraDocument(href[1]!)) {
        offenders.push(`${relative(file)} links to ${href[1]} with <Link>`);
      }
    }
  }

  // Whoever trips this: use a plain <a>. The camera grant travels with the
  // document, and <Link> does not fetch one.
  expect(offenders).toEqual([]);
});

test('every surface that renders a list of doors decides per door', () => {
  /*
   * THE HOLE THE LITERAL SCAN LEAVES, closed by naming the surfaces instead.
   *
   * The scan above reads `href="..."`, so `<Link href={door.href}>` is
   * invisible to it -- and a list built from the building map can reach BOTH
   * camera documents. That is how the door register kept a soft navigation
   * into the recorders after the corridor and the card catalog were fixed:
   * three surfaces navigate by a variable and the test knew about two.
   *
   * A general scan for ANY variable href was tried first and is not here. It
   * would flag thirteen call sites across the application that render lists of
   * their own links -- operations, the workspace, the breadcrumbs -- none of
   * which can reach a camera document, and converting them all to buy this one
   * guard is a worse trade than naming the three surfaces that read the
   * building map. This does not generalise to a fourth door list, which is a
   * real limit and the reason the door register had to be found by review
   * rather than by CI.
   */
  const doorLists = [
    ['components/Corridor.tsx', 'ChromeLink'],
    ['components/CardCatalog.tsx', 'requiresDocumentLoad'],
    ['app/admin/door-register/page.tsx', 'ChromeLink'],
  ] as const;

  for (const [file, expected] of doorLists) {
    const source = readFileSync(path.join(WEB, ...file.split('/')), 'utf8');
    expect({ file, consults: source.includes(expected) }).toEqual({ file, consults: true });
    // And none of them may still hand a door straight to next/link.
    expect({ file, bare: source.includes('<Link href={door.href}') })
      .toEqual({ file, bare: false });
  }
});

test('each recorder is actually reachable, by an anchor', () => {
  /*
   * The assertion above is satisfied by a recorder nothing links to at all,
   * which would pass while leaving the feature unreachable. This is the other
   * half: every camera document is linked from somewhere, and as an anchor.
   */
  const anchored = new Set<string>();
  for (const file of SOURCES) {
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(/<a\b[^>]*>/g)) {
      const href = /href=["']([^"']+)["']/.exec(match[0]);
      if (href && isCameraDocument(href[1]!)) anchored.add(href[1]!);
    }
  }

  expect([...anchored].sort()).toEqual([...CAMERA_DOCUMENT_ROUTES].sort());
});

/*
 * THE GLOBAL CHROME, DERIVED RATHER THAN LISTED.
 *
 * GlobalRoleHeader is mounted by the root layout on every signed-in surface,
 * which includes both recorders. Everything it renders is therefore navigation
 * that can happen while the current document holds camera=(self) -- and
 * leaving that document by a soft navigation carries the grant onto every
 * ordinary page afterwards, for as long as the tab lives.
 *
 * The first version of this file checked only links that pointed AT a
 * recorder, and named Corridor by hand. It missed the larger and worse set:
 * the card catalog reaches every door in the building through
 * router.push(door.href), the session bar's own controls are `<Link>`, and the
 * safety badge is mounted beside them. Reading the header's imports means a
 * control added to the bar tomorrow is covered without anybody remembering to
 * add it here.
 */
function componentsImportedBy(file: string): string[] {
  const source = readFileSync(file, 'utf8');
  const names = [
    // Relative, as the chrome imports its siblings.
    ...[...source.matchAll(/^import\s+(?:[\w{},\s*]+)\s+from\s+["']\.\/([\w/]+)["'];?$/gm)].map((m) => m[1]!),
    // Aliased, as a page under app/ imports a component.
    ...[...source.matchAll(/^import\s+(?:[\w{},\s*]+)\s+from\s+["']@\/components\/([\w/]+)["'];?$/gm)].map((m) => m[1]!),
  ];
  return names
    .map((name) => ['tsx', 'ts'].map((ext) => path.join(WEB, 'components', `${name}.${ext}`)).find((f) => SOURCES.includes(f)))
    .filter((f): f is string => Boolean(f));
}

/*
 * EVERYTHING THAT RENDERS ON A CAMERA DOCUMENT, not only the session bar.
 *
 * Two sources, because there are two ways a component ends up on a recorder:
 * the global chrome, which is mounted on every signed-in surface, and whatever
 * the capture pages themselves render. The second is how RoleSessionGate was
 * missed -- it wraps both recorders and redirects on an expired session, a
 * starting PIN or a role that may not be there, which is more exits than any
 * link in the application offers.
 */
const CHROME = (() => {
  const roots = [
    path.join(WEB, 'components', 'GlobalRoleHeader.tsx'),
    ...CAMERA_DOCUMENT_ROUTES.map((route) => path.join(WEB, 'app', ...route.slice(1).split('/'), 'page.tsx')),
  ];
  // The roots are in the set too, not merely walked: a soft-navigating link
  // written directly on a recorder is the shortest way to reopen this, and
  // seeding only the header left the capture pages themselves unchecked.
  const found = new Set<string>(roots.filter((root) => SOURCES.includes(root)));
  found.add(path.join(WEB, 'components', 'GlobalRoleHeader.tsx'));
  for (const root of roots) {
    for (const file of componentsImportedBy(root)) found.add(file);
  }
  return [...found];
})();

test('the chrome set is read off the header, and is not empty', () => {
  // A regex that matched nothing would make the two assertions below vacuous.
  const names = CHROME.map(relative);
  expect(names).toContain('components/GlobalRoleHeader.tsx');
  expect(names).toContain('components/Corridor.tsx');
  expect(names).toContain('components/CardCatalog.tsx');
  // The one the first version of this file missed, and the one with the most
  // ways out of a recorder.
  expect(names).toContain('components/RoleSessionGate.tsx');
  for (const route of CAMERA_DOCUMENT_ROUTES) {
    expect(names).toContain(`app${route}/page.tsx`);
  }
  expect(CHROME.length).toBeGreaterThan(4);
});

test('nothing in the global chrome navigates with a bare next/link', () => {
  const offenders: string[] = [];
  for (const file of CHROME) {
    if (relative(file) === 'components/ChromeLink.tsx') continue; // it IS the wrapper
    const source = readFileSync(file, 'utf8');
    if (/^import\s+Link\s+from\s+["']next\/link["']/m.test(source)) {
      offenders.push(`${relative(file)} imports next/link directly`);
    }
  }
  // Whoever trips this: use ChromeLink. It renders a `<Link>` everywhere
  // except on the two documents where a soft navigation would carry a camera
  // grant off the page that was granted it.
  expect(offenders).toEqual([]);
});

test('nothing in the global chrome routes programmatically without asking first', () => {
  const offenders: string[] = [];
  for (const file of CHROME) {
    const source = readFileSync(file, 'utf8');
    const navigates = /router\.(push|replace)\s*\(/.test(source);
    if (navigates && !source.includes('requiresDocumentLoad')) {
      offenders.push(`${relative(file)} calls router.push/replace with no camera-document check`);
    }
  }
  /*
   * A coarse check on purpose. Proving each individual call site is guarded
   * would mean parsing control flow, and a guard that needs a parser is one
   * nobody maintains. This says: a chrome component that navigates in code has
   * at least consulted the rule -- which is what the card catalog failed to do
   * while looking entirely correct.
   */
  expect(offenders).toEqual([]);
});

test('the two places that navigate by a variable href still consult the rule', () => {
  // Neither has a literal href anywhere for the scan above to read, and
  // between them they are how most people move around this application.
  const catalog = readFileSync(path.join(WEB, 'components', 'CardCatalog.tsx'), 'utf8');
  expect(catalog).toMatch(/requiresDocumentLoad\(pathname, door\.href\)/);
  expect(catalog).toMatch(/window\.location\.assign\(door\.href\)/);

  const corridor = readFileSync(path.join(WEB, 'components', 'Corridor.tsx'), 'utf8');
  expect(corridor).toContain('ChromeLink');
});

test('the gate that wraps both recorders redirects by loading a document', () => {
  /*
   * RoleSessionGate is rendered by both capture pages and redirects on an
   * expired session, a starting PIN, a role that may not be here, or a server
   * error -- four exits, all of them router.replace, all of them from a
   * document holding camera=(self). The capability would have outlived the
   * session the gate had just cleared.
   */
  const gate = readFileSync(path.join(WEB, 'components', 'RoleSessionGate.tsx'), 'utf8');

  expect(gate).toContain('requiresDocumentLoad');
  // Every redirect goes through the one helper, so a fifth added later
  // inherits the rule instead of quietly reopening this.
  expect(gate).not.toMatch(/router\.replace\((?!destination\))/);
  expect(gate).toMatch(/window\.location\.replace\(destination\)/);
});

test('signing out does not lose the logout request to the unload', () => {
  /*
   * Making the exit a document load introduced this: an ordinary fetch is
   * cancelled when the page goes away, so the server would never revoke the
   * session -- "logout" that leaves the session alive, which is the defect
   * the credentials note in both files already exists to prevent.
   */
  for (const name of ['GlobalRoleHeader.tsx', 'CardCatalog.tsx']) {
    const source = readFileSync(path.join(WEB, 'components', name), 'utf8');
    // Matched on the line, not with a balanced-paren regex: the URL contains
    // `${apiBase()}` and its closing paren would end the match early.
    const logout = source
      .split(/\r?\n/)
      .filter((line) => line.includes('auth/logout') && line.includes('fetch('));
    expect(logout).toHaveLength(1);
    expect(logout[0]).toContain('keepalive: true');
    expect(logout[0]).toContain("credentials: 'include'");
  }
});

test('an upload in flight is not silently thrown away by the exits we just hardened', () => {
  /*
   * THE COST OF MAKING EVERY EXIT A PAGE LOAD. The recording lives in page
   * memory until the POST that stores it finishes, and that POST dies with the
   * document. It survived before only because the session bar soft-navigated.
   * Every control we converted is now a way to discard the rep that was just
   * filmed, with no error, because the handler that would report one is gone
   * with the page. keepalive covers the logout POST beside it and cannot cover
   * this: 64 KiB, and this body is a video.
   */
  const recorder = readFileSync(path.join(WEB, 'components', 'useCameraRecorder.ts'), 'utf8');

  expect(recorder).toContain("addEventListener('beforeunload'");
  expect(recorder).toContain("removeEventListener('beforeunload'");
  // Only while uploading: an idle recorder must not interrupt ordinary
  // navigation with a browser prompt.
  expect(recorder).toMatch(/if \(phase !== 'uploading'\) return;/);
});

test('leaving a camera document needs a load, not only arriving at one', () => {
  /*
   * The direction the first repair missed. Arriving soft means the camera
   * never opens, which is visible immediately. Leaving soft means the grant
   * stays live on every ordinary page after it, which is visible to nobody.
   */
  expect(requiresDocumentLoad('/teach-shadow/capture', '/dashboard')).toBe(true);
  expect(requiresDocumentLoad('/coach/video-analysis/capture', '/login')).toBe(true);
  expect(requiresDocumentLoad('/teach-shadow/capture', '/coach/video-analysis/capture')).toBe(true);
  expect(requiresDocumentLoad('/dashboard', '/teach-shadow/capture')).toBe(true);

  // And an ordinary move between ordinary pages stays soft: making every
  // navigation a page load would be a different app.
  expect(requiresDocumentLoad('/dashboard', '/coach/video-analysis')).toBe(false);
  expect(requiresDocumentLoad(null, '/teach-shadow')).toBe(false);
});

test('a trailing slash or a query string does not smuggle a link past the check', () => {
  // The path decides which document is served; the rest does not.
  expect(isCameraDocument('/teach-shadow/capture')).toBe(true);
  expect(isCameraDocument('/teach-shadow/capture/')).toBe(true);
  expect(isCameraDocument('/teach-shadow/capture?take=2')).toBe(true);
  expect(isCameraDocument('/teach-shadow/capture#record')).toBe(true);
  expect(isCameraDocument('/coach/video-analysis/capture')).toBe(true);

  // And a path below one is a different document, which is not granted a
  // camera and must not be given a full page load on the strength of its
  // prefix.
  expect(isCameraDocument('/teach-shadow/capture/preview')).toBe(false);
  expect(isCameraDocument('/teach-shadow')).toBe(false);
  expect(isCameraDocument('/coach/video-analysis')).toBe(false);
});
