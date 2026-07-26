import { expect, test } from '@playwright/test';

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
    await expect(page.getByText('Sign in with Account ID/PIN or Microsoft.')).toBeVisible();
  });

  test('protected routes still require authentication', async ({ page }) => {
    await page.goto('/operations');

    // An unauthenticated visitor must never see protected page content, whether
    // the client-side auth gate is still resolving or has already redirected.
    await expect(page.getByRole('heading', { name: 'The Ring' })).toHaveCount(0);
    await expect(page).toHaveURL(/\/login/, { timeout: 15000 });
  });
});
