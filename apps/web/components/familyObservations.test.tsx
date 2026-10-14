/**
 * @jest-environment jsdom
 */

// The coach's read of what the family recorded at home (F-073): category,
// rating when given, the words, "a guardian" and when in gym time; newest
// read wins on an athlete switch; a failed read says so, never "nothing".

import '@testing-library/jest-dom';
import { act, render, screen, within } from '@testing-library/react';

import FamilyObservations from './FamilyObservations';

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, status: ok ? 200 : 500, json: async () => body } as unknown as Response;
}

const RATED = {
  note_id: 'o2',
  category: 'energy',
  rating: 4,
  notes: 'Tired after a double shift\nat school.',
  // 23:30 UTC on Oct 12 is 7:30 PM in the gym.
  created_at: '2026-10-12T23:30:00.000Z',
};
const UNRATED = {
  note_id: 'o1',
  category: 'sleep_recovery',
  rating: null,
  notes: 'Slept well all week.',
  created_at: '2026-10-10T14:00:00.000Z',
};

afterEach(() => {
  jest.restoreAllMocks();
});

test('each observation reads with its category, rating if given, the words, a guardian and gym time, in the order given', async () => {
  const fetchMock = jest.fn(async () => jsonResponse({ items: [RATED, UNRATED] }));
  global.fetch = fetchMock as unknown as typeof fetch;

  await act(async () => {
    render(<FamilyObservations athleteId="ath-1" />);
  });

  const items = within(screen.getByRole('list', { name: 'Family observations' })).getAllByRole('listitem');
  expect(items).toHaveLength(2);
  expect(items[0]!.textContent).toContain('Energy · 4 out of 10');
  expect(items[0]!.textContent).toContain('Tired after a double shift');
  expect(items[0]!.textContent).toMatch(/A guardian · .*7:30/);
  expect(items[1]!.textContent).toContain('Sleep & recovery');
  expect(items[1]!.textContent).not.toContain('out of 10');
  expect(fetchMock).toHaveBeenCalledWith(
    expect.stringContaining('/api/pilot/coach/family-observations?athlete_id=ath-1'),
    expect.anything(),
  );
});

test('a failed read says so, and never that nothing was recorded', async () => {
  global.fetch = jest.fn(async () => jsonResponse({ error: 'boom' }, false)) as unknown as typeof fetch;

  await act(async () => {
    render(<FamilyObservations athleteId="ath-1" />);
  });

  expect(screen.getByRole('alert').textContent).toContain('could not be loaded');
  expect(screen.queryByText(/No observations from the family yet/)).toBeNull();
});

test('an empty read says nothing has been recorded yet', async () => {
  global.fetch = jest.fn(async () => jsonResponse({ items: [] })) as unknown as typeof fetch;

  await act(async () => {
    render(<FamilyObservations athleteId="ath-1" />);
  });

  expect(screen.getByText('No observations from the family yet.')).toBeInTheDocument();
});

test("a slow read for the athlete just left never shows under the next athlete's name", async () => {
  let finishFirst: ((value: Response) => void) | null = null;
  global.fetch = jest.fn((input: RequestInfo | URL) => {
    if (String(input).includes('athlete_id=ath-1')) {
      return new Promise<Response>((resolve) => { finishFirst = resolve; });
    }
    return Promise.resolve(jsonResponse({ items: [] }));
  }) as unknown as typeof fetch;

  const view = render(<FamilyObservations athleteId="ath-1" />);
  await act(async () => {});
  await act(async () => {
    view.rerender(<FamilyObservations athleteId="ath-2" />);
  });
  await act(async () => {
    finishFirst?.(jsonResponse({ items: [RATED] }));
  });

  expect(screen.queryByText(/Tired after a double shift/)).toBeNull();
  expect(screen.getByText('No observations from the family yet.')).toBeInTheDocument();
});
