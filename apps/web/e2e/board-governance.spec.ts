import { expect, test, type Page } from '@playwright/test';

const ROLE_SESSION_KEY = 'ppbf-role-session';

async function authenticateAsBoardPresident(page: Page) {
  const expiresAt = Date.now() + 60 * 60 * 1000;
  await page.addInitScript(({ key, expiresAtValue }) => {
    window.localStorage.setItem(
      key,
      JSON.stringify({ role: 'board-president', expiresAt: expiresAtValue }),
    );
    window.localStorage.setItem('ppbf-club-role', 'board-president');
  }, { key: ROLE_SESSION_KEY, expiresAtValue: expiresAt });
}

test.describe('Board governance surfaces', () => {
  test('renders governance shell and tabs for president seat', async ({ page }) => {
    await authenticateAsBoardPresident(page);
    await page.goto('/board/president');

    await expect(page.getByRole('heading', { name: 'President Workspace' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Governance' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Strategy' })).toBeVisible();
    await expect(page.getByText('Nonprofit Identity')).toBeVisible();
    await expect(page.getByText('501(c)(3) Public Charity')).toBeVisible();
    await expect(page.getByText('Governance SHADOW Feed')).toBeVisible();
  });

  test('all board seat routes load', async ({ page }) => {
    await authenticateAsBoardPresident(page);

    const seats = [
      'president',
      'chair',
      'vice-chair',
      'treasurer',
      'secretary',
      'safety-director',
      'community-director',
      'at-large',
    ] as const;

    for (const seat of seats) {
      const response = await page.goto(`/board/${seat}`);
      expect(response?.ok(), `Expected /board/${seat} to return 2xx`).toBeTruthy();
      await expect(page.getByText('Board Workspace Framework')).toBeVisible();
    }
  });

  test('captures board governance visual baselines', async ({ page }) => {
    await authenticateAsBoardPresident(page);

    await page.goto('/board');
    await expect(page.getByRole('heading', { name: 'One board governance framework' })).toBeVisible();
    await expect(page).toHaveScreenshot('board-hub.png', { fullPage: true });

    await page.goto('/board/president');
    await expect(page.getByRole('heading', { name: 'President Workspace' })).toBeVisible();
    await expect(page).toHaveScreenshot('board-president-workspace.png', { fullPage: true });
  });
});
