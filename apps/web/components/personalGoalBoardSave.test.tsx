/**
 * @jest-environment jsdom
 */

// Save truth on "I did it" (WO-N5-02): saving says so, and a press the server did not keep says
// that instead of leaving the goal as if nothing had been pressed.

import '@testing-library/jest-dom';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { resetAchievementCeremonyMemory } from './achievementCeremony';
import PersonalGoalBoard from './PersonalGoalBoard';

jest.mock('./useGymSound', () => ({
  __esModule: true,
  default: () => ({ enabled: false, ready: false, status: 'off' as const, play: () => false, setEnabled: async () => false }),
}));

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, json: async () => body } as unknown as Response;
}

let write: 'ok' | 'refused' | 'offline' | 'pending' = 'ok';
let release: () => void = () => {};
let reached: string | null = null;

beforeEach(() => {
  window.localStorage.clear();
  resetAchievementCeremonyMemory();
  write = 'ok';
  reached = null;
  global.fetch = jest.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    if (method === 'GET') {
      return jsonResponse({
        ok: true,
        items: [{ goal_id: 'g1', title: 'Run a mile', why_it_matters: '', target_date: null, reached_at: reached }],
      });
    }
    if (write === 'offline') throw new Error('offline');
    if (write === 'refused') return jsonResponse({ error: 'Forbidden' }, false);
    if (write === 'pending') {
      return new Promise<Response>((resolve) => {
        release = () => {
          reached = '2026-10-12';
          resolve(jsonResponse({ ok: true }));
        };
      });
    }
    reached = '2026-10-12';
    return jsonResponse({ ok: true });
  }) as unknown as typeof fetch;
});

async function renderBoard() {
  render(<PersonalGoalBoard athleteId="ath_1" />);
  await waitFor(() => expect(screen.getByRole('button', { name: /i did it/i })).toBeTruthy());
}

test.each(['refused', 'offline'] as const)('a %s "I did it" says it did not save, and the goal stays open', async (outcome) => {
  write = outcome;
  await renderBoard();
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /i did it/i }));
  });
  expect(screen.getByText('That did not save. Try it again.')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /i did it/i })).toBeInTheDocument();
});

test('"I did it" in flight says "Saving...", and a kept one moves the goal with no extra line', async () => {
  write = 'pending';
  await renderBoard();
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /i did it/i }));
  });
  expect(screen.getByText('Saving...')).toBeInTheDocument();
  await act(async () => {
    release();
  });
  await waitFor(() => expect(screen.queryByRole('button', { name: /i did it/i })).toBeNull());
  expect(screen.queryByText('Saving...')).toBeNull();
  expect(screen.queryByText('That did not save. Try it again.')).toBeNull();
});
