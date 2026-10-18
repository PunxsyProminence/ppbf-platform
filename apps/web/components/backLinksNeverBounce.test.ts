import fs from 'node:fs';
import path from 'node:path';

/**
 * A "BACK" LINK NEVER OPENS A PAGE THAT REFUSES THE PAGE'S OWN READERS.
 *
 * Lane U2 (audit UX-A A-5, A-7, 2026-10-16). RoleSessionGate answers a refused
 * role by sending it home with nothing said, so a back button into a page that
 * refuses the reader looks broken. internalLinksResolve.test.ts proves a link
 * opens a page that EXISTS; this proves a literal "Back to ..." link opens a
 * page that admits every role the linking page admits.
 *
 * WHAT IT READS: each app page's first `allowedRoles={[...]}` literal, and every
 * literal `<Link href="/x" ...>Back to ...</Link>` in it. Pages without an
 * allowedRoles literal, and targets without one, are skipped -- their gate is
 * not knowable from source, and guessing would make this lie in the confident
 * direction. The shared BackHome link is checked by backHome.test.tsx instead.
 */

const APP_DIR = path.resolve(__dirname, '../app');

function pageFiles(dir: string = APP_DIR, found: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'api') pageFiles(full, found);
    } else if (entry.name === 'page.tsx') {
      found.push(full);
    }
  }
  return found;
}

function rolesIn(source: string): string[] | null {
  const match = source.match(/allowedRoles=\{\[([^\]]*)\]\}/);
  // A spread or a constant (`[...OPERATIONS_ROLES]`) is not knowable here.
  if (!match || !/^\s*'[^']+'(\s*,\s*'[^']+')*\s*,?\s*$/.test(match[1])) return null;
  return [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

function routeOf(file: string): string {
  const rel = path.relative(APP_DIR, path.dirname(file)).split(path.sep).join('/');
  return rel === '' ? '/' : `/${rel}`;
}

const PAGES = new Map(pageFiles().map((file) => [routeOf(file), fs.readFileSync(file, 'utf8')]));

const BACK_LINK = /<Link\s+(?:[^>]*?\s)?href="(\/[^"?#]*)"[^>]*>\s*Back to[^<]*<\/Link>/g;

/** The pages lane U2 gave the shared back link, which must keep it. */
const BACK_HOME_PAGES = [
  '/coach/attempt-log', '/coach/behavior-standards', '/coach/credentials', '/coach/decision-loop',
  '/coach/drills', '/coach/floor-groups', '/coach/intelligence', '/coach/intervention-executions',
  '/coach/intervention-protocols', '/coach/intervention-review', '/coach/one-percent-club',
  '/coach/progression-intelligence', '/coach/recognition', '/coach/transfer-check', '/coach/video-analysis',
  '/coach/visualization', '/teach-shadow',
  '/admin/athlete-consent', '/admin/attendance', '/admin/community-service',
  '/admin/consent', '/admin/escalations', '/admin/import', '/admin/program-phases', '/admin/safety-flags',
  '/notices', '/operations/external-competition', '/operations/wrestling-league', '/coach/passbook-gaps',
  '/schedule',
  // A-7: pages that had no in-page way back at all.
  '/coach/passbook', '/coach/assessments', '/coach/mental-skills', '/coach/sparring-exposure',
  '/coach/video-publications/library', '/athlete/dashboard/sparring', '/athlete/progression-intelligence',
  '/board/aggregates', '/board/escalation-monitoring', '/coach/cohorts', '/coach/disciplines',
  '/coach/adult-pathway', '/rabbit-holes',
];

describe('back links never bounce', () => {
  test('the scan found pages and gated pages', () => {
    expect(PAGES.size).toBeGreaterThan(100);
    expect([...PAGES.values()].filter((s) => rolesIn(s)).length).toBeGreaterThan(50);
  });

  test('every literal "Back to" link opens a page that admits all of this page\'s roles', () => {
    const bounces: string[] = [];
    for (const [route, source] of PAGES) {
      const from = rolesIn(source);
      if (!from) continue;
      for (const match of source.matchAll(BACK_LINK)) {
        const target = PAGES.get(match[1]);
        const to = target ? rolesIn(target) : null;
        if (!to) continue;
        const refused = from.filter((role) => !to.includes(role));
        if (refused.length > 0) bounces.push(`${route} -> ${match[1]} refuses ${refused.join(', ')}`);
      }
    }
    expect(bounces).toEqual([]);
  });

  test.each(BACK_HOME_PAGES)('%s carries the shared back link', (route) => {
    const source = PAGES.get(route);
    expect(source).toBeDefined();
    expect(source).toMatch(/import BackHome from '@\/components\/BackHome';/);
    expect(source).toMatch(/<BackHome[\s/]/);
  });

  test('no page hard-codes a coach-home back link', () => {
    const offenders = [...PAGES].filter(([, s]) => /Back to Coach Workspace/.test(s)).map(([r]) => r);
    expect(offenders).toEqual([]);
  });

  test('the print room offers the way back', () => {
    const room = fs.readFileSync(path.resolve(__dirname, 'PrintRoom.tsx'), 'utf8');
    expect(room).toMatch(/<BackHome \/>/);
  });

  test.each([
    ['/admin/escalations', '/admin/compliance-center'],
    ['/admin/athlete-consent', '/admin/video-compliance'],
    ['/admin/attendance', '/admin/athletes'],
  ])('%s shows %s only to the roles that page admits', (route, target) => {
    const source = PAGES.get(route) as string;
    expect(source).not.toMatch(new RegExp(`<Link\\s+href="${target}"`));
    const roles = rolesIn(PAGES.get(target) as string) as string[];
    const gated = source.match(new RegExp(`<RoleLink href="${target}" roles=\\{\\[([^\\]]*)\\]\\}`));
    expect(gated).not.toBeNull();
    expect([...(gated as RegExpMatchArray)[1].matchAll(/'([^']+)'/g)].map((m) => m[1])).toEqual(roles);
  });
});
