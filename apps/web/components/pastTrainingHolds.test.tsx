/**
 * @jest-environment jsdom
 */

import { act, fireEvent, render, screen, within } from '@testing-library/react';

import PastTrainingHolds, { isoInstant } from './PastTrainingHolds';

// Past holds on the Sports Medicine board (audit finding F-071). The route's
// reads and who may make them are proven in the training-holds route suites;
// this pins what the list does with the answer: athlete-safe fields only (the
// board's 2026-08-15 rule), ended holds only, and a failed or malformed read is
// never shown as "no past holds".

function respond(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

const ACTIVE = {
  hold_id: 'h-active',
  athlete_id: 'ath-1',
  status: 'active',
  scope: 'all_training',
  athlete_explanation: 'CURRENT hold sentence',
  lift_condition_text: '',
  placed_at: '2026-10-01 16:00:00+00',
  expires_at: null,
  lifted_at: null,
};
const LIFTED = {
  hold_id: 'h-lifted',
  athlete_id: 'ath-1',
  status: 'lifted',
  scope: 'contact_only',
  reason_category: 'medical',
  reason_text: 'STAFF-ONLY reason',
  athlete_explanation: 'No contact while your wrist heals.',
  lift_condition_text: 'Grip strength back to normal.',
  placed_at: '2026-09-01 16:00:00+00',
  expires_at: null,
  lifted_by_account_id: 'coach-login@example.org',
  lifted_at: '2026-09-10 16:00:00.123+00',
  lift_note: 'STAFF-ONLY lift note',
};
const EXPIRED = {
  hold_id: 'h-expired',
  athlete_id: 'ath-1',
  status: 'expired',
  scope: 'all_training',
  athlete_explanation: '',
  lift_condition_text: '',
  placed_at: '2026-08-01 16:00:00+00',
  // 02:00 UTC on the 16th is the evening of the 15th at the gym.
  expires_at: '2026-08-16 02:00:00+00',
  lifted_at: null,
};

let urls: string[];
function serve(handler: () => Response | Promise<Response>) {
  urls = [];
  global.fetch = jest.fn(async (input: RequestInfo | URL) => {
    urls.push(String(input));
    return handler();
  }) as unknown as typeof fetch;
}

afterEach(() => jest.restoreAllMocks());

test('closed, it reads nothing; opened, it reads every hold of this athlete with no status filter', async () => {
  serve(() => respond({ ok: true, holds: [] }));
  render(<PastTrainingHolds athleteId="ath 1" athleteName="Jordan Doe" />);
  expect(urls).toEqual([]);
  fireEvent.click(screen.getByRole('button', { name: 'Past holds' }));
  await screen.findByText('Jordan Doe has no lifted or expired holds.');
  expect(urls).toEqual(['/api/pilot/training-holds?athlete_id=ath%201']);
});

test('lists lifted and expired holds, not the active one, with only what the athlete was told', async () => {
  serve(() => respond({ ok: true, holds: [ACTIVE, LIFTED, EXPIRED] }));
  render(<PastTrainingHolds athleteId="ath-1" athleteName="Jordan Doe" />);
  fireEvent.click(screen.getByRole('button', { name: 'Past holds' }));

  const list = await screen.findByRole('list', { name: 'Past holds for Jordan Doe, newest first' });
  const items = within(list).getAllByRole('listitem');
  expect(items).toHaveLength(2);
  expect(within(items[0]).getByText('No contact while your wrist heals.')).toBeTruthy();
  expect(within(items[0]).getByText(/contact only · placed 9\/1\/2026 · Lifted 9\/10\/2026/)).toBeTruthy();
  expect(within(items[0]).getByText('Its path back was: Grip strength back to normal.')).toBeTruthy();
  // The expiry is a gym day, not a UTC day.
  expect(within(items[1]).getByText(/Expired 8\/15\/2026/)).toBeTruthy();
  expect(within(items[1]).getByText('No sentence was written for the athlete.')).toBeTruthy();
  expect(within(items[1]).getByText('Its path back was: Not written down.')).toBeTruthy();

  expect(screen.queryByText(/CURRENT hold sentence/)).toBeNull();
  expect(screen.queryByText(/STAFF-ONLY/)).toBeNull();
  expect(screen.queryByText(/medical/)).toBeNull();
  expect(screen.queryByText(/coach-login@example\.org/)).toBeNull();
});

test.each([
  ['a refused read', () => respond({ ok: false, error: 'Forbidden' }, 403)],
  ['a read that throws', () => Promise.reject(new Error('offline'))],
  ['a 200 without ok:true', () => respond({ holds: [] })],
  ['a 200 without a holds list', () => respond({ ok: true })],
  ['another athlete’s hold in the answer', () => respond({ ok: true, holds: [{ ...LIFTED, athlete_id: 'ath-2' }] })],
  ['an entry that is not a hold', () => respond({ ok: true, holds: [{}] })],
])('%s says it could not be read, never "no past holds", and Check again reads again', async (_label, handler) => {
  serve(handler);
  render(<PastTrainingHolds athleteId="ath-1" athleteName="Jordan Doe" />);
  fireEvent.click(screen.getByRole('button', { name: 'Past holds' }));

  const alert = await screen.findByRole('alert');
  expect(alert.textContent).toMatch(/could not be read just now\. This is not a statement that there were none\./);
  expect(screen.queryByText(/has no lifted or expired holds/)).toBeNull();

  serve(() => respond({ ok: true, holds: [LIFTED] }));
  fireEvent.click(within(alert).getByRole('button', { name: 'Check again' }));
  await screen.findByText('No contact while your wrist heals.');
  expect(screen.queryByRole('alert')).toBeNull();
});

test('an open list reads again when the board’s hold changes (a lift), and a closed one does not', async () => {
  serve(() => respond({ ok: true, holds: [] }));
  const { rerender } = render(<PastTrainingHolds athleteId="ath-1" athleteName="Jordan Doe" reloadKey="h-active" />);
  fireEvent.click(screen.getByRole('button', { name: 'Past holds' }));
  await screen.findByText('Jordan Doe has no lifted or expired holds.');

  serve(() => respond({ ok: true, holds: [LIFTED] }));
  rerender(<PastTrainingHolds athleteId="ath-1" athleteName="Jordan Doe" reloadKey="none" />);
  await screen.findByText('No contact while your wrist heals.');

  fireEvent.click(screen.getByRole('button', { name: 'Hide' }));
  serve(() => respond({ ok: true, holds: [] }));
  await act(async () => {
    rerender(<PastTrainingHolds athleteId="ath-1" athleteName="Jordan Doe" reloadKey="h-new" />);
  });
  expect(urls).toEqual([]);
});

test('the database’s text times are turned into ISO 8601, which every browser’s Date reads', () => {
  expect(isoInstant('2026-09-01 16:00:00+00')).toBe('2026-09-01T16:00:00+00:00');
  expect(isoInstant('2026-09-10 16:00:00.123+00')).toBe('2026-09-10T16:00:00.123+00:00');
  expect(isoInstant('2026-09-10T16:00:00.000Z')).toBe('2026-09-10T16:00:00.000Z');
});

test('an answer that arrives after Hide, or after a newer read, does not land', async () => {
  const pending: Array<(value: Response) => void> = [];
  serve(() => new Promise<Response>((resolve) => { pending.push(resolve); }));
  const { rerender } = render(<PastTrainingHolds athleteId="ath-1" athleteName="Jordan Doe" reloadKey="a" />);
  fireEvent.click(screen.getByRole('button', { name: 'Past holds' }));
  await screen.findByText('Reading past holds…');

  // A newer read (the board's hold changed) supersedes the first.
  rerender(<PastTrainingHolds athleteId="ath-1" athleteName="Jordan Doe" reloadKey="b" />);
  await act(async () => { pending[1](respond({ ok: true, holds: [] })); });
  await screen.findByText('Jordan Doe has no lifted or expired holds.');
  await act(async () => { pending[0](respond({ ok: true, holds: [LIFTED] })); });
  expect(screen.queryByText('No contact while your wrist heals.')).toBeNull();

  // Hidden while a read is out: the answer does not reopen the list.
  fireEvent.click(screen.getByRole('button', { name: 'Hide' }));
  fireEvent.click(screen.getByRole('button', { name: 'Past holds' }));
  fireEvent.click(screen.getByRole('button', { name: 'Hide' }));
  await act(async () => { pending[2](respond({ ok: true, holds: [LIFTED] })); });
  expect(screen.getByRole('button', { name: 'Past holds' })).toBeTruthy();
  expect(screen.queryByText('No contact while your wrist heals.')).toBeNull();
});
