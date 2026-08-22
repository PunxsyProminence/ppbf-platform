import { expect, test } from '@playwright/test';

/* There is no pixel baseline here, and the reason is worth writing down
   because it took three rounds to accept.

   A screenshot recorded on one machine and asserted on another does not work
   for this page. A diagnostic run inside CI showed why: per-section heights are
   identical for the header, hero and footer, but #programs comes out 23px
   taller on the runner and #technology 38px, and on desktop it is #mission that
   grows instead. Every font face and load state is byte-identical, so it is not
   fonts. CI installs Chrome for Testing 149 (playwright chromium v1228); other
   environments pin other revisions, and shaping shifts glyph advances just
   enough to move a wrap point. One extra line in a 1000px column is 31px.

   Narrowing to the hero fixed the geometry -- same dimensions both sides -- and
   then failed anyway on 11960 differing pixels, 5% of the image, against a 2%
   tolerance. That number is the end of the argument rather than an invitation
   to raise the threshold: a real regression here, a call-to-action changing
   colour, is about 4% of the same image. The noise and the signal are the same
   size, so no threshold catches one without swallowing the other. Cross-version
   pixel comparison needs a pinned browser, which is a container change.

   What replaces it is better suited to this codebase anyway. Every defect this
   branch actually found was a wrong token, a failing contrast ratio or an
   undersized target -- none of which needs pixels to detect, and all of which
   are computed-style facts that hold across browser revisions. So the checks
   below assert the design system's own laws on the page a stranger sees first:
   Law 2 (saturated colour means safety, nothing else), the AA contrast floor,
   and Law 5's target floor.

   Two dead theories, recorded so they are not retried. Chromium rasterisation
   was raised first and dismissed as too small to matter -- it was right, by way
   of shaping rather than anti-aliasing. Fonts came second: ppbf.css named four
   faces and only --font-stencil pointed at a real one, and CDP confirmed 614
   glyphs coming off DejaVu Sans Mono. Self-hosting them was a genuine bug worth
   fixing and moved this number by nothing (127047 -> 128101 differing pixels). */

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

  });

  test('holds the design system laws a stranger sees first', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: /Boxing is the engagement platform/i })).toBeVisible();

    const audit = await page.evaluate(() => {
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

    // Law 2 — the safety gate's red belongs to the safety gate.
    expect(audit.painted, 'elements painted the safety red on a public page').toEqual([]);

    // WCAG 1.4.3.
    const failures = audit.lowContrast
      .map((row) => JSON.parse(row) as { label: string; fg: string; bg: string; floor: number })
      .filter((row) => contrast(row.fg, row.bg) < row.floor)
      .map((row) => `${row.label} — ${contrast(row.fg, row.bg).toFixed(2)}:1, needs ${row.floor}:1`);
    expect(failures, 'text under the AA contrast floor').toEqual([]);

    // WCAG 2.5.5, which Law 5 restates as the kiosk floor. Inline links inside
    // running text are exempt and are filtered out above.
    expect(audit.smallTargets, 'interactive targets under 44px').toEqual([]);
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
    //
    // Both sign-in methods are the contract, and the approved board (AF-01,
    // AF-M02) makes that literal: there is no longer a method picker to
    // choose between, so neither method greets you at the other's expense.
    // Every way in is on the page at once.
    await expect(page.getByRole('button', { name: 'Continue With Microsoft' })).toBeVisible();
    await expect(page.getByLabel(/Account ID/i).first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sign In', exact: true })).toBeVisible();
  });

  test('protected routes still require authentication', async ({ page }) => {
    await page.goto('/operations');

    // An unauthenticated visitor must never see protected page content, whether
    // the client-side auth gate is still resolving or has already redirected.
    await expect(page.getByRole('heading', { name: 'The Ring' })).toHaveCount(0);
    await expect(page).toHaveURL(/\/login/, { timeout: 15000 });
  });
});
