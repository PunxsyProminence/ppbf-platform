import { expect, test } from '@playwright/test';
import { installPilotApi, signInAtTheAthleteDoor, LOGIN_ROUTE } from './support/signIn';

/* An athlete, from the tablet by the door to the work their coach set.
   ------------------------------------------------------------------------

   WHAT THIS LAYER OWNS. The `.pg` suites prove the tables and the route tests
   prove the contracts. Neither can catch what a child standing at a shared
   gym tablet actually hits: a field that will not take the PIN, a sign-in
   that reports success and goes nowhere, a heading no one can read. This spec
   stubs the pilot API at the network boundary and drives the real browser
   against the real app, so the form, the routing and the rendering are all
   the genuine article.

   THE ATHLETE'S DOOR IS ITS OWN DOOR, AND THAT IS A SAFETY BOUNDARY.
   /athlete/sign-in takes an Account ID and a six-digit PIN, and PIN sessions
   are athlete-only by design (credentialPolicy.usesPin, and
   resolveAuthoritativeRoleSession's `privileged_auth_required`). No identity
   provider is involved, so unlike the coach and guardian journeys this one is
   the WHOLE journey -- every step below is the step an athlete takes.

   ONE LIMIT, STATED PLAINLY. /athlete/dashboard resolves its role on the
   SERVER (`requirePageRole` -> resolvePrincipal -> Postgres). With no
   database here it answers 307 -> /login for everybody, stub or not, because
   a browser-level stub cannot reach a check that runs inside the Next server.
   So the "reaches their own work" leg below is proven on
   /athlete/progression-intelligence, the client-gated athlete surface that
   carries the assigned drills and the athlete's own log. See
   SERVER_GUARDED_ROUTES in e2e/support/signIn.ts. */

const ATHLETE_ID = 'ath-rosa';
const ACCOUNT_ID = 'athlete-account-0042';
const PIN = '481902';

const GAP = {
  gap_id: 'gap-1',
  athlete_id: ATHLETE_ID,
  gap_type: 'guard_recovery',
  gap_description: 'Guard drops after the third punch of a combination.',
  severity: 'medium',
  status: 'assigned',
  created_at: '2026-08-18T10:00:00.000Z',
};

const ASSIGNMENT = {
  assignment_id: 'asg-1',
  gap_id: GAP.gap_id,
  drill_name: 'Return-to-guard shadow rounds',
  drill_description: 'Three rounds, hands back to the chin after every combination.',
  drill_difficulty: 'foundational',
  rep_count: 30,
  completion_percentage: 0,
  status: 'assigned',
  created_at: '2026-08-18T10:00:00.000Z',
};

test.describe('Athlete journey', () => {
  test('signs in at their own door with an Account ID and a PIN', async ({ page }) => {
    const loginAttempts: Array<Record<string, unknown>> = [];

    await signInAtTheAthleteDoor(page, {
      accountId: ACCOUNT_ID,
      pin: PIN,
      // Every athlete account is issued a PIN by the gym and must change it on
      // first use, so this -- not a workspace -- is the first thing an athlete
      // ever sees after signing in. It is a valid session, not a refusal, and
      // bouncing it to /login would loop forever.
      session: { role: 'athlete', athleteId: ATHLETE_ID, mustChangePin: true },
      routes: {
        [LOGIN_ROUTE]: (_url, route) => {
          loginAttempts.push(JSON.parse(route.request().postData() ?? '{}'));
          return { ok: true, role: 'athlete', athlete_id: ATHLETE_ID };
        },
      },
    });

    // What the athlete typed is what left the browser. The API tests own what
    // the server does with it; this owns that the form collected it at all.
    await expect.poll(() => loginAttempts).toHaveLength(1);
    expect(loginAttempts[0]).toEqual({ account_id: ACCOUNT_ID, pin: PIN });

    // And the app took them to the one page the server still allows them.
    await expect(page).toHaveURL(/\/change-pin$/);
  });

  test('reaches the work their coach set, and logs having done it', async ({ page }) => {
    const logged: Array<Record<string, unknown>> = [];

    await installPilotApi(page, {
      session: { role: 'athlete', athleteId: ATHLETE_ID },
      routes: {
        '/api/pilot/progression/gaps': { ok: true, items: [GAP] },
        '/api/pilot/progression/assignments': { ok: true, items: [ASSIGNMENT] },
        '/api/pilot/progression/completions': (_url, route) => {
          if (route.request().method() === 'POST') {
            logged.push(JSON.parse(route.request().postData() ?? '{}'));
            return { ok: true };
          }
          return { ok: true, items: [] };
        },
      },
    });

    await page.goto('/athlete/progression-intelligence');

    await expect(page.getByRole('heading', { name: 'Your Progression' })).toBeVisible();

    // The gate resolved -- an athlete must never be left looking at the
    // holding screen, and must never see the "sign in again" alert on a
    // session the gate itself just accepted.
    await expect(page.getByRole('heading', { name: 'Checking access' })).toHaveCount(0);
    await expect(page.getByText('Unable to resolve athlete session. Sign in again.')).toHaveCount(0);

    // The drill their coach assigned, and the gap it was assigned for. This
    // is the whole reason an athlete opens this page.
    const drill = page.getByRole('heading', { name: ASSIGNMENT.drill_name });
    await expect(drill).toBeVisible();
    await expect(page.getByText(ASSIGNMENT.drill_description)).toBeVisible();

    // The gap it was assigned FOR, in the words the coach recorded. A drill
    // with no reason attached is homework; a drill with the gap attached is
    // coaching, and this page's whole claim is the second one.
    await expect(page.getByRole('heading', { name: 'guard recovery' })).toBeVisible();
    await expect(page.getByText(GAP.gap_description)).toBeVisible();

    // "...and somewhere to say when you have done it."
    await page.getByRole('button', { name: 'Log completion' }).click();
    await page.getByLabel('Reps completed (optional)').fill('30');
    await page.getByLabel('Notes (optional)').fill('Hands came back every round.');
    await page.getByRole('button', { name: 'Save log' }).click();

    await expect.poll(() => logged).toHaveLength(1);
    expect(logged[0]).toEqual({
      assignment_id: ASSIGNMENT.assignment_id,
      athlete_id: ATHLETE_ID,
      reps_completed: 30,
      notes: 'Hands came back every round.',
    });
  });

  test('the athlete door refuses an account that is not an athlete', async ({ page }) => {
    /* PIN sessions are athlete-only, and this page enforces it on the client
       as well as the server. It matters in a browser because the refusal has
       to be VISIBLE: a door that silently declines to move is the same
       experience as a door that is broken. */
    await signInAtTheAthleteDoor(page, {
      accountId: 'coach-account-0001',
      pin: PIN,
      session: { role: 'coach' },
      loginResponse: { ok: true, role: 'coach' },
    });

    /* Filtered rather than taken whole: Next mounts an empty
       aria-live route announcer with role="alert" on every page, so a bare
       getByRole('alert') is always ambiguous in this app. Asking for the
       alert that carries the refusal keeps both halves of the claim -- the
       words are there, and they are announced as an alert. */
    const refusal = page.getByRole('alert').filter({ hasText: 'This sign-in page is for athlete accounts only.' });
    await expect(refusal).toBeVisible();
    await expect(page).toHaveURL(/\/athlete\/sign-in$/);
  });

  /* The sparring log gained a "which athlete is this for" picker so that a
     coach could use a surface that already admitted them and could not
     actually be used. The boxer's own path must be exactly as it was: they
     are the subject, there is nothing to choose, and no control appears
     asking them to choose it. */
  test('logs their own sparring session with no athlete to choose', async ({ page }) => {
    await installPilotApi(page, { session: { role: 'athlete', athleteId: ATHLETE_ID } });

    await page.goto('/athlete/dashboard/sparring');

    await expect(page.getByRole('heading', { level: 1, name: 'Sparring Log' })).toBeVisible();
    await expect(page.getByText('Your Corner')).toBeVisible();
    await expect(page.getByLabel('Which athlete is this for')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Log This Session' })).toBeEnabled();
  });
});
