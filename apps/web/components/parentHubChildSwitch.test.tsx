/**
 * @jest-environment jsdom
 */

import { act, fireEvent, render, screen } from '@testing-library/react';

import type { AnnouncementItem } from './AnnouncementBanner';
import ParentHub from './ParentHub';

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  } as unknown as Response;
}

function announcement(overrides: Partial<AnnouncementItem> = {}): AnnouncementItem {
  return {
    announcement_id: 'ann_1',
    message: 'Gym closed Monday for the holiday.',
    author_name: 'Coach J.',
    author_role: 'coach',
    created_at: '2026-07-30T12:00:00.000Z',
    placement: 'everywhere',
    kind: 'notice',
    active: true,
    starts_at: null,
    ends_at: null,
    ...overrides,
  };
}

function installFetch(announcements: () => Promise<Response> = async () => jsonResponse({ ok: true, announcements: [] })): jest.Mock {
  const fetchMock = jest.fn(async (input: unknown) => {
    const url = String(input);

    if (url.includes('/api/pilot/auth/session')) {
      return jsonResponse({ authenticated: true, account_id: 'acct_parent_1' });
    }
    if (url.includes('/api/pilot/athletes/list')) {
      return jsonResponse({
        items: [
          { athlete_id: 'ath_1', full_name: 'First Child' },
          { athlete_id: 'ath_2', full_name: 'Second Child' },
        ],
      });
    }
    if (url.includes('/api/pilot/announcements/get')) {
      return announcements();
    }

    throw new Error(`Unexpected fetch: ${url}`);
  });

  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('parent hub child selector', () => {
  test('switching child does not refetch the roster or re-show the loading spinner', async () => {
    const fetchMock = installFetch();
    await act(async () => {
      render(<ParentHub />);
    });

    const rosterCalls = () =>
      fetchMock.mock.calls.filter((call) => String(call[0]).includes('/api/pilot/athletes/list')).length;
    expect(rosterCalls()).toBe(1);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Second Child' }));
    });

    // The roster is the same list either way; refetching it made every child
    // switch flash the spinner and blank the selector.
    expect(rosterCalls()).toBe(1);
    expect(screen.queryByText(/Loading your children/i)).toBeNull();
    expect(screen.queryByRole('button', { name: 'First Child' })).not.toBeNull();
  });

  test('the first child is selected by default and switching moves the overview to the other child', async () => {
    installFetch();
    await act(async () => {
      render(<ParentHub />);
    });

    expect(screen.queryByText('First Child', { selector: 'p' })).not.toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Second Child' }));
    });

    expect(screen.queryByText('Second Child', { selector: 'p' })).not.toBeNull();
    expect(screen.queryByText('First Child', { selector: 'p' })).toBeNull();
  });
});

// The placement vocabulary has no parent surface, so 'everywhere' is the only
// thing this hub can honestly ask for. Asking for anything else would be a
// placement no author can choose and no migration defines.
describe('authored announcements on the parent hub', () => {
  function announcementRequests(fetchMock: jest.Mock): Array<Record<string, unknown>> {
    return fetchMock.mock.calls
      .filter((call) => String(call[0]).includes('/api/pilot/announcements/get'))
      .map((call) => JSON.parse(String((call[1] as RequestInit | undefined)?.body ?? '{}')) as Record<string, unknown>);
  }

  test('the hub asks only for gym-wide items', async () => {
    const fetchMock = installFetch();
    await act(async () => {
      render(<ParentHub />);
    });

    const requests = announcementRequests(fetchMock);
    expect(requests.length).toBeGreaterThan(0);
    for (const request of requests) {
      expect(request.placement).toBe('everywhere');
    }
    expect(requests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'notice' }),
        expect.objectContaining({ kind: 'motivation' }),
      ]),
    );
  });

  test('a live gym-wide notice reaches the parent', async () => {
    installFetch(async () => jsonResponse({ ok: true, announcements: [announcement()] }));
    await act(async () => {
      render(<ParentHub />);
    });

    expect(screen.queryByText('Gym closed Monday for the holiday.')).not.toBeNull();
  });

  test('nothing live leaves no heading and no empty box behind', async () => {
    installFetch();
    await act(async () => {
      render(<ParentHub />);
    });

    expect(screen.queryByText('Gym Notices')).toBeNull();
    expect(screen.queryByText('From the Gym')).toBeNull();
  });

  test('a failed announcements read leaves the rest of the hub working', async () => {
    installFetch(async () => {
      throw new Error('announcements offline');
    });
    await act(async () => {
      render(<ParentHub />);
    });

    expect(screen.queryByText('Gym Notices')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Second Child' })).not.toBeNull();
  });
});
