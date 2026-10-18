import fs from 'node:fs';
import path from 'node:path';

import { BUILDING } from './buildingMap';

/**
 * EACH MENU LABEL EQUALS ITS PAGE TITLE (Jason 2026-10-17, glossary A; lane U2,
 * audit UX-A A-12). The Corridor and the Jump catalog both print door labels,
 * and the catalog search found a page by a name the page never showed.
 *
 * A door passes when its label equals one of the literal <h1> texts of its
 * page OR of a component the page imports (one level: /print renders
 * PrintRoom, the board seats render BoardMemberDashboard). A notice for a
 * refused role or a holding state does not count as the title.
 *
 * Pages whose title is not a literal anywhere in that reach -- built from
 * data or a prop -- are listed below by name, so a new one cannot slip past
 * silently: the test fails until it is either titled or listed here.
 */

const WEB = path.resolve(__dirname, '..');

/** Pages whose only literal h1 is a holding state while the real one loads. */
const HOLDING_ONLY: Record<string, string> = {
  '/shadow': '"Opening SHADOW" while the chat loads',
  '/shadow/scout': '"Opening Scout" while the scout loads',
};

/** Pages whose title is not a literal in the page or the components it imports. */
const TITLE_NOT_LITERAL: Record<string, string> = {
  '/': 'the public front page; its h1 comes from the stored gym profile',
  '/athlete/dashboard': 'AthleteWorkspace prints the open tab group as the h1',
  '/coach/environment/intake-router': 'the shell prints roleLabel "Coach Workspace" as the h1',
  '/workspace': 'the h1 is "<role> Workspace", built from the session role',
  '/profile': 'the shell prints roleLabel "Your Corner" as the h1',
  '/wall': 'the gym TV wall; its heading comes from the wall read',
  '/parent/progression-visibility': "the h1 is <child>'s Progression, built from the chosen child",
  '/parent/video': "the h1 is <child>'s Film (or Your Athlete's Film), built from the chosen child",
  // The eight seats: titled "<seatLabel> Workspace" from the board config;
  // pinned below against that config instead.
  '/board/president': 'seat page, see below', '/board/chair': 'seat page, see below',
  '/board/vice-chair': 'seat page, see below', '/board/treasurer': 'seat page, see below',
  '/board/secretary': 'seat page, see below', '/board/safety-director': 'seat page, see below',
  '/board/community-director': 'seat page, see below', '/board/at-large': 'seat page, see below',
};


const NOT_A_TITLE = /^Loading|Access Required|managed per gym|set per gym/;

function literalH1s(source: string): string[] {
  return [...source.matchAll(/<h1[^>]*>\s*([^<{]+?)\s*<\/h1>/g)]
    .map((m) => m[1].replace(/&apos;|&rsquo;/g, "'").replace(/&amp;/g, '&'))
    .filter((title) => !NOT_A_TITLE.test(title));
}

/** Local component files a page imports (@/components/X, ./X, ../X). */
function importedComponents(file: string, source: string): string[] {
  const found: string[] = [];
  for (const m of source.matchAll(/^import\s+[^;]*?from\s+'((?:@\/components|\.{1,2})\/[^']+)';/gm)) {
    const spec = m[1];
    const base = spec.startsWith('@/') ? path.join(WEB, spec.slice(2)) : path.resolve(path.dirname(file), spec);
    for (const candidate of [`${base}.tsx`, path.join(base, 'index.tsx')]) {
      if (fs.existsSync(candidate)) found.push(candidate);
    }
  }
  return found;
}

function titlesFor(href: string): string[] | null {
  const file = path.join(WEB, 'app', ...href.split('/').filter(Boolean), 'page.tsx');
  if (!fs.existsSync(file)) return null;
  const source = fs.readFileSync(file, 'utf8');
  const titles = [
    ...literalH1s(source),
    ...importedComponents(file, source).flatMap((component) => literalH1s(fs.readFileSync(component, 'utf8'))),
  ];
  return titles.length > 0 ? titles : null;
}

const DOORS = BUILDING.filter((door) => !/[?#]/.test(door.href) && !(door.href in HOLDING_ONLY));
const SCANNED = DOORS.map((door) => [door.href, door.label, titlesFor(door.href)] as const);
const CHECKED = SCANNED.filter(([, , titles]) => titles !== null);

test('every door without a findable title is named, with why', () => {
  const unknown = SCANNED.filter(([, , titles]) => titles === null).map(([href]) => href).sort();
  expect(unknown).toEqual(Object.keys(TITLE_NOT_LITERAL).sort());
});

test('the scan reaches enough doors to mean something', () => {
  expect(CHECKED.length).toBeGreaterThan(120);
});

test.each(CHECKED)('%s: the door "%s" is the page title', (_href, label, titles) => {
  expect(titles).toContain(label);
});


test('each board seat door names its seat page, "<seatLabel> Workspace"', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { boardSeatConfigs } = require('../app/board/boardWorkspaceConfig') as typeof import('../app/board/boardWorkspaceConfig');
  for (const seat of boardSeatConfigs) {
    const door = BUILDING.find((d) => d.href === `/board/${seat.slug}`);
    expect(door?.label).toBe(`${seat.seatLabel} Workspace`);
  }
  expect(fs.readFileSync(path.join(WEB, 'components/BoardMemberDashboard.tsx'), 'utf8')).toContain('{seat.seatLabel} Workspace</h1>');
});
