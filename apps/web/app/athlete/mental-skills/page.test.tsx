/**
 * @jest-environment jsdom
 */

/*
 * The athlete's mental skills page. What is worth a test:
 *   1. self only: no request this page makes names an athlete, so it cannot
 *      be aimed at anyone else's entries.
 *   2. nothing is computed: no total minutes, streak or target on screen.
 *   3. a failed read never reads as "nothing logged".
 *   4. the forms send exactly what the route expects, and only the approved
 *      content key.
 */

import { act, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';

import AthleteMentalSkillsPage from './page';

jest.mock('@/components/RoleStandaloneView', () => ({
  __esModule: true,
  default: ({ children }: { readonly children: ReactNode }) => <div>{children}</div>,
}));
jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ children, href }: { readonly children: ReactNode; readonly href: string }) => <a href={href}>{children}</a>,
}));

interface Stubs {
  entriesOk?: boolean;
  refetchOk?: boolean;
  postDelay?: Promise<void>;
  blocksOk?: boolean;
  postStatus?: number;
  postError?: string;
}

const entries = {
  current_cue: { entry_id: 'e-cue', cue_text: 'hands home', cue_kind: 'instructional', logged_on: '2026-10-03' },
  imagery_sessions: [
    { entry_id: 'e-1', minutes: 7, content_key: 'imagery-rehearsal', logged_on: '2026-10-03' },
    { entry_id: 'e-2', minutes: 4, content_key: null, logged_on: '2026-10-01' },
  ],
};

const afterSave = {
  current_cue: { entry_id: 'e-cue-2', cue_text: 'keep working', cue_kind: 'motivational', logged_on: '2026-10-04' },
  imagery_sessions: [{ entry_id: 'e-3', minutes: 6, content_key: 'imagery-rehearsal', logged_on: '2026-10-04' }, ...entries.imagery_sessions],
};

const blocks = [
  {
    block_id: 'b-1',
    status: 'active',
    objectives: [
      { objective_id: 'o-1', domain: 'mental', objective: 'Breathe out on every exit from the pocket.', status: 'active' },
      { objective_id: 'o-2', domain: 'technical', objective: 'Jab off the back foot.', status: 'active' },
      { objective_id: 'o-3', domain: 'mental', objective: 'Dropped mental goal.', status: 'cancelled' },
      { objective_id: 'o-4', domain: 'mental', objective: 'Draft mental goal.', status: 'draft' },
      { objective_id: 'o-5', domain: 'mental', objective: 'Finished mental goal.', status: 'completed' },
    ],
  },
  {
    block_id: 'b-2',
    status: 'cancelled',
    objectives: [{ objective_id: 'o-6', domain: 'mental', objective: 'Goal in a cancelled block.', status: 'active' }],
  },
];

function installFetch(stubs: Stubs = {}): jest.Mock {
  let saved = false;
  const fetchMock = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/api/pilot/athlete/mental-skills') && init?.method === 'POST') {
      if (stubs.postDelay) await stubs.postDelay;
      const status = stubs.postStatus ?? 201;
      if (status < 300) saved = true;
      return { ok: status < 300, status, json: async () => (status < 300 ? {} : { error: stubs.postError }) } as Response;
    }
    if (url.includes('/api/pilot/athlete/mental-skills')) {
      const ok = saved ? (stubs.refetchOk ?? true) : (stubs.entriesOk ?? true);
      return { ok, status: ok ? 200 : 503, json: async () => (saved ? afterSave : entries) } as Response;
    }
    if (url.includes('/api/pilot/athlete/development-blocks')) {
      const ok = stubs.blocksOk ?? true;
      return { ok, status: ok ? 200 : 503, json: async () => ({ blocks }) } as Response;
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

async function renderPage(stubs: Stubs = {}) {
  const fetchMock = installFetch(stubs);
  await act(async () => {
    render(<AthleteMentalSkillsPage />);
  });
  return fetchMock;
}

afterEach(() => jest.restoreAllMocks());

test('self only: no request names an athlete, before or after a write', async () => {
  const fetchMock = await renderPage();
  fireEvent.change(screen.getByLabelText('Minutes'), { target: { value: '5' } });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Log session' }));
  });
  expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(4);
  for (const [input, init] of fetchMock.mock.calls) {
    expect(String(input)).not.toMatch(/athlete_id/);
    expect(String((init as RequestInit | undefined)?.body ?? '')).not.toMatch(/athlete_id/);
  }
});

test('shows the current cue with both kind names, each session as logged, and only active goals in active blocks', async () => {
  await renderPage();
  expect(screen.getByText('hands home')).toBeTruthy();
  expect(screen.getByText(/Technique \(instructional\) · set/)).toBeTruthy();
  expect(screen.getByText(/7 min/)).toBeTruthy();
  expect(screen.getByText(/4 min/)).toBeTruthy();
  expect(screen.getByText('Breathe out on every exit from the pocket.')).toBeTruthy();
  expect(screen.queryByText('Jab off the back foot.')).toBeNull();
  for (const hidden of ['Dropped mental goal.', 'Draft mental goal.', 'Finished mental goal.', 'Goal in a cancelled block.']) {
    expect(screen.queryByText(hidden)).toBeNull();
  }
});

test('nothing is computed: no total, streak or target', async () => {
  await renderPage();
  const text = document.body.textContent ?? '';
  expect(text).not.toMatch(/11 min|total|streak|per week|a week|target|score|\d+\s*sessions/i);
});

test('a failed read is not shown as nothing logged', async () => {
  await renderPage({ entriesOk: false, blocksOk: false });
  expect(screen.getAllByRole('alert')).toHaveLength(2);
  expect(screen.queryByText('No imagery sessions logged yet.')).toBeNull();
  expect(screen.queryByText(/No mental goals/)).toBeNull();
});

test('saving a cue sends the text and kind, then reloads', async () => {
  const fetchMock = await renderPage();
  fireEvent.change(screen.getByLabelText('Your cue, in your own words'), { target: { value: 'keep working' } });
  fireEvent.click(screen.getByLabelText('Effort (motivational)'));
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Save cue' }));
  });
  const post = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === 'POST');
  expect(JSON.parse(String((post?.[1] as RequestInit).body))).toEqual({
    kind: 'self_talk_cue', cue_text: 'keep working', cue_kind: 'motivational',
  });
  expect(screen.getByRole('status').textContent).toBe('Cue saved.');
  // The list was reloaded: the new cue is on screen.
  expect(screen.getByText('keep working', { selector: 'p' })).toBeTruthy();
});

test('a failed reload after a save keeps the list on screen and says so', async () => {
  await renderPage({ refetchOk: false });
  fireEvent.change(screen.getByLabelText('Minutes'), { target: { value: '5' } });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Log session' }));
  });
  expect(screen.getByRole('status').textContent).toMatch(/^Session logged\. The list could not refresh/);
  expect(screen.getByText('hands home')).toBeTruthy();
  expect(screen.queryByRole('alert')).toBeNull();
});

test('a double tap sends one write', async () => {
  let release: () => void = () => {};
  const postDelay = new Promise<void>((resolve) => { release = resolve; });
  const fetchMock = await renderPage({ postDelay });
  fireEvent.change(screen.getByLabelText('Minutes'), { target: { value: '5' } });
  const button = screen.getByRole('button', { name: 'Log session' });
  await act(async () => {
    fireEvent.click(button);
    fireEvent.click(button);
  });
  await act(async () => {
    release();
  });
  expect(fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'POST')).toHaveLength(1);
});

test('a cue without a kind is not sent', async () => {
  const fetchMock = await renderPage();
  fireEvent.change(screen.getByLabelText('Your cue, in your own words'), { target: { value: 'keep working' } });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Save cue' }));
  });
  expect(fetchMock.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === 'POST')).toBe(false);
});

test('logging a session sends whole minutes and the approved content key; bad minutes are not sent', async () => {
  const fetchMock = await renderPage();
  fireEvent.change(screen.getByLabelText('Minutes'), { target: { value: '61' } });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Log session' }));
  });
  expect(fetchMock.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === 'POST')).toBe(false);

  fireEvent.change(screen.getByLabelText('Minutes'), { target: { value: '6' } });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Log session' }));
  });
  const post = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === 'POST');
  expect(JSON.parse(String((post?.[1] as RequestInit).body))).toEqual({
    kind: 'imagery_session', minutes: 6, content_key: 'imagery-rehearsal',
  });
});

test('a validation refusal shows its reason; any other failure is generic', async () => {
  await renderPage({ postStatus: 400, postError: 'No more than 20 mental skills entries a day.' });
  fireEvent.change(screen.getByLabelText('Minutes'), { target: { value: '5' } });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Log session' }));
  });
  expect(screen.getByRole('status').textContent).toBe('No more than 20 mental skills entries a day.');
});

test('a server failure does not leak its message', async () => {
  await renderPage({ postStatus: 403, postError: 'Forbidden: internal detail' });
  fireEvent.change(screen.getByLabelText('Minutes'), { target: { value: '5' } });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Log session' }));
  });
  expect(screen.getByRole('status').textContent).toBe('That did not save. Try again.');
});

test('the approved imagery steps are on screen, in order', async () => {
  await renderPage();
  const items = screen.getAllByRole('listitem').map((li) => li.textContent);
  const first = items.indexOf('Pick ONE technique and say its name out loud (e.g. "jab").');
  expect(first).toBeGreaterThan(-1);
  expect(items[first + 4]).toBe('Throw it once for real at working pace. Nothing else.');
});

describe('remove (OD-2026-10-04-023)', () => {
  test('each own entry has a Remove button; confirming sends only the entry id, never an athlete', async () => {
    const fetchMock = await renderPage();
    jest.spyOn(window, 'confirm').mockReturnValue(true);
    expect(screen.getByRole('button', { name: 'Remove this cue' })).toBeTruthy();
    const sessionButtons = screen.getAllByRole('button', { name: /^Remove the \d+ min session from / });
    expect(sessionButtons).toHaveLength(2);

    await act(async () => {
      fireEvent.click(sessionButtons[1]);
    });
    const posts = fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST');
    expect(posts).toHaveLength(1);
    expect(JSON.parse(String(posts[0][1].body))).toEqual({ action: 'remove', entry_id: 'e-2' });
    expect(String(posts[0][0])).not.toMatch(/athlete_id/);
    expect(screen.getByRole('status').textContent).toBe('Entry removed.');
  });

  test('cancelling the confirm sends nothing', async () => {
    const fetchMock = await renderPage();
    jest.spyOn(window, 'confirm').mockReturnValue(false);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Remove this cue' }));
    });
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0);
  });

  test('a refused remove says so and does not claim it was removed', async () => {
    await renderPage({ postStatus: 404, postError: 'That entry was not found.' });
    jest.spyOn(window, 'confirm').mockReturnValue(true);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Remove this cue' }));
    });
    expect(screen.getByRole('status').textContent).not.toMatch(/removed/i);
  });
});
