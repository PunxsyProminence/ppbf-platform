/**
 * @jest-environment jsdom
 */

// The staff side of family goals (PH-06b): staff read every live goal with who
// set it and its done state, change only staff goals (PH-06 Q-2 A), and a
// failed read is never "no goals".

import '@testing-library/jest-dom';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import FamilyGoalsForStaff, { type StaffFamilyGoal } from './FamilyGoalsForStaff';

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, status: ok ? 200 : 400, json: async () => body } as unknown as Response;
}

const GUARDIAN: StaffFamilyGoal = {
  goal_id: 'g-guardian',
  title: 'Lights out by nine',
  support_action: 'We take the phone at 8:30.',
  target_date: '2026-11-01',
  // 7:02 PM Eastern on 2026-10-13.
  state: 'completed',
  completed_at: '2026-10-13T23:02:00.000Z',
  set_by: 'A guardian',
  mine_to_change: false,
};
const STAFF: StaffFamilyGoal = {
  goal_id: 'g-staff',
  title: 'Water bottle every session',
  support_action: 'Pack a filled bottle in the gym bag.',
  target_date: null,
  state: 'active',
  completed_at: null,
  set_by: 'Coach Pat',
  mine_to_change: true,
};
const STAFF_2: StaffFamilyGoal = { ...STAFF, goal_id: 'g-staff-2', title: 'Wrap hands at home', support_action: 'Practise twice a week.' };

type Handler = (init: RequestInit | undefined, url: string) => Response | Promise<Response>;

function installFetch(items: StaffFamilyGoal[] | (() => Response | Promise<Response>), write?: Handler): jest.Mock {
  const mock = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (!init?.method || init.method === 'GET') {
      return typeof items === 'function' ? items() : jsonResponse({ ok: true, items });
    }
    if (!write) throw new Error(`Unexpected write: ${url}`);
    return write(init, url);
  });
  global.fetch = mock as unknown as typeof fetch;
  return mock;
}

function writes(mock: jest.Mock): Array<{ method: string; body: Record<string, unknown> }> {
  return mock.mock.calls
    .filter(([, init]) => init?.method && init.method !== 'GET')
    .map(([, init]) => ({ method: String(init.method), body: JSON.parse(String(init.body)) as Record<string, unknown> }));
}

function goalItem(title: string): HTMLElement {
  return screen.getByText(title).closest('li') as HTMLElement;
}

async function mount(athleteId = 'ath-1') {
  await act(async () => {
    render(<FamilyGoalsForStaff key={athleteId} athleteId={athleteId} />);
  });
}

afterEach(() => {
  jest.restoreAllMocks();
});

test('reads guardian and staff goals with who set them, the day and the state; controls only on the staff goal', async () => {
  const mock = installFetch([GUARDIAN, STAFF]);
  await mount();

  expect(String(mock.mock.calls[0]![0])).toContain('/api/pilot/coach/family-goals?athlete_id=ath-1');
  const guardian = goalItem('Lights out by nine');
  expect(guardian).toHaveTextContent('We take the phone at 8:30.');
  expect(guardian).toHaveTextContent('Set by A guardian');
  expect(guardian).toHaveTextContent('By November 1, 2026');
  expect(guardian).toHaveTextContent('Done October 13, 2026');
  expect(guardian).not.toHaveTextContent('%');
  // Q-2 A: a guardian's goal is the guardian's.
  expect(within(guardian).queryByRole('checkbox')).toBeNull();
  expect(within(guardian).queryByRole('button')).toBeNull();

  const staff = goalItem('Water bottle every session');
  expect(staff).toHaveTextContent('Set by Coach Pat');
  expect(staff).toHaveTextContent('In progress');
  expect(within(staff).getByRole('checkbox', { name: 'Done: Water bottle every session' })).not.toBeChecked();
  expect(within(staff).getByRole('button', { name: 'Edit: Water bottle every session' })).toBeEnabled();
  expect(within(staff).getByRole('button', { name: 'Retire: Water bottle every session' })).toBeEnabled();
});

test('a failed read says so and is not the empty state; an empty answer is', async () => {
  installFetch(() => jsonResponse({ error: 'nope' }, false));
  const { unmount } = render(<FamilyGoalsForStaff athleteId="ath-1" />);
  expect(await screen.findByRole('alert')).toHaveTextContent('Family goals could not be loaded. This is not a statement that there are none.');
  expect(screen.queryByText('No family goals for this athlete yet.')).toBeNull();
  // Nothing to add into a list that never loaded.
  expect(screen.queryByRole('form', { name: 'Add a goal for the family' })).toBeNull();
  unmount();

  installFetch(() => Promise.reject(new TypeError('Failed to fetch')));
  const thrown = render(<FamilyGoalsForStaff athleteId="ath-1" />);
  expect(await screen.findByText(/Family goals could not be loaded/)).toBeInTheDocument();
  thrown.unmount();

  installFetch([]);
  await mount();
  expect(screen.getByText('No family goals for this athlete yet.')).toBeInTheDocument();
  expect(screen.queryByText(/could not be loaded/)).toBeNull();
});

test('add posts the athlete and the fields, puts the answer on top and clears the form', async () => {
  const created: StaffFamilyGoal = { ...STAFF, goal_id: 'g-new', title: 'Stretch after school', support_action: 'Ten minutes.', target_date: '2026-12-01' };
  const mock = installFetch([GUARDIAN], () => jsonResponse({ ok: true, item: created }));
  await mount();

  fireEvent.change(screen.getByLabelText('Goal'), { target: { value: 'Stretch after school' } });
  fireEvent.change(screen.getByLabelText('What the family will do'), { target: { value: 'Ten minutes.' } });
  fireEvent.change(screen.getByLabelText('Target date (optional)'), { target: { value: '2026-12-01' } });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Add goal' }));
  });

  expect(writes(mock)).toEqual([{
    method: 'POST',
    body: { athlete_id: 'ath-1', title: 'Stretch after school', support_action: 'Ten minutes.', target_date: '2026-12-01' },
  }]);
  const titles = within(screen.getByRole('list', { name: 'Family goals' })).getAllByRole('listitem').map((li) => li.querySelector('.font-semibold')?.textContent);
  expect(titles).toEqual(['Stretch after school', 'Lights out by nine']);
  expect(screen.getByLabelText('Goal')).toHaveValue('');
});

test('tick and untick send done and undo, and show the server answer', async () => {
  let next: StaffFamilyGoal = { ...STAFF, state: 'completed', completed_at: '2026-10-14T15:00:00.000Z' };
  const mock = installFetch([GUARDIAN, STAFF], () => jsonResponse({ ok: true, item: next }));
  await mount();

  await act(async () => {
    fireEvent.click(screen.getByRole('checkbox', { name: 'Done: Water bottle every session' }));
  });
  expect(goalItem('Water bottle every session')).toHaveTextContent('Done October 14, 2026');

  next = STAFF;
  await act(async () => {
    fireEvent.click(screen.getByRole('checkbox', { name: 'Done: Water bottle every session' }));
  });
  expect(goalItem('Water bottle every session')).toHaveTextContent('In progress');
  expect(writes(mock)).toEqual([
    { method: 'PATCH', body: { goal_id: 'g-staff', action: 'done' } },
    { method: 'PATCH', body: { goal_id: 'g-staff', action: 'undo' } },
  ]);
});

test('edit sends the fields, holds other goals and Cancel while it saves, and shows the answer', async () => {
  let release: (response: Response) => void = () => undefined;
  const edited: StaffFamilyGoal = { ...STAFF, title: 'Two bottles', support_action: 'One for after.', target_date: '2026-11-20' };
  const mock = installFetch([STAFF, STAFF_2], () => new Promise<Response>((resolve) => { release = resolve; }));
  await mount();

  fireEvent.click(screen.getByRole('button', { name: 'Edit: Water bottle every session' }));
  // One edit at a time.
  expect(screen.getByRole('button', { name: 'Edit: Wrap hands at home' })).toBeDisabled();
  const form = screen.getByRole('form', { name: 'Edit Water bottle every session' });
  fireEvent.change(within(form).getByLabelText('Goal'), { target: { value: 'Two bottles' } });
  fireEvent.change(within(form).getByLabelText('What the family will do'), { target: { value: 'One for after.' } });
  fireEvent.change(within(form).getByLabelText('Target date (optional)'), { target: { value: '2026-11-20' } });
  fireEvent.click(within(form).getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(within(form).getByRole('button', { name: 'Cancel' })).toBeDisabled());

  await act(async () => {
    release(jsonResponse({ ok: true, item: edited }));
  });
  expect(writes(mock)).toEqual([{
    method: 'PATCH',
    body: { goal_id: 'g-staff', action: 'edit', title: 'Two bottles', support_action: 'One for after.', target_date: '2026-11-20' },
  }]);
  expect(goalItem('Two bottles')).toHaveTextContent('By November 20, 2026');
  expect(screen.getByRole('button', { name: 'Edit: Wrap hands at home' })).toBeEnabled();
});

test('retire sends retire and takes the goal off the list', async () => {
  const mock = installFetch([GUARDIAN, STAFF], () => jsonResponse({ ok: true, item: null }));
  await mount();
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Retire: Water bottle every session' }));
  });
  expect(writes(mock)).toEqual([{ method: 'PATCH', body: { goal_id: 'g-staff', action: 'retire' } }]);
  expect(screen.queryByText('Water bottle every session')).toBeNull();
  expect(screen.getByText('Lights out by nine')).toBeInTheDocument();
});

test('a double submit sends once', async () => {
  let release: (response: Response) => void = () => undefined;
  const mock = installFetch([], () => new Promise<Response>((resolve) => { release = resolve; }));
  await mount();
  fireEvent.change(screen.getByLabelText('Goal'), { target: { value: 'Stretch' } });
  fireEvent.change(screen.getByLabelText('What the family will do'), { target: { value: 'Ten minutes.' } });
  const form = screen.getByRole('form', { name: 'Add a goal for the family' });
  fireEvent.submit(form);
  fireEvent.submit(form);
  await act(async () => {
    release(jsonResponse({ ok: true, item: { ...STAFF, goal_id: 'g-new', title: 'Stretch' } }));
  });
  expect(writes(mock)).toHaveLength(1);
});

test('blank fields keep Add and Save disabled and a forced submit sends nothing', async () => {
  const mock = installFetch([STAFF], () => jsonResponse({ ok: true, item: STAFF }));
  await mount();
  fireEvent.change(screen.getByLabelText('Goal'), { target: { value: 'Only a title' } });
  fireEvent.change(screen.getByLabelText('What the family will do'), { target: { value: '   ' } });
  expect(screen.getByRole('button', { name: 'Add goal' })).toBeDisabled();
  await act(async () => {
    fireEvent.submit(screen.getByRole('form', { name: 'Add a goal for the family' }));
  });

  fireEvent.click(screen.getByRole('button', { name: 'Edit: Water bottle every session' }));
  const edit = screen.getByRole('form', { name: 'Edit Water bottle every session' });
  fireEvent.change(within(edit).getByLabelText('Goal'), { target: { value: ' ' } });
  expect(within(edit).getByRole('button', { name: 'Save' })).toBeDisabled();
  await act(async () => {
    fireEvent.submit(edit);
  });
  expect(writes(mock)).toEqual([]);
});

test('a network failure on a write says the goal was not saved; a refusal shows the server text', async () => {
  let fail: () => Promise<Response> = () => Promise.reject(new TypeError('Failed to fetch'));
  installFetch([STAFF], () => fail());
  await mount();
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Retire: Water bottle every session' }));
  });
  expect(screen.getByRole('alert')).toHaveTextContent('The goal was not saved.');
  expect(screen.getByText('Water bottle every session')).toBeInTheDocument();

  fail = async () => jsonResponse({ error: 'Not found: that goal is not one you can change.' }, false);
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Retire: Water bottle every session' }));
  });
  expect(screen.getByRole('alert')).toHaveTextContent('Not found: that goal is not one you can change.');
});

// No key here on purpose: even a prop change on the same instance never lets
// the previous athlete's read land (abort + identity check).
test("switching athlete drops the previous athlete's goals, and their slow read cannot land", async () => {
  let releaseA: (response: Response) => void = () => undefined;
  const mock = jest.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('athlete_id=ath-a')) return new Promise<Response>((resolve) => { releaseA = resolve; });
    return jsonResponse({ ok: true, items: [STAFF_2] });
  });
  global.fetch = mock as unknown as typeof fetch;

  const { rerender } = render(<FamilyGoalsForStaff athleteId="ath-a" />);
  await act(async () => {
    rerender(<FamilyGoalsForStaff athleteId="ath-b" />);
  });
  expect(screen.getByText('Wrap hands at home')).toBeInTheDocument();
  await act(async () => {
    releaseA(jsonResponse({ ok: true, items: [GUARDIAN] }));
  });
  expect(screen.queryByText('Lights out by nine')).toBeNull();
  expect(screen.getByText('Wrap hands at home')).toBeInTheDocument();
});

test('a draft typed for one athlete is gone after switching to another (key)', async () => {
  installFetch([]);
  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(<FamilyGoalsForStaff key="ath-a" athleteId="ath-a" />);
  });
  fireEvent.change(screen.getByLabelText('Goal'), { target: { value: 'For A only' } });
  await act(async () => {
    view.rerender(<FamilyGoalsForStaff key="ath-b" athleteId="ath-b" />);
  });
  expect(screen.getByLabelText('Goal')).toHaveValue('');
});
