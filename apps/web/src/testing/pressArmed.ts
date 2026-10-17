import { fireEvent } from '@testing-library/react';

import { ARM_SETTLE_MS } from '@/components/ArmedButton';

/**
 * Both presses of an ArmedButton, the second one after the settle time, for a
 * test that is about what the action does rather than about arming it. The
 * clock is moved only for the second press, so real and fake timers both work.
 * A test about the arming itself presses with fireEvent directly.
 */
export function pressArmed(button: HTMLElement): void {
  fireEvent.click(button);
  const armedAt = Date.now();
  const spy = jest.spyOn(Date, 'now').mockReturnValue(armedAt + ARM_SETTLE_MS);
  try {
    fireEvent.click(button);
  } finally {
    spy.mockRestore();
  }
}
