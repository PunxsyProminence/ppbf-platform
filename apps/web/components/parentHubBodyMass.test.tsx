/**
 * @jest-environment jsdom
 */

import '@testing-library/jest-dom';
import { act, fireEvent, render, screen, within } from '@testing-library/react';

import ParentHub from './ParentHub';

// The guardian's body-mass card (elite-boxing item 5): the selected child's
// latest weigh-in and the server's seven-day flag sentence, read per child
// from /api/pilot/parent/body-mass and never shown under the wrong child.

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, status: ok ? 200 : 403, json: async () => body } as unknown as Response;
}

const FLAG = 'Weight down 6.0% in 7 days (132.3 lb → 124.3 lb). Check in with the athlete.';

function installFetch(bodyMass: (athleteId: string) => Promise<Response>): jest.Mock {
  const fetchMock = jest.fn(async (input: unknown) => {
    const url = String(input);
    if (url.includes('/api/pilot/auth/session')) return jsonResponse({ authenticated: true, account_id: 'acct_parent_1' });
    if (url.includes('/api/pilot/athletes/list')) {
      return jsonResponse({
        items: [
          { athlete_id: 'ath_1', full_name: 'First Child' },
          { athlete_id: 'ath_2', full_name: 'Second Child' },
        ],
      });
    }
    if (url.includes('/api/pilot/parent/body-mass')) {
      return bodyMass(new URL(url, 'http://localhost').searchParams.get('athlete_id') ?? '');
    }
    if (url.includes('/api/pilot/announcements/get')) return jsonResponse({ ok: true, announcements: [] });
    if (url.includes('/api/pilot/parent/safety')) return jsonResponse({ ok: true, items: [] });
    if (url.includes('/api/pilot/parent/messages')) return jsonResponse({ ok: true, items: [] });
    if (url.includes('/api/pilot/scheduler')) return jsonResponse({ ok: true, classes: [], registrations: [], attendance: [] });
    if (url.includes('/api/pilot/profile/card')) return jsonResponse({}, false);
    throw new Error(`Unexpected fetch: ${url}`);
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

const summary = (pounds: number, flagText: string | null) => ({
  body_mass: {
    latest: { kilograms: pounds * 0.45359237, pounds, observed_at: '2026-10-03T17:00:00.000Z' },
    flag_text: flagText,
  },
});

afterEach(() => jest.restoreAllMocks());

test('the selected child\'s weight and flag are shown', async () => {
  installFetch(async () => jsonResponse(summary(124.3, FLAG)));
  await act(async () => {
    render(<ParentHub />);
  });

  const card = await screen.findByTestId('parent-body-mass');
  expect(card.textContent).toContain('124.3 lb');
  expect(within(card).getByRole('status').textContent).toBe(FLAG);
});

test('no weigh-in, or a refused read, shows no card', async () => {
  installFetch(async (athleteId) => (athleteId === 'ath_1' ? jsonResponse({ body_mass: null }) : jsonResponse({}, false)));
  await act(async () => {
    render(<ParentHub />);
  });
  expect(screen.queryByTestId('parent-body-mass')).toBeNull();

  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Second Child' }));
  });
  expect(screen.queryByTestId('parent-body-mass')).toBeNull();
});

test('switching child never shows the first child\'s weight under the second', async () => {
  let releaseFirst!: () => void;
  const firstHeld = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  installFetch(async (athleteId) => {
    if (athleteId === 'ath_1') {
      await firstHeld;
      return jsonResponse(summary(150, FLAG));
    }
    return jsonResponse({ body_mass: null });
  });
  await act(async () => {
    render(<ParentHub />);
  });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Second Child' }));
  });
  await act(async () => {
    releaseFirst();
  });

  expect(screen.queryByTestId('parent-body-mass')).toBeNull();
  expect(screen.queryByText(/150 lb/)).toBeNull();
});
