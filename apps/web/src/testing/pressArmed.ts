import { fireEvent } from '@testing-library/react';

import { ARM_SETTLE_MS } from '@/components/ArmedButton';

/** One press, as if it came ARM_SETTLE_MS * `step` after now. */
function pressLater(button: HTMLElement, step: number): void {
  const later = Date.now() + ARM_SETTLE_MS * step;
  const spy = jest.spyOn(Date, 'now').mockReturnValue(later);
  try {
    fireEvent.click(button);
  } finally {
    spy.mockRestore();
  }
}

/**
 * Both presses of an ArmedButton, each after its settle time, for a test that
 * is about what the action does rather than about arming it. The clock is
 * moved only for the presses, so real and fake timers both work. A test about
 * the arming itself presses with fireEvent directly.
 */
export function pressArmed(button: HTMLElement): void {
  pressLater(button, 1);
  pressLater(button, 2);
}

/** The first press only, after the button has settled on screen: it arms. */
export function armOnly(button: HTMLElement): void {
  pressLater(button, 1);
}
