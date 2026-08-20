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
