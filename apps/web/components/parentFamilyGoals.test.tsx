/**
 * @jest-environment jsdom
 */

// The Family Goals tab for one child (#1593, PH-06): the list from the server,
// own goals with Done / Edit / Retire, staff goals read-only, add, a failed
// read that says so, and one write at a time.

import '@testing-library/jest-dom';
import { act, fireEvent, render, screen, within } from '@testing-library/react';

import ParentFamilyGoals, { type FamilyGoalItem } from './ParentFamilyGoals';

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, status: ok ? 200 : 400, json: async () => body } as unknown as Response;
}

function goal(overrides: Partial<FamilyGoalItem> = {}): FamilyGoalItem {
  return {
    goal_id: 'g-own', title: 'Gym twice a week', support_action: 'Drive Tuesdays and Thursdays.', target_date: '2026-11-30',
    state: 'active', completed_at: null, set_by: 'You', mine: true, ...overrides,
  };
}

const STAFF = goal({ goal_id: 'g-staff', title: 'Shadowbox at home', support_action: 'Clear space in the garage.', target_date: null, set_by: 'Coach Pat Smith', mine: false });

function routed(options: { list?: () => Response | Promise<Response>; write?: (body: Record<string, unknown>, method: string) => Response | Promise<Response> } = {}) {
  const fetchMock = jest.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (!init?.method || init.method === 'GET') {
      return options.list ? options.list() : jsonResponse({ ok: true, items: [goal(), STAFF] });
    }
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    return options.write ? options.write(body, init.method) : jsonResponse({ ok: true, item: goal() });
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

function writes(fetchMock: jest.Mock) {
  return fetchMock.mock.calls
    .filter((call) => (call[1] as RequestInit | undefined)?.method && (call[1] as RequestInit).method !== 'GET')
    .map((call) => ({ method: (call[1] as RequestInit).method, body: JSON.parse(String((call[1] as RequestInit).body)) }));
}

async function renderFor(athleteId = 'ath-1') {
  await act(async () => {
    render(<ParentFamilyGoals athleteId={athleteId} />);
  });
}

afterEach(() => {
  jest.restoreAllMocks();
});

test("reads the child's goals; own goals carry Done, Edit and Retire, a staff goal is read-only", async () => {
  const fetchMock = routed();
  await renderFor();

  expect(String(fetchMock.mock.calls[0]![0])).toContain('/api/pilot/parent/family-goals?athlete_id=ath-1');
  const [own, staff] = within(screen.getByRole('list', { name: 'Family goals' })).getAllByRole('listitem');
  expect(own!.textContent).toContain('Drive Tuesdays and Thursdays.');
  expect(own!.textContent).toContain('By November 30, 2026');
  expect(own!.textContent).toContain('Set by You');
  expect(own!.textContent).toContain('In progress');
  expect(within(own!).getByRole('checkbox', { name: 'Done' })).not.toBeChecked();
  expect(within(own!).getByRole('button', { name: 'Edit' })).toBeInTheDocument();
  expect(within(own!).getByRole('button', { name: 'Retire' })).toBeInTheDocument();

  expect(staff!.textContent).toContain('Set by Coach Pat Smith');
  expect(within(staff!).queryByRole('checkbox')).toBeNull();
  expect(within(staff!).queryByRole('button')).toBeNull();
  expect(screen.queryByText(/%/)).toBeNull();
});

test('a done goal shows the day it was ticked', async () => {
  // 03:00 UTC on Oct 21 is still the evening of Oct 20 in the gym.
  routed({ list: () => jsonResponse({ ok: true, items: [goal({ state: 'completed', completed_at: '2026-10-21T03:00:00.000Z' })] }) });
  await renderFor();

  expect(screen.getByText('Done October 20, 2026')).toBeInTheDocument();
  expect(screen.getByRole('checkbox', { name: 'Done' })).toBeChecked();
});

test('two presses in one tick send one write', async () => {
  let finish: ((value: Response) => void) | null = null;
  const fetchMock = routed({ write: () => new Promise<Response>((resolve) => { finish = resolve; }) });
  await renderFor();

  const retire = screen.getByRole('button', { name: 'Retire' });
  act(() => {
    fireEvent.click(retire);
    fireEvent.click(retire);
  });
  expect(writes(fetchMock)).toHaveLength(1);
  await act(async () => {
    finish?.(jsonResponse({ ok: true, item: null }));
  });
});

test('ticking sends done for that goal and shows the answer; unticking sends undo', async () => {
  let call = 0;
  const fetchMock = routed({
    write: () => jsonResponse({ ok: true, item: (call += 1) === 1 ? goal({ state: 'completed', completed_at: '2026-10-20T15:00:00.000Z' }) : goal() }),
  });
  await renderFor();

  await act(async () => {
    fireEvent.click(screen.getAllByRole('checkbox', { name: 'Done' })[0]!);
  });
  expect(screen.getByText('Done October 20, 2026')).toBeInTheDocument();
  await act(async () => {
    fireEvent.click(screen.getAllByRole('checkbox', { name: 'Done' })[0]!);
  });
  expect(writes(fetchMock)).toEqual([
    { method: 'PATCH', body: { goal_id: 'g-own', action: 'done' } },
    { method: 'PATCH', body: { goal_id: 'g-own', action: 'undo' } },
  ]);
  expect(screen.getAllByText('In progress')).toHaveLength(2);
});

test('adding sends the goal for this child, puts the answer first and clears the form', async () => {
  const fetchMock = routed({
    list: () => jsonResponse({ ok: true, items: [STAFF] }),
    write: () => jsonResponse({ ok: true, item: goal({ goal_id: 'g-new', title: 'Read about nutrition' }) }),
  });
  await renderFor();

  fireEvent.change(screen.getByLabelText('Goal'), { target: { value: 'Read about nutrition' } });
  fireEvent.change(screen.getByLabelText('What the family will do'), { target: { value: 'Cook two of the gym recipes a week.' } });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Add goal' }));
  });

  expect(writes(fetchMock)).toEqual([{ method: 'POST', body: { athlete_id: 'ath-1', title: 'Read about nutrition', support_action: 'Cook two of the gym recipes a week.', target_date: null } }]);
  const items = within(screen.getByRole('list', { name: 'Family goals' })).getAllByRole('listitem');
  expect(items[0]!.textContent).toContain('Read about nutrition');
  expect(screen.getByLabelText('Goal')).toHaveValue('');
});

test('editing sends the new words; retiring removes the goal from the list', async () => {
  const fetchMock = routed({
    write: (body) => jsonResponse({ ok: true, item: body.action === 'retire' ? null : goal({ title: 'Gym three times a week' }) }),
  });
  await renderFor();

  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
  });
  fireEvent.change(screen.getByLabelText('Goal', { selector: '#edit-g-own-title' }), { target: { value: 'Gym three times a week' } });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  });
  expect(screen.getByText('Gym three times a week')).toBeInTheDocument();

  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Retire' }));
  });
  expect(screen.queryByText('Gym three times a week')).toBeNull();
  expect(writes(fetchMock).map((write) => write.body.action)).toEqual(['edit', 'retire']);
});

test('a refused write keeps the list and says why', async () => {
  routed({ write: () => jsonResponse({ ok: false, error: 'Not found: that goal is not one you can change.' }, false) });
  await renderFor();

  await act(async () => {
    fireEvent.click(screen.getAllByRole('checkbox', { name: 'Done' })[0]!);
  });
  expect(screen.getByRole('alert').textContent).toContain('that goal is not one you can change');
  expect(screen.getAllByText('In progress')).toHaveLength(2);
});

test('no goals says so; a failed read says so and never that there are none', async () => {
  routed({ list: () => jsonResponse({ ok: true, items: [] }) });
  await renderFor();
  expect(screen.getByText('No family goals yet. Add one below.')).toBeInTheDocument();
});

test('a failed read is not an empty list, and offers no add form a saved goal could vanish from', async () => {
  routed({ list: () => jsonResponse({ error: 'boom' }, false) });
  await renderFor();
  expect(screen.getByRole('alert').textContent).toContain('could not be loaded');
  expect(screen.queryByText('No family goals yet. Add one below.')).toBeNull();
  expect(screen.queryByRole('form', { name: 'Add a family goal' })).toBeNull();
});
