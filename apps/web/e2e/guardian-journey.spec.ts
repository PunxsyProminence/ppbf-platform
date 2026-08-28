import { expect, test } from '@playwright/test';
import { installPilotApi, signInAtTheBell } from './support/signIn';

/* A guardian, signed in, seeing their own child and deciding for them.
   ------------------------------------------------------------------------

   WHAT THIS LAYER OWNS. The `.pg` suites prove the guardian link and the
   consent tables; the route tests prove that /api/pilot/parent/* refuses
   another family's child. What neither can see is the browser: whether the
   child a guardian is acting on is actually NAMED on screen next to the
   button, whether the family ground renders legibly, whether the hub resolves
   at all. This spec holds the API still at the network boundary and drives
   the real app above it.

   'parent' IS THE CANONICAL GUARDIAN ROLE in this codebase -- /guardian
   itself now redirects into the Parent Hub, and /guardian/dashboard is a
   signpost saying the consent and safety controls live on their real
   surfaces. So the guardian's destination is /parent/dashboard, and the
   consent decision is made at /parent/consent. Both are asserted here.

   The Microsoft half of sign-in belongs to an identity provider and is not
   simulated; see e2e/support/signIn.ts. */

const ROSA = { athlete_id: 'ath-rosa', full_name: 'Rosa Delgado' };
const OTHER_FAMILYS_CHILD = 'Marcus Bell';

test.describe('Guardian journey', () => {
  test('signs in and sees their own child in the family hub', async ({ page }) => {
    const unstubbed: string[] = [];

    await signInAtTheBell(page, {
      session: { role: 'parent' },
      unstubbed,
      routes: {
        '/api/pilot/athletes/list': { ok: true, items: [ROSA] },
        '/api/pilot/profile/card': (url) => ({
          card: {
            athleteId: url.searchParams.get('athlete_id'),
            accountId: 'acct-rosa',
            initials: 'RD',
            photoAvailable: false,
          },
        }),
      },
    });

    await expect(page).toHaveURL(/\/parent\/dashboard$/);
    await expect(page.getByRole('heading', { name: 'Family Development Dashboard' })).toBeVisible();

    // The child, by name. A family hub that resolved but showed "No children
    // found" is the failure a guardian would report, and it is exactly what
    // the loading and error branches of this component can leave on screen.
    await expect(page.getByRole('button', { name: ROSA.full_name })).toBeVisible();
    await expect(page.getByText('No children found')).toHaveCount(0);
    await expect(page.getByText('Loading your children...')).toHaveCount(0);

    // Safeguarding, observable from the browser: a guardian reaches a child's
    // identity through /profile/card, which runs the guardian-link visibility
    // gate per athlete. It must NOT come from /profile/roster, the staff-wide
    // read -- that route is where another family's child would come from.
    expect(unstubbed).not.toContain('/api/pilot/profile/roster');

    await expect(page.getByRole('heading', { name: 'Checking access' })).toHaveCount(0);
    await expect(page.getByText(OTHER_FAMILYS_CHILD)).toHaveCount(0);
  });

  test('grants photo and video consent for the child they are looking at', async ({ page }) => {
    const decisions: Array<Record<string, unknown>> = [];

    await installPilotApi(page, {
      session: { role: 'parent' },
      routes: {
        '/api/pilot/parent/consent': (_url, route) => {
          if (route.request().method() === 'POST') {
            decisions.push(JSON.parse(route.request().postData() ?? '{}'));
            return { ok: true };
          }
          return {
            ok: true,
            items: [
              {
                athlete_id: ROSA.athlete_id,
                athlete_name: ROSA.full_name,
                consent_ok: false,
                guardian_count: 1,
                missing_guardian_count: 1,
                per_guardian: [
                  { parent_id: 'par-1', you: true, status: null, covers_video: null, public_use_allowed: null, signed_at: null },
                ],
              },
            ],
          };
        },
      },
    });

    await page.goto('/parent/consent');

    await expect(page.getByRole('heading', { name: 'Photo & Video Consent' })).toBeVisible();

    // The child is named, and their current state is stated in words as well
    // as colour -- a consent screen that says "needed" only in red is a
    // consent screen a colour-blind guardian cannot read.
    await expect(page.getByText(ROSA.full_name)).toBeVisible();
    await expect(page.getByText('Consent needed')).toBeVisible();

    // The scope controls a guardian is entitled to set BEFORE consenting.
    // Public use is unchecked by default and must stay that way: a guardian
    // who grants consent without touching anything has not agreed to their
    // child appearing on social media.
    const publicUse = page.getByRole('checkbox', { name: /Allow public use/ });
    await expect(publicUse).not.toBeChecked();
    await expect(page.getByRole('checkbox', { name: /Include video/ })).toBeChecked();

    await page.getByRole('button', { name: 'Grant Consent' }).click();

    await expect.poll(() => decisions).toHaveLength(1);
    expect(decisions[0]).toEqual({
      athlete_id: ROSA.athlete_id,
      decision: 'grant',
      covers_video: true,
      public_use_allowed: false,
    });

    await expect(page.getByText('Consent granted.')).toBeVisible();
  });

  /* THE SAME PLAN THEIR CHILD READS, AND NO MORE.
     A guardian reads exactly what their child reads -- the rule
     /parent/progression-visibility already states, and the reason both pages
     render one shared component. This drives the guardian's half in a real
     browser: the child picker names which child, and the plan that comes back
     is the coach's words unaltered. */
  test('reads the plan their child\'s coach wrote, choosing which child', async ({ page }) => {
    const asked: string[] = [];

    await installPilotApi(page, {
      session: { role: 'parent' },
      routes: {
        '/api/pilot/athletes/list': { ok: true, items: [ROSA] },
        '/api/pilot/athlete/development-blocks': (url) => {
          // A guardian may hold several links, so the child is named --
          // and it is the one they chose.
          asked.push(url.searchParams.get('athlete_id') ?? '');
          return {
            ok: true,
            blocks: [{
              block_id: 'blk-1',
              title: 'Winter technical block',
              training_emphasis: 'Stop backing straight up when the pressure comes.',
              starts_on: '2026-09-01',
              ends_on: '2026-10-13',
              status: 'active',
              objectives: [{
                objective_id: 'obj-1',
                domain: 'nutrition_body_composition',
                objective: 'Eat a real breakfast before morning conditioning.',
                status: 'draft',
              }],
            }],
          };
        },
      },
    });

    await page.goto('/parent/development-blocks');

    // Nothing is read until a child is chosen: a guardian of two children has
    // no default, and picking one for them would invent an answer.
    await expect(page.getByRole('heading', { level: 1, name: 'Their Development Plan' })).toBeVisible();
    expect(asked).toEqual([]);

    await page.getByLabel('Which child').selectOption(ROSA.athlete_id);

    await expect.poll(() => asked).toEqual([ROSA.athlete_id]);
    await expect(page.getByText('Winter technical block')).toBeVisible();
    await expect(page.getByText('Stop backing straight up when the pressure comes.')).toBeVisible();
    await expect(page.getByText('Eat a real breakfast before morning conditioning.')).toBeVisible();

    /* Read-only, and the page says so to the parent in words as well as by
       carrying no control that could change anything. */
    await expect(page.getByText(/nothing on this page can be changed from it/i)).toBeVisible();
    await expect(page.locator('form, textarea')).toHaveCount(0);
    await expect(page.locator('progress, meter, [role="progressbar"]')).toHaveCount(0);
  });

  test('an unauthenticated visitor never sees a family surface', async ({ page }) => {
    // The negative that gives the two tests above their meaning: with the
    // session route answering 401, no part of the hub may render on the way
    // to /login.
    await installPilotApi(page, { session: null });

    await page.goto('/parent/dashboard');

    await expect(page.getByRole('heading', { name: 'Family Development Dashboard' })).toHaveCount(0);
    await expect(page).toHaveURL(/\/login/, { timeout: 15000 });
  });
});
