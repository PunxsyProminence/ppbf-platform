/** @jest-environment jsdom */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import ActivatePage from './page';

jest.mock('next/navigation', () => ({ useRouter: () => ({ refresh: jest.fn() }) }));
jest.mock('next/link', () => ({ __esModule: true, default: ({ children, href }: { children: ReactNode; href: string }) => <a href={href}>{children}</a> }));
jest.mock('@/src/lib/useFocusOnStepChange', () => ({ useFocusOnStepChange: jest.fn() }));

const originalFetch = global.fetch;
afterEach(() => { global.fetch = originalFetch; });

test('posts the one-time code with the athlete-chosen PIN and never puts the code in a URL', async () => {
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
  global.fetch = jest.fn(async (url: string, init?: RequestInit) => {
    requests.push({ url, body: JSON.parse(String(init?.body)) });
    return { ok: true, json: async () => ({ ok: true, account_id: 'ath-login', signed_in: true }) } as Response;
  }) as never;

  render(<ActivatePage />);
  fireEvent.change(screen.getByLabelText('Activation code'), { target: { value: 'ABCD-2345-EFGH' } });
  fireEvent.click(screen.getByRole('button', { name: /Continue/i }));
  fireEvent.change(await screen.findByLabelText(/^Choose your PIN$/i), { target: { value: '482913' } });
  fireEvent.change(screen.getByLabelText(/^Type it again$/i), { target: { value: '482913' } });
  fireEvent.click(screen.getByRole('button', { name: /Activate/i }));

  await waitFor(() => expect(requests).toHaveLength(1));
  expect(requests[0]).toEqual({ url: '/api/pilot/auth/activate', body: { code: 'ABCD-2345-EFGH', pin: '482913' } });
  expect(requests[0].url).not.toContain('ABCD');
  expect(await screen.findByText(/ath-login/i)).toBeTruthy();
});

/* A REJECTED PIN IS FIXED WHERE THE ATHLETE IS STANDING.
   ------------------------------------------------------------------------
   A rejected CODE means the slip in their hand is wrong and they have to
   start over. A rejected PIN means they type a different one. Sending them
   back to the code screen for a PIN problem asks a child to re-enter a code
   that was never the issue -- and it clears both PIN fields on the way.

   Told apart by the machine `code` the server sends, not by how the message
   is spelled. The prefix test this replaces missed PIN_TRIVIALLY_GUESSABLE,
   whose message begins "That PIN is too easy to guess", so the single most
   likely rejection -- an athlete picking 111111 -- was the one it got wrong. */
async function reachThePinStep() {
  render(<ActivatePage />);
  fireEvent.change(screen.getByLabelText('Activation code'), { target: { value: 'ABCD-2345-EFGH' } });
  fireEvent.click(screen.getByRole('button', { name: /Continue/i }));
  fireEvent.change(await screen.findByLabelText(/^Choose your PIN$/i), { target: { value: '111111' } });
  fireEvent.change(screen.getByLabelText(/^Type it again$/i), { target: { value: '111111' } });
  fireEvent.click(screen.getByRole('button', { name: /Activate/i }));
}

function refuseWith(code: string, error: string) {
  global.fetch = jest.fn(async () => ({
    ok: false,
    json: async () => ({ ok: false, error, code }),
  })) as never;
}

test('keeps the athlete on the PIN step when the PIN is the problem', async () => {
  refuseWith('PIN_TRIVIALLY_GUESSABLE', 'That PIN is too easy to guess. Avoid repeated digits, runs, and simple patterns.');
  await reachThePinStep();

  /* Wait for the REFUSAL to be rendered before asking which step we are on.
     findBy* resolves immediately against the current DOM, so asserting the
     step straight after the click passes before React has processed the
     rejection at all -- which made the first version of these two tests
     vacuous: they stayed green with the branch inverted. */
  await screen.findByText(/too easy to guess/i);

  // Still on the PIN step: the field they need to correct is in front of them.
  expect(screen.getByLabelText(/^Choose your PIN$/i)).toBeTruthy();
  expect(screen.queryByLabelText('Activation code')).toBeNull();
});

test('sends the athlete back to the code step when the code is the problem', async () => {
  refuseWith('UNAUTHORIZED', 'Unauthorized: activation code is invalid, already used, or expired');
  await reachThePinStep();

  await screen.findByText(/invalid, already used, or expired/i);

  expect(screen.getByLabelText('Activation code')).toBeTruthy();
  expect(screen.queryByLabelText(/^Choose your PIN$/i)).toBeNull();
});
