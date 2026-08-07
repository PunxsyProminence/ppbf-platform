import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * A ratchet, and the cleanup is now done.
 *
 * `toLocaleDateString(undefined, ...)` and its siblings format in the VIEWER's
 * timezone. Every date this platform shows describes something that happened at
 * a gym in Punxsutawney, so a viewer-dependent rendering is wrong by
 * construction -- and wrong invisibly, because CI runs in UTC. The suite stayed
 * green while ThenAndNow rendered day one as the day before on every machine in
 * America/New_York, which is every machine the gym actually uses.
 * * All twenty-six original call sites have been converted, so the list below is
 * empty and this test now asserts a flat prohibition: nothing outside
 * src/lib/gymTime.ts may call a toLocale* formatter. Use the helpers there --
 * formatGymDay for a value that may be a calendar date, formatGymStamp or
 * formatGymDate/formatGymTimeOfDay for an instant, formatGymCustom when the
 * option set is bespoke. Each pins both the zone and the locale, which are the
 * two things a viewer's device must never decide for a gym's records.
 *
 * If a file legitimately needs a viewer-local rendering some day, add it here
 * with a comment saying why. An empty list is the desired state, not a rule
 * against exceptions existing.
 */

const APP_ROOT = path.resolve(__dirname, '../..');
const SCANNED_DIRECTORIES = ['app', 'components', 'src'];
const LOCALE_FORMATTERS = /\.toLocale(Date|Time)?String\s*\(/;

/**
 * Files that formatted dates in the viewer's timezone before the gym-local
 * helpers existed. Grandfathered, and each one is a real (if minor) display bug
 * for anyone whose device is not set to America/New_York.
 */
const KNOWN_VIEWER_TIMEZONE_CALLERS = new Set<string>([
  // Empty, and worth keeping empty. Every entry here is a screen showing the
  // wrong day to anyone whose device is not set to America/New_York.
]);

function sourceFilesUnder(directory: string): string[] {
  const absolute = path.join(APP_ROOT, directory);
  const found: string[] = [];

  const walk = (current: string): void => {
    for (const entry of readdirSync(current)) {
      if (entry === 'node_modules' || entry === '.next') continue;
      const full = path.join(current, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.tsx?$/.test(entry) || /\.test\.tsx?$/.test(entry)) continue;
      found.push(path.relative(APP_ROOT, full).split(path.sep).join('/'));
    }
  };

  walk(absolute);
  return found;
}

describe('dates are formatted in the gym timezone, not the viewer timezone', () => {
  const offenders = SCANNED_DIRECTORIES.flatMap(sourceFilesUnder)
    .filter((file) => file !== 'src/lib/gymTime.ts')
    .filter((file) => LOCALE_FORMATTERS.test(readFileSync(path.join(APP_ROOT, file), 'utf8')));

  // The scan itself is what could rot: a glob that stopped matching would make
  // every assertion below vacuously true. Counting the files walked keeps the
  // guard honest now that the offender list is empty.
  test('the scan walks a real number of source files', () => {
    const scanned = SCANNED_DIRECTORIES.flatMap(sourceFilesUnder);
    expect(scanned.length).toBeGreaterThan(100);
    expect(scanned).toContain('src/lib/gymTime.ts');
  });

  test('no file formats dates in the viewer timezone', () => {
    const added = offenders.filter((file) => !KNOWN_VIEWER_TIMEZONE_CALLERS.has(file));
    expect(added).toEqual([]);
  });

  test('the debt list has no stale entries', () => {
    // A file that was converted (or deleted) must be removed from the list, so
    // the count here always reflects the real remaining work.
    const stale = [...KNOWN_VIEWER_TIMEZONE_CALLERS].filter((file) => !offenders.includes(file));
    expect(stale).toEqual([]);
  });
});
