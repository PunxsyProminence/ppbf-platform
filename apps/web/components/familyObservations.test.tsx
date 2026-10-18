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

test('the newest ten show first; Show more reveals the older ones, saying how many are left', async () => {
  const many = Array.from({ length: 23 }, (_, index) => ({
    note_id: `o-${index}`,
    category: 'energy',
    rating: null,
    notes: `Note ${index}`,
    created_at: new Date(Date.UTC(2026, 9, 30 - index, 12)).toISOString(),
  }));
  global.fetch = jest.fn(async () => jsonResponse({ items: many })) as unknown as typeof fetch;

  await act(async () => {
    render(<FamilyObservations athleteId="ath-1" />);
  });

  const list = () => within(screen.getByRole('list', { name: 'Family observations' })).getAllByRole('listitem');
  expect(list()).toHaveLength(10);
  expect(list()[0]!.textContent).toContain('Note 0');
  await act(async () => {
    screen.getByRole('button', { name: 'Show 10 more (13 older)' }).click();
  });
  expect(list()).toHaveLength(20);
  await act(async () => {
    screen.getByRole('button', { name: 'Show 3 more (3 older)' }).click();
  });
  expect(list()).toHaveLength(23);
  expect(screen.queryByRole('button', { name: /more/ })).toBeNull();
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

// UXB-05: a reload would throw away every unsent draft on the Decision Loop.
test('a failed read offers Check again, which re-runs this read only, and never says Reload', async () => {
  let fail = true;
  const fetchMock = jest.fn(async () => (fail ? jsonResponse({ error: 'down' }, false) : jsonResponse({ items: [RATED] })));
  global.fetch = fetchMock as unknown as typeof fetch;

  await act(async () => {
    render(<FamilyObservations athleteId="ath-1" />);
  });
  expect(screen.getByRole('alert')).toHaveTextContent('could not be loaded');
  expect(document.body.textContent).not.toMatch(/reload/i);

  fail = false;
  await act(async () => {
    screen.getByRole('button', { name: 'Check again' }).click();
  });

  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.getByText(/Tired after a double shift/)).toBeInTheDocument();
});
