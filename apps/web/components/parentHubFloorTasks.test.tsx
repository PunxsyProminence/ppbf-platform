/**
 * @jest-environment jsdom
 */

/**
 * WO-PH-02: the Parent Floor's "This Week's Parent Support Tasks", from the
 * tasks the gym actually set (pilot.parent_task_state, read through
 * /api/pilot/parent/messages).
 *
 *   the list is the selected child's, cut from the same read the Messages tab
 *   and the Parent Floor tasks tile use, so a tick in one place shows in all three;
 *
 *   "this week" is the gym's calendar week, Monday to Sunday in
 *   America/New_York, and an unticked task from an earlier week stays listed
 *   rather than dropping off when Sunday passes (Q1 = B);
 *
 *   the done count is persisted state, and a read that did not answer is not
 *   an empty week.
 */

import '@testing-library/jest-dom';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import ParentHub from './ParentHub';

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, status: ok ? 200 : 400, json: async () => body } as unknown as Response;
}

// Wednesday 14 October 2026, noon at the gym: the week is Mon 12 - Sun 18.
const WEDNESDAY = Date.parse('2026-10-14T16:00:00.000Z');
// Sunday 18 October, 23:59 at the gym (EDT, UTC-4), and the minute after.
const SUNDAY_LAST_MINUTE = Date.parse('2026-10-19T03:59:00.000Z');
const MONDAY_FIRST_MINUTE = Date.parse('2026-10-19T04:00:00.000Z');

function task(noteId: string, athleteId: string, noteText: string, dueDate: string | null, completedAt: string | null = null) {
  return {
    note_id: noteId,
    athlete_id: athleteId,
    athlete_name: athleteId === 'ath_1' ? 'First Child' : 'Second Child',
    sender_role: 'coach',
    note_text: noteText,
    created_at: '2026-10-01T12:00:00.000Z',
    task: { due_date: dueDate, completed_at: completedAt },
  };
}

const ITEMS = [
  // First child.
  task('n_monday', 'ath_1', 'Label the mouthguard', '2026-10-12'),
  task('n_prev_sunday', 'ath_1', 'Wash the hand wraps', '2026-10-11'),
  task('n_week_open', 'ath_1', 'Bring gloves Thursday', '2026-10-15'),
  task('n_week_done', 'ath_1', 'Sign the medical form', '2026-10-13', '2026-10-12T22:00:00.000Z'),
  task('n_sunday', 'ath_1', 'Pack the kit bag', '2026-10-18'),
  task('n_earlier_open', 'ath_1', 'Return the loaner headgear', '2026-10-02'),
  task('n_earlier_done', 'ath_1', 'Pay the tournament entry', '2026-10-01', '2026-10-01T20:00:00.000Z'),
  task('n_undated', 'ath_1', 'Find the birth certificate', null),
  task('n_next_week', 'ath_1', 'Book the physical', '2026-10-21'),
  // A message with no task is not a task.
  { ...task('n_plain', 'ath_1', 'Great week in the gym.', null), task: null },
  // Second child.
  task('n_sibling', 'ath_2', 'Sibling: water bottle every session', '2026-10-16'),
];

type Handler = (init?: RequestInit) => Promise<Response>;

function installFetch(options: { messages?: Handler; messagesPost?: Handler; roster?: Handler } = {}): jest.Mock {
  const fetchMock = jest.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    // FC-06: the Messages tab's "Sent to your athlete" copy; none here.
    if (url.includes('/api/pilot/parent/athlete-messages')) return jsonResponse({ ok: true, items: [] });
    if (url.includes('/api/pilot/athletes/list')) {
      if (options.roster) return options.roster(init);
      return jsonResponse({
        items: [
          { athlete_id: 'ath_1', full_name: 'First Child' },
          { athlete_id: 'ath_2', full_name: 'Second Child' },
        ],
      });
    }
    if (url.includes('/api/pilot/parent/messages')) {
      if (init?.method === 'POST') {
        if (options.messagesPost) return options.messagesPost(init);
        // Answers as the route does: the task's persisted state after the
        // write, its due date unchanged.
        const sent = JSON.parse(String(init.body)) as { note_id: string; completed: boolean };
        const held = ITEMS.find((item) => item.note_id === sent.note_id);
        return jsonResponse({
          ok: true,
          task: { due_date: held?.task?.due_date ?? null, completed_at: sent.completed ? '2026-10-14T16:05:00.000Z' : null },
        });
      }
      return options.messages ? options.messages(init) : jsonResponse({ ok: true, items: ITEMS });
    }
    if (url.includes('/api/pilot/profile/card')) return jsonResponse({ error: 'not in this test' }, false);
    // Everything else the hub reads answers empty.
    return jsonResponse({ ok: true, items: [], announcements: [], classes: [], registrations: [], attendance: [], card: null });
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

function setClock(ms: number) {
  jest.spyOn(Date, 'now').mockReturnValue(ms);
}

async function renderFloor(options: { waitForChildren?: boolean } = {}) {
  await act(async () => {
    render(<ParentHub />);
  });
  if (options.waitForChildren !== false) {
    await waitFor(() => expect(screen.getByRole('button', { name: 'First Child' })).toBeInTheDocument());
  }
  await openTab('Parent Floor');
}

async function openTab(name: string) {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name }));
  });
}

function card(): HTMLElement {
  return screen.getByText("This Week's Parent Support Tasks").closest('div') as HTMLElement;
}

function list(label: string): HTMLElement | null {
  return within(card()).queryByRole('list', { name: label });
}

function textsIn(element: HTMLElement | null): string[] {
  if (!element) return [];
  return within(element).getAllByRole('listitem').map((item) => item.querySelector('p')?.textContent ?? '');
}

afterEach(() => {
  jest.restoreAllMocks();
  // The hub opens on the child remembered last (src/lib/chosenChild.ts); one
  // test's pick must not choose the next test's opening child.
  window.sessionStorage.clear();
  window.localStorage.clear();
});

describe('the week, and what carries forward', () => {
  test('this week holds every task due Mon-Sun, done or not; earlier holds only the unticked and the undated', async () => {
    setClock(WEDNESDAY);
    installFetch();
    await renderFloor();

    // Monday the 12th is the week's first day; Sunday the 11th is last week's.
    expect(textsIn(list('Due this week'))).toEqual([
      'Label the mouthguard',
      'Sign the medical form',
      'Bring gloves Thursday',
      'Pack the kit bag',
    ]);
    expect(textsIn(list('Still open: earlier or no due date'))).toEqual([
      'Return the loaner headgear',
      'Wash the hand wraps',
      'Find the birth certificate',
    ]);
    const text = card().textContent ?? '';
    // Ticked in an earlier week, due next week, or not a task at all: not here.
    expect(text).not.toContain('Pay the tournament entry');
    expect(text).not.toContain('Book the physical');
    expect(text).not.toContain('Great week in the gym.');
    expect(text).toContain('No due date');
  });

  test('the count is the persisted done state over this week’s tasks, with no percentage', async () => {
    setClock(WEDNESDAY);
    installFetch();
    await renderFloor();

    expect(card().textContent).toContain('1 of 4 done this week (October 12, 2026 to October 18, 2026).');
    expect(card().textContent ?? '').not.toMatch(/\d+\s*%/);
  });

  test('Sunday 23:59 at the gym is still this week', async () => {
    setClock(SUNDAY_LAST_MINUTE);
    installFetch();
    await renderFloor();
    expect(textsIn(list('Due this week'))).toContain('Pack the kit bag');
    expect(textsIn(list('Still open: earlier or no due date'))).not.toContain('Pack the kit bag');
  });

  test('Monday 00:00 at the gym starts the next week, and last week’s unticked tasks carry forward', async () => {
    setClock(MONDAY_FIRST_MINUTE);
    installFetch();
    await renderFloor();
    expect(textsIn(list('Due this week'))).toEqual(['Book the physical']);
    expect(textsIn(list('Still open: earlier or no due date'))).toEqual([
      'Return the loaner headgear',
      'Wash the hand wraps',
      'Label the mouthguard',
      'Bring gloves Thursday',
      'Pack the kit bag',
      'Find the birth certificate',
    ]);
    // Done last week: neither group.
    expect(card().textContent).not.toContain('Sign the medical form');
  });

  test('a page left open past Sunday midnight moves to the new week when it is looked at again', async () => {
    setClock(SUNDAY_LAST_MINUTE);
    installFetch();
    await renderFloor();
    expect(card().textContent).toContain('(October 12, 2026 to October 18, 2026)');

    setClock(MONDAY_FIRST_MINUTE);
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    expect(card().textContent).toContain('(October 19, 2026 to October 25, 2026)');
    expect(textsIn(list('Due this week'))).toEqual(['Book the physical']);
  });

  test('a due date that is not a bare calendar date is shown as typed, among the open ones, never in the week', async () => {
    setClock(WEDNESDAY);
    installFetch({
      messages: async () => jsonResponse({ ok: true, items: [task('n_odd', 'ath_1', 'Odd date', '10/14/2026')] }),
    });
    await renderFloor();
    expect(list('Due this week')).toBeNull();
    expect(textsIn(list('Still open: earlier or no due date'))).toEqual(['Odd date']);
    expect(card().textContent).toContain('Due 10/14/2026');
  });

  test('a week with nothing due says so, and still shows what is open from earlier', async () => {
    setClock(WEDNESDAY);
    installFetch({
      messages: async () => jsonResponse({ ok: true, items: [task('n_old', 'ath_1', 'Return the loaner headgear', '2026-10-02')] }),
    });
    await renderFloor();
    expect(card().textContent).toContain('Nothing from the gym is due this week (October 12, 2026 to October 18, 2026).');
    expect(textsIn(list('Still open: earlier or no due date'))).toEqual(['Return the loaner headgear']);
  });
});

describe('the child on screen', () => {
  test('only the selected child’s tasks are listed, and switching moves the list', async () => {
    setClock(WEDNESDAY);
    installFetch();
    await renderFloor();
    expect(card().textContent).not.toContain('Sibling: water bottle every session');

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Second Child' }));
    });
    expect(textsIn(list('Due this week'))).toEqual(['Sibling: water bottle every session']);
    expect(list('Still open: earlier or no due date')).toBeNull();
    expect(card().textContent).toContain('0 of 1 done this week');
    expect(card().textContent).not.toContain('Bring gloves Thursday');
  });

  test('a row says who set it and when it is due, and carries no account id', async () => {
    setClock(WEDNESDAY);
    installFetch();
    await renderFloor();
    const row = within(list('Due this week') as HTMLElement).getByText('Bring gloves Thursday').closest('li') as HTMLElement;
    expect(row).toHaveTextContent('From Coach · Due October 15, 2026');
    expect(row).toHaveTextContent('Still to do');
    // The box is "Done", described by the task it belongs to.
    expect(within(row).getByRole('checkbox', { name: 'Done' })).toHaveAccessibleDescription('Bring gloves Thursday');
    expect(card().textContent ?? '').not.toMatch(/acct_|account/i);
  });
});

describe('ticking a task off', () => {
  test('a tick on the Parent Floor is the same write, and shows on Messages and in the Parent Floor tasks tile', async () => {
    setClock(WEDNESDAY);
    const fetchMock = installFetch();
    await renderFloor();

    const tileBefore = screen.getAllByText('Parent Floor tasks').find((element) => element.tagName === 'P')?.parentElement?.textContent;
    // Open tasks across both children: monday, prev_sunday, week_open,
    // sunday, earlier_open, undated, next_week, sibling.
    expect(tileBefore).toBe('Parent Floor tasks8');

    const row = within(list('Due this week') as HTMLElement).getByText('Bring gloves Thursday').closest('li') as HTMLElement;
    await act(async () => {
      fireEvent.click(within(row).getByRole('checkbox', { name: 'Done' }));
    });

    const posts = fetchMock.mock.calls
      .filter((c) => String(c[0]).includes('/api/pilot/parent/messages') && (c[1] as RequestInit | undefined)?.method === 'POST')
      .map((c) => JSON.parse(String((c[1] as RequestInit).body)));
    expect(posts).toEqual([{ note_id: 'n_week_open', completed: true }]);

    await waitFor(() => expect(within(row).getByRole('checkbox', { name: /^Done/ })).toBeChecked());
    expect(card().textContent).toContain('2 of 4 done this week');
    expect(screen.getAllByText('Parent Floor tasks').find((element) => element.tagName === 'P')?.parentElement?.textContent).toBe('Parent Floor tasks7');

    await openTab('Messages');
    const messageCard = screen.getByText('Bring gloves Thursday').closest('div.mat-paper') as HTMLElement;
    expect(within(messageCard).getByRole('checkbox', { name: /^Done/ })).toBeChecked();
  });

  test('a carry-forward task ticked on this visit stays, ticked, so a wrong tick can be undone where it was made', async () => {
    setClock(WEDNESDAY);
    const fetchMock = installFetch();
    await renderFloor();

    const row = () => within(list('Still open: earlier or no due date') as HTMLElement).getByText('Return the loaner headgear').closest('li') as HTMLElement;
    await act(async () => {
      fireEvent.click(within(row()).getByRole('checkbox', { name: 'Done' }));
    });
    await waitFor(() => expect(within(row()).getByRole('checkbox', { name: /^Done/ })).toBeChecked());

    await act(async () => {
      fireEvent.click(within(row()).getByRole('checkbox', { name: /^Done/ }));
    });
    await waitFor(() => expect(within(row()).getByRole('checkbox', { name: 'Done' })).not.toBeChecked());
    const posts = fetchMock.mock.calls
      .filter((c) => String(c[0]).includes('/api/pilot/parent/messages') && (c[1] as RequestInit | undefined)?.method === 'POST')
      .map((c) => JSON.parse(String((c[1] as RequestInit).body)));
    expect(posts).toEqual([
      { note_id: 'n_earlier_open', completed: true },
      { note_id: 'n_earlier_open', completed: false },
    ]);
  });

  test('a task ticked off before this visit is not carried forward', async () => {
    setClock(WEDNESDAY);
    installFetch();
    await renderFloor();
    expect(card().textContent).not.toContain('Pay the tournament entry');
  });

  test('unticking a done task this week posts completed: false and the count follows', async () => {
    setClock(WEDNESDAY);
    const fetchMock = installFetch();
    await renderFloor();

    const row = within(list('Due this week') as HTMLElement).getByText('Sign the medical form').closest('li') as HTMLElement;
    await act(async () => {
      fireEvent.click(within(row).getByRole('checkbox', { name: /^Done/ }));
    });
    const posts = fetchMock.mock.calls
      .filter((c) => String(c[0]).includes('/api/pilot/parent/messages') && (c[1] as RequestInit | undefined)?.method === 'POST')
      .map((c) => JSON.parse(String((c[1] as RequestInit).body)));
    expect(posts).toEqual([{ note_id: 'n_week_done', completed: false }]);
    await waitFor(() => expect(card().textContent).toContain('0 of 4 done this week'));
  });

  test('the box is held while its write is out, so a second click sends nothing', async () => {
    setClock(WEDNESDAY);
    let release: (() => void) | null = null;
    const fetchMock = installFetch({
      messagesPost: () => new Promise<Response>((resolve) => {
        release = () => resolve(jsonResponse({ ok: true, task: { due_date: '2026-10-15', completed_at: '2026-10-14T16:05:00.000Z' } }));
      }),
    });
    await renderFloor();

    const row = within(list('Due this week') as HTMLElement).getByText('Bring gloves Thursday').closest('li') as HTMLElement;
    await act(async () => {
      fireEvent.click(within(row).getByRole('checkbox', { name: 'Done' }));
    });
    expect(within(row).getByRole('checkbox', { name: 'Done' })).toBeDisabled();
    await act(async () => {
      fireEvent.click(within(row).getByRole('checkbox', { name: 'Done' }));
    });
    expect(fetchMock.mock.calls.filter((c) => String(c[0]).includes('/api/pilot/parent/messages') && (c[1] as RequestInit | undefined)?.method === 'POST')).toHaveLength(1);
    await act(async () => {
      (release as (() => void) | null)?.();
    });
    await waitFor(() => expect(within(row).getByRole('checkbox', { name: /^Done/ })).toBeChecked());
  });

  test('a refused tick leaves the box as it was and says so in words', async () => {
    setClock(WEDNESDAY);
    installFetch({ messagesPost: async () => jsonResponse({ error: 'Not found: no such task for your children' }, false) });
    await renderFloor();

    const row = within(list('Due this week') as HTMLElement).getByText('Bring gloves Thursday').closest('li') as HTMLElement;
    await act(async () => {
      fireEvent.click(within(row).getByRole('checkbox', { name: 'Done' }));
    });

    expect(await within(card()).findByRole('alert')).toHaveTextContent('That tick did not save — Not found: no such task for your children.');
    expect(within(row).getByRole('checkbox', { name: 'Done' })).not.toBeChecked();
    expect(card().textContent).toContain('1 of 4 done this week');

    // The notice was about the first child's task; it does not follow the
    // guardian to the sibling.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Second Child' }));
    });
    expect(within(card()).queryByRole('alert')).toBeNull();
  });
});

describe('a tick that fails after the guardian has moved on', () => {
  test('its notice is not shown under the sibling, and is still there back on the child it was about', async () => {
    setClock(WEDNESDAY);
    let refuse: (() => void) | null = null;
    installFetch({
      messagesPost: () => new Promise<Response>((resolve) => {
        refuse = () => resolve(jsonResponse({ error: 'Not found: no such task for your children' }, false));
      }),
    });
    await renderFloor();

    const row = within(list('Due this week') as HTMLElement).getByText('Bring gloves Thursday').closest('li') as HTMLElement;
    await act(async () => {
      fireEvent.click(within(row).getByRole('checkbox', { name: 'Done' }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Second Child' }));
    });
    // The write fails now, with the sibling on screen.
    await act(async () => {
      (refuse as (() => void) | null)?.();
    });
    expect(within(card()).queryByRole('alert')).toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'First Child' }));
    });
    expect(within(card()).getByRole('alert')).toHaveTextContent('That tick did not save');
  });
});

describe('a read that did not answer', () => {
  test('is Unavailable, never an empty week', async () => {
    setClock(WEDNESDAY);
    installFetch({ messages: async () => jsonResponse({ error: 'down' }, false) });
    await renderFloor();
    expect(card().textContent).toContain('Unavailable - your tasks could not be shown. This is not an empty list.');
    expect(card().textContent).not.toContain('Nothing from the gym is due');
    expect(card().textContent).not.toMatch(/done this week/);
  });

  test('a roster that did not load leaves no child selected, and that is not an empty week either', async () => {
    setClock(WEDNESDAY);
    installFetch({ roster: async () => jsonResponse({ error: 'down' }, false) });
    await renderFloor({ waitForChildren: false });
    expect(card().textContent).toContain('Unavailable - your tasks could not be shown.');
    expect(card().textContent).not.toContain('Nothing from the gym is due');
  });

  test('the roadmap placeholder is gone', async () => {
    setClock(WEDNESDAY);
    installFetch();
    await renderFloor();
    expect(card().textContent).not.toContain('PLANNED | NOT YET IMPLEMENTED');
    expect(card().textContent).not.toContain('A separate weekly checklist is not built yet');
  });
});
