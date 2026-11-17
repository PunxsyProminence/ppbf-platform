/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import MedicalRestrictionsPanel from './MedicalRestrictionsPanel';
import { clearRoleSession, createPersistentRoleSession } from '@/components/roleSession';

/*
 * The staff panel for USA Boxing medical restrictions (P22a), on its own page,
 * /coach/medical-restrictions. The route decides everything; this asserts what
 * the SURFACE promises: the staff who may write a restriction see the whole
 * record, a coach is not offered the void the route would refuse, and each form
 * sends what it was given.
 */

const ATHLETES = [{ athlete_id: 'ath-1', full_name: 'Test Member' }];

const ROW = {
  restriction_id: '0b6b6c4e-6f43-4b8e-9b51-3c2f6d1e9a10',
  athlete_id: 'ath-1',
  source: 'training_knockout_or_concussion',
  loss_of_consciousness: 'over_1_min',
  note: 'Staff-only test note',
  start_date: '2026-10-01',
  minimum_end_date: '2026-10-30',
  release_signed_on: null,
  lbc_informed_on: null,
  voided_at: null,
  state: 'release_needed',
};

type Call = { url: string; init?: RequestInit };
let calls: Call[];

function respondWith(restrictions: unknown[]) {
  calls = [];
  global.fetch = jest.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    if (init?.method === 'POST') {
      return { ok: true, status: 200, json: async () => ({ ok: true }) } as Response;
    }
    return { ok: true, status: 200, json: async () => ({ ok: true, restrictions }) } as Response;
  }) as unknown as typeof fetch;
}

async function openFor(name: string) {
  fireEvent.change(screen.getByLabelText('Member'), { target: { value: 'ath-1' } });
  await screen.findByText(name);
}

afterEach(() => {
  clearRoleSession();
  jest.restoreAllMocks();
});

test('nothing is read until a member is chosen', () => {
  respondWith([]);
  render(<MedicalRestrictionsPanel athletes={ATHLETES} />);
  expect(calls).toHaveLength(0);
});

test('staff see the whole record; a coach is not offered the void', async () => {
  createPersistentRoleSession('coach');
  respondWith([ROW, { ...ROW, restriction_id: 'f1d5c1aa-0000-4000-8000-000000000002', voided_at: '2026-10-02T00:00:00Z', void_reason: 'Wrong member', state: 'voided' }]);
  render(<MedicalRestrictionsPanel athletes={ATHLETES} />);
  await openFor('In force — release needed');
  expect(screen.getAllByText('From 10/1/2026; minimum end date 10/30/2026.')).toHaveLength(2);
  expect(screen.getAllByText('Source: Training knockout or concussion. Loss of consciousness: Over 1 minute.')).toHaveLength(2);
  expect(screen.getAllByText('Staff note: Staff-only test note')).toHaveLength(2);
  expect(screen.getAllByText(/Physician's release: not on file\./)).toHaveLength(2);
  expect(screen.getByText('Marked entered in error: Wrong member.')).toBeTruthy();
  // A coach is not offered the void the route would refuse.
  expect(screen.queryByRole('button', { name: 'Mark entered in error' })).toBeNull();
  expect(calls[0].url).toContain('/api/pilot/coach/medical-restrictions?athlete_id=ath-1');
});

// OD-2026-11-17-009 ruling 5 (OW25-38 A): a restriction in force carries the
// Restricted mark (the restricted rung, ▲ and the word), never the
// medical-stop mark; other states are words only.
test('a restriction in force carries the Restricted mark; a lifted or voided one does not', async () => {
  createPersistentRoleSession('coach');
  respondWith([
    ROW,
    { ...ROW, restriction_id: 'f1d5c1aa-0000-4000-8000-000000000003', state: 'lifted', release_signed_on: '2026-11-01' },
    { ...ROW, restriction_id: 'f1d5c1aa-0000-4000-8000-000000000004', state: 'voided', voided_at: '2026-10-02T00:00:00Z', void_reason: 'Wrong member' },
  ]);
  render(<MedicalRestrictionsPanel athletes={ATHLETES} />);
  await openFor('In force — release needed');
  const marks = screen.getAllByTestId('restricted-mark');
  expect(marks).toHaveLength(1);
  expect(marks[0].className).toBe('badge badge--restricted');
  expect(marks[0].parentElement?.textContent).toBe('▲RestrictedIn force — release needed');
  expect(screen.getByText('Lifted — release on file').parentElement?.querySelector('[data-testid="restricted-mark"]')).toBeNull();
  expect(document.body.innerHTML).not.toMatch(/--locked|badge--locked|✕/);
});

// OD-2026-11-17-009 ruling 4 (OW25-37 A): every text control wears the kiosk
// size, and nothing asks for less than the kiosk text floor.
test('every control on the record form and the rows wears the kiosk size', async () => {
  createPersistentRoleSession('admin');
  respondWith([ROW]);
  render(<MedicalRestrictionsPanel athletes={ATHLETES} />);
  await openFor('In force — release needed');
  fireEvent.click(screen.getByRole('button', { name: 'Record a restriction' }));
  const controls = document.querySelectorAll('input, select, textarea');
  expect(controls.length).toBeGreaterThanOrEqual(10);
  for (const control of controls) expect(control.className).toContain('input--kiosk');
  expect(document.body.innerHTML).not.toMatch(/var\(--t-(sm|xs)\)/);
});

test.each([
  ['in_force', 'In force', true],
  ['release_needed', 'In force — release needed', true],
  ['not_started', 'Starts later', false],
  ['lifted', 'Lifted — release on file', false],
  ['voided', 'Marked entered in error', false],
])('state %s: the Restricted mark is %s', async (state, words, marked) => {
  createPersistentRoleSession('coach');
  respondWith([{ ...ROW, state, ...(state === 'voided' ? { voided_at: '2026-10-02T00:00:00Z', void_reason: 'Wrong member' } : {}) }]);
  render(<MedicalRestrictionsPanel athletes={ATHLETES} />);
  fireEvent.change(screen.getByLabelText('Member'), { target: { value: 'ath-1' } });
  const line = (await screen.findByText(words, { selector: 'span' })).parentElement!;
  expect(line.querySelector('[data-testid="restricted-mark"]') !== null).toBe(marked);
});

test('the read failure, the reading line and a refusal are at the kiosk text size', async () => {
  createPersistentRoleSession('coach');
  let answer: (response: Response) => void = () => {};
  global.fetch = jest.fn(() => new Promise<Response>((resolve) => { answer = resolve; })) as unknown as typeof fetch;
  render(<MedicalRestrictionsPanel athletes={ATHLETES} />);
  fireEvent.change(screen.getByLabelText('Member'), { target: { value: 'ath-1' } });
  expect(screen.getByText('Reading medical restrictions...').getAttribute('style')).toContain('font-size: var(--t-md)');
  answer({ ok: false, status: 500, json: async () => ({}) } as Response);
  const title = await screen.findByText('Not read');
  expect(title.getAttribute('style')).toContain('font-size: var(--t-md)');
  expect(title.nextElementSibling?.getAttribute('style')).toContain('font-size: var(--t-md)');
});

test('a refusal wears the kiosk stamp and no 15px size', async () => {
  createPersistentRoleSession('coach');
  respondWith([]);
  render(<MedicalRestrictionsPanel athletes={ATHLETES} />);
  await openFor('No medical restriction on file for this member.');
  fireEvent.click(screen.getByRole('button', { name: 'Record a restriction' }));
  fireEvent.click(screen.getByRole('button', { name: 'Save restriction' }));
  const alert = await screen.findByRole('alert');
  expect(alert.querySelector('.stamp')?.className).toContain('stamp--kiosk');
  expect(alert.innerHTML).not.toMatch(/--t-sm/);
});

/*
 * FOUND IN PASSING (Overwatch: a data-integrity bug). A save's re-read used
 * the member captured when the save began, so a coach who picked another
 * member mid-save could see the first member's list under the second's name,
 * and record a release on the wrong row. The picker is now locked while a
 * save runs, and the re-read happens only for the member still shown.
 */
test('switching member mid-save never shows one member\'s records under another\'s name', async () => {
  createPersistentRoleSession('coach');
  const second = { ...ROW, restriction_id: 'f1d5c1aa-0000-4000-8000-0000000000b2', athlete_id: 'ath-2', note: 'Second member note' };
  let finishSave: (response: Response) => void = () => {};
  const gets: string[] = [];
  global.fetch = jest.fn((url: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'POST') return new Promise<Response>((resolve) => { finishSave = resolve; });
    gets.push(String(url));
    const rows = String(url).includes('athlete_id=ath-2') ? [second] : [ROW];
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true, restrictions: rows }) } as Response);
  }) as unknown as typeof fetch;
  render(<MedicalRestrictionsPanel athletes={[...ATHLETES, { athlete_id: 'ath-2', full_name: 'Second Member' }]} />);
  await openFor('In force — release needed');
  fireEvent.change(screen.getByLabelText('Date the release was signed'), { target: { value: '2026-11-01' } });
  fireEvent.click(screen.getByRole('button', { name: 'Record release' }));

  // Locked while the save is in flight.
  const picker = screen.getByLabelText('Member') as HTMLSelectElement;
  await waitFor(() => expect(picker.disabled).toBe(true));

  // Even if a change gets through, the save's answer must not repaint the list.
  fireEvent.change(picker, { target: { value: 'ath-2' } });
  finishSave({ ok: true, status: 200, json: async () => ({ ok: true }) } as Response);
  await waitFor(() => expect(picker.disabled).toBe(false));
  await new Promise((resolve) => setTimeout(resolve, 0));

  const shown = picker.value;
  const notes = screen.queryAllByText(/^Staff note: /).map((node) => node.textContent);
  expect(notes).toEqual([shown === 'ath-2' ? 'Staff note: Second member note' : 'Staff note: Staff-only test note']);
  // The last read is for the member on screen.
  expect(gets.at(-1)).toContain(`athlete_id=${shown}`);
});

test('a gym admin is offered the void, and it sends the reason', async () => {
  createPersistentRoleSession('admin');
  respondWith([ROW]);
  render(<MedicalRestrictionsPanel athletes={ATHLETES} />);
  await openFor('In force — release needed');
  fireEvent.change(screen.getByLabelText(/Entered in error\? Say why/), { target: { value: 'Wrong member' } });
  fireEvent.click(screen.getByRole('button', { name: 'Mark entered in error' }));
  await waitFor(() => expect(calls.some((c) => c.init?.method === 'POST')).toBe(true));
  const sent = calls.find((c) => c.init?.method === 'POST');
  expect(JSON.parse(String(sent?.init?.body))).toEqual({ action: 'void', restriction_id: ROW.restriction_id, reason: 'Wrong member' });
});

test('records a release date for the row it was typed on', async () => {
  createPersistentRoleSession('coach');
  respondWith([ROW]);
  render(<MedicalRestrictionsPanel athletes={ATHLETES} />);
  await openFor('In force — release needed');
  fireEvent.change(screen.getByLabelText('Date the release was signed'), { target: { value: '2026-11-01' } });
  fireEvent.click(screen.getByRole('button', { name: 'Record release' }));
  await waitFor(() => expect(calls.some((c) => c.init?.method === 'POST')).toBe(true));
  const sent = calls.find((c) => c.init?.method === 'POST');
  expect(JSON.parse(String(sent?.init?.body))).toEqual({
    action: 'release', restriction_id: ROW.restriction_id, release_signed_on: '2026-11-01',
  });
});

test('records a new restriction with the fields entered', async () => {
  createPersistentRoleSession('coach');
  respondWith([]);
  render(<MedicalRestrictionsPanel athletes={ATHLETES} />);
  await openFor('No medical restriction on file for this member.');
  fireEvent.click(screen.getByRole('button', { name: 'Record a restriction' }));
  fireEvent.change(screen.getByLabelText('Source'), { target: { value: 'ringside_affidavit' } });
  fireEvent.change(screen.getByLabelText('Loss of consciousness'), { target: { value: 'unknown' } });
  fireEvent.change(screen.getByLabelText('Start date'), { target: { value: '2026-11-10' } });
  fireEvent.change(screen.getByLabelText('Minimum end date'), { target: { value: '2026-12-10' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save restriction' }));
  await waitFor(() => expect(calls.some((c) => c.init?.method === 'POST')).toBe(true));
  const sent = calls.find((c) => c.init?.method === 'POST');
  expect(JSON.parse(String(sent?.init?.body))).toEqual({
    action: 'record', athlete_id: 'ath-1', source: 'ringside_affidavit', loss_of_consciousness: 'unknown',
    start_date: '2026-11-10', minimum_end_date: '2026-12-10',
  });
});

/*
 * OW25-36 A: "'Choose…', Save asks for both (Recommended)". Nothing is
 * pre-picked, so a skipped field can never save as an answer nobody gave.
 */
async function openRecordForm() {
  createPersistentRoleSession('coach');
  respondWith([]);
  render(<MedicalRestrictionsPanel athletes={ATHLETES} />);
  await openFor('No medical restriction on file for this member.');
  fireEvent.click(screen.getByRole('button', { name: 'Record a restriction' }));
}

function selected(label: string): HTMLOptionElement {
  const select = screen.getByLabelText(label) as HTMLSelectElement;
  return select.options[select.selectedIndex];
}

test('Source and Loss of consciousness start at "Choose…" with nothing picked', async () => {
  await openRecordForm();
  for (const label of ['Source', 'Loss of consciousness']) {
    expect(selected(label).value).toBe('');
    expect(selected(label).textContent).toBe('Choose…');
    expect((screen.getByLabelText(label) as HTMLSelectElement).required).toBe(true);
  }
});

test.each([
  ['no Source', { 'Loss of consciousness': 'none' }],
  ['no Loss of consciousness answer', { Source: 'ringside_affidavit' }],
  ['neither', {}],
])('Save with %s is refused on screen and sends nothing', async (_label, chosen: Record<string, string>) => {
  await openRecordForm();
  for (const [label, value] of Object.entries(chosen)) {
    fireEvent.change(screen.getByLabelText(label), { target: { value } });
  }
  fireEvent.change(screen.getByLabelText('Start date'), { target: { value: '2026-11-10' } });
  fireEvent.change(screen.getByLabelText('Minimum end date'), { target: { value: '2026-12-10' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save restriction' }));
  expect(await screen.findByText('Choose a Source and a Loss of consciousness answer; Save needs both.')).toBeTruthy();
  expect(screen.getByRole('alert').textContent).toContain('Not saved');
  expect(calls.some((c) => c.init?.method === 'POST')).toBe(false);
});

test('after a save the next record starts at "Choose…" again', async () => {
  await openRecordForm();
  fireEvent.change(screen.getByLabelText('Source'), { target: { value: 'other' } });
  fireEvent.change(screen.getByLabelText('Loss of consciousness'), { target: { value: 'under_1_min' } });
  fireEvent.change(screen.getByLabelText('Start date'), { target: { value: '2026-11-10' } });
  fireEvent.change(screen.getByLabelText('Minimum end date'), { target: { value: '2026-12-10' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save restriction' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Record a restriction' }));
  expect(selected('Source').value).toBe('');
  expect(selected('Loss of consciousness').value).toBe('');
});

test('Cancel, then reopening, starts at "Choose…" again', async () => {
  await openRecordForm();
  fireEvent.change(screen.getByLabelText('Source'), { target: { value: 'other' } });
  fireEvent.change(screen.getByLabelText('Loss of consciousness'), { target: { value: 'none' } });
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  fireEvent.click(screen.getByRole('button', { name: 'Record a restriction' }));
  expect(selected('Source').value).toBe('');
  expect(selected('Loss of consciousness').value).toBe('');
});

test("one member's choices never carry into another member's form", async () => {
  createPersistentRoleSession('coach');
  respondWith([]);
  render(<MedicalRestrictionsPanel athletes={[...ATHLETES, { athlete_id: 'ath-2', full_name: 'Second Member' }]} />);
  await openFor('No medical restriction on file for this member.');
  fireEvent.click(screen.getByRole('button', { name: 'Record a restriction' }));
  fireEvent.change(screen.getByLabelText('Source'), { target: { value: 'other' } });
  fireEvent.change(screen.getByLabelText('Loss of consciousness'), { target: { value: 'none' } });
  fireEvent.change(screen.getByLabelText('Member'), { target: { value: 'ath-2' } });
  fireEvent.click(await screen.findByRole('button', { name: 'Record a restriction' }));
  expect(selected('Source').value).toBe('');
  expect(selected('Loss of consciousness').value).toBe('');
});

/*
 * P2: a row the server sent that this screen cannot show is counted, never
 * dropped, so the screen never says "none on file" while one exists.
 */
test('a row that cannot be shown is counted, and "none on file" is not said', async () => {
  createPersistentRoleSession('coach');
  respondWith([{ restriction_id: 'x', state: 'not_a_state' }]);
  render(<MedicalRestrictionsPanel athletes={ATHLETES} />);
  await openFor('1 record could not be shown.');
  expect(screen.queryByText('No medical restriction on file for this member.')).toBeNull();
});

test('shown rows and a count of the rest appear together', async () => {
  createPersistentRoleSession('coach');
  respondWith([ROW, { restriction_id: 'x' }, null]);
  render(<MedicalRestrictionsPanel athletes={ATHLETES} />);
  await openFor('In force — release needed');
  const count = screen.getByTestId('medical-restrictions-hidden');
  expect(count.textContent).toBe('2 records could not be shown.');
  expect(screen.queryByText('No medical restriction on file for this member.')).toBeNull();
  // Read before the list, never below it where a long list would push it out of view.
  const list = screen.getByRole('list', { name: 'Medical restrictions on file' });
  expect(count.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

test('"none on file" still shows when the server sent none', async () => {
  createPersistentRoleSession('coach');
  respondWith([]);
  render(<MedicalRestrictionsPanel athletes={ATHLETES} />);
  await openFor('No medical restriction on file for this member.');
  expect(screen.queryByTestId('medical-restrictions-hidden')).toBeNull();
});
