/**
 * @jest-environment jsdom
 */

// TEACH SHADOW: clearance.
//
// WHAT THIS SUITE IS FOR. The owner's rule is that filming to teach the
// recognizer is never restricted. The server was changed to match -- a capture
// session starts with nobody named and an upload carrying a take but no
// participant is accepted -- but the button on this page went on being
// disabled until an athlete was chosen, so the UI still blocked what the
// server allowed. That gap only showed up against the running app, and it is
// what these tests exist to stop recurring.
//
// The second half pins the copy. This page briefly told a coach a guardian
// must have given Teach Shadow consent, after that consent had been removed
// -- a screen stating a requirement that does not exist is worse than a screen
// saying nothing.

import '@testing-library/jest-dom';
import { render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';

import CaptureClearancePage from './page';

jest.mock('@/components/RoleSessionGate', () => ({
  __esModule: true,
  default: ({ children }: { readonly children: ReactNode }) => children,
}));

const ATHLETES = [
  { athlete_id: 'ath-1', full_name: 'Athlete One' },
  { athlete_id: 'ath-2', full_name: 'Athlete Two' },
];

beforeEach(() => {
  global.fetch = jest.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/api/pilot/athletes/list')) {
      return { ok: true, status: 200, json: async () => ({ items: ATHLETES }) } as Response;
    }
    // Anything else is a failure rather than a default: a catch-all would let
    // a request added later go unexercised.
    throw new Error(`Unexpected fetch in this test: ${url}`);
  }) as unknown as typeof fetch;
});

function startButton(): HTMLButtonElement {
  return screen.getByRole('button', { name: /start recording/i }) as HTMLButtonElement;
}

test('filming starts with nobody named', async () => {
  /*
   * THE DEFECT THIS PINS. The server accepts a session with no participant,
   * but this button stayed disabled until one was chosen -- so the client
   * enforced a restriction the owner had removed. Anyone re-adding that guard
   * fails here.
   */
  render(<CaptureClearancePage />);
  await waitFor(() => expect(global.fetch).toHaveBeenCalled());

  expect(startButton()).toBeEnabled();
});

test('it does not claim a consent that no longer exists', async () => {
  // Teach Shadow consent was removed by owner ruling. A page still demanding
  // it would send a coach looking for a permission nothing can grant.
  render(<CaptureClearancePage />);
  await waitFor(() => expect(global.fetch).toHaveBeenCalled());

  const text = document.body.textContent ?? '';
  expect(text).not.toMatch(/Teach Shadow consent/i);
  expect(text).not.toMatch(/guardian must have/i);
});

test('naming someone is offered, and explained as a safeguarding record', async () => {
  /*
   * The link is kept for one reason: a content scan flagging something in the
   * footage has to be able to reach a real person. The page says that, rather
   * than implying the name is required or that it gates anything.
   */
  render(<CaptureClearancePage />);
  await waitFor(() => expect(global.fetch).toHaveBeenCalled());

  expect(await screen.findByText('Athlete One')).toBeInTheDocument();

  const text = document.body.textContent ?? '';
  expect(text).toMatch(/optional/i);
  expect(text).toMatch(/does not restrict filming/i);
});

test('the athlete list is read here, because this is the surface allowed to name people', async () => {
  // The inverse of the Teach Shadow recorder, which must never read it. That
  // asymmetry is the whole design: identity lives on this page and nowhere
  // past it.
  render(<CaptureClearancePage />);

  await waitFor(() => {
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/pilot/athletes/list'),
      expect.anything(),
    );
  });
});
