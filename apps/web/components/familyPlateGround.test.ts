import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { readDesignSystemCss } from '../src/design/readDesignSystemCss';

/* B7 — the enforcement half of T7 (Plate Set v1, owner-approved 2026-08-16).
 *
 * THE RULE. A family surface stands on the warm ground or on no ground at
 * all. It never declares a room.
 *
 * WHY A TEST AND NOT A CODE REVIEW. RoleStandaloneView already refuses to put
 * a room on the family branch, and states why in a comment. But only 14 of the
 * ~79 room-bearing surfaces go through that shell -- the rest write
 * `room--office` straight into a className string, which no shell can
 * intercept. Three had already done exactly that (guardian/dashboard,
 * parent/safety, parent/consent) and were corrected alongside this test. A
 * comment in a component nobody imported was not enough to hold the rule, so
 * the rule is asserted where it cannot be bypassed.
 *
 * WHY IT MATTERS MORE NOW. Before plates a stray room meant a gradient wall on
 * a family page -- wrong, but quiet. With Plate Set v1 wired it means a
 * photographic plank wall behind a child's consent form. The rule went from
 * stylistic to load-bearing, so it acquired a test.
 *
 * EVERY room is non-warm. There is no `.room--warm`; the warm ground is
 * `.on-canvas`, Law 6's second ground, which is not a room at all. So the
 * assertion is simply that no family file names a room -- naming any room is
 * naming a non-warm one.
 */

const APP_DIR = join(__dirname, '..', 'app');

/** Route trees whose audience is family, per roleGround.ts's FAMILY_ROLES and
 * the T7 wording ("/guardian, /parent, or public onboarding"). */
const FAMILY_ROUTE_DIRS = ['guardian', 'parent', 'public'];

const ROOM_CLASS = /room--([a-z-]+)/g;

function collectFiles(dir: string): string[] {
  let found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      found = found.concat(collectFiles(full));
      continue;
    }
    if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) found.push(full);
  }
  return found;
}

describe('T7: family surfaces never declare a non-warm room', () => {
  for (const routeDir of FAMILY_ROUTE_DIRS) {
    const dir = join(APP_DIR, routeDir);

    test(`/${routeDir} declares no room`, () => {
      const files = collectFiles(dir);

      // A family tree that has gone missing would make this suite pass by
      // examining nothing, which is the failure mode a path-based guard is
      // most prone to. Assert there is something to check.
      expect(files.length).toBeGreaterThan(0);

      const offenders: string[] = [];
      for (const file of files) {
        const source = readFileSync(file, 'utf8');
        for (const match of source.matchAll(ROOM_CLASS)) {
          // `room--` alone is the tokenised tail of a template literal
          // (`room--${room}`), which designSystemClasses.test.ts also skips;
          // it names no specific room.
          if (!match[1]) continue;
          offenders.push(`${file.replace(APP_DIR, 'app')} declares room--${match[1]}`);
        }
      }

      expect(offenders).toEqual([]);
    });
  }
});

describe('T7: the warm ground is reachable and is not a room', () => {
  test('.on-canvas carries the warm plate, and no room-- class does', () => {
    const css = readDesignSystemCss(
      join(__dirname, '..', '..', '..', 'design-system', 'ppbf.css'),
    );

    // The family ground resolves plate 7...
    expect(css).toMatch(/\.on-canvas\s*\{\s*--plate:\s*url\("\/plates\/plate-07-warm-ground-01\.jpg"\)/);

    // ...and no room does. If a room ever claimed the warm plate, T7 would be
    // satisfiable by a staff surface, which is not what the rule protects.
    const roomsClaimingWarm = [...css.matchAll(/\.room--[a-z-]+\s*\{\s*--plate:\s*url\("([^"]+)"\)/g)]
      .filter((m) => m[1].includes('warm-ground'));
    expect(roomsClaimingWarm).toEqual([]);
  });
});
