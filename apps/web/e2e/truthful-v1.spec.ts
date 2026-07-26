import { expect, test, type Page, type Request, type Route } from '@playwright/test';

type AuthRole = 'athlete' | 'coach' | 'organization_admin';

const removedAthleteFixtures = [
  'Morning Readiness Check-In',
  'Dynamic Warmup + Mobility',
  "Hey! I'm SHADOW, your AI athletic coach.",
];

const removedCoachFixtures = [
  'Bronze Certification',
  'USA Boxing Coach License',
  'Film review - last session',
  'Sophia Chen',
  'James Thompson',
  'Marcus Rodriguez',
  'Recommend modified rounds',
];

async function fulfillJson(route: Route, body: unknown, status = 200) {
  await route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}

async function mockAuthoritativeSession(page: Page, role: AuthRole) {
  await page.route('**/api/pilot/auth/session', async (route) => {
    await fulfillJson(route, {
      authenticated: true,
      role,
      auth_provider: role === 'athlete' ? 'ppbf_local' : 'microsoft',
      account_id: `${role}-account`,
      athlete_id: role === 'athlete' ? 'athlete-verified-1' : undefined,
    });
  });
}

function isWrite(request: Request) {
  return !['GET', 'HEAD', 'OPTIONS'].includes(request.method());
}

async function expectRemovedFixturesAbsent(page: Page, fixtures: readonly string[]) {
  for (const fixture of fixtures) {
    await expect(page.getByText(fixture, { exact: false })).toHaveCount(0);
  }
}

test.describe('truthful V1 containment', () => {
  test('athlete empty state stays empty and check-in does not create readiness-derived work', async ({
    page,
  }) => {
    const floorPlanWrites: Request[] = [];
    const readinessAsRpeWrites: Request[] = [];

    page.on('request', (request) => {
      if (!isWrite(request)) return;

      if (new URL(request.url()).pathname === '/api/pilot/floor-plans') {
        floorPlanWrites.push(request);
      }

      const body = request.postData() ?? '';
      if (/"rpe"\s*:|readiness.{0,24}rpe|rpe.{0,24}readiness/i.test(body)) {
        readinessAsRpeWrites.push(request);
      }
    });

    await mockAuthoritativeSession(page, 'athlete');
    await page.route('**/api/pilot/goals/list?**', (route) =>
      fulfillJson(route, { items: [] }),
    );
    await page.route('**/api/pilot/sessions/list?**', (route) =>
      fulfillJson(route, { items: [] }),
    );
    await page.route('**/api/pilot/shadow/observation-projection', (route) =>
      fulfillJson(route, { items: [] }),
    );

    await page.goto('/athlete/dashboard');

    await expect(page.getByRole('heading', { name: 'My Training Dashboard' })).toBeVisible();
    await expect(page.getByText('No recorded sessions', { exact: true }).first()).toBeVisible();

    await page.getByRole('button', { name: 'Floor', exact: true }).click();
    await expect(
      page.getByText('Live coach-assigned floor tasks are not connected', { exact: false }),
    ).toBeVisible();

    await page.getByRole('button', { name: 'Bio Check-In', exact: true }).click();
    await expect(
      page.getByText('treat readiness as RPE', { exact: false }),
    ).toBeVisible();

    await page.getByRole('button', { name: 'Schedule', exact: true }).click();
    await expect(
      page.getByText('does not contain a verified class feed', { exact: false }),
    ).toBeVisible();

    await page.getByRole('button', { name: 'SHADOW', exact: true }).click();
    await expect(page.getByText('No SHADOW observations', { exact: true })).toBeVisible();
    await expect(
      page.getByText('does not generate sample conversations', { exact: false }),
    ).toBeVisible();

    await expectRemovedFixturesAbsent(page, removedAthleteFixtures);
    expect(floorPlanWrites).toHaveLength(0);
    expect(readinessAsRpeWrites).toHaveLength(0);
  });

  test('athlete read failures remain explicit and never fall back to samples', async ({ page }) => {
    await mockAuthoritativeSession(page, 'athlete');
    await page.route('**/api/pilot/goals/list?**', (route) =>
      fulfillJson(route, { error: 'unavailable' }, 503),
    );
    await page.route('**/api/pilot/sessions/list?**', (route) =>
      fulfillJson(route, { error: 'unavailable' }, 503),
    );
    await page.route('**/api/pilot/shadow/observation-projection', (route) =>
      fulfillJson(route, { error: 'unavailable' }, 503),
    );

    await page.goto('/athlete/dashboard');

    await expect(page.getByText('Session loading error', { exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'Goals', exact: true }).click();
    await expect(page.getByText('Goal loading error', { exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'SHADOW', exact: true }).click();
    await expect(page.getByText('SHADOW loading error', { exact: true })).toBeVisible();
    await expectRemovedFixturesAbsent(page, removedAthleteFixtures);
  });

  test('coach absent fields stay unavailable without invented work or recommendations', async ({
    page,
  }) => {
    await mockAuthoritativeSession(page, 'coach');
    await page.route('**/api/pilot/athletes/list', (route) =>
      fulfillJson(route, { items: [{ athlete_id: 'verified-athlete-1' }] }),
    );
    await page.route('**/api/pilot/floor-plans?**', (route) =>
      fulfillJson(route, { items: [] }),
    );
    await page.route('**/api/pilot/shadow/review-projection', (route) =>
      fulfillJson(route, { queue: [] }),
    );
    await page.route('**/api/pilot/shadow/observation-projection', (route) =>
      fulfillJson(route, { items: [] }),
    );

    await page.goto('/coach/review-queue');

    await expect(page.getByRole('heading', { name: 'Coach Operations Workspace' })).toBeVisible();
    await expect(page.getByText('Not reported', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('Unavailable', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('Name not reported', { exact: true })).toBeVisible();
    await expect(
      page.getByText('No coach-task service is connected', { exact: false }),
    ).toBeVisible();

    await page.getByRole('button', { name: 'Development', exact: true }).click();
    await expect(
      page.getByText('No verified certification, license, training-hour', { exact: false }),
    ).toBeVisible();

    await page.getByRole('button', { name: 'Tasks', exact: true }).click();
    await expect(
      page.getByText('No verified coach-task service is connected', { exact: false }),
    ).toBeVisible();

    await page.getByRole('button', { name: 'SHADOW Intel', exact: true }).click();
    await expect(page.getByText('No review records reported.', { exact: true })).toBeVisible();
    await expect(page.getByText('No observation records reported.', { exact: true })).toBeVisible();
    await expectRemovedFixturesAbsent(page, removedCoachFixtures);
  });

  test('admin GET failures never trigger a write or fallback records', async ({ page }) => {
    const writes: Request[] = [];
    page.on('request', (request) => {
      if (
        isWrite(request)
        && new URL(request.url()).pathname.startsWith('/api/pilot/admin/')
      ) {
        writes.push(request);
      }
    });

    await mockAuthoritativeSession(page, 'organization_admin');
    await page.route('**/api/pilot/admin/**', (route) => {
      if (route.request().method() === 'GET') {
        return fulfillJson(route, { error: 'unavailable' }, 503);
      }
      return fulfillJson(route, {});
    });

    await page.goto('/admin');

    await expect(
      page.getByText('Unavailable. No fallback or sample records are being shown.', {
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page.getByText('Unavailable. Existing access settings will not be overwritten.', {
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page.getByText('Unavailable. No default assignments are being substituted.', {
        exact: true,
      }),
    ).toBeVisible();

    await expect.poll(() => writes.length).toBe(0);
    await expect(
      page.getByRole('button', { name: 'SAVE CAPABILITY CHANGES', exact: true }),
    ).toBeDisabled();
  });

  test('admin empty reads stay empty and persist only after explicit Save', async ({ page }) => {
    const writes: Request[] = [];
    page.on('request', (request) => {
      if (
        isWrite(request)
        && new URL(request.url()).pathname.startsWith('/api/pilot/admin/')
      ) {
        writes.push(request);
      }
    });

    await mockAuthoritativeSession(page, 'organization_admin');
    await page.route('**/api/pilot/admin/track-assignments', (route) =>
      fulfillJson(route, { assignments: {} }),
    );
    await page.route('**/api/pilot/admin/capabilities', (route) => {
      if (route.request().method() === 'GET') {
        return fulfillJson(route, { capabilities: [] });
      }
      return fulfillJson(route, { saved: true });
    });
    await page.route('**/api/pilot/admin/gym-capabilities', (route) =>
      fulfillJson(route, { capabilityAccess: {} }),
    );

    await page.goto('/admin');

    await expect(
      page.getByText('Loaded successfully. No capabilities are stored for this organization.', {
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page.getByText('Loaded successfully. No gym capability access settings are stored.', {
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page.getByText('Loaded successfully. No track assignments are stored.', { exact: true }),
    ).toBeVisible();
    await expect.poll(() => writes.length).toBe(0);

    await page.getByRole('button', { name: 'Capability Builder', exact: true }).click();
    await page.getByLabel('Capability Name', { exact: true }).fill('Verified test capability');
    await page.getByRole('button', { name: 'APPLY TO UNSAVED CHANGES', exact: true }).click();

    await expect(page.getByText('Save status: Unsaved changes', { exact: true })).toBeVisible();
    await expect.poll(() => writes.length).toBe(0);

    await page.getByRole('button', { name: 'SAVE CAPABILITY CHANGES', exact: true }).click();

    await expect.poll(() => writes.length).toBe(1);
    expect(writes[0].url()).toContain('/api/pilot/admin/capabilities');
    expect(writes[0].postDataJSON()).toMatchObject({
      capabilities: [expect.objectContaining({ name: 'Verified test capability' })],
    });
    await expect(page.getByText('Save status: Saved', { exact: true })).toBeVisible();
  });
});
