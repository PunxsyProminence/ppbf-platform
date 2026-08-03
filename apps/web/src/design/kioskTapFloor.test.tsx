/**
 * @jest-environment jsdom
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { render } from '@testing-library/react';

import AthleteLayout from '../../app/athlete/layout';

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
