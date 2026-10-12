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
    // identified, assigned, in_progress are open; completed and deferred are not.
    expect(value('summary-gaps')).toBe('3 open');
    // The cancelled one is not counted.
    expect(value('summary-assignments')).toBe('2 working on now · 1 completed · 1 closed, not completed');
    expect(value('summary-logged')).toBe('4 entries: 2 verified by a coach · 1 waiting for a coach · 1 disputed');
    // n1 done, n2 open; n3 is a message with no task; n4 is the sibling's.
    expect(value('summary-support')).toBe('1 of 2 done');
  });

  test('a withdrawn assignment’s logged work is not asked for', async () => {
    const fetchMock = installFetch();
    await renderProgress();
    await waitFor(() => expect(value('summary-logged')).not.toBe('Reading...'));
    const asked = fetchMock.mock.calls
      .map((call) => String(call[0]))
      .filter((url) => url.includes('/api/pilot/progression/completions'));
    expect(asked.some((url) => url.includes('assignment_id=a5'))).toBe(false);
    expect(asked.filter((url) => url.includes('assignment_id=a'))).toHaveLength(4);
  });

  test('real zeros are zeros', async () => {
    installFetch({
      ath_1: { gaps: { items: [] }, assignments: { items: [], workouts: [] }, completions: {} },
      ath_2: RECORDS.ath_2,
    }, { ok: true, items: [] });
    await renderProgress();
    await waitFor(() => expect(value('summary-logged')).not.toBe('Reading...'));
    expect(value('summary-gaps')).toBe('0 open');
    expect(value('summary-assignments')).toBe('0 working on now · 0 completed · 0 closed, not completed');
    expect(value('summary-logged')).toBe('0 entries: 0 verified by a coach · 0 waiting for a coach · 0 disputed');
    expect(value('summary-support')).toBe('0 of 0 done');
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
    expect(value('summary-assignments')).toBe('2 working on now · 1 completed · 1 closed, not completed');
  });

  test('a failed assignments read makes assignments and logged work Unavailable, not 0', async () => {
    installFetch({ ...RECORDS, ath_1: { ...RECORDS.ath_1, assignments: 'fail' } });
    await renderProgress();
    await waitFor(() => expect(value('summary-assignments')).toBe('Unavailable'));
    expect(value('summary-logged')).toBe('Unavailable');
    expect(value('summary-gaps')).toBe('3 open');
  });

  test('one failed completions read makes the logged-work line Unavailable rather than an undercount', async () => {
    installFetch({ ...RECORDS, ath_1: { ...RECORDS.ath_1, completions: { ...RECORDS.ath_1.completions, a3: 'fail' } } });
    await renderProgress();
    await waitFor(() => expect(value('summary-logged')).toBe('Unavailable'));
    expect(value('summary-assignments')).toBe('2 working on now · 1 completed · 1 closed, not completed');
  });

  test('an unknown verification status is not guessed at', async () => {
    installFetch({ ...RECORDS, ath_1: { ...RECORDS.ath_1, completions: { ...RECORDS.ath_1.completions, a1: { items: [{ completion_id: 'x', verification_status: 'mystery' }] } } } });
    await renderProgress();
    await waitFor(() => expect(value('summary-logged')).toBe('Unavailable'));
  });

  test('a messages read that did not answer makes the support line Unavailable', async () => {
    installFetch(RECORDS, 'fail');
    await renderProgress();
    await waitFor(() => expect(value('summary-gaps')).toBe('3 open'));
    expect(value('summary-support')).toBe('Unavailable');
  });
});

describe('the child on screen', () => {
  test('switching moves every line, and the previous child’s counts are not shown while the new reads are open', async () => {
    installFetch({ ...RECORDS, ath_2: { ...RECORDS.ath_2, gaps: 'hang' } });
    await renderProgress();
    await waitFor(() => expect(value('summary-gaps')).toBe('3 open'));

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
    await waitFor(() => expect(value('summary-gaps')).toBe('3 open'));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Second Child' }));
    });
    await waitFor(() => expect(value('summary-gaps')).toBe('1 open'));
    expect(value('summary-assignments')).toBe('0 working on now · 1 completed · 0 closed, not completed');
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
    await waitFor(() => expect(value('summary-gaps')).toBe('1 open'));
    await act(async () => {
      (releaseFirst as (() => void) | null)?.();
    });
    expect(value('summary-gaps')).toBe('1 open');
    expect(value('summary-assignments')).toBe('0 working on now · 1 completed · 0 closed, not completed');
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
    expect(screen.getAllByRole('link', { name: 'Open the full progression record' })[0]).toHaveAttribute('href', '/parent/progression-visibility');
  });
});
