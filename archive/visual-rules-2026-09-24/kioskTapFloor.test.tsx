/**
 * @jest-environment jsdom
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { render } from '@testing-library/react';

import AthleteLayout from '../../app/athlete/layout';
import { readDesignSystemCss } from '../../src/design/readDesignSystemCss';

/**
 * The gym-floor tap floor has two halves, and each is useless without the
 * other: a CSS rule scoped to [data-surface="kiosk"], and a marker that
 * actually puts that attribute on the athlete subtree.
 *
 * Written because the first attempt at this shipped only half. I wrote a rule
 * for `.mat-kiosk`, a class that exists nowhere in the codebase -- so it
 * compiled, reviewed cleanly, and protected nothing. A stylesheet cannot tell
 * you its selector matches no element, and neither can a typechecker.
 *
 * So this asserts BOTH ends and that they agree on the same string.
 */

const GLOBALS = path.resolve(__dirname, '../../app/globals.css');
const PPBF = path.resolve(__dirname, '../../../../design-system/ppbf.css');
const SURFACE_ATTRIBUTE = 'data-surface';
const SURFACE_VALUE = 'kiosk';

describe('kiosk tap floor', () => {
  const css = readFileSync(GLOBALS, 'utf8');

  it('marks the athlete subtree with the attribute the stylesheet targets', () => {
    const { container } = render(<AthleteLayout><button type="button">Check In</button></AthleteLayout>);

    const marker = container.querySelector(`[${SURFACE_ATTRIBUTE}="${SURFACE_VALUE}"]`);
    expect(marker).not.toBeNull();
    // The control the rule is for is inside it, not a sibling.
    expect(marker?.querySelector('button')).not.toBeNull();
  });

  it('does not add a layout box around athlete pages', () => {
    const { container } = render(<AthleteLayout><button type="button">Check In</button></AthleteLayout>);
    const marker = container.querySelector(`[${SURFACE_ATTRIBUTE}="${SURFACE_VALUE}"]`);

    // display:contents, via Tailwind's `contents` utility. Without it every
    // athlete page gains a box it was not designed inside.
    expect(marker?.className).toContain('contents');
  });

  it('raises controls to --tap rather than the 44px desk floor', () => {
    const rule = css.match(/\[data-surface="kiosk"\][\s\S]*?\{([^}]*)\}/);
    expect(rule).not.toBeNull();
    expect(rule?.[1]).toContain('var(--tap)');
    // 55px, not 44: a child in gloves is not a person at a desk.
    expect(rule?.[1]).not.toContain('44px');
  });

  it('states the floor for .btn in the unlayered sheet, where it can win', () => {
    // The globals.css rule above is inside `@layer base`, so `.btn` in the
    // unlayered ppbf.css beat it and every athlete button rendered 44px while
    // its class string asked for var(--tap). The other half of the floor has to
    // live in ppbf.css or it does not apply at all.
    const ppbf = readDesignSystemCss(PPBF);
    const rule = ppbf.match(/\[data-surface="kiosk"\]\s+\.btn\s*\{([^}]*)\}/);

    expect(rule).not.toBeNull();
    expect(rule?.[1]).toContain('min-height: var(--tap)');
    // Not layered: the rule is worthless the moment it is wrapped in a layer.
    expect(ppbf).not.toMatch(/@layer[^{]*\{[^}]*\[data-surface="kiosk"\]\s+\.btn/);
  });

  it('floors .btn anchors, which the element-list rule cannot reach', () => {
    // globals.css lists `button`, `select`, `input[...]` -- never `a`. Half the
    // athlete floor's tap targets are router Links carrying `.btn`, so a rule
    // written per element type left them at 44px however it was layered.
    // Asserted against a rendered anchor rather than by reading the selector,
    // because a selector matching nothing is the exact bug this file exists for.
    const { container } = render(
      <AthleteLayout>
        <a href="/schedule" className="btn btn--ghost">Schedule</a>
      </AthleteLayout>,
    );

    expect(container.querySelector(`[${SURFACE_ATTRIBUTE}="${SURFACE_VALUE}"] .btn`)).not.toBeNull();
    expect(container.querySelector<HTMLAnchorElement>('a.btn')?.tagName).toBe('A');
  });

  it('covers the control types an athlete actually touches', () => {
    // The session-duration field is an input[type=number] and sat at 36px
    // through three sweeps, so a button-only rule would miss the exact control
    // that prompted this.
    const selector = css.slice(css.indexOf('[data-surface="kiosk"]'), css.indexOf('min-height: var(--tap)'));

    for (const control of ['button', 'select', 'input[type="number"]', 'input[type="text"]']) {
      expect(selector).toContain(control);
    }
  });
});
