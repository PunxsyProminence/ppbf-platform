import { expect, test } from '@playwright/test';

import { installPilotApi } from './support/signIn';

/**
 * VIZ-1 in a real browser: a coach runs one authored scenario end to end.
 *
 * This is the runtime journey the jsdom tests cannot give -- the route really
 * renders behind the real access gate, the authored order really advances under
 * clicks, and the network log really shows that nothing is written. The session
 * is stubbed the way every other coach journey here stubs it; the page itself
 * is unstubbed, because it asks the server for nothing.
 */

const ROUTE = '/coach/visualization';

test.describe('Coach guided visualization', () => {
  test('a coach opens one scenario and runs it through to session complete, writing nothing', async ({ page }) => {
    await installPilotApi(page, { session: { role: 'coach' } });

    // Every request the page makes, so "no product write" is observed, not assumed.
    const writes: string[] = [];
    page.on('request', (request) => {
      const method = request.method();
      if (method === 'GET' || method === 'HEAD') return;
      if (new URL(request.url()).pathname === '/api/pilot/auth/session') return;
      writes.push(`${method} ${request.url()}`);
    });

    await page.goto(ROUTE);

    // The gate let the coach stand here, and the surface is the one asked for.
    await expect(page).toHaveURL(new RegExp(`${ROUTE}$`));
    await expect(page.getByText('Checking access')).toHaveCount(0);
    await expect(page.getByRole('heading', { level: 1, name: 'Guided Visualization' })).toBeVisible();

    // Scenario identity and content source are readable, secondary to the prompt.
    await expect(page.getByText('PF-001 · The Ring-Cutter · Pressure Fighter · Foundation · 1 OF 17')).toBeVisible();
    await expect(
      page.getByText(/Adaptive_Amateur_Boxing_Visualization_Curriculum_100_Scenarios\.docx/),
    ).toBeVisible();

    // It opens on the delivery-level choice, carrying the manual's own rules.
    const prompt = page.getByRole('heading', { level: 2 });
    await expect(prompt).toHaveText('Choose how you will deliver it');
    await expect(page.getByText('1 — Guided')).toBeVisible();
    await expect(page.getByText('2 — Decision')).toBeVisible();
    await expect(page.getByText('3 — Adaptive / Scored')).toBeVisible();
    await expect(page.getByText('See the cue before the answer', { exact: false })).toBeVisible();

    // The coach picks ONE level for the whole exposure, then it begins.
    await page.getByRole('button', { name: 'Run at Level 1' }).click();
    await expect(prompt).toHaveText('Before the Bell — Build the Opponent');
    await expect(page.getByText('Step 1 of 22')).toBeVisible();
    await expect(page.getByText('Picture a patient ring-cutter in a orthodox stance.', { exact: false })).toBeVisible();

    // Pause holds the fight where it is.
    await page.getByRole('button', { name: 'Pause' }).click();
    await expect(page.getByRole('button', { name: 'Next prompt' })).toBeDisabled();
    await expect(page.getByText('Paused.', { exact: false })).toBeVisible();
    await page.getByRole('button', { name: 'Resume' }).click();
    await expect(page.getByRole('button', { name: 'Next prompt' })).toBeEnabled();

    // Walk the authored order to the debrief, collecting each prompt.
    const promptText = async () => ((await prompt.textContent()) ?? '').trim();
    const delivered: string[] = [await promptText()];
    for (let step = 0; step < 30; step += 1) {
      const next = page.getByRole('button', { name: 'Next prompt' });
      if (!(await next.isVisible())) break;
      await next.click();
      delivered.push(await promptText());
      if (delivered[delivered.length - 1] === 'Session complete') break;
    }

    expect(delivered).toEqual([
      'Before the Bell — Build the Opponent',
      'Key visual cues',
      'Common athlete mistakes',
      'What am I fighting?',
      'The opponent acts',
      'Ask the athlete',
      'Coach guidance',
      'Continue the fight',
      'Corner note',
      'How can I use what I discovered?',
      'The opponent acts',
      'Ask the athlete',
      'Coach guidance',
      'Continue the fight',
      'Corner note',
      'Can I solve an opponent who is now trying to solve me?',
      'The opponent acts',
      'Ask the athlete',
      'Coach guidance',
      'Continue the fight',
      'Post-Fight Debrief',
      'Session complete',
    ]);

    // Session complete says the exposure happened and refuses the rest.
    await expect(page.getByText('You reached the authored debrief', { exact: false })).toBeVisible();
    await expect(page.getByText('does not say the athlete has learned to', { exact: false })).toBeVisible();
    await expect(page.getByText('nothing here was recorded', { exact: false })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Next prompt' })).toHaveCount(0);

    // Nothing was written anywhere, the whole way through.
    expect(writes).toEqual([]);
  });

  test('the debrief takes words that a refresh throws away', async ({ page }) => {
    await installPilotApi(page, { session: { role: 'coach' } });
    await page.goto(ROUTE);

    const prompt = page.getByRole('heading', { level: 2 });
    const promptText = async () => ((await prompt.textContent()) ?? '').trim();
    await page.getByRole('button', { name: 'Run at Level 1' }).click();
    for (let step = 0; step < 30; step += 1) {
      if ((await promptText()) === 'Post-Fight Debrief') break;
      await page.getByRole('button', { name: 'Next prompt' }).click();
    }
    await expect(prompt).toHaveText('Post-Fight Debrief');

    const firstAnswer = page.getByRole('textbox').first();
    await firstAnswer.fill('He cut the lane before he punched.');
    await expect(firstAnswer).toHaveValue('He cut the lane before he punched.');

    await page.reload();

    // A refresh is a new unsaved exposure: back at the level choice, nothing kept.
    await expect(prompt).toHaveText('Choose how you will deliver it');
    await page.getByRole('button', { name: 'Run at Level 1' }).click();
    for (let step = 0; step < 30; step += 1) {
      if ((await promptText()) === 'Post-Fight Debrief') break;
      await page.getByRole('button', { name: 'Next prompt' }).click();
    }
    await expect(page.getByRole('textbox').first()).toHaveValue('');
  });

  test('rebuilding the picture goes back to the opponent and returns to the same prompt', async ({ page }) => {
    await installPilotApi(page, { session: { role: 'coach' } });
    await page.goto(ROUTE);

    await page.getByRole('button', { name: 'Run at Level 1' }).click();
    for (let step = 0; step < 4; step += 1) {
      await page.getByRole('button', { name: 'Next prompt' }).click();
    }
    const prompt = page.getByRole('heading', { level: 2 });
    await expect(prompt).toHaveText('The opponent acts');
    await expect(page.getByText('Step 5 of 22')).toBeVisible();

    await page.getByRole('button', { name: 'Rebuild the picture' }).click();
    await expect(prompt).toHaveText('Before the Bell — Build the Opponent');

    await page.getByRole('button', { name: 'Back to Round 1 of 3 — DISCOVER' }).click();
    await expect(prompt).toHaveText('The opponent acts');
    await expect(page.getByText('Step 5 of 22')).toBeVisible();
  });

  test('the Level 1 options stay out of the script until the coach asks for them', async ({ page }) => {
    await installPilotApi(page, { session: { role: 'coach' } });
    await page.goto(ROUTE);

    await page.getByRole('button', { name: 'Run at Level 1' }).click();
    for (let step = 0; step < 5; step += 1) {
      await page.getByRole('button', { name: 'Next prompt' }).click();
    }
    await expect(page.getByRole('heading', { level: 2 })).toHaveText('Ask the athlete');
    await expect(page.getByText('not a list the coach must read aloud', { exact: false })).toBeVisible();
    await expect(page.getByText('Use the jab as a range and information tool', { exact: false })).toHaveCount(0);

    await page.getByRole('button', { name: 'Offer the response options' }).click();
    await expect(page.getByText('Use the jab as a range and information tool', { exact: false })).toBeVisible();
  });

  test('Level 3 delivers cues only, with no fed answer anywhere', async ({ page }) => {
    await installPilotApi(page, { session: { role: 'coach' } });
    await page.goto(ROUTE);

    await page.getByRole('button', { name: 'Run at Level 3' }).click();
    const prompt = page.getByRole('heading', { level: 2 });
    for (let step = 0; step < 4; step += 1) {
      await page.getByRole('button', { name: 'Next prompt' }).click();
    }
    await expect(prompt).toHaveText('Level 3 — Cue-Only Version');
    await expect(page.getByText('not a command-response drill', { exact: false })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Offer the response options' })).toHaveCount(0);
  });
});
