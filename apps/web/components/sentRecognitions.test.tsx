/**
 * @jest-environment jsdom
 */

import { act, fireEvent, render, screen, within } from '@testing-library/react';

import SentRecognitions from './SentRecognitions';

// Recognition read back for a coach (audit finding F-071). The route's read and
// who may make it are proven in the recognition route suites; this pins what
// the screen asks for and does with the answer, and that a failed or malformed
// read is never shown as "nothing sent".

function respond(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

const ROSTER = [
  { athlete_id: 'ath-2', full_name: 'Zed Young' },
  { athlete_id: 'ath-1', full_name: 'Ada Reyes' },
];

const ONE = {
  recognition_id: 'rec-1',
  athlete_id: 'ath-1',
  coach_display_name: 'Coach Dee',
  kind: 'helped_someone',
  note: 'Held the pads for the new kid.',
  // 02:30 UTC on the 14th is the evening of the 13th at the gym.
  created_at: '2026-10-14T02:30:00.000Z',
};
const TWO = { ...ONE, recognition_id: 'rec-2', kind: 'not_a_kind_this_build_knows', note: '  ', coach_display_name: '' };

let urls: string[];
function serve(handler: () => Response | Promise<Response>) {
  urls = [];
  global.fetch = jest.fn(async (input: RequestInfo | URL) => {
    urls.push(String(input));
    return handler();
  }) as unknown as typeof fetch;
}

function pick(athleteId: string) {
  fireEvent.change(screen.getByLabelText('Athlete'), { target: { value: athleteId } });
}

afterEach(() => jest.restoreAllMocks());

test('names are alphabetical, nothing is read until one is picked, then only that athlete is read', async () => {
  serve(() => respond({ ok: true, items: [] }));
  render(<SentRecognitions roster={ROSTER} />);
  const options = within(screen.getByLabelText('Athlete')).getAllByRole('option').map((option) => option.textContent);
  expect(options).toEqual(['Choose an athlete', 'Ada Reyes', 'Zed Young']);
  expect(urls).toEqual([]);

  pick('ath-1');
  await screen.findByText('Nothing has been sent to Ada Reyes yet.');
  expect(urls).toEqual(['/api/pilot/achievements/recognition?athlete_id=ath-1&limit=21']);
});

test('lists what was said, the coach’s own word, who said it and the gym day, in the order the route sends', async () => {
  serve(() => respond({ ok: true, items: [ONE, TWO] }));
  render(<SentRecognitions roster={ROSTER} />);
  pick('ath-1');

  const list = await screen.findByRole('list', { name: 'Recognition sent to Ada Reyes, newest first' });
  const items = within(list).getAllByRole('listitem');
  expect(items).toHaveLength(2);
  expect(within(items[0]).getByText('You helped somebody who needed it.')).toBeTruthy();
  expect(within(items[0]).getByText('“Held the pads for the new kid.”')).toBeTruthy();
  expect(within(items[0]).getByText('Coach Dee · 10/13/2026')).toBeTruthy();
  expect(within(items[1]).getByText('A recognition this screen does not have words for.')).toBeTruthy();
  expect(within(items[1]).getByText(/^A coach · /)).toBeTruthy();
  expect(within(items[1]).queryByText(/“/)).toBeNull();
  expect(screen.queryByText(/Only the newest/)).toBeNull();
});

test('twenty-one back: twenty are listed and it says older ones are kept', async () => {
  const many = Array.from({ length: 21 }, (_, index) => ({ ...ONE, recognition_id: `rec-${index}` }));
  serve(() => respond({ ok: true, items: many }));
  render(<SentRecognitions roster={ROSTER} />);
  pick('ath-1');
  await screen.findByText('Only the newest 20 are shown here. Older ones are kept.');
  expect(within(screen.getByRole('list')).getAllByRole('listitem')).toHaveLength(20);
});

test('exactly twenty back: all listed, and it does not claim there are older ones', async () => {
  const twenty = Array.from({ length: 20 }, (_, index) => ({ ...ONE, recognition_id: `rec-${index}` }));
  serve(() => respond({ ok: true, items: twenty }));
  render(<SentRecognitions roster={ROSTER} />);
  pick('ath-1');
  const list = await screen.findByRole('list');
  expect(within(list).getAllByRole('listitem')).toHaveLength(20);
  expect(screen.queryByText(/Older ones are kept/)).toBeNull();
});

test('a roster that could not be read says so, and is not shown as no athletes', () => {
  serve(() => respond({ ok: true, items: [] }));
  render(<SentRecognitions roster={[]} rosterState="unavailable" />);
  expect(screen.getByRole('alert').textContent).toMatch(/athlete list could not be read/);
  expect(screen.queryByText('No athletes on your roster.')).toBeNull();
});

test('a roster read that succeeded and is empty says there are no athletes; while loading it says nothing', () => {
  serve(() => respond({ ok: true, items: [] }));
  const { rerender } = render(<SentRecognitions roster={[]} rosterState="loading" />);
  expect(screen.queryByText('No athletes on your roster.')).toBeNull();
  expect(screen.queryByRole('alert')).toBeNull();
  rerender(<SentRecognitions roster={[]} rosterState="ready" />);
  expect(screen.getByText('No athletes on your roster.')).toBeTruthy();
});

test.each([
  ['a refused read', () => respond({ ok: false, error: 'Forbidden' }, 403)],
  ['a read that throws', () => Promise.reject(new Error('offline'))],
  ['a 200 without ok:true', () => respond({ items: [] })],
  ['a 200 without an items list', () => respond({ ok: true })],
  ['another athlete’s recognition in the answer', () => respond({ ok: true, items: [{ ...ONE, athlete_id: 'ath-2' }] })],
  ['an entry that is not a recognition', () => respond({ ok: true, items: [{}] })],
])('%s says it could not be read, never "nothing sent", and Check again reads again', async (_label, handler) => {
  serve(handler);
  render(<SentRecognitions roster={ROSTER} />);
  pick('ath-1');

  const alert = await screen.findByRole('alert');
  expect(alert.textContent).toMatch(/could not be read just now\. This is not a statement that nothing was sent\./);
  expect(screen.queryByText(/Nothing has been sent/)).toBeNull();

  serve(() => respond({ ok: true, items: [ONE] }));
  fireEvent.click(within(alert).getByRole('button', { name: 'Check again' }));
  await screen.findByText('You helped somebody who needed it.');
  expect(screen.queryByRole('alert')).toBeNull();
});

test('a send from the pad reads the open athlete again; with nobody picked it reads nothing', async () => {
  serve(() => respond({ ok: true, items: [] }));
  const { rerender } = render(<SentRecognitions roster={ROSTER} reloadKey={0} />);
  await act(async () => {
    rerender(<SentRecognitions roster={ROSTER} reloadKey={1} />);
  });
  expect(urls).toEqual([]);

  pick('ath-1');
  await screen.findByText('Nothing has been sent to Ada Reyes yet.');
  serve(() => respond({ ok: true, items: [ONE] }));
  rerender(<SentRecognitions roster={ROSTER} reloadKey={2} />);
  await screen.findByText('You helped somebody who needed it.');
});

test('a slow answer for the first athlete does not land on the second', async () => {
  let release: (value: Response) => void = () => {};
  serve(() => new Promise<Response>((resolve) => { release = resolve; }));
  render(<SentRecognitions roster={ROSTER} />);
  pick('ath-1');
  const first = release;

  serve(() => respond({ ok: true, items: [] }));
  pick('ath-2');
  await screen.findByText('Nothing has been sent to Zed Young yet.');
  await act(async () => { first(respond({ ok: true, items: [ONE] })); });
  expect(screen.queryByText('You helped somebody who needed it.')).toBeNull();
  expect(screen.getByText('Nothing has been sent to Zed Young yet.')).toBeTruthy();
});
