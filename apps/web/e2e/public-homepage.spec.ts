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
   the AA contrast floor and Law 5's target floor. (A third check refused the
   safety gate's red here until red stopped being reserved, OD-2026-09-29-001.)

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
      return { lowContrast, smallTargets };
    });

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

  /* NO TEXT ON THE PHOTOGRAPH AT THE DOOR.
     The sign-in page stands on a plate, and the plate changes with the screen:
     dark timber in landscape, a light grey wall in portrait. Until 2026-10-02
     the help copy, the athlete-door link and the work axis were painted in
     near-white straight onto it, and measured 3.2-4.0:1 on every upright
     screen while reading fine on a desktop -- which is why nothing caught it.

     This does not pin how the page looks. It asks two things of every piece of
     text inside <main>, at a desktop, an upright tablet and a phone:
       1. it stands on something OPAQUE the page painted for it -- a panel, a
          card, a button -- and not on the page ground, where the photograph
          is what is behind it. A tint or a see-through scrim does not count:
          the photograph still shows through it;
       2. where that ground is a flat colour (with any tints over it
          composited in), the ink reads against it.
     WHAT THIS DOES NOT MEASURE. An opaque gradient or textured ground -- the
     parchment card, the brass buttons -- cannot be named by a computed style,
     so text on those gets check 1 and not check 2; `npm run sweep` reads
     those off pixels. Error, sent-link, hover and focus states are not
     exercised. Text that overflows its panel, or a panel drawn on a
     pseudo-element, is beyond a computed-style walk. */
  test('sign-in page puts no text straight onto the wall, at any screen shape', async ({ page }) => {
    const shapes = [
      { name: 'desktop', width: 1280, height: 720 },
      { name: 'upright tablet', width: 810, height: 1080 },
      { name: 'phone', width: 390, height: 844 },
    ];
    /* A LIVE NOTICE IS PART OF THE PAGE. The notice column is empty unless the
       gym has posted one, and an empty column passes anything. The first cut
       of the panel fix shipped a notice nobody could read (1.07:1) precisely
       because no test ever saw one. So one is put on the page, through the
       same public feed the page reads. */
    const notice = 'Gym closed Saturday for the regional show.';
    await page.route('**/api/pilot/announcements/public**', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        announcements: [{
          announcement_id: 'e2e-notice',
          message: notice,
          author_name: 'Coach Sample',
          author_role: 'coach',
          created_at: new Date().toISOString(),
          placement: 'gym_notices',
          kind: 'notice',
          active: true,
          starts_at: null,
          ends_at: null,
        }],
      }),
    }));

    for (const shape of shapes) {
      await page.setViewportSize({ width: shape.width, height: shape.height });
      await page.goto('/login');
      await expect(page.getByRole('heading', { name: 'The Bell' })).toBeVisible();
      await expect(page.getByText(notice)).toBeVisible();

      const audit = await page.evaluate(() => {
        const main = document.querySelector('main');
        const onTheWall: string[] = [];
        const onFlat: string[] = [];
        if (!main) return { onTheWall: ['no <main> on the page'], onFlat, checked: 0 };
        let checked = 0;

        for (const el of main.querySelectorAll('*')) {
          const ownsText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent!.trim());
          if (!ownsText) continue;
          // WCAG 1.4.3 exempts inactive controls, and a disabled button is
          // greyed out on purpose.
          if (el.closest(':disabled, [aria-disabled="true"]')) continue;
          const cs = getComputedStyle(el);
          const box = el.getBoundingClientRect();
          if (cs.visibility === 'hidden' || cs.display === 'none' || box.width === 0 || box.height === 0) continue;
          checked += 1;
          const label = `<${el.tagName.toLowerCase()}> ${(el.textContent || '').trim().slice(0, 30)}`;

          // Walk up to the first OPAQUE thing painted behind this text, short
          // of the page itself. Only an opaque ground ends the walk: a tint, a
          // scrim or a see-through gradient lets the photograph show, so it is
          // composited and the walk carries on. Reaching <main> without an
          // opaque ground means the text is on the wall, however many
          // translucent layers sit in between.
          let ground: { flat: string | null } | null = null;
          let inkOpacity = 1;
          let unnameable = false;
          const tints: Array<[number, number, number, number]> = [];
          for (let node: Element | null = el; node && node !== main; node = node.parentElement) {
            const style = getComputedStyle(node);
            const nodeOpacity = Number(style.opacity);
            const parts = (style.backgroundColor.match(/[\d.]+/g) ?? []).map(Number);
            const alpha = (parts.length > 3 ? parts[3] : 1) * nodeOpacity;
            const painted = style.backgroundColor !== 'rgba(0, 0, 0, 0)' && alpha > 0;
            const image = style.backgroundImage;
            if (image !== 'none') {
              // A photograph, or a gradient with no see-through stop, is a
              // ground this check cannot name. A see-through gradient is not a
              // ground at all.
              const seeThrough = !image.includes('url(') && /rgba\(|transparent/.test(image);
              if (!seeThrough && nodeOpacity === 1) { ground = { flat: null }; break; }
              unnameable = true;
            }
            if (painted && alpha === 1) {
              let [r, g, bl] = parts;
              for (const [tr, tg, tb, ta] of tints.reverse()) {
                r = tr * ta + r * (1 - ta);
                g = tg * ta + g * (1 - ta);
                bl = tb * ta + bl * (1 - ta);
              }
              ground = { flat: unnameable ? null : `rgb(${Math.round(r)}, ${Math.round(g)}, ${Math.round(bl)})` };
              break;
            }
            if (painted) tints.push([parts[0], parts[1], parts[2], alpha]);
            // Opacity below the ground fades the ink into it.
            inkOpacity *= nodeOpacity;
          }
          const opacity = inkOpacity;

          if (!ground) { onTheWall.push(label); continue; }
          if (ground.flat) {
            const size = parseFloat(cs.fontSize);
            const large = size >= 24 || (size >= 18.66 && Number(cs.fontWeight) >= 700);
            // -webkit-text-fill-color paints the glyphs when it is set; it
            // defaults to `color`.
            const ink = cs.webkitTextFillColor || cs.color;
            onFlat.push(JSON.stringify({ label, fg: ink, bg: ground.flat, opacity, floor: large ? 3 : 4.5 }));
          }
        }
        return { onTheWall, onFlat, checked };
      });

      // A page with no text would pass both checks below by saying nothing.
      expect(audit.checked, `${shape.name}: text found to check`).toBeGreaterThan(10);
      expect(audit.onTheWall, `${shape.name}: text painted straight onto the page ground`).toEqual([]);
      // And the contrast half below must have something to measure.
      expect(audit.onFlat.length, `${shape.name}: text on a nameable flat ground`).toBeGreaterThan(5);

      const failures = audit.onFlat
        .map((row) => JSON.parse(row) as { label: string; fg: string; bg: string; opacity: number; floor: number })
        .map((row) => {
          // An element at opacity < 1 shows its ground through its ink.
          const mix = (channel: number, behind: number) => Math.round(channel * row.opacity + behind * (1 - row.opacity));
          const fg = (row.fg.match(/[\d.]+/g) ?? []).map(Number);
          const bg = (row.bg.match(/[\d.]+/g) ?? []).map(Number);
          const seen = `rgb(${mix(fg[0], bg[0])}, ${mix(fg[1], bg[1])}, ${mix(fg[2], bg[2])})`;
          return { ...row, ratio: contrast(seen, row.bg) };
        })
        .filter((row) => row.ratio < row.floor)
        .map((row) => `${row.label} — ${row.ratio.toFixed(2)}:1, needs ${row.floor}:1`);
      expect(failures, `${shape.name}: text under the AA contrast floor on its own panel`).toEqual([]);
    }
  });

  /* One front page (Jason, 2026-10-03: "home page and public is the same
     page"). Updated deliberately: /public used to be its own portal and is now
     a permanent forward, and its interest form lives on / without a consent
     checkbox -- sending it is the request to be contacted. */
  test('/public forwards permanently to the front page', async ({ page, request }) => {
    const direct = await request.get('/public', { maxRedirects: 0 });
    expect(direct.status()).toBe(308);
    expect(direct.headers()['location']).toMatch(/\/$/);

    await page.goto('/public');
    await expect(page).toHaveURL('/');
    await expect(page.getByRole('heading', { name: /Boxing is the engagement platform/i })).toBeVisible();
  });

  test('the interest form on / sends with no consent checkbox', async ({ page }) => {
    let sent: Record<string, unknown> | null = null;
    await page.route('**/api/pilot/public-interest', async (route) => {
      sent = route.request().postDataJSON();
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });

    await page.goto('/#interest-intake');
    const form = page.locator('#interest-intake form');
    await expect(form.locator('input[type="checkbox"]')).toHaveCount(0);
    await form.getByLabel('Your name').fill('Pat Example');
    await form.getByLabel('Email').fill('pat@example.com');
    await form.getByRole('button', { name: 'Send this to a coach' }).click();

    await expect(form.getByRole('status')).toContainText('Got it');
    expect(sent).toMatchObject({ full_name: 'Pat Example', email: 'pat@example.com' });
    expect(sent).not.toHaveProperty('consent_to_contact');
    await expect(form.getByText('We use what you send only to answer you.', { exact: false })).toBeVisible();
  });

  test('protected routes still require authentication', async ({ page }) => {
    await page.goto('/operations');

    // An unauthenticated visitor must never see protected page content, whether
    // the client-side auth gate is still resolving or has already redirected.
    await expect(page.getByRole('heading', { name: 'The Ring' })).toHaveCount(0);
    await expect(page).toHaveURL(/\/login/, { timeout: 15000 });
  });
});
