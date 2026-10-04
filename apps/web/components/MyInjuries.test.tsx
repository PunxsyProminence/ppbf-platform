/**
 * @jest-environment jsdom
 */

import { render, screen, waitFor } from '@testing-library/react';

import MyInjuries from './MyInjuries';

const ROW = {
  injury_id: 'inj-1',
  injury_date: '2026-09-01',
  body_area: 'lower_leg',
  injury_type: 'sprain_strain',
  context: 'competition',
  reported_by: 'clinician',
  expected_return_date: '2026-09-20',
  returned_on: null,
  // Not something the route sends; present so the test pins that the view
  // renders only the fields it knows.
  staff_note: 'Staff only.',
};

function mockFetch(reply: { ok: boolean; body: unknown }) {
  global.fetch = jest.fn(async () => ({ ok: reply.ok, json: async () => reply.body })) as unknown as typeof fetch;
}

test("an athlete's own record: no athlete_id is sent, and only the family fields render", async () => {
  mockFetch({ ok: true, body: { ok: true, injuries: [ROW] } });
  render(<MyInjuries />);
  expect(await screen.findByText(/Lower leg · Sprain \/ strain · Competition/)).toBeTruthy();
  expect(screen.getByText(/Stated by a clinician · Expected back/)).toBeTruthy();
  expect(screen.queryByText(/Staff only/)).toBeNull();
  expect((global.fetch as jest.Mock).mock.calls[0][0]).toMatch(/\/api\/pilot\/athlete\/injuries$/);
});

test("a guardian's view names the child", async () => {
  mockFetch({ ok: true, body: { ok: true, injuries: [{ ...ROW, returned_on: '2026-09-18' }] } });
  render(<MyInjuries athleteId="ath 7" />);
  expect(await screen.findByText(/Back /)).toBeTruthy();
  expect((global.fetch as jest.Mock).mock.calls[0][0]).toMatch(/\/api\/pilot\/athlete\/injuries\?athlete_id=ath%207$/);
});

test('no injuries says so', async () => {
  mockFetch({ ok: true, body: { ok: true, injuries: [] } });
  render(<MyInjuries />);
  expect(await screen.findByText('No injuries on record.')).toBeTruthy();
});

test('a refused or failed read says it could not be read, never "no injuries"', async () => {
  mockFetch({ ok: false, body: { error: 'Forbidden' } });
  render(<MyInjuries athleteId="ath-1" />);
  expect(await screen.findByText(/could not be read right now/)).toBeTruthy();
  await waitFor(() => expect(screen.queryByText('No injuries on record.')).toBeNull());
});
