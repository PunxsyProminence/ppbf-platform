import { expect, test } from '@playwright/test';

/* The full-page baseline below only works because every glyph on the page now
   comes from a file in this repo.

   It did not, at first. Wired into CI on baselines recorded in a dev
   container, CI rendered the same page 60px taller -- 412x3620 expected,
   412x3680 received -- deterministically on both sides, two retries producing
   byte-identical diffs. The cause was in the sheet: ppbf.css named four faces
   and only --font-stencil had been pointed at a real one, so .t-eyebrow,
   .t-data and .badge were still set in system stacks (Inter, ui-monospace,
   SFMono, Consolas). Text set in a font the repo does not ship wraps at
   machine-dependent widths, and the page ends up a different height.

   Those three now alias to the faces next/font already self-hosts, so layout
   no longer depends on what a machine has installed. Verified by walking every
   element on four routes: the only text run that does not resolve to a loaded
   face is <title>, which lives in <head> and is never painted.

   Worth knowing if this fails in future: a size mismatch fails BEFORE
   maxDiffPixelRatio is consulted, so the 2% tolerance in playwright.config.ts
   covers rasterisation between Chromium revisions and nothing else. A height
   difference means something reintroduced a font the repo does not ship, or
   the page genuinely changed. */
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

    await expect(page).toHaveScreenshot('public-homepage.png', { fullPage: true });
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
