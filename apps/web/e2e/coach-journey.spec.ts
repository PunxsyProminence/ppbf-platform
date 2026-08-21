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
    await expect(page.getByRole('heading', { name: 'Live Session Management' })).toBeVisible();

    // The two live safety reads a coach scans first. Their presence is the
    // point; their contents belong to the API tests.
    await expect(page.getByRole('heading', { name: 'Athlete Pain Reports' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Safety Escalations' })).toBeVisible();

    // A signed-in surface must never be showing the gate's holding screen by
    // the time the coach is looking at it.
    await expect(page.getByRole('heading', { name: 'Checking access' })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Unable to verify access' })).toHaveCount(0);
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
});
