import fs from 'node:fs';
import path from 'node:path';

import { BUILDING } from './buildingMap';

/**
 * EACH MENU LABEL EQUALS ITS PAGE TITLE (Jason 2026-10-17, glossary A; lane U2,
 * audit UX-A A-12). The Corridor and the Jump catalog both print door labels,
 * and the catalog search found a page by a name the page never showed.
 *
 * A door passes when its label equals one of the page's literal <h1> texts (a
 * page may carry a notice h1 for a refused role beside its own). Pages whose
 * title is not a literal -- built from data, or set by a shared shell -- are
 * not knowable from source and are skipped, as are the two listed below.
 */

const WEB = path.resolve(__dirname, '..');

/** Pages whose only literal h1 is a holding state while the real one loads. */
const HOLDING_ONLY: Record<string, string> = {
  '/shadow': '"Opening SHADOW" while the chat loads',
  '/shadow/scout': '"Opening Scout" while the scout loads',
};

function literalTitles(href: string): string[] | null {
  const file = path.join(WEB, 'app', ...href.split('/').filter(Boolean), 'page.tsx');
  if (!fs.existsSync(file)) return null;
  const source = fs.readFileSync(file, 'utf8');
  const titles = [...source.matchAll(/<h1[^>]*>\s*([^<{]+?)\s*<\/h1>/g)]
    .map((m) => m[1].replace(/&apos;|&rsquo;/g, "'").replace(/&amp;/g, '&'))
    // A notice for a refused role or a holding state is not the page's title.
    .filter((title) => !/^Loading|Access Required|managed per gym|set per gym/.test(title));
  return titles.length > 0 ? titles : null;
}

const CHECKED = BUILDING.filter((door) => !/[?#]/.test(door.href) && !(door.href in HOLDING_ONLY))
  .map((door) => [door.href, door.label, literalTitles(door.href)] as const)
  .filter(([, , titles]) => titles !== null);

test('the scan reaches enough doors to mean something', () => {
  expect(CHECKED.length).toBeGreaterThan(110);
});

test.each(CHECKED)('%s: the door "%s" is the page title', (_href, label, titles) => {
  expect(titles).toContain(label);
});
