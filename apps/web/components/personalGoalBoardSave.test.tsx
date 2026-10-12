/**
 * @jest-environment jsdom
 */

// Save truth on "I did it" (WO-N5-02): saving says so, and a press the server did not keep says
// that instead of leaving the goal as if nothing had been pressed.

import '@testing-library/jest-dom';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

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
let extraGoals: Array<Record<string, unknown>> = [];
let refuseGoal: string | null = null;

beforeEach(() => {
  window.localStorage.clear();
  resetAchievementCeremonyMemory();
  write = 'ok';
  reached = null;
  extraGoals = [];
  refuseGoal = null;
  global.fetch = jest.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    if (method === 'GET') {
      return jsonResponse({
        ok: true,
        items: [
          { goal_id: 'g1', title: 'Run a mile', why_it_matters: '', target_date: null, reached_at: reached },
          ...extraGoals,
        ],
      });
    }
    if (write === 'offline') throw new Error('offline');
    const goalId = (JSON.parse(String(init?.body)) as { goal_id?: string }).goal_id;
    if (goalId === refuseGoal) return jsonResponse({ error: 'Forbidden' }, false);
    if (goalId !== 'g1') {
      extraGoals = extraGoals.map((goal) => (goal.goal_id === goalId ? { ...goal, reached_at: '2026-10-12' } : goal));
      return jsonResponse({ ok: true });
    }
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
  await waitFor(() => expect(screen.getAllByRole('button', { name: /i did it/i }).length).toBeGreaterThan(0));
}

test.each(['refused', 'offline'] as const)('a %s "I did it" says it did not save, and the goal stays open', async (outcome) => {
  write = outcome;
  await renderBoard();
  await act(async () => {
    fireEvent.click(screen.getAllByRole('button', { name: /i did it/i })[0]);
  });
  expect(screen.getByText('That did not save. Try it again.')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /i did it/i })).toBeInTheDocument();
});

test('"I did it" in flight says "Saving...", and a kept one moves the goal with no extra line', async () => {
  write = 'pending';
  await renderBoard();
  await act(async () => {
    fireEvent.click(screen.getAllByRole('button', { name: /i did it/i })[0]);
  });
  expect(screen.getByText('Saving...')).toBeInTheDocument();
  await act(async () => {
    release();
  });
  await waitFor(() => expect(screen.queryByRole('button', { name: /i did it/i })).toBeNull());
  expect(screen.queryByText('Saving...')).toBeNull();
  expect(screen.queryByText('That did not save. Try it again.')).toBeNull();
});

test('with another goal still open, a kept "I did it" leaves no saving line behind', async () => {
  extraGoals = [{ goal_id: 'g2', title: 'Hold my guard', why_it_matters: '', target_date: null, reached_at: null }];
  await renderBoard();
  await act(async () => {
    fireEvent.click(screen.getAllByRole('button', { name: /i did it/i })[0]);
  });
  await waitFor(() => expect(screen.getAllByRole('button', { name: /i did it/i })).toHaveLength(1));
  expect(screen.queryByText('Saving...')).toBeNull();
  expect(screen.queryByText('That did not save. Try it again.')).toBeNull();
});

function goalCard(title: string): HTMLElement {
  return screen.getByText(title).closest('li') as HTMLElement;
}

test('the line sits on the goal that was pressed, at floor size', async () => {
  extraGoals = [{ goal_id: 'g2', title: 'Hold my guard', why_it_matters: '', target_date: null, reached_at: null }];
  refuseGoal = 'g2';
  await renderBoard();
  await act(async () => {
    fireEvent.click(within(goalCard('Hold my guard')).getByRole('button', { name: /i did it/i }));
  });
  const note = within(goalCard('Hold my guard')).getByText('That did not save. Try it again.');
  expect(note.className).toContain('text-[length:var(--t-md)]');
  expect(within(goalCard('Run a mile')).queryByText('That did not save. Try it again.')).toBeNull();
});

test("another goal's kept press does not erase a goal's failure", async () => {
  extraGoals = [{ goal_id: 'g2', title: 'Hold my guard', why_it_matters: '', target_date: null, reached_at: null }];
  refuseGoal = 'g1';
  await renderBoard();
  await act(async () => {
    fireEvent.click(within(goalCard('Run a mile')).getByRole('button', { name: /i did it/i }));
  });
  await act(async () => {
    fireEvent.click(within(goalCard('Hold my guard')).getByRole('button', { name: /i did it/i }));
  });
  await waitFor(() => expect(screen.getAllByRole('button', { name: /i did it/i })).toHaveLength(1));
  expect(within(goalCard('Run a mile')).getByText('That did not save. Try it again.')).toBeInTheDocument();
});

test('a failed press does not follow the kiosk to another athlete', async () => {
  write = 'refused';
  const { rerender } = render(<PersonalGoalBoard athleteId="ath_1" />);
  await waitFor(() => expect(screen.getAllByRole('button', { name: /i did it/i }).length).toBeGreaterThan(0));
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /i did it/i }));
  });
  expect(screen.getByText('That did not save. Try it again.')).toBeInTheDocument();
  rerender(<PersonalGoalBoard athleteId="ath_2" />);
  await waitFor(() => expect(screen.queryByText('That did not save. Try it again.')).toBeNull());
});
