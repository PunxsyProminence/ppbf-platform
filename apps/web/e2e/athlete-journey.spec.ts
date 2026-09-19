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

/* Work issued against a drill in the gym's library (W-D4B). drill_id -- the
   operational version the coach assigned -- is what makes it openable; the
   dose and the due date are what the athlete must still be able to see once
   they have opened it. */
const LINKED_ASSIGNMENT = {
  assignment_id: 'asg-2',
  drill_id: 'drl-op-7',
  gap_id: GAP.gap_id,
  drill_name: 'Slip-and-return shadow rounds',
  drill_description: 'Slip the jab, come straight back to guard, reset your feet.',
  drill_difficulty: 'foundational',
  rep_count: 20,
  duration_minutes: 15,
  frequency_per_week: 3,
  due_date: '2026-09-26',
  completion_percentage: 40,
  status: 'in_progress',
  created_at: '2026-09-12T10:00:00.000Z',
};

const INSTRUCTION_ROUTE = '/api/pilot/progression/drill-instruction';

/* What that route answers an athlete: the athlete-safe projection, with NO
   drill_id key. The reference detail's own drill_id is the reference pointer,
   and the server drops it (withoutReferencePointer), so the page has to open
   the drill without it. A name for who set the work, never an account id. */
const LINKED_INSTRUCTION = {
  assignment_id: LINKED_ASSIGNMENT.assignment_id,
  assigned_by: 'Coach J Rivera',
  state: 'available',
  audience: 'athlete',
  drill: {
    name: LINKED_ASSIGNMENT.drill_name,
    purpose: 'Make the slip and the return to guard one movement, not two.',
    setup: 'Open floor, in front of a mirror if there is one free.',
    equipment_needed: 'None',
    execution: 'Slip outside an imagined jab.\n\nBring both hands straight back to the chin.\n\nReset your feet before the next one.',
    contact_level: 'none',
    requires_coach_authorization: false,
    cues: ['Hands home first', 'Chin behind the shoulder'],
    what_good_looks_like: 'Hands back at the chin before the feet settle.',
    what_bad_looks_like: 'Rear hand drifting down to the ribs after the slip.',
    common_errors: '',
    corrections: '',
    scale_levels: [],
    stop_rules: [
      { ordinal: 1, condition_text: 'Stop if you feel dizzy or your neck hurts when you slip.', scope: 'universal', rule_kind: 'safety' },
    ],
  },
};

/* Reads the page makes with POST because the route only exports POST: the
   session gate (see e2e/support/signIn.ts) and the rabbit-hole lesson read.
   Neither writes, and neither is the opener's -- anything else that is not a
   GET is. */
const KNOWN_READ_POSTS: ReadonlySet<string> = new Set(['/api/pilot/auth/session', '/api/pilot/rabbit-holes/get']);

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

  /* OPENING THE DRILL FROM THE WORK, AND COMING BACK TO IT (W-D4B).
     Owner decision 2026-09-19: reading a drill's instruction does not complete
     work, log performance or move progression. The route test proves the
     server has no write verb; what only a browser can prove is that the PAGE
     sends nothing but a read when a kid taps "Open drill", keeps the
     assignment in front of them while they read, offers no way to log from
     inside the drill, and puts them back on the same piece of work when they
     are done -- where Log completion still does exactly what it did. */
  test('opens the drill from their assigned work, reads it without logging anything, and comes back', async ({ page }) => {
    const logged: Array<Record<string, unknown>> = [];

    await installPilotApi(page, {
      session: { role: 'athlete', athleteId: ATHLETE_ID },
      routes: {
        '/api/pilot/progression/gaps': { ok: true, items: [GAP] },
        // The legacy row rides along to prove the opener is per assignment: a
        // row written before drills had identity has nothing to open.
        '/api/pilot/progression/assignments': { ok: true, items: [LINKED_ASSIGNMENT, ASSIGNMENT] },
        [INSTRUCTION_ROUTE]: LINKED_INSTRUCTION,
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

    const assignmentsHeading = page.getByRole('heading', { name: 'Drill Assignments' });
    const opener = page.getByRole('button', { name: `Open drill: ${LINKED_ASSIGNMENT.drill_name}`, exact: true });
    await expect(assignmentsHeading).toBeVisible();
    await expect(opener).toBeVisible();
    await expect(page.getByRole('button', { name: `Open drill: ${ASSIGNMENT.drill_name}` })).toHaveCount(0);

    /* Recorded from here, after the list has settled: the list only renders
       once its completions reads are done, so everything captured below is
       the opener's, or Back's, or the log's. */
    const sent: Array<{ method: string; path: string; search: string }> = [];
    page.on('request', (request) => {
      const url = new URL(request.url());
      if (url.pathname.startsWith('/api/pilot/')) {
        sent.push({ method: request.method(), path: url.pathname, search: url.search });
      }
    });
    const writes = () => sent.filter((r) => r.method !== 'GET' && !KNOWN_READ_POSTS.has(r.path));

    await opener.click();

    // The list steps aside -- hidden, not unmounted -- and nothing on it,
    // Log completion included, is reachable while the drill is open.
    await expect(assignmentsHeading).toBeHidden();
    await expect(page.getByRole('button', { name: 'Log completion' })).toHaveCount(0);

    /* THE ASSIGNMENT STAYS IN FRONT OF THEM. Named by the drill it is for,
       and it is where focus lands: the athlete opened a piece of work, not a
       library page. */
    const context = page.getByRole('region', { name: LINKED_ASSIGNMENT.drill_name, exact: true });
    await expect(context).toBeVisible();
    await expect(context).toBeFocused();
    await expect(context.getByText('Your assignment', { exact: true })).toBeVisible();
    // The coach's own words for this work, under its name, so the opened view
    // is never emptier than the card it came from. Asked of the context, not
    // the page: the same words are still in the hidden list behind it.
    await expect(context.getByText(LINKED_ASSIGNMENT.drill_description, { exact: true })).toBeVisible();
    const term = (label: string) =>
      context
        .locator('div', { has: page.getByRole('term').filter({ hasText: new RegExp(`^${label}$`) }) })
        .getByRole('definition');
    // Always drawn: "Your coach" until the read lands, then the name it carried.
    await expect(term('From')).toHaveText('Coach J Rivera');
    await expect(term('Due')).toHaveText('Sep 26, 2026');
    await expect(term('Reps')).toHaveText('20');
    await expect(term('Duration')).toHaveText('15 min');
    await expect(term('Frequency')).toHaveText('3x/week');
    await expect(term('Progress')).toHaveText('40% · in progress');
    await expect(
      context.getByText(
        'Reading the drill does not log your work. When you have done it, go back to your assigned work and use Log completion.',
      ),
    ).toBeVisible();

    // The drill itself, safety first and open.
    const drill = page.getByRole('article', { name: LINKED_ASSIGNMENT.drill_name, exact: true });
    await expect(drill).toBeVisible();
    await expect(drill.getByRole('heading', { level: 2, name: LINKED_ASSIGNMENT.drill_name, exact: true })).toBeVisible();
    const safety = drill.getByRole('region', { name: 'Safety', exact: true });
    await expect(safety).toBeVisible();
    await expect(safety).toContainText('Contact: No contact');
    await expect(safety).toContainText(LINKED_INSTRUCTION.drill.stop_rules[0].condition_text);

    /* LEARNING IS NOT LOGGING. Opening sent exactly one request: a GET keyed
       by the assignment, carrying nothing else -- no drill id the page could
       have swapped for a newer version. Nothing else went out, and above all
       nothing to completions, the one route that records work. */
    await expect.poll(() => sent.filter((r) => r.path === INSTRUCTION_ROUTE)).toHaveLength(1);
    expect(sent.filter((r) => r.path === INSTRUCTION_ROUTE)).toEqual([
      { method: 'GET', path: INSTRUCTION_ROUTE, search: `?assignment_id=${LINKED_ASSIGNMENT.assignment_id}` },
    ]);
    expect(writes()).toEqual([]);
    expect(sent.filter((r) => r.path === '/api/pilot/progression/completions')).toEqual([]);

    // And nothing inside the opened drill could record work either, or carries
    // the provenance a coach reads.
    await expect(drill.locator('form, input, textarea, select')).toHaveCount(0);
    await expect(drill.getByText(/Source and version|Content status/)).toHaveCount(0);

    // A name, never a raw staff identifier, on a minor's screen.
    await expect(page.getByText(/acct-/)).toHaveCount(0);

    /* BACK TO THE SAME PIECE OF WORK. Focus returns to the button that opened
       it, so a keyboard or screen-reader user is where they left off. */
    await page.getByRole('button', { name: 'Back to your assigned work' }).click();
    await expect(opener).toBeFocused();
    await expect(assignmentsHeading).toBeVisible();
    await expect(page.getByRole('article')).toHaveCount(0);
    expect(writes()).toEqual([]);
    expect(sent.filter((r) => r.path === '/api/pilot/progression/completions')).toEqual([]);

    /* ...and logging is where it always was, doing exactly what it did. Two
       cards, two Log completion buttons: this one is the linked card's. */
    const linkedCard = page
      .locator('div.mat-leather')
      .filter({ has: page.getByRole('heading', { level: 3, name: LINKED_ASSIGNMENT.drill_name, exact: true }) });
    await linkedCard.getByRole('button', { name: 'Log completion' }).click();
    await page.getByLabel('Reps completed (optional)').fill('20');
    await page.getByLabel('Notes (optional)').fill('Read the drill first, then did the rounds.');
    await page.getByRole('button', { name: 'Save log' }).click();

    await expect.poll(() => logged).toHaveLength(1);
    expect(logged[0]).toEqual({
      assignment_id: LINKED_ASSIGNMENT.assignment_id,
      athlete_id: ATHLETE_ID,
      reps_completed: 20,
      notes: 'Read the drill first, then did the rounds.',
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

  /* THE PLAN THEIR COACH WROTE, READ IN A REAL BROWSER.
     Owner decision 2026-08-28: everything, verbatim, including the
     nutrition_body_composition domain. The route test proves the payload and
     the page test proves the rendering; neither can catch what a boxer at a
     tablet actually hits -- so this drives the real app and checks the two
     things that would matter to them: their coach's words are there, and
     nothing on the screen grades them for it. */
  test('reads the plan their coach wrote, whole, with nothing scoring them', async ({ page }) => {
    await installPilotApi(page, {
      session: { role: 'athlete', athleteId: ATHLETE_ID },
      routes: {
        '/api/pilot/athlete/development-blocks': (url) => {
          // The athlete never names a subject: the route takes it from the
          // session, and this page must not be sending one.
          expect(url.searchParams.get('athlete_id')).toBeNull();
          return {
            ok: true,
            blocks: [{
              block_id: 'blk-1',
              title: 'Winter technical block',
              training_emphasis: 'Stop backing straight up when the pressure comes.',
              starts_on: '2026-09-01',
              ends_on: '2026-10-13',
              status: 'active',
              created_by_name: 'Coach J Rivera',
              objectives: [
                {
                  objective_id: 'obj-1',
                  domain: 'technical',
                  objective: 'Jab off the back foot, not just off the front.',
                  status: 'active',
                },
                {
                  objective_id: 'obj-2',
                  domain: 'nutrition_body_composition',
                  objective: 'Eat a real breakfast before morning conditioning.',
                  status: 'completed',
                },
              ],
            }],
          };
        },
      },
    });

    await page.goto('/athlete/development-blocks');

    await expect(page.getByRole('heading', { level: 1, name: 'Your Plan' })).toBeVisible();
    await expect(page.getByText('Winter technical block')).toBeVisible();
    await expect(page.getByText('Stop backing straight up when the pressure comes.')).toBeVisible();

    // Both domains, under human labels rather than stored slugs. The tenth is
    // shown like any other -- that was the decision.
    await expect(page.getByText('Jab off the back foot, not just off the front.')).toBeVisible();
    await expect(page.getByText('Eat a real breakfast before morning conditioning.')).toBeVisible();
    await expect(page.getByText('Nutrition & body composition')).toBeVisible();
    await expect(page.getByText('nutrition_body_composition')).toHaveCount(0);

    /* NOTHING GRADES THEM. One objective of two is 'completed', which is
       exactly the state a roll-up would render as "1 of 2" or "50%". Neither
       appears, and no progress element exists to carry one. */
    await expect(page.getByText(/\b1\s*(of|\/)\s*2\b/)).toHaveCount(0);
    await expect(page.getByText(/\d+\s*%/)).toHaveCount(0);
    await expect(page.locator('progress, meter, [role="progressbar"]')).toHaveCount(0);

    /* WHO TO GO AND ASK. Owner decision 2026-08-28: the coach is named to the
       family. A NAME, though -- the route sends no account id at all, and a
       raw staff identifier on a minor's screen is what that projection
       exists to prevent. */
    await expect(page.getByText('Written by Coach J Rivera')).toBeVisible();
    await expect(page.getByText(/acct-/)).toHaveCount(0);

    // And no control: reading is not writing, on a page with no write verb
    // behind it.
    await expect(page.locator('form, select, textarea')).toHaveCount(0);
  });
});
