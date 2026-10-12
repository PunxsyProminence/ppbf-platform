/**
 * @jest-environment jsdom
 */

/**
 * WO-PH-09: the Progress tab's "Where things stand", a count of the selected
 * child's recorded progression from the routes the full record reads.
 *
 *   every line is a count of rows: no percentage, no score;
 *
 *   a line whose read did not answer is Unavailable and never 0, and does not
 *   take the other lines with it;
 *
 *   the counts are the selected child's: a sibling's answer, late or not,
 *   never shows under this child's name;
 *
 *   the placeholder and its always-empty milestones list are gone, and the
 *   earned milestones stay with AthleteAchievements.
 */

import '@testing-library/jest-dom';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

import ParentHub from './ParentHub';

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, status: ok ? 200 : 500, json: async () => body } as unknown as Response;
}

type Answer = Record<string, unknown> | 'fail' | 'hang';

interface ChildRecord {
  gaps: Answer;
  assignments: Answer;
  completions: Record<string, Answer>;
}

const RECORDS: Record<string, ChildRecord> = {
  ath_1: {
    gaps: {
      items: [
        { gap_id: 'g1', status: 'identified' },
        { gap_id: 'g2', status: 'in_progress' },
        { gap_id: 'g3', status: 'assigned' },
        { gap_id: 'g4', status: 'completed' },
        { gap_id: 'g5', status: 'deferred' },
      ],
    },
    assignments: {
      items: [
        { assignment_id: 'a1', status: 'assigned' },
        { assignment_id: 'a2', status: 'in_progress' },
        { assignment_id: 'a3', status: 'completed' },
        { assignment_id: 'a4', status: 'incomplete' },
        { assignment_id: 'a5', status: 'cancelled' },
      ],
      workouts: [],
    },
    completions: {
      a1: { items: [] },
      a2: { items: [{ completion_id: 'c1', verification_status: 'pending' }] },
      a3: { items: [{ completion_id: 'c2', verification_status: 'verified' }, { completion_id: 'c3', verification_status: 'verified' }] },
      a4: { items: [{ completion_id: 'c4', verification_status: 'disputed' }] },
      // Never asked: a withdrawn assignment's work is not counted.
      a5: { items: [{ completion_id: 'c5', verification_status: 'verified' }] },
    },
  },
  ath_2: {
    gaps: { items: [{ gap_id: 'g9', status: 'identified' }] },
    assignments: { items: [{ assignment_id: 'b1', status: 'completed' }], workouts: [] },
    completions: { b1: { items: [{ completion_id: 'c9', verification_status: 'verified' }] } },
  },
};

const MESSAGES = {
  ok: true,
  items: [
    { note_id: 'n1', athlete_id: 'ath_1', athlete_name: 'First Child', sender_role: 'coach', note_text: 'Bring gloves', created_at: '2026-10-01T12:00:00.000Z', task: { due_date: '2026-10-15', completed_at: '2026-10-14T12:00:00.000Z' } },
    { note_id: 'n2', athlete_id: 'ath_1', athlete_name: 'First Child', sender_role: 'coach', note_text: 'Medical form', created_at: '2026-10-01T12:00:00.000Z', task: { due_date: '2026-10-16', completed_at: null } },
    { note_id: 'n3', athlete_id: 'ath_1', athlete_name: 'First Child', sender_role: 'coach', note_text: 'Great week', created_at: '2026-10-01T12:00:00.000Z', task: null },
    { note_id: 'n4', athlete_id: 'ath_2', athlete_name: 'Second Child', sender_role: 'coach', note_text: 'Water bottle', created_at: '2026-10-01T12:00:00.000Z', task: { due_date: '2026-10-16', completed_at: null } },
  ],
};

function answer(value: Answer | undefined, init?: RequestInit): Promise<Response> {
  if (value === 'fail' || value === undefined) return Promise.resolve(jsonResponse({ error: 'no' }, false));
  if ((value as unknown) === 'fail-with-items') return Promise.resolve(jsonResponse({ items: [] }, false));
  if (value === 'hang') {
    return new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      });
    });
  }
  return Promise.resolve(jsonResponse(value));
}

function installFetch(records: Record<string, ChildRecord> = RECORDS, messages: Answer = MESSAGES): jest.Mock {
  const fetchMock = jest.fn(async (input: unknown, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    const athleteId = url.searchParams.get('athlete_id') ?? '';
    if (url.pathname.includes('/api/pilot/athletes/list')) {
      return jsonResponse({
        items: [
          { athlete_id: 'ath_1', full_name: 'First Child' },
          { athlete_id: 'ath_2', full_name: 'Second Child' },
        ],
      });
    }
    if (url.pathname.endsWith('/api/pilot/progression/gaps')) return answer(records[athleteId]?.gaps, init);
    if (url.pathname.endsWith('/api/pilot/progression/assignments')) return answer(records[athleteId]?.assignments, init);
    if (url.pathname.endsWith('/api/pilot/progression/completions')) {
      const assignmentId = url.searchParams.get('assignment_id') ?? '';
      const owner = Object.values(records).find((record) => assignmentId in record.completions);
      return answer(owner?.completions[assignmentId], init);
    }
    if (url.pathname.includes('/api/pilot/parent/messages')) return answer(messages, init);
    if (url.pathname.includes('/api/pilot/profile/card')) return jsonResponse({ error: 'not in this test' }, false);
    return jsonResponse({ ok: true, items: [], announcements: [], classes: [], registrations: [], attendance: [], card: null, completed_sessions: 0 });
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

async function renderProgress() {
  await act(async () => {
    render(<ParentHub />);
  });
  await waitFor(() => expect(screen.getByRole('button', { name: 'First Child' })).toBeInTheDocument());
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Progress' }));
  });
}

const value = (testId: string) => screen.getByTestId(testId).textContent;

afterEach(() => {
  jest.restoreAllMocks();
});

describe('the counts', () => {
  test('each line counts the selected child’s recorded rows', async () => {
    installFetch();
    await renderProgress();

    await waitFor(() => expect(value('summary-logged')).not.toBe('Reading...'));
    // Every gap on record: nothing in the app closes one, so none is called open.
    expect(value('summary-gaps')).toBe('5 on record');
    // The cancelled one is not counted as work.
    expect(value('summary-assignments')).toBe('2 open · 1 completed · 1 closed, not completed');
    // Logged work is every entry the full record lists, withdrawn work included.
    expect(value('summary-logged')).toBe('5 entries: 3 verified by a coach · 1 waiting for a coach · 1 disputed');
    // n1 done, n2 open; n3 is a message with no task; n4 is the sibling's.
    expect(value('summary-support')).toBe('1 of 2 done');
  });

  test('logged work is asked of every assignment, as the full record asks, a few at a time', async () => {
    let inFlight = 0;
    let most = 0;
    const fetchMock = installFetch();
    const base = fetchMock.getMockImplementation() as (input: unknown, init?: RequestInit) => Promise<Response>;
    fetchMock.mockImplementation(async (input: unknown, init?: RequestInit) => {
      if (!String(input).includes('/api/pilot/progression/completions')) return base(input, init);
      inFlight += 1;
      most = Math.max(most, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return base(input, init);
    });
    await renderProgress();
    await waitFor(() => expect(value('summary-logged')).not.toBe('Reading...'));
    const asked = fetchMock.mock.calls
      .map((call) => String(call[0]))
      .filter((url) => url.includes('/api/pilot/progression/completions') && url.includes('assignment_id=a'));
    expect(asked).toHaveLength(5);
    expect(most).toBeLessThanOrEqual(4);
  });

  test('a workout counts once: open while any step is open', async () => {
    installFetch({
      ...RECORDS,
      ath_1: {
        gaps: { items: [] },
        assignments: {
          items: [
            { assignment_id: 's1', status: 'completed' },
            { assignment_id: 's2', status: 'assigned' },
            { assignment_id: 's3', status: 'assigned' },
            { assignment_id: 'd1', status: 'completed' },
            { assignment_id: 'd2', status: 'completed' },
            { assignment_id: 'solo', status: 'completed' },
          ],
          workouts: [
            { issue_id: 'w1', template_name: 'Home footwork', steps: [
              { ordinal: 1, block: 'main', scale_level: null, contact_level: 'none', coach_note: null, assignment_id: 's1' },
              { ordinal: 2, block: 'main', scale_level: null, contact_level: 'none', coach_note: null, assignment_id: 's2' },
              { ordinal: 3, block: 'main', scale_level: null, contact_level: 'none', coach_note: null, assignment_id: 's3' },
            ] },
            { issue_id: 'w2', template_name: 'Done session', steps: [
              { ordinal: 1, block: 'main', scale_level: null, contact_level: 'none', coach_note: null, assignment_id: 'd1' },
              { ordinal: 2, block: 'main', scale_level: null, contact_level: 'none', coach_note: null, assignment_id: 'd2' },
            ] },
          ],
        },
        completions: { s1: { items: [] }, s2: { items: [] }, s3: { items: [] }, d1: { items: [] }, d2: { items: [] }, solo: { items: [] } },
      },
    });
    await renderProgress();
    await waitFor(() => expect(value('summary-assignments')).toBe('1 open · 2 completed'));
  });

  test('real zeros are zeros', async () => {
    installFetch({
      ath_1: { gaps: { items: [] }, assignments: { items: [], workouts: [] }, completions: {} },
      ath_2: RECORDS.ath_2,
    }, { ok: true, items: [] });
    await renderProgress();
    await waitFor(() => expect(value('summary-logged')).not.toBe('Reading...'));
    expect(value('summary-gaps')).toBe('0 on record');
    expect(value('summary-assignments')).toBe('0 open · 0 completed');
    expect(value('summary-logged')).toBe('0 entries: 0 verified by a coach · 0 waiting for a coach · 0 disputed');
    expect(value('summary-support')).toBe('None set yet');
  });

  test('no percentage and no account id anywhere in the summary', async () => {
    installFetch();
    await renderProgress();
    await waitFor(() => expect(value('summary-logged')).not.toBe('Reading...'));
    const panel = screen.getByRole('region', { name: 'Where things stand' });
    expect(panel.textContent ?? '').not.toMatch(/\d+\s*%/);
    expect(panel.textContent ?? '').not.toMatch(/acct_|account/i);
  });
});

describe('a read that did not answer', () => {
  test('a failed gaps read makes only that line Unavailable', async () => {
    installFetch({ ...RECORDS, ath_1: { ...RECORDS.ath_1, gaps: 'fail' } });
    await renderProgress();
    await waitFor(() => expect(value('summary-gaps')).toBe('Unavailable'));
    expect(value('summary-assignments')).toBe('2 open · 1 completed · 1 closed, not completed');
  });

  test('a failed assignments read makes assignments and logged work Unavailable, not 0', async () => {
    installFetch({ ...RECORDS, ath_1: { ...RECORDS.ath_1, assignments: 'fail' } });
    await renderProgress();
    await waitFor(() => expect(value('summary-assignments')).toBe('Unavailable'));
    expect(value('summary-logged')).toBe('Unavailable');
    expect(value('summary-gaps')).toBe('5 on record');
  });

  test('one failed completions read makes the logged-work line Unavailable rather than an undercount', async () => {
    installFetch({ ...RECORDS, ath_1: { ...RECORDS.ath_1, completions: { ...RECORDS.ath_1.completions, a3: 'fail' } } });
    await renderProgress();
    await waitFor(() => expect(value('summary-logged')).toBe('Unavailable'));
    expect(value('summary-assignments')).toBe('2 open · 1 completed · 1 closed, not completed');
  });

  test('an unknown verification status is not guessed at', async () => {
    installFetch({ ...RECORDS, ath_1: { ...RECORDS.ath_1, completions: { ...RECORDS.ath_1.completions, a1: { items: [{ completion_id: 'x', verification_status: 'mystery' }] } } } });
    await renderProgress();
    await waitFor(() => expect(value('summary-logged')).toBe('Unavailable'));
  });

  test('a refused read that still carries a list is not read as that list', async () => {
    installFetch({ ...RECORDS, ath_1: { ...RECORDS.ath_1, gaps: 'fail-with-items' as unknown as Answer } });
    await renderProgress();
    await waitFor(() => expect(value('summary-gaps')).toBe('Unavailable'));
  });

  test('an assignment without an id, or an item that is not a row, makes the line Unavailable', async () => {
    installFetch({ ...RECORDS, ath_1: { ...RECORDS.ath_1, assignments: { items: [{ status: 'assigned' }], workouts: [] } } });
    await renderProgress();
    await waitFor(() => expect(value('summary-assignments')).toBe('Unavailable'));
    expect(value('summary-logged')).toBe('Unavailable');
  });

  test('a gaps list holding something that is not a row is Unavailable', async () => {
    installFetch({ ...RECORDS, ath_1: { ...RECORDS.ath_1, gaps: { items: [null, 'x'] } } });
    await renderProgress();
    await waitFor(() => expect(value('summary-gaps')).toBe('Unavailable'));
  });

  test('the support line reads while the messages read is out', async () => {
    installFetch(RECORDS, 'hang');
    await renderProgress();
    await waitFor(() => expect(value('summary-gaps')).toBe('5 on record'));
    expect(value('summary-support')).toBe('Reading...');
  });

  test('a messages read that did not answer makes the support line Unavailable', async () => {
    installFetch(RECORDS, 'fail');
    await renderProgress();
    await waitFor(() => expect(value('summary-gaps')).toBe('5 on record'));
    expect(value('summary-support')).toBe('Unavailable');
  });
});

describe('the child on screen', () => {
  test('switching moves every line, and the previous child’s counts are not shown while the new reads are open', async () => {
    installFetch({ ...RECORDS, ath_2: { ...RECORDS.ath_2, gaps: 'hang' } });
    await renderProgress();
    await waitFor(() => expect(value('summary-gaps')).toBe('5 on record'));

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Second Child' }));
    });
    // The second child's gaps read is still open: nothing from the first child.
    expect(value('summary-gaps')).toBe('Reading...');
    expect(value('summary-assignments')).toBe('Reading...');
    expect(value('summary-support')).toBe('0 of 1 done');
  });

  test('the second child’s own counts', async () => {
    installFetch();
    await renderProgress();
    await waitFor(() => expect(value('summary-gaps')).toBe('5 on record'));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Second Child' }));
    });
    await waitFor(() => expect(value('summary-gaps')).toBe('1 on record'));
    expect(value('summary-assignments')).toBe('0 open · 1 completed');
    expect(value('summary-logged')).toBe('1 entry: 1 verified by a coach · 0 waiting for a coach · 0 disputed');
  });

  test('a late answer for the child left behind does not overwrite the child on screen', async () => {
    let releaseFirst: (() => void) | null = null;
    let firstGapsCalls = 0;
    const fetchMock = installFetch();
    const base = fetchMock.getMockImplementation() as (input: unknown, init?: RequestInit) => Promise<Response>;
    fetchMock.mockImplementation(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/pilot/progression/gaps') && url.includes('athlete_id=ath_1')) {
        firstGapsCalls += 1;
        // The first child's gaps answer arrives only when released, and
        // ignores the abort: it is already in the pipe.
        if (firstGapsCalls === 1) {
          return new Promise<Response>((resolve) => {
            releaseFirst = () => resolve(jsonResponse(RECORDS.ath_1.gaps));
          });
        }
      }
      return base(input, init);
    });
    await renderProgress();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Second Child' }));
    });
    await waitFor(() => expect(value('summary-gaps')).toBe('1 on record'));
    await act(async () => {
      (releaseFirst as (() => void) | null)?.();
    });
    expect(value('summary-gaps')).toBe('1 on record');
    expect(value('summary-assignments')).toBe('0 open · 1 completed');
  });
});

describe('reads left behind are stopped', () => {
  test('switching child aborts the open gaps read for the child left behind', async () => {
    const fetchMock = installFetch({ ...RECORDS, ath_1: { ...RECORDS.ath_1, gaps: 'hang' } });
    await renderProgress();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Second Child' }));
    });
    const gapsCall = fetchMock.mock.calls.find((call) =>
      String(call[0]).includes('/api/pilot/progression/gaps') && String(call[0]).includes('athlete_id=ath_1'));
    expect((gapsCall?.[1] as RequestInit).signal?.aborted).toBe(true);
    await waitFor(() => expect(value('summary-gaps')).toBe('1 on record'));
  });
});

describe('no child selected', () => {
  test('a roster that failed says so and still links the full record', async () => {
    const fetchMock = installFetch();
    const base = fetchMock.getMockImplementation() as (input: unknown, init?: RequestInit) => Promise<Response>;
    fetchMock.mockImplementation(async (input: unknown, init?: RequestInit) =>
      (String(input).includes('/api/pilot/athletes/list') ? jsonResponse({ error: 'down' }, false) : base(input, init)));
    await act(async () => {
      render(<ParentHub />);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Progress' }));
    });
    await screen.findByText('Unavailable - no child selected.');
    expect(screen.getByRole('link', { name: 'Open the full progression record' })).toHaveAttribute('href', '/parent/progression-visibility');
  });

  test('a roster still loading is reading, not "no child"', async () => {
    const fetchMock = installFetch();
    const base = fetchMock.getMockImplementation() as (input: unknown, init?: RequestInit) => Promise<Response>;
    fetchMock.mockImplementation(async (input: unknown, init?: RequestInit) =>
      (String(input).includes('/api/pilot/athletes/list') ? new Promise<Response>(() => {}) : base(input, init)));
    await act(async () => {
      render(<ParentHub />);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Progress' }));
    });
    expect(screen.queryByText('Unavailable - no child selected.')).toBeNull();
  });
});

describe('what the tab no longer says', () => {
  test('the placeholder and the always-empty milestones list are gone; the full record is linked', async () => {
    installFetch();
    await renderProgress();
    const text = document.body.textContent ?? '';
    expect(text).not.toContain('Parent-Support Visibility Placeholder');
    expect(text).not.toContain('FRONT-END PLACEHOLDER');
    expect(text).not.toContain('there is no backend feed for progress milestones');
    expect(screen.getByRole('link', { name: 'Open the full progression record' })).toHaveAttribute('href', '/parent/progression-visibility');
  });
});
