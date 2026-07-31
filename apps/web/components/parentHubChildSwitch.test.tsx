/**
 * @jest-environment jsdom
 */

import { act, fireEvent, render, screen } from '@testing-library/react';

import ParentHub from './ParentHub';

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  } as unknown as Response;
}

function installFetch(): jest.Mock {
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
