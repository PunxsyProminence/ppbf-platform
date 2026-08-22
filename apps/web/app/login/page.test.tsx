/**
 * @jest-environment jsdom
 */

// The Gym Notice panel used to fall back to a hardcoded "System" message
// whenever the feed was empty or the read failed, so the signed-out page
// always showed a notice whether or not the gym had posted one.

import type { ReactNode } from 'react';
import { act, render, screen } from '@testing-library/react';

import LoginPage from './page';

jest.mock('next/navigation', () => ({
  useRouter: () => ({ replace: jest.fn(), push: jest.fn() }),
  useSearchParams: () => new URLSearchParams(''),
}));

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ children, href }: { readonly children: ReactNode; readonly href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, status: ok ? 200 : 500, json: async () => body } as Response;
}

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  jest.clearAllMocks();
});

async function renderPage(noticesResponse: () => Promise<Response>) {
  const fetchMock = jest.fn(async (url: unknown) => {
    if (String(url).includes('/api/pilot/announcements/public')) {
      return noticesResponse();
    }
    return jsonResponse({ authenticated: false });
  });

  global.fetch = fetchMock as unknown as typeof fetch;
  await act(async () => {
    render(<LoginPage />);
  });
  return fetchMock;
}

test('renders an authored notice from the public feed', async () => {
  await renderPage(async () =>
    jsonResponse({
      ok: true,
      announcements: [
        {
          announcement_id: 'ann-1',
          message: 'Doors open at 4 on Saturday.',
          author_name: 'Coach M.',
          author_role: 'coach',
          created_at: '2026-07-30T12:00:00.000Z',
          placement: 'gym_notices',
          kind: 'notice',
          active: true,
          starts_at: null,
          ends_at: null,
        },
      ],
    }),
  );

  expect(screen.getByText('Doors open at 4 on Saturday.')).toBeTruthy();
});

test('shows no notice panel at all when the gym has posted nothing', async () => {
  await renderPage(async () => jsonResponse({ ok: true, announcements: [] }));

  expect(screen.queryByText(/📢 Gym Notice/)).toBeNull();
  expect(screen.queryByText(/Welcome to PPBF/i)).toBeNull();
});

test('a failed notice read does not invent a notice, and leaves sign-in usable', async () => {
  await renderPage(async () => jsonResponse({}, false));

  expect(screen.queryByText(/📢 Gym Notice/)).toBeNull();
  expect(screen.queryByText(/Welcome to PPBF/i)).toBeNull();
  // The claim being made here is unchanged: a failed notice fetch must leave
  // sign-in usable.
  expect(screen.getByText('Continue With Microsoft')).toBeTruthy();
});

test('meets nobody with a door that cannot open for them', async () => {
  await renderPage(async () => jsonResponse({ ok: true, announcements: [] }));

  /* This used to assert that the page OPENED on Microsoft, because only one
     method was drawn at a time and whichever one was chosen was wrong for
     somebody: opening on PIN put every coach, parent and staff member in
     front of a form that could never authenticate them (PIN sign-in admits
     only athletes), and opening on Microsoft did the same to athletes.

     The approved board (AF-01, AF-M02) draws all three at once, so there is
     no default left to get wrong -- which is a stronger version of the same
     claim, and what this now checks. */
  expect(screen.getByText('Continue With Microsoft')).toBeTruthy();
  expect(screen.getByPlaceholderText('account-001')).toBeTruthy();
  expect(screen.getByPlaceholderText('you@example.com')).toBeTruthy();
});
