/**
 * @jest-environment jsdom
 */

// CUT A STUDY CLIP -- the step the teaching loop was missing.
//
// What this suite pins is the shape of the act: a clip cannot be cut without a
// study, footage, a span that is actually a span, and a code two annotators can
// say out loud. And that the footage is fetched from TEACHING's playback door,
// never the Film Study route -- which is the contradiction that made the whole
// calibration lab unusable and is the reason this page exists.

import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';

import CutStudyClipPage from './page';

jest.mock('@/components/RoleSessionGate', () => ({
  __esModule: true,
  default: ({ children }: { readonly children: ReactNode }) => children,
}));

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ children, href }: { readonly children: ReactNode; readonly href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

const RELEASED_URL = '/api/pilot/teach-shadow/released';
const PROJECTS_URL = '/api/pilot/calibration/projects';
const CLIPS_URL = '/api/pilot/calibration/clips';
const STREAM_URL = (id: string) => `/api/pilot/teach-shadow/footage/${id}/stream`;

/*
 * A catch-all fetch mock that answers ok:true to anything is a known hazard in
 * this repo: a fetch added later is never exercised and the suite still reports
 * green. Worse here, because this page turns every read error into the alert,
 * so an unrecognised URL would masquerade as the error state. So: record it and
 * fail the test on the record.
 */
const unexpectedRequests: string[] = [];

const FOOTAGE_LIVE = {
  video_session_id: 'vs-live',
  file_name: 'take-2-front.webm',
  take_number: 2,
  camera_view: 'front',
  created_at: '2026-01-01T00:00:00.000Z',
  status: 'ready',
  clips_cut: 3,
  clips_labelled: 1,
  archived: false,
};

const FOOTAGE_ARCHIVED = {
  ...FOOTAGE_LIVE,
  video_session_id: 'vs-gone',
  file_name: 'take-9-desk.webm',
  take_number: 9,
  status: 'archived',
  archived: true,
};

const PROJECT = {
  calibration_project_id: 'proj-1',
  name: 'Calibration round 1',
  ontology_version: 'boxing-ontology-0.1',
  status: 'draft',
};

function jsonResponse(body: unknown, ok = true) {
  return { ok, json: async () => body } as Response;
}

function mockFetch(overrides: {
  released?: () => Response;
  projects?: () => Response;
  stream?: () => Response;
  clips?: () => Response;
} = {}) {
  const mock = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const requested = String(input);
    void init;
    if (requested === RELEASED_URL) {
      return (overrides.released ?? (() => jsonResponse({ ok: true, items: [FOOTAGE_LIVE] })))();
    }
    if (requested === PROJECTS_URL && init?.method !== 'POST') {
      return (overrides.projects ?? (() => jsonResponse({
        ok: true, projects: [PROJECT], supported_ontology_version: 'boxing-ontology-0.1',
      })))();
    }
    if (requested === PROJECTS_URL) {
      return jsonResponse({ ok: true, project: { ...PROJECT, calibration_project_id: 'proj-new' } });
    }
    if (requested === STREAM_URL('vs-live')) {
      return (overrides.stream ?? (() => jsonResponse({
        ok: true, stream_url: 'https://blob.example/take.webm?sas',
      })))();
    }
    if (requested === CLIPS_URL) {
      return (overrides.clips ?? (() => jsonResponse({ ok: true, clip: { clip_code: 'C-01' } })))();
    }
    unexpectedRequests.push(requested);
    throw new Error(`Unexpected fetch: ${requested}`);
  });
  global.fetch = mock as unknown as typeof fetch;
  return mock;
}

function requestedUrls(mock: ReturnType<typeof mockFetch>): string[] {
  return mock.mock.calls.map(([input]) => String(input));
}

const originalFetch = global.fetch;

afterEach(() => {
  expect(unexpectedRequests).toEqual([]);
  unexpectedRequests.length = 0;
  global.fetch = originalFetch;
  jest.clearAllMocks();
});

/** Open the take, then mark a usable span and name the clip. */
async function prepareCut(fetchMock: ReturnType<typeof mockFetch>) {
  fireEvent.click(await screen.findByRole('button', { name: 'Open this take' }));
  await waitFor(() => { expect(requestedUrls(fetchMock)).toContain(STREAM_URL('vs-live')); });

  const player = await screen.findByTestId('cutter-player');
  // jsdom has no media pipeline, so currentTime is driven directly -- the page
  // reads it from the event target, which is what a real timeupdate carries.
  fireEvent.timeUpdate(player, { target: { currentTime: 1.5 } });
  fireEvent.click(screen.getByRole('button', { name: 'Mark start here' }));
  fireEvent.timeUpdate(player, { target: { currentTime: 7 } });
  fireEvent.click(screen.getByRole('button', { name: 'Mark end here' }));

  fireEvent.change(screen.getByLabelText(/clip code/i), { target: { value: 'C-01' } });
  fireEvent.change(screen.getByLabelText(/^study$/i), { target: { value: 'proj-1' } });
}

test('the footage plays through teaching\'s own door, never the Film Study route', async () => {
  /*
   * THE WHOLE REASON THIS PAGE EXISTS. Only take-backed footage may be cut, and
   * /api/pilot/video/[videoId] refuses take-backed footage -- so a cutter that
   * reached for the Film Study route would be broken on arrival, exactly as the
   * annotation page was for four days.
   */
  const fetchMock = mockFetch();
  render(<CutStudyClipPage />);

  fireEvent.click(await screen.findByRole('button', { name: 'Open this take' }));

  await waitFor(() => { expect(requestedUrls(fetchMock)).toContain(STREAM_URL('vs-live')); });
  expect(requestedUrls(fetchMock).some((url) => url.startsWith('/api/pilot/video/'))).toBe(false);
});

test('archived footage is not offered, because it can only be refused', async () => {
  mockFetch({ released: () => jsonResponse({ ok: true, items: [FOOTAGE_LIVE, FOOTAGE_ARCHIVED] }) });
  render(<CutStudyClipPage />);

  await screen.findByText('take-2-front.webm');
  expect(screen.queryByText('take-9-desk.webm')).not.toBeInTheDocument();
});

test('a clip cannot be cut until the study, the footage, the span and the code are all there', async () => {
  const fetchMock = mockFetch();
  render(<CutStudyClipPage />);

  await screen.findByText('take-2-front.webm');
  // No footage open yet, so the marking step is not even on screen.
  expect(screen.queryByRole('button', { name: 'Cut this clip' })).not.toBeInTheDocument();

  await prepareCut(fetchMock);
  expect(screen.getByRole('button', { name: 'Cut this clip' })).toBeEnabled();
});

test('an end before the start is refused in words, not by a dead button', async () => {
  // A Cut button that is simply inert tells somebody nothing about why.
  const fetchMock = mockFetch();
  render(<CutStudyClipPage />);

  await screen.findByText('take-2-front.webm');
  fireEvent.click(screen.getByRole('button', { name: 'Open this take' }));
  const player = await screen.findByTestId('cutter-player');

  fireEvent.timeUpdate(player, { target: { currentTime: 9 } });
  fireEvent.click(screen.getByRole('button', { name: 'Mark start here' }));
  fireEvent.timeUpdate(player, { target: { currentTime: 2 } });
  fireEvent.click(screen.getByRole('button', { name: 'Mark end here' }));

  expect(screen.getByText(/end must come after the start/i)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Cut this clip' })).toBeDisabled();
  expect(requestedUrls(fetchMock)).not.toContain(CLIPS_URL);
});

test('cutting sends the span in milliseconds and the reason from the vocabulary', async () => {
  const fetchMock = mockFetch();
  render(<CutStudyClipPage />);

  await screen.findByText('take-2-front.webm');
  await prepareCut(fetchMock);
  fireEvent.click(screen.getByRole('button', { name: 'Cut this clip' }));

  await waitFor(() => { expect(requestedUrls(fetchMock)).toContain(CLIPS_URL); });

  const call = fetchMock.mock.calls.find(([input]) => String(input) === CLIPS_URL);
  const body = JSON.parse(String(call?.[1]?.body));
  expect(body).toMatchObject({
    calibration_project_id: 'proj-1',
    video_session_id: 'vs-live',
    clip_code: 'C-01',
    start_ms: 1_500,
    end_ms: 7_000,
  });
  // Whatever the first vocabulary term is, it is a term and not free text.
  expect(typeof body.primary_sampling_reason).toBe('string');
  expect(body.primary_sampling_reason.length).toBeGreaterThan(0);
});

test('after a cut the take and the study stay open, and the span and code clear', async () => {
  // The next clip is nearly always from the same take, so re-picking both
  // every time would be the page fighting the work.
  const fetchMock = mockFetch();
  render(<CutStudyClipPage />);

  await screen.findByText('take-2-front.webm');
  await prepareCut(fetchMock);
  fireEvent.click(screen.getByRole('button', { name: 'Cut this clip' }));

  expect(await screen.findByRole('status')).toHaveTextContent(/cut/i);
  expect(screen.getByLabelText(/clip code/i)).toHaveValue('');
  expect(screen.getByText(/Start not marked\./)).toBeInTheDocument();
  expect(screen.getByTestId('cutter-player')).toBeInTheDocument();
});

test('a refused cut shows the server\'s own reason', async () => {
  const fetchMock = mockFetch({
    clips: () => jsonResponse({ error: 'This study already has a clip called "C-01". Pick another code.' }, false),
  });
  render(<CutStudyClipPage />);

  await screen.findByText('take-2-front.webm');
  await prepareCut(fetchMock);
  fireEvent.click(screen.getByRole('button', { name: 'Cut this clip' }));

  expect(await screen.findByRole('alert')).toHaveTextContent(/already has a clip called/i);
});

test('a failed read is an alert, not a gym that has filmed nothing', async () => {
  // Falling back to an empty list would make a specific and wrong claim about
  // somebody's work -- the same rule the coverage read holds.
  mockFetch({ released: () => jsonResponse({ error: 'Released footage could not be read.' }, false) });
  render(<CutStudyClipPage />);

  expect(await screen.findByRole('alert')).toHaveTextContent('Released footage could not be read.');
  expect(screen.queryByText(/Nothing to cut yet/)).not.toBeInTheDocument();
});

test('no athlete name reaches the footage picker', async () => {
  /*
   * Teaching media names nobody, so footage is identified by take, view and
   * file. Scoped to the LIST rather than the whole page on purpose: the page's
   * own opening paragraph says "nothing here scores an athlete", which is the
   * sentence a coach needs to read and not a name leaking out. A test that
   * failed on it would punish saying the true thing.
   */
  mockFetch({ released: () => jsonResponse({ ok: true, items: [FOOTAGE_LIVE] }) });
  render(<CutStudyClipPage />);

  const row = (await screen.findByText('take-2-front.webm')).closest('li');
  expect(row).not.toBeNull();
  expect(row!.textContent?.toLowerCase()).not.toContain('athlete');
});
