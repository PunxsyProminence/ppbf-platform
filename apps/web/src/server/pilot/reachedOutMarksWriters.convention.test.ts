// Convention gate for the "reached out" mark (lane W4-6, SC-3a-2; OW27-33 B;
// Overwatch W4-6 Q4 A, and on #2163 answer A: the mark goes through
// stoppedComing.ts and its one route, no separate reached-out route).
//
// stoppedComing.ts is where a mark is refused for a caller who is not staff
// here, an athlete who is not a live athlete of this gym, or one not on the
// list now; reachedOutMarks.ts itself trusts its caller for all three. So no
// other file may import that module, and no other file may name the table in
// its own text, or a new route could write or read marks around those checks.
//
// WHAT IT IS AND IS NOT. A source check over every shipped file under app/,
// components/, lib/ and src/ (tests excluded; migrations live in infra/ and the
// runner in scripts/, neither swept). It proves which files import the module
// or name the table, not what any of them does; a table name assembled at run
// time is not caught. privacyTiers.ts names the table only on the public
// surface denylist, to forbid it.

import fs from 'node:fs';
import path from 'node:path';

const WEB_DIR = path.resolve(__dirname, '../../..');

function filesUnder(dir: string, keep: (file: string) => boolean): string[] {
  if (!fs.existsSync(dir)) return [];
  const found: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...filesUnder(full, keep));
    else if (keep(full)) found.push(full);
  }
  return found;
}

const relative = (file: string) => path.relative(WEB_DIR, file).split(path.sep).join('/');
const source = (file: string) => fs.readFileSync(file, 'utf8');
// Every JS or TS extension, .jsx and .cts included (reviewer J got a .jsx re-export past a narrower list).
const isSource = (file: string) => /\.[cm]?[jt]sx?$/.test(file) && !/\.test\.[a-z]+$/.test(file);

const ALL_SOURCE = ['app', 'components', 'lib', 'src'].flatMap((dir) => filesUnder(path.join(WEB_DIR, dir), isSource));

/** An import, re-export or require of the module, by any relative or alias path, either quote style. */
const IMPORTS_MODULE = /\breachedOutMarks(\.[cm]?[jt]sx?)?['"]/;
const NAMES_TABLE = /athlete_reached_out_marks/;

describe('the reached-out mark is written and read only through stoppedComing.ts', () => {
  it('the sweep reads the files it claims to (it has not gone blind)', () => {
    expect(ALL_SOURCE.length).toBeGreaterThan(500);
    const all = ALL_SOURCE.map(relative);
    for (const file of ['src/server/pilot/reachedOutMarks.ts', 'src/server/pilot/stoppedComing.ts', 'src/server/pilot/privacyTiers.ts']) {
      expect(all).toContain(file);
    }
  });

  it('only stoppedComing.ts imports the reachedOutMarks module', () => {
    expect(ALL_SOURCE.filter((file) => IMPORTS_MODULE.test(source(file))).map(relative).sort())
      .toEqual(['src/server/pilot/stoppedComing.ts']);
  });

  it('only reachedOutMarks.ts and privacyTiers.ts name the table in their own text', () => {
    expect(ALL_SOURCE.filter((file) => NAMES_TABLE.test(source(file))).map(relative).sort())
      .toEqual(['src/server/pilot/privacyTiers.ts', 'src/server/pilot/reachedOutMarks.ts']);
  });
});
