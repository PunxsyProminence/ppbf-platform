/**
 * @jest-environment jsdom
 */

// Notices used to exist only as rows an engineer inserted by hand, so the
// author had no way to see which of them a member could actually read. These
// pin the distinction the surface has to keep visible: live, scheduled,
// expired, and retired are four different things.

import type { ReactNode } from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';

import NoticesPage from './page';
import type { AnnouncementItem } from '@/components/AnnouncementBanner';

jest.mock('@/components/RoleSessionGate', () => ({
  __esModule: true,
  default: ({ children }: { readonly children: ReactNode }) => children,
}));

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ children, href }: { readonly children: ReactNode; readonly href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

jest.mock('@/components/usePilotSession', () => ({
  usePilotSession: () => ({
    role: 'coach',
    organizationId: 'org-1',
    authProvider: 'microsoft',
    accountId: 'coach-1',
    mustChangePin: false,
    loading: false,
  }),
}));

function item(overrides: Partial<AnnouncementItem> = {}): AnnouncementItem {
  return {
    announcement_id: 'ann-1',
    message: 'Gloves on at 5.',
    author_name: 'Coach M.',
    author_role: 'coach',
    created_at: '2026-07-30T12:00:00.000Z',
    placement: 'gym_notices',
    kind: 'notice',
    active: true,
    starts_at: null,
    ends_at: null,
    ...overrides,
  };
}

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, json: async () => body } as Response;
}

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  jest.clearAllMocks();
});

async function renderPage(fetchMock: jest.Mock) {
  global.fetch = fetchMock as unknown as typeof fetch;
  await act(async () => {
    render(<NoticesPage />);
  });
  return fetchMock;
}

function listFetch(announcements: AnnouncementItem[]): jest.Mock {
  return jest.fn(async (url: unknown) => {
    if (String(url).includes('/api/pilot/announcements/get')) {
      return jsonResponse({ ok: true, announcements });
    }
    throw new Error(`Unexpected fetch: ${String(url)}`);
  });
}

test('the author sees which items are live and which are not', async () => {
  await renderPage(
    listFetch([
      item({ announcement_id: 'a-live', message: 'Gloves on at 5.' }),
      item({ announcement_id: 'a-sched', message: 'Tournament sign-ups open Monday.', starts_at: '2099-01-01T00:00:00.000Z' }),
      item({ announcement_id: 'a-gone', message: 'Last week only.', ends_at: '2020-01-01T00:00:00.000Z' }),
      item({ announcement_id: 'a-retired', message: 'Pulled down.', active: false }),
    ]),
  );

  const posted = screen.getByRole('heading', { name: 'Everything Posted' }).parentElement as HTMLElement;
  expect(within(posted).getByText('LIVE')).toBeTruthy();
  expect(within(posted).getByText('SCHEDULED')).toBeTruthy();
  expect(within(posted).getByText('EXPIRED')).toBeTruthy();
  expect(within(posted).getByText('RETIRED')).toBeTruthy();
});

test('the live-right-now summary carries only what a member can read today', async () => {
  await renderPage(
    listFetch([
      item({ announcement_id: 'a-live', message: 'Gloves on at 5.' }),
      item({ announcement_id: 'a-sched', message: 'Tournament sign-ups open Monday.', starts_at: '2099-01-01T00:00:00.000Z' }),
    ]),
  );

  const live = screen.getByRole('heading', { name: 'Live Right Now' }).parentElement as HTMLElement;
  expect(within(live).getByText(/Gloves on at 5\./)).toBeTruthy();
  expect(within(live).queryByText(/Tournament sign-ups open Monday\./)).toBeNull();
  expect(within(live).getAllByText(/Nothing live\./).length).toBeGreaterThan(0);
});

test('publishing sends the placement, kind and window the author chose', async () => {
  const fetchMock = jest.fn(async (url: unknown, init?: RequestInit) => {
    if (String(url).includes('/api/pilot/announcements/post')) {
      return jsonResponse({ ok: true, announcement: item() });
    }
    if (String(url).includes('/api/pilot/announcements/get')) {
      return jsonResponse({ ok: true, announcements: [] });
    }
    throw new Error(`Unexpected fetch: ${String(url)} ${String(init?.method)}`);
  });

  await renderPage(fetchMock);

  fireEvent.change(screen.getByPlaceholderText('What should this surface say?'), {
    target: { value: 'Hands up, chin down.' },
  });
  fireEvent.change(screen.getByPlaceholderText('Your name, as members will see it'), {
    target: { value: 'Coach M.' },
  });
  fireEvent.change(screen.getByLabelText(/Placement/), { target: { value: 'athlete_workspace' } });
  fireEvent.change(screen.getByLabelText(/Kind/), { target: { value: 'motivation' } });

  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Publish' }));
  });

  const postCall = fetchMock.mock.calls.find((call) => String(call[0]).includes('/announcements/post'));
  expect(postCall).toBeDefined();
  expect(JSON.parse(String((postCall?.[1] as RequestInit).body))).toMatchObject({
    message: 'Hands up, chin down.',
    author_name: 'Coach M.',
    placement: 'athlete_workspace',
    kind: 'motivation',
    starts_at: null,
    ends_at: null,
  });
});

test('a window that closes before it opens is refused before it reaches the server', async () => {
  const fetchMock = await renderPage(listFetch([]));

  fireEvent.change(screen.getByPlaceholderText('What should this surface say?'), { target: { value: 'Hello' } });
  fireEvent.change(screen.getByPlaceholderText('Your name, as members will see it'), { target: { value: 'Coach' } });
  fireEvent.change(screen.getByLabelText(/Starts \(optional\)/), { target: { value: '2026-08-08T10:00' } });
  fireEvent.change(screen.getByLabelText(/Ends \(optional\)/), { target: { value: '2026-08-01T10:00' } });

  expect(screen.getByText('The end time must be after the start time.')).toBeTruthy();
  expect((screen.getByRole('button', { name: 'Publish' }) as HTMLButtonElement).disabled).toBe(true);
  expect(fetchMock.mock.calls.filter((call) => String(call[0]).includes('/announcements/post'))).toHaveLength(0);
});

test('retiring an item marks it retired in place', async () => {
  const fetchMock = jest.fn(async (url: unknown) => {
    if (String(url).includes('/api/pilot/announcements/update')) {
      return jsonResponse({ ok: true, announcement: item({ active: false }) });
    }
    if (String(url).includes('/api/pilot/announcements/get')) {
      return jsonResponse({ ok: true, announcements: [item()] });
    }
    throw new Error(`Unexpected fetch: ${String(url)}`);
  });

  await renderPage(fetchMock);

  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Retire' }));
  });

  expect(screen.getByText('Retired. It no longer renders anywhere.')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Restore' })).toBeTruthy();
  const live = screen.getByRole('heading', { name: 'Live Right Now' }).parentElement as HTMLElement;
  expect(within(live).queryByText(/Gloves on at 5\./)).toBeNull();
});

test('a failed load is not presented as an empty notice board', async () => {
  await renderPage(jest.fn(async () => jsonResponse({}, false)));

  expect(screen.getByText(/Nothing below is the full list/i)).toBeTruthy();
  expect(screen.queryByText('Nothing has been posted for this gym yet.')).toBeNull();
});
