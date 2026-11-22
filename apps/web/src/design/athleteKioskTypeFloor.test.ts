import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * THE ATHLETE'S KIOSK TEXT IS --t-md OR LARGER (lane AS-8, AS8-6; app scrub
 * ATH-12; Overwatch Q16 A and Q-CAP A on #2020).
 *
 * An athlete reads these screens on the gym floor, at the kiosk distance the
 * kiosk floor names (--t-md, 19.1px; design-system/README.md). On main there
 * were 89 text declarations below it in these files: --t-sm (15px) and --t-xs
 * (11.8px), as Tailwind length classes or inline font sizes. Every one is
 * --t-md now. An inline pin on a .t-data element is set to --t-md rather than
 * removed, because removing it would raise it to the kiosk .t-data floor
 * (--t-lg).
 *
 * src/design/kioskTypeFloor.test.ts reads CSS only; nothing read JSX for this.
 * This reads the source of the athlete files below and fails on any smaller
 * text declaration in them. Comments are not read: several record the sizes
 * these files used to have.
 */

const WEB = path.resolve(__dirname, '../..');

/** The athlete files in plan #2020's AS8-6 allowlist (Q16 A), and the
 *  after-sparring check's captions (Q-CAP A). */
const FILES = [
  'components/AthleteWorkspace.tsx',
  'components/AthleteCheckInPanel.tsx',
  'components/SparringSymptomCheck.tsx',
  'app/athlete/progression-intelligence/page.tsx',
  'app/athlete/dashboard/sparring/page.tsx',
  'app/athlete/sign-in/page.tsx',
  'app/athlete/video-analysis/page.tsx',
  'app/activate/page.tsx',
];

/** Text below --t-md, in the spellings these files use or could use. */
const BELOW_KIOSK = /--t-(?:sm|xs)\b|\btext-(?:xs|sm)\b|text-\[\d+(?:\.\d+)?px\]|fontSize:\s*['"]?\d+(?:\.\d+)?px|font-size:\s*\d+(?:\.\d+)?px/;

/** The source with block comments, JSX comments and whole-line // comments blanked, lines kept. */
function code(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ' '))
    .replace(/^\s*\/\/.*$/gm, '');
}

test.each(FILES)('%s declares no text below --t-md', (file) => {
  const lines = code(readFileSync(path.join(WEB, file), 'utf8')).split('\n');
  const found = lines.flatMap((line, i) => (BELOW_KIOSK.test(line) ? [`${file}:${i + 1}: ${line.trim()}`] : []));
  expect(found).toEqual([]);
});

test('the guard reads code, and would see a small size if one came back', () => {
  expect(BELOW_KIOSK.test('className="text-[length:var(--t-sm)]"')).toBe(true);
  expect(BELOW_KIOSK.test("style={{ fontSize: 'var(--t-xs)' }}")).toBe(true);
  expect(BELOW_KIOSK.test('className="text-sm"')).toBe(true);
  expect(BELOW_KIOSK.test("style={{ fontSize: '12px' }}")).toBe(true);
  expect(BELOW_KIOSK.test('className="text-[length:var(--t-md)]"')).toBe(false);
  expect(code('a /* --t-sm */ b\n  // --t-xs\n{/* text-sm */}')).not.toMatch(BELOW_KIOSK);
});
