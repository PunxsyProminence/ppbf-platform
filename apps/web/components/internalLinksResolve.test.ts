import fs from 'node:fs';
import path from 'node:path';

/**
 * EVERY INTERNAL LINK IN THE APP OPENS ONTO A PAGE THAT EXISTS.
 *
 * buildingMapCoverage.test.ts already checks that no DOOR points at a missing
 * page. That is a different question from this one, and the gap between them
 * is where ten dead buttons lived: `/coach` has never had a page.tsx and has
 * never had a door, so nothing in the map had an opinion about it -- while ten
 * coach pages rendered `<Link href="/coach">Back to Coach Workspace</Link>`
 * straight into a 404. The suite was green the whole time, because no test
 * looked at an href.
 *
 * So this walks the JSX instead of the map. A literal internal href either
 * resolves to a route on disk or it is a dead affordance, and a dead
 * affordance on a "back to where you came from" button is worse than no
 * button: the coach has already committed to leaving the page.
 *
 * WHAT THIS DELIBERATELY DOES NOT COVER, so nobody reads a pass as more than
 * it is:
 *
 *   - Template-literal and expression hrefs (`href={`/store/${id}`}`,
 *     `href={crumb.href}`). Their target is not knowable from source, and
 *     guessing at one would make this test lie in the confident direction.
 *   - Anything that is not a same-origin path: `http…`, `mailto:`, and bare
 *     `#anchor` fragments never match the pattern.
 *   - Whether the page a link resolves to will actually admit the person who
 *     clicked it. That is the page's own guard, and buildingMap.ts's header is
 *     emphatic that a visibility list is not an authorization decision.
 *
 * A dynamic segment matches any single path part, the same way the router
 * resolves it: `/store/[organizationId]` accepts `/store/org-1`.
 */

const APP_DIR = path.resolve(__dirname, '../app');

/** Every route in app/ that renders a page, as a URL path. */
function routesOnDisk(dir: string = APP_DIR, prefix = ''): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      if (entry.name === 'page.tsx' || entry.name === 'page.ts') {
        found.push(prefix === '' ? '/' : prefix);
      }
      continue;
    }
    if (entry.name === 'api' || entry.name.startsWith('_')) continue;
    // Route groups are not part of the URL; dynamic segments are.
    const next = entry.name.startsWith('(') ? prefix : `${prefix}/${entry.name}`;
    found.push(...routesOnDisk(path.join(dir, entry.name), next));
  }
  return found;
}

/** Every non-test .tsx under app/, excluding the API tree. */
function sourceFiles(dir: string = APP_DIR, found: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'api') continue;
      sourceFiles(full, found);
    } else if (entry.name.endsWith('.tsx') && !entry.name.includes('.test.')) {
      found.push(full);
    }
  }
  return found;
}

/** `href="/some/path?q=1#frag"` -> `/some/path`. Literals only. */
const LITERAL_INTERNAL_HREF = /href="(\/[^"{}`]*)"/g;

function linksIn(source: string): string[] {
  return [...source.matchAll(LITERAL_INTERNAL_HREF)]
    .map((match) => match[1].split('?')[0].split('#')[0])
    .filter((href) => href !== '');
}

function resolves(href: string, routes: readonly string[]): boolean {
  const parts = href.split('/');
  return routes.some((route) => {
    const routeParts = route.split('/');
    if (routeParts.length !== parts.length) return false;
    return routeParts.every((part, i) => part.startsWith('[') || part === parts[i]);
  });
}

describe('every internal link opens onto a page that exists', () => {
  const routes = routesOnDisk();
  const files = sourceFiles();

  it('finds the app tree, and enough of it to be worth asserting on', () => {
    // A broken walk would make the assertion below vacuously pass, which is
    // the failure mode this whole file exists to close.
    expect(routes.length).toBeGreaterThan(100);
    expect(files.length).toBeGreaterThan(100);
    expect(routes).toContain('/coach/environment/intake-router');
  });

  it('reads hrefs out of real markup', () => {
    // Proves the pattern matches the shape it is meant to catch, so "no
    // unresolved links" means the walk looked rather than that it found
    // nothing to look at.
    expect(linksIn('<Link href="/coach/drills">Drills</Link>')).toEqual(['/coach/drills']);
    expect(linksIn('<Link href="/print?athlete_id=a1">Print</Link>')).toEqual(['/print']);
    expect(linksIn('<a href="#programs">Programs</a>')).toEqual([]);
    expect(linksIn('<a href="mailto:admin@punxsyprominence.org">Mail</a>')).toEqual([]);
    expect(linksIn('<Link href={`/store/${id}`}>Store</Link>')).toEqual([]);
  });

  it('resolves a dynamic segment the way the router does', () => {
    expect(resolves('/store/org-1', ['/store/[organizationId]'])).toBe(true);
    expect(resolves('/store/org-1/extra', ['/store/[organizationId]'])).toBe(false);
  });

  it('has no link pointing at a route that does not exist', () => {
    const dangling: string[] = [];

    for (const file of files) {
      const source = fs.readFileSync(file, 'utf8');
      for (const href of linksIn(source)) {
        if (!resolves(href, routes)) {
          dangling.push(`${href}  <-  ${path.relative(APP_DIR, file)}`);
        }
      }
    }

    // Whoever trips this: the fix is the href or the missing page, not an
    // exception list. `/coach` was the last one, and it was wrong ten times.
    expect(dangling).toEqual([]);
  });
});
