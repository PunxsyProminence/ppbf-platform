/**
 * @jest-environment jsdom
 */

/*
 * A guardian's view of their child's film (OD-2026-10-06-025 ruling 1): the
 * child picker from the guardian-gated athletes list, the child's rounds from
 * the parent branch of video/list, and the coach's notes with the playback,
 * signed with the coach's display name (ruling 2). Read-only throughout.
 */

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';

import ParentVideoPage from './page';

jest.mock('@/components/RoleStandaloneView', () => ({
  __esModule: true,
  default: ({ children }: { readonly children: ReactNode }) => <div>{children}</div>,
}));

const CHILD = { athlete_id: 'athlete-001', full_name: 'Jordan Doe' };
const SECOND_CHILD = { athlete_id: 'athlete-002', full_name: 'Riley Doe' };

const VIDEO = {
  video_session_id: 'vid-1',
  title: 'Sparring round 3',
  file_name: 'round3.mp4',
  file_size_bytes: 2_000_000,
  status: 'ready',
  created_at: '2026-07-30T00:00:00.000Z',
};

const PLAYBACK = {
  stream_url: 'https://example.invalid/stream',
  title: 'Sparring round 3',
  coach_notes: [
    { text: 'Guard dropped in round 2. Keep the right hand home.', coach_name: 'Coach Jane', noted_at: '2026-07-30T14:00:00.000Z' },
  ],
};

type JsonBody = Record<string, unknown>;

function jsonOk(body: JsonBody) {
  return { ok: true, json: async () => body } as Response;
}

function mockFetch(overrides: Record<string, () => Promise<Response> | Response> = {}) {
  return jest.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    for (const [fragment, responder] of Object.entries(overrides)) {
      if (url.includes(fragment)) return responder();
    }
    if (url.includes('/athletes/list')) return jsonOk({ items: [CHILD] });
    if (url.includes('/api/pilot/video/list')) return jsonOk({ items: [VIDEO] });
    if (/\/api\/pilot\/video\/[^/?]+$/.test(url)) return jsonOk(PLAYBACK);
    return jsonOk({ items: [] });
  });
}

afterEach(() => {
  jest.restoreAllMocks();
  // A switch is remembered (src/lib/chosenChild.ts); one test's pick must not
  // choose the next test's opening child.
  window.sessionStorage.clear();
  window.localStorage.clear();
});

test("the child's rounds are read for that child, and the coach note shows under the opened round", async () => {
  const fetchMock = mockFetch();
  global.fetch = fetchMock as unknown as typeof fetch;

  render(<ParentVideoPage />);

  await screen.findByText("Jordan Doe's Film");
  await screen.findByText('Sparring round 3');
  const listCall = fetchMock.mock.calls.map(([input]) => String(input)).find((url) => url.includes('/api/pilot/video/list'));
  expect(listCall).toContain('athlete_id=athlete-001');

  expect(screen.queryByText('Coach notes')).toBeNull();
  fireEvent.click(await screen.findByRole('button', { name: 'Play' }));

  await screen.findByText('Coach notes');
  await screen.findByText('Guard dropped in round 2. Keep the right hand home.');
  expect(screen.getByText(/Coach Jane/)).toBeTruthy();
  // Read-only: nothing to type into, nothing to upload.
  expect(screen.queryByRole('textbox')).toBeNull();
  expect(document.body.textContent).not.toContain('coach-1');
});

test('a guardian with no linked athlete is told so, and no film is requested', async () => {
  const fetchMock = mockFetch({ '/athletes/list': () => jsonOk({ items: [] }) });
  global.fetch = fetchMock as unknown as typeof fetch;

  render(<ParentVideoPage />);

  await screen.findByText('No linked athletes');
  expect(fetchMock.mock.calls.map(([input]) => String(input)).some((url) => url.includes('/api/pilot/video/list'))).toBe(false);
});

test('switching children re-reads the list for the other child and closes the open round', async () => {
  const fetchMock = mockFetch({
    '/athletes/list': () => jsonOk({ items: [CHILD, SECOND_CHILD] }),
    'athlete_id=athlete-002': () => jsonOk({ items: [] }),
  });
  global.fetch = fetchMock as unknown as typeof fetch;

  render(<ParentVideoPage />);

  // Two children and none remembered: the guardian picks (FAM-11).
  fireEvent.click(await screen.findByRole('button', { name: 'Jordan Doe' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Play' }));
  await screen.findByText('Coach notes');

  fireEvent.click(screen.getByRole('button', { name: 'Riley Doe' }));

  await screen.findByText("Riley Doe's Film");
  await waitFor(() => expect(screen.queryByText('Coach notes')).toBeNull());
  await screen.findByText('No film yet. It shows up here when a coach puts some up.');
});

test("a round opened for one child never lands under the other child's name", async () => {
  // Play on Jordan's round, then switch to Riley before the playback arrives:
  // the late response is dropped, not shown under "Riley Doe's Film".
  let releasePlayback: (() => void) | null = null;
  const fetchMock = mockFetch({
    '/athletes/list': () => jsonOk({ items: [CHILD, SECOND_CHILD] }),
    'athlete_id=athlete-002': () => jsonOk({ items: [] }),
    '/api/pilot/video/vid-1': () => new Promise<Response>((resolve) => { releasePlayback = () => resolve(jsonOk(PLAYBACK)); }),
  });
  global.fetch = fetchMock as unknown as typeof fetch;

  render(<ParentVideoPage />);

  fireEvent.click(await screen.findByRole('button', { name: 'Jordan Doe' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Play' }));
  await waitFor(() => expect(releasePlayback).not.toBeNull());
  fireEvent.click(screen.getByRole('button', { name: 'Riley Doe' }));
  await screen.findByText("Riley Doe's Film");

  await act(async () => { releasePlayback!(); });

  await screen.findByText('No film yet. It shows up here when a coach puts some up.');
  expect(screen.queryByText('Coach notes')).toBeNull();
  expect(screen.queryByText('Guard dropped in round 2. Keep the right hand home.')).toBeNull();
});

test("a consent refusal reaches the guardian in the server's own words, with no notes", async () => {
  global.fetch = mockFetch({
    '/api/pilot/video/vid-1': () => ({
      ok: false,
      status: 409,
      json: async () => ({ error: 'Blocked: photo-only media consent on file.', code: 'GUARDIAN_CONSENT_EXCLUDES_VIDEO' }),
    }) as Response,
  }) as unknown as typeof fetch;

  render(<ParentVideoPage />);

  fireEvent.click(await screen.findByRole('button', { name: 'Play' }));

  await screen.findByText('Blocked: photo-only media consent on file.');
  expect(screen.queryByText('Coach notes')).toBeNull();
});

test('a failed linked-athlete read never says the account is not linked', async () => {
  global.fetch = mockFetch({
    '/athletes/list': () => ({ ok: false, status: 500, json: async () => ({}) }) as Response,
  }) as unknown as typeof fetch;

  render(<ParentVideoPage />);

  await screen.findByText('Could not load your linked athletes');
  expect(screen.queryByText('No linked athletes')).toBeNull();
});

describe('the family picker (FAM-11) and the one back link (FAM-18)', () => {
  const listReads = (fetchMock: jest.Mock) =>
    fetchMock.mock.calls.map(([input]) => String(input)).filter((url) => url.includes('/api/pilot/video/list'));

  test('two children and none remembered: it asks, reads no film, and never says "No film yet"', async () => {
    const fetchMock = mockFetch({ '/athletes/list': () => jsonOk({ items: [CHILD, SECOND_CHILD] }) });
    global.fetch = fetchMock as unknown as typeof fetch;

    render(<ParentVideoPage />);

    await screen.findByText('Choose a child');
    expect(screen.getByRole('group', { name: 'Which child' })).toBeTruthy();
    expect(listReads(fetchMock)).toEqual([]);
    expect(screen.queryByText('No film yet. It shows up here when a coach puts some up.')).toBeNull();
    expect(screen.queryByText('Rounds')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Riley Doe' }));
    await screen.findByText("Riley Doe's Film");
    expect(listReads(fetchMock)).toEqual([expect.stringContaining('athlete_id=athlete-002')]);
    expect(screen.queryByText('Choose a child')).toBeNull();
    // The pick is the child the next family page opens on.
    expect(window.sessionStorage.getItem('ppbf.parent.chosenChild')).toBe('athlete-002');
  });

  test('the remembered child opens, among two', async () => {
    window.sessionStorage.setItem('ppbf.parent.chosenChild', 'athlete-002');
    const fetchMock = mockFetch({ '/athletes/list': () => jsonOk({ items: [CHILD, SECOND_CHILD] }) });
    global.fetch = fetchMock as unknown as typeof fetch;

    render(<ParentVideoPage />);

    await screen.findByText("Riley Doe's Film");
    expect(screen.getByRole('button', { name: 'Riley Doe' }).getAttribute('aria-pressed')).toBe('true');
    expect(listReads(fetchMock)).toEqual([expect.stringContaining('athlete_id=athlete-002')]);
  });

  test('a one-child family is shown no picker and goes straight to the film', async () => {
    const fetchMock = mockFetch();
    global.fetch = fetchMock as unknown as typeof fetch;

    render(<ParentVideoPage />);

    await screen.findByText("Jordan Doe's Film");
    expect(screen.queryByRole('group', { name: 'Which child' })).toBeNull();
    expect(screen.queryByText('Choose a child')).toBeNull();
  });

  test('the back link is the shared one, not "Back to your dashboard"', async () => {
    global.fetch = mockFetch() as unknown as typeof fetch;

    render(<ParentVideoPage />);

    await screen.findByText("Jordan Doe's Film");
    expect(screen.queryByText('Back to your dashboard')).toBeNull();
    // No session is cached in this test, so BackHome names no role's home.
    expect(screen.getByRole('link', { name: 'Back to your home page' }).getAttribute('href')).toBe('/dashboard');
  });
});

/* Between the pick and the read starting there is one render with the child
   chosen and nothing loaded. It must say Loading, never "No film yet": nobody
   has read that child's film. React replaces that line before a test can look
   at the page, so this watches what was taken OFF the page: a removed node
   keeps its text, and so does a text node's old value. */
test('picking a child never draws "No film yet" before that child\'s film is read', async () => {
  let answerList: (value: Response) => void = () => {};
  const fetchMock = mockFetch({
    '/athletes/list': () => jsonOk({ items: [CHILD, SECOND_CHILD] }),
    '/api/pilot/video/list': () => new Promise<Response>((resolve) => { answerList = resolve; }),
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  render(<ParentVideoPage />);
  await screen.findByText('Choose a child');

  const takenOff: string[] = [];
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of Array.from(record.removedNodes)) takenOff.push(node.textContent ?? '');
      if (record.oldValue) takenOff.push(record.oldValue);
    }
  });
  observer.observe(document.body, { childList: true, subtree: true, characterData: true, characterDataOldValue: true });

  fireEvent.click(screen.getByRole('button', { name: 'Riley Doe' }));
  await screen.findByText('Loading film...');
  await act(async () => { answerList(jsonOk({ items: [] })); });
  await screen.findByText('No film yet. It shows up here when a coach puts some up.');
  await act(async () => {});
  observer.disconnect();

  // The observer works: it saw the Loading line leave when the answer came.
  expect(takenOff.some((text) => text.includes('Loading film...'))).toBe(true);
  // "No film yet" was drawn once, after the answer, and never taken back.
  expect(takenOff.some((text) => text.includes('No film yet'))).toBe(false);
});
