/**
 * @jest-environment jsdom
 */

// The coach injury page sends the form and shows what the route says back;
// authorization is the route's. These pin: the vocabularies match the server
// module; the list shows who it came from, the plan's return date when a plan
// is linked, and days lost; record and update send the FULL record (an update
// replaces it); a refusal is shown as the server worded it; marking entered in
// error asks first; each injury carries its Return plan block (the block's own
// states are pinned in components/ReturnPlanBlock.test.tsx); a re-read of the
// same athlete keeps the list mounted, and a re-read that fails takes it down.

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';

import CoachInjuriesPage from './page';
import {
  INJURY_BODY_AREAS,
  INJURY_CONTEXTS,
  INJURY_REPORTED_BY,
  INJURY_TYPES,
} from '@/src/server/pilot/athleteInjuries';

jest.mock('@/src/server/pilot/db', () => ({}));

jest.mock('@/components/RoleStandaloneView', () => ({
  __esModule: true,
  default: ({ children }: { readonly children: ReactNode }) => <div>{children}</div>,
}));

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ children, href }: { readonly children: ReactNode; readonly href: string }) => <a href={href}>{children}</a>,
}));

const PLAN_INJURY = {
  injury_id: 'inj-1', injury_date: '2026-09-01', body_area: 'head', injury_type: 'head_injury', context: 'competition',
  reported_by: 'clinician', staff_note: 'Ringside doctor stopped the bout.', expected_return_date: null,
  returned_on: '2026-09-29', linked_rtt_plan_id: 'plan-1', linked_hold_id: null, linked_clearance_status_id: null,
  linked_pain_report_id: null, plan_earliest_return_date: '2026-09-22',
};
const WRIST = {
  ...PLAN_INJURY, injury_id: 'inj-2', injury_date: '2026-08-01', body_area: 'wrist', injury_type: 'sprain_strain',
  context: 'training', reported_by: 'athlete', staff_note: '', expected_return_date: '2026-08-10', returned_on: null,
  linked_rtt_plan_id: null, plan_earliest_return_date: null,
};
const CANDIDATES = {
  // 01:30 UTC on 9/2 is the evening of 9/1 at the gym (America/New_York).
  holds: [{ hold_id: 'hold-1', scope: 'contact_only', status: 'active', placed_at: '2026-09-02 01:30:00+00' }],
  plans: [{ plan_id: 'plan-1', triggering_event: 'confirmed_concussion', event_date: '2026-09-01', earliest_return_date: '2026-09-22', status: 'active' }],
  clearances: [],
  painReports: [],
};
// The return-to-training route's reply for this athlete (route.ts GET): plans with steps and current_step_id.
const RTT_PLANS = [{
  plan_id: 'plan-1', athlete_id: 'ath-1', status: 'active', triggering_event: 'confirmed_concussion',
  steps: [{
    step_id: 'step-1', plan_id: 'plan-1', week_number: 1, intensity_label: 'Bag work only', permitted_contact: 'none',
    permitted_scale_level: null, planned_note: '', advanced_by_account_id: null, advanced_at: null, advancement_note: null,
  }],
  current_step_id: 'step-1',
}];

const NO_PLANS = { holds: [], plans: [], clearances: [], painReports: [] };
const NEW_PLAN = { ...RTT_PLANS[0], plan_id: 'plan-2', triggering_event: 'injury', steps: [], current_step_id: null };

let posts: Array<Record<string, unknown>>;
let planPosts: Array<Record<string, unknown>>;
let plansReply: unknown[];
let injuriesFail: boolean;
let candidatesReply: unknown;
/** Null: create_plan succeeds and links. Otherwise the reply to give, with the injuries as they are then. */
let planPostReply: { status: number; body: unknown; injuries?: unknown[] } | null;
let postReply: { status: number; body: unknown };
let injuriesReply: unknown[];
let accessibleReply: string[];

beforeEach(() => {
  posts = [];
  planPosts = [];
  plansReply = RTT_PLANS;
  injuriesFail = false;
  candidatesReply = CANDIDATES;
  planPostReply = null;
  postReply = { status: 200, body: { ok: true } };
  injuriesReply = [PLAN_INJURY, WRIST];
  accessibleReply = ['ath-1'];
  global.fetch = jest.fn(async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.includes('/api/pilot/athletes/list')) {
      return {
        ok: true,
        json: async () => ({ items: [{ athlete_id: 'ath-1', full_name: 'Jordan Doe' }, { athlete_id: 'ath-x', full_name: 'Not Mine' }] }),
      };
    }
    if (u.includes('/api/pilot/coach/injuries') && init?.method === 'POST') {
      const sent = JSON.parse(String(init.body));
      if (sent.action === 'accessible_athletes') {
        return { ok: true, status: 200, json: async () => ({ ok: true, athlete_ids: accessibleReply.filter((id) => sent.athlete_ids.includes(id)) }) };
      }
      posts.push(sent);
      return { ok: postReply.status < 300, status: postReply.status, json: async () => postReply.body };
    }
    if (u.includes('/api/pilot/coach/injuries?athlete_id=ath-1')) {
      if (injuriesFail) return { ok: false, status: 502, json: async () => { throw new Error('not json'); } };
      const injuries = injuriesReply;
      return { ok: true, json: async () => ({ ok: true, injuries, candidates: candidatesReply }) };
    }
    if (u.includes('/api/pilot/coach/return-to-training?athlete_id=ath-1') && init?.method === 'GET') {
      return { ok: true, status: 200, json: async () => ({ ok: true, plans: plansReply }) };
    }
    if (u.endsWith('/api/pilot/coach/return-to-training') && init?.method === 'POST') {
      // create_plan (route.ts): the plan is made and the injury linked to it.
      planPosts.push(JSON.parse(String(init.body)));
      if (planPostReply) {
        const reply = planPostReply;
        if (reply.injuries) injuriesReply = reply.injuries;
        return { ok: reply.status < 300, status: reply.status, json: async () => reply.body };
      }
      injuriesReply = [PLAN_INJURY, { ...WRIST, linked_rtt_plan_id: 'plan-2', expected_return_date: null, plan_earliest_return_date: '2026-08-10' }];
      plansReply = [...RTT_PLANS, NEW_PLAN];
      return { ok: true, status: 200, json: async () => ({ ok: true, plan: NEW_PLAN, injury: { injury_id: 'inj-2', linked_rtt_plan_id: 'plan-2' } }) };
    }
    throw new Error(`unexpected fetch ${u}`);
  }) as unknown as typeof fetch;
});

async function openAthlete() {
  render(<CoachInjuriesPage />);
  const select = await screen.findByLabelText('Athlete');
  await waitFor(() => expect((select as HTMLSelectElement).disabled).toBe(false));
  await act(async () => {
    fireEvent.change(select, { target: { value: 'ath-1' } });
  });
  return screen.findByRole('region', { name: 'Injuries' });
}

function options(label: string): string[] {
  return within(screen.getByLabelText(label)).getAllByRole('option').map((o) => (o as HTMLOptionElement).value);
}

test('the form offers exactly the server vocabularies', async () => {
  await openAthlete();
  expect(options('Body area')).toEqual([...INJURY_BODY_AREAS]);
  expect(options('Type')).toEqual([...INJURY_TYPES]);
  expect(options('When')).toEqual([...INJURY_CONTEXTS]);
  expect(options('Who it came from')).toEqual([...INJURY_REPORTED_BY]);
});

test("the list says who it came from, reads a linked plan's return date, and counts days lost", async () => {
  const list = await openAthlete();
  expect(within(list).getByText('A clinician stated it')).toBeTruthy();
  expect(within(list).getByText(/\(from the return-to-training plan\)/)).toBeTruthy();
  expect(within(list).getByText(/28 days lost/)).toBeTruthy();
  expect(within(list).getByText('Staff note: Ringside doctor stopped the bout.')).toBeTruthy();
  expect(within(list).getByText('The athlete told us')).toBeTruthy();
});

test("each injury carries its own Return plan block: the linked plan's steps read for this athlete, or that there is none", async () => {
  const list = await openAthlete();
  const blocks = within(list).getAllByRole('region', { name: 'Return plan' });
  expect(blocks).toHaveLength(2);
  expect(await within(blocks[0]).findByText('Week 1 · Bag work only · ▸ Current step')).toBeTruthy();
  expect(within(blocks[0]).getByRole('button', { name: 'Advance' })).toBeTruthy();
  expect(within(blocks[1]).getByText('No return plan on this injury.')).toBeTruthy();
  expect(within(blocks[1]).getAllByRole('button').map((b) => b.textContent)).toEqual(['Start a return plan']);
  // One read, for the linked injury only, naming the athlete on screen.
  const reads = (global.fetch as jest.Mock).mock.calls.map(([url]) => String(url)).filter((url) => url.includes('return-to-training'));
  expect(reads).toEqual(['/api/pilot/coach/return-to-training?athlete_id=ath-1']);
});

test('a half-typed Advance note survives saving another injury: the list stays mounted across the re-read', async () => {
  const list = await openAthlete();
  const note = await within(list).findByLabelText('Your note on this decision (required)');
  fireEvent.change(note, { target: { value: 'Bag work went fine, no sym' } });
  // Save a change to the OTHER injury; the page reads the injuries again.
  fireEvent.click(within(list).getAllByRole('button', { name: 'Edit' })[1]);
  fireEvent.change(screen.getByLabelText('Returned on'), { target: { value: '2026-08-12' } });
  injuriesReply = [PLAN_INJURY, { ...WRIST, returned_on: '2026-08-12' }];
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save changes' })); });
  expect(await screen.findByText('Injury updated.')).toBeTruthy();
  // The re-read landed (the other injury now shows its return), and the note is still there, in the same field.
  expect(within(list).getByText(/Returned 8\/12\/2026/)).toBeTruthy();
  expect(list.isConnected).toBe(true);
  expect(note.isConnected).toBe(true);
  expect((note as HTMLTextAreaElement).value).toBe('Bag work went fine, no sym');
  // The block was not re-read either: one read of the plan, from before the save.
  const planReads = (global.fetch as jest.Mock).mock.calls.filter(([url, init]) => String(url).includes('return-to-training') && init?.method === 'GET');
  expect(planReads).toHaveLength(1);
});

test('a re-read that fails takes the list down, so a stale list is never left on screen as current', async () => {
  const list = await openAthlete();
  fireEvent.click(within(list).getAllByRole('button', { name: 'Edit' })[1]);
  injuriesFail = true;
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save changes' })); });
  expect(within(await screen.findByRole('alert')).getByText('Injuries could not be loaded.')).toBeTruthy();
  expect(screen.queryByRole('region', { name: 'Injuries' })).toBeNull();
  expect(screen.queryByText('No injuries recorded for this athlete.')).toBeNull();
});

test('starting a return plan on an injury re-reads the injuries, and the injury then shows its plan', async () => {
  const list = await openAthlete();
  let blocks = within(list).getAllByRole('region', { name: 'Return plan' });
  fireEvent.click(within(blocks[1]).getByRole('button', { name: 'Start a return plan' }));
  const form = within(blocks[1]).getByRole('form', { name: 'Start a return plan' });
  // The injury's own date and Expected back, as recorded, are stated; neither is typed again.
  expect(within(form).getByText("Event date: the injury's date, 8/1/2026.")).toBeTruthy();
  expect(within(form).getByText(/Expected back date \(8\/10\/2026\)/)).toBeTruthy();
  fireEvent.change(within(form).getByLabelText('Triggering event'), { target: { value: 'injury' } });
  fireEvent.change(within(form).getByLabelText('Medical clearance on file'), { target: { value: 'no' } });
  fireEvent.change(within(form).getByLabelText('Who set the rest period (rulebook, physician)'), { target: { value: 'Dr. Reyes' } });
  await act(async () => { fireEvent.click(within(form).getByRole('button', { name: 'Save plan' })); });
  expect(planPosts).toEqual([{
    action: 'create_plan', injury_id: 'inj-2', triggering_event: 'injury', medical_clearance_on_file: false,
    authority_source: 'Dr. Reyes', rest_period_days: null, earliest_return_date: null, note: '',
  }]);
  // The page read the injuries again and the same injury now carries the new plan, ready for its first step.
  await waitFor(() => expect(within(list).queryByText('No return plan on this injury.')).toBeNull());
  blocks = within(list).getAllByRole('region', { name: 'Return plan' });
  expect(await within(blocks[1]).findByText('No steps on this plan yet.')).toBeTruthy();
  expect(within(blocks[1]).getByRole('button', { name: 'Add step' })).toBeTruthy();
  expect(within(blocks[1]).queryByRole('button', { name: 'Start a return plan' })).toBeNull();
  // Nothing went to the injury route: starting a plan is the plan route's write.
  expect(posts).toEqual([]);
});

/** Open the athlete, open Start on the injury with no plan (the wrist), and fill what is required. */
async function openStartOnWrist() {
  const list = await openAthlete();
  const block = within(list).getAllByRole('region', { name: 'Return plan' })[1];
  fireEvent.click(within(block).getByRole('button', { name: 'Start a return plan' }));
  const form = within(block).getByRole('form', { name: 'Start a return plan' });
  fireEvent.change(within(form).getByLabelText('Triggering event'), { target: { value: 'injury' } });
  fireEvent.change(within(form).getByLabelText('Medical clearance on file'), { target: { value: 'no' } });
  fireEvent.change(within(form).getByLabelText('Who set the rest period (rulebook, physician)'), { target: { value: 'Dr. Reyes' } });
  return { list, block, form };
}

const WRIST_LINKED_ELSEWHERE = { ...WRIST, linked_rtt_plan_id: 'plan-1', expected_return_date: null, plan_earliest_return_date: '2026-09-22' };

test('a refused start whose injury then shows another plan is still said on the page: the refusal is not erased by the plan appearing', async () => {
  planPostReply = {
    status: 409, body: { error: 'This injury already has a return-to-training plan.', code: 'RTT_PLAN_ALREADY_LINKED' },
    injuries: [PLAN_INJURY, WRIST_LINKED_ELSEWHERE],
  };
  const { list, form } = await openStartOnWrist();
  await act(async () => { fireEvent.click(within(form).getByRole('button', { name: 'Save plan' })); });
  // The injury now carries a plan the coach did not make; its block shows that plan.
  await waitFor(() => expect(within(list).queryByText('No return plan on this injury.')).toBeNull());
  const alert = await screen.findByRole('alert');
  expect(within(alert).getByText('Not done')).toBeTruthy();
  expect(within(alert).getByText('This injury already has a return-to-training plan.')).toBeTruthy();
});

test('an unknown start followed by a failed re-read stays "not known": it is never replaced by "Not done"', async () => {
  planPostReply = { status: 500, body: { error: 'Internal server error' } };
  const { form } = await openStartOnWrist();
  injuriesFail = true;
  await act(async () => { fireEvent.click(within(form).getByRole('button', { name: 'Save plan' })); });
  const alert = await screen.findByRole('alert');
  expect(within(alert).getByText('Not known')).toBeTruthy();
  expect(alert.textContent).toContain('it is not known whether the plan was saved');
  expect(alert.textContent).toContain('After that, the injuries could not be read again: Injuries could not be loaded.');
  expect(within(alert).queryByText('Not done')).toBeNull();
  expect(screen.queryByRole('region', { name: 'Injuries' })).toBeNull();
});

test('Start is not offered on the injury whose edit is open, so a stale edit cannot be saved over a new plan', async () => {
  const list = await openAthlete();
  fireEvent.click(within(list).getAllByRole('button', { name: 'Edit' })[1]);
  const block = within(list).getAllByRole('region', { name: 'Return plan' })[1];
  expect(within(block).getByText('Save or cancel the edit of this injury before starting a return plan.')).toBeTruthy();
  expect(within(block).queryByRole('button', { name: 'Start a return plan' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(within(block).getByRole('button', { name: 'Start a return plan' })).toBeTruthy();
});

test('an edit opened while a plan was being saved is closed and said so: it would have saved the injury without its plan', async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const original = (global.fetch as jest.Mock).getMockImplementation()!;
  const { list, form } = await openStartOnWrist();
  (global.fetch as jest.Mock).mockImplementation(async (url: string, init?: RequestInit) => {
    if (String(url).endsWith('/api/pilot/coach/return-to-training') && init?.method === 'POST') await gate;
    return original(url, init);
  });
  fireEvent.click(within(form).getByRole('button', { name: 'Save plan' }));
  // The plan write is in flight; the coach opens Edit on the same injury (its form shows no plan).
  fireEvent.click(within(list).getAllByRole('button', { name: 'Edit' })[1]);
  expect(screen.getByRole('button', { name: 'Save changes' })).toBeTruthy();
  await act(async () => { release(); await gate; });
  const alert = await screen.findByRole('alert');
  expect(within(alert).getByText('Edit closed')).toBeTruthy();
  expect(alert.textContent).toContain('its return plan changed while it was open');
  expect(screen.queryByRole('button', { name: 'Save changes' })).toBeNull();
  // Nothing was sent to the injury route, and the plan is on the injury.
  expect(posts).toEqual([]);
  await waitFor(() => expect(within(list).queryByText('No return plan on this injury.')).toBeNull());
});

test('an active plan no listed injury links to is named on the injury with no plan', async () => {
  candidatesReply = { ...CANDIDATES, plans: [...CANDIDATES.plans, { plan_id: 'plan-9', triggering_event: 'knockout', event_date: '2026-07-04', earliest_return_date: null, status: 'active' }, { plan_id: 'plan-8', triggering_event: 'illness', event_date: '2026-06-01', earliest_return_date: null, status: 'cancelled' }] };
  const list = await openAthlete();
  const block = within(list).getAllByRole('region', { name: 'Return plan' })[1];
  // plan-1 is linked to the other injury and plan-8 is cancelled: only plan-9 is named.
  expect(within(block).getByText(/not linked to an injury listed here: Knockout 7\/4\/2026\. To use one/)).toBeTruthy();
});

test('an older reply that arrives after a newer one is dropped: the newest read of the injuries is the one shown', async () => {
  let releasePlan: () => void = () => {};
  const planGate = new Promise<void>((resolve) => { releasePlan = resolve; });
  let releaseOld: () => void = () => {};
  const oldGate = new Promise<void>((resolve) => { releaseOld = resolve; });
  const original = (global.fetch as jest.Mock).getMockImplementation()!;
  const { list, form } = await openStartOnWrist();
  let injuryReads = 0;
  (global.fetch as jest.Mock).mockImplementation(async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith('/api/pilot/coach/return-to-training') && init?.method === 'POST') await planGate;
    if (u.includes('/api/pilot/coach/injuries?athlete_id=ath-1')) {
      injuryReads += 1;
      if (injuryReads === 1) {
        // The first re-read answers late, with the list as it was BEFORE the plan was linked.
        const before = [PLAN_INJURY, { ...WRIST, staff_note: 'Edited.' }];
        await oldGate;
        return { ok: true, json: async () => ({ ok: true, injuries: before, candidates: CANDIDATES }) };
      }
    }
    return original(url, init);
  });
  // 1. The plan write starts and waits. 2. The coach saves a new injury; that re-read (read 1) is slow.
  fireEvent.click(within(form).getByRole('button', { name: 'Save plan' }));
  fireEvent.change(screen.getByLabelText('Date of injury'), { target: { value: '2026-10-01' } });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Record injury' })); });
  // 3. The plan write lands and the page reads again (read 2), which answers at once with the plan linked.
  await act(async () => { releasePlan(); await planGate; });
  await waitFor(() => expect(within(list).queryByText('No return plan on this injury.')).toBeNull());
  // 4. Read 1 finally answers. It is older than what is on screen and must not replace it.
  await act(async () => { releaseOld(); await oldGate; });
  expect(injuryReads).toBe(2);
  expect(within(list).queryByText('No return plan on this injury.')).toBeNull();
  expect(within(list).queryByText('Staff note: Edited.')).toBeNull();
});

test("switching athlete takes the first athlete's list down at once, and that athlete's late failure does not touch the second", async () => {
  let failA: () => void = () => {};
  const gateA = new Promise<void>((resolve) => { failA = resolve; });
  let releaseB: () => void = () => {};
  const gateB = new Promise<void>((resolve) => { releaseB = resolve; });
  let readsOfA = 0;
  global.fetch = jest.fn(async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.includes('/api/pilot/athletes/list')) {
      return { ok: true, json: async () => ({ items: [{ athlete_id: 'ath-1', full_name: 'A' }, { athlete_id: 'ath-2', full_name: 'B' }] }) };
    }
    if (init?.method === 'POST') return { ok: true, status: 200, json: async () => ({ ok: true, athlete_ids: ['ath-1', 'ath-2'] }) };
    if (u.includes('return-to-training')) return { ok: true, status: 200, json: async () => ({ ok: true, plans: RTT_PLANS }) };
    if (u.includes('athlete_id=ath-1')) {
      readsOfA += 1;
      if (readsOfA === 1) return { ok: true, json: async () => ({ ok: true, injuries: [PLAN_INJURY], candidates: CANDIDATES }) };
      await gateA;
      return { ok: false, status: 502, json: async () => { throw new Error('not json'); } };
    }
    if (u.includes('athlete_id=ath-2')) {
      await gateB;
      return { ok: true, json: async () => ({ ok: true, injuries: [], candidates: NO_PLANS }) };
    }
    throw new Error(`unexpected fetch ${u}`);
  }) as unknown as typeof fetch;

  render(<CoachInjuriesPage />);
  const select = await screen.findByLabelText('Athlete');
  await waitFor(() => expect((select as HTMLSelectElement).disabled).toBe(false));
  await act(async () => { fireEvent.change(select, { target: { value: 'ath-1' } }); });
  expect(await screen.findByText('Staff note: Ringside doctor stopped the bout.')).toBeTruthy();
  // Back to "choose", then A again (its second read hangs), then B.
  await act(async () => { fireEvent.change(select, { target: { value: 'ath-2' } }); });
  // B has not answered yet, and nothing of A's is on screen while we wait.
  expect(screen.queryByText('Staff note: Ringside doctor stopped the bout.')).toBeNull();
  expect(screen.queryByRole('region', { name: 'Injuries' })).toBeNull();
  await act(async () => { fireEvent.change(select, { target: { value: 'ath-1' } }); });
  await act(async () => { fireEvent.change(select, { target: { value: 'ath-2' } }); });
  await act(async () => { releaseB(); await gateB; });
  const list = await screen.findByRole('region', { name: 'Injuries' });
  expect(within(list).getByText('No injuries recorded for this athlete.')).toBeTruthy();
  // A's second read now fails. B is on screen: no alert, and B's list stays.
  await act(async () => { failA(); await gateA; });
  expect(screen.queryByRole('alert')).toBeNull();
  expect(within(list).getByText('No injuries recorded for this athlete.')).toBeTruthy();
});

test('recording sends the full record with empty fields as null, then reloads', async () => {
  await openAthlete();
  fireEvent.change(screen.getByLabelText('Date of injury'), { target: { value: '2026-10-01' } });
  fireEvent.change(screen.getByLabelText('Body area'), { target: { value: 'knee' } });
  fireEvent.change(screen.getByLabelText('Training hold'), { target: { value: 'hold-1' } });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Record injury' }));
  });
  expect(posts).toEqual([{
    action: 'record', athlete_id: 'ath-1', injury_date: '2026-10-01', body_area: 'knee', injury_type: 'other',
    context: 'training', reported_by: 'athlete', staff_note: null, expected_return_date: null, returned_on: null,
    linked_rtt_plan_id: null, linked_hold_id: 'hold-1', linked_clearance_status_id: null, linked_pain_report_id: null,
  }]);
  expect(await screen.findByText('Injury recorded.')).toBeTruthy();
});

test("a refusal is shown in the server's words", async () => {
  postReply = { status: 400, body: { error: 'returnedOn cannot be before injuryDate.' } };
  await openAthlete();
  fireEvent.change(screen.getByLabelText('Date of injury'), { target: { value: '2026-10-01' } });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Record injury' }));
  });
  expect(await screen.findByText('returnedOn cannot be before injuryDate.')).toBeTruthy();
});

test('editing loads the injury and sends the whole record as an update', async () => {
  const list = await openAthlete();
  fireEvent.click(within(list).getAllByRole('button', { name: 'Edit' })[1]);
  fireEvent.change(screen.getByLabelText('Returned on'), { target: { value: '2026-08-12' } });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
  });
  expect(posts).toEqual([{
    action: 'update', injury_id: 'inj-2', injury_date: '2026-08-01', body_area: 'wrist', injury_type: 'sprain_strain',
    context: 'training', reported_by: 'athlete', staff_note: null, expected_return_date: '2026-08-10',
    returned_on: '2026-08-12', linked_rtt_plan_id: null, linked_hold_id: null, linked_clearance_status_id: null,
    linked_pain_report_id: null,
  }]);
});

test('linking a plan empties and disables the expected-return date', async () => {
  await openAthlete();
  fireEvent.change(screen.getByLabelText('Expected back'), { target: { value: '2026-10-20' } });
  fireEvent.change(screen.getByLabelText('Return-to-training plan'), { target: { value: 'plan-1' } });
  expect((screen.getByLabelText('Expected back') as HTMLInputElement).disabled).toBe(true);
  expect((screen.getByLabelText('Expected back') as HTMLInputElement).value).toBe('');
});

test('entered in error asks first, and sends nothing when declined', async () => {
  const confirm = jest.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
  const list = await openAthlete();
  fireEvent.click(within(list).getAllByRole('button', { name: 'Entered in error' })[0]);
  expect(posts).toEqual([]);
  await act(async () => {
    fireEvent.click(within(list).getAllByRole('button', { name: 'Entered in error' })[0]);
  });
  expect(posts).toEqual([{ action: 'mark_entered_in_error', injury_id: 'inj-1' }]);
  confirm.mockRestore();
});

test('an athlete with no injuries says so', async () => {
  injuriesReply = [];
  const list = await openAthlete();
  expect(within(list).getByText('No injuries recorded for this athlete.')).toBeTruthy();
});

test("a reply for an athlete no longer selected is dropped, so one child's injuries never show under another's name", async () => {
  let releaseA: () => void = () => {};
  const gateA = new Promise<void>((resolve) => { releaseA = resolve; });
  global.fetch = jest.fn(async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.includes('/api/pilot/athletes/list')) {
      return { ok: true, json: async () => ({ items: [{ athlete_id: 'ath-1', full_name: 'A' }, { athlete_id: 'ath-2', full_name: 'B' }] }) };
    }
    if (init?.method === 'POST') {
      return { ok: true, status: 200, json: async () => ({ ok: true, athlete_ids: ['ath-1', 'ath-2'] }) };
    }
    if (u.includes('athlete_id=ath-1')) {
      await gateA;
      return { ok: true, json: async () => ({ ok: true, injuries: [PLAN_INJURY], candidates: CANDIDATES }) };
    }
    if (u.includes('athlete_id=ath-2')) {
      return { ok: true, json: async () => ({ ok: true, injuries: [], candidates: CANDIDATES }) };
    }
    throw new Error(`unexpected fetch ${u}`);
  }) as unknown as typeof fetch;

  render(<CoachInjuriesPage />);
  const select = await screen.findByLabelText('Athlete');
  await waitFor(() => expect((select as HTMLSelectElement).disabled).toBe(false));
  await act(async () => { fireEvent.change(select, { target: { value: 'ath-1' } }); });
  await act(async () => { fireEvent.change(select, { target: { value: 'ath-2' } }); });
  const list = await screen.findByRole('region', { name: 'Injuries' });
  await act(async () => { releaseA(); await gateA; });
  expect(within(list).getByText('No injuries recorded for this athlete.')).toBeTruthy();
  expect(within(list).queryByText('A clinician stated it')).toBeNull();
});

test('the athlete cannot be switched while a save is in flight', async () => {
  let releasePost: () => void = () => {};
  const gate = new Promise<void>((resolve) => { releasePost = resolve; });
  const original = (global.fetch as jest.Mock).getMockImplementation()!;
  await openAthlete();
  (global.fetch as jest.Mock).mockImplementation(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') { await gate; return { ok: true, status: 200, json: async () => ({ ok: true }) }; }
    return original(url, init);
  });
  fireEvent.change(screen.getByLabelText('Date of injury'), { target: { value: '2026-10-01' } });
  fireEvent.click(screen.getByRole('button', { name: 'Record injury' }));
  await waitFor(() => expect((screen.getByLabelText('Athlete') as HTMLSelectElement).disabled).toBe(true));
  await act(async () => { releasePost(); await gate; });
  await waitFor(() => expect((screen.getByLabelText('Athlete') as HTMLSelectElement).disabled).toBe(false));
});

test('a linked record older than the offered choices still shows as linked, and stays linked on save', async () => {
  injuriesReply = [{ ...WRIST, linked_hold_id: 'hold-old', linked_pain_report_id: 'pain-old' }];
  const list = await openAthlete();
  fireEvent.click(within(list).getByRole('button', { name: 'Edit' }));
  const hold = screen.getByLabelText('Training hold') as HTMLSelectElement;
  expect(hold.value).toBe('hold-old');
  expect(hold.selectedOptions[0].textContent).toBe('Linked record (older)');
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save changes' })); });
  expect(posts[0]).toMatchObject({ linked_hold_id: 'hold-old', linked_pain_report_id: 'pain-old' });
});

test('a failed save is shown as an alert, not in the same voice as a success', async () => {
  postReply = { status: 403, body: { error: 'Forbidden: coach is not assigned to athlete' } };
  await openAthlete();
  fireEvent.change(screen.getByLabelText('Date of injury'), { target: { value: '2026-10-01' } });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Record injury' })); });
  expect(within(await screen.findByRole('alert')).getByText('Forbidden: coach is not assigned to athlete')).toBeTruthy();
  expect(screen.queryByRole('status')).toBeNull();
});

test('a load that fails is an alert, never "No injuries recorded"', async () => {
  const original = (global.fetch as jest.Mock).getMockImplementation()!;
  (global.fetch as jest.Mock).mockImplementation(async (url: string, init?: RequestInit) => {
    if (String(url).includes('athlete_id=')) return { ok: true, json: async () => { throw new Error('not json'); } };
    return original(url, init);
  });
  render(<CoachInjuriesPage />);
  const select = await screen.findByLabelText('Athlete');
  await waitFor(() => expect((select as HTMLSelectElement).disabled).toBe(false));
  await act(async () => { fireEvent.change(select, { target: { value: 'ath-1' } }); });
  expect(within(await screen.findByRole('alert')).getByText('Injuries could not be loaded.')).toBeTruthy();
  expect(screen.queryByText('No injuries recorded for this athlete.')).toBeNull();
  expect(screen.queryByText('Loading injuries...')).toBeNull();
});

test("a hold's time stamp is shown as the gym's day, not UTC's", async () => {
  await openAthlete();
  const hold = within(screen.getByLabelText('Training hold')).getByRole('option', { name: /Contact only/ });
  expect(hold.textContent).toBe('Contact only 9/1/2026 (active)');
});

test('the picker offers only athletes the injury route will open for this coach', async () => {
  render(<CoachInjuriesPage />);
  const select = await screen.findByLabelText('Athlete');
  await waitFor(() => expect((select as HTMLSelectElement).disabled).toBe(false));
  expect(options('Athlete')).toEqual(['', 'ath-1']);
});

test('a coach who coaches or covers nobody is told so, and the roster ids were sent to be checked', async () => {
  accessibleReply = [];
  render(<CoachInjuriesPage />);
  expect(await screen.findByRole('option', { name: 'No athletes you coach or cover' })).toBeTruthy();
  const check = (global.fetch as jest.Mock).mock.calls.find(([, init]) => init?.method === 'POST');
  expect(JSON.parse(String(check?.[1].body))).toEqual({ action: 'accessible_athletes', athlete_ids: ['ath-1', 'ath-x'] });
});
