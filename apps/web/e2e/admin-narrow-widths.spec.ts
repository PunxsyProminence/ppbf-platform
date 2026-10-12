import { expect, test } from '@playwright/test';
import { installPilotApi, openSignedIn } from './support/signIn';
import { ADMIN_NARROW_PAGES } from './support/adminNarrowFixtures';

/* Nine admin pages, at the widths a gym's Android tablet and a phone use
   (#1482 item 5). The live audit measured eight of them wider than the screen
   at 460px and /admin/people clipping its table title at 375px.

   What this owns: the PAGE never scrolls sideways. A wide table may scroll
   inside its own box -- that is the fix, not the fault -- so this asserts on
   the document, not on every element. Each page gets realistic rows (long
   names, emails, ids, notes; support/adminNarrowFixtures.ts), because an empty
   page cannot show what real data pushes past the edge.

   What it does not own: how any of it looks. Geometry only. */

const WIDTHS = [375, 460, 768] as const;

for (const entry of ADMIN_NARROW_PAGES) {
  for (const width of WIDTHS) {
    test(`${entry.path} does not scroll sideways at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await installPilotApi(page, { session: { role: 'organization_admin' }, routes: entry.routes as never });
      await openSignedIn(page, entry.path);
      await expect(page.getByText(entry.expectText)).toBeVisible();

      // Against the width asked for, not innerWidth: under a mobile emulation
      // innerWidth grows to fit the content, and a page wider than the screen
      // would pass.
      const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
      expect(scrollWidth).toBeLessThanOrEqual(width);
    });
  }
}

test('/admin/people keeps its table title on screen at 375px while the table scrolls', async ({ page }) => {
  const entry = ADMIN_NARROW_PAGES.find((candidate) => candidate.page === 'people');
  if (!entry) throw new Error('people fixture missing');
  await page.setViewportSize({ width: 375, height: 900 });
  await installPilotApi(page, { session: { role: 'organization_admin' }, routes: entry.routes as never });
  await openSignedIn(page, entry.path);
  await expect(page.getByText(entry.expectText)).toBeVisible();

  const title = page.locator('table.ledger caption span');
  await expect(title).toHaveText('Everyone in this gym');
  const box = await title.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(375);

  // Scroll the table's own box to its far edge: the title is still in view.
  await page.locator('table.ledger').evaluate((table) => {
    const scroller = table.parentElement as HTMLElement;
    scroller.scrollLeft = scroller.scrollWidth;
  });
  const after = await title.boundingBox();
  expect(after!.x).toBeGreaterThanOrEqual(0);
  expect(after!.x + after!.width).toBeLessThanOrEqual(375);
});
