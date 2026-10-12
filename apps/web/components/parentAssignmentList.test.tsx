/**
 * @jest-environment jsdom
 */

/**
 * WO-PH-03: the parent hub's Assignments tab, from the coach's real
 * assignments (GET /api/pilot/progression/assignments, family projection).
 *
 *   the list is the selected child's, and a sibling's answer -- late or not --
 *   never shows under this child's name;
 *
 *   active and finished work are split by the persisted status, and work the
 *   coach withdrew is not listed as work to support;
 *
 *   an issued workout keeps its shape: one panel, its blocks, its steps in the
 *   coach's order;
 *
 *   the guardian reads and does not complete (Q1 = B): no completion control,
 *   no percentage, no account id;
 *
 *   a read that failed is not an empty list.
 */

import '@testing-library/jest-dom';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import ParentHub from './ParentHub';

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, status: ok ? 200 : 500, json: async () => body } as unknown as Response;
}

function assignment(id: string, name: string, status: string, overrides: Record<string, unknown> = {}) {
  return {
    assignment_id: id,
    gap_id: null,
    athlete_id: 'ath_1',
    drill_id: `drill_${id}`,
    drill_name: name,
    drill_description: `${name}: as written`,
    drill_display_name: name,
    drill_display_description: `${name}: how to do it`,
    drill_category: 'footwork',
    drill_cues: null,
    drill_difficulty: 'beginner',
    rep_count: null,
    duration_minutes: null,
    frequency_per_week: null,
    due_date: null,
    status,
    completion_percentage: status === 'completed' ? 100 : 40,
    assigned_by_name: 'Coach Dee',
    assigned_at: '2026-10-01T12:00:00.000Z',
    created_at: '2026-10-01T12:00:00.000Z',
    ...overrides,
  };
}

const FIRST = {
  items: [
    assignment('a_shadow', 'Shadowboxing rounds', 'assigned', { rep_count: 3, duration_minutes: 9, frequency_per_week: 4, due_date: '2026-10-20' }),
    assignment('a_jab', 'Jab on the line', 'in_progress'),
    assignment('a_rope', 'Rope skipping', 'assigned'),
    assignment('a_guard', 'Guard up drill', 'completed'),
    assignment('a_wall', 'Wall slips', 'incomplete'),
    assignment('a_pulled', 'Withdrawn drill', 'cancelled'),
  ],
  // Rope (step 1, warm_up) then Jab (step 2, main), as the coach ordered them.
  workouts: [
    {
      issue_id: 'iss_1',
      athlete_id: 'ath_1',
      template_name: 'Home footwork',
      template_version: 1,
      issued_at: '2026-10-05T12:00:00.000Z',
      issued_by_name: 'Coach Dee',
      steps: [
        { ordinal: 2, block: 'main', scale_level: null, contact_level: 'no_contact', coach_note: 'Slow and sharp.', assignment_id: 'a_jab' },
        { ordinal: 1, block: 'warm_up', scale_level: null, contact_level: 'no_contact', coach_note: null, assignment_id: 'a_rope' },
      ],
    },
  ],
};

const SECOND = {
  items: [{ ...assignment('b_sibling', 'Sibling drill', 'assigned'), athlete_id: 'ath_2' }],
  workouts: [],
};

type Handler = (athleteId: string, init?: RequestInit) => Promise<Response>;

function installFetch(assignments?: Handler): jest.Mock {
  const fetchMock = jest.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/api/pilot/athletes/list')) {
      return jsonResponse({
        items: [
          { athlete_id: 'ath_1', full_name: 'First Child' },
          { athlete_id: 'ath_2', full_name: 'Second Child' },
        ],
      });
    }
    if (url.includes('/api/pilot/progression/assignments')) {
      const athleteId = new URL(url, 'http://localhost').searchParams.get('athlete_id') ?? '';
      if (assignments) return assignments(athleteId, init);
      return jsonResponse(athleteId === 'ath_1' ? FIRST : SECOND);
    }
    if (url.includes('/api/pilot/profile/card')) return jsonResponse({ error: 'not in this test' }, false);
    return jsonResponse({ ok: true, items: [], announcements: [], classes: [], registrations: [], attendance: [], card: null });
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

async function renderAssignments() {
  await act(async () => {
    render(<ParentHub />);
  });
  await waitFor(() => expect(screen.getByRole('button', { name: 'First Child' })).toBeInTheDocument());
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Assignments' }));
  });
}

function group(name: string): HTMLElement | null {
  return screen.queryByRole('region', { name });
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('what the coach set, as it stands', () => {
  test('active and finished are split by status, and withdrawn work is not listed', async () => {
    installFetch();
    await renderAssignments();

    const active = await waitFor(() => group('Working on now') as HTMLElement);
    expect(active).toHaveTextContent('Shadowboxing rounds');
    expect(active).toHaveTextContent('Jab on the line');
    expect(active).toHaveTextContent('Rope skipping');
    expect(active).not.toHaveTextContent('Guard up drill');

    const finished = group('Finished') as HTMLElement;
    expect(finished).toHaveTextContent('Guard up drill');
    expect(finished).toHaveTextContent('Completed');
    expect(finished).toHaveTextContent('Wall slips');
    expect(finished).toHaveTextContent('Closed, not completed');

    expect(screen.queryByText('Withdrawn drill')).toBeNull();
  });

  test('a card shows the display name and instructions, the coach’s numbers, the due day and who assigned it', async () => {
    installFetch();
    await renderAssignments();

    const card = (await screen.findByText('Shadowboxing rounds')).closest('[data-testid="assignment"]') as HTMLElement;
    expect(card).toHaveTextContent('Shadowboxing rounds: how to do it');
    expect(card).toHaveTextContent('Reps3');
    expect(card).toHaveTextContent('Duration9 min');
    expect(card).toHaveTextContent('Per week4x');
    expect(card).toHaveTextContent('DueOct 20, 2026');
    expect(card).toHaveTextContent('Assigned byCoach Dee');
    expect(card).toHaveTextContent('Assigned');
  });

  test('an issued workout is one panel, its steps in the coach’s order under their blocks', async () => {
    installFetch();
    await renderAssignments();

    const panel = await screen.findByTestId('issued-workout');
    expect(panel).toHaveTextContent('Home footwork');
    expect(panel).toHaveTextContent('From: Coach Dee');
    expect(panel).toHaveTextContent('2 steps, in this order');
    const steps = within(panel).getAllByTestId('issued-workout-step').map((step) => step.querySelector('h6')?.textContent);
    expect(steps).toEqual(['Rope skipping', 'Jab on the line']);
    expect(panel.textContent?.indexOf('warm up')).toBeLessThan(panel.textContent?.indexOf('main') ?? -1);
    expect(panel).toHaveTextContent('Note: Slow and sharp.');
  });

  test('read-only: no completion control, no percentage, no account id', async () => {
    installFetch();
    await renderAssignments();
    await screen.findByText('Shadowboxing rounds');

    const tab = group('Working on now')?.parentElement as HTMLElement;
    expect(within(tab).queryByRole('checkbox')).toBeNull();
    expect(within(tab).queryByRole('button', { name: /complete|done|mark/i })).toBeNull();
    expect(tab.textContent ?? '').not.toMatch(/\d+\s*%/);
    expect(tab.textContent ?? '').not.toMatch(/acct_|account/i);
  });

  test('links to the full progression record', async () => {
    installFetch();
    await renderAssignments();
    await screen.findByText('Shadowboxing rounds');
    expect(screen.getByRole('link', { name: 'Open the full progression record' })).toHaveAttribute('href', '/parent/progression-visibility');
  });
});

describe('the child on screen', () => {
  test('only the selected child’s assignments, and switching moves the list', async () => {
    installFetch();
    await renderAssignments();
    await screen.findByText('Shadowboxing rounds');
    expect(screen.queryByText('Sibling drill')).toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Second Child' }));
    });
    await screen.findByText('Sibling drill');
    expect(screen.queryByText('Shadowboxing rounds')).toBeNull();
  });

  test('the child left behind’s list is not shown while the new read is open, and its late answer is ignored', async () => {
    let releaseFirst: (() => void) | null = null;
    let releaseSecond: (() => void) | null = null;
    let firstCalls = 0;
    installFetch((athleteId) => {
      if (athleteId === 'ath_1') {
        firstCalls += 1;
        // The first read answers at once; a later one for ath_1 never does.
        if (firstCalls === 1) return Promise.resolve(jsonResponse(FIRST));
      }
      return new Promise<Response>((resolve) => {
        if (athleteId === 'ath_2') releaseSecond = () => resolve(jsonResponse(SECOND));
        else releaseFirst = () => resolve(jsonResponse(FIRST));
      });
    });
    await renderAssignments();
    await screen.findByText('Shadowboxing rounds');

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Second Child' }));
    });
    // New read open: neither child's list.
    expect(screen.queryByText('Shadowboxing rounds')).toBeNull();
    expect(screen.getByText('Reading the assignments...')).toBeInTheDocument();

    // Back to the first child and straight on to the second again: the
    // second read for ath_1 is left hanging, then answers late.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'First Child' }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Second Child' }));
    });
    // The second child's answer lands first, then the first child's late one:
    // the late one must neither show nor wipe the list on screen.
    await act(async () => {
      (releaseSecond as (() => void) | null)?.();
    });
    await screen.findByText('Sibling drill');
    await act(async () => {
      (releaseFirst as (() => void) | null)?.();
    });
    expect(screen.queryByText('Shadowboxing rounds')).toBeNull();
    expect(screen.getByText('Sibling drill')).toBeInTheDocument();
  });
});

describe('a read that did not answer', () => {
  test('a refused read is Unavailable, never "no assignments"', async () => {
    installFetch(async () => jsonResponse({ error: 'Forbidden' }, false));
    await renderAssignments();
    await screen.findByText('Unavailable - the assignments could not be read. This is not an empty list.');
    expect(screen.queryByText('No assignments from the coach yet.')).toBeNull();
  });

  test('workouts that cannot be read make the list unreadable, not loose drills', async () => {
    installFetch(async () => jsonResponse({ items: FIRST.items, workouts: [{ issue_id: 'iss_1' }] }));
    await renderAssignments();
    await screen.findByText('Unavailable - the assignments could not be read. This is not an empty list.');
    expect(screen.queryByText('Jab on the line')).toBeNull();
  });

  test('a real empty list says so, and so does a list of only withdrawn work', async () => {
    installFetch(async () => jsonResponse({ items: [assignment('a_pulled', 'Withdrawn drill', 'cancelled')], workouts: [] }));
    await renderAssignments();
    await screen.findByText('No assignments from the coach yet.');
  });

  test('the placeholder is gone', async () => {
    installFetch();
    const { container } = render(<ParentHub />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'First Child' })).toBeInTheDocument());
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Assignments' }));
    });
    expect(container.textContent).not.toContain('there is no backend feed for home assignments');
    expect(container.textContent).not.toContain('Upload evidence if requested');
  });
});
