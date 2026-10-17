/**
 * @jest-environment jsdom
 */

/**
 * UX audit A-8: the coach's multi-week plan and the mental-skills log were
 * reachable by a parent only through the catalog. The hub's Progress tab links
 * both, and a click carries the child on screen (src/lib/chosenChild.ts), never
 * in the address.
 */

import '@testing-library/jest-dom';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { readChosenChild, rememberChosenChild } from '@/src/lib/chosenChild';
import ParentHub from './ParentHub';

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, status: ok ? 200 : 500, json: async () => body } as unknown as Response;
}

beforeEach(() => {
  global.fetch = jest.fn(async (input: unknown) => {
    const url = new URL(String(input), 'http://localhost');
    if (url.pathname.includes('/api/pilot/athletes/list')) {
      return jsonResponse({
        items: [
          { athlete_id: 'ath_1', full_name: 'First Child' },
          { athlete_id: 'ath_2', full_name: 'Second Child' },
        ],
      });
    }
    if (url.pathname.includes('/api/pilot/profile/card')) return jsonResponse({ error: 'not in this test' }, false);
    return jsonResponse({ ok: true, items: [], announcements: [], classes: [], registrations: [], attendance: [], card: null, completed_sessions: 0 });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  jest.restoreAllMocks();
  window.sessionStorage.clear();
  window.localStorage.clear();
});

test('the Progress tab links the development plan and mental skills, carrying the child on screen', async () => {
  await act(async () => {
    render(<ParentHub />);
  });
  await waitFor(() => expect(screen.getByRole('button', { name: 'Second Child' })).toBeInTheDocument());
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Second Child' }));
  });
  // The switch itself is remembered (the hub's save effect), before any link
  // is clicked -- a link opened another way still lands on this child.
  expect(window.sessionStorage.getItem('ppbf.parent.chosenChild')).toBe('ath_2');
  expect(window.localStorage.getItem('ppbf.parent.chosenChild')).toBe('ath_2');
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Progress' }));
  });

  const plan = screen.getByRole('link', { name: 'Their Development Plan' });
  const mental = screen.getByRole('link', { name: 'Mental Skills' });
  // The bare page address: the child never rides in the URL (A-9 ruling).
  expect(plan).toHaveAttribute('href', '/parent/development-blocks');
  expect(mental).toHaveAttribute('href', '/parent/mental-skills');

  window.sessionStorage.clear();
  fireEvent.click(mental);
  expect(window.sessionStorage.getItem('ppbf.parent.chosenChild')).toBe('ath_2');
});

/* UX audit A-9: the hub opens on the child chosen on another family page, when
   that child is one of this guardian's own, and does not write its own
   default over that pick while it loads. */
async function renderHubSettled() {
  await act(async () => {
    render(<ParentHub />);
  });
  await waitFor(() => expect(screen.getByRole('button', { name: 'Second Child' })).toBeInTheDocument());
  await act(async () => {});
}

test('opens on the remembered child when that child is in its own list, and keeps the pick', async () => {
  rememberChosenChild('ath_2');
  await renderHubSettled();
  expect(screen.getByRole('button', { name: 'Second Child' })).toHaveAttribute('aria-pressed', 'true');
  expect(screen.getByRole('button', { name: 'First Child' })).toHaveAttribute('aria-pressed', 'false');
  // Not overwritten on mount, in either store.
  expect(window.sessionStorage.getItem('ppbf.parent.chosenChild')).toBe('ath_2');
  expect(window.localStorage.getItem('ppbf.parent.chosenChild')).toBe('ath_2');
});

test('opens on the first child when the remembered id is not one of theirs', async () => {
  rememberChosenChild('ath_other_family');
  await renderHubSettled();
  expect(screen.getByRole('button', { name: 'First Child' })).toHaveAttribute('aria-pressed', 'true');
  expect(screen.getByRole('button', { name: 'Second Child' })).toHaveAttribute('aria-pressed', 'false');
  expect(readChosenChild()).toBe('ath_1');
});
