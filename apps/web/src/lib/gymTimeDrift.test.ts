import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * A ratchet, not a cleanup.
 *
 * `toLocaleDateString(undefined, ...)` and its siblings format in the VIEWER's
 * timezone. Every date this platform shows describes something that happened at
 * a gym in Punxsutawney, so a viewer-dependent rendering is wrong by
 * construction -- and wrong invisibly, because CI runs in UTC. The suite stayed
 * green while ThenAndNow rendered day one as the day before on every machine in
 * America/New_York, which is every machine the gym actually uses.
 *
 * Fixing all twenty-six call sites at once would be a large, untested sweep
 * across pages nobody is currently changing. So the existing ones are recorded
 * here as known debt, and this test fails when a NEW file starts formatting
 * dates that way. Use src/lib/gymTime.ts instead: formatGymDay for a value that
 * may be a calendar date, formatGymDate/formatGymDateTime for an instant.
 *
 * REMOVING AN ENTRY: convert the file to gymTime and delete its line. The list
 * only ever shrinks.
 */

const APP_ROOT = path.resolve(__dirname, '../..');
const SCANNED_DIRECTORIES = ['app', 'components', 'src'];
const LOCALE_FORMATTERS = /\.toLocale(Date|Time)?String\s*\(/;

/**
 * Files that formatted dates in the viewer's timezone before the gym-local
 * helpers existed. Grandfathered, and each one is a real (if minor) display bug
 * for anyone whose device is not set to America/New_York.
 */
const KNOWN_VIEWER_TIMEZONE_CALLERS = new Set([
  'app/admin/activation-codes/page.tsx',
  'app/admin/compliance-center/page.tsx',
  'app/admin/feedback/page.tsx',
  'app/admin/page.tsx',
  'app/admin/public-interest/page.tsx',
  'app/admin/video-review/page.tsx',
  'app/athlete/dashboard/sparring/page.tsx',
  'app/athlete/progression-intelligence/page.tsx',
  'app/athlete/video-analysis/page.tsx',
  'app/coach/progression-intelligence/page.tsx',
  'app/coach/video-analysis/page.tsx',
  'app/rabbit-holes/page.tsx',
  'app/research/chat/page.tsx',
  'app/retro-lab/page.tsx',
  'app/schedule/page.tsx',
  'app/shadow/page.tsx',
  'app/shadow/scout/page.tsx',
  'app/workspace/page.tsx',
  'components/AnnouncementBanner.tsx',
  'components/AthleteWorkspace.tsx',
  'components/BoardSeatEvidence.tsx',
  'components/Chalkboard.tsx',
  'components/CoachWorkspace.tsx',
  'components/ParentDigest.tsx',
  'components/PrintSheet.tsx',
  'src/client/shadowSessions.ts',
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

  test('the scan finds files at all, so this guard cannot pass vacuously', () => {
    expect(offenders.length).toBeGreaterThan(0);
  });

  test('no new file formats dates in the viewer timezone', () => {
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
