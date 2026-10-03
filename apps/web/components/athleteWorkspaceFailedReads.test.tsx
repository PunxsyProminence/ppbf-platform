/**
 * @jest-environment jsdom
 */

// The #991 class on the athlete home: a read that FAILED must not render the
// claim a read that answered "none" would. A child told "Active Goals 0" or
// "No sessions on the card yet" over a failed read is told something false
// about their own record.

import { act, render, screen, waitFor } from '@testing-library/react';
import React from 'react';

jest.mock('next/link', () => ({
  __esModule: true,
  default: function MockLink({ href, children, ...rest }: { href: string; children: React.ReactNode }) {
    return React.createElement('a', { href, ...rest }, children);
  },
}));

import AthleteWorkspace from './AthleteWorkspace';

type Fail = 'goals' | 'sessions';

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, status: ok ? 200 : 500, json: async () => body } as unknown as Response;
}

async function renderWith(fail: Fail | null): Promise<void> {
  global.fetch = jest.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/api/pilot/auth/session')) {
      return jsonResponse({ authenticated: true, athlete_id: 'ath_test' });
    }
    if (url.includes('/api/pilot/goals/list')) {
      return fail === 'goals' ? jsonResponse({ error: 'Internal server error' }, false) : jsonResponse({ items: [] });
    }
    if (url.includes('/api/pilot/sessions/list')) {
      return fail === 'sessions' ? jsonResponse({ error: 'Internal server error' }, false) : jsonResponse({ items: [] });
    }
    return jsonResponse({ ok: true, items: [] });
  }) as unknown as typeof fetch;
  render(<AthleteWorkspace />);
  await act(async () => {
    await Promise.resolve();
  });
}

/** The summary tile's own text: label plus value, nothing around it. */
function activeGoalsTile(): string {
  return screen.getByText('Active Goals').parentElement?.textContent ?? '';
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('athlete home: a failed read is not an empty one', () => {
  test('a failed goals read does not show "Active Goals 0"', async () => {
    await renderWith('goals');
    await waitFor(() => expect(activeGoalsTile()).toBe('Active GoalsUnavailable'));
  });

  test('a goals read that answered with none still shows 0', async () => {
    await renderWith(null);
    await waitFor(() => expect(activeGoalsTile()).toBe('Active Goals0'));
  });

  test('a failed session read does not say "No sessions on the card yet"', async () => {
    await renderWith('sessions');
    expect(await screen.findByText('Your card could not be loaded right now.')).toBeTruthy();
    expect(screen.queryByText('No sessions on the card yet')).toBeNull();
  });

  test('a session read that answered with none still says the card is empty', async () => {
    await renderWith(null);
    expect(await screen.findByText('No sessions on the card yet')).toBeTruthy();
    expect(screen.queryByText('Your card could not be loaded right now.')).toBeNull();
  });
});
