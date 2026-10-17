/**
 * @jest-environment jsdom
 */

// UXB Q1 B (lane U3 L5b): "I did it" is one tap, and a slip can be taken back
// for ten minutes with a short Undo line. The server holds the window and the
// owner (personalGoalUndo.pg.test.ts); this file holds what the board offers.

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

import PersonalGoalBoard from './PersonalGoalBoard';

function json(body: unknown, ok = true, status = ok ? 200 : 500): Response {
  return { ok, status, json: async () => body } as unknown as Response;
}

function goal(reachedAt: string | null) {
  return { goal_id: 'g1', own_words: 'Run a mile', title: 'Run a mile', why_it_matters: '', target_date: null, reached_at: reachedAt, created_at: '2026-10-01T12:00:00Z' };
}

afterEach(() => {
  jest.restoreAllMocks();
});

test('a fresh mark offers Undo, and Undo sends the athlete\'s own undo', async () => {
  let reachedAt: string | null = new Date(Date.now() - 60_000).toISOString();
  const patches: Array<Record<string, unknown>> = [];
  global.fetch = jest.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'PATCH') {
      patches.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      reachedAt = null;
      return json({ ok: true });
    }
    return json({ items: [goal(reachedAt)] });
  }) as unknown as typeof fetch;

  const onChanged = jest.fn();
  render(<PersonalGoalBoard athleteId="ath_1" onChanged={onChanged} />);

  const undo = await screen.findByRole('button', { name: 'Undo' });
  await act(async () => {
    fireEvent.click(undo);
  });

  expect(patches).toEqual([{ athlete_id: 'ath_1', goal_id: 'g1', undo: true }]);
  // Back on the working list, with I did it again.
  expect(await screen.findByRole('button', { name: 'I did it' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull();
  expect(onChanged).toHaveBeenCalled();
});

test('a mark older than ten minutes offers no Undo', async () => {
  global.fetch = jest.fn(async () => json({ items: [goal(new Date(Date.now() - 11 * 60_000).toISOString())] })) as unknown as typeof fetch;
  render(<PersonalGoalBoard athleteId="ath_1" />);

  await screen.findByText('Done');
  expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull();
});

test('a family reader is offered no Undo', async () => {
  global.fetch = jest.fn(async () => json({ items: [goal(new Date().toISOString())] })) as unknown as typeof fetch;
  render(<PersonalGoalBoard athleteId="ath_1" readOnly />);

  await screen.findByText('Done');
  expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull();
});

test('when the server says the window has closed, the board says so and the mark stands', async () => {
  global.fetch = jest.fn(async (_input: RequestInfo | URL, init?: RequestInit) => (init?.method === 'PATCH'
    ? json({ error: 'That can no longer be undone.' }, false, 409)
    : json({ items: [goal(new Date(Date.now() - 9 * 60_000).toISOString())] }))) as unknown as typeof fetch;
  render(<PersonalGoalBoard athleteId="ath_1" />);

  const undo = await screen.findByRole('button', { name: 'Undo' });
  await act(async () => {
    fireEvent.click(undo);
  });

  await waitFor(() => expect(screen.getByRole('status').textContent).toBe('That can no longer be undone.'));
  expect(screen.getByText('Done')).toBeTruthy();
});

test('two Undo presses before the first is answered send one', async () => {
  let release: (() => void) | null = null;
  let patches = 0;
  global.fetch = jest.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'PATCH') {
      patches += 1;
      await new Promise<void>((resolve) => { release = resolve; });
      return json({ ok: true });
    }
    return json({ items: [goal(new Date().toISOString())] });
  }) as unknown as typeof fetch;
  render(<PersonalGoalBoard athleteId="ath_1" />);

  const undo = await screen.findByRole('button', { name: 'Undo' });
  act(() => {
    undo.click();
    undo.click();
  });
  await waitFor(() => expect(patches).toBe(1));
  await act(async () => {
    release?.();
  });
  expect(patches).toBe(1);
});
