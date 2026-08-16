/**
 * @jest-environment jsdom
 */

// The clearance board replaced a scaffold that showed org-wide SHADOW
// projections under a sports-medicine heading. What these pin: the board
// reads clearance + holds per roster athlete and NOTHING clinical; "no
// record" and a failed read are rendered as action states, never as quiet or
// as cleared; and the loading state withholds every claim.

import { render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';

import SportsMedicinePage from './page';

jest.mock('@/components/RoleStandaloneView', () => ({
  __esModule: true,
  default: ({ children }: { readonly children: ReactNode }) => <div>{children}</div>,
}));

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ children, href }: { readonly children: ReactNode; readonly href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

const ATHLETE = { athlete_id: 'ath-1', full_name: 'Jordan Doe' };

const CLEARED_STATUS = {
  status_id: 'status-1',
  status: 'cleared',
  effective_at: '2026-08-01T10:00:00.000Z',
  // Fields the surface must never display, present in the payload on purpose
  // so the tests can pin their absence from the DOM.
  restriction_flags: { no_sparring: true },
  source_reference: 'physician-note-123',
};

const HOLD = {
  scope: 'sparring',
  athlete_explanation: 'Taking a week off contact while your headache settles.',
  lift_condition_text: 'A symptom-free week and a coach check-in.',
};

function mockFetch(overrides: Record<string, () => Response | Promise<Response>> = {}) {
  return jest.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    for (const [fragment, responder] of Object.entries(overrides)) {
      if (url.includes(fragment)) return responder();
    }
    if (url.includes('/athletes/list')) {
      return { ok: true, json: async () => ({ items: [ATHLETE] }) } as Response;
    }
    if (url.includes('/shadow/medical-status')) {
      return { ok: true, json: async () => ({ ok: true, status: CLEARED_STATUS }) } as Response;
    }
    if (url.includes('/training-holds')) {
      return { ok: true, json: async () => ({ ok: true, holds: [] }) } as Response;
    }
    return { ok: true, json: async () => ({ items: [] }) } as Response;
  }) as unknown as typeof fetch;
}

afterEach(() => {
  jest.restoreAllMocks();
});

test('the empty state is withheld while the roster is still loading', async () => {
  global.fetch = mockFetch({ '/athletes/list': () => new Promise<Response>(() => {}) });

  render(<SportsMedicinePage />);

  await screen.findByText(/Loading clearance board/);
  expect(screen.queryByText('No athletes on your roster')).toBeNull();
});

test('a cleared athlete shows the badge and date, and no clinical detail leaks', async () => {
  global.fetch = mockFetch();

  render(<SportsMedicinePage />);

  await screen.findByText('Jordan Doe');
  expect(screen.getByText('cleared')).toBeTruthy();
  expect(screen.getByText(/since/)).toBeTruthy();

  // The payload carried restriction flags and a source reference; the surface
  // must not.
  expect(screen.queryByText(/no_sparring/)).toBeNull();
  expect(screen.queryByText(/physician-note-123/)).toBeNull();
});

test('no clearance record reads as an action state, not as quiet', async () => {
  global.fetch = mockFetch({
    '/shadow/medical-status': () => ({ ok: true, json: async () => ({ ok: true, status: null }) }) as Response,
  });

  render(<SportsMedicinePage />);

  await screen.findByText('no record');
  expect(screen.getByText(/medical gate blocks recommendations/)).toBeTruthy();
});

test('a failed clearance read says unknown is not cleared', async () => {
  global.fetch = mockFetch({
    '/shadow/medical-status': () => ({ ok: false, json: async () => ({}) }) as Response,
  });

  render(<SportsMedicinePage />);

  await screen.findByText('unavailable');
  expect(screen.getByText(/Unknown is not cleared/)).toBeTruthy();
  expect(screen.queryByText('cleared')).toBeNull();
});

test('an active hold shows its athlete-safe explanation and lift condition', async () => {
  global.fetch = mockFetch({
    '/training-holds': () => ({ ok: true, json: async () => ({ ok: true, holds: [HOLD] }) }) as Response,
  });

  render(<SportsMedicinePage />);

  await screen.findByText(/Active Training Hold — sparring/);
  expect(screen.getByText(HOLD.athlete_explanation)).toBeTruthy();
  expect(screen.getByText(/A symptom-free week and a coach check-in/)).toBeTruthy();

  await waitFor(() => expect(screen.queryByText(/Loading clearance board/)).toBeNull());
});
