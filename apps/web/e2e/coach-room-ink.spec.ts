import { expect, test } from '@playwright/test';

import { installPilotApi } from './support/signIn';

/**
 * THE INK ON THE COACH ROOM'S LIGHT OBJECTS, MEASURED IN A REAL BROWSER.
 *
 * This exists because of a defect that shipped and that nothing caught.
 *
 * The coach board sets its inks BY ELEMENT -- `.coach-board h2`, `... p` --
 * because the board is dark slate and everything written on it is chalk. An
 * element selector outranks a class, so every rule the LIGHT objects set for
 * themselves lost silently. The attendance register's heading rendered
 * chalk-white on bone enamel. So did the clipboard titles in the room. I had
 * looked at that render, noticed the clipboards seemed faint, and written it
 * off as small type.
 *
 * WHY IT HAS TO BE A BROWSER. jsdom does not apply the stylesheet, so no unit
 * test in this repository can see a cascade failure. The bug was invisible to
 * 1,857 passing tests. It is only visible where the cascade actually runs.
 *
 * WHY IT MEASURES CONTRAST RATHER THAN COLOUR. A guard asserting
 * "`.rg-h` is #22180C" is the address-based rule this codebase has just spent a
 * day deleting: it pins one element to one value, says nothing about the next
 * light object somebody adds, and has to be edited for every legitimate retune.
 * A guard asserting "the text is not the same colour as its ground" passes on
 * text that is one shade off invisible. So it measures the WCAG contrast ratio,
 * which is the thing a coach's eye is actually subject to.
 *
 * It is deliberately a Coach regression, not a repository styling constitution.
 */

const ROUTE = '/coach/environment/intake-router';

/** WCAG relative luminance, and from it the contrast ratio. Written out rather
 *  than pulled in so the number this test fails on is inspectable here. */
const CONTRAST_FN = `
  (fg, bg) => {
    const parse = (c) => {
      const m = c.match(/rgba?\\(([^)]+)\\)/);
      if (!m) return null;
      const p = m[1].split(',').map((n) => parseFloat(n));
      return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
    };
    const lum = ({ r, g, b }) => {
      const f = (v) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
      };
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const a = parse(fg); const b = parse(bg);
    if (!a || !b) return null;
    const l1 = lum(a); const l2 = lum(b);
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  }
`;

test.describe('Coach room light objects stay legible', () => {
  test('every label on a bone surface has real contrast against the ground it sits on', async ({ page }) => {
    await installPilotApi(page, {
      session: { role: 'coach' },
      routes: {
        '/api/pilot/athletes/list': {
          items: [
            { athlete_id: 'ath_1', full_name: 'Jordan P.' },
            { athlete_id: 'ath_2', full_name: 'Sam R.' },
          ],
        },
        '/api/pilot/coach/attendance-today': {
          covered: ['ath_1', 'ath_2'],
          marks: [{ athlete_id: 'ath_1', status: 'present' }],
        },
      },
    });

    await page.goto(ROUTE);
    await expect(page.getByText('Checking access')).toHaveCount(0);

    // Into the room, and open the register -- the light objects only all exist
    // once a door has been through.
    await page.getByRole('button', { name: 'Room' }).click();
    await page.getByRole('button', { name: "Open today's attendance register" }).click();
    await expect(page.locator('.rg')).toBeVisible();

    const readings = await page.evaluate(({ contrastSrc }) => {
      const contrast = eval(contrastSrc) as (fg: string, bg: string) => number | null;

      /* The ground a piece of text actually sits on. Walk up until something
         paints. This is the step that makes the measurement honest: the text
         elements themselves are transparent, and reading their own
         background-color would compare a colour against nothing. */
      const groundOf = (el: Element): string => {
        let node: Element | null = el;
        while (node) {
          const bg = getComputedStyle(node).backgroundColor;
          if (bg && !/rgba\(0,\s*0,\s*0,\s*0\)|transparent/.test(bg)) return bg;
          node = node.parentElement;
        }
        return 'rgb(255, 255, 255)';
      };

      const SELECTORS = [
        '.rg-h', '.rg-eyebrow', '.rg-name', '.rg-mark', '.rg-state',
        '.rm-clip-t', '.rm-clip-v', '.rm-clip-d',
        '.rm-peg-n', '.rm-peg-l',
      ];

      return SELECTORS.map((sel) => {
        const el = document.querySelector(sel);
        if (!el) return { sel, found: false, ratio: null, fg: null, bg: null };
        const fg = getComputedStyle(el).color;
        const bg = groundOf(el);
        return { sel, found: true, ratio: contrast(fg, bg), fg, bg };
      });
    }, { contrastSrc: CONTRAST_FN });

    // Non-vacuous: if the selectors stopped matching, everything below would
    // pass by finding nothing.
    const found = readings.filter((r) => r.found);
    expect(found.length).toBeGreaterThanOrEqual(8);

    /* 4.5:1 is the WCAG AA threshold for body text. The failing case that
       prompted this measured about 1.1 -- chalk on bone. The assertion carries
       the readings so a failure names the element, its ink and its ground
       rather than only a number. */
    const tooFaint = found.filter((r) => (r.ratio ?? 0) < 4.5);
    expect(tooFaint).toEqual([]);
  });

  test('the escalation records stay chalk-on-slate behind the clipboard', async ({ page }) => {
    /* The other direction, and it is not symmetry for its own sake. The records
       panel is the board's OWN dark surface, moved behind a door. If a future
       fix for the light objects were applied too broadly, it would darken this
       text onto dark slate -- the same bug, mirrored, and just as invisible. */
    await installPilotApi(page, {
      session: { role: 'coach' },
      routes: {
        '/api/pilot/athletes/list': { items: [{ athlete_id: 'ath_1', full_name: 'Jordan P.' }] },
        '/api/pilot/escalations': {
          ok: true,
          escalations: [{
            escalation_id: 'esc_1',
            athlete_id: 'ath_1',
            source_type: 'pain_report',
            severity: 'high',
            reason: 'Pain score 8 reported after sparring round.',
            status: 'open',
            created_at: '2026-08-14T18:00:00.000Z',
          }],
        },
      },
    });

    await page.goto(ROUTE);
    await page.getByRole('button', { name: 'Room' }).click();
    await page.getByRole('button', { name: 'Open safety escalation records' }).click();
    await expect(page.getByText(/Pain score 8 reported after sparring round/)).toBeVisible();

    const reading = await page.evaluate(({ contrastSrc }) => {
      const contrast = eval(contrastSrc) as (fg: string, bg: string) => number | null;
      const groundOf = (el: Element): string => {
        let node: Element | null = el;
        while (node) {
          const bg = getComputedStyle(node).backgroundColor;
          if (bg && !/rgba\(0,\s*0,\s*0,\s*0\)|transparent/.test(bg)) return bg;
          node = node.parentElement;
        }
        return 'rgb(0, 0, 0)';
      };
      const el = document.querySelector('.rd .cb-what');
      if (!el) return null;
      const fg = getComputedStyle(el).color;
      const bg = groundOf(el);
      return { ratio: contrast(fg, bg), fg, bg };
    }, { contrastSrc: CONTRAST_FN });

    expect(reading).not.toBeNull();
    expect(reading!.ratio ?? 0).toBeGreaterThanOrEqual(4.5);
  });
});
