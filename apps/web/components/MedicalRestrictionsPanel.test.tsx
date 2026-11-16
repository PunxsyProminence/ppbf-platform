/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import MedicalRestrictionsPanel from './MedicalRestrictionsPanel';
import { clearRoleSession, createPersistentRoleSession } from '@/components/roleSession';

/*
 * The Sports Medicine panel for USA Boxing medical restrictions (P22a). The
 * route decides everything; this asserts what the SURFACE promises: it opens
 * on demand, shows what the member reads plus whether the release and LBC
 * dates are on file, never prints the source, the loss-of-consciousness
 * answer or the staff note even when the server sends them, hides the void
 * control from a coach, and sends the form it was given.
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
  fireEvent.click(screen.getByRole('button', { name: 'Open medical restrictions' }));
  fireEvent.change(screen.getByLabelText('Member'), { target: { value: 'ath-1' } });
  await screen.findByText(name);
}

afterEach(() => {
  clearRoleSession();
  jest.restoreAllMocks();
});

test('closed until opened: no member names, no read', () => {
  respondWith([]);
  render(<MedicalRestrictionsPanel athletes={ATHLETES} />);
  expect(screen.queryByText('Test Member')).toBeNull();
  expect(calls).toHaveLength(0);
});

test('shows the state, the dates and what is not on file -- never the source, loss of consciousness or note', async () => {
  createPersistentRoleSession('coach');
  respondWith([ROW]);
  render(<MedicalRestrictionsPanel athletes={ATHLETES} />);
  await openFor('Release needed — no sparring');
  expect(screen.getByText('Minimum end date 10/30/2026.')).toBeTruthy();
  expect(document.body.textContent).not.toContain('10/1/2026');
  expect(screen.getByText(/Physician's release: not on file\./)).toBeTruthy();
  expect(screen.getByText(/LBC: not yet informed\./)).toBeTruthy();
  const text = document.body.textContent ?? '';
  for (const hidden of ['knockout', 'concussion', 'Over 1 minute', 'over_1_min', 'Staff-only test note']) {
    expect(text).not.toContain(hidden);
  }
  // A coach is not offered the void the route would refuse.
  expect(screen.queryByRole('button', { name: 'Mark entered in error' })).toBeNull();
  expect(calls[0].url).toContain('/api/pilot/coach/medical-restrictions?athlete_id=ath-1');
});

test('a gym admin is offered the void, and it sends the reason', async () => {
  createPersistentRoleSession('admin');
  respondWith([ROW]);
  render(<MedicalRestrictionsPanel athletes={ATHLETES} />);
  await openFor('Release needed — no sparring');
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
  await openFor('Release needed — no sparring');
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
