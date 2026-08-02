import { expect, test } from '@playwright/test';

/* The pixel check covers the masthead, not the whole page, and that is a
   deliberate limit rather than an oversight.

   A fullPage baseline recorded on one machine and asserted on another does not
   work here, and it took a diagnostic run inside CI to say why. Per-section
   heights, mobile:

     header 36   hero 660   mission 596   footer 247      identical
     #programs   1070 -> 1093                             +23 on the runner
     #technology  483 ->  521                             +38 on the runner

   Only the prose-heavy sections move, and on desktop it is #mission that grows
   instead. The font-face list and every load state are byte-identical between
   the two, so this is not fonts -- it is text shaping. CI installs Chrome for
   Testing 149 (playwright chromium v1228); other environments pin other
   revisions, and shaping shifts glyph advances just enough to move a wrap
   point. One extra line in a 1000px column is 31px of page height, and a size
   mismatch fails before maxDiffPixelRatio is ever consulted.

   Two earlier theories were wrong and worth recording so they are not retried.
   The first was Chromium rasterisation, dismissed as too small to matter -- it
   was right, via shaping rather than anti-aliasing. The second was fonts:
   ppbf.css named four faces and only --font-stencil pointed at a real one, and
   CDP confirmed 614 glyphs coming off DejaVu Sans Mono. Self-hosting those was
   a genuine bug worth fixing, and it moved this number by nothing at all
   (127047 differing pixels -> 128101).

   So the assertion targets the hero section, which measured 660px in both
   environments. Fixed dimensions mean the 2% tolerance in playwright.config.ts
   finally applies to what it was written for -- rasterisation -- and the check
   still fails loudly on the things worth catching there: the wordmark, the
   ground colour, the type ladder and both call-to-action buttons.

   Making the whole page assertable means pinning one browser revision for
   recording and asserting alike, which is a container, not a test change. */
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

    await expect(page.locator('main > section').first()).toHaveScreenshot('homepage-hero.png');
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
