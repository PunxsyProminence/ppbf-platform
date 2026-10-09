/**
 * @jest-environment jsdom
 */

/* Lane P6, PR-B (OD-2026-10-08-006/-007): a message a coach gave a due date
   is something the family does, and the family says when it is done.
   The route (/api/pilot/parent/messages) already returned `task`; this
   file pins what the hub does with it, the Home Tasks count that reads
   from it, the Upcoming compare, and the state marks on chips and tabs. */

import '@testing-library/jest-dom';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import ParentHub from './ParentHub';

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, status: ok ? 200 : 400, json: async () => body } as unknown as Response;
}

function message(overrides: Record<string, unknown> = {}) {
  return {
    note_id: 'n1',
    athlete_id: 'ath_1',
    athlete_name: 'First Child',
    sender_role: 'coach',
    note_text: 'Medical form is due.',
    created_at: '2026-10-01T12:00:00.000Z',
    task: null,
    ...overrides,
  };
}

type Handler = (init?: RequestInit) => Promise<Response>;

function installFetch(options: {
  messages?: Handler;
  messagesPost?: Handler;
  scheduler?: Handler;
} = {}): jest.Mock {
  const fetchMock = jest.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/api/pilot/auth/session')) {
      return jsonResponse({ authenticated: true, account_id: 'acct_parent_1', role: 'parent' });
    }
    if (url.includes('/api/pilot/athletes/list')) {
      return jsonResponse({
        items: [
          { athlete_id: 'ath_1', full_name: 'First Child' },
          { athlete_id: 'ath_2', full_name: 'Second Child' },
        ],
      });
    }
    if (url.includes('/api/pilot/announcements/get')) return jsonResponse({ ok: true, announcements: [] });
    if (url.includes('/api/pilot/parent/safety')) return jsonResponse({ ok: true, items: [] });
    if (url.includes('/api/pilot/parent/messages')) {
      if (init?.method === 'POST') {
        if (options.messagesPost) return options.messagesPost(init);
        const sent = JSON.parse(String(init.body)) as { note_id: string; completed: boolean };
        return jsonResponse({
          ok: true,
          task: { due_date: '2026-10-20', completed_at: sent.completed ? '2026-10-09T15:00:00.000Z' : null },
        });
      }
      return options.messages ? options.messages(init) : jsonResponse({ ok: true, items: [] });
    }
    if (url.includes('/api/pilot/scheduler')) {
      return options.scheduler
        ? options.scheduler(init)
        : jsonResponse({ ok: true, classes: [], registrations: [], attendance: [] });
    }
    if (url.includes('/api/pilot/profile/card')) {
      return jsonResponse({ error: 'not in this test' }, false);
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

async function renderHub() {
  await act(async () => {
    render(<ParentHub />);
  });
  await waitFor(() => expect(screen.getByRole('button', { name: 'First Child' })).toBeInTheDocument());
}

async function openTab(name: string) {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name }));
  });
}

function tileValue(label: string): string {
  const labelElement = screen.getAllByText(label).find((element) => element.tagName === 'P');
  const tile = labelElement?.parentElement;
  return tile?.textContent?.replace(label, '').trim() ?? '';
}

function postsToMessages(fetchMock: jest.Mock): Array<Record<string, unknown>> {
  return fetchMock.mock.calls
    .filter((c) => String(c[0]).includes('/api/pilot/parent/messages') && (c[1] as RequestInit | undefined)?.method === 'POST')
    .map((c) => JSON.parse(String((c[1] as RequestInit).body)) as Record<string, unknown>);
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('a message with a due date on the Messages tab', () => {
  test('shows the due date as the calendar day the coach typed, and an unticked Done box', async () => {
    installFetch({
      messages: async () => jsonResponse({ ok: true, items: [message({ task: { due_date: '2026-10-20', completed_at: null } })] }),
    });
    await renderHub();
    await openTab('Messages');

    // October 20, not 19: a bare date must stay on the day it names, not be
    // read as UTC midnight and shifted into the gym's zone (the day before).
    expect(screen.getByText('Due October 20, 2026')).toBeInTheDocument();
    expect(screen.getByText('Still to do')).toBeInTheDocument();
    const box = screen.getByRole('checkbox', { name: 'Done' });
    expect(box).not.toBeChecked();
    expect(box).toBeEnabled();
  });

  test('a message with no task shows no box and no due line', async () => {
    installFetch({
      messages: async () => jsonResponse({ ok: true, items: [message()] }),
    });
    await renderHub();
    await openTab('Messages');

    expect(screen.getByText('Medical form is due.')).toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.queryByText(/^Due /)).toBeNull();
  });

  test('ticking Done posts {note_id, completed: true} with credentials and shows the box as the server answered', async () => {
    const fetchMock = installFetch({
      messages: async () => jsonResponse({ ok: true, items: [message({ task: { due_date: '2026-10-20', completed_at: null } })] }),
    });
    await renderHub();
    await openTab('Messages');

    await act(async () => {
      fireEvent.click(screen.getByRole('checkbox', { name: 'Done' }));
    });

    expect(postsToMessages(fetchMock)).toEqual([{ note_id: 'n1', completed: true }]);
    const post = fetchMock.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === 'POST');
    expect((post?.[1] as RequestInit).credentials).toBe('include');
    await waitFor(() => expect(screen.getByRole('checkbox', { name: /^Done/ })).toBeChecked());
    expect(screen.queryByText('Still to do')).toBeNull();
    // Done carries when, in words beside the tick.
    expect(screen.getByText(/^Done .+/)).toBeInTheDocument();
  });

  test('unticking a done task posts completed: false -- a wrong tick is undoable', async () => {
    const fetchMock = installFetch({
      messages: async () =>
        jsonResponse({ ok: true, items: [message({ task: { due_date: '2026-10-20', completed_at: '2026-10-05T12:00:00.000Z' } })] }),
    });
    await renderHub();
    await openTab('Messages');

    const box = screen.getByRole('checkbox', { name: /^Done/ });
    expect(box).toBeChecked();
    await act(async () => {
      fireEvent.click(box);
    });

    expect(postsToMessages(fetchMock)).toEqual([{ note_id: 'n1', completed: false }]);
    await waitFor(() => expect(screen.getByRole('checkbox', { name: 'Done' })).not.toBeChecked());
    expect(screen.getByText('Still to do')).toBeInTheDocument();
  });

  test('a refused tick leaves the box as it was and says so in words', async () => {
    installFetch({
      messages: async () => jsonResponse({ ok: true, items: [message({ task: { due_date: '2026-10-20', completed_at: null } })] }),
      messagesPost: async () => jsonResponse({ error: 'Not found: no such task for your children' }, false),
    });
    await renderHub();
    await openTab('Messages');

    await act(async () => {
      fireEvent.click(screen.getByRole('checkbox', { name: 'Done' }));
    });

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'That tick did not save -- Not found: no such task for your children. The box shows what the gym has on record; try again.',
    );
    expect(screen.getByRole('checkbox', { name: 'Done' })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Done' })).toBeEnabled();
  });

  test('a 200 without the task envelope is not treated as saved', async () => {
    installFetch({
      messages: async () => jsonResponse({ ok: true, items: [message({ task: { due_date: '2026-10-20', completed_at: null } })] }),
      messagesPost: async () => jsonResponse({ ok: true }),
    });
    await renderHub();
    await openTab('Messages');

    await act(async () => {
      fireEvent.click(screen.getByRole('checkbox', { name: 'Done' }));
    });

    expect(await screen.findByRole('alert')).toHaveTextContent('That tick did not save -- The tick did not save.');
    expect(screen.getByRole('checkbox', { name: 'Done' })).not.toBeChecked();
  });

  test('a dropped connection says the gym could not be reached', async () => {
    installFetch({
      messages: async () => jsonResponse({ ok: true, items: [message({ task: { due_date: '2026-10-20', completed_at: null } })] }),
      messagesPost: async () => {
        throw new TypeError('Failed to fetch');
      },
    });
    await renderHub();
    await openTab('Messages');

    await act(async () => {
      fireEvent.click(screen.getByRole('checkbox', { name: 'Done' }));
    });

    expect(await screen.findByRole('alert')).toHaveTextContent('That tick did not save -- Failed to fetch.');
    expect(screen.getByRole('checkbox', { name: 'Done' })).not.toBeChecked();
  });

  test('the box is disabled while its write is out, and only that box', async () => {
    let release: ((response: Response) => void) | undefined;
    installFetch({
      messages: async () =>
        jsonResponse({
          ok: true,
          items: [
            message({ note_id: 'n1', task: { due_date: '2026-10-20', completed_at: null } }),
            message({ note_id: 'n2', note_text: 'Bring gloves.', task: { due_date: '2026-10-22', completed_at: null } }),
          ],
        }),
      messagesPost: () => new Promise<Response>((resolve) => { release = resolve; }),
    });
    await renderHub();
    await openTab('Messages');

    const boxes = screen.getAllByRole('checkbox', { name: 'Done' });
    await act(async () => {
      fireEvent.click(boxes[0]);
    });
    expect(boxes[0]).toBeDisabled();
    expect(boxes[1]).toBeEnabled();

    await act(async () => {
      release?.(jsonResponse({ ok: true, task: { due_date: '2026-10-20', completed_at: '2026-10-09T15:00:00.000Z' } }));
    });
    await waitFor(() => expect(screen.getAllByRole('checkbox')[0]).toBeEnabled());
    expect(screen.getAllByRole('checkbox')[0]).toBeChecked();
    expect(screen.getAllByRole('checkbox')[1]).not.toBeChecked();
  });
});

describe('the Home Tasks tile', () => {
  test('counts open tasks across every child once the messages read answered; a done task is not counted', async () => {
    installFetch({
      messages: async () =>
        jsonResponse({
          ok: true,
          items: [
            message({ note_id: 'n1', task: { due_date: '2026-10-20', completed_at: null } }),
            message({ note_id: 'n2', athlete_id: 'ath_2', athlete_name: 'Second Child', task: { due_date: '2026-10-22', completed_at: null } }),
            message({ note_id: 'n3', task: { due_date: '2026-10-01', completed_at: '2026-10-02T12:00:00.000Z' } }),
            message({ note_id: 'n4' }),
          ],
        }),
    });
    await renderHub();

    expect(tileValue('Home Tasks')).toBe('2');
  });

  test('a real zero stays a number: messages answered, none with a due date', async () => {
    installFetch({ messages: async () => jsonResponse({ ok: true, items: [message()] }) });
    await renderHub();

    expect(tileValue('Home Tasks')).toBe('0');
  });

  test('an unanswered messages read is Unavailable, never 0', async () => {
    installFetch({
      messages: async () => {
        throw new Error('messages offline');
      },
    });
    await renderHub();

    expect(tileValue('Home Tasks')).toBe('Unavailable');
  });

  test('ticking a task off takes it out of the count', async () => {
    installFetch({
      messages: async () => jsonResponse({ ok: true, items: [message({ task: { due_date: '2026-10-20', completed_at: null } })] }),
    });
    await renderHub();
    expect(tileValue('Home Tasks')).toBe('1');

    await openTab('Messages');
    await act(async () => {
      fireEvent.click(screen.getByRole('checkbox', { name: 'Done' }));
    });

    await waitFor(() => expect(tileValue('Home Tasks')).toBe('0'));
  });
});

describe('Upcoming reads the class time as a time, not as text', () => {
  /* PAR-02. Postgres timestamptz text ('2026-10-08 18:00:00+00') compared as
     a string against an ISO instant ('2026-10-08T17:00:00.000Z'): the space
     sorts before the 'T', so a class later today read as already past. */
  function inAnHour(): string {
    const date = new Date(Date.now() + 60 * 60 * 1000);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:00+00`;
  }
  function anHourAgo(): string {
    const date = new Date(Date.now() - 60 * 60 * 1000);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:00+00`;
  }

  test('a class later today, in Postgres text form, is upcoming; one an hour ago is not', async () => {
    installFetch({
      scheduler: async () =>
        jsonResponse({
          ok: true,
          classes: [
            { class_id: 'c_soon', title: 'Tonight Sparring', start_at: inAnHour(), location: 'Ring', status: 'open' },
            { class_id: 'c_gone', title: 'Morning Pads', start_at: anHourAgo(), location: 'Ring', status: 'open' },
          ],
          registrations: [
            { registration_id: 'r1', class_id: 'c_soon', athlete_id: 'ath_1', status: 'registered' },
            { registration_id: 'r2', class_id: 'c_gone', athlete_id: 'ath_1', status: 'registered' },
          ],
          attendance: [],
        }),
    });
    await renderHub();
    await openTab('Attendance');

    await waitFor(() => expect(screen.getByText(/Tonight Sparring/)).toBeInTheDocument());
    expect(screen.queryByText(/Morning Pads/)).not.toBeInTheDocument();
  });

  test('a start that will not parse is not shown as upcoming', async () => {
    installFetch({
      scheduler: async () =>
        jsonResponse({
          ok: true,
          classes: [{ class_id: 'c_bad', title: 'Mystery Hour', start_at: 'soon', location: 'Ring', status: 'open' }],
          registrations: [{ registration_id: 'r1', class_id: 'c_bad', athlete_id: 'ath_1', status: 'registered' }],
          attendance: [],
        }),
    });
    await renderHub();
    await openTab('Attendance');

    await waitFor(() => expect(screen.getByText(/No upcoming sessions/i)).toBeInTheDocument());
    expect(screen.queryByText(/Mystery Hour/)).not.toBeInTheDocument();
  });
});

describe('the selected child and tab are marked, not only coloured', () => {
  test('child chips carry aria-pressed and it follows the selection', async () => {
    installFetch();
    await renderHub();

    expect(screen.getByRole('button', { name: 'First Child' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Second Child' })).toHaveAttribute('aria-pressed', 'false');

    await openTab('Second Child');

    expect(screen.getByRole('button', { name: 'First Child' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: 'Second Child' })).toHaveAttribute('aria-pressed', 'true');
  });

  test('tabs carry aria-pressed and aria-current on the open one only', async () => {
    installFetch();
    await renderHub();

    const overview = screen.getByRole('button', { name: 'Overview' });
    const messages = screen.getByRole('button', { name: 'Messages' });
    expect(overview).toHaveAttribute('aria-pressed', 'true');
    expect(overview).toHaveAttribute('aria-current', 'true');
    expect(messages).toHaveAttribute('aria-pressed', 'false');
    expect(messages).not.toHaveAttribute('aria-current');

    await openTab('Messages');

    expect(messages).toHaveAttribute('aria-pressed', 'true');
    expect(messages).toHaveAttribute('aria-current', 'true');
    expect(overview).toHaveAttribute('aria-pressed', 'false');
    expect(overview).not.toHaveAttribute('aria-current');
  });

  test('the chips and tabs read at --t-sm, not the 11.8px --t-xs', async () => {
    installFetch();
    await renderHub();

    expect(screen.getByRole('button', { name: 'Overview' }).className).toContain('text-[length:var(--t-sm)]');
    expect(screen.getByRole('button', { name: 'First Child' }).className).toContain('text-[length:var(--t-sm)]');
  });
});

describe('the roadmap card on the Parent Floor tells the truth about tasks', () => {
  test('says where tasks live now and what is still not built', async () => {
    installFetch();
    await renderHub();
    await openTab('Parent Floor');

    const card = screen.getByText("This Week's Parent Support Tasks").closest('div') as HTMLElement;
    expect(within(card).getByText(/is on the Messages tab, with a box to tick when it is done/)).toBeInTheDocument();
    expect(within(card).getByText(/A separate weekly checklist is not built yet/)).toBeInTheDocument();
    expect(within(card).queryByText(/There is no parent-task assignment feed/)).toBeNull();
  });
});
