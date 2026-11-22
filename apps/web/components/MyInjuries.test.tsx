/**
 * @jest-environment jsdom
 */

import '@testing-library/jest-dom';
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

test('a 200 without an injuries list is a failed read, not "no injuries"', async () => {
  mockFetch({ ok: true, body: { ok: true } });
  render(<MyInjuries />);
  expect(await screen.findByText(/could not be read right now/)).toBeTruthy();
  expect(screen.queryByText('No injuries on record.')).toBeNull();
});

/* THE ROWS SPEAK IN THE DESIGN SYSTEM'S VOICES (AS9-5, Overwatch Q-D = A).
   The "who reported it · expected back" line carried a raw --bone-400, an ink
   written for leather: on the parent Safety page's paper it read 2.11:1 to
   1.74:1. As .t-muted it is restated in ink on paper and canvas and stays bone
   on the athlete's dark floor; the row is .t-body, so on the two kiosk pages
   that draw this list both lines take the --t-md floor together. */
test('each row is the body voice and its second line the muted voice, with no raw colour or size', async () => {
  mockFetch({ ok: true, body: { ok: true, injuries: [ROW] } });
  const { container } = render(<MyInjuries athleteId="ath-1" />);
  const second = await screen.findByText(/Stated by a clinician · Expected back/);
  expect(second).toHaveClass('t-muted');
  const row = second.closest('li') as HTMLElement;
  expect(row).toHaveClass('t-body');
  const list = container.querySelector('ul') as HTMLElement;
  expect(list.innerHTML).not.toMatch(/--bone-|text-\[length:/);
});
