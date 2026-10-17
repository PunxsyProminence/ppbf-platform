import { expect, test, type Page } from '@playwright/test';

async function expectLoginRedirect(page: Page, path: string) {
  await page.goto(path);
  await expect(page).toHaveURL(/\/login/);
  await expect(page.getByRole('heading', { name: 'The Bell' })).toBeVisible();
}

test.describe('Board governance surfaces', () => {
  test('board hub requires authenticated board session', async ({ page }) => {
    await expectLoginRedirect(page, '/board');
  });

  test('board seat routes require authenticated board session', async ({ page }) => {
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
      await expectLoginRedirect(page, `/board/${seat}`);
    }
  });

  test('board compliance monitoring requires authenticated board session', async ({ page }) => {
    await expectLoginRedirect(page, '/board/compliance-monitoring');
  });
});
