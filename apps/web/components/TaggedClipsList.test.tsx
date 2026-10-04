/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen } from '@testing-library/react';

import TaggedClipsList from './TaggedClipsList';

const ATHLETES = [
  { athlete_id: 'ath-1', full_name: 'Avery Stone' },
  { athlete_id: 'ath-2', full_name: 'Blake Rivers' },
];

const CLIP = {
  tag_id: 'tag-1',
  video_session_id: 'vid-1',
  athlete_id: 'ath-1',
  event_kind: 'competition',
  competition_id: 'Golden Gloves',
  note: 'Round two',
  tagged_by_account_id: 'coach-1',
  created_at: '2026-10-01T18:00:00Z',
  title: 'Bout vs. North',
  status: 'ready',
  recorded_at: '2026-10-01T18:00:00Z',
};

function mockFetch(reply: { status: number; body: unknown }) {
  global.fetch = jest.fn(async () => ({
    ok: reply.status >= 200 && reply.status < 300,
    status: reply.status,
    json: async () => reply.body,
  })) as unknown as typeof fetch;
}

const urls = () => (global.fetch as jest.Mock).mock.calls.map((call) => call[0] as string);

test('no tagged clips says so', async () => {
  mockFetch({ status: 200, body: { items: [] } });
  render(<TaggedClipsList athletes={ATHLETES} />);
  expect(await screen.findByText('No tagged clips yet.')).toBeTruthy();
  expect(urls()[0]).toMatch(/\/api\/pilot\/video\/clips$/);
});

test('a clip shows title, athlete by name, event and note', async () => {
  mockFetch({ status: 200, body: { items: [CLIP] } });
  render(<TaggedClipsList athletes={ATHLETES} />);
  expect(await screen.findByText('Bout vs. North')).toBeTruthy();
  expect(screen.getByText(/Avery Stone · Competition · Golden Gloves/)).toBeTruthy();
  expect(screen.getByText('Round two')).toBeTruthy();
});

test('choosing an athlete filters by athlete_id', async () => {
  mockFetch({ status: 200, body: { items: [] } });
  render(<TaggedClipsList athletes={ATHLETES} />);
  await screen.findByText('No tagged clips yet.');
  fireEvent.change(screen.getByLabelText('Show clips for'), { target: { value: 'ath-2' } });
  await screen.findByText('No tagged clips yet.');
  expect(urls().at(-1)).toMatch(/\/api\/pilot\/video\/clips\?athlete_id=ath-2$/);
});

test('a refused athlete filter shows a plain message, not "no clips"', async () => {
  mockFetch({ status: 403, body: { error: 'Forbidden: coach is not assigned to athlete' } });
  render(<TaggedClipsList athletes={ATHLETES} />);
  expect(await screen.findByText('You can list clips only for athletes you coach.')).toBeTruthy();
  expect(screen.queryByText('No tagged clips yet.')).toBeNull();
});

test('a failed read says so, never "no clips"', async () => {
  mockFetch({ status: 500, body: { error: 'Internal server error' } });
  render(<TaggedClipsList athletes={ATHLETES} />);
  expect(await screen.findByText('Tagged clips could not be read right now.')).toBeTruthy();
  expect(screen.queryByText('No tagged clips yet.')).toBeNull();
});

test('a 200 without items is a failed read', async () => {
  mockFetch({ status: 200, body: {} });
  render(<TaggedClipsList athletes={ATHLETES} />);
  expect(await screen.findByText('Tagged clips could not be read right now.')).toBeTruthy();
});
