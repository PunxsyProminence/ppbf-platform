import { redirect } from 'next/navigation';

import AthletePinSignInPage from './page';

jest.mock('next/navigation', () => ({
  redirect: jest.fn(() => {
    throw new Error('NEXT_REDIRECT');
  }),
}));

/**
 * ATH-15, Jason 2026-11-23 Q5 "A" (lane SIGNIN-FIX #2143): one athlete PIN
 * form, on /login. This address is kept as a redirect so old links, bookmarks
 * and printed cards still reach that form, opened at its own heading.
 */
test('sends the athlete to the one PIN form, on /login, at its heading', () => {
  expect(() => AthletePinSignInPage()).toThrow('NEXT_REDIRECT');
  expect(redirect).toHaveBeenCalledWith('/login#signin-pin-heading');
});
