/** @jest-environment jsdom */
import '@testing-library/jest-dom';
import { fireEvent, render, screen } from '@testing-library/react';
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

/* Lane U1, SC2-4 (OW25-48 A): a refused PIN is not a medical stop, so the box
   is on the restricted rung with ▲. ▲ is also the app's "not yet" mark, so the
   refusal carries a word of its own, at the kiosk type floor. */
test('a refused sign-in says Not signed in, with ▲ and the server\'s words', async () => {
  global.fetch = jest.fn(async () => ({
    ok: false,
    status: 401,
    json: async () => ({ ok: false, error: 'Invalid credentials' }),
  })) as never;
  render(<AthletePinSignInPage />);
  fireEvent.change(document.getElementById('athlete-account-id') as HTMLInputElement, { target: { value: 'a-1' } });
  fireEvent.change(document.getElementById('athlete-pin') as HTMLInputElement, { target: { value: '4826' } });
  fireEvent.submit((document.getElementById('athlete-pin') as HTMLInputElement).form as HTMLFormElement);

  const alert = await screen.findByRole('alert');
  expect(alert).toHaveTextContent('Not signed in');
  expect(alert).toHaveTextContent('Invalid credentials');
  expect(alert.textContent).toContain('\u25b2');
  expect(alert.className).toContain('var(--restricted)');
  expect(alert.className).not.toContain('var(--locked)');
  expect(alert.className).toContain('text-[length:var(--t-md)]');
});
