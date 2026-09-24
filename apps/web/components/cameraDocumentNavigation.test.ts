import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import nextConfig from '../next.config';
import { CAMERA_DOCUMENT_ROUTES, isCameraDocument } from './cameraDocuments';

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

test('the corridor decides per door, because its hrefs are not literals', () => {
  /*
   * The scan above reads literal hrefs. Corridor renders every door in the
   * building from `door.href`, so a capture door goes through it with no
   * literal anywhere for the scan to see -- and the corridor is how most
   * people navigate this application. It has to make the choice at runtime,
   * and this is the assertion that it still does.
   */
  const corridor = readFileSync(path.join(WEB, 'components', 'Corridor.tsx'), 'utf8');

  expect(corridor).toContain('isCameraDocument');
  expect(corridor).toMatch(/if \(isCameraDocument\(door\.href\)\)/);
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
