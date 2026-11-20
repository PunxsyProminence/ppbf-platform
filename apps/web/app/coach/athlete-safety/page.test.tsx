/**
 * @jest-environment jsdom
 */

// Athlete Safety (lane AS-5) is the injury page grown into one athlete's page:
// the Injury Record section below is that page, moved unchanged, and the cases
// at the foot pin what was added. The Medical Restrictions panel and the
// family's notes are stubbed here; their own suites pin what they show.
//
// The coach injury page sends the form and shows what the route says back;
// authorization is the route's. These pin: the vocabularies match the server
// module; the list shows who it came from, the plan's return date when a plan
// is linked, and days lost; record and update send the FULL record (an update
// replaces it); a refusal is shown as the server worded it; marking entered in
// error asks first; each injury carries its Return plan block (the block's own
// states are pinned in components/ReturnPlanBlock.test.tsx); a re-read of the
// same athlete keeps the list mounted, and a re-read that fails takes it down.

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';

import { readFileSync } from 'node:fs';
import path from 'node:path';

import CoachInjuriesPage from './page';
import {
  ATHLETE_SAFETY_PAGE,
  CLEARANCE_BOARD_PAGE,
  DECISION_LOOP_PAGE,
  handOffArrivalAthlete,
  takeArrivalAthlete,
} from '@/components/decisionLoopArrival';
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
  default: ({ children, href, onClick }: { readonly children: ReactNode; readonly href: string; readonly onClick?: (event: MouseEvent) => void }) => (
    <a href={href} onClick={(event) => { event.preventDefault(); onClick?.(event.nativeEvent); }}>{children}</a>
  ),
}));

jest.mock('@/components/MedicalRestrictionsPanel', () => ({
  __esModule: true,
  default: ({ athleteId, onBusy }: { readonly athleteId?: string; readonly onBusy?: (busy: boolean) => void }) => (
    <div data-testid="restrictions-panel" data-athlete={athleteId}>
      <button type="button" onClick={() => onBusy?.(true)}>panel write out</button>
      <button type="button" onClick={() => onBusy?.(false)}>panel write back</button>
    </div>
  ),
}));

jest.mock('@/components/FamilyNotesPosted', () => ({
  __esModule: true,
  default: ({ athleteId }: { readonly athleteId: string }) => <div data-testid="family-notes" data-athlete={athleteId} />,
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
/** What the training-holds route answers for ath-1's active holds. */
let holdsReply: unknown;
let holdsStatus: number;

const HOLD = {
  hold_id: 'hold-1', athlete_id: 'ath-1', status: 'active', placed_by_role: 'coach', scope: 'all_training',
  athlete_explanation: 'Rest until the doctor has seen your wrist.', lift_condition_text: 'A note from the doctor.',
};

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
  holdsReply = { ok: true, holds: [] };
  holdsStatus = 200;
  global.fetch = jest.fn(async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.includes('/api/pilot/training-holds?athlete_id=ath-1&status=active') && init?.method === 'GET') {
      return { ok: holdsStatus < 300, status: holdsStatus, json: async () => holdsReply };
    }
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

test('a refused start after the route had already made the plan names that plan: it is linked to nothing', async () => {
  // The route creates, then links; a link refused because another coach linked first leaves the new plan loose.
  planPostReply = {
    status: 409, body: { error: 'This injury already has a return-to-training plan.', code: 'RTT_PLAN_ALREADY_LINKED' },
    injuries: [PLAN_INJURY, WRIST_LINKED_ELSEWHERE],
  };
  const { form } = await openStartOnWrist();
  candidatesReply = { ...CANDIDATES, plans: [...CANDIDATES.plans, { plan_id: 'plan-2', triggering_event: 'injury', event_date: '2026-08-01', earliest_return_date: '2026-08-10', status: 'active' }] };
  await act(async () => { fireEvent.click(within(form).getByRole('button', { name: 'Save plan' })); });
  const alert = await screen.findByRole('alert');
  expect(alert.textContent).toContain('This injury already has a return-to-training plan. Return plans for this athlete not linked to an injury listed here: Injury 8/1/2026.');
});

test.each([
  ['refused', { status: 400, body: { error: "earliest_return_date is before this injury's date." } }, "earliest_return_date is before this injury's date."],
  ['unknown', { status: 500, body: { error: 'Internal server error' } }, 'it is not known whether the plan was saved'],
])('a %s start whose block is still on screen is said once, beside its form, not repeated on the page', async (_kind, reply, said) => {
  planPostReply = reply;
  const { block, form } = await openStartOnWrist();
  await act(async () => { fireEvent.click(within(form).getByRole('button', { name: 'Save plan' })); });
  await waitFor(() => expect(screen.queryByText('Reading the injuries again\u2026')).toBeNull());
  const alerts = screen.getAllByRole('alert');
  expect(alerts).toHaveLength(1);
  expect(block.contains(alerts[0])).toBe(true);
  expect(alerts[0].textContent).toContain(said);
  // What was typed is still there for the coach to correct.
  expect((within(block).getByLabelText('Who set the rest period (rulebook, physician)') as HTMLInputElement).value).toBe('Dr. Reyes');
});

test('a saved plan followed by a failed re-read is said as saved, not as "Not done"', async () => {
  const { form } = await openStartOnWrist();
  injuriesFail = true;
  await act(async () => { fireEvent.click(within(form).getByRole('button', { name: 'Save plan' })); });
  const alert = await screen.findByRole('alert');
  expect(within(alert).getByText('Saved')).toBeTruthy();
  expect(alert.textContent).toContain('Return plan started. After that, the injuries could not be read again: Injuries could not be loaded.');
  expect(within(alert).queryByText('Not done')).toBeNull();
});

test('while a plan is being saved the athlete cannot be switched and no injury can be edited or saved', async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const original = (global.fetch as jest.Mock).getMockImplementation()!;
  const { list, form } = await openStartOnWrist();
  (global.fetch as jest.Mock).mockImplementation(async (url: string, init?: RequestInit) => {
    if (String(url).endsWith('/api/pilot/coach/return-to-training') && init?.method === 'POST') await gate;
    return original(url, init);
  });
  fireEvent.click(within(form).getByRole('button', { name: 'Save plan' }));
  // The answer must come back to this athlete and this list; an edit opened now would be saved without the plan.
  await waitFor(() => expect((screen.getByLabelText('Athlete') as HTMLSelectElement).disabled).toBe(true));
  for (const name of ['Edit', 'Entered in error']) {
    for (const button of within(list).getAllByRole('button', { name })) expect((button as HTMLButtonElement).disabled).toBe(true);
  }
  expect((screen.getByRole('button', { name: 'Record injury' }) as HTMLButtonElement).disabled).toBe(true);
  expect((within(list).getByRole('button', { name: 'Advance' }) as HTMLButtonElement).disabled).toBe(true);
  await act(async () => { release(); await gate; });
  await waitFor(() => expect((screen.getByLabelText('Athlete') as HTMLSelectElement).disabled).toBe(false));
  expect((within(list).getAllByRole('button', { name: 'Edit' })[0] as HTMLButtonElement).disabled).toBe(false);
  expect(posts).toEqual([]);
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

test('an active plan no listed injury links to is named on the injury with no plan', async () => {
  candidatesReply = { ...CANDIDATES, plans: [...CANDIDATES.plans, { plan_id: 'plan-9', triggering_event: 'knockout', event_date: '2026-07-04', earliest_return_date: null, status: 'active' }, { plan_id: 'plan-8', triggering_event: 'illness', event_date: '2026-06-01', earliest_return_date: null, status: 'cancelled' }] };
  const list = await openAthlete();
  const block = within(list).getAllByRole('region', { name: 'Return plan' })[1];
  // plan-1 is linked to the other injury and plan-8 is cancelled: only plan-9 is named.
  expect(within(block).getByText(/not linked to an injury listed here: Knockout 7\/4\/2026\. To use one/)).toBeTruthy();
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
  expect(await screen.findByRole('option', { name: 'No athletes in your gym' })).toBeTruthy();
  const check = (global.fetch as jest.Mock).mock.calls.find(([, init]) => init?.method === 'POST');
  expect(JSON.parse(String(check?.[1].body))).toEqual({ action: 'accessible_athletes', athlete_ids: ['ath-1', 'ath-x'] });
});

test("a pain report is offered by its score only, with no severity word (#1528)", async () => {
  candidatesReply = {
    ...CANDIDATES,
    painReports: [
      // 01:30 UTC on 9/3 is the evening of 9/2 at the gym.
      { near_miss_id: 'pain-1', severity: 'high', pain_score: 6, created_at: '2026-09-03 01:30:00+00' },
      { near_miss_id: 'pain-2', severity: 'moderate', pain_score: null, created_at: '2026-09-04 14:00:00+00' },
    ],
  };
  await openAthlete();

  const picker = screen.getByLabelText("Athlete's pain report");
  const labels = within(picker).getAllByRole('option').map((o) => o.textContent);
  expect(labels).toEqual(['None', '6/10 9/2/2026', 'No score 9/4/2026']);
  for (const label of labels) expect(label).not.toMatch(/\b(low|moderate|high|critical)\b/i);
  expect((within(picker).getByRole('option', { name: '6/10 9/2/2026' }) as HTMLOptionElement).value).toBe('pain-1');

  // Control: a record that is not a pain report still reads by its word.
  expect(within(screen.getByLabelText('Training hold')).getByRole('option', { name: /Contact only/ }).textContent)
    .toBe('Contact only 9/1/2026 (active)');
});

// Lane AS-5 (S2-3 A): what Athlete Safety adds around the Injury Record.
describe('Athlete Safety (lane AS-5)', () => {
  const scrolled: Element[] = [];
  const original = Element.prototype.scrollIntoView;

  beforeEach(() => {
    scrolled.length = 0;
    Element.prototype.scrollIntoView = function scrollIntoView(this: Element) {
      scrolled.push(this);
    };
  });

  afterEach(() => {
    Element.prototype.scrollIntoView = original;
    window.history.replaceState(null, '', '/');
    takeArrivalAthlete(ATHLETE_SAFETY_PAGE);
    takeArrivalAthlete(CLEARANCE_BOARD_PAGE);
    takeArrivalAthlete(DECISION_LOOP_PAGE);
  });

  test('the page is Athlete Safety; its three sections show once an athlete is chosen, each for that athlete', async () => {
    render(<CoachInjuriesPage />);
    expect(screen.getByRole('heading', { level: 1, name: 'Athlete Safety' })).toBeTruthy();
    await screen.findByLabelText('Athlete');
    expect(screen.queryByRole('heading', { name: 'Injury Record' })).toBeNull();
    expect(screen.queryByTestId('restrictions-panel')).toBeNull();
    cleanup();

    await openAthlete();
    for (const [name, id] of [['Injury Record', 'injury-record'], ['Medical Restrictions', 'medical-restrictions'], ["Post to the Family's Page", 'post-to-family']]) {
      expect(screen.getByRole('heading', { level: 2, name }).closest('section')?.id).toBe(id);
    }
    expect(screen.getByTestId('restrictions-panel').getAttribute('data-athlete')).toBe('ath-1');
    expect(screen.getByTestId('family-notes').getAttribute('data-athlete')).toBe('ath-1');
  });

  test('"Find an athlete" narrows the pick and says how many match; the athlete already chosen stays offered', async () => {
    accessibleReply = ['ath-1', 'ath-x'];
    render(<CoachInjuriesPage />);
    const find = (await screen.findByLabelText('Find an athlete')) as HTMLInputElement;
    expect(find.classList.contains('input--kiosk')).toBe(true);
    // `.select` alone is floored at 46px unlayered, under the kiosk 55px.
    expect(screen.getByLabelText('Athlete').classList.contains('input--kiosk')).toBe(true);
    expect(screen.getByText('2 athletes.')).toBeTruthy();

    fireEvent.change(find, { target: { value: 'jord' } });
    expect(options('Athlete')).toEqual(['', 'ath-1']);
    expect(screen.getByText('1 of 2 athletes match.').getAttribute('aria-live')).toBe('polite');

    await act(async () => {
      fireEvent.change(screen.getByLabelText('Athlete'), { target: { value: 'ath-1' } });
    });
    fireEvent.change(find, { target: { value: 'nobody' } });
    expect(options('Athlete')).toEqual(['', 'ath-1']);
    expect(screen.getByText('0 of 2 athletes match.')).toBeTruthy();
  });

  test('an athlete handed over is chosen when the list holds them; otherwise, or for another page, nobody is', async () => {
    handOffArrivalAthlete('ath-1', ATHLETE_SAFETY_PAGE);
    render(<CoachInjuriesPage />);
    await screen.findByRole('region', { name: 'Injuries' });
    expect((screen.getByLabelText('Athlete') as HTMLSelectElement).value).toBe('ath-1');
    cleanup();

    // ath-x is in the gym roster but not in the list this person may open.
    handOffArrivalAthlete('ath-x', ATHLETE_SAFETY_PAGE);
    render(<CoachInjuriesPage />);
    const select = (await screen.findByLabelText('Athlete')) as HTMLSelectElement;
    await waitFor(() => expect(select.disabled).toBe(false));
    await act(async () => {
      await Promise.resolve();
    });
    expect(select.value).toBe('');
    // Nothing is read or shown for an athlete the list does not hold.
    expect(screen.queryByRole('heading', { name: 'Injury Record' })).toBeNull();
    const urls = (global.fetch as unknown as jest.Mock).mock.calls.map(([u]) => String(u));
    expect(urls.some((u) => u.includes('ath-x') && !u.includes('/athletes/list'))).toBe(false);
    cleanup();

    handOffArrivalAthlete('ath-1');
    render(<CoachInjuriesPage />);
    const again = (await screen.findByLabelText('Athlete')) as HTMLSelectElement;
    await waitFor(() => expect(again.disabled).toBe(false));
    expect(again.value).toBe('');
  });

  test('the family link and the Clearance Board link hand this athlete to their page, on a plain click only, with no id in an address', async () => {
    await openAthlete();
    const family = screen.getByRole('link', { name: "Post to the Family's Page" });
    expect(family.getAttribute('href')).toBe('/coach/decision-loop#post-to-family');
    fireEvent.click(family, { ctrlKey: true });
    expect(takeArrivalAthlete(DECISION_LOOP_PAGE)).toBeNull();
    fireEvent.click(family);
    expect(takeArrivalAthlete(DECISION_LOOP_PAGE)).toBe('ath-1');

    const board = screen.getByRole('link', { name: 'Clearance Board' });
    expect(board.getAttribute('href')).toBe('/coach/sports-medicine');
    fireEvent.click(board);
    expect(takeArrivalAthlete(CLEARANCE_BOARD_PAGE)).toBe('ath-1');

    for (const link of screen.getAllByRole('link')) {
      expect(link.getAttribute('href')).not.toContain('ath-1');
    }
  });

  test('an old address opens its section: once the athlete is chosen and the injuries are read, the page scrolls there once', async () => {
    window.history.replaceState(null, '', '/coach/athlete-safety#medical-restrictions');
    await openAthlete();
    await waitFor(() => expect(scrolled).toHaveLength(1));
    expect(scrolled[0].id).toBe('medical-restrictions');

    await act(async () => {
      fireEvent.change(screen.getByLabelText('Athlete'), { target: { value: '' } });
    });
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Athlete'), { target: { value: 'ath-1' } });
    });
    await screen.findByRole('region', { name: 'Injuries' });
    expect(scrolled).toHaveLength(1);
  });

  test('the scroll to an old address\'s section waits until the injuries are read, so the list above is in place', async () => {
    window.history.replaceState(null, '', '/coach/athlete-safety#medical-restrictions');
    const base = global.fetch;
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    global.fetch = jest.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes('/api/pilot/coach/injuries?athlete_id=ath-1')) await held;
      return (base as unknown as (u: string, i?: RequestInit) => Promise<Response>)(url, init);
    }) as unknown as typeof fetch;
    render(<CoachInjuriesPage />);
    const select = (await screen.findByLabelText('Athlete')) as HTMLSelectElement;
    await waitFor(() => expect(select.disabled).toBe(false));
    await act(async () => {
      fireEvent.change(select, { target: { value: 'ath-1' } });
    });
    expect(screen.getByTestId('restrictions-panel')).toBeTruthy();
    expect(scrolled).toEqual([]);
    await act(async () => {
      release();
      await held;
    });
    await waitFor(() => expect(scrolled).toHaveLength(1));
    expect(scrolled[0].id).toBe('medical-restrictions');
  });

  test('the Injury Record\'s old address opens the page at the pick: the page is not scrolled to it', async () => {
    window.history.replaceState(null, '', '/coach/athlete-safety#injury-record');
    await openAthlete();
    await act(async () => {
      await Promise.resolve();
    });
    expect(scrolled).toEqual([]);
  });

  test('each section names the athlete under its heading, so the athlete is named wherever the page opens', async () => {
    await openAthlete();
    for (const id of ['injury-record', 'medical-restrictions', 'post-to-family']) {
      const heading = document.getElementById(id)?.querySelector('h2');
      expect(heading?.nextElementSibling?.textContent).toBe('Jordan Doe');
    }
  });

  // Tablet review: text straight on the clinic wall photo does not read.
  test('the pick and each section\'s heading and intro sit on a mat, not on the wall', async () => {
    await openAthlete();
    const onMat = (element: Element) => element.closest('.mat-leather') !== null;
    expect(onMat(screen.getByLabelText('Find an athlete'))).toBe(true);
    expect(onMat(screen.getByText('1 athlete.'))).toBe(true);
    expect(onMat(screen.getByLabelText('Athlete'))).toBe(true);
    for (const name of ['Injury Record', 'Medical Restrictions', "Post to the Family's Page"]) {
      expect(onMat(screen.getByRole('heading', { level: 2, name }))).toBe(true);
    }
    expect(onMat(screen.getByText(/^Record what the athlete, a parent/))).toBe(true);
    expect(onMat(screen.getByText(/^USA Boxing medical restrictions:/))).toBe(true);
    // The form's heading sits under the Injury Record's.
    expect(screen.getByRole('heading', { level: 3, name: 'Record an injury' })).toBeTruthy();
  });

  // The Medical Restrictions page's roster failure, kept (its page test on main).
  test('a roster that will not load says "Not loaded" at the gym-floor size, and offers no pick', async () => {
    const base = global.fetch;
    global.fetch = jest.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes('/api/pilot/athletes/list')) return { ok: false, status: 500, json: async () => ({}) };
      return (base as unknown as (u: string, i?: RequestInit) => Promise<Response>)(url, init);
    }) as unknown as typeof fetch;
    render(<CoachInjuriesPage />);
    const message = await screen.findByText('Your roster could not be loaded. Reload to try again.');
    // Gym-floor size (OD-2026-11-17-009 ruling 4): .alert-* are fixed sizes the kiosk floor does not reach.
    expect(message.getAttribute('style')).toContain('font-size: var(--t-md)');
    expect(screen.getByText('Not loaded').getAttribute('style')).toContain('font-size: var(--t-md)');
    expect(screen.queryByLabelText('Athlete')).toBeNull();
    expect(screen.queryByLabelText('Find an athlete')).toBeNull();
    expect(screen.queryByText('Loading roster...')).toBeNull();
  });

  test('a failed injury read is said at the gym-floor size too, as "Not done"', async () => {
    injuriesFail = true;
    render(<CoachInjuriesPage />);
    const select = (await screen.findByLabelText('Athlete')) as HTMLSelectElement;
    await waitFor(() => expect(select.disabled).toBe(false));
    await act(async () => {
      fireEvent.change(select, { target: { value: 'ath-1' } });
    });
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText('Not done').getAttribute('style')).toContain('font-size: var(--t-md)');
    expect(within(alert).getByText('Injuries could not be loaded.').getAttribute('style')).toContain('font-size: var(--t-md)');
  });

  // AS5-2b (Overwatch Q-3 = A on #2030; Q-B2 and Q-B4 = A on #2041).
  describe('the Training Hold section', () => {
    const section = () => document.getElementById('training-hold') as HTMLElement;
    const UNREAD = 'Training hold could not be read just now. Unknown is not “no hold” — check again before making a call that depends on it.';

    test('it is the first section after the pick, names the athlete, and shows nothing for an athlete with no hold', async () => {
      await openAthlete();
      expect([...document.querySelectorAll('section[id]')].map((s) => s.id))
        .toEqual(['training-hold', 'injury-record', 'medical-restrictions', 'post-to-family']);
      await waitFor(() => expect(section().getAttribute('aria-busy')).toBe('false'));
      expect(within(section()).getByRole('heading', { level: 2, name: 'Training Hold' }).nextElementSibling?.textContent).toBe('Jordan Doe');
      expect(section().closest('.mat-leather')).not.toBeNull();
      expect(section().querySelector('[data-refusal-stamp]')).toBeNull();
      expect(within(section()).queryByText(UNREAD)).toBeNull();
    });

    test('an active hold is shown in the board\'s words, read only: nothing here places or lifts', async () => {
      holdsReply = { ok: true, holds: [HOLD] };
      await openAthlete();
      const stamp = await within(section()).findByText('TRAINING HOLD');
      expect(stamp.closest('[data-refusal-stamp="training_hold"]')).not.toBeNull();
      expect(within(section()).getByText('Active Training Hold — all training')).toBeTruthy();
      expect(within(section()).getByText('Rest until the doctor has seen your wrist.')).toBeTruthy();
      expect(within(section()).getByText('Lifts when: A note from the doctor.')).toBeTruthy();
      // Placing and lifting are the Clearance Board's.
      expect(within(section()).queryAllByRole('button')).toEqual([]);
      expect(within(section()).queryAllByRole('textbox')).toEqual([]);
      expect(section().textContent).not.toMatch(/Lift this hold|Lift note|Place hold|only an organization admin can lift/);
      const sent = (global.fetch as unknown as jest.Mock).mock.calls
        .filter(([u]) => String(u).includes('/api/pilot/training-holds'));
      expect(sent.map(([u, init]) => [String(u).split('/api/pilot/')[1], init?.method]))
        .toEqual([['training-holds?athlete_id=ath-1&status=active', 'GET']]);
    });

    test('a hold with no lift condition says so, in the board\'s words', async () => {
      holdsReply = { ok: true, holds: [{ ...HOLD, lift_condition_text: '' }] };
      await openAthlete();
      expect(await within(section()).findByText(
        'Lifts when: Not written down — all this athlete is told is to ask whoever placed the hold. Tell them what ends it.',
      )).toBeTruthy();
    });

    test.each<[string, () => void]>([
      ['the route refuses', () => { holdsStatus = 500; }],
      ['the answer does not say ok', () => { holdsReply = { holds: [] }; }],
      ['the answer carries another athlete\'s hold', () => { holdsReply = { ok: true, holds: [{ ...HOLD, athlete_id: 'ath-2' }] }; }],
      ['the answer carries a hold already lifted', () => { holdsReply = { ok: true, holds: [{ ...HOLD, status: 'lifted' }] }; }],
      ['the answer carries a hold with no sentence for the athlete', () => { holdsReply = { ok: true, holds: [{ ...HOLD, athlete_explanation: ' ' }] }; }],
    ])('a hold nobody could read is said as unread, never shown as no hold or as a hold: %s', async (_name, arrange) => {
      arrange();
      await openAthlete();
      expect(await within(section()).findByText(UNREAD)).toBeTruthy();
      expect(section().querySelector('[data-refusal-stamp]')).toBeNull();
      expect(section().textContent).not.toContain('Rest until the doctor');
      // The board's sentence, cut before the part about the board's own row (Q-B4 = A).
      expect(section().textContent).not.toMatch(/cannot be placed from this row/);
    });

    test('the Clearance Board link sits with the hold and opens the board on this athlete; with nobody chosen it is at the foot and hands nobody over', async () => {
      render(<CoachInjuriesPage />);
      await screen.findByLabelText('Athlete');
      const foot = screen.getByRole('link', { name: 'Clearance Board' });
      expect(foot.closest('section')).toBeNull();
      expect(foot.getAttribute('href')).toBe('/coach/sports-medicine');
      fireEvent.click(foot);
      expect(takeArrivalAthlete(CLEARANCE_BOARD_PAGE)).toBeNull();
      cleanup();

      await openAthlete();
      const links = screen.getAllByRole('link', { name: 'Clearance Board' });
      expect(links).toHaveLength(1);
      expect(links[0].closest('section')?.id).toBe('training-hold');
      expect(links[0].getAttribute('href')).toBe('/coach/sports-medicine');
      fireEvent.click(links[0], { ctrlKey: true });
      expect(takeArrivalAthlete(CLEARANCE_BOARD_PAGE)).toBeNull();
      fireEvent.click(links[0]);
      expect(takeArrivalAthlete(CLEARANCE_BOARD_PAGE)).toBe('ath-1');
    });

    test('one athlete\'s hold is never on screen under another\'s name: it is taken down the moment the pick changes', async () => {
      accessibleReply = ['ath-1', 'ath-x'];
      holdsReply = { ok: true, holds: [HOLD] };
      const base = global.fetch;
      let release: () => void = () => undefined;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      global.fetch = jest.fn(async (url: string, init?: RequestInit) => {
        const u = String(url);
        if (u.includes('/api/pilot/training-holds?athlete_id=ath-x')) {
          await held;
          return { ok: true, status: 200, json: async () => ({ ok: true, holds: [] }) };
        }
        if (u.includes('ath-x') && !u.includes('/athletes/list')) return { ok: false, status: 502, json: async () => ({}) };
        return (base as unknown as (u: string, i?: RequestInit) => Promise<Response>)(url, init);
      }) as unknown as typeof fetch;

      await openAthlete();
      await within(section()).findByText('TRAINING HOLD');
      await act(async () => {
        fireEvent.change(screen.getByLabelText('Athlete'), { target: { value: 'ath-x' } });
      });
      // ath-x's hold has not been read yet, and nothing of ath-1's is left up.
      expect(within(section()).getByRole('heading', { name: 'Training Hold' }).nextElementSibling?.textContent).toBe('Not Mine');
      expect(section().getAttribute('aria-busy')).toBe('true');
      expect(screen.queryByText('TRAINING HOLD')).toBeNull();
      expect(document.body.textContent).not.toContain('Rest until the doctor');
      await act(async () => {
        release();
        await held;
      });
      await waitFor(() => expect(section().getAttribute('aria-busy')).toBe('false'));
      expect(screen.queryByText('TRAINING HOLD')).toBeNull();
    });

    test('nothing in the section is set below the gym-floor type size', async () => {
      holdsReply = { ok: true, holds: [HOLD] };
      await openAthlete();
      await within(section()).findByText('TRAINING HOLD');
      expect(section().querySelectorAll('[style*="font-size"]')).toHaveLength(0);
      expect(section().querySelector('.stamp')?.classList.contains('stamp--kiosk')).toBe(true);
    });
  });

  test('while the Medical Restrictions panel has a write out, the athlete pick is locked', async () => {
    await openAthlete();
    const select = screen.getByLabelText('Athlete') as HTMLSelectElement;
    expect(select.disabled).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'panel write out' }));
    expect(select.disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'panel write back' }));
    expect(select.disabled).toBe(false);
  });

  // The page's gate is exactly the gate of the two pages it took in.
  test('the page admits exactly coach and admin', () => {
    const source = readFileSync(path.join(__dirname, 'page.tsx'), 'utf8');
    const gates = [...source.matchAll(/allowedRoles=\{\[([^\]]*)\]\}/g)].map((m) => m[1]);
    expect(gates).toEqual(["'coach', 'admin'"]);
  });

  // components/glossaryWords.test.ts reads app/coach/injuries/page.tsx, which is
  // a redirect now; the same guard, here, on the page that holds the words.
  test('the Injury Record names the Training Hold, not a pause', () => {
    const source = readFileSync(path.join(__dirname, 'page.tsx'), 'utf8');
    expect(source).not.toMatch(/does not pause training/);
    expect(source).toMatch(/place a Training Hold for that/);
  });
});
