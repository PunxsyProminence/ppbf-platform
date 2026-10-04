/**
 * @jest-environment jsdom
 */

// The coach injury page sends the form and shows what the route says back;
// authorization is the route's. These pin: the vocabularies match the server
// module; the list shows who it came from, the plan's return date when a plan
// is linked, and days lost; record and update send the FULL record (an update
// replaces it); a refusal is shown as the server worded it; marking entered in
// error asks first.

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

let posts: Array<Record<string, unknown>>;
let postReply: { status: number; body: unknown };
let injuriesReply: unknown[];
let accessibleReply: string[];

beforeEach(() => {
  posts = [];
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
      return { ok: true, json: async () => ({ ok: true, injuries: injuriesReply, candidates: CANDIDATES }) };
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
