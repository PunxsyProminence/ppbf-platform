/**
 * @jest-environment jsdom
 */

// The "Return plan" block shows what the return-to-training route answers and
// sends what the coach entered; every rule is the route's. These pin each
// state (none, loading, refused, failed, missing, empty, all advanced, not
// active), the current step, Advance (note required, exact body, the route's
// refusal in its own words) and Add step (nothing prefilled or preselected,
// exact body), against the response shapes of
// app/api/pilot/coach/return-to-training/route.ts.

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';

import ReturnPlanBlock, { RTT_CONTACT, RTT_EVENTS, RTT_SCALE } from './ReturnPlanBlock';

const STEP = {
  organization_id: 'org-1', plan_id: 'plan-1', permitted_scale_level: null, planned_note: '',
  advanced_by_account_id: null, advanced_at: null, advancement_note: null,
};
// 01:30 UTC on 9/9 is the evening of 9/8 at the gym (America/New_York).
const STEP1 = {
  ...STEP, step_id: 'step-1', week_number: 1, intensity_label: 'Walking and light bike', permitted_contact: 'none',
  planned_note: 'No bag work.', advanced_by_account_id: 'acct-coach-1', advanced_at: '2026-09-09T01:30:00.000Z',
  advancement_note: 'Completed the week pain-free.',
};
const STEP2 = {
  ...STEP, step_id: 'step-2', week_number: 2, intensity_label: 'Bag work only', permitted_contact: 'light_technical',
  permitted_scale_level: 'B',
};
const STEP3 = { ...STEP, step_id: 'step-3', week_number: 3, intensity_label: 'Pads', permitted_contact: 'conditioned' };
const PLAN = {
  organization_id: 'org-1', plan_id: 'plan-1', athlete_id: 'ath-1', triggering_event: 'injury', event_date: '2026-09-01',
  authority_source: 'physician', rest_period_days: 14, earliest_return_date: '2026-09-22', medical_clearance_on_file: false,
  entered_by_account_id: 'acct-coach-1', entered_by_role: 'coach', entered_at: '2026-09-01T15:00:00.000Z', status: 'active',
  note: '', steps: [STEP1, STEP2, STEP3], current_step_id: 'step-2',
};
const OTHER_PLAN = { ...PLAN, plan_id: 'plan-other', steps: [{ ...STEP3, step_id: 'other-step', intensity_label: 'Another injury' }], current_step_id: 'other-step' };

const GET_URL = '/api/pilot/coach/return-to-training?athlete_id=ath-1';
const WRITE_URL = '/api/pilot/coach/return-to-training';
const NOTE = 'Your note on this decision (required)';
const CREATED = { ok: true, plan: { plan_id: 'plan-new', steps: [], current_step_id: null }, injury: { injury_id: 'inj-1', linked_rtt_plan_id: 'plan-new' } };

// The injury the block sits under, as the page passes it.
const changed = jest.fn();
const sending = jest.fn();
const INJURY = {
  injuryId: 'inj-1', injuryDate: '2026-09-01', expectedBack: null as string | null,
  editing: false, pageBusy: false, loosePlans: [] as string[], onSending: sending, onChanged: changed,
};

beforeEach(() => { changed.mockClear(); sending.mockClear(); });

function respond(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

interface Write { url: string; method: string; body: Record<string, unknown> }
let reads: string[];
let writes: Write[];

/**
 * Records every request; asserting on them happens in the test body, never
 * inside the double, where a failed expect would be swallowed by the block's
 * own catch and read as "could not be loaded".
 */
function serve(get: () => Response | Promise<Response>, write?: () => Response | Promise<Response>) {
  reads = [];
  writes = [];
  global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'GET') {
      reads.push(String(input));
      return get();
    }
    writes.push({ url: String(input), method: String(init?.method), body: JSON.parse(String(init?.body)) });
    return write ? write() : respond({ ok: true, step: STEP2 });
  }) as unknown as typeof fetch;
}

const plans = (...list: unknown[]) => () => respond({ ok: true, plans: list });

async function open(planId: string | null = 'plan-1', expectedBack: string | null = null) {
  render(<ReturnPlanBlock athleteId="ath-1" planId={planId} {...INJURY} expectedBack={expectedBack} />);
  const block = screen.getByRole('region', { name: 'Return plan' });
  if (planId) await waitFor(() => expect(within(block).queryByText('Loading return plan…')).toBeNull());
  return block;
}

function routeList(name: string): string[] {
  const source = readFileSync(path.resolve(__dirname, '../app/api/pilot/coach/return-to-training/route.ts'), 'utf8');
  const match = source.match(new RegExp(`const ${name}\\b[^=]*=\\s*\\[([^\\]]*)\\]`));
  if (!match) throw new Error(`${name} not found in route.ts`);
  return [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

test('the contact and scale choices are exactly the route’s', () => {
  expect([...RTT_CONTACT]).toEqual(routeList('PERMITTED_CONTACT'));
  expect([...RTT_SCALE]).toEqual(routeList('SCALE_LEVELS'));
  expect(RTT_CONTACT.length).toBe(5);
  expect([...RTT_EVENTS]).toEqual(routeList('TRIGGERING_EVENTS'));
  expect(RTT_EVENTS.length).toBe(6);
});

test('an injury with no plan says so and reads nothing', async () => {
  serve(plans(PLAN));
  const block = await open(null);
  expect(within(block).getByText('No return plan on this injury.')).toBeTruthy();
  expect(global.fetch).not.toHaveBeenCalled();
  // The one thing offered is starting one; nothing is open or filled in until the coach asks.
  expect(within(block).getAllByRole('button').map((b) => b.textContent)).toEqual(['Start a return plan']);
  expect(within(block).queryByRole('form')).toBeNull();
});

async function openStart(expectedBack: string | null = null) {
  const block = await open(null, expectedBack);
  fireEvent.click(within(block).getByRole('button', { name: 'Start a return plan' }));
  return { block, form: within(block).getByRole('form', { name: 'Start a return plan' }) };
}

function fillStart(form: HTMLElement, values: Record<string, string | undefined>) {
  for (const [label, value] of Object.entries(values)) {
    if (value !== undefined) fireEvent.change(within(form).getByLabelText(label), { target: { value } });
  }
}

const AUTHORITY = 'Who set the rest period (rulebook, physician)';

test('Start a return plan opens an empty form: no event, clearance, date or number chosen for the coach', async () => {
  serve(plans());
  const { form } = await openStart();
  for (const label of ['Triggering event', 'Medical clearance on file', AUTHORITY, 'Rest period, days (optional)', 'Earliest return date (optional)', 'Plan note (optional)']) {
    expect((within(form).getByLabelText(label) as HTMLInputElement).value).toBe('');
  }
  expect(within(within(form).getByLabelText('Triggering event')).getAllByRole('option').map((o) => (o as HTMLOptionElement).value))
    .toEqual(['', ...RTT_EVENTS]);
  expect(within(within(form).getByLabelText('Medical clearance on file')).getAllByRole('option').map((o) => o.textContent))
    .toEqual(['Choose', 'Yes', 'No']);
  // The event date is not asked for: the route uses the injury's own, and the form says which.
  expect(within(form).getByText("Event date: the injury's date, 9/1/2026.")).toBeTruthy();
  // Nothing is said about an Expected back date the injury does not have.
  expect(form.textContent).not.toContain('Expected back');
});

test('when the injury has an Expected back date, the form says a blank earliest return date takes it', async () => {
  serve(plans());
  const { form } = await openStart('2026-09-20');
  expect(within(form).getByText("The plan's earliest return date replaces this injury's Expected back date (9/20/2026). Left blank, that date is used.")).toBeTruthy();
});

test.each([
  ['a triggering event', { 'Medical clearance on file': 'no' }, 'Choose the triggering event.'],
  ['a clearance answer', { 'Triggering event': 'injury' }, 'Say whether a medical clearance is on file: Yes or No.'],
])('Start a return plan without %s sends nothing, because the route would save one unasked', async (_name, values, said) => {
  serve(plans());
  const { block, form } = await openStart();
  fillStart(form, { [AUTHORITY]: 'USA Boxing rulebook', ...values });
  await act(async () => { fireEvent.submit(form); });
  expect(writes).toEqual([]);
  expect(changed).not.toHaveBeenCalled();
  expect(within(block).getByRole('alert').textContent).toBe(`\u25b2 ${said}`);
});

test.each([
  ['yes', true],
  ['no', false],
])('Save plan sends exactly what the coach entered (clearance %s), says it started, and asks the page to read the injuries again', async (clearance, onFile) => {
  serve(plans(), () => respond(CREATED));
  const { block, form } = await openStart();
  fillStart(form, {
    'Triggering event': 'knockout', 'Medical clearance on file': clearance, [AUTHORITY]: 'USA Boxing rulebook',
    'Rest period, days (optional)': '30', 'Plan note (optional)': 'Stopped in round 2.',
  });
  await act(async () => { fireEvent.click(within(form).getByRole('button', { name: 'Save plan' })); });
  expect(writes).toEqual([{
    url: WRITE_URL, method: 'POST',
    body: {
      action: 'create_plan', injury_id: 'inj-1', triggering_event: 'knockout', medical_clearance_on_file: onFile,
      authority_source: 'USA Boxing rulebook', rest_period_days: 30, earliest_return_date: null, note: 'Stopped in round 2.',
    },
  }]);
  expect(changed.mock.calls).toEqual([[{ kind: 'saved', text: 'Return plan started.' }]]);
  // The page was told a write was in flight, then that it was answered: it locks itself in between.
  expect(sending.mock.calls).toEqual([[true], [false]]);
  expect(within(block).getByRole('status').textContent).toBe('\u2713 Return plan started.');
  // The plan's steps are the page's to show once the injury is linked: nothing is read here.
  expect(reads).toEqual([]);
});

/** The block under a page that, like the real one, goes busy re-reading as soon as it is told. */
function UnderPage() {
  const [pageBusy, setPageBusy] = useState(false);
  return <ReturnPlanBlock athleteId="ath-1" planId={null} {...INJURY} pageBusy={pageBusy} onChanged={(tried) => { changed(tried); setPageBusy(true); }} />;
}

test('once a plan is saved the block stops saying there is none, and offers no second start, while the page reads it in', async () => {
  serve(plans(), () => respond(CREATED));
  render(<UnderPage />);
  const block = screen.getByRole('region', { name: 'Return plan' });
  fireEvent.click(within(block).getByRole('button', { name: 'Start a return plan' }));
  const form = within(block).getByRole('form', { name: 'Start a return plan' });
  fillStart(form, { 'Triggering event': 'injury', 'Medical clearance on file': 'no', [AUTHORITY]: 'Dr. Reyes' });
  await act(async () => { fireEvent.submit(form); });
  expect(within(block).getByRole('status').textContent).toBe('\u2713 Return plan started.');
  expect(within(block).queryByText('No return plan on this injury.')).toBeNull();
  expect(within(block).queryByRole('button')).toBeNull();
});

test('no plan is started under an injury whose own edit is open on the page', async () => {
  serve(plans());
  const { rerender } = render(<ReturnPlanBlock athleteId="ath-1" planId={null} {...INJURY} />);
  const block = screen.getByRole('region', { name: 'Return plan' });
  fireEvent.click(within(block).getByRole('button', { name: 'Start a return plan' }));
  rerender(<ReturnPlanBlock athleteId="ath-1" planId={null} {...INJURY} editing />);
  expect(within(block).getByText('Save or cancel the edit of this injury before starting a return plan.')).toBeTruthy();
  expect(within(block).queryByRole('button')).toBeNull();
  expect(within(block).queryByRole('form')).toBeNull();
});

test('active plans of this athlete that no listed injury links to are named where a new plan would be started', async () => {
  serve(plans());
  render(<ReturnPlanBlock athleteId="ath-1" planId={null} {...INJURY} loosePlans={['Knockout 9/1/2026', 'Injury 8/1/2026']} />);
  expect(screen.getByText(/Return plans for this athlete not linked to an injury listed here: Knockout 9\/1\/2026; Injury 8\/1\/2026\./)).toBeTruthy();
});

test('while the page is saving or reading again, every control in the block waits', async () => {
  serve(plans(PLAN));
  const { rerender } = render(<ReturnPlanBlock athleteId="ath-1" planId="plan-1" {...INJURY} />);
  const block = screen.getByRole('region', { name: 'Return plan' });
  await within(block).findByText(/Week 2 \u00b7 Bag work only/);
  fireEvent.click(within(block).getByRole('button', { name: 'Add step' }));
  // A note is already typed, so only the page being busy stands between a submit and a write.
  fireEvent.change(within(block).getByLabelText(NOTE), { target: { value: 'Bag work, no symptoms reported.' } });
  rerender(<ReturnPlanBlock athleteId="ath-1" planId="plan-1" {...INJURY} pageBusy />);
  const controls = [...block.querySelectorAll('button, input, select, textarea')] as HTMLButtonElement[];
  expect(controls.length).toBeGreaterThan(5);
  for (const control of controls) expect(control.disabled).toBe(true);
  fireEvent.submit(within(block).getByRole('form', { name: 'Advance week 2' }));
  expect(writes).toEqual([]);
});

test('an earliest return date is sent as entered, and rest days that are not a whole number go as typed for the route to refuse', async () => {
  serve(plans(), () => respond({ error: 'rest_period_days must be a whole number from 1 to 3650.' }, 400));
  const { block, form } = await openStart();
  fillStart(form, {
    'Triggering event': 'injury', 'Medical clearance on file': 'no', [AUTHORITY]: 'Dr. Reyes',
    'Rest period, days (optional)': '2.5', 'Earliest return date (optional)': '2026-09-22',
  });
  await act(async () => { fireEvent.submit(form); });
  expect(writes[0].body).toMatchObject({ rest_period_days: '2.5', earliest_return_date: '2026-09-22', note: '' });
  expect(within(block).getByRole('alert').textContent).toBe('\u25b2 rest_period_days must be a whole number from 1 to 3650.');
});

test.each([
  ['refused', () => respond({ error: 'This injury already has a return-to-training plan.', code: 'RTT_PLAN_ALREADY_LINKED' }, 409), 'This injury already has a return-to-training plan.'],
  ['unknown', () => respond({ error: 'Internal server error' }, 500), 'it is not known whether the plan was saved'],
  ['unknown', () => Promise.reject(new Error('offline')), 'it is not known whether the plan was saved'],
])('a Start that is %s says so beside the form, keeps what was typed, and tells the page what came of it', async (kind, write, said) => {
  serve(plans(), write);
  const { block, form } = await openStart();
  fillStart(form, { 'Triggering event': 'illness', 'Medical clearance on file': 'yes', [AUTHORITY]: 'Dr. Reyes' });
  await act(async () => { fireEvent.submit(form); });
  expect(writes).toHaveLength(1);
  expect(within(block).getByRole('alert').textContent).toContain(said);
  expect(block.textContent).not.toContain('Internal server error');
  expect(within(block).queryByRole('status')).toBeNull();
  // Still "no plan" as far as this screen knows; the page's re-read decides what is true.
  expect(within(block).getByText('No return plan on this injury.')).toBeTruthy();
  const still = within(block).getByRole('form', { name: 'Start a return plan' });
  expect((within(still).getByLabelText(AUTHORITY) as HTMLInputElement).value).toBe('Dr. Reyes');
  expect((within(still).getByLabelText('Triggering event') as HTMLSelectElement).value).toBe('illness');
  // The page gets the kind and the same words, so it can repeat them if this block leaves the screen.
  expect(changed).toHaveBeenCalledTimes(1);
  expect(changed.mock.calls[0][0].kind).toBe(kind);
  expect(changed.mock.calls[0][0].text).toContain(said);
  // After an unknown answer the coach is told where a saved plan would show, before starting another.
  if (kind === 'unknown') expect(within(block).getByRole('alert').textContent).toContain('Check before starting another.');
});

test('Law 5 on the start form: every field and button asks for the 55px floor by class', async () => {
  serve(plans());
  const { block } = await openStart('2026-09-20');
  expect(block.getAttribute('data-surface')).toBe('kiosk');
  const fields = [...block.querySelectorAll('input, select, textarea')];
  expect(fields).toHaveLength(6);
  for (const control of fields) expect(control.classList.contains('input--kiosk')).toBe(true);
  const buttons = [...block.querySelectorAll('button')];
  expect(buttons).toHaveLength(2);
  for (const button of buttons) expect(button.classList.contains('btn')).toBe(true);
  for (const element of [block, ...block.querySelectorAll('*')]) {
    expect((element as HTMLElement).style.fontSize).toBe('');
    expect(element.className).not.toMatch(/\b(working|alert-title|alert-msg|t-data|badge)\b|text-\[length:var\(--t-(xs|sm)\)\]/);
  }
});

test('says it is loading until the route answers, and never shows an empty plan meanwhile', async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  serve(async () => { await gate; return respond({ ok: true, plans: [PLAN] }); });
  render(<ReturnPlanBlock athleteId="ath-1" planId="plan-1" {...INJURY} />);
  expect(screen.getByText('Loading return plan…')).toBeTruthy();
  expect(screen.queryByText('No steps on this plan yet.')).toBeNull();
  await act(async () => { release(); await gate; });
  expect(await screen.findByText(/Week 2 · Bag work only/)).toBeTruthy();
  expect(reads).toEqual([GET_URL]);
});

test('shows this plan’s steps in week order, marks the route’s current step, and shows an advanced step with its note and gym day', async () => {
  serve(plans(OTHER_PLAN, PLAN));
  const block = await open();
  const steps = within(block).getAllByRole('listitem');
  expect(steps.map((li) => li.querySelector('p')?.textContent)).toEqual([
    'Week 1 · Walking and light bike',
    'Week 2 · Bag work only · ▸ Current step',
    'Week 3 · Pads',
  ]);
  expect(steps.map((li) => li.getAttribute('aria-current'))).toEqual([null, 'step', null]);
  expect(within(steps[0]).getByText('Contact: No contact')).toBeTruthy();
  expect(within(steps[0]).getByText('Plan note: No bag work.')).toBeTruthy();
  expect(within(steps[0]).getByText('Advanced 9/8/2026 · Coach’s note: Completed the week pain-free.')).toBeTruthy();
  expect(within(steps[1]).getByText('Contact: Light technical contact · Scale B')).toBeTruthy();
  // Only the current step can be advanced, and another plan's steps never show here.
  expect(within(block).getAllByRole('button', { name: 'Advance' })).toHaveLength(1);
  expect(within(steps[1]).getByRole('button', { name: 'Advance' })).toBeTruthy();
  expect(within(block).queryByText(/Another injury/)).toBeNull();
  // The account id of who advanced it is not a name and is not printed.
  expect(block.textContent).not.toContain('acct-coach-1');
});

test('a plan with no steps says so and still offers Add step', async () => {
  serve(plans({ ...PLAN, steps: [], current_step_id: null }));
  const block = await open();
  expect(within(block).getByText('No steps on this plan yet.')).toBeTruthy();
  expect(within(block).queryByText('Every step of this plan has been advanced.')).toBeNull();
  expect(within(block).queryByRole('button', { name: 'Advance' })).toBeNull();
  expect(within(block).getByRole('button', { name: 'Add step' })).toBeTruthy();
});

test('a plan with every step advanced says so and offers no Advance', async () => {
  serve(plans({ ...PLAN, steps: [STEP1], current_step_id: null }));
  const block = await open();
  expect(within(block).getByText('Every step of this plan has been advanced.')).toBeTruthy();
  expect(within(block).queryByRole('button', { name: 'Advance' })).toBeNull();
});

test.each(['completed', 'cancelled'])('a %s plan shows its steps and offers neither Advance nor Add step', async (status) => {
  serve(plans({ ...PLAN, status }));
  const block = await open();
  expect(within(block).getByText(`This plan is ${status}. Its steps are shown as recorded.`)).toBeTruthy();
  const steps = within(block).getAllByRole('listitem');
  expect(steps).toHaveLength(3);
  expect(within(block).queryByRole('button')).toBeNull();
  // A plan that is over is not "on" a step, whatever the route still calls current.
  expect(steps.map((li) => li.getAttribute('aria-current'))).toEqual([null, null, null]);
  expect(block.textContent).not.toContain('Current step');
  expect(block.textContent).not.toContain('Every step of this plan has been advanced.');
});

test('a refused read shows the route’s own words, never an empty plan', async () => {
  serve(() => respond({ error: 'Forbidden: coach not assigned to athlete' }, 403));
  const block = await open();
  expect(within(block).getByRole('alert').textContent).toBe('▲ Not shown: Forbidden: coach not assigned to athlete');
  expect(within(block).queryByText('No steps on this plan yet.')).toBeNull();
  expect(within(block).queryByText('No return plan on this injury.')).toBeNull();
  expect(within(block).queryByRole('listitem')).toBeNull();
});

test.each([
  ['a server fault', () => respond({ error: 'Internal server error' }, 500)],
  ['a reply that is not JSON', () => ({ ok: true, status: 200, json: async () => { throw new Error('not json'); } }) as unknown as Response],
  ['a reply without plans', () => respond({ ok: true })],
  ['a plan whose steps are unreadable', () => respond({ ok: true, plans: [{ ...PLAN, steps: [{ step_id: 'step-1' }] }] })],
  ['no connection', () => Promise.reject(new Error('offline'))],
])('%s is "could not be loaded", never an empty plan, and Try again reads again', async (_name, get) => {
  let healthy = false;
  serve(() => (healthy ? respond({ ok: true, plans: [PLAN] }) : get()));
  const block = await open();
  expect(within(block).getByRole('alert').textContent).toContain('The return plan could not be loaded.');
  expect(within(block).queryByText('No steps on this plan yet.')).toBeNull();
  expect(within(block).queryByRole('listitem')).toBeNull();
  healthy = true;
  await act(async () => { fireEvent.click(within(block).getByRole('button', { name: 'Try again' })); });
  expect(await within(block).findByText(/Week 2 · Bag work only/)).toBeTruthy();
  expect(reads).toEqual([GET_URL, GET_URL]);
});

test('a linked plan the route did not send is said plainly, not shown as empty', async () => {
  serve(plans(OTHER_PLAN));
  const block = await open();
  expect(within(block).getByRole('alert').textContent)
    .toContain('This injury is linked to a return plan that was not in the list the server sent.');
  expect(within(block).queryByText(/Another injury/)).toBeNull();
  expect(within(block).queryByText('No steps on this plan yet.')).toBeNull();
});

test('Advance needs the coach’s note: a blank one sends nothing', async () => {
  serve(plans(PLAN));
  const block = await open();
  const form = within(block).getByRole('form', { name: 'Advance week 2' });
  expect((within(form).getByLabelText('Your note on this decision (required)') as HTMLTextAreaElement).required).toBe(true);
  fireEvent.change(within(form).getByLabelText('Your note on this decision (required)'), { target: { value: '   ' } });
  await act(async () => { fireEvent.submit(form); });
  expect(writes).toEqual([]);
  expect(within(block).getByRole('alert').textContent).toContain('Write your note first');
});

test('Advance sends the current step with the note, says it was advanced, and reads the plan again', async () => {
  let advanced = false;
  const after = { ...PLAN, steps: [STEP1, { ...STEP2, advanced_at: '2026-09-15T15:00:00.000Z', advancement_note: 'Bag work, no symptoms reported.' }, STEP3], current_step_id: 'step-3' };
  serve(() => respond({ ok: true, plans: [advanced ? after : PLAN] }), () => { advanced = true; return respond({ ok: true, step: after.steps[1] }); });
  const block = await open();
  fireEvent.change(within(block).getByLabelText('Your note on this decision (required)'), { target: { value: 'Bag work, no symptoms reported.' } });
  await act(async () => { fireEvent.click(within(block).getByRole('button', { name: 'Advance' })); });
  expect(writes).toEqual([{
    url: WRITE_URL, method: 'PATCH',
    body: { athlete_id: 'ath-1', plan_id: 'plan-1', step_id: 'step-2', advancement_note: 'Bag work, no symptoms reported.' },
  }]);
  expect(within(block).getByRole('status').textContent).toBe('✓ Week 2 advanced.');
  expect(reads).toEqual([GET_URL, GET_URL]);
  const steps = within(block).getAllByRole('listitem');
  expect(steps.map((li) => li.getAttribute('aria-current'))).toEqual([null, null, 'step']);
  // The next step's note starts empty: one decision's note is never carried to the next.
  expect((within(steps[2]).getByLabelText('Your note on this decision (required)') as HTMLTextAreaElement).value).toBe('');
});

test.each([
  [400, 'Advancement note must be at least 10 characters.'],
  [409, 'Week 1 is the current step; advance it first.'],
  [403, 'Forbidden: coach not assigned to athlete'],
])('a refused Advance (%i) shows the route’s own words, keeps the note, and reads the plan again', async (status, error) => {
  serve(plans(PLAN), () => respond({ error }, status));
  const block = await open();
  fireEvent.change(within(block).getByLabelText('Your note on this decision (required)'), { target: { value: 'ok' } });
  await act(async () => { fireEvent.click(within(block).getByRole('button', { name: 'Advance' })); });
  expect(writes).toHaveLength(1);
  expect(within(block).getByRole('alert').textContent).toBe(`▲ ${error}`);
  expect(within(block).queryByRole('status')).toBeNull();
  expect((within(block).getByLabelText('Your note on this decision (required)') as HTMLTextAreaElement).value).toBe('ok');
  expect(reads).toEqual([GET_URL, GET_URL]);
});

test.each([
  ['the connection fails', () => Promise.reject(new Error('offline'))],
  ['the answer is unreadable', () => ({ ok: true, status: 200, json: async () => { throw new Error('not json'); } }) as unknown as Response],
  // The route audits after it advances, so a 500 can follow a step that WAS advanced.
  ['the server faults', () => respond({ error: 'Internal server error' }, 500)],
  ['a gateway times out', () => ({ ok: false, status: 504, json: async () => { throw new Error('not json'); } }) as unknown as Response],
  ['a refusal has no readable words', () => respond({}, 409)],
])('when %s on Advance it does not claim saved or not saved, and reads the plan again', async (_name, write) => {
  serve(plans(PLAN), write);
  const block = await open();
  fireEvent.change(within(block).getByLabelText('Your note on this decision (required)'), { target: { value: 'Bag work, no symptoms reported.' } });
  await act(async () => { fireEvent.click(within(block).getByRole('button', { name: 'Advance' })); });
  expect(within(block).getByRole('alert').textContent).toContain('it is not known whether that was saved');
  expect(block.textContent).not.toContain('Internal server error');
  expect(within(block).queryByRole('status')).toBeNull();
  expect(reads).toEqual([GET_URL, GET_URL]);
});

test.each([
  ['refused because another coach advanced it first', () => respond({ error: 'Week 2 has already been advanced.' }, 409), 'Week 2 has already been advanced.'],
  ['unknown because the answer was lost', () => Promise.reject(new Error('offline')), 'it is not known whether that was saved'],
])('a note written for one week is never carried onto the next: Advance %s', async (_name, write, said) => {
  let moved = false;
  const after = { ...PLAN, steps: [STEP1, { ...STEP2, advanced_at: '2026-09-15T15:00:00.000Z', advancement_note: 'Someone else\u2019s note.' }, STEP3], current_step_id: 'step-3' };
  serve(() => respond({ ok: true, plans: [moved ? after : PLAN] }), () => { moved = true; return write(); });
  const block = await open();
  fireEvent.change(within(block).getByLabelText(NOTE), { target: { value: 'Week 2 went fine, no symptoms.' } });
  await act(async () => { fireEvent.click(within(block).getByRole('button', { name: 'Advance' })); });
  // Week 3 is now the current step. What the coach wrote was about week 2.
  const steps = within(block).getAllByRole('listitem');
  expect(steps.map((li) => li.getAttribute('aria-current'))).toEqual([null, null, 'step']);
  expect((within(steps[2]).getByLabelText(NOTE) as HTMLTextAreaElement).value).toBe('');
  // The answer stays on screen, beside the week it was about.
  expect(within(steps[1]).getByRole('alert').textContent).toContain(said);
  // A second tap sends nothing: week 3 has no note, so it is not advanced on week 2's.
  await act(async () => { fireEvent.submit(within(block).getByRole('form', { name: 'Advance week 3' })); });
  expect(writes).toHaveLength(1);
  expect(writes[0].body.step_id).toBe('step-2');
});

test('two taps in the same instant send one decision', async () => {
  serve(plans(PLAN));
  const block = await open();
  fireEvent.change(within(block).getByLabelText(NOTE), { target: { value: 'Bag work, no symptoms reported.' } });
  const form = within(block).getByRole('form', { name: 'Advance week 2' });
  // Both submits land before React renders the disabled state.
  await act(async () => { fireEvent.submit(form); fireEvent.submit(form); });
  expect(writes).toHaveLength(1);
});

test('when the plan cannot be read again after a write, the answer stays and the steps are not guessed', async () => {
  let wrote = false;
  serve(() => (wrote ? respond({ error: 'Internal server error' }, 500) : respond({ ok: true, plans: [PLAN] })), () => { wrote = true; return respond({ ok: true, step: STEP2 }); });
  const block = await open();
  fireEvent.change(within(block).getByLabelText(NOTE), { target: { value: 'Bag work, no symptoms reported.' } });
  await act(async () => { fireEvent.click(within(block).getByRole('button', { name: 'Advance' })); });
  expect(within(block).getByRole('status').textContent).toBe('\u2713 Week 2 advanced.');
  expect(within(block).getByRole('alert').textContent).toContain('The return plan could not be loaded.');
  expect(within(block).queryByRole('listitem')).toBeNull();
});

test('a refusal stays on screen when the coach opens Add step', async () => {
  serve(plans(PLAN), () => respond({ error: 'Advancement note must be at least 10 characters.' }, 400));
  const block = await open();
  fireEvent.change(within(block).getByLabelText(NOTE), { target: { value: 'ok' } });
  await act(async () => { fireEvent.click(within(block).getByRole('button', { name: 'Advance' })); });
  fireEvent.click(within(block).getByRole('button', { name: 'Add step' }));
  expect(within(block).getByRole('alert').textContent).toBe('\u25b2 Advancement note must be at least 10 characters.');
});

test('controls are off while a write is in flight, so one decision is not sent twice', async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  serve(plans(PLAN), async () => { await gate; return respond({ ok: true, step: STEP2 }); });
  const block = await open();
  fireEvent.change(within(block).getByLabelText('Your note on this decision (required)'), { target: { value: 'Bag work, no symptoms reported.' } });
  const form = within(block).getByRole('form', { name: 'Advance week 2' });
  fireEvent.submit(form);
  await waitFor(() => expect((within(block).getByRole('button', { name: 'Advance' }) as HTMLButtonElement).disabled).toBe(true));
  expect((within(block).getByRole('button', { name: 'Add step' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.submit(form);
  await act(async () => { release(); await gate; });
  await waitFor(() => expect((within(block).getByRole('button', { name: 'Add step' }) as HTMLButtonElement).disabled).toBe(false));
  expect(writes).toHaveLength(1);
});

async function openAddStep() {
  const block = await open();
  fireEvent.click(within(block).getByRole('button', { name: 'Add step' }));
  return { block, form: within(block).getByRole('form', { name: 'Add a step' }) };
}

test('Add step opens an empty form: no week suggested, no contact chosen for the coach', async () => {
  serve(plans(PLAN));
  const { block, form } = await openAddStep();
  expect(within(block).getByRole('button', { name: 'Add step' }).getAttribute('aria-expanded')).toBe('true');
  expect((within(form).getByLabelText('Week number') as HTMLInputElement).value).toBe('');
  expect((within(form).getByLabelText("This week's ceiling, in your words") as HTMLInputElement).value).toBe('');
  expect((within(form).getByLabelText('Contact') as HTMLSelectElement).value).toBe('');
  expect(within(within(form).getByLabelText('Contact')).getAllByRole('option').map((o) => (o as HTMLOptionElement).value))
    .toEqual(['', ...RTT_CONTACT]);
  expect(within(within(form).getByLabelText('Scale (optional)')).getAllByRole('option').map((o) => (o as HTMLOptionElement).value))
    .toEqual(['', ...RTT_SCALE]);
});

test('Add step without a contact choice sends nothing, because the route would save "none" unasked', async () => {
  serve(plans(PLAN));
  const { block, form } = await openAddStep();
  fireEvent.change(within(form).getByLabelText('Week number'), { target: { value: '4' } });
  fireEvent.change(within(form).getByLabelText("This week's ceiling, in your words"), { target: { value: 'Controlled rounds' } });
  await act(async () => { fireEvent.submit(form); });
  expect(writes).toEqual([]);
  expect(within(block).getByRole('alert').textContent).toBe('▲ Choose the contact for this week.');
});

test('Add step sends exactly what the coach entered, says it was added, closes the form and reads the plan again', async () => {
  serve(plans(PLAN), () => respond({ ok: true, step: { ...STEP, step_id: 'step-4', week_number: 4, intensity_label: 'Controlled rounds', permitted_contact: 'controlled_sparring' } }));
  const { block, form } = await openAddStep();
  fireEvent.change(within(form).getByLabelText('Week number'), { target: { value: '4' } });
  fireEvent.change(within(form).getByLabelText("This week's ceiling, in your words"), { target: { value: 'Controlled rounds' } });
  fireEvent.change(within(form).getByLabelText('Contact'), { target: { value: 'controlled_sparring' } });
  fireEvent.change(within(form).getByLabelText('Plan note (optional)'), { target: { value: 'Three rounds, known partner.' } });
  await act(async () => { fireEvent.click(within(form).getByRole('button', { name: 'Save step' })); });
  expect(writes).toEqual([{
    url: WRITE_URL, method: 'POST',
    body: {
      action: 'add_step', athlete_id: 'ath-1', plan_id: 'plan-1', week_number: 4, intensity_label: 'Controlled rounds',
      permitted_contact: 'controlled_sparring', permitted_scale_level: null, planned_note: 'Three rounds, known partner.',
    },
  }]);
  expect(within(block).getByRole('status').textContent).toBe('✓ Step added.');
  expect(within(block).queryByRole('form', { name: 'Add a step' })).toBeNull();
  expect(reads).toEqual([GET_URL, GET_URL]);
});

test('a chosen scale is sent, and a week that is not a whole number goes as typed for the route to refuse in its words', async () => {
  serve(plans(PLAN), () => respond({ error: 'week_number must be a whole number from 1 to 520.' }, 400));
  const { block, form } = await openAddStep();
  fireEvent.change(within(form).getByLabelText('Week number'), { target: { value: '2.5' } });
  fireEvent.change(within(form).getByLabelText("This week's ceiling, in your words"), { target: { value: 'Pads' } });
  fireEvent.change(within(form).getByLabelText('Contact'), { target: { value: 'none' } });
  fireEvent.change(within(form).getByLabelText('Scale (optional)'), { target: { value: 'C' } });
  await act(async () => { fireEvent.submit(form); });
  expect(writes[0].body).toMatchObject({ week_number: '2.5', permitted_contact: 'none', permitted_scale_level: 'C' });
  expect(within(block).getByRole('alert').textContent).toBe('▲ week_number must be a whole number from 1 to 520.');
});

test('a refused Add step shows the route’s own words and keeps what the coach typed', async () => {
  serve(plans(PLAN), () => respond({ error: 'A return-to-training step already exists for that week.', code: 'RTT_STEP_WEEK_DUPLICATE' }, 409));
  const { block, form } = await openAddStep();
  fireEvent.change(within(form).getByLabelText('Week number'), { target: { value: '3' } });
  fireEvent.change(within(form).getByLabelText("This week's ceiling, in your words"), { target: { value: 'Pads' } });
  fireEvent.change(within(form).getByLabelText('Contact'), { target: { value: 'conditioned' } });
  await act(async () => { fireEvent.submit(form); });
  expect(within(block).getByRole('alert').textContent).toBe('▲ A return-to-training step already exists for that week.');
  const still = within(block).getByRole('form', { name: 'Add a step' });
  expect((within(still).getByLabelText('Week number') as HTMLInputElement).value).toBe('3');
  expect((within(still).getByLabelText('Contact') as HTMLSelectElement).value).toBe('conditioned');
});

test('an Add step whose answer is lost says the outcome is unknown, beside the form, and keeps what was typed', async () => {
  serve(plans(PLAN), () => Promise.reject(new Error('offline')));
  const { block, form } = await openAddStep();
  fireEvent.change(within(form).getByLabelText('Week number'), { target: { value: '4' } });
  fireEvent.change(within(form).getByLabelText("This week's ceiling, in your words"), { target: { value: 'Pads' } });
  fireEvent.change(within(form).getByLabelText('Contact'), { target: { value: 'conditioned' } });
  await act(async () => { fireEvent.submit(form); });
  const alert = within(block).getByRole('alert');
  expect(alert.textContent).toContain('it is not known whether that was saved');
  // After the step list, with the form: not above a long plan where it would be missed.
  const still = within(block).getByRole('form', { name: 'Add a step' });
  expect(still.compareDocumentPosition(alert) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect((within(still).getByLabelText('Week number') as HTMLInputElement).value).toBe('4');
  expect(reads).toEqual([GET_URL, GET_URL]);
});

test.each([
  ['plan', { athleteId: 'ath-1', planId: 'plan-other' }],
  ['athlete', { athleteId: 'ath-2', planId: 'plan-other' }],
])('a reply for a %s no longer shown is dropped, so one child’s steps never show under another', async (_name, next) => {
  let releaseFirst: () => void = () => {};
  const gate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let calls = 0;
  serve(async () => {
    calls += 1;
    if (calls === 1) { await gate; return respond({ ok: true, plans: [PLAN, OTHER_PLAN] }); }
    return respond({ ok: true, plans: [PLAN, OTHER_PLAN] });
  });
  const { rerender } = render(<ReturnPlanBlock athleteId="ath-1" planId="plan-1" {...INJURY} />);
  rerender(<ReturnPlanBlock {...INJURY} {...next} />);
  expect(await screen.findByText(/Another injury/)).toBeTruthy();
  await act(async () => { releaseFirst(); await gate; });
  expect(screen.getByText(/Another injury/)).toBeTruthy();
  expect(screen.queryByText(/Bag work only/)).toBeNull();
  expect(reads).toEqual([GET_URL, `/api/pilot/coach/return-to-training?athlete_id=${next.athleteId}`]);
});

test('Law 5: the block is a kiosk surface, and every control asks for the 55px floor by a class that has a rule', async () => {
  serve(plans(PLAN));
  const { block } = await openAddStep();
  // The attribute the 55px and 19.1px rules are scoped to (kioskTapFloor / kioskTypeFloor), on the block's own root.
  expect(block.getAttribute('data-surface')).toBe('kiosk');
  expect(block.className).toContain('text-[length:var(--t-md)]');
  // No anchors or ARIA-made controls.
  expect(block.querySelector('a, [role="button"], [onclick]')).toBeNull();
  // jsdom applies no CSS, so this pins the class and the rule behind it, not a rendered size.
  // Buttons: `[data-surface="kiosk"] .btn { min-height: var(--tap) }`, unlayered.
  const css = readFileSync(path.resolve(__dirname, '../../../design-system/legacy/ppbf-leather-brass.css'), 'utf8');
  expect(css).toMatch(/\[data-surface="kiosk"\] \.btn \{ min-height: var\(--tap\); \}/);
  const buttons = [...block.querySelectorAll('button')];
  expect(buttons).toHaveLength(3);
  for (const button of buttons) expect(button.classList.contains('btn')).toBe(true);
  // Fields: the kiosk attribute does NOT floor .input/.select/.textarea (their unlayered 46px wins),
  // and a min-h utility loses to it too, so each field carries input--kiosk, defined AFTER that 46px rule.
  expect(css.indexOf('.input--kiosk { min-height: var(--tap);')).toBeGreaterThan(css.indexOf('.input, .select, .textarea {'));
  expect(css.indexOf('.input, .select, .textarea {')).toBeGreaterThan(-1);
  const fields = [...block.querySelectorAll('input, select, textarea')];
  expect(fields).toHaveLength(6);
  for (const control of fields) expect(control.classList.contains('input--kiosk')).toBe(true);
  // Nothing in the block sets its own smaller size: no inline font size, and no voice the kiosk floor does not hold.
  for (const element of [block, ...block.querySelectorAll('*')]) {
    expect((element as HTMLElement).style.fontSize).toBe('');
    expect(element.className).not.toMatch(/\b(working|alert-title|alert-msg|t-data|badge)\b|text-\[length:var\(--t-(xs|sm)\)\]/);
  }
});
