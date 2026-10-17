import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * UXB-L11 (lane U3): one word per action, dates through the gym-time helpers,
 * and readiness never as colour alone. A source check on purpose: it sees
 * every branch of every screen, and fails by file when one drifts back.
 */

const WEB = path.resolve(__dirname, '../..');

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (name === 'node_modules') return [];
    if (statSync(full).isDirectory()) return sources(full);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [full] : [];
  });
}

const SCREENS = [...sources(path.join(WEB, 'app')), ...sources(path.join(WEB, 'components'))];
const rel = (file: string) => path.relative(WEB, file).replace(/\\/g, '/');

/* Files another open PR is changing on the same lines; each leaves this list
   when that PR merges and this check is extended to it. Only ever shrinks. */
const PENDING: ReadonlySet<string> = new Set([
  'app/coach/decision-loop/page.tsx', // held until lane U1 and #1664 land (Overwatch ruling (c))
  'components/AthleteAchievements.tsx', // #1680
  'components/AthleteWorkspace.tsx', // #1680
  'app/admin/athletes/page.tsx', // #1684
  'app/admin/people/page.tsx', // #1684
]);

describe('one word per action (UXB-32)', () => {
  test('busy text is "Saving…", never "Saving..."', () => {
    const offenders = SCREENS.filter((file) => !PENDING.has(rel(file)) && readFileSync(file, 'utf8').includes('Saving...'));
    expect(offenders.map(rel)).toEqual([]);
  });

  test('an athlete picker prompts "Choose an athlete"', () => {
    const offenders = SCREENS.filter((file) => {
      if (PENDING.has(rel(file))) return false;
      const source = readFileSync(file, 'utf8');
      return /Select an athlete(…|\.\.\.)|Choose an athlete(…|\.\.\.)|<option value="">Select an athlete</.test(source);
    });
    expect(offenders.map(rel)).toEqual([]);
  });
});

describe('dates through the gym-time helpers (UXB-30)', () => {
  test.each([
    'app/coach/intervention-executions/page.tsx',
    'app/coach/intervention-protocols/page.tsx',
    'app/coach/intervention-review/page.tsx',
    'app/coach/session-scripts/page.tsx',
  ])('%s prints no sliced ISO date', (file) => {
    const source = readFileSync(path.join(WEB, file), 'utf8');
    expect(source).not.toMatch(/\{[\w.]*(created_at|delivered_on)\.slice\(0, 10\)\}/);
    expect(source).not.toMatch(/\? run\.delivered_on\.slice\(0, 10\) :/);
  });

  test('the credentials page defaults to the gym\'s day, not the UTC day', () => {
    const source = readFileSync(path.join(WEB, 'app/admin/credentials/page.tsx'), 'utf8');
    expect(source).toMatch(/const today = \(\) => gymDayIso\(/);
  });
});

describe('readiness is never colour alone (UXB-29, Law 3)', () => {
  test('the roster dot carries its words beside it, not in a hover title', () => {
    const source = readFileSync(path.join(WEB, 'components/CoachWorkspace.tsx'), 'utf8');
    expect(source).not.toMatch(/title=\{athlete\.readiness === 'UNKNOWN'/);
    expect(source).toMatch(/\{readinessWords\(athlete\.readiness\)\}/);
  });
});

describe('builder words are gone from coach screens (UXB-31)', () => {
  test.each([
    ['components/SessionScriptLiveDelivery.tsx', /frozen plan|Pinned at version/],
    ['components/CoachWorkspace.tsx', /Elapsed \(server clock\)|SHADOW read models|\} RED, \{|Unable to load SHADOW \$\{failed\}/],
    ['app/coach/intervention-executions/page.tsx', /frozen plan/],
    ['app/coach/video-analysis/page.tsx', /\$\{p\.model_deployment\}/],
    ['app/teach-shadow/page.tsx', /Reading the corpus/],
  ])('%s', (file, builder) => {
    expect(readFileSync(path.join(WEB, file), 'utf8')).not.toMatch(builder);
  });
});
