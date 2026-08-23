import { expect, test, type Page } from '@playwright/test';

/* There is no pixel baseline here. The reason is written out at the top of
   e2e/public-homepage.spec.ts: Chromium shaping moves wrap points between
   revisions by roughly the same number of pixels a real regression does, so
   no ratio separates noise from signal. What replaces it is the same
   computed-style audit that file already runs on / — Law 2, the AA contrast
   floor, and Law 5's 44×44 target floor — pointed at the two public store
   surfaces.

   The shop is fetched. These tests hold the API still at the network
   boundary so an empty database, a down origin, or a gym with nothing listed
   cannot make the visual audit look at the loading skeleton or the empty
   sentence instead of the catalogue. */

const relativeLuminance = (css: string) => {
  const [r, g, b] = css.match(/\d+(\.\d+)?/g)!.slice(0, 3).map(Number)
    .map((v) => v / 255)
    .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (fg: string, bg: string) => {
  const [hi, lo] = [relativeLuminance(fg), relativeLuminance(bg)].sort((a, b) => b - a);
  return (hi + 0.05) / (lo + 0.05);
};

const LISTED_GYM = {
  organization_id: 'org-1',
  organization_name: 'Punxsy Prominence',
  listed_product_count: 3,
};

const LISTED_PRODUCTS = [
  {
    product_id: 'gloves-12oz',
    name: 'Training gloves 12oz',
    brand: 'Everlast',
    description: '12 ounce training gloves.',
    category: 'gloves',
    retail_price_cents: 4000,
    availability: 'in_stock',
    checkout_url: 'https://example.test/buy',
  },
  {
    product_id: 'wraps',
    name: 'Hand wraps',
    brand: '',
    description: '',
    category: 'wraps',
    retail_price_cents: 1200,
    availability: 'order_only',
    checkout_url: '',
  },
  {
    product_id: 'mouthguard',
    name: 'Mouthguard',
    brand: '',
    description: '',
    category: 'protection',
    retail_price_cents: 800,
    availability: 'unavailable',
    checkout_url: 'https://example.test/buy',
  },
];

async function stubStore(page: Page) {
  await page.route('**/api/public/store**', async (route) => {
    const url = new URL(route.request().url());
    const organizationId = url.searchParams.get('organization_id');
    if (organizationId) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          organization_id: organizationId,
          products: LISTED_PRODUCTS,
        }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ stores: [LISTED_GYM] }),
    });
  });
}

async function auditPage(page: Page) {
  return page.evaluate(() => {
    const painted: string[] = [];
    const lowContrast: string[] = [];
    const smallTargets: string[] = [];

    /* Returns the flat colour behind an element, or null when there isn't
       one to name. A computed style cannot composite a gradient or blend a
       translucent layer, and ppbf's materials are built from both, so this
       has to refuse rather than guess. Getting that wrong in the other
       direction is not theoretical: reading .btn's transparent background
       instead of its brass gradient reports 1.59:1 for a button that
       measures 9.6:1 in actual pixels. */
    const backdrop = (el: Element): string | null => {
      for (let node: Element | null = el; node; node = node.parentElement) {
        const cs = getComputedStyle(node);
        if (cs.backgroundImage !== 'none') return null;
        // Parse the alpha rather than splitting on commas. `rgba(0, 0, 0,
        // 0.043)`.split(',')[3] is " 0.043)" — the closing paren rides along
        // and Number() gives NaN, so neither the ===1 nor the >0 branch fires
        // and the walker keeps climbing past a translucent layer. That is the
        // exact opposite of the refusal this function is supposed to perform.
        const parts = cs.backgroundColor.match(/[\d.]+/g);
        const alpha = parts && parts.length > 3 ? Number(parts[3]) : 1;
        if (alpha === 1) return cs.backgroundColor;
        if (alpha > 0) return null;
      }
      return null;
    };

    for (const el of document.querySelectorAll('body *')) {
      const cs = getComputedStyle(el);
      const label = `<${el.tagName.toLowerCase()}> ${(el.textContent || '').trim().slice(0, 30)}`;

      // rgb(168,30,34) is #A81E22, --locked. Law 2 reserves it for the safety
      // gate, so it has no business on a page whose entire audience is
      // strangers with no athlete to be locked. The literal is inlined
      // because this callback is serialised into the browser and cannot close
      // over anything declared out here.
      const isSafetyRed = (c: string) => /rgba?\(168,\s*30,\s*34/.test(c);
      if (isSafetyRed(cs.color) || isSafetyRed(cs.backgroundColor)) {
        painted.push(label);
      }

      // Only where the element owns its text and sits on a nameable colour.
      const ownsText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent!.trim());
      const bg = ownsText ? backdrop(el) : null;
      if (bg) {
        const size = parseFloat(cs.fontSize);
        const large = size >= 24 || (size >= 18.66 && Number(cs.fontWeight) >= 700);
        lowContrast.push(JSON.stringify({ label, fg: cs.color, bg, floor: large ? 3 : 4.5 }));
      }

      if (el.matches('a[href], button, input:not([type=hidden]), select, textarea')) {
        const r = el.getBoundingClientRect();
        const inline = el.tagName === 'A' && cs.display === 'inline';
        // 2.5.5 is 44 by 44, not 44 tall. Height alone passes an icon-only
        // button that is 44 high and 20 wide, which is the shape most likely
        // to be too small in the first place.
        const tooSmall = r.height < 44 || r.width < 44;
        if (r.height > 0 && r.width > 0 && tooSmall && !inline) {
          smallTargets.push(`${label} = ${Math.round(r.width)}x${Math.round(r.height)}px`);
        }
      }
    }
    return { painted, lowContrast, smallTargets };
  });
}

function assertDesignLaws(
  audit: { painted: string[]; lowContrast: string[]; smallTargets: string[] },
) {
  expect(audit.painted, 'elements painted the safety red on a public page').toEqual([]);

  const failures = audit.lowContrast
    .map((row) => JSON.parse(row) as { label: string; fg: string; bg: string; floor: number })
    .filter((row) => contrast(row.fg, row.bg) < row.floor)
    .map((row) => `${row.label} — ${contrast(row.fg, row.bg).toFixed(2)}:1, needs ${row.floor}:1`);
  expect(failures, 'text under the AA contrast floor').toEqual([]);

  expect(audit.smallTargets, 'interactive targets under 44px').toEqual([]);
}

test.describe('Public store', () => {
  test('renders publicly at /store without requiring authentication', async ({ page }) => {
    await stubStore(page);
    const response = await page.goto('/store');
    expect(response?.ok(), 'Expected /store to return 2xx for an unauthenticated visitor').toBeTruthy();

    await expect(page).toHaveURL('/store');
    await expect(page.getByRole('heading', { name: 'Equipment' })).toBeVisible();
    await expect(page.getByText('Buying gear here supports the gym directly.')).toBeVisible();
    await expect(page.getByRole('link', { name: /Punxsy Prominence/i })).toHaveAttribute(
      'href',
      '/store/org-1',
    );

    await expect(page.locator('input[type="password"]')).toHaveCount(0);
    const cookies = await page.context().cookies();
    expect(cookies.filter((cookie) => /session/i.test(cookie.name))).toEqual([]);
  });

  test('renders one gym catalogue publicly at /store/[organizationId]', async ({ page }) => {
    await stubStore(page);
    const response = await page.goto('/store/org-1');
    expect(response?.ok(), 'Expected /store/org-1 to return 2xx for an unauthenticated visitor').toBeTruthy();

    await expect(page.getByRole('heading', { name: 'Equipment' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'All shops' })).toHaveAttribute('href', '/store');
    await expect(page.getByRole('heading', { name: 'Training gloves 12oz' })).toBeVisible();
    await expect(page.getByText('$40.00')).toBeVisible();
    await expect(page.getByText('In stock')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Buy' })).toHaveAttribute('rel', 'noopener noreferrer');
    await expect(page.getByText('Ask at the gym')).toHaveCount(2);
    await expect(page.getByRole('button', { name: 'Ask at the gym' })).toHaveCount(0);

    await expect(page.locator('input[type="password"]')).toHaveCount(0);
    const cookies = await page.context().cookies();
    expect(cookies.filter((cookie) => /session/i.test(cookie.name))).toEqual([]);
  });

  test('holds the design system laws at /store', async ({ page }) => {
    await stubStore(page);
    await page.goto('/store');
    await expect(page.getByRole('heading', { name: 'Equipment' })).toBeVisible();
    await expect(page.getByRole('link', { name: /Punxsy Prominence/i })).toBeVisible();
    assertDesignLaws(await auditPage(page));
  });

  test('holds the design system laws at /store/[organizationId]', async ({ page }) => {
    await stubStore(page);
    await page.goto('/store/org-1');
    await expect(page.getByRole('heading', { name: 'Training gloves 12oz' })).toBeVisible();
    assertDesignLaws(await auditPage(page));
  });

  test('does not scroll sideways at 360px', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 800 });
    await stubStore(page);
    await page.goto('/store/org-1');
    await expect(page.getByRole('heading', { name: 'Training gloves 12oz' })).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    );
    expect(overflow, 'horizontal scroll at 360px').toBe(false);
  });
});
