import { expect, test } from '@playwright/test';

/* The pixel baseline is opt-in, and that is a correction, not a retreat.

   It was wired into CI on baselines recorded in a dev container, and CI
   rendered the same page 60px taller: 412x3620 expected, 412x3680 received.
   Both sides are deterministic -- two CI retries produced byte-identical
   diffs -- so this is not flake, it is two different rendering environments.
   Note also that a size mismatch fails BEFORE maxDiffPixelRatio is consulted,
   so the tolerance in playwright.config.ts never applied and could not have.

   The cause is in the sheet, not the test. The app self-hosts its three real
   faces through next/font, but ppbf.css's --font-ui, --font-data and
   --font-hand are system stacks (Inter, ui-monospace, SFMono, Consolas,
   Segoe Print). Those resolve to whatever a given machine happens to have,
   and .t-eyebrow / .t-data / .badge are set in them, so text wraps at
   different widths and the page ends up a different height.

   A full-page pixel baseline therefore cannot be portable until those stacks
   are self-hosted too. Until then this assertion runs where a baseline was
   recorded on the same machine, and CI runs the rest of this file -- which is
   the part that actually generalises: the homepage stays public, the headings
   stay present, no password field appears on it, Log In routes to The Bell,
   and protected routes still redirect. All five pass in CI today.

   To use it:  npm --workspace web run test:e2e:homepage:update   (record)
               PPBF_VISUAL_BASELINE=1 npm --workspace web run test:e2e:homepage */
const visualBaseline = process.env.PPBF_VISUAL_BASELINE === '1';

test.describe('Public homepage', () => {
  test('renders publicly at / without requiring authentication', async ({ page }) => {
    const response = await page.goto('/');
    expect(response?.ok(), 'Expected / to return 2xx for an unauthenticated visitor').toBeTruthy();

    await expect(page).toHaveURL('/');
    await expect(
      page.getByRole('heading', { name: /Boxing is the engagement platform/i }),
    ).toBeVisible();
    await expect(page.getByText('IRS-recognized 501(c)(3) nonprofit').first()).toBeVisible();
    await expect(page.getByText('Children participate at no charge.')).toBeVisible();

    await expect(page.getByRole('link', { name: 'Log In' }).first()).toHaveAttribute('href', '/login');
    await expect(page.getByRole('link', { name: 'Learn About Our Programs' })).toHaveAttribute('href', '#programs');

    // No login form should be embedded directly on the homepage.
    await expect(page.locator('input[type="password"]')).toHaveCount(0);

    if (visualBaseline) {
      await expect(page).toHaveScreenshot('public-homepage.png', { fullPage: true });
    }
  });

  test('Log In routes to the existing authentication page', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('link', { name: 'Log In' }).first().click();
    await expect(page).toHaveURL(/\/login/);
    await expect(page.getByRole('heading', { name: 'The Bell' })).toBeVisible();
  });

  test('login route still exposes Microsoft and PIN sign-in options', async ({ page }) => {
    const response = await page.goto('/login');
    expect(response?.ok()).toBeTruthy();
    await expect(page.getByRole('heading', { name: 'The Bell' })).toBeVisible();

    // This asserted on one exact sentence of lede copy, which then got
    // rewritten, so the test failed for a reason that had nothing to do with
    // what it is named for. The two sign-in methods are the contract; the
    // sentence introducing them is not.
    await expect(page.getByRole('button', { name: /Microsoft/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /Account ID \/ PIN/ })).toBeVisible();
    await expect(page.getByLabel(/Account ID/i).first()).toBeVisible();
  });

  test('protected routes still require authentication', async ({ page }) => {
    await page.goto('/operations');

    // An unauthenticated visitor must never see protected page content, whether
    // the client-side auth gate is still resolving or has already redirected.
    await expect(page.getByRole('heading', { name: 'The Ring' })).toHaveCount(0);
    await expect(page).toHaveURL(/\/login/, { timeout: 15000 });
  });
});
