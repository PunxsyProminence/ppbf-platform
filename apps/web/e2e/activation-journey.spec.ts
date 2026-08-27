import { expect, test } from '@playwright/test';

import { installPilotApi } from './support/signIn';

/* THE JOURNEY NOTHING COVERED.
   ------------------------------------------------------------------------

   `grep -rln "activat" apps/web/e2e/` returned nothing before this file. That
   is a gap with a particular shape: activation is the ONLY way a new athlete
   gets into the product. createAthleteAccount inserts pin_hash null and
   active_flag false, so until a one-time code is redeemed at /activate the
   account cannot sign in at all. The first thing every athlete does was the
   one journey no browser test walked.

   Three defects lived in here at once and each was found by reading, not by a
   failing test, because there was no test to fail:

     * /athlete/sign-in never linked to /activate, so an athlete holding a code
       had a form that would refuse them and nowhere to go (#685).
     * a refused PIN threw the athlete back to the CODE step and charged the
       failure against the activation-code brute-force budget, so trying
       111111 then 123123 then 112233 could rate-limit them out of their own
       activation without ever mistyping the code (#684).
     * the PIN rules were never stated -- the screen said "6 numbers" while
       the policy refused six shapes (#685).

   This spec walks the whole thing end to end, in a real browser, in the order
   an athlete meets it.

   WHY THE ACTIVATE ENDPOINT IS STUBBED SEPARATELY. installPilotApi fulfils
   every table entry with status 200, and the interesting half of this journey
   is a 400. Playwright matches routes in reverse registration order, so the
   handler registered AFTER it wins for this one path -- which is also why it
   is registered second rather than relying on any ordering left implicit.

   The stub answers from the request body, so what it returns depends on what
   the browser actually sent. A test that returned a refusal regardless of the
   PIN would still pass against a page that sent the wrong field. */

const CODE = 'ABCD-2345-EFGH';
const TRIVIAL_PIN = '112233';
const GOOD_PIN = '284917';

/** The refusal validatePinPolicy raises for a doubled-digit PIN, in the shape
    jsonError puts on the wire: a message plus the machine code the client
    reads. The message deliberately does NOT begin with "PIN" -- that is the
    whole reason the prefix test it replaced was wrong. */
const TRIVIAL_PIN_REFUSAL = {
  error: 'That PIN is too easy to guess. Avoid repeated digits, runs, and simple patterns.',
  code: 'PIN_TRIVIALLY_GUESSABLE',
};

async function stubActivation(page: import('@playwright/test').Page) {
  await installPilotApi(page, { session: null });

  await page.route('**/api/pilot/auth/activate', async (route) => {
    const body = route.request().postDataJSON() as { code?: string; pin?: string };

    // Answering off the submitted PIN rather than unconditionally: a stub that
    // refused every request would pass even if the page sent no PIN at all.
    if (body?.pin === TRIVIAL_PIN) {
      await route.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify(TRIVIAL_PIN_REFUSAL),
      });
      return;
    }

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, account_id: 'ath-gate-1', signed_in: true }),
    });
  });
}

test.describe('an athlete activating their account', () => {
  test('can reach /activate from the sign-in page they land on', async ({ page }) => {
    await stubActivation(page);
    await page.goto('/athlete/sign-in');

    // The PIN form stays first -- a returning athlete is the common case and
    // must not have to read past the activation offer to reach it.
    await expect(page.getByLabel('Athlete Account ID')).toBeVisible();

    await page.getByRole('link', { name: /set up your sign-in/i }).click();

    await expect(page).toHaveURL(/\/activate$/);
    await expect(page.getByLabel('Activation code')).toBeVisible();
  });

  test('is told the PIN rules before typing one, not after being refused', async ({ page }) => {
    await stubActivation(page);
    await page.goto('/activate');

    await page.getByLabel('Activation code').fill(CODE);
    await page.getByRole('button', { name: /continue/i }).click();

    // The four shapes the screen used to refuse without warning. An athlete
    // who reads this knows 112233 will not be accepted before they try it.
    const rules = page.getByText(/not all the same, not in counting order/i);
    await expect(rules).toBeVisible();
    for (const refused of ['111111', '123456', '121212', '112233', '123321']) {
      await expect(rules).toContainText(refused);
    }
  });

  test('a refused PIN is correctable in place and does not send them back to the code', async ({ page }) => {
    await stubActivation(page);
    await page.goto('/activate');

    await page.getByLabel('Activation code').fill(CODE);
    await page.getByRole('button', { name: /continue/i }).click();

    await page.getByLabel(/^Choose your PIN$/).fill(TRIVIAL_PIN);
    await page.getByLabel(/^Type it again$/).fill(TRIVIAL_PIN);
    await page.getByRole('button', { name: /activate/i }).click();

    // The refusal is shown, in the athlete's own words.
    await expect(page.getByText(/too easy to guess/i)).toBeVisible();

    // And they are still on the PIN step. This is the assertion that matters:
    // before #684 this refusal cleared both PIN fields and returned them to
    // the code screen, where the error they were shown was about a PIN and the
    // slip in their hand looked like the problem.
    await expect(page.getByLabel(/^Choose your PIN$/)).toBeVisible();
    await expect(page.getByLabel('Activation code')).toBeHidden();
  });

  test('completes activation once the PIN is acceptable', async ({ page }) => {
    await stubActivation(page);
    await page.goto('/activate');

    await page.getByLabel('Activation code').fill(CODE);
    await page.getByRole('button', { name: /continue/i }).click();

    // Refused first, then corrected without reloading -- the real sequence,
    // rather than a clean path that never meets the guard.
    await page.getByLabel(/^Choose your PIN$/).fill(TRIVIAL_PIN);
    await page.getByLabel(/^Type it again$/).fill(TRIVIAL_PIN);
    await page.getByRole('button', { name: /activate/i }).click();
    await expect(page.getByText(/too easy to guess/i)).toBeVisible();

    await page.getByLabel(/^Choose your PIN$/).fill(GOOD_PIN);
    await page.getByLabel(/^Type it again$/).fill(GOOD_PIN);
    await page.getByRole('button', { name: /activate/i }).click();

    await expect(page.getByText('ath-gate-1')).toBeVisible();
  });

  test('never puts the one-time code in a URL', async ({ page }) => {
    await stubActivation(page);

    const urlsSeen: string[] = [];
    page.on('request', (request) => urlsSeen.push(request.url()));

    await page.goto('/activate');
    await page.getByLabel('Activation code').fill(CODE);
    await page.getByRole('button', { name: /continue/i }).click();
    await page.getByLabel(/^Choose your PIN$/).fill(GOOD_PIN);
    await page.getByLabel(/^Type it again$/).fill(GOOD_PIN);
    await page.getByRole('button', { name: /activate/i }).click();

    await expect(page.getByText('ath-gate-1')).toBeVisible();

    // A one-time credential in a URL leaks into browser and proxy history,
    // Referer headers and access logs, and is trivially forwardable. The page
    // documents this as deliberate; nothing asserted it until now.
    expect(urlsSeen.filter((url) => url.includes('ABCD'))).toEqual([]);
    expect(page.url()).not.toContain('ABCD');
  });
});
