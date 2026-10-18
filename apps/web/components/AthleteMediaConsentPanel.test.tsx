/**
 * @jest-environment jsdom
 */

import '@testing-library/jest-dom';
import { act, fireEvent, render, screen } from '@testing-library/react';

import AthleteMediaConsentPanel from './AthleteMediaConsentPanel';

// The adult athlete's own photo and video consent (OD-2026-10-08-015).

interface View {
  is_adult: boolean;
  consent: { status: string; covers_video: boolean; public_use_allowed: boolean; recorded_at: string } | null;
  counts_for_new_publication: boolean;
  retracted_publication_ids?: string[];
}

const TOGGLE = 'Photos and video of me';
const NONE: View = { is_adult: true, consent: null, counts_for_new_publication: false };
const MINOR: View = { is_adult: false, consent: null, counts_for_new_publication: false };
const VIDEO_GYM: View = {
  is_adult: true,
  consent: { status: 'signed', covers_video: true, public_use_allowed: false, recorded_at: '2026-10-01T00:00:00Z' },
  counts_for_new_publication: true,
};
const PHOTO_PUBLIC: View = {
  is_adult: true,
  consent: { status: 'signed', covers_video: false, public_use_allowed: true, recorded_at: '2026-10-01T00:00:00Z' },
  counts_for_new_publication: false,
};
const WITHDRAWN: View = {
  is_adult: true,
  consent: { status: 'withdrawn', covers_video: false, public_use_allowed: false, recorded_at: '2026-10-01T00:00:00Z' },
  counts_for_new_publication: false,
};

function respond(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: async () => body } as unknown as Response;
}

function installFetch(initial: View, afterPost: (body: Record<string, unknown>) => Response | Promise<Response>): jest.Mock {
  let current = initial;
  const fetchMock = jest.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      const response = await afterPost(JSON.parse(String(init.body)));
      return response;
    }
    return respond(current);
  });
  (fetchMock as unknown as { setCurrent: (v: View) => void }).setCurrent = (v: View) => { current = v; };
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

function posted(fetchMock: jest.Mock): Array<Record<string, unknown>> {
  return fetchMock.mock.calls
    .filter(([, init]) => (init as RequestInit | undefined)?.method === 'POST')
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>);
}

async function renderPanel(openIt = true) {
  await act(async () => { render(<AthleteMediaConsentPanel />); });
  if (openIt) {
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: TOGGLE })); });
  }
}

afterEach(() => jest.restoreAllMocks());

test('closed by default, and nothing is read until it is tapped; closing it takes the answer off the screen', async () => {
  const fetchMock = installFetch(VIDEO_GYM, () => respond(VIDEO_GYM));
  await renderPanel(false);
  expect(screen.getByRole('button', { name: TOGGLE })).toHaveAttribute('aria-expanded', 'false');
  expect(fetchMock).not.toHaveBeenCalled();

  await act(async () => { fireEvent.click(screen.getByRole('button', { name: TOGGLE })); });
  expect(fetchMock).toHaveBeenCalledWith(expect.stringMatching(/\/api\/pilot\/athlete\/media-consent$/), expect.anything());
  expect(await screen.findByText(/You said yes to photos and video, for use inside the gym only/)).toBeInTheDocument();

  await act(async () => { fireEvent.click(screen.getByRole('button', { name: TOGGLE })); });
  expect(screen.queryByText(/You said yes/)).toBeNull();
});

test('a minor is told their guardian decides until 18, and is offered nothing to press', async () => {
  installFetch(MINOR, () => respond(MINOR));
  await renderPanel();
  expect(screen.getByText(/Until you are 18, your guardian decides/)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Save my answer' })).toBeNull();
  expect(screen.queryByRole('radio')).toBeNull();
});

test.each([
  ['no decision yet', NONE, /You haven't decided yet. Until you do, no new video of you is published/],
  ['photos only', PHOTO_PUBLIC, /You said yes to photos only/],
  ['withdrawn', WITHDRAWN, /You said no/],
])('an adult with %s sees it plainly', async (_label, view, words) => {
  installFetch(view, () => respond(view));
  await renderPanel();
  expect(screen.getByTestId('media-consent-current')).toHaveTextContent(words);
});

test('the choices start at the answer on file, so saving untouched sends the same answer', async () => {
  const fetchMock = installFetch(PHOTO_PUBLIC, () => respond({ ...PHOTO_PUBLIC, ok: true }));
  await renderPanel();
  expect(screen.getByRole('radio', { name: 'Photos only' })).toBeChecked();
  expect(screen.getByRole('checkbox', { name: /Also outside the gym/ })).toBeChecked();

  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save my answer' })); });
  expect(posted(fetchMock)).toEqual([{ decision: 'grant', covers_video: false, public_use_allowed: true }]);
});

test.each([
  ['no answer on file', NONE],
  ['a no on file', WITHDRAWN],
])('with %s nothing is chosen and Save waits for a choice, so one tap cannot send a yes', async (_label, view) => {
  const fetchMock = installFetch(view, () => respond({ ...VIDEO_GYM, ok: true }));
  await renderPanel();
  expect(screen.getByRole('radio', { name: 'Photos and video' })).not.toBeChecked();
  expect(screen.getByRole('radio', { name: 'Photos only' })).not.toBeChecked();
  expect(screen.getByRole('checkbox', { name: /Also outside the gym/ })).not.toBeChecked();
  expect(screen.getByRole('button', { name: 'Save my answer' })).toBeDisabled();
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save my answer' })); });
  expect(posted(fetchMock)).toEqual([]);
});

test('after saying no, the earlier yes is not left selected', async () => {
  installFetch(PHOTO_PUBLIC, () => respond({ ...WITHDRAWN, ok: true }));
  await renderPanel();
  expect(screen.getByRole('radio', { name: 'Photos only' })).toBeChecked();
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Say no to all photos and video' })); });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Say no and take them down' })); });
  expect(screen.getByRole('radio', { name: 'Photos only' })).not.toBeChecked();
  expect(screen.getByRole('checkbox', { name: /Also outside the gym/ })).not.toBeChecked();
  expect(screen.getByRole('button', { name: 'Save my answer' })).toBeDisabled();
});

test('each choice is a full gym-floor tap target', async () => {
  installFetch(NONE, () => respond(NONE));
  await renderPanel();
  for (const name of ['Photos and video', 'Photos only', /Also outside the gym/]) {
    const control = screen.getByRole(name === 'Photos and video' || name === 'Photos only' ? 'radio' : 'checkbox', { name });
    expect(control.closest('label')).toHaveClass('min-h-[var(--tap)]');
  }
});

test('a failed read after a failed save takes the old answer off the screen', async () => {
  let reads = 0;
  global.fetch = jest.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'POST') return respond({ ok: false }, 500);
    reads += 1;
    return reads === 1 ? respond(VIDEO_GYM) : respond({}, 500);
  }) as unknown as typeof fetch;
  await renderPanel();
  expect(screen.getByTestId('media-consent-current')).toHaveTextContent(/photos and video/);
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save my answer' })); });
  expect(screen.queryByTestId('media-consent-current')).toBeNull();
  expect(screen.getByText("That didn't load.")).toBeInTheDocument();
  expect(screen.getByText(/We couldn't confirm that was saved/)).toBeInTheDocument();
});

test('a reply that lands after the panel was closed is not kept or shown', async () => {
  let release!: (r: Response) => void;
  global.fetch = jest.fn(() => new Promise<Response>((resolve) => { release = resolve; })) as unknown as typeof fetch;
  await renderPanel();
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: TOGGLE })); });
  await act(async () => { release(respond(VIDEO_GYM)); });
  expect(screen.queryByText(/You said yes/)).toBeNull();
});

test('saying yes to photos and video sends that, and says it saved', async () => {
  const fetchMock = installFetch(NONE, () => respond({ ...VIDEO_GYM, ok: true }));
  await renderPanel();
  await act(async () => { fireEvent.click(screen.getByRole('radio', { name: 'Photos and video' })); });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save my answer' })); });
  expect(posted(fetchMock)).toEqual([{ decision: 'grant', covers_video: true, public_use_allowed: false }]);
  expect(screen.getByRole('status')).toHaveTextContent('Saved.');
  expect(screen.getByTestId('media-consent-current')).toHaveTextContent(/photos and video/);
});

test('photos only warns that published video comes down, and reports how many did', async () => {
  installFetch(VIDEO_GYM, () => respond({ ...PHOTO_PUBLIC, ok: true, retracted_publication_ids: ['p1', 'p2'] }));
  await renderPanel();
  await act(async () => { fireEvent.click(screen.getByRole('radio', { name: 'Photos only' })); });
  expect(screen.getByText(/Photos only takes down any video of you that is already published/)).toBeInTheDocument();
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save my answer' })); });
  expect(screen.getByRole('status')).toHaveTextContent('Saved. 2 published videos were taken down.');
});

test('saying no takes one confirm, and only the confirm sends it', async () => {
  const fetchMock = installFetch(VIDEO_GYM, () => respond({ ...WITHDRAWN, ok: true, retracted_publication_ids: ['p1'] }));
  await renderPanel();
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Say no to all photos and video' })); });
  expect(posted(fetchMock)).toEqual([]);
  expect(screen.getByText(/Saying no takes down your published videos/)).toBeInTheDocument();

  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Keep my answer' })); });
  expect(posted(fetchMock)).toEqual([]);

  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Say no to all photos and video' })); });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Say no and take them down' })); });
  expect(posted(fetchMock)).toEqual([{ decision: 'withdraw' }]);
  expect(screen.getByRole('status')).toHaveTextContent('Saved. 1 published video was taken down.');
  expect(screen.queryByRole('button', { name: 'Say no to all photos and video' })).toBeNull();
});

test('a refusal says nothing was saved, in plain words, and reads again', async () => {
  const fetchMock = installFetch(VIDEO_GYM, () => respond({ error: 'x', code: 'ATHLETE_NOT_ADULT' }, 403));
  await renderPanel();
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save my answer' })); });
  expect(screen.getByRole('alert')).toHaveTextContent('Until you are 18, your guardian decides this. Nothing was saved.');
  expect(fetchMock.mock.calls.filter(([, init]) => !(init as RequestInit | undefined)?.method).length).toBe(2);
});

test('a server failure or a lost reply never claims it was not saved, and reads again', async () => {
  const fetchMock = installFetch(VIDEO_GYM, () => respond({ ok: false, error: 'boom' }, 500));
  await renderPanel();
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save my answer' })); });
  expect(screen.getByRole('alert')).toHaveTextContent("We couldn't confirm that was saved.");
  expect(screen.getByRole('alert')).not.toHaveTextContent(/not saved/);
  expect(fetchMock.mock.calls.filter(([, init]) => !(init as RequestInit | undefined)?.method).length).toBe(2);
});

test('a read that fails says so and can be tried again', async () => {
  let reads = 0;
  global.fetch = jest.fn(async () => {
    reads += 1;
    return reads === 1 ? respond({}, 500) : respond(NONE);
  }) as unknown as typeof fetch;
  await renderPanel();
  expect(screen.getByRole('alert')).toHaveTextContent("That didn't load.");
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Try again' })); });
  expect(screen.getByTestId('media-consent-current')).toHaveTextContent(/You haven't decided yet/);
});
