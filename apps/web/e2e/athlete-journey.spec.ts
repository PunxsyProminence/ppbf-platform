import { expect, test, type Page, type Request } from '@playwright/test';
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

  /* ARRIVING FROM THE FLOOR (A-FIN-04). The athlete's Floor lists their open
     coach work and links here for the two things it does not do itself --
     read the drill, log the work -- so there is one opener and one log form.
     The page tests pin the logic; what only a browser can prove is that the
     real router hands the page its query string, the named work opens in
     front of the athlete, and arriving writes nothing. */
  test('lands on the work a Floor link names, and writes nothing by arriving', async ({ page }) => {
    const logged: Array<Record<string, unknown>> = [];

    await installPilotApi(page, {
      session: { role: 'athlete', athleteId: ATHLETE_ID },
      routes: {
        '/api/pilot/progression/gaps': { ok: true, items: [GAP] },
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

    const sent: Array<{ method: string; path: string; search: string }> = [];
    page.on('request', (request) => {
      const url = new URL(request.url());
      if (url.pathname.startsWith('/api/pilot/')) {
        sent.push({ method: request.method(), path: url.pathname, search: url.search });
      }
    });
    const completionWrites = () => sent.filter((r) => r.path === '/api/pilot/progression/completions' && r.method !== 'GET');

    // "Open drill" on the Floor: the drill opens, under its assignment, from one read.
    await page.goto(`/athlete/progression-intelligence?assignment=${LINKED_ASSIGNMENT.assignment_id}&intent=instruction`);
    await expect(page.getByRole('article', { name: LINKED_ASSIGNMENT.drill_name, exact: true })).toBeVisible();
    await expect(page.getByRole('region', { name: LINKED_ASSIGNMENT.drill_name, exact: true })).toBeFocused();
    await expect.poll(() => sent.filter((r) => r.path === INSTRUCTION_ROUTE)).toHaveLength(1);
    expect(sent.filter((r) => r.path === INSTRUCTION_ROUTE)[0]).toEqual({
      method: 'GET',
      path: INSTRUCTION_ROUTE,
      search: `?assignment_id=${LINKED_ASSIGNMENT.assignment_id}`,
    });
    expect(completionWrites()).toEqual([]);

    // "Log completion" on the Floor: that card's own form, open and focused, nothing sent yet.
    await page.goto(`/athlete/progression-intelligence?assignment=${ASSIGNMENT.assignment_id}&intent=log`);
    const reps = page.getByLabel('Reps completed (optional)');
    await expect(reps).toBeVisible();
    await expect(reps).toBeFocused();
    await expect(page.getByRole('article')).toHaveCount(0);
    expect(completionWrites()).toEqual([]);
    expect(logged).toEqual([]);

    // An id that is not in this athlete's own list opens nothing, and goes nowhere.
    await page.goto('/athlete/progression-intelligence?assignment=asg-not-yours&intent=log');
    await expect(page.getByRole('heading', { name: 'Drill Assignments' })).toBeVisible();
    await expect(page.getByRole('button', { name: `Open drill: ${LINKED_ASSIGNMENT.drill_name}`, exact: true })).toBeVisible();
    await expect(page.getByLabel('Reps completed (optional)')).toHaveCount(0);
    await expect(page.getByRole('article')).toHaveCount(0);
    expect(sent.some((r) => r.search.includes('asg-not-yours'))).toBe(false);
    expect(completionWrites()).toEqual([]);
    expect(logged).toEqual([]);
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

/* A-FIN-10 -- THE SESSION LIFECYCLE, IN A REAL BROWSER.
   ------------------------------------------------------------------------

   WHAT THIS LAYER OWNS, AND THE ONE THING IT MUST NOT CLAIM. A-FIN-01,
   A-FIN-05 and A-FIN-08 put a publication contract on the athlete's session
   note: the box is a private draft, only a deliberate act publishes or
   withdraws it, and check-out replays what was SHARED rather than what is in
   the box. Every one of those rules is currently proven by jsdom and by route
   tests. Neither runs a browser, so neither can fail if the contract breaks
   in the real event loop -- a restored autosave timer, a check-out that reads
   the textarea, a clear that publishes itself.

   These tests drive the real component in a real browser and assert on the
   WIRE: which request fires, how many, and with what body. That is the whole
   claim. A stubbed browser e2e proves NOTHING about Postgres persistence,
   about server authorization, or about staging behaviour; the `.pg` suites,
   the route tests and the 2026-09-26 authenticated staging run cover those,
   separately and by name.

   WHY THIS ONE NEEDS A DATABASE WHEN THE REST OF THIS FILE DOES NOT.
   AthleteWorkspace is mounted on exactly one route -- app/athlete/dashboard
   -- and that page calls requirePageRole(['athlete']), which resolves the
   session cookie against Postgres INSIDE the Next server. A browser-level
   stub cannot reach it, which is the limit stated at the top of this file.
   So the session lifecycle cannot be driven anywhere else, and these tests
   sign in for real: the login POST is deliberately NOT stubbed, only the
   three session endpoints are, so the cookie the server issues is the
   genuine article and the page renders as an athlete's.

   Run it against the offline runtime, which is a real embedded Postgres with
   the full schema, synthetic personas and no route to production:

     npm --workspace web run offline -- --reset --port 3100

   and then point the suite AT it. The three variables are not optional
   here: the runtime binds 127.0.0.1, so a run left on the default host
   reproduces the exact failure PPBF_E2E_HOST exists to fix. In PowerShell
   (Windows), which has no inline assignment:

     $env:PPBF_E2E_HOST='127.0.0.1'; $env:PPBF_E2E_PORT='3100'
     $env:PPBF_E2E_REUSE_EXISTING_SERVER='1'
     npm --workspace web run test:e2e:athlete

   In a POSIX shell:

     PPBF_E2E_HOST=127.0.0.1 PPBF_E2E_PORT=3100 \n       PPBF_E2E_REUSE_EXISTING_SERVER=1 \n       npm --workspace web run test:e2e:athlete

   PPBF_E2E_REQUIRE_ATHLETE_DB is deliberately NOT set there: local runs
   are the optional-runtime mode, and only a step that started a runtime
   may promise one is present.

   With no database present the sign-in cannot mint a session, /athlete/
   dashboard answers 307 -> /login, and each test below SKIPS with that reason
   attached to the run rather than passing on an empty page. The proofs are
   written in full and run unchanged wherever a database is -- the same shape
   golden-era-scope-proofs.spec.ts uses for `.ge-locker`, which is the same
   route and the same limit. */

/** The offline runtime's synthetic athlete persona, documented in
    docs/OFFLINE_RUNTIME.md. Not a credential: it exists only inside a local
    embedded Postgres that the launcher creates, and the launcher's network
    guard rejects every non-loopback socket. */
const OFFLINE_ATHLETE_ACCOUNT = 'offline-athlete';
const OFFLINE_ATHLETE_PIN = '246810';
/** The athlete RECORD that account resolves to, which is a different
    identifier and the one every session row carries -- `offline-runtime.mjs`
    seeds the pair explicitly (`['offline-athlete', 'athlete',
    'offline-athlete-record']`). Writing the account id into a synthetic
    session would build payloads the real /sessions/update could never
    accept, and a stub would take them anyway. */
const OFFLINE_ATHLETE_ID = 'offline-athlete-record';

const SESSION_CREATE = '/api/pilot/sessions';
const SESSION_UPDATE = '/api/pilot/sessions/update';
const SESSION_LIST = '/api/pilot/sessions/list';

/** Restated rather than imported from src/shared/sessionNoteSemantics.ts, for
    the reason ROLE_DESTINATION is restated in support/signIn.ts: a test that
    imports the app's own constant agrees with the code by construction, and
    would keep passing if the sentinel changed under it. */
const NO_ATHLETE_NOTE = 'No athlete note provided at check-in.';

/** The interval the note box used to autosave on, before A-FIN-08 made
    publication deliberate. Waited PAST, not up to: the property under test is
    that nothing is sent BECAUSE time passed, so the window has to close with
    the test still watching. */
const HISTORICAL_AUTOSAVE_MS = 1200;
const PAST_THE_AUTOSAVE_WINDOW_MS = HISTORICAL_AUTOSAVE_MS * 2 + 600;

const SERVER_GUARDED_SKIP =
  '/athlete/dashboard resolves its role inside the Next server (requirePageRole -> resolvePrincipal '
  + '-> Postgres), so with no database present it answers 307 -> /login and the athlete workspace '
  + 'never renders. The proof in this test is complete and runs unchanged against the offline '
  + 'runtime (docs/OFFLINE_RUNTIME.md) or any environment with a database.';

interface SessionWrite {
  readonly path: string;
  readonly body: Record<string, unknown>;
}

interface RecorderOptions {
  /** Rows GET /sessions/list answers with before this test writes anything. */
  readonly initialRows?: Record<string, unknown>[];
  /** Refuse every POST /sessions/update, to prove the screen does not lie
      about what reached the coach. */
  readonly refuseUpdates?: boolean;
}

/**
 * Holds the three session endpoints still and records what the browser sent.
 *
 * Only those three. /api/pilot/auth/login and /api/pilot/auth/session are
 * deliberately left alone so the session cookie is minted by the real server
 * -- a stub there would put the page back behind the guard it cannot pass.
 * Everything else on the surface answers from the real offline database,
 * which is also why nothing here asserts on it.
 */
async function recordSessionWrites(
  page: Page,
  options: RecorderOptions = {},
): Promise<SessionWrite[]> {
  const writes: SessionWrite[] = [];
  const rows: Record<string, unknown>[] = [...(options.initialRows ?? [])];

  const json = (body: unknown, status = 200) => ({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });

  await page.route('**/api/pilot/sessions**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();

    if (path === SESSION_LIST && method === 'GET') {
      await route.fulfill(json({ items: rows }));
      return;
    }

    if (path === SESSION_CREATE && method === 'POST') {
      const body = JSON.parse(request.postData() ?? '{}') as Record<string, unknown>;
      writes.push({ path, body });
      rows.push({ ...body });
      await route.fulfill(json({ ok: true, session_id: body.session_id }));
      return;
    }

    if (path === SESSION_UPDATE && method === 'POST') {
      const body = JSON.parse(request.postData() ?? '{}') as Record<string, unknown>;
      writes.push({ path, body });
      if (options.refuseUpdates) {
        await route.fulfill(json({ error: 'refused by the test' }, 500));
        return;
      }
      const index = rows.findIndex((row) => row.session_id === body.session_id);
      if (index >= 0) rows[index] = { ...rows[index], ...body };
      await route.fulfill(json({ ok: true }));
      return;
    }

    await route.continue();
  });

  return writes;
}

/** An open session as /sessions/list returns one, created just now so that the
    gym-day reduction in loadStoredSessions selects it as today's. */
function openSessionRow(notes: string) {
  const now = new Date();
  return {
    session_id: 'session_e2e_open',
    athlete_id: OFFLINE_ATHLETE_ID,
    date: now.toISOString().slice(0, 10),
    rpe: null,
    rpe_method: 'UNKNOWN',
    notes,
    completed_flag: false,
    created_at: now.toISOString(),
  };
}

/**
 * The athlete's real door, then the workspace.
 *
 * Returns false when the sign-in does not land on /athlete/dashboard, which in
 * practice means no database: every caller turns that into a skip with the
 * reason attached rather than asserting against a login form.
 */
/** What the real POST /api/pilot/auth/login did, which is the only thing that
    can tell an ABSENT backend apart from a REFUSING one. */
interface LoginAttempt {
  /** The request never reached a server at all. */
  readonly transportFailed: boolean;
  readonly status: number | null;
  readonly body: string;
}

/**
 * The athlete's real door, then the workspace.
 *
 * Returns false ONLY where the missing server/database prerequisite is
 * positively identified. Everything else raises.
 */
async function openAthleteWorkspace(page: Page): Promise<boolean> {
  await page.goto('/athlete/sign-in');
  await page.getByLabel(/Athlete Account ID/i).fill(OFFLINE_ATHLETE_ACCOUNT);
  await page.getByLabel(/^PIN/i).fill(OFFLINE_ATHLETE_PIN);

  /* Armed BEFORE the click, because a response cannot be waited for after it
     has already arrived. A transport failure is recorded separately: it
     produces no response at all, and it is the strongest evidence there is
     that nothing was listening. */
  const attempt: { transportFailed: boolean } = { transportFailed: false };
  const onFailed = (request: Request) => {
    if (new URL(request.url()).pathname === LOGIN_ROUTE) attempt.transportFailed = true;
  };
  page.on('requestfailed', onFailed);
  const pendingLogin = page
    .waitForResponse((response) => new URL(response.url()).pathname === LOGIN_ROUTE, { timeout: 25000 })
    .catch(() => null);

  await page.getByRole('button', { name: /Sign In/i }).click();
  const response = await pendingLogin;
  const login: LoginAttempt = {
    transportFailed: attempt.transportFailed,
    status: response ? response.status() : null,
    body: response ? await response.text().catch(() => '') : '',
  };
  page.off('requestfailed', onFailed);

  /* A MISSING DATABASE MUST BE RECOGNISED, NEVER INFERRED FROM FAILURE.
     Two earlier shapes of this were both too broad. Catching every navigation
     timeout reported a broken door as an absent one; then reading any sign-in
     alert did the same thing more quietly, because SignInPanel shows that one
     alert for a wrong PIN, a rate limit, a lost session and a server fault
     alike. So the decision is made on the login RESPONSE, which is the only
     evidence that distinguishes them. */
  if (login.transportFailed) return false;
  if (isMissingBackendBody(login.body)) return false;

  if (login.status !== null && login.status !== 200) {
    throw new Error(
      'the athlete door refused the synthetic sign-in for a reason that is NOT a missing database, '
      + `so this is a finding rather than a skip. status=${login.status} body=${login.body.slice(0, 300)}`,
    );
  }

  /* The login itself succeeded, so the remaining question is only whether the
     page guard can resolve the cookie it set. */
  const deadline = Date.now() + 25000;
  for (;;) {
    const path = new URL(page.url()).pathname;
    if (path === '/athlete/dashboard') return true;
    // requirePageRole could not resolve the session it was just handed, which
    // is the documented no-database behaviour of a SERVER_GUARDED_ROUTE.
    if (path === '/login') return false;
    if (Date.now() > deadline) {
      const body = (await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 300);
      throw new Error(
        'the login succeeded but the browser reached neither the workspace nor the server guard. '
        + `url=${page.url()} body=${body}`,
      );
    }
    await page.waitForTimeout(250);
  }
}

/** The backend is ABSENT, as opposed to present and refusing. Matched on the
    shapes this stack actually produces, both observed rather than assumed:

      * the unset connection string, which is what a checkout with no
        .env.local and no offline runtime answers -- verified here, and note
        that it arrives as a 400, not a 5xx, so a status-range test would have
        missed it entirely;
      * a connection that could not be made or was dropped, which is what a
        configured-but-unreachable database answers.

    Deliberately NOT matched: a wrong PIN, a rate limit, a lost session, or any
    other refusal. Those mean the door is there and said no, which is a finding
    about the application, never a reason to skip a proof. */
function isMissingBackendBody(body: string): boolean {
  return /Missing required environment variable: AZURE_POSTGRES_CONNECTION_STRING/i.test(body)
    || /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|Connection terminated|connection refused|could not connect|database (is )?(unavailable|unreachable)/i.test(body);
}

/* CI CREATES THE PREREQUISITE, SO CI MAY NOT SKIP.
   Locally the offline runtime is optional, and a missing database is an
   honest skip with the reason attached. In a workflow step that has just
   STARTED one, the same skip would report green for ten proofs that never
   ran -- which is the exact failure a gate exists to prevent, and worse than
   having no gate because it looks like coverage. PPBF_E2E_REQUIRE_ATHLETE_DB
   turns that condition into a failure, and the step that sets it is the step
   that owns the runtime. */
const ATHLETE_DB_REQUIRED = process.env.PPBF_E2E_REQUIRE_ATHLETE_DB === '1';

async function enterWorkspaceOrSkip(page: Page): Promise<void> {
  if (await openAthleteWorkspace(page)) return;
  if (ATHLETE_DB_REQUIRED) {
    throw new Error(
      'PPBF_E2E_REQUIRE_ATHLETE_DB=1 declares that a database was provided for this run, but the '
      + 'athlete workspace did not render. ' + SERVER_GUARDED_SKIP,
    );
  }
  test.skip(true, SERVER_GUARDED_SKIP);
}

const createsIn = (writes: SessionWrite[]) => writes.filter((write) => write.path === SESSION_CREATE);
const updatesIn = (writes: SessionWrite[]) => writes.filter((write) => write.path === SESSION_UPDATE);

test.describe('A-FIN-10 the session lifecycle on the wire', () => {
  // Which contract this run is under, said out loud, so a green summary can
  // never be read as ten executed proofs when it was ten skips.
  test.beforeAll(() => {
    console.log(ATHLETE_DB_REQUIRED
      ? '[A-FIN-10] PPBF_E2E_REQUIRE_ATHLETE_DB=1 -- these proofs MUST execute; an absent database fails the run.'
      : '[A-FIN-10] no database declared for this run -- these proofs skip, with the reason attached, if one is absent.');
  });

  test('opening the workspace starts no session', async ({ page }) => {
    const writes = await recordSessionWrites(page);
    await enterWorkspaceOrSkip(page);

    await expect(page.getByText('You are not checked in right now.')).toBeVisible();
    /* Waited out rather than read on arrival: a create fired by a mount effect
       would land after the first paint, so an assertion taken immediately
       would pass whether or not one was coming. */
    await page.waitForTimeout(PAST_THE_AUTOSAVE_WINDOW_MS);

    expect(createsIn(writes), 'merely loading the workspace must not create a session').toHaveLength(0);
    expect(updatesIn(writes), 'merely loading the workspace must not write a session').toHaveLength(0);
  });

  test('check-in creates one session and sends the sentinel, never the draft', async ({ page }) => {
    const writes = await recordSessionWrites(page);
    await enterWorkspaceOrSkip(page);

    const draft = 'my left wrist is sore from Tuesday';
    await page.locator('#pre-check-in-note').fill(draft);
    await page.getByRole('button', { name: 'Start check-in' }).first().click();

    /* Check-in deliberately moves the athlete off the Session Log -- to
       Wellness when today's wellness is missing, to the Floor when it is not
       -- so the confirmation is read where it is shown and the Session Log is
       returned to for the rest. Asserted loosely on purpose: which of the two
       lines appears is a property of the wellness gate, not of check-in. */
    await expect(page.getByText(/You are checked in\./)).toBeVisible();
    await page.getByRole('button', { name: 'Dashboard', exact: true }).first().click();
    await expect(page.getByText(/Session active since/)).toBeVisible();

    const creates = createsIn(writes);
    expect(creates, 'check-in is exactly one session create').toHaveLength(1);
    expect(creates[0].body.notes, 'check-in stores the sentinel, not the athlete draft').toBe(NO_ATHLETE_NOTE);
    expect(creates[0].body.notes).not.toBe(draft);
    expect(creates[0].body.rpe, 'the session has not happened, so there is no effort to rate').toBeNull();
    expect(creates[0].body.rpe_method).toBe('UNKNOWN');
    expect(creates[0].body.completed_flag).toBe(false);
    /* The ATHLETE RECORD, not the account that signed in. The client reads it
       off the real session response, so this is the one identifier in the
       payload that the stub did not supply. */
    expect(creates[0].body.athlete_id, 'the create names the seeded athlete record').toBe(OFFLINE_ATHLETE_ID);

    // The draft survives check-in as a draft, and the screen says so.
    await expect(page.getByLabel('Session notes for your coach')).toHaveValue(draft);
    await expect(page.getByText('Only you can see this until you share it.')).toBeVisible();
    expect(updatesIn(writes), 'checking in must not publish the draft afterwards either').toHaveLength(0);
  });

  test('typing does not publish after the interval it used to autosave on', async ({ page }) => {
    const writes = await recordSessionWrites(page, { initialRows: [openSessionRow(NO_ATHLETE_NOTE)] });
    await enterWorkspaceOrSkip(page);

    const box = page.getByLabel('Session notes for your coach');
    await expect(box).toBeVisible();
    await box.fill('thinking out loud, not finished');
    await page.waitForTimeout(PAST_THE_AUTOSAVE_WINDOW_MS);

    expect(updatesIn(writes), 'time passing is not a decision to publish').toHaveLength(0);
    await expect(page.getByText('Only you can see this until you share it.')).toBeVisible();
  });

  test('Share with coach sends exactly one update carrying the note', async ({ page }) => {
    const row = openSessionRow(NO_ATHLETE_NOTE);
    const writes = await recordSessionWrites(page, { initialRows: [row] });
    await enterWorkspaceOrSkip(page);

    const note = 'my left wrist is sore from Tuesday';
    await page.getByLabel('Session notes for your coach').fill(note);
    await page.getByRole('button', { name: 'Share with coach' }).click();
    await expect(page.getByText('Your coach can read this.')).toBeVisible();

    const updates = updatesIn(writes);
    expect(updates, 'sharing is one write').toHaveLength(1);
    expect(updates[0].body.notes).toBe(note);
    expect(updates[0].body.completed_flag, 'sharing a note does not close the session').toBe(false);
    /* Replayed, not fabricated: /sessions/update replaces the whole record, so
       a field this write invents is a field it destroys. */
    expect(updates[0].body.session_id).toBe(row.session_id);
    expect(updates[0].body.athlete_id, 'a payload the real route could accept').toBe(OFFLINE_ATHLETE_ID);
    expect(updates[0].body.date).toBe(row.date);
    expect(updates[0].body.created_at).toBe(row.created_at);
    expect(updates[0].body.rpe, 'an open session has no effort rating yet').toBeNull();
    expect(updates[0].body.rpe_method).toBe('UNKNOWN');
  });

  test('editing after a share does not send the changed draft', async ({ page }) => {
    const writes = await recordSessionWrites(page, { initialRows: [openSessionRow(NO_ATHLETE_NOTE)] });
    await enterWorkspaceOrSkip(page);

    const box = page.getByLabel('Session notes for your coach');
    await box.fill('wrist is sore');
    await page.getByRole('button', { name: 'Share with coach' }).click();
    await expect(page.getByText('Your coach can read this.')).toBeVisible();

    await box.fill('wrist is sore and my shoulder too');
    await page.waitForTimeout(PAST_THE_AUTOSAVE_WINDOW_MS);

    expect(updatesIn(writes), 'a second thought is not a second publication').toHaveLength(1);
    await expect(
      page.getByText('Your coach can still read what you shared before. This change is not shared yet.'),
    ).toBeVisible();
  });

  test('clearing the box is not a withdrawal, and Withdraw is', async ({ page }) => {
    const writes = await recordSessionWrites(page, { initialRows: [openSessionRow(NO_ATHLETE_NOTE)] });
    await enterWorkspaceOrSkip(page);

    const box = page.getByLabel('Session notes for your coach');
    await box.fill('wrist is sore');
    await page.getByRole('button', { name: 'Share with coach' }).click();
    await expect(page.getByText('Your coach can read this.')).toBeVisible();

    await box.fill('');
    await page.waitForTimeout(PAST_THE_AUTOSAVE_WINDOW_MS);
    expect(updatesIn(writes), 'a stray backspace must not erase what a coach can already read').toHaveLength(1);

    await page.getByRole('button', { name: 'Withdraw from coach' }).click();
    await expect(page.getByText('Only you can see this until you share it.')).toBeVisible();

    const updates = updatesIn(writes);
    expect(updates, 'withdrawal is the second write, and a deliberate one').toHaveLength(2);
    expect(updates[1].body.notes, 'withdrawal stores the no-note sentinel, not an empty string').toBe(NO_ATHLETE_NOTE);
    expect(updates[1].body.athlete_id).toBe(OFFLINE_ATHLETE_ID);
    expect(updates[1].body.completed_flag).toBe(false);
  });

  test('check-out sends an answered effort as the athlete self-report', async ({ page }) => {
    const writes = await recordSessionWrites(page, { initialRows: [openSessionRow(NO_ATHLETE_NOTE)] });
    await enterWorkspaceOrSkip(page);

    await page.getByLabel('How hard was the session you just finished? 7').click();
    await page.getByRole('button', { name: 'Check Out' }).click();
    await expect(page.getByText('You are not checked in right now.')).toBeVisible();

    const updates = updatesIn(writes);
    expect(updates, 'check-out is one write').toHaveLength(1);
    expect(updates[0].body.completed_flag).toBe(true);
    expect(updates[0].body.rpe).toBe(7);
    expect(updates[0].body.rpe_method).toBe('athlete_post_session_self_report');
    expect(updates[0].body.athlete_id).toBe(OFFLINE_ATHLETE_ID);
  });

  test('check-out leaves an unanswered effort unrecorded rather than defaulting it', async ({ page }) => {
    const writes = await recordSessionWrites(page, { initialRows: [openSessionRow(NO_ATHLETE_NOTE)] });
    await enterWorkspaceOrSkip(page);

    await page.getByRole('button', { name: 'Check Out' }).click();
    await expect(page.getByText('You are not checked in right now.')).toBeVisible();

    const updates = updatesIn(writes);
    expect(updates).toHaveLength(1);
    expect(updates[0].body.rpe, 'skipping the question is not an answer of any number').toBeNull();
    expect(updates[0].body.rpe_method).toBe('UNKNOWN');
  });

  test('check-out preserves the last shared note and never publishes the open draft', async ({ page }) => {
    const writes = await recordSessionWrites(page, { initialRows: [openSessionRow(NO_ATHLETE_NOTE)] });
    await enterWorkspaceOrSkip(page);

    const shared = 'wrist is sore';
    const unsent = 'and something I decided not to send';

    const box = page.getByLabel('Session notes for your coach');
    await box.fill(shared);
    await page.getByRole('button', { name: 'Share with coach' }).click();
    await expect(page.getByText('Your coach can read this.')).toBeVisible();

    await box.fill(unsent);
    await page.getByRole('button', { name: 'Check Out' }).click();
    await expect(page.getByText('You are not checked in right now.')).toBeVisible();

    const updates = updatesIn(writes);
    expect(updates, 'the share, then the check-out -- nothing in between').toHaveLength(2);
    expect(updates[1].body.completed_flag).toBe(true);
    expect(updates[1].body.notes, 'check-out replays what was SHARED').toBe(shared);
    expect(updates[1].body.notes, 'checking out must not publish an unsent draft').not.toBe(unsent);
    expect(updates[1].body.athlete_id).toBe(OFFLINE_ATHLETE_ID);
  });

  test('a refused publication does not let the screen claim it reached the coach', async ({ page }) => {
    const writes = await recordSessionWrites(page, {
      initialRows: [openSessionRow(NO_ATHLETE_NOTE)],
      refuseUpdates: true,
    });
    await enterWorkspaceOrSkip(page);

    await page.getByLabel('Session notes for your coach').fill('wrist is sore');
    await page.getByRole('button', { name: 'Share with coach' }).click();

    await expect(page.getByText('That did not reach your coach -- try again.')).toBeVisible();
    await expect(page.getByText('Your coach can read this.')).toHaveCount(0);
    await expect(page.getByText('Only you can see this until you share it.')).toBeVisible();
    expect(updatesIn(writes), 'the write was attempted once, and refused once').toHaveLength(1);
  });
});
