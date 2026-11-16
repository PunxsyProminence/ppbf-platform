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
