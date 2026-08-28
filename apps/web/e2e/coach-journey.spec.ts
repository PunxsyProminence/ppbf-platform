import { expect, test } from '@playwright/test';
import { installPilotApi, signInAtTheBell } from './support/signIn';

/* A coach, signed in, from the Bell to the decision they came to make.
   ------------------------------------------------------------------------

   WHAT THIS LAYER OWNS. The database under this is already proven by the
   `.pg` suites and the API contracts by the route tests. Neither of them can
   fail the way a browser fails: a heading rendered dark-on-dark, a gate that
   never resolves, a control pushed off screen, a page that hydrates into
   nothing. This spec stubs the pilot API at the network boundary and drives
   the real Chromium against the real Next app, so everything above the fetch
   -- routing, RoleSessionGate, hydration, layout, the accessible names a
   coach navigates by -- is genuine.

   The Microsoft half of sign-in belongs to an identity provider and is not
   simulated. What is driven here is the half the browser owns and the half
   that broke in production: SignInPanel asks who is holding the cookie and
   routes on the answer. See e2e/support/signIn.ts. */

const ROSA = { athlete_id: 'ath-rosa', full_name: 'Rosa Delgado' };

const PROVISIONAL_RECOMMENDATION = {
  recommendation_id: 'rec-1',
  athlete_id: ROSA.athlete_id,
  recommendation_text: 'Reduce sparring volume to two rounds this week.',
  expected_outcome: 'Headache reports stop within seven days.',
  status: 'provisional',
  created_by_account_id: 'shadow',
  created_at: '2026-08-18T10:00:00.000Z',
  expires_at: '2026-08-25T10:00:00.000Z',
  decided_by_account_id: null,
  decided_at: null,
};

test.describe('Coach journey', () => {
  test('signs in and lands in the coach workspace', async ({ page }) => {
    await signInAtTheBell(page, {
      session: { role: 'coach' },
      routes: { '/api/pilot/athletes/list': { ok: true, items: [ROSA] } },
    });

    // Arrived at the coach's own destination, not somebody else's and not
    // back at the login form.
    await expect(page).toHaveURL(/\/coach\/environment\/intake-router$/);

    // The thing a coach opens this page for. Asserted by role and accessible
    // name rather than by class, because this codebase restyles constantly
    // and a journey test that dies on a restyle is worse than no test.
    //
    // The masthead used to read 'Live Session Management' on all ten tabs.
    // It names the open surface now (approved board AF-09), so the coach
    // landing's heading is the tab it opens on; the workspace's own name
    // moved to the line under it, which this checks too.
    await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible();
    await expect(page.getByText('Coach workspace · Live session management')).toBeVisible();

    // The two live safety reads a coach scans first. Their presence is the
    // point; their contents belong to the API tests.
    await expect(page.getByRole('heading', { name: 'Athlete Pain Reports' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Safety Escalations' })).toBeVisible();

    // A signed-in surface must never be showing the gate's holding screen by
    // the time the coach is looking at it.
    await expect(page.getByRole('heading', { name: 'Checking access' })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Unable to verify access' })).toHaveCount(0);
  });

  /* The hub's account of what the platform can do, in a real browser.
     ----------------------------------------------------------------

     The workspace used to tell a coach that live session tracking was not
     built, that there was no scheduling feed, and that video upload was a
     front-end placeholder -- while pilot.session_script_runs, the scheduler
     and /api/pilot/video/* were all serving. The Jest suite pins the copy;
     these two pin that the copy is driven by what the routes actually answer,
     through hydration and the session gate, which is the layer that decides
     whether a coach ever sees it. */
  test('a session already in progress is on the coach hub, with the way back to it', async ({ page }) => {
    await signInAtTheBell(page, {
      session: { role: 'coach' },
      routes: {
        '/api/pilot/athletes/list': { ok: true, items: [ROSA] },
        // The route's real shape: { run } for the caller's own live delivery,
        // with the elapsed count computed on the server.
        '/api/pilot/session-scripts/runs': {
          run: {
            run_id: 'run-1',
            script_id: 'scr-1',
            script_version: 2,
            delivered_by_account_id: 'acct-coach',
            delivered_on: '2026-08-28',
            athletes_present: 9,
            run_state: 'in_progress',
            started_at: '2026-08-28T22:00:00.000Z',
            ended_at: null,
            current_block_id: 'blk-2',
            paused_at: null,
            paused_seconds: 0,
            elapsed_seconds: 1530,
            is_paused: false,
          },
        },
      },
    });

    // Twice on purpose, and both are checked: the KPI summary sentence and the
    // Today's Session panel. A coach who reads either must not be told the
    // opposite by the other.
    await expect(page.getByText('Session in progress -- running 25m 30s.')).toBeVisible();
    // 1530 server-side seconds, rendered as the panel's own elapsed field. Not
    // a figure this page counted.
    await expect(page.getByText('25m 30s', { exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Return to live delivery' }).first())
      .toHaveAttribute('href', '/coach/session-scripts');

    // The sentence that used to sit here regardless of the answer.
    await expect(page.getByText(/Live session tracking is not built/i)).toHaveCount(0);
  });

  test('with nothing running, the hub says so -- and still does not deny the capability', async ({ page }) => {
    await signInAtTheBell(page, {
      session: { role: 'coach' },
      routes: {
        '/api/pilot/athletes/list': { ok: true, items: [ROSA] },
        // { run: null } is the route's success shape for an idle coach.
        '/api/pilot/session-scripts/runs': { run: null },
      },
    });

    await expect(page.getByText('No session in progress.', { exact: true })).toBeVisible();
    await expect(page.getByText(/Live session tracking is not built/i)).toHaveCount(0);
    await expect(page.getByText(/There is no scheduling backend feed/i)).toHaveCount(0);
  });

  test('reaches the decision loop and records a decision on a provisional recommendation', async ({ page }) => {
    const decided: Array<Record<string, unknown>> = [];

    await installPilotApi(page, {
      session: { role: 'coach' },
      routes: {
        '/api/pilot/athletes/list': { ok: true, items: [ROSA] },
        '/api/pilot/shadow/medical-status': { ok: true, status: null },
        '/api/pilot/shadow/recommendations': { ok: true, recommendations: [PROVISIONAL_RECOMMENDATION] },
        '/api/pilot/shadow/decisions': { ok: true, decisions: [] },
        '/api/pilot/shadow/near-misses': { ok: true, nearMisses: [] },
        '/api/pilot/shadow/recommendations/decide': (_url, route) => {
          decided.push(JSON.parse(route.request().postData() ?? '{}'));
          return { ok: true };
        },
      },
    });

    await page.goto('/coach/decision-loop');
    await expect(page.getByRole('heading', { name: 'SHADOW Decision Loop' })).toBeVisible();

    // Nothing is shown until a coach names an athlete -- the loop is per
    // athlete, and this page says so rather than defaulting to somebody.
    await expect(page.getByText('Select or enter an athlete to review their decision loop.')).toBeVisible();

    await page.getByRole('combobox', { name: 'Athlete' }).selectOption(ROSA.athlete_id);

    // The recommendation is on screen, and it is on screen as PROVISIONAL.
    // That word is the whole contract of this surface: silence never equals
    // acceptance, so a provisional recommendation must arrive with a human
    // decision still outstanding.
    /* Scoped to the recommendation's own card rather than to the page. The
       page also carries a "link to recommendation" <select> whose options
       repeat this text, so a page-wide getByText matches twice -- and, more
       to the point, a badge or a button found anywhere on the page is not
       evidence that it belongs to THIS recommendation. */
    const card = page.getByRole('article').filter({ hasText: PROVISIONAL_RECOMMENDATION.recommendation_text });
    await expect(card).toBeVisible();
    await expect(card.getByText('provisional')).toBeVisible();

    // ...and with both human decisions offered on that same card. A page that
    // showed the recommendation but not the two controls would be an advisory
    // the coach cannot answer.
    const accept = card.getByRole('button', { name: 'Accept' });
    const reject = card.getByRole('button', { name: 'Reject' });
    await expect(accept).toBeVisible();
    await expect(reject).toBeVisible();

    await accept.click();

    // The decision left the browser attributed to this recommendation. The
    // route tests own what the server then does with it.
    await expect.poll(() => decided).toHaveLength(1);
    expect(decided[0]).toEqual({
      athleteId: ROSA.athlete_id,
      recommendationId: PROVISIONAL_RECOMMENDATION.recommendation_id,
      decision: 'accepted',
    });
  });

  /* OPERATIONS V1 acceptance points 24 and 25, in a browser.
     ------------------------------------------------------------------------
     The route test proves the server hands back the issued/skipped split and
     the .pg suite proves the rows are really written, one per authorized
     active member, under one issuance_id. Neither can fail the way this can:
     a report rendered but not painted, a skipped list dropped from the DOM,
     a coach reading "Issued to Junior Boxing" and reasonably concluding all
     three members got the card. The honesty of a group card is a VISUAL
     property of this page, so it is asserted here. */
  test('issues a card to a whole program and shows who did not get it', async ({ page }) => {
    const issued: Array<Record<string, unknown>> = [];

    await installPilotApi(page, {
      session: { role: 'coach' },
      routes: {
        '/api/pilot/athletes/list': { ok: true, items: [ROSA] },
        '/api/pilot/drills': { ok: true, items: [] },
        '/api/pilot/admin/programs': {
          ok: true,
          items: [
            { program_id: 'prog-1', program_name: 'Junior Boxing', status: 'active', active_member_count: 3 },
            // Archived programs keep their history and are not offered new
            // work; if this one ever appears in the picker, the form is
            // offering work to a group that no longer trains.
            { program_id: 'prog-2', program_name: 'Old Guard', status: 'archived', active_member_count: 0 },
          ],
        },
        '/api/pilot/coach/cards': (_url, route) => {
          if (route.request().method() !== 'POST') {
            return { items: [] };
          }
          issued.push(JSON.parse(route.request().postData() ?? '{}'));
          return {
            program_id: 'prog-1',
            program_name: 'Junior Boxing',
            issuance_id: 'issuance-1',
            issued: [
              { athlete_id: 'ath-rosa', athlete_name: 'Rosa Delgado', assignment_id: 'asg-1' },
              { athlete_id: 'ath-cora', athlete_name: 'Cora Vance', assignment_id: 'asg-2' },
            ],
            skipped: [{ athlete_id: 'ath-bela', athlete_name: 'Bela Ortiz' }],
          };
        },
      },
    });

    await page.goto('/coach/cards');
    await expect(page.getByRole('heading', { name: 'Issue a Card' })).toBeVisible();

    // The form opens on the individual card. Reaching a program is a
    // deliberate act -- issuing to eleven people must not be one stray click
    // away from issuing to one.
    await expect(page.getByRole('button', { name: 'One athlete' })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByLabel('Program')).toHaveCount(0);

    await page.getByRole('button', { name: 'Whole program' }).click();
    const programPicker = page.getByLabel('Program');
    await expect(programPicker).toBeVisible();
    await expect(programPicker.getByRole('option', { name: /Old Guard/ })).toHaveCount(0);

    await programPicker.selectOption('prog-1');
    await page.getByLabel('Title').fill('Jump rope');
    await page.getByLabel('Description').fill('Ten minutes, no misses');
    await page.getByRole('button', { name: 'Issue to program' }).click();

    // What left the browser: the program, never a list of athletes the client
    // assembled for itself. Who is in the group is the server's answer.
    await expect.poll(() => issued).toHaveLength(1);
    expect(issued[0]).toMatchObject({ program_id: 'prog-1', title: 'Jump rope' });
    expect(issued[0]).not.toHaveProperty('athlete_id');

    const report = page.getByRole('region', { name: 'Issuance report' });
    await expect(report).toBeVisible();
    await expect(report.getByRole('heading', { name: 'Issued to Junior Boxing' })).toBeVisible();
    // The count and BOTH lists. A page that showed only the two who got the
    // card would be telling the coach the program is covered.
    await expect(report.getByText('2 issued, 1 skipped.')).toBeVisible();
    await expect(report.getByText('Rosa Delgado')).toBeVisible();
    await expect(report.getByText('Cora Vance')).toBeVisible();
    await expect(report.getByText('Bela Ortiz')).toBeVisible();
    await expect(report.getByText(/Skipped/)).toBeVisible();
  });

  /* WHAT THE BLOCK IS PREPARING FOR, IN A REAL BROWSER.
     ------------------------------------------------

     Module 036's Open Question 2, answered (a): a block may optionally name an
     existing competition or league event, "as a target date only (name and
     date, nothing else)".

     The unit suites pin the wiring. What only a browser shows is the thing
     this slice is most likely to get wrong: a date on screen invites a
     countdown, and a countdown invites a taper. Neither competition table
     holds anything either could honestly be built from, so the rendered page
     must carry neither. */
  test('a coach names the show a block is preparing for, and gets a date rather than a taper', async ({ page }) => {
    const patched: Array<Record<string, unknown>> = [];
    const KEYSTONE = {
      kind: 'competition',
      id: 'comp-1',
      name: 'Keystone Open',
      date: '2026-11-14',
      location: 'Altoona, PA',
      sanctioning_body: 'USA Boxing',
      status: 'planned',
    };
    let target: Record<string, unknown> | null = null;

    await installPilotApi(page, {
      session: { role: 'coach' },
      routes: {
        '/api/pilot/coach/athletes': { ok: true, items: [ROSA] },
        '/api/pilot/coach/development-blocks': (url, route) => {
          if (route.request().method() === 'PATCH') {
            const body = JSON.parse(route.request().postData() ?? '{}') as Record<string, unknown>;
            patched.push(body);
            target = body.target ? KEYSTONE : null;
            return { ok: true, block: {} };
          }
          if (url.searchParams.get('targets') === 'options') {
            return { ok: true, options: [KEYSTONE] };
          }
          return {
            ok: true,
            blocks: [{
              block_id: 'blk-1',
              athlete_id: ROSA.athlete_id,
              title: 'Winter technical block',
              training_emphasis: 'Guard recovery off the jab.',
              starts_on: '2026-09-01',
              ends_on: '2026-11-13',
              status: 'active',
              target_competition_id: target ? 'comp-1' : null,
              target_wrestling_event_id: null,
              target,
              created_by_account_id: 'acct-coach',
              created_at: '2026-08-28T00:00:00.000Z',
              updated_at: '2026-08-28T00:00:00.000Z',
            }],
          };
        },
      },
    });

    await page.goto('/coach/development-blocks');
    await page.getByLabel('Which athlete').selectOption(ROSA.athlete_id);

    // Before: a block that is a date range of its own.
    await expect(page.getByText('No event named. This block is a date range of its own.')).toBeVisible();

    await page.getByLabel('Change what this block is preparing for').selectOption('competition:comp-1');

    await expect.poll(() => patched).toHaveLength(1);
    expect(patched[0]).toEqual({ block_id: 'blk-1', target: { kind: 'competition', id: 'comp-1' } });

    /* After: the five things the order asks a coach to be shown. Scoped to
       the "Preparing for" panel, because the picker below it carries the same
       name and date in an <option> -- asserting on the page as a whole would
       pass on the dropdown alone, which is not the block saying anything. */
    await expect(page.getByText('Keystone Open', { exact: true })).toBeVisible();
    // The detail line, whole: kind, date, place, body, in one string a coach
    // reads at a glance. Asserted as one locator because the picker below
    // carries the same name and date in an <option>, and a looser match would
    // pass on the dropdown alone -- which is not the block saying anything.
    await expect(page.getByText('Competition · November 14, 2026 · Altoona, PA · USA Boxing')).toBeVisible();

    /* AND NOTHING INFERRED FROM IT. No countdown, no weeks-out figure, no
       peak week, no taper. The block ends the day before the show and the
       page still says nothing about what to do with that. */
    const body = (await page.locator('body').textContent()) ?? '';
    expect(body).not.toMatch(/\d+%/);
    expect(body).not.toMatch(/weeks out|peak week|taper|workload|ACWR|fatigue|injury risk|weight cut/i);
    await expect(page.locator('progress')).toHaveCount(0);
    await expect(page.locator('[role="progressbar"]')).toHaveCount(0);
  });

  test('a cancelled show stays named on the block, and says it was cancelled', async ({ page }) => {
    // A dropped link is indistinguishable from a target never chosen, and a
    // coach who cannot tell will plan around a show that is not happening.
    await installPilotApi(page, {
      session: { role: 'coach' },
      routes: {
        '/api/pilot/coach/athletes': { ok: true, items: [ROSA] },
        '/api/pilot/coach/development-blocks': (url) => {
          if (url.searchParams.get('targets') === 'options') return { ok: true, options: [] };
          return {
            ok: true,
            blocks: [{
              block_id: 'blk-1',
              athlete_id: ROSA.athlete_id,
              title: 'Winter technical block',
              training_emphasis: 'Guard recovery off the jab.',
              starts_on: '2026-09-01',
              ends_on: '2026-11-13',
              status: 'active',
              target_competition_id: 'comp-1',
              target_wrestling_event_id: null,
              target: {
                kind: 'competition',
                id: 'comp-1',
                name: 'Keystone Open',
                date: '2026-11-14',
                location: 'Altoona, PA',
                sanctioning_body: 'USA Boxing',
                status: 'cancelled',
              },
              created_by_account_id: 'acct-coach',
              created_at: '2026-08-28T00:00:00.000Z',
              updated_at: '2026-08-28T00:00:00.000Z',
            }],
          };
        },
      },
    });

    await page.goto('/coach/development-blocks');
    await page.getByLabel('Which athlete').selectOption(ROSA.athlete_id);

    await expect(page.getByText('Keystone Open', { exact: true })).toBeVisible();
    await expect(page.getByText(/This event was cancelled/)).toBeVisible();
  });

  /* A RED FLAG ABOUT A CHILD, ON WHATEVER SCREEN THE COACH IS ALREADY ON.
     -------------------------------------------------------------------

     /api/pilot/escalations is a pull surface by construction; its own header
     records that this platform sends no email, ever. So an unacknowledged
     high or critical escalation waited for a coach to choose to open the
     escalation inbox. The count now rides the session bar, which is the one
     component mounted on every route.

     This is asserted in a real browser, on a route that has nothing to do
     with safety, because that is the entire claim: not that the badge can
     render, but that a coach cannot get through a session without passing it. */
  test('an unacknowledged critical escalation follows the coach onto every surface', async ({ page }) => {
    await installPilotApi(page, {
      session: { role: 'coach' },
      routes: {
        '/api/pilot/escalations': {
          ok: true,
          escalations: [
            {
              escalation_id: 'esc-1',
              source_type: 'near_miss',
              athlete_id: ROSA.athlete_id,
              severity: 'critical',
              reason: 'Headache reported after contact rounds, twice this week.',
              status: 'open',
              escalated_to_role: 'coach',
              created_at: '2026-08-27T22:00:00.000Z',
            },
          ],
        },
      },
    });

    // The drill library: about as far from a safety surface as a coach gets.
    await page.goto('/coach/drills');

    const badge = page.getByRole('link', { name: /Safety escalations needing acknowledgement/i });
    await expect(badge).toBeVisible();
    await expect(badge).toHaveAttribute('href', '/admin/escalations');
    await expect(page.getByText('Safety 1 critical')).toBeVisible();

    /* A COUNT, AND NOTHING ABOUT THE CHILD. This bar is on every screen in
       the building, including whichever one happens to be facing the room. */
    await expect(page.getByText(ROSA.athlete_id)).toHaveCount(0);
    await expect(page.getByText('Headache reported after contact rounds')).toHaveCount(0);
  });

  test('a coach with nothing flagged carries no safety chip at all', async ({ page }) => {
    // Silence means none. A permanent "0 open" chip on every screen is how a
    // person stops seeing this row.
    await installPilotApi(page, {
      session: { role: 'coach' },
      routes: { '/api/pilot/escalations': { ok: true, escalations: [] } },
    });

    await page.goto('/coach/drills');

    await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
    await expect(page.getByText(/^Safety/)).toHaveCount(0);
  });

  /* THE OPERATIONS HUB IS ADMINISTRATION NOW (owner decision, 2026-08-26).

     Both halves have to be one test. Narrowing the hub's gate and accidentally
     narrowing the coach's own floor look identical from the passing side of a
     refusal-only assertion, and the floor is the thing a coach actually came
     for. So this refuses them the hub, checks every chassis surface that used
     to offer it, and then walks the work they keep. */
  test('a coach is refused the Operations hub and keeps every surface of their own', async ({ page }) => {
    await installPilotApi(page, { session: { role: 'coach' } });

    /* 1. THE REFUSAL, AND NO HUB CONTENT ON THE WAY OUT. Absence is asserted
          BEFORE the URL settles, the ordering public-homepage.spec uses.

          Be honest about what that buys: toHaveCount(0) auto-retries and
          returns on its FIRST satisfied poll, so this samples an instant, not
          an interval -- it cannot prove no frame ever painted the hub. What
          rules a flash out is structural, and it is asserted where it can be:
          RoleSessionGate returns its holding screen from the same render and
          only reaches its children once accessState is 'authorized', so a
          refused role never mounts them at all. app/operations/page.test.tsx
          proves that against the real gate by showing the children's own
          effects never fire. This line is the browser-level corroboration of
          it, not the proof itself. */
    await page.goto('/operations');
    await expect(page.getByRole('heading', { name: 'The Ring' })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'WORKSPACES' })).toHaveCount(0);
    await expect(page).toHaveURL(/\/coach\/environment\/intake-router$/);

    /* 2. NO OPERATIONS CONTROL ON THE CHASSIS. The session bar mounts on every
          route, so one signed-in surface proves it for all of them -- and the
          bar itself must still be there, which is the half that catches a
          removal that took its neighbours with it. */
    await expect(page.getByRole('link', { name: 'Operations' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Bell' }).first()).toBeVisible();

    /* 3. NOT IN THE CATALOG, however plainly a coach asks for it. The door
          carried `roles: OPEN`, and the catalog searches labels, keywords and
          hrefs -- so every name it answered to has to come back empty. */
    await page.keyboard.press('Meta+k');
    const catalog = page.getByRole('dialog');
    const search = catalog.getByRole('combobox');
    for (const query of ['operations', 'mission control', 'hub']) {
      await search.fill(query);
      await expect(catalog.getByText('Operations Hub')).toHaveCount(0);
    }
    /* The path prefix is not the gate: these two carry their own
       ['coach', 'admin'], and after this change the catalog and the corridor
       are a coach's only route to them. */
    await search.fill('wrestling');
    /* The OPTION, not the label inside it. The option is the unit the catalog
       offers and the thing a finger lands on; the label is one box within it.
       On a phone that inner box measures zero wide -- `.catalog-row-main` is
       `min-width: 0` with no `flex-grow` beside a `flex-shrink: 0` sibling, so
       the href column takes the row and the title overflows a collapsed box.
       That is a real Card Catalog defect on narrow viewports, it predates this
       change, and it is being fixed on its own branch. Asserting the option
       keeps this test about what it is about: the door a coach keeps. */
    await expect(catalog.getByRole('option', { name: /Wrestling League/ })).toBeVisible();
    await page.keyboard.press('Escape');

    /* 4. THE WORK THEY CAME FOR. Client-gated routes only: /coach/review-queue
          and /coach/operations are in SERVER_GUARDED_ROUTES and answer 307 to
          /login in this harness regardless of the session stub, so they would
          fail here for a reason that has nothing to do with this change. */
    for (const path of [
      '/coach/floor-groups',
      '/coach/session-scripts',
      '/coach/drills',
      '/coach/progression-intelligence',
      '/schedule',
    ]) {
      await page.goto(path);
      // Not bounced, and not stuck on the gate's holding screen.
      await expect(page).toHaveURL(new RegExp(`${path.replace(/\//g, '\\/')}$`));
      await expect(page.getByText('Checking access')).toHaveCount(0);
      // And the hub is not offered from any of them either.
      await expect(page.getByRole('link', { name: 'Operations' })).toHaveCount(0);
    }
  });

  /* A coach's multi-week plan for one athlete, written in a real browser.
     -----------------------------------------------------------------

     The persistence foundation shipped with no route and no UI, and its own
     header said so: which staff roles may author a block was left as an owner
     decision. The API answers that with the platform's existing answer
     (assertActorCanAccessAthlete) and this is the surface over it.

     What this asserts beyond the unit suites: the page reaches a coach through
     the real role gate, the picker is the access-contract one, and the plan
     that comes back carries no score, no percentage and no progress bar --
     which is the part a mocked render cannot see going wrong in CSS. */
  test('a coach writes a development block, and it comes back as words rather than numbers', async ({ page }) => {
    const written: Array<Record<string, unknown>> = [];
    const stored: Array<Record<string, unknown>> = [];

    await installPilotApi(page, {
      session: { role: 'coach' },
      routes: {
        '/api/pilot/coach/athletes': { ok: true, items: [ROSA] },
        '/api/pilot/coach/development-blocks': (_url, route) => {
          if (route.request().method() === 'POST') {
            const body = JSON.parse(route.request().postData() ?? '{}') as Record<string, unknown>;
            written.push(body);
            stored.push({
              block_id: 'blk-1',
              athlete_id: body.athlete_id,
              title: body.title,
              training_emphasis: body.training_emphasis,
              starts_on: body.starts_on,
              ends_on: body.ends_on,
              status: body.status,
              created_by_account_id: 'acct-coach',
              created_at: '2026-08-28T00:00:00.000Z',
              updated_at: '2026-08-28T00:00:00.000Z',
            });
            return { ok: true, block: stored[0] };
          }
          return { ok: true, blocks: stored };
        },
      },
    });

    await page.goto('/coach/development-blocks');

    await expect(page.getByRole('heading', { level: 1, name: 'The Next Several Weeks' })).toBeVisible();

    await page.getByLabel('Which athlete').selectOption(ROSA.athlete_id);
    await page.getByLabel('Title').fill('Winter technical block');
    await page.getByLabel('Training emphasis').fill('Guard recovery off the jab.');
    await page.getByLabel('Starts on').fill('2026-09-01');
    await page.getByLabel('Ends on').fill('2026-10-13');
    await page.getByRole('button', { name: 'Save block' }).click();

    // Filed against the athlete the coach chose, attributed by the server.
    await expect.poll(() => written).toHaveLength(1);
    expect(written[0]).toMatchObject({
      athlete_id: ROSA.athlete_id,
      title: 'Winter technical block',
      training_emphasis: 'Guard recovery off the jab.',
    });
    expect(written[0]).not.toHaveProperty('organization_id');
    expect(written[0]).not.toHaveProperty('created_by_account_id');

    // And read back from the server, in the coach's own words.
    await expect(page.getByText('Guard recovery off the jab.')).toBeVisible();

    /* NO INVENTED TRAINING SCIENCE ON THE PAGE. Each of these is named in the
       build order as something this slice must not produce. */
    await expect(page.locator('progress')).toHaveCount(0);
    await expect(page.locator('[role="progressbar"]')).toHaveCount(0);
    const body = (await page.locator('body').textContent()) ?? '';
    expect(body).not.toMatch(/\d+%/);
    expect(body).not.toMatch(/workload|ACWR|fatigue|taper|injury risk/i);
  });

  test('a guardian who opens a coach route is sent to their own hub, not to a login form', async ({ page }) => {
    /* Signed in, just not to this surface. Sending them to /login is the
       defect requirePageRole and BoardRoleGate were both written to end: the
       login page's own effect sees a valid session and forwards them
       straight back, so the visible result is a login form flashing past --
       indistinguishable from having been logged out. */
    await installPilotApi(page, { session: { role: 'parent' } });

    await page.goto('/coach/decision-loop');

    await expect(page).toHaveURL(/\/parent\/dashboard$/);
    await expect(page.getByRole('heading', { name: 'SHADOW Decision Loop' })).toHaveCount(0);
  });
  /* THE CARD CATALOG'S TITLE COLUMN, MEASURED RATHER THAN READ.
     ------------------------------------------------------------------------
     The catalog is how a coach reaches most of this building, and its rows
     had a layout defect no text scan of the stylesheet could have found: the
     metadata column was `flex-shrink: 0` while the title column had no
     `flex-grow`, so on a narrow viewport the route ate the row and the NAME
     was squeezed to nothing. Measured on a Pixel 7 before the fix, at a 393px
     row: "The Work" and "Progression Intelligence" 0px wide, "Community
     Service" 2px, "Intervention Protocols" 10px, "Session Scripts" 54px wide
     by 199px tall -- a title shredded one letter per line, overflowing a box
     of no width. Playwright reported those titles `hidden`, which is how this
     was found at all.

     Asserted over EVERY row the catalog renders, in both viewport projects,
     because the collapse is a function of how long a row's route is and
     picking one row to check is picking which regression to catch. One
     `evaluate` rather than 64 locator round-trips, and it names the offending
     rows so a failure says which doors broke.

     THE TWO LIMITS COME FROM MEASUREMENT, not from taste. Width must be
     non-zero -- that is the hard collapse. Height must stay under 96px --
     that is what catches the 2px and 10px columns, which are non-zero and
     still ruined; a shredded title grows DOWN. After the fix the tallest
     title column measures 53px on the Pixel 7 and 38px on the desktop, and
     before it the same column measured 260px, so 96px sits clear of both. */
  test('every catalog row gives its title a real column, at any viewport', async ({ page }) => {
    await installPilotApi(page, { session: { role: 'coach' } });
    await page.goto('/coach/environment/intake-router');
    await expect(page.getByRole('link', { name: 'Bell' }).first()).toBeVisible();

    await page.keyboard.press('Meta+k');
    const catalog = page.getByRole('dialog');
    // A single letter is the widest net this search offers: it matches most
    // of the building map, so the sweep below runs over real rows and not
    // over three.
    await catalog.getByRole('combobox').fill('a');
    await expect(catalog.getByRole('option').first()).toBeVisible();

    const rows = await page.evaluate(() =>
      Array.from(document.querySelectorAll('li.catalog-row')).map((li) => {
        const box = li.querySelector('.catalog-row-main')?.getBoundingClientRect();
        return {
          label: li.querySelector('b')?.textContent ?? '(unnamed)',
          width: Math.round(box?.width ?? 0),
          height: Math.round(box?.height ?? 0),
        };
      }),
    );

    // A sweep over an empty list is a passing test that proves nothing.
    expect(rows.length).toBeGreaterThan(20);

    const collapsed = rows.filter((row) => row.width === 0);
    expect(collapsed, 'catalog rows whose title column has no width').toEqual([]);

    const shredded = rows.filter((row) => row.height > 96);
    expect(shredded, 'catalog rows whose title is wrapping down a squeezed column').toEqual([]);
  });

  /* The sparring log, opened by a coach rather than by the boxer.
     -----------------------------------------------------------

     /athlete/dashboard/sparring has admitted the coach role since it gained
     its gate, and the observations route has accepted a coach submission for
     an authorized athlete for just as long. The page could not do it: the
     subject came from the session's athlete_id, a coach's session carries
     none, and the submit button was disabled forever with nothing on screen
     saying why. The jsdom suite pins the wiring; this pins that a coach in a
     real browser, through the real role gate, actually gets the control. */
  test('a coach opens the sparring log and is offered only their own athletes', async ({ page }) => {
    await signInAtTheBell(page, {
      session: { role: 'coach' },
      routes: {
        // The access-contract read behind the picker. ROSA is this coach's;
        // the gym's other athletes are deliberately not in this answer.
        '/api/pilot/coach/athletes': { ok: true, items: [ROSA] },
        // The whole-gym roster read. If the picker is ever built on THIS
        // instead, the extra name appears and this test says so.
        '/api/pilot/athletes/list': {
          ok: true,
          items: [ROSA, { athlete_id: 'ath-not-mine', full_name: 'Not This Coach Athlete' }],
        },
      },
      landOn: '/coach/environment/intake-router',
    });

    await page.goto('/athlete/dashboard/sparring');

    const picker = page.getByLabel('Which athlete is this for');
    await expect(picker).toBeVisible();
    await expect(picker.locator('option')).toHaveText(['Choose an athlete', 'Rosa Delgado']);
    await expect(page.getByText('Not This Coach Athlete')).toHaveCount(0);

    // Nothing chosen yet, so there is nothing to file this against.
    await expect(page.getByRole('button', { name: 'Log This Session' })).toBeDisabled();

    await picker.selectOption(ROSA.athlete_id);
    await expect(page.getByRole('button', { name: 'Log This Session' })).toBeEnabled();
  });

  /* WHO WROTE THE PLAN, AS A PERSON.
     This line rendered `Written by acct-coach` to a coach until now, which is
     not attribution -- it is the absence of it, shown to someone who then
     cannot tell which colleague planned the block. The route resolves the
     name; this proves a coach actually sees it, and that the id does not leak
     onto the screen beside it. */
  test('sees who wrote a block by name, not by account id', async ({ page }) => {
    await installPilotApi(page, {
      session: { role: 'coach' },
      routes: {
        '/api/pilot/coach/athletes': { ok: true, items: [ROSA] },
        '/api/pilot/coach/development-blocks': (url) => {
          if (url.searchParams.get('targets') === 'options') return { ok: true, options: [] };
          return {
            ok: true,
            blocks: [{
              block_id: 'blk-1',
              athlete_id: ROSA.athlete_id,
              title: 'Winter technical block',
              training_emphasis: 'Guard recovery off the jab.',
              starts_on: '2026-09-01',
              ends_on: '2026-11-13',
              status: 'active',
              target_competition_id: null,
              target_wrestling_event_id: null,
              target: null,
              created_by_account_id: 'acct-coach',
              created_by_name: 'Coach Rivera',
              created_at: '2026-08-28T00:00:00.000Z',
              updated_at: '2026-08-28T00:00:00.000Z',
            }],
          };
        },
      },
    });

    await page.goto('/coach/development-blocks');
    await page.getByLabel('Which athlete').selectOption(ROSA.athlete_id);

    await expect(page.getByText('Written by Coach Rivera')).toBeVisible();
    await expect(page.getByText('acct-coach')).toHaveCount(0);
  });

  /* The fallback, driven rather than asserted in a comment. If the route ever
     stops resolving a name, a coach should see an ugly true string rather
     than a line that quietly reads "Written by" and stops. */
  test('falls back to the account id when no name resolves, rather than to nothing', async ({ page }) => {
    await installPilotApi(page, {
      session: { role: 'coach' },
      routes: {
        '/api/pilot/coach/athletes': { ok: true, items: [ROSA] },
        '/api/pilot/coach/development-blocks': (url) => {
          if (url.searchParams.get('targets') === 'options') return { ok: true, options: [] };
          return {
            ok: true,
            blocks: [{
              block_id: 'blk-1',
              athlete_id: ROSA.athlete_id,
              title: 'Winter technical block',
              training_emphasis: 'Guard recovery off the jab.',
              starts_on: '2026-09-01',
              ends_on: '2026-11-13',
              status: 'active',
              target_competition_id: null,
              target_wrestling_event_id: null,
              target: null,
              created_by_account_id: 'acct-coach',
              // created_by_name deliberately absent.
              created_at: '2026-08-28T00:00:00.000Z',
              updated_at: '2026-08-28T00:00:00.000Z',
            }],
          };
        },
      },
    });

    await page.goto('/coach/development-blocks');
    await page.getByLabel('Which athlete').selectOption(ROSA.athlete_id);

    await expect(page.getByText('Written by acct-coach')).toBeVisible();
  });

  /* A coach's own development, in a real browser.
     -------------------------------------------

     The jsdom suites pin the wiring and the route tests pin the
     authorization. What neither can catch is what the coach actually reads on
     the page -- and the specific thing that must not be there is a progress
     figure. The Coach Goals tab shipped with hardcoded goals carrying bars
     that read "68%" for every coach who logged in; the goals were deleted and
     the BAR was left behind as dead code over an empty list. This slice
     points a real feed at that tab, so a browser check that no percentage,
     bar or score reaches the screen is worth its cost.

     The fixture is deliberately the tempting case: a goal whose target date
     is long past and three activities whose durations sum to a round number.
     A build that decided the goal was overdue, or totalled the minutes into
     "development hours", would have both on screen here. */
  test("a coach's own development record shows their words and no score", async ({ page }) => {
    await signInAtTheBell(page, {
      session: { role: 'coach' },
      routes: {
        '/api/pilot/coach/development': {
          ok: true,
          goals: [{
            goal_id: 'goal-1',
            title: 'Corner work under pressure',
            development_focus: 'Keep the anxious kids in the room during hard rounds.',
            // Years past, and still exactly what the coach left it as.
            target_on: '2020-01-01',
            status: 'active',
            created_at: '2026-08-01T00:00:00.000Z',
            updated_at: '2026-08-01T00:00:00.000Z',
          }],
          activities: [
            { activity_id: 'a1', goal_id: null, title: 'Youth coaching clinic', provider: 'USA Boxing', occurred_on: '2026-03-12', duration_minutes: 60, notes: '', created_at: '2026-03-12T00:00:00.000Z' },
            { activity_id: 'a2', goal_id: null, title: 'Ringside seminar', provider: '', occurred_on: '2026-02-02', duration_minutes: 120, notes: '', created_at: '2026-02-02T00:00:00.000Z' },
            { activity_id: 'a3', goal_id: null, title: 'Adaptive Coaching', provider: '', occurred_on: '2026-01-05', duration_minutes: 30, notes: '', created_at: '2026-01-05T00:00:00.000Z' },
          ],
        },
      },
      landOn: '/coach/environment/intake-router',
    });

    await page.goto('/coach/development');

    // The coach's own words, read back as written.
    await expect(page.getByRole('heading', { name: 'Corner work under pressure' })).toBeVisible();
    await expect(
      page.getByText('Keep the anxious kids in the room during hard rounds.'),
    ).toBeVisible();

    // Each activity carries its own duration...
    await expect(page.getByText('2026-03-12 · USA Boxing · 1h 00m')).toBeVisible();
    // ...and one with no provider recorded renders a clean line, not a
    // dangling separator or the word null.
    await expect(page.getByText('2026-02-02 · 2h 00m')).toBeVisible();

    const body = (await page.locator('body').innerText()).toLowerCase();

    // The sum -- 210 minutes, 3h 30m -- is nowhere. A total built from
    // self-entered rows sitting beside a certification band reads as proof of
    // hours, and it would not be.
    expect(body).not.toContain('3h 30m');
    expect(body).not.toContain('210');

    // No percentage, no bar, no score, and nothing calling the elapsed target
    // date a failure.
    expect(body).not.toMatch(/\d+\s*%/);
    expect(body).not.toMatch(/overdue|expired|missed deadline|behind schedule/);
    expect(await page.locator('progress, [role="progressbar"]').count()).toBe(0);

    // Nothing here claims a clearance, and the page says where the real
    // record is instead of leaving a coach to work it out.
    expect(body).toContain('self-entered');
    await expect(page.getByRole('link', { name: 'Your credentials' })).toBeVisible();
  });

  /* Plan -> session, in a real browser.
     ---------------------------------

     The jsdom suite pins the wiring and the route tests pin the two different
     authorization questions. What a browser adds is what the coach actually
     reads next to a plan -- and the thing that must NOT be there is a count.
     The fixture is deliberately the tempting one: two linked sessions against
     a six-week block, which is exactly the shape somebody would render as
     "2 of 12 delivered" or a coverage bar. */
  test('a coach sees which sessions worked a block, and no count of them', async ({ page }) => {
    const BLOCK = {
      block_id: 'blk-1',
      athlete_id: ROSA.athlete_id,
      title: 'Late summer block',
      training_emphasis: 'Round-three work rate.',
      starts_on: '2026-08-01',
      ends_on: '2026-09-30',
      status: 'active',
      target_competition_id: null,
      target_wrestling_event_id: null,
      target: null,
      created_by_account_id: 'acct-coach-a',
      created_at: '2026-08-01T00:00:00.000Z',
      updated_at: '2026-08-01T00:00:00.000Z',
    };

    await signInAtTheBell(page, {
      session: { role: 'coach' },
      routes: {
        '/api/pilot/coach/athletes': { ok: true, items: [ROSA] },
        '/api/pilot/coach/development-blocks': { ok: true, blocks: [BLOCK], options: [] },
        '/api/pilot/coach/session-block-links': {
          ok: true,
          runs: [
            { run_id: 'run-1', script_id: 'scr-1', script_name: 'Tuesday Technical', delivered_on: '2026-09-08', run_state: 'completed' },
            { run_id: 'run-2', script_id: 'scr-1', script_name: 'Tuesday Technical', delivered_on: '2026-09-15', run_state: 'completed' },
          ],
          sessions: [
            { run_id: 'run-1', script_id: 'scr-1', script_name: 'Tuesday Technical', delivered_on: '2026-09-08', delivered_by_account_id: 'acct-coach-a', run_state: 'completed', athletes_present: 9, blocks_completed: 4, deviation_note: '', what_worked: 'Guard held up in round three.', what_did_not: '', linked_by_account_id: 'acct-coach-a', linked_at: '2026-09-08T20:00:00.000Z' },
            { run_id: 'run-2', script_id: 'scr-1', script_name: 'Tuesday Technical', delivered_on: '2026-09-15', delivered_by_account_id: 'acct-coach-a', run_state: 'completed', athletes_present: 11, blocks_completed: 5, deviation_note: 'Cut the last round short.', what_worked: '', what_did_not: '', linked_by_account_id: 'acct-coach-a', linked_at: '2026-09-15T20:00:00.000Z' },
          ],
        },
      },
      landOn: '/coach/environment/intake-router',
    });

    await page.goto('/coach/development-blocks');
    await page.getByLabel('Which athlete').selectOption(ROSA.athlete_id);
    // The panels load when a coach opens them; opening is what a coach does.
    await page.getByRole('button', { name: 'Sessions' }).first().click();

    await expect(page.getByText('Sessions that worked this block')).toBeVisible();
    // The run's own words about itself, carried through rather than summarised.
    await expect(page.getByText('What worked: Guard held up in round three.')).toBeVisible();
    await expect(page.getByText('Cut the last round short.')).toBeVisible();
    // A blank field renders no heading at all, rather than a label over nothing.
    await expect(page.getByText('What did not:')).toHaveCount(0);

    const body = (await page.locator('body').innerText()).toLowerCase();

    // NO COUNT AND NO COVERAGE. Plan-versus-actual is the next slice; a
    // figure here would be a judgement about a coach's work with a child
    // assembled out of links nobody validated.
    expect(body).not.toMatch(/\d+\s*of\s*\d+/);
    expect(body).not.toMatch(/\d+\s*%/);
    expect(body).not.toMatch(/coverage|adherence|compliance|on track|behind schedule/);
    expect(await page.locator('progress, [role="progressbar"]').count()).toBe(0);

    // And a coach can attach another one.
    await expect(page.getByLabel('Link a session')).toBeVisible();
  });

  /* Objectives marked against a session, in a real browser.
     -----------------------------------------------------

     The last bullet of PR F, and the surface where a count would do the most
     damage: objectives carry a DOMAIN, so a tally is one step from a
     per-domain coverage chart about a child's training. The fixture is built
     to tempt exactly that -- three objectives across three domains, one
     marked, and one of the unmarked ones in the nutrition domain, which is
     the reading a coach would most wrongly treat as a finding. */
  test('a coach marks what a session worked on, and sees no tally of it', async ({ page }) => {
    const BLOCK = {
      block_id: 'blk-1',
      athlete_id: ROSA.athlete_id,
      title: 'Late summer block',
      training_emphasis: 'Round-three work rate.',
      starts_on: '2026-08-01',
      ends_on: '2026-09-30',
      status: 'active',
      target_competition_id: null,
      target_wrestling_event_id: null,
      target: null,
      created_by_account_id: 'acct-coach-a',
      created_at: '2026-08-01T00:00:00.000Z',
      updated_at: '2026-08-01T00:00:00.000Z',
    };

    await signInAtTheBell(page, {
      session: { role: 'coach' },
      routes: {
        '/api/pilot/coach/athletes': { ok: true, items: [ROSA] },
        '/api/pilot/coach/development-blocks': { ok: true, blocks: [BLOCK], options: [] },
        '/api/pilot/coach/session-block-links': {
          ok: true,
          runs: [],
          sessions: [
            { run_id: 'run-1', script_id: 'scr-1', script_name: 'Tuesday Technical', delivered_on: '2026-09-08', delivered_by_account_id: 'acct-coach-a', run_state: 'completed', athletes_present: 9, blocks_completed: 4, deviation_note: '', what_worked: '', what_did_not: '', linked_by_account_id: 'acct-coach-a', linked_at: '2026-09-08T20:00:00.000Z' },
          ],
        },
        '/api/pilot/coach/session-objective-links': {
          ok: true,
          objectives: [
            { objective_id: 'obj-a', block_id: 'blk-1', domain: 'technical', objective: 'Stop drifting to the ropes.', status: 'active' },
            { objective_id: 'obj-b', block_id: 'blk-1', domain: 'mental', objective: 'Settle after a clean shot.', status: 'active' },
            { objective_id: 'obj-c', block_id: 'blk-1', domain: 'nutrition_body_composition', objective: 'Eat before the session.', status: 'active' },
          ],
          links: [{ run_id: 'run-1', objective_id: 'obj-a', linked_by_account_id: 'acct-coach-a' }],
        },
      },
      landOn: '/coach/environment/intake-router',
    });

    await page.goto('/coach/development-blocks');
    await page.getByLabel('Which athlete').selectOption(ROSA.athlete_id);
    // The panels load when a coach opens them; opening is what a coach does.
    await page.getByRole('button', { name: 'Sessions' }).first().click();

    await expect(page.getByText('Objectives this session addressed')).toBeVisible();
    // The marked one, and the unmarked ones -- a coach has to see what the
    // class did not touch in order to mark it.
    await expect(page.getByRole('button', { name: 'Addressed: Stop drifting to the ropes.' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Not marked: Settle after a clean shot.' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Not marked: Eat before the session.' })).toBeVisible();

    const body = (await page.locator('body').innerText()).toLowerCase();

    // NO TALLY. "1 of 3" is the shape, and a nutrition domain reading zero is
    // the reading -- neither of which this platform has earned.
    expect(body).not.toMatch(/\d+\s*of\s*\d+/);
    expect(body).not.toMatch(/\d+\s*%/);
    expect(body).not.toMatch(/coverage|adherence|neglect|gap|missing/);
    expect(await page.locator('progress, [role="progressbar"]').count()).toBe(0);
  });
  /* Plan versus what was actually recorded, in a real browser.
     --------------------------------------------------------

     THE SURFACE THE WHOLE LANE HAS BEEN HOLDING THE DOOR OPEN FOR. Every
     panel before this one refused to count anything, so that when the
     plan-versus-actual question finally arrived it would arrive undecided.
     Here it arrives: a plan and a record of activity are on one screen for
     the first time, and the fixture is built to tempt the exact figure the
     build order forbids -- a six-week block, three sessions recorded, twelve
     training attempts, and one source sitting at zero, which is precisely the
     shape somebody renders as "3 of 12", a coverage bar, or an 82%.

     What a browser adds over the jsdom suite is the reading. A coach looking
     at a column of counts will draw a conclusion; the claim under test is
     that what is on the glass supports only the true one -- these are counts
     of RECORDS -- and that the judgement control next to them opens
     undecided. */
  test('a coach reads what was recorded against a plan, and is handed no percentage', async ({ page }) => {
    const BLOCK = {
      block_id: 'blk-1',
      athlete_id: ROSA.athlete_id,
      title: 'Late summer block',
      training_emphasis: 'Round-three work rate.',
      starts_on: '2026-08-01',
      ends_on: '2026-09-30',
      status: 'active',
      target_competition_id: null,
      target_wrestling_event_id: null,
      target: null,
      created_by_account_id: 'acct-coach-a',
      created_at: '2026-08-01T00:00:00.000Z',
      updated_at: '2026-08-01T00:00:00.000Z',
    };

    await signInAtTheBell(page, {
      session: { role: 'coach' },
      routes: {
        '/api/pilot/coach/athletes': { ok: true, items: [ROSA] },
        '/api/pilot/coach/development-blocks': { ok: true, blocks: [BLOCK], options: [] },
        '/api/pilot/coach/block-review': {
          ok: true,
          reviews: [
            {
              review_id: 'rev-1',
              block_id: 'blk-1',
              adherence_state: 'delivered_with_deviations',
              deviations: 'Two weeks lost to a hall closure.',
              reason: 'Venue.',
              what_worked: 'Round-three output held.',
              what_did_not: 'Southpaw work never started.',
              next_adjustment: 'Move southpaw work forward.',
              reviewed_by_account_id: 'acct-coach-a',
              created_at: '2026-09-30T00:00:00.000Z',
            },
          ],
          evidence: [
            { key: 'sessions', label: 'Sessions linked to this block', recorded: 3, undated: 0, recent: [{ when: '2026-09-08', detail: 'Tuesday Technical' }] },
            { key: 'training_attempts', label: 'Training attempts recorded', recorded: 12, undated: 0, recent: [] },
            { key: 'activity_log', label: 'Training activity entries recorded', recorded: 0, undated: 0, recent: [] },
            { key: 'assessments', label: 'Assessments administered', recorded: 2, undated: 3, recent: [] },
          ],
        },
      },
      landOn: '/coach/environment/intake-router',
    });

    await page.goto('/coach/development-blocks');
    await page.getByLabel('Which athlete').selectOption(ROSA.athlete_id);
    await page.getByRole('button', { name: 'Plan vs actual' }).first().click();

    await expect(page.getByText('Plan versus what was recorded')).toBeVisible();

    // Counts of RECORDS, each carrying the word that says so.
    await expect(page.getByText('Sessions linked to this block: 3 recorded')).toBeVisible();
    await expect(page.getByText('Training attempts recorded: 12 recorded')).toBeVisible();
    // The zero is on the glass, with the reading it does not support beside it.
    await expect(page.getByText('Training activity entries recorded: 0 recorded')).toBeVisible();
    await expect(page.getByText(/nobody wrote anything down/i)).toBeVisible();

    /* Rows no window can place, kept apart from the count. An assessment that
       was scheduled and never administered has no date: counting it would
       claim a test happened, and dropping it would hide records a coach is
       looking for. */
    await expect(page.getByText('Assessments administered: 2 recorded')).toBeVisible();
    await expect(page.getByText(/3 more on record with no date/i)).toBeVisible();

    // The human's judgement, in the human's words.
    await expect(page.getByText('Deviations: Two weeks lost to a hall closure.')).toBeVisible();
    await expect(page.getByText('Next adjustment: Move southpaw work forward.')).toBeVisible();

    const body = (await page.locator('body').innerText()).toLowerCase();

    /* THE REFUSAL, ON THE RENDERED PAGE. The build order settles it in its own
       words: "Do not invent an adherence percentage." A figure here would be a
       machine's verdict on a coach's work with a child, and it would be
       believed precisely because it looked measured. */
    expect(body).not.toMatch(/\d+\s*%/);
    expect(body).not.toMatch(/\d+\s*of\s*\d+/);
    expect(body).not.toMatch(/coverage|compliance|on track|behind schedule|completion/);
    expect(await page.locator('progress, [role="progressbar"]').count()).toBe(0);

    /* AND THE JUDGEMENT IS STILL THE COACH'S TO MAKE. Three sessions, twelve
       attempts and a zero on screen, and the control still opens on 'unknown'
       -- nothing read those counts and chose a state. */
    await expect(page.getByLabel('How did it go')).toHaveValue('unknown');
  });
});
