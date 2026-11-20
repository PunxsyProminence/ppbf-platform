// The one start helper (lane U2-6a): exactly one POST per start, the body the
// route expects, and every answer said back as a kind a screen can word.

import { startClassSession, startRefusalWords } from './startClassSession';

jest.mock('@/lib/apiBase', () => ({ apiBase: () => '' }));

const RUN = { run_id: 'ssrun_1', run_state: 'in_progress' };

function respond(...answers: Array<{ ok: boolean; body?: unknown } | Error>) {
  // The arguments are named so the calls are typed (the body reads none of them).
  const fetchMock = jest.fn(async (_input?: RequestInfo | URL, _init?: RequestInit) => {
    void _input;
    void _init;
    const answer = answers.shift();
    if (!answer) throw new Error('unexpected fetch');
    if (answer instanceof Error) throw answer;
    return { ok: answer.ok, json: async () => answer.body } as Response;
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

test('a plain start tied to a class sends one POST with class_id only, and returns the run', async () => {
  const fetchMock = respond({ ok: true, body: { run: RUN } });
  await expect(startClassSession({ scriptId: null, classId: 'cls-1' })).resolves.toEqual({ kind: 'started', run: RUN });
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe('/api/pilot/session-scripts/runs');
  expect(init.method).toBe('POST');
  expect(JSON.parse(String(init.body))).toEqual({ class_id: 'cls-1' });
});

test('a plan started as open gym sends script_id only', async () => {
  const fetchMock = respond({ ok: true, body: { run: RUN } });
  await startClassSession({ scriptId: 'scr-1', classId: null });
  expect(JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body))).toEqual({ script_id: 'scr-1' });
});

test('already live: the running session is read and returned, never a second start', async () => {
  const fetchMock = respond({ ok: false, body: { error: 'SESSION_RUN_ALREADY_LIVE' } }, { ok: true, body: { run: RUN } });
  await expect(startClassSession({ scriptId: null, classId: null })).resolves.toEqual({ kind: 'already_live', run: RUN });
  expect(fetchMock.mock.calls.map(([, init]) => (init as RequestInit | undefined)?.method)).toEqual(['POST', 'GET']);
});

test('already live but unreadable: says so, and Session Plans words it as before', async () => {
  respond({ ok: false, body: { error: 'SESSION_RUN_ALREADY_LIVE' } }, { ok: false, body: {} });
  const outcome = await startClassSession({ scriptId: null, classId: null });
  expect(outcome).toEqual({ kind: 'already_live', run: null });
  expect(startRefusalWords(outcome)).toBe(
    'The server reports a session already in progress, but it could not be loaded. Reload this page to recover it.',
  );
});

test('no answer is a network outcome, and nothing is claimed started', async () => {
  respond(new Error('offline'));
  const outcome = await startClassSession({ scriptId: null, classId: null });
  expect(outcome).toEqual({ kind: 'network' });
  expect(startRefusalWords(outcome)).toBe('Network error -- no session was started.');
});

test('refusals keep the route code and words; Session Plans words them as it did before', async () => {
  respond({ ok: false, body: { error: 'SESSION_SCRIPT_HAS_NO_BLOCKS' } });
  expect(startRefusalWords(await startClassSession({ scriptId: 'scr-1', classId: null }))).toBe(
    'This plan has no blocks, so there is nothing to deliver. It stays start-disabled until blocks exist.',
  );
  respond({ ok: false, body: { error: 'SESSION_SCRIPT_NOT_FOUND' } });
  expect(startRefusalWords(await startClassSession({ scriptId: 'scr-1', classId: null }))).toBe(
    'That plan could not be found, so no session was started.',
  );
  respond({ ok: false, body: { error: 'SESSION_CLASS_HELD', message: 'Another live session is running that class.' } });
  const held = await startClassSession({ scriptId: null, classId: 'cls-1' });
  expect(held).toEqual({ kind: 'refused', code: 'SESSION_CLASS_HELD', message: 'Another live session is running that class.' });
  expect(startRefusalWords(held)).toBe('Another live session is running that class.');
  respond({ ok: false, body: {} });
  expect(startRefusalWords(await startClassSession({ scriptId: null, classId: null }))).toBe('The server refused to start the session.');
});

test('a 2xx with no run is not a start', async () => {
  respond({ ok: true, body: {} });
  await expect(startClassSession({ scriptId: null, classId: null })).resolves.toEqual({ kind: 'refused', code: null, message: null });
});
