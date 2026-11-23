/**
 * @jest-environment jsdom
 */

// Lane AS4-4D4E (AS-4 part 4e; app scrub FAM-06; GO on #2128): Parent Hub keeps
// the open tab in the address, so "Back to Parent Hub" and the job bar's tab
// items open that tab, not Overview. Only a tab on the rail opens from it.

import '@testing-library/jest-dom';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

import ParentHub from './ParentHub';

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, status: ok ? 200 : 500, json: async () => body } as unknown as Response;
}

function installFetch(): void {
  global.fetch = jest.fn(async (input: unknown) => {
    const url = String(input);
    if (url.includes('/api/pilot/athletes/list')) {
      return jsonResponse({
        items: [
          { athlete_id: 'ath_1', full_name: 'First Child' },
          { athlete_id: 'ath_2', full_name: 'Second Child' },
        ],
      });
    }
    if (url.includes('/api/pilot/profile/card')) return jsonResponse({ error: 'not in this test' }, false);
    return jsonResponse({ ok: true, items: [], announcements: [], card: null });
  }) as unknown as typeof fetch;
}

async function renderHubAt(url: string) {
  window.history.replaceState(null, '', url);
  installFetch();
  await act(async () => {
    render(<ParentHub />);
  });
  await waitFor(() => expect(screen.getByRole('button', { name: 'First Child' })).toBeInTheDocument());
}

const pressed = (name: string) => screen.getByRole('button', { name }).getAttribute('aria-pressed');

afterEach(() => {
  jest.restoreAllMocks();
  window.sessionStorage.clear();
  window.localStorage.clear();
  window.history.replaceState(null, '', '/');
});

test('?tab=progress opens Progress', async () => {
  await renderHubAt('/parent/dashboard?tab=progress');
  expect(pressed('Progress')).toBe('true');
  expect(pressed('Overview')).toBe('false');
});

test.each([['nonsense'], ['assessments']])('?tab=%s opens Overview, as with no value', async (value) => {
  await renderHubAt(`/parent/dashboard?tab=${value}`);
  expect(pressed('Overview')).toBe('true');
});

test('pressing a tab writes it to the address; Overview leaves none', async () => {
  await renderHubAt('/parent/dashboard');

  fireEvent.click(screen.getByRole('button', { name: 'Messages' }));
  expect(new URLSearchParams(window.location.search).get('tab')).toBe('messages');
  expect(pressed('Messages')).toBe('true');

  fireEvent.click(screen.getByRole('button', { name: 'Overview' }));
  expect(window.location.search).toBe('');
});
