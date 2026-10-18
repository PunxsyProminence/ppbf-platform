import fs from 'node:fs';
import path from 'node:path';

import { BUILDING } from './buildingMap';

/**
 * ONE WORD PER THING (lane U2, audit UX-A A-12; Jason 2026-10-17, glossary
 * "A: Use these words (Recommended)"): Session Plan (not Session Script),
 * Training Hold ("paused" only in the family sentence), Development Plan (the
 * coach's multi-week plan for an athlete), Gym Office (the admin's home). Each
 * menu label equals its page title. "Home" for the header button is PROPOSED
 * under that rule (Overwatch Q3).
 *
 * Code identifiers keep their names (SessionScriptEditor, session_scripts,
 * /coach/session-scripts): only what a person reads changes.
 */

const WEB = path.resolve(__dirname, '..');

function screens(dir: string, found: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'api' && entry.name !== 'node_modules') screens(full, found);
    } else if (/\.tsx$/.test(entry.name) && !/\.test\.tsx$/.test(entry.name)) {
      found.push(full);
    }
  }
  return found;
}

/** The source with comments removed, so a note about the old word is not a screen showing it. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');
}

const SCREENS = [...screens(path.join(WEB, 'app')), ...screens(path.join(WEB, 'components'))].map(
  (file) => [path.relative(WEB, file).split(path.sep).join('/'), withoutComments(fs.readFileSync(file, 'utf8'))] as const,
);

const read = (rel: string) => fs.readFileSync(path.join(WEB, rel), 'utf8');
const door = (href: string) => BUILDING.find((d) => d.href === href);

describe('the ruled words', () => {
  test('no screen says "session script": the word is Session Plan', () => {
    const offenders = SCREENS.filter(([, s]) => /\bsession scripts?\b/i.test(s)).map(([f]) => f);
    expect(offenders).toEqual([]);
  });

  test("the coach's multi-week plan is a Development Plan, not a block, wherever it is named", () => {
    const PLAN_SCREENS = [
      'app/coach/development-blocks/page.tsx',
      'app/athlete/development-blocks/page.tsx',
      'app/parent/development-blocks/page.tsx',
    ];
    for (const file of PLAN_SCREENS) {
      const source = withoutComments(read(file));
      expect(source).not.toMatch(/\bdevelopment blocks?\b/i);
      expect(source).not.toMatch(/'Save block'|>\s*Blocks on record\s*<|New block\{/);
    }
  });

  test('staff screens name the Training Hold, not a pause', () => {
    expect(withoutComments(read('app/coach/sports-medicine/page.tsx'))).not.toMatch(/pause or narrow training/);
    expect(withoutComments(read('app/coach/injuries/page.tsx'))).not.toMatch(/does not pause training/);
    const STAFF = ['components/CoachWorkspace.tsx', 'app/schedule/page.tsx', 'app/coach/progression-intelligence/page.tsx'];
    for (const file of STAFF) {
      const source = withoutComments(read(file));
      expect(source).not.toMatch(/is currently paused for this athlete/);
      expect(source).toMatch(/Training Hold on \{/);
    }
  });

  test('the family page labels say Training hold; "paused" stays in its one sentence', () => {
    const source = read('app/parent/safety/page.tsx');
    expect(source).toContain("all_training: 'Training hold',");
    expect(source).not.toMatch(/'No pause'|'Contact paused'|'Conditioning paused'/);
    expect(source).toContain("all_training: 'Training is paused right now',");
  });

  test.each([
    ['/coach/session-scripts', 'app/coach/session-scripts/page.tsx', 'Session Plans'],
    ['/coach/development-blocks', 'app/coach/development-blocks/page.tsx', 'Development Plans'],
    ['/athlete/development-blocks', 'app/athlete/development-blocks/page.tsx', 'My Development Plan'],
    ['/parent/development-blocks', 'app/parent/development-blocks/page.tsx', 'Their Development Plan'],
    ['/coach/development', 'app/coach/development/page.tsx', 'Your Coaching Growth'],
    ['/admin/people', 'app/admin/people/page.tsx', 'Gym Office'],
    ['/dashboard', 'app/dashboard/page.tsx', 'Home'],
  ])('%s: door label = page title = %s', (href, file, title) => {
    expect(door(href)?.label).toBe(title);
    expect(read(file)).toMatch(new RegExp(`<h1[^>]*>\\s*${title}\\s*</h1>`));
  });

  test('the header button reads Home, the page it opens', () => {
    expect(read('components/GlobalRoleHeader.tsx')).toMatch(/>\s*Home\s*<\/ChromeLink>/);
    expect(read('components/GlobalRoleHeader.tsx')).not.toMatch(/>\s*Bell\s*</);
  });

  test("the coach's own growth is not called Development, which is the athlete's plan", () => {
    expect(read('components/CoachWorkspace.tsx')).toContain("{ id: 'development', label: 'Your Growth' },");
    // The staff workspace link names it as its door does (#1703 added the link).
    expect(read('app/workspace/page.tsx')).toContain("label: 'Your Coaching Growth',");
  });
});
