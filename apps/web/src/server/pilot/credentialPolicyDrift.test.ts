import fs from 'node:fs';
import path from 'node:path';

// Drift guard for the credential policy, in the same shape as
// gymTimeDrift.test.ts and migrationDispatchCoverage.test.ts.
//
// The rule "who signs in with what" lived in five places and they disagreed:
// the server admitted only athletes to PIN sign-in while app/login/page.tsx
// opened a PIN form for everyone, so coaches and parents met a door that could
// not let them in and an error blaming their credential for it.
//
// credentialPolicy.ts is now the only place allowed to answer that question.
// This test fails the build if an auth path starts deciding for itself again.

const PILOT_DIR = path.resolve(__dirname);
const APP_DIR = path.resolve(__dirname, '../../../app');

/**
 * The authentication surface: code that mints a session, validates one, or
 * chooses which credential to ask a user for.
 *
 * Scoped deliberately. Comparing a role against 'athlete' is normal and correct
 * in AUTHORIZATION code -- "an athlete may only check themselves in" appears
 * legitimately in scheduler/route.ts, video/list, and the schedule page, and
 * none of those decide how anyone signs in. A guard that swept the whole tree
 * would demand they consult a credential policy, which is nonsense.
 *
 * The question this guards is narrower: who is allowed THROUGH THE DOOR, and
 * which door are they shown. Only these files answer it.
 */
const AUTH_SURFACE = [
  path.join(PILOT_DIR, 'auth.ts'),
  path.join(APP_DIR, 'login', 'page.tsx'),
  path.join(APP_DIR, 'athlete', 'sign-in', 'page.tsx'),
  path.join(APP_DIR, 'api', 'pilot', 'auth', 'login', 'route.ts'),
  path.join(APP_DIR, 'api', 'pilot', 'auth', 'session', 'route.ts'),
  path.join(APP_DIR, 'api', 'pilot', 'auth', 'activate', 'route.ts'),
];

/**
 * Comparing a role against 'athlete' is how the old copies each restated the
 * PIN rule. Authorization checks ("may this person see X") legitimately compare
 * roles all over the codebase, so this looks only for the authentication
 * question -- an equality test against the athlete literal.
 */
const ATHLETE_ROLE_COMPARISON = /\brole\s*(?:!==|===|!=|==)\s*['"]athlete['"]|['"]athlete['"]\s*(?:!==|===|!=|==)\s*\w*[Rr]ole\b/;

/**
 * Files permitted to compare a role against 'athlete'.
 *
 * credentialPolicy.ts     -- the single source of truth; this IS the decision
 * credentialPolicy.test.ts -- asserts the decision
 * this file               -- contains the pattern as a string literal
 *
 * Adding to this list means accepting a second copy of the rule. Do not,
 * without a reason written down here.
 */
const ALLOWED = new Set([
  'credentialPolicy.ts',
  'credentialPolicy.test.ts',
  'credentialPolicyDrift.test.ts',
]);

describe('the credential policy is the only place that decides how someone signs in', () => {
  test('the scan is not vacuous -- every guarded file exists and was read', () => {
    // A drift guard pointed at files that have moved passes forever while
    // checking nothing. gymTimeDrift learned this the hard way, and a stale
    // path here would silently un-guard the login page.
    for (const file of AUTH_SURFACE) {
      expect(fs.existsSync(file)).toBe(true);
      expect(fs.readFileSync(file, 'utf8').length).toBeGreaterThan(0);
    }
    expect(AUTH_SURFACE.length).toBeGreaterThanOrEqual(6);
  });

  test('the guard would catch a violation if one existed', () => {
    // Proves the regex matches the shape it is meant to catch, so a passing
    // suite means "no violations" rather than "the pattern never matches".
    expect(ATHLETE_ROLE_COMPARISON.test("if (data.role !== 'athlete') {")).toBe(true);
    expect(ATHLETE_ROLE_COMPARISON.test("row.role === 'athlete'")).toBe(true);
    // And that it does not fire on ordinary authorization code.
    expect(ATHLETE_ROLE_COMPARISON.test("if (role === 'coach') return true;")).toBe(false);
    expect(ATHLETE_ROLE_COMPARISON.test("roles.includes('athlete')")).toBe(false);
  });

  test('nothing on the authentication surface restates the athlete-only PIN rule', () => {
    const violations: string[] = [];

    for (const file of AUTH_SURFACE) {
      if (ALLOWED.has(path.basename(file))) continue;
      const source = fs.readFileSync(file, 'utf8');
      source.split(/\r\n?|\n/).forEach((line, index) => {
        if (line.trimStart().startsWith('//') || line.trimStart().startsWith('*')) return;
        if (ATHLETE_ROLE_COMPARISON.test(line)) {
          violations.push(`${path.relative(APP_DIR, file)}:${index + 1}  ${line.trim()}`);
        }
      });
    }

    expect(violations).toEqual([]);
  });

  test('auth.ts asks the policy rather than answering itself', () => {
    const source = fs.readFileSync(path.join(PILOT_DIR, 'auth.ts'), 'utf8');
    expect(source).toContain("from './credentialPolicy'");
    expect(source).toContain('usesPin(');
  });
});
