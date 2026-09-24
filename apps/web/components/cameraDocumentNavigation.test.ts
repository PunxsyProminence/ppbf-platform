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
const CHROME = (() => {
  const header = readFileSync(path.join(WEB, 'components', 'GlobalRoleHeader.tsx'), 'utf8');
  const names = [...header.matchAll(/^import\s+(?:[\w{},\s*]+)\s+from\s+["']\.\/([\w/]+)["'];?$/gm)]
    .map((match) => match[1]!);
  return ['GlobalRoleHeader', ...names]
    .map((name) => ['tsx', 'ts'].map((ext) => path.join(WEB, 'components', `${name}.${ext}`)).find((file) => SOURCES.includes(file)))
    .filter((file): file is string => Boolean(file));
})();

test('the chrome set is read off the header, and is not empty', () => {
  // A regex that matched nothing would make the two assertions below vacuous.
  const names = CHROME.map(relative);
  expect(names).toContain('components/GlobalRoleHeader.tsx');
  expect(names).toContain('components/Corridor.tsx');
  expect(names).toContain('components/CardCatalog.tsx');
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
