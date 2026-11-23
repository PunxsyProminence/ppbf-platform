import { expect, test, type Page } from '@playwright/test';
import { installPilotApi } from './support/signIn';

/* The kiosk type floor, measured where it is felt: computed font-size in a
   real browser. kioskTypeFloor.test.ts reads the stylesheet and the source;
   this reads what Chromium resolves after the cascade, which is the only thing
   a child at the tablet sees (kiosk text-size sweep part B, lane
   KIOSK-SWEEP-B, 2026-11-23).

   Three layers, because the three kinds of line reach the screen differently:
   a class probe for the Training Card, whose route (/athlete/dashboard) is
   server-guarded and cannot load without a database; the real progression page
   for .gauge-cap and .stat-label with data in them; and the real coach home for
   the Tailwind text-xs lines in CoachWorkspace. */

const FLOOR_PX = 19.1;
const ATHLETE_ID = 'ath-rosa';

const GAP = {
  gap_id: 'gap-1', athlete_id: ATHLETE_ID, gap_type: 'guard_recovery',
  gap_description: 'Guard drops after the third punch.', severity: 'medium',
  status: 'assigned', created_at: '2026-08-18T10:00:00.000Z',
};
const assignment = (id: string, status: string, pct: number) => ({
  assignment_id: id, gap_id: GAP.gap_id, drill_name: `Return-to-guard rounds ${id}`,
  drill_description: 'Three rounds, hands back to the chin.', drill_difficulty: 'foundational',
  rep_count: 30, duration_minutes: 15, frequency_per_week: 3, due_date: '2026-09-26',
  completion_percentage: pct, status, created_at: '2026-08-18T10:00:00.000Z',
});

/* Floors to a 0.01px grid: 19.1px is stored as a rung, and the engine reports
   it back to a few decimals. */
async function fontSizes(page: Page, selector: string): Promise<number[]> {
  return page.locator(selector).evaluateAll((nodes) =>
    nodes.map((node) => Number.parseFloat(getComputedStyle(node).fontSize)));
}

async function pageScrollsSideways(page: Page): Promise<boolean> {
  return page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
}

test.describe('Kiosk type floor, in the browser', () => {
  test('the Training Card classes compute to 19.1px or more under a kiosk surface', async ({ page }) => {
    await installPilotApi(page, { session: null });
    await page.goto('/athlete/sign-in');
    await expect(page.locator('[data-surface="kiosk"]').first()).toBeAttached();
    // Hydration can replace nodes appended before it finishes; wait it out.
    await page.waitForLoadState('networkidle');

    const classes = [
      'tcard-sub', 'tcard-stamp', 'tcard-legend', 'stat-label', 'gauge-cap',
    ];
    await page.evaluate((names) => {
      const host = document.querySelector('[data-surface="kiosk"]') as HTMLElement;
      const probe = document.createElement('div');
      probe.id = 'kiosk-probe';
      for (const name of names) {
        const el = document.createElement('p');
        el.className = name;
        el.textContent = '10';
        probe.append(el);
      }
      const count = document.createElement('div');
      count.className = 'tcard-count';
      count.innerHTML = '<span>sessions logged</span>';
      const slot = document.createElement('div');
      slot.className = 'tcard-seal-slot';
      slot.innerHTML = '<span class="tcard-seal-lbl">34 · to go</span>';
      probe.append(count, slot);
      host.append(probe);
    }, classes);

    const sizes = await fontSizes(page, '#kiosk-probe p, #kiosk-probe span');
    expect(sizes).toHaveLength(classes.length + 2);
    for (const size of sizes) expect(size).toBeGreaterThanOrEqual(FLOOR_PX - 0.05);
  });

  test('progression: gauge caption and stat labels hold 19.1px without clipping or sideways scroll', async ({ page }) => {
    await installPilotApi(page, {
      session: { role: 'athlete', athleteId: ATHLETE_ID },
      routes: {
        '/api/pilot/progression/gaps': { ok: true, items: [GAP] },
        '/api/pilot/progression/assignments': {
          ok: true,
          items: [assignment('a1', 'in_progress', 40), assignment('a2', 'completed', 100)],
        },
      },
    });

    for (const viewport of [{ width: 1024, height: 768 }, { width: 412, height: 915 }]) {
      await page.setViewportSize(viewport);
      await page.goto('/athlete/progression-intelligence');
      await expect(page.locator('.stat-label').first()).toBeVisible();
      await expect(page.locator('.gauge-cap').first()).toBeVisible();

      for (const size of await fontSizes(page, '.gauge-cap, .stat-label')) {
        expect(size).toBeGreaterThanOrEqual(FLOOR_PX - 0.05);
      }
      expect(await pageScrollsSideways(page)).toBe(false);
    }
  });

  test('coach home: the escalation and family-barrier lines hold 19.1px', async ({ page }) => {
    await installPilotApi(page, { session: { role: 'coach' } });
    await page.goto('/coach/environment/intake-router');
    await expect(page.locator('[data-surface="kiosk"]').first()).toBeAttached();

    const lines = page.getByText(/No open escalations for your athletes|No guardian on your roster has reported/);
    await expect(lines.first()).toBeVisible();
    for (const size of await lines.evaluateAll((nodes) =>
      nodes.map((node) => Number.parseFloat(getComputedStyle(node).fontSize)))) {
      expect(size).toBeGreaterThanOrEqual(FLOOR_PX - 0.05);
    }
  });
});
