/** @jest-environment jsdom */
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import AthletePinSignInPage from './page';

jest.mock('next/navigation', () => ({ useRouter: () => ({ replace: jest.fn() }) }));
jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ children, href }: { children: ReactNode; href: string }) => <a href={href}>{children}</a>,
}));

/**
 * An athlete's first credential is a one-time activation code, and this page is
 * where they land looking for somewhere to use it. createAthleteAccount inserts
 * pin_hash null and active_flag false, so the form below will refuse a new
 * account no matter what they type -- /activate is the only route that turns
 * the code into a sign-in, and nothing anywhere linked to it.
 */
test('offers the athlete a route to redeem an activation code', () => {
  render(<AthletePinSignInPage />);

  const link = screen.getByRole('link', { name: /set up your sign-in/i });
  expect(link.getAttribute('href')).toBe('/activate');
});

test('names the code, so an athlete holding one recognises the link as theirs', () => {
  render(<AthletePinSignInPage />);

  // A bare "Set up your sign-in" is not enough on its own: the athlete is
  // holding something their gym called a code, and the link has to be
  // identifiable as the place that code goes.
  expect(screen.getByText(/one-time code/i)).toBeTruthy();
});

test('still leads with the PIN form, which is what a returning athlete needs', () => {
  render(<AthletePinSignInPage />);

  // Guards against "fixing" the dead end by turning this into an activation
  // page. The returning athlete is the common case and their two fields must
  // stay first.
  expect(screen.getByLabelText(/athlete account id/i)).toBeTruthy();
  expect(screen.getByLabelText(/^PIN$/i)).toBeTruthy();
});
