/**
 * @jest-environment jsdom
 */

/**
 * Parent walk 2026-10-19 item 5: tasks due Oct 16 were still open on the 19th
 * and looked like any other. Jason 2026-10-19, Q2 "A: "Past due" badge
 * (Rec.)": an open task whose due date is before the gym's today
 * (America/New_York) carries a "Past due" badge, with its glyph (Law 3), on
 * the Parent Floor and in Messages. Due today is not past due; a ticked task
 * and an undated one never are.
 *
 * Pinned on the rendered DOM (jsdom). How it reads on a tablet has not been
 * checked (NOT VERIFIED).
 */

import '@testing-library/jest-dom';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import ParentHub from './ParentHub';

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, status: ok ? 200 : 400, json: async () => body } as unknown as Response;
}

// Wednesday 14 October 2026, noon at the gym.
const WEDNESDAY = Date.parse('2026-10-14T16:00:00.000Z');
// Wednesday 14 October, 23:59 at the gym (EDT, UTC-4) -- still the 14th there,
// already the 15th in UTC.
const WEDNESDAY_LATE = Date.parse('2026-10-15T03:59:00.000Z');

function task(noteId: string, noteText: string, dueDate: string | null, completedAt: string | null = null) {
  return {
    note_id: noteId,
    athlete_id: 'ath_1',
    athlete_name: 'First Child',
    sender_role: 'coach',
    sender_name: 'Coach Rivera',
    note_text: noteText,
    created_at: '2026-10-01T12:00:00.000Z',
    task: { due_date: dueDate, completed_at: completedAt },
  };
}

const ITEMS = [
  task('n_yesterday', 'Wash the hand wraps', '2026-10-13'),
  task('n_earlier', 'Return the loaner headgear', '2026-10-02'),
  task('n_today', 'Bring gloves today', '2026-10-14'),
  task('n_done_late', 'Sign the medical form', '2026-10-12', '2026-10-13T22:00:00.000Z'),
  task('n_undated', 'Find the birth certificate', null),
];

function installFetch(): void {
  global.fetch = jest.fn(async (input: unknown) => {
    const url = String(input);
    if (url.includes('/api/pilot/parent/athlete-messages')) return jsonResponse({ ok: true, items: [] });
    if (url.includes('/api/pilot/athletes/list')) {
      return jsonResponse({ items: [{ athlete_id: 'ath_1', full_name: 'First Child' }] });
    }
    if (url.includes('/api/pilot/parent/messages')) return jsonResponse({ ok: true, items: ITEMS });
    if (url.includes('/api/pilot/profile/card')) return jsonResponse({ error: 'not in this test' }, false);
    return jsonResponse({ ok: true, items: [], announcements: [], classes: [], registrations: [], attendance: [], card: null });
  }) as unknown as typeof fetch;
}

async function renderHub(clockMs: number) {
  jest.spyOn(Date, 'now').mockReturnValue(clockMs);
  installFetch();
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

/** The smallest element holding the task text and its own "Done" box. */
function taskBlock(text: string): HTMLElement {
  let node: HTMLElement | null = screen.getByText(text);
  while (node && !node.querySelector('input[type="checkbox"]')) node = node.parentElement;
  if (!node) throw new Error(`no task block for ${text}`);
  return node;
}

function pastDue(text: string): boolean {
  return within(taskBlock(text)).queryByText('Past due') !== null;
}

afterEach(() => {
  jest.restoreAllMocks();
  window.sessionStorage.clear();
});

test('on the Parent Floor, an open task due before today says Past due; today, done and undated do not', async () => {
  await renderHub(WEDNESDAY);
  await openTab('Parent Floor');
  await waitFor(() => expect(screen.getByText('Wash the hand wraps')).toBeInTheDocument());

  expect(pastDue('Wash the hand wraps')).toBe(true);
  expect(pastDue('Return the loaner headgear')).toBe(true);
  expect(pastDue('Bring gloves today')).toBe(false);
  expect(pastDue('Sign the medical form')).toBe(false);
  // The badge carries its glyph, not colour alone (Law 3).
  const badge = within(taskBlock('Wash the hand wraps')).getByText('Past due').closest('.badge');
  expect(badge).toHaveClass('badge--restricted');
  expect(badge?.querySelector('i')).toHaveTextContent('▲');
});

test('in Messages, the same tasks say Past due', async () => {
  await renderHub(WEDNESDAY);
  await openTab('Messages');
  await waitFor(() => expect(screen.getByText('Wash the hand wraps')).toBeInTheDocument());

  expect(pastDue('Wash the hand wraps')).toBe(true);
  expect(pastDue('Return the loaner headgear')).toBe(true);
  expect(pastDue('Bring gloves today')).toBe(false);
  expect(pastDue('Sign the medical form')).toBe(false);
  expect(pastDue('Find the birth certificate')).toBe(false);
});

test("late on the due day at the gym it is still not past due, though UTC has moved on", async () => {
  await renderHub(WEDNESDAY_LATE);
  await openTab('Messages');
  await waitFor(() => expect(screen.getByText('Bring gloves today')).toBeInTheDocument());

  expect(pastDue('Bring gloves today')).toBe(false);
  expect(pastDue('Wash the hand wraps')).toBe(true);
});
