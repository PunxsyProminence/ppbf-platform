/**
 * @jest-environment jsdom
 */

// The coach's read-back of what the gym posted to a family (#1542, FC-01):
// each note, who posted it, when in gym time, its due date, and the family's
// done / still-to-do state. A failed read says so, never "nothing posted".

import '@testing-library/jest-dom';
import { act, render, screen } from '@testing-library/react';

import FamilyNotesPosted, { type FamilyNoteRow } from './FamilyNotesPosted';

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, status: ok ? 200 : 500, json: async () => body } as unknown as Response;
}

const DONE: FamilyNoteRow = {
  note_id: 'n2',
  note_text: 'Medical form by Friday, please.',
  // 7:02 PM Eastern on 2026-10-13 is 23:02 UTC.
  posted_at: '2026-10-13T22:40:00.000Z',
  posted_by_name: 'Coach Pat',
  task: { due_date: '2026-10-16', completed_at: '2026-10-13T23:02:00.000Z' },
};
const OPEN: FamilyNoteRow = {
  note_id: 'n1',
  note_text: 'Bring gloves Thursday.',
  posted_at: '2026-10-12T21:00:00.000Z',
  posted_by_name: 'Coach Sam',
  task: { due_date: '2026-10-15', completed_at: null },
};
const UNDATED: FamilyNoteRow = {
  note_id: 'n0',
  note_text: 'Great week.',
  posted_at: '2026-10-11T21:00:00.000Z',
  posted_by_name: 'Coach Sam',
  task: null,
};

afterEach(() => {
  jest.restoreAllMocks();
});

test('each note reads with its author, gym time, due date and the family state, in the order the server gives', async () => {
  const fetchMock = jest.fn(async () => jsonResponse({ items: [DONE, OPEN, UNDATED] }));
  global.fetch = fetchMock as unknown as typeof fetch;

  await act(async () => {
    render(<FamilyNotesPosted athleteId="ath-1" refreshKey={0} />);
  });

  const items = screen.getAllByRole('listitem');
  expect(items.map((item) => item.querySelector('.t-body')?.textContent)).toEqual([
    'Medical form by Friday, please.',
    'Bring gloves Thursday.',
    'Great week.',
  ]);
  expect(items[0]!.textContent).toContain('Coach Pat');
  expect(items[0]!.textContent).toMatch(/Done .*7:02/);
  expect(items[0]!.textContent).toContain('Due ');
  expect(items[1]!.textContent).toContain('Still to do');
  // No due date and never ticked: no state is invented for it.
  expect(items[2]!.textContent).not.toMatch(/Still to do|Done/);
  expect(fetchMock).toHaveBeenCalledWith(
    expect.stringContaining('/api/pilot/coach/family-notes?athlete_id=ath-1'),
    expect.anything(),
  );
});

test('a failed read says so, and never that nothing was posted', async () => {
  global.fetch = jest.fn(async () => jsonResponse({ error: 'boom' }, false)) as unknown as typeof fetch;

  await act(async () => {
    render(<FamilyNotesPosted athleteId="ath-1" refreshKey={0} />);
  });

  expect(screen.getByRole('alert').textContent).toContain('could not be loaded');
  expect(screen.queryByText(/Nothing has been posted/)).toBeNull();
});

test('an empty read says nothing has been posted yet', async () => {
  global.fetch = jest.fn(async () => jsonResponse({ items: [] })) as unknown as typeof fetch;

  await act(async () => {
    render(<FamilyNotesPosted athleteId="ath-1" refreshKey={0} />);
  });

  expect(screen.getByText('Nothing has been posted to this family yet.')).toBeInTheDocument();
});

test('a new refreshKey re-reads, so a note just posted appears', async () => {
  const fetchMock = jest.fn()
    .mockResolvedValueOnce(jsonResponse({ items: [] }))
    .mockResolvedValueOnce(jsonResponse({ items: [OPEN] }));
  global.fetch = fetchMock as unknown as typeof fetch;

  let view: ReturnType<typeof render> | null = null;
  await act(async () => {
    view = render(<FamilyNotesPosted athleteId="ath-1" refreshKey={0} />);
  });
  await act(async () => {
    view!.rerender(<FamilyNotesPosted athleteId="ath-1" refreshKey={1} />);
  });

  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(screen.getByText('Bring gloves Thursday.')).toBeInTheDocument();
});

test("the render right after a switch shows loading, not the last athlete's notes", async () => {
  let finishSecond: ((value: Response) => void) | null = null;
  global.fetch = jest.fn((input: RequestInfo | URL) => {
    if (String(input).includes('athlete_id=ath-2')) {
      return new Promise<Response>((resolve) => { finishSecond = resolve; });
    }
    return Promise.resolve(jsonResponse({ items: [OPEN] }));
  }) as unknown as typeof fetch;

  let view: ReturnType<typeof render> | null = null;
  await act(async () => {
    view = render(<FamilyNotesPosted athleteId="ath-1" refreshKey={0} />);
  });
  expect(screen.getByText('Bring gloves Thursday.')).toBeInTheDocument();

  view!.rerender(<FamilyNotesPosted athleteId="ath-2" refreshKey={0} />);
  expect(screen.queryByText('Bring gloves Thursday.')).toBeNull();
  expect(screen.getByText('Loading what was posted…')).toBeInTheDocument();

  await act(async () => {
    finishSecond?.(jsonResponse({ items: [] }));
  });
});

test("a slow read for the athlete just left never shows under the next athlete's name", async () => {
  let finishFirst: ((value: Response) => void) | null = null;
  global.fetch = jest.fn((input: RequestInfo | URL) => {
    if (String(input).includes('athlete_id=ath-1')) {
      return new Promise<Response>((resolve) => { finishFirst = resolve; });
    }
    return Promise.resolve(jsonResponse({ items: [] }));
  }) as unknown as typeof fetch;

  let view: ReturnType<typeof render> | null = null;
  await act(async () => {
    view = render(<FamilyNotesPosted athleteId="ath-1" refreshKey={0} />);
  });
  await act(async () => {
    view!.rerender(<FamilyNotesPosted athleteId="ath-2" refreshKey={0} />);
  });
  await act(async () => {
    finishFirst?.(jsonResponse({ items: [OPEN] }));
  });

  expect(screen.queryByText('Bring gloves Thursday.')).toBeNull();
  expect(screen.getByText('Nothing has been posted to this family yet.')).toBeInTheDocument();
});
