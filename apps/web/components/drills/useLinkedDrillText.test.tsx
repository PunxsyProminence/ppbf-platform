/**
 * @jest-environment jsdom
 */

// The linked-drill reads behind a session plan's empty Say, Watch and Fix
// lines (lane U2-6e, Overwatch Q4 = A): one GET per drill through the drill
// library's own read, kept while the screen is open, re-read after a failure
// only when the list changes, cancelled when the screen goes.

import { act, renderHook, waitFor } from '@testing-library/react';

import { provenanceSaysDraft, useLinkedDrillText } from './useLinkedDrillText';
import { REQUIRES_FLOOR_VALIDATION_PROVENANCE, requiresFloorValidation } from '@/src/lib/drillFloorValidation';
import { vocabularyValues } from '@/src/server/pilot/contentImport/vocabularies';

jest.mock('@/lib/apiBase', () => ({ apiBase: () => '' }));

function drill(drillId: string, overrides: Record<string, unknown> = {}) {
  return {
    drill_id: drillId,
    name: `Drill ${drillId}`,
    version: 1,
    active: true,
    superseded_at: null,
    what_good_looks_like: 'Hand comes straight back.',
    what_bad_looks_like: 'Reaching.',
    corrections: 'Elbow in.',
    contact_level: 'none',
    cues: [{ cue_text: 'Snap it back', cue_family: 'guard' }, { cue_text: 'Eyes up', cue_family: 'eyes' }],
    field_drafts: { cues: true, what_good_looks_like: false, what_bad_looks_like: null, corrections: true },
    ...overrides,
  };
}

type Answer = { status: number; body?: unknown } | Error;

function mockFetch(answer: (drillId: string) => Answer | Promise<Answer>) {
  const fetchMock = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const drillId = new URL(String(input), 'http://localhost').searchParams.get('drill_id') as string;
    const result = await answer(drillId);
    if (result instanceof Error) throw result;
    void init;
    return { ok: result.status >= 200 && result.status < 300, status: result.status, json: async () => result.body } as Response;
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

afterEach(() => {
  jest.restoreAllMocks();
});

test('reads each drill once, by the drill library read, and holds its text and per-field draft state', async () => {
  const fetchMock = mockFetch((id) => ({ status: 200, body: { drill: drill(id) } }));
  const { result } = renderHook(() => useLinkedDrillText(['drl-1', 'drl-1']));

  await waitFor(() => expect(result.current.get('drl-1')?.state).toBe('loaded'));
  expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual(['/api/pilot/drill-library?drill_id=drl-1']);
  expect(fetchMock.mock.calls.every(([, init]) => (init?.method ?? 'GET') === 'GET')).toBe(true);
  expect(result.current.get('drl-1')).toEqual({
    state: 'loaded',
    // The drill panel's order: by cue family, then text.
    cues: ['Eyes up', 'Snap it back'],
    good: 'Hand comes straight back.',
    bad: 'Reaching.',
    corrections: 'Elbow in.',
    drafts: { cues: true, good: false, bad: null, corrections: true },
  });
});

test('a response without field_drafts reads as "not checked" for every field, never as "not a draft"', async () => {
  mockFetch((id) => ({ status: 200, body: { drill: drill(id, { field_drafts: undefined }) } }));
  const { result } = renderHook(() => useLinkedDrillText(['drl-1']));
  await waitFor(() => expect(result.current.get('drl-1')?.state).toBe('loaded'));
  const text = result.current.get('drl-1');
  expect(text?.state === 'loaded' && text.drafts).toEqual({ cues: null, good: null, bad: null, corrections: null });
});

// Lane U2-6e follow-up (Overwatch QA = B on #1991, Q9 = A on #2001): a drill whose own
// field_provenance says DRAFT fills the "not checked" gap with the draft mark; an explicit label wins.
// Every value the column allows (pilot_drill_library_field_provenance_check), plus an empty one.
const PROVENANCES: Array<[string, true | null]> = [
  ...vocabularyValues('field_provenance').map((value): [string, true | null] => [value, requiresFloorValidation(value) ? true : null]),
  ['', null],
];

test('the two draft provenances are among the allowed values, and only they say DRAFT', () => {
  expect(PROVENANCES.filter(([, filled]) => filled).map(([value]) => value).sort()).toEqual([...REQUIRES_FLOOR_VALIDATION_PROVENANCE].sort());
  for (const [value] of PROVENANCES) expect(provenanceSaysDraft(value)).toBe(requiresFloorValidation(value));
});

test.each([
  [['DRAFT']],
  [{ text: 'DRAFT' }],
  [42],
  [null],
  [undefined],
])('a provenance that is not text (%j) is not a draft', (value) => {
  expect(provenanceSaysDraft(value as never)).toBe(false);
});

test.each(PROVENANCES)('provenance %j fills only the fields no label settles', async (provenance, filled) => {
  mockFetch((id) => ({
    status: 200,
    body: {
      drill: drill(id, {
        field_provenance: provenance,
        // cues: a draft label; good: an explicit non-draft label (e.g. a coach's edit); bad, corrections: no label.
        field_drafts: { cues: true, what_good_looks_like: false, what_bad_looks_like: null, corrections: null },
      }),
    },
  }));
  const { result } = renderHook(() => useLinkedDrillText(['drl-1']));
  await waitFor(() => expect(result.current.get('drl-1')?.state).toBe('loaded'));
  const text = result.current.get('drl-1');
  expect(text?.state === 'loaded' && text.drafts).toEqual({ cues: true, good: false, bad: filled, corrections: filled });
});

test('a drafted drill with no label read at all shows the mark on every field from its provenance', async () => {
  mockFetch((id) => ({
    status: 200,
    body: { drill: drill(id, { field_drafts: undefined, field_provenance: REQUIRES_FLOOR_VALIDATION_PROVENANCE[1] }) },
  }));
  const { result } = renderHook(() => useLinkedDrillText(['drl-1']));
  await waitFor(() => expect(result.current.get('drl-1')?.state).toBe('loaded'));
  const text = result.current.get('drl-1');
  expect(text?.state === 'loaded' && text.drafts).toEqual({ cues: true, good: true, bad: true, corrections: true });
});

test('"draft" in lower case is not the DRAFT the ruling names', async () => {
  mockFetch((id) => ({ status: 200, body: { drill: drill(id, { field_drafts: undefined, field_provenance: 'reviewed draft notes' }) } }));
  const { result } = renderHook(() => useLinkedDrillText(['drl-1']));
  await waitFor(() => expect(result.current.get('drl-1')?.state).toBe('loaded'));
  const text = result.current.get('drl-1');
  expect(text?.state === 'loaded' && text.drafts).toEqual({ cues: null, good: null, bad: null, corrections: null });
});

test('a drill read once is kept: moving to another drill and back reads nothing again', async () => {
  const fetchMock = mockFetch((id) => ({ status: 200, body: { drill: drill(id) } }));
  const { result, rerender } = renderHook(({ ids }) => useLinkedDrillText(ids), { initialProps: { ids: ['drl-1'] } });
  await waitFor(() => expect(result.current.get('drl-1')?.state).toBe('loaded'));

  rerender({ ids: ['drl-2'] });
  await waitFor(() => expect(result.current.get('drl-2')?.state).toBe('loaded'));
  rerender({ ids: ['drl-1'] });
  rerender({ ids: [] });

  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(result.current.get('drl-1')?.state).toBe('loaded');
});

test('a drill the library cannot open (404) or a failed read is "failed", and is read again only when the list changes', async () => {
  const log = jest.spyOn(console, 'error').mockImplementation(() => {});
  let fail = true;
  const fetchMock = mockFetch((id) => (id === 'gone' ? { status: 404, body: { error: 'DRILL_NOT_FOUND' } } : fail ? new Error('offline') : { status: 200, body: { drill: drill(id) } }));
  const { result, rerender } = renderHook(({ ids }) => useLinkedDrillText(ids), { initialProps: { ids: ['gone', 'drl-1'] } });

  await waitFor(() => expect(result.current.get('drl-1')?.state).toBe('failed'));
  await waitFor(() => expect(result.current.get('gone')?.state).toBe('failed'));
  // A render with the same list does not retry.
  rerender({ ids: ['drl-1', 'gone'] });
  expect(fetchMock).toHaveBeenCalledTimes(2);

  fail = false;
  rerender({ ids: ['drl-1'] });
  await waitFor(() => expect(result.current.get('drl-1')?.state).toBe('loaded'));
  expect(fetchMock).toHaveBeenCalledTimes(3);
  expect(log).toHaveBeenCalledWith(expect.objectContaining({ event: 'linked-drill-text-load-failed', drill_id: 'drl-1' }));
});

test('leaving the screen cancels a read still loading, and its late answer changes nothing', async () => {
  let release: (answer: Answer) => void = () => {};
  const fetchMock = mockFetch(() => new Promise<Answer>((resolve) => { release = resolve; }));
  const log = jest.spyOn(console, 'error').mockImplementation(() => {});
  const { result, unmount } = renderHook(() => useLinkedDrillText(['drl-1']));
  expect(result.current.get('drl-1')).toEqual({ state: 'loading' });

  const signal = (fetchMock.mock.calls[0][1] as RequestInit).signal as AbortSignal;
  unmount();
  expect(signal.aborted).toBe(true);
  await act(async () => {
    release({ status: 200, body: { drill: drill('drl-1') } });
  });
  expect(log).not.toHaveBeenCalled();
});
