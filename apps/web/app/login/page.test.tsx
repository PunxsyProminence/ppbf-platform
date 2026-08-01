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
  expect(screen.getByPlaceholderText('account-001')).toBeTruthy();
});
