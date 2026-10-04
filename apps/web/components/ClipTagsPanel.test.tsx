/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import ClipTagsPanel from './ClipTagsPanel';

const ATHLETES = [
  { athlete_id: 'ath-1', full_name: 'Avery Stone' },
  { athlete_id: 'ath-2', full_name: 'Blake Rivers' },
];

const TAG = {
  tag_id: 'tag-1',
  athlete_id: 'ath-1',
  event_kind: 'sparring' as const,
  competition_id: null,
  note: 'Keeps hands high',
  created_at: '2026-10-01T18:00:00Z',
};

type Reply = { status: number; body: unknown };

/** Answers each fetch in order; the last reply repeats. */
function mockFetch(...replies: Reply[]) {
  let call = 0;
  global.fetch = jest.fn(async () => {
    const reply = replies[Math.min(call, replies.length - 1)];
    call += 1;
    return { ok: reply.status >= 200 && reply.status < 300, status: reply.status, json: async () => reply.body };
  }) as unknown as typeof fetch;
}

const calls = () => (global.fetch as jest.Mock).mock.calls as [string, RequestInit | undefined][];

test('no tags says so and reads the right route', async () => {
  mockFetch({ status: 200, body: { consent_blocked: false, items: [] } });
  render(<ClipTagsPanel videoId="vid 1" athletes={ATHLETES} />);
  expect(await screen.findByText('No athletes tagged on this clip yet.')).toBeTruthy();
  expect(calls()[0][0]).toMatch(/\/api\/pilot\/video\/vid%201\/tags$/);
});

test('a tag shows the athlete by name, the event and the note', async () => {
  mockFetch({ status: 200, body: { consent_blocked: false, items: [TAG] } });
  render(<ClipTagsPanel videoId="vid-1" athletes={ATHLETES} />);
  expect(await screen.findByText('Avery Stone · Sparring · Keeps hands high')).toBeTruthy();
});

test('a failed read says so, never "no athletes tagged"', async () => {
  mockFetch({ status: 500, body: { error: 'Internal server error' } });
  render(<ClipTagsPanel videoId="vid-1" athletes={ATHLETES} />);
  expect(await screen.findByText("This clip's tags could not be read right now.")).toBeTruthy();
  expect(screen.queryByText('No athletes tagged on this clip yet.')).toBeNull();
});

test('a 200 without items is a failed read', async () => {
  mockFetch({ status: 200, body: { consent_blocked: false } });
  render(<ClipTagsPanel videoId="vid-1" athletes={ATHLETES} />);
  expect(await screen.findByText("This clip's tags could not be read right now.")).toBeTruthy();
});

test('a hidden video reads as not available', async () => {
  mockFetch({ status: 404, body: { error: 'Not found' } });
  render(<ClipTagsPanel videoId="vid-1" athletes={ATHLETES} />);
  expect(await screen.findByText('This video is not available to you.')).toBeTruthy();
});

test('a consent-blocked clip says so plainly and shows no note, even if one arrives', async () => {
  // The server blanks notes on a blocked clip; the panel must not show one
  // even if a note slips through.
  mockFetch({ status: 200, body: { consent_blocked: true, items: [TAG] } });
  render(<ClipTagsPanel videoId="vid-1" athletes={ATHLETES} />);
  expect(await screen.findByText(/Consent blocked: .*no one can play this clip/)).toBeTruthy();
  expect(screen.getByText('Avery Stone · Sparring')).toBeTruthy();
  expect(screen.queryByText(/Keeps hands high/)).toBeNull();
});

test('tagging posts the athlete and event, then reloads', async () => {
  mockFetch(
    { status: 200, body: { consent_blocked: false, items: [] } },
    { status: 201, body: { ...TAG, tag_id: 'tag-2', athlete_id: 'ath-2' } },
    { status: 200, body: { consent_blocked: false, items: [{ ...TAG, tag_id: 'tag-2', athlete_id: 'ath-2', note: '' }] } },
  );
  render(<ClipTagsPanel videoId="vid-1" athletes={ATHLETES} />);
  await screen.findByText('No athletes tagged on this clip yet.');
  fireEvent.change(screen.getByLabelText('Athlete to tag'), { target: { value: 'ath-2' } });
  fireEvent.click(screen.getByText('Tag athlete'));
  expect(await screen.findByText('Tagged Blake Rivers.')).toBeTruthy();
  const [url, init] = calls()[1];
  expect(url).toMatch(/\/api\/pilot\/video\/vid-1\/tags$/);
  expect(init?.method).toBe('POST');
  expect(JSON.parse(String(init?.body))).toEqual({ athlete_id: 'ath-2', event_kind: 'sparring', competition_id: null, note: '' });
  expect(await screen.findByText('Blake Rivers · Sparring')).toBeTruthy();
});

test('tagging without an athlete asks for one and sends nothing', async () => {
  mockFetch({ status: 200, body: { consent_blocked: false, items: [] } });
  render(<ClipTagsPanel videoId="vid-1" athletes={ATHLETES} />);
  await screen.findByText('No athletes tagged on this clip yet.');
  fireEvent.click(screen.getByText('Tag athlete'));
  expect(await screen.findByText('Choose the athlete to tag.')).toBeTruthy();
  expect(calls()).toHaveLength(1);
});

test('a refused tag (athlete not theirs) shows a plain message', async () => {
  mockFetch(
    { status: 200, body: { consent_blocked: false, items: [] } },
    { status: 403, body: { error: 'Forbidden: coach is not assigned to athlete' } },
  );
  render(<ClipTagsPanel videoId="vid-1" athletes={ATHLETES} />);
  await screen.findByText('No athletes tagged on this clip yet.');
  fireEvent.change(screen.getByLabelText('Athlete to tag'), { target: { value: 'ath-2' } });
  fireEvent.click(screen.getByText('Tag athlete'));
  expect(await screen.findByText(/You can tag only athletes you coach/)).toBeTruthy();
  expect(screen.queryByText(/Forbidden/)).toBeNull();
});

test('a 400 shows the server message', async () => {
  mockFetch(
    { status: 200, body: { consent_blocked: false, items: [] } },
    { status: 400, body: { error: 'event_kind must be "sparring" or "competition".', code: 'CLIP_TAG_EVENT_KIND' } },
  );
  render(<ClipTagsPanel videoId="vid-1" athletes={ATHLETES} />);
  await screen.findByText('No athletes tagged on this clip yet.');
  fireEvent.change(screen.getByLabelText('Athlete to tag'), { target: { value: 'ath-1' } });
  fireEvent.click(screen.getByText('Tag athlete'));
  expect(await screen.findByText('event_kind must be "sparring" or "competition".')).toBeTruthy();
});

test('removing a tag sends DELETE with the tag id and reloads', async () => {
  mockFetch(
    { status: 200, body: { consent_blocked: false, items: [TAG] } },
    { status: 200, body: { ok: true, tag_id: 'tag-1' } },
    { status: 200, body: { consent_blocked: false, items: [] } },
  );
  render(<ClipTagsPanel videoId="vid-1" athletes={ATHLETES} />);
  await screen.findByText('Avery Stone · Sparring · Keeps hands high');
  fireEvent.click(screen.getByText('Remove'));
  expect(await screen.findByText('Removed the tag for Avery Stone.')).toBeTruthy();
  const [url, init] = calls()[1];
  expect(url).toMatch(/\/api\/pilot\/video\/vid-1\/tags\?tag_id=tag-1$/);
  expect(init?.method).toBe('DELETE');
  expect(await screen.findByText('No athletes tagged on this clip yet.')).toBeTruthy();
});

test('a coach removal a consent block stops shows the admin-only message', async () => {
  const adminOnly = "This athlete's media consent blocks video, so removing their tag would let the clip play with them "
    + 'still in it. Ask an organization admin to remove it.';
  mockFetch(
    { status: 200, body: { consent_blocked: true, items: [{ ...TAG, note: '' }] } },
    { status: 409, body: { error: adminOnly, code: 'CLIP_TAG_REMOVAL_NEEDS_ADMIN' } },
  );
  render(<ClipTagsPanel videoId="vid-1" athletes={ATHLETES} />);
  await screen.findByText('Avery Stone · Sparring');
  fireEvent.click(screen.getByText('Remove'));
  expect(await screen.findByText(adminOnly)).toBeTruthy();
  await waitFor(() => expect(calls()).toHaveLength(2));
});

test('a removal refused because the athlete is not theirs reads as unavailable', async () => {
  mockFetch(
    { status: 200, body: { consent_blocked: false, items: [TAG] } },
    { status: 404, body: { error: 'Not found' } },
  );
  render(<ClipTagsPanel videoId="vid-1" athletes={ATHLETES} />);
  await screen.findByText('Avery Stone · Sparring · Keeps hands high');
  fireEvent.click(screen.getByText('Remove'));
  expect(await screen.findByText(/no longer available to you/)).toBeTruthy();
});

test('a network failure on remove says it could not be removed', async () => {
  let call = 0;
  global.fetch = jest.fn(async () => {
    call += 1;
    if (call === 1) return { ok: true, status: 200, json: async () => ({ consent_blocked: false, items: [TAG] }) };
    throw new Error('offline');
  }) as unknown as typeof fetch;
  render(<ClipTagsPanel videoId="vid-1" athletes={ATHLETES} />);
  await screen.findByText('Avery Stone · Sparring · Keeps hands high');
  fireEvent.click(screen.getByText('Remove'));
  expect(await screen.findByText('The tag could not be removed right now. Try again.')).toBeTruthy();
});

test('a competition tag sends the competition, and a change is reported to the page', async () => {
  mockFetch(
    { status: 200, body: { consent_blocked: false, items: [] } },
    { status: 201, body: { ...TAG, event_kind: 'competition', competition_id: 'Golden Gloves' } },
    { status: 200, body: { consent_blocked: false, items: [] } },
  );
  const onTagsChanged = jest.fn();
  render(<ClipTagsPanel videoId="vid-1" athletes={ATHLETES} onTagsChanged={onTagsChanged} />);
  await screen.findByText('No athletes tagged on this clip yet.');
  fireEvent.change(screen.getByLabelText('Athlete to tag'), { target: { value: 'ath-1' } });
  fireEvent.change(screen.getByLabelText('Event'), { target: { value: 'competition' } });
  fireEvent.change(screen.getByLabelText('Competition (optional)'), { target: { value: ' Golden Gloves ' } });
  fireEvent.click(screen.getByText('Tag athlete'));
  expect(await screen.findByText('Tagged Avery Stone.')).toBeTruthy();
  expect(JSON.parse(String(calls()[1][1]?.body))).toMatchObject({ event_kind: 'competition', competition_id: 'Golden Gloves' });
  expect(onTagsChanged).toHaveBeenCalledTimes(1);
});

test('an athlete missing from the roster is never shown as a raw id', async () => {
  mockFetch({ status: 200, body: { consent_blocked: false, items: [{ ...TAG, athlete_id: 'ath-zz9', note: '' }] } });
  render(<ClipTagsPanel videoId="vid-1" athletes={ATHLETES} />);
  expect(await screen.findByText('An athlete not on your roster · Sparring')).toBeTruthy();
  expect(screen.queryByText(/ath-zz9/)).toBeNull();
});

test('an ended session says to sign in again', async () => {
  mockFetch(
    { status: 200, body: { consent_blocked: false, items: [TAG] } },
    { status: 401, body: { error: 'Unauthorized' } },
  );
  render(<ClipTagsPanel videoId="vid-1" athletes={ATHLETES} />);
  await screen.findByText('Avery Stone · Sparring · Keeps hands high');
  fireEvent.click(screen.getByText('Remove'));
  expect(await screen.findByText('Your session has ended. Sign in again, then retry.')).toBeTruthy();
});
