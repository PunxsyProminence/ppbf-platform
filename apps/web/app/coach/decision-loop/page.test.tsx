/**
 * @jest-environment jsdom
 */

import type { ReactNode } from 'react';
import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import DecisionLoopReviewPage from './page';

jest.mock('@/components/RoleStandaloneView', () => ({
  __esModule: true,
  default: ({ children }: { readonly children: ReactNode }) => <div>{children}</div>,
}));

function jsonResponse(body: unknown, ok = true) {
  return { ok, json: async () => body } as Response;
}

function installFetch(overrides: Record<string, unknown> = {}) {
  const fetchMock = jest.fn(async (url: string, init?: RequestInit) => {
    const key = String(url);
    if (key.includes('/api/pilot/athletes/list')) {
      return jsonResponse({ items: [{ athlete_id: 'ath-1', full_name: 'Jordan T.' }] });
    }
    if (key.includes('/api/pilot/shadow/medical-status')) {
      // Overridable in the same shape as domainUpsert/incidents below. All
      // four shadow reads are awaited together and read through one
      // readJsonOrThrow chain, so refusing this one is how a test makes the
      // whole load fail -- which is the only state in which the four panels
      // below are unreadable rather than empty.
      const handler = overrides.medicalStatus as ((init?: RequestInit) => Response) | undefined;
      return handler ? handler(init) : jsonResponse({ status: null });
    }
    if (key.includes('/api/pilot/shadow/recommendations')) {
      return jsonResponse({ recommendations: [] });
    }
    if (key.includes('/api/pilot/shadow/decisions')) {
      return jsonResponse({ decisions: [] });
    }
    if (key.includes('/api/pilot/shadow/near-misses')) {
      return jsonResponse({ nearMisses: [] });
    }
    if (key.includes('/api/pilot/intake/domain-upsert')) {
      const handler = overrides.domainUpsert as ((init?: RequestInit) => Response) | undefined;
      return handler ? handler(init) : jsonResponse({ ok: true, entity_type: 'coach_note', entity_id: 'obs-1', athlete_id: 'ath-1' });
    }
    if (key.includes('/api/pilot/incidents')) {
      const handler = overrides.incidents as ((init?: RequestInit) => Response) | undefined;
      return handler ? handler(init) : jsonResponse({ ok: true, escalation_id: 'esc-1', source_type: 'incident' });
    }
    throw new Error(`Unexpected fetch: ${key}`);
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

async function selectAthlete() {
  render(<DecisionLoopReviewPage />);
  const input = await screen.findByPlaceholderText('athlete-id');
  fireEvent.change(input, { target: { value: 'ath-1' } });
  await screen.findByText('Behavior & Habit Note');
}

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  jest.clearAllMocks();
});

test('logging a behavior note posts entity_type coach_note with a generic note_type, no invented taxonomy', async () => {
  const fetchMock = installFetch();
  await selectAthlete();

  fireEvent.change(screen.getByLabelText('Note'), { target: { value: 'Showed real effort helping a younger athlete warm up.' } });
  fireEvent.click(screen.getByRole('button', { name: 'Log Note' }));

  await waitFor(() => {
    const call = fetchMock.mock.calls.find((c) => String(c[0]).includes('/api/pilot/intake/domain-upsert'));
    expect(call).toBeDefined();
  });

  const call = fetchMock.mock.calls.find((c) => String(c[0]).includes('/api/pilot/intake/domain-upsert'));
  const body = JSON.parse(String((call?.[1] as RequestInit).body));
  expect(body).toEqual({
    entity_type: 'coach_note',
    athlete_id: 'ath-1',
    payload: { note_type: 'behavior_standard', note_text: 'Showed real effort helping a younger athlete warm up.' },
  });

  await screen.findByText('Note logged.');
});

test('the textarea clears after a successful log', async () => {
  installFetch();
  await selectAthlete();

  const textarea = screen.getByLabelText('Note') as HTMLTextAreaElement;
  fireEvent.change(textarea, { target: { value: 'A note.' } });
  fireEvent.click(screen.getByRole('button', { name: 'Log Note' }));

  await waitFor(() => expect(textarea.value).toBe(''));
});

test('an empty note does not submit', async () => {
  const fetchMock = installFetch();
  await selectAthlete();

  fireEvent.click(screen.getByRole('button', { name: 'Log Note' }));

  expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('/api/pilot/intake/domain-upsert'))).toBe(false);
});

test('a failed log shows the error, not a false success message', async () => {
  installFetch({ domainUpsert: () => jsonResponse({ error: 'Forbidden' }, false) });
  await selectAthlete();

  fireEvent.change(screen.getByLabelText('Note'), { target: { value: 'A note.' } });
  fireEvent.click(screen.getByRole('button', { name: 'Log Note' }));

  await screen.findByText('Forbidden');
  expect(screen.queryByText('Note logged.')).toBeNull();
});

// Capability #90, scoped to one-directional send: a coach message to the
// athlete's family, reusing domain-upsert exactly like the Behavior Note
// panel, with note_type: 'parent_message' -- the one value
// listParentMessages reads back on the guardian's Messages tab.
describe('Message Home (#90)', () => {
  test('posts entity_type coach_note with note_type parent_message', async () => {
    const fetchMock = installFetch();
    await selectAthlete();

    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Great effort at practice this week!' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send to Family' }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find((c) => String(c[0]).includes('/api/pilot/intake/domain-upsert'));
      expect(call).toBeDefined();
    });

    const call = fetchMock.mock.calls.find((c) => String(c[0]).includes('/api/pilot/intake/domain-upsert'));
    const body = JSON.parse(String((call?.[1] as RequestInit).body));
    expect(body).toEqual({
      entity_type: 'coach_note',
      athlete_id: 'ath-1',
      payload: { note_type: 'parent_message', note_text: 'Great effort at practice this week!' },
    });

    await screen.findByText('Sent to the family.');
  });

  test('the textarea clears after a successful send', async () => {
    installFetch();
    await selectAthlete();

    const textarea = screen.getByLabelText('Message') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'A message.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send to Family' }));

    await waitFor(() => expect(textarea.value).toBe(''));
  });

  test('an empty message does not submit', async () => {
    const fetchMock = installFetch();
    await selectAthlete();

    fireEvent.click(screen.getByRole('button', { name: 'Send to Family' }));

    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('/api/pilot/intake/domain-upsert'))).toBe(false);
  });

  test('a failed send shows the error, not a false success message', async () => {
    installFetch({ domainUpsert: () => jsonResponse({ error: 'Forbidden' }, false) });
    await selectAthlete();

    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'A message.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send to Family' }));

    await screen.findByText('Forbidden');
    expect(screen.queryByText('Sent to the family.')).toBeNull();
  });
});

// Round 9 review: capability #152's Report Incident form shipped with zero
// test coverage -- only the server route and the pure function were
// exercised, never the UI a coach actually uses to file one.
describe('Report Incident (#152)', () => {
  test('severity defaults to high and posts the payload the route expects', async () => {
    const fetchMock = installFetch();
    await selectAthlete();

    fireEvent.change(screen.getByLabelText('What happened'), { target: { value: 'Athlete was struck after the bell.' } });
    fireEvent.click(screen.getByRole('button', { name: 'File Incident Report' }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find((c) => String(c[0]).includes('/api/pilot/incidents'));
      expect(call).toBeDefined();
    });

    const call = fetchMock.mock.calls.find((c) => String(c[0]).includes('/api/pilot/incidents'));
    const body = JSON.parse(String((call?.[1] as RequestInit).body));
    expect(body).toEqual({
      athleteId: 'ath-1',
      description: 'Athlete was struck after the bell.',
      severity: 'high',
      occurredAt: undefined,
    });

    await screen.findByText('Incident filed -- it is now in the escalation queue.');
  });

  test('an explicit critical severity and an occurredAt value both pass through', async () => {
    const fetchMock = installFetch();
    await selectAthlete();

    const incidentSection = screen.getByText('Report Incident').closest('section') as HTMLElement;
    fireEvent.change(screen.getByLabelText('What happened'), { target: { value: 'Ambulance called.' } });
    fireEvent.change(within(incidentSection).getByLabelText('Severity'), { target: { value: 'critical' } });
    fireEvent.change(screen.getByLabelText('When it happened (optional, if not today)'), { target: { value: '2026-08-05' } });
    fireEvent.click(screen.getByRole('button', { name: 'File Incident Report' }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find((c) => String(c[0]).includes('/api/pilot/incidents'));
      expect(call).toBeDefined();
    });

    const call = fetchMock.mock.calls.find((c) => String(c[0]).includes('/api/pilot/incidents'));
    const body = JSON.parse(String((call?.[1] as RequestInit).body));
    expect(body).toEqual({
      athleteId: 'ath-1',
      description: 'Ambulance called.',
      severity: 'critical',
      occurredAt: '2026-08-05',
    });
  });

  test('the description clears after a successful file', async () => {
    installFetch();
    await selectAthlete();

    const textarea = screen.getByLabelText('What happened') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'Something happened.' } });
    fireEvent.click(screen.getByRole('button', { name: 'File Incident Report' }));

    await waitFor(() => expect(textarea.value).toBe(''));
  });

  test('an empty description does not submit', async () => {
    const fetchMock = installFetch();
    await selectAthlete();

    fireEvent.click(screen.getByRole('button', { name: 'File Incident Report' }));

    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('/api/pilot/incidents'))).toBe(false);
  });

  test('a failed file shows the error, not a false success message', async () => {
    installFetch({ incidents: () => jsonResponse({ error: 'Forbidden' }, false) });
    await selectAthlete();

    fireEvent.change(screen.getByLabelText('What happened'), { target: { value: 'Something happened.' } });
    fireEvent.click(screen.getByRole('button', { name: 'File Incident Report' }));

    await screen.findByText('Forbidden');
    expect(screen.queryByText('Incident filed -- it is now in the escalation queue.')).toBeNull();
  });

  test('the submit button disables while the request is in flight, so a double click cannot file twice', async () => {
    let resolveIncident: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => {
      resolveIncident = resolve;
    });
    const fetchMock = installFetch({
      incidents: async () => {
        await pending;
        return jsonResponse({ ok: true, escalation_id: 'esc-1' });
      },
    });
    await selectAthlete();

    fireEvent.change(screen.getByLabelText('What happened'), { target: { value: 'Something happened.' } });
    const button = screen.getByRole('button', { name: 'File Incident Report' });
    fireEvent.click(button);

    await waitFor(() => expect(button).toBeDisabled());
    fireEvent.click(button);

    resolveIncident?.();
    await waitFor(() => expect(button).not.toBeDisabled());

    expect(fetchMock.mock.calls.filter((c) => String(c[0]).includes('/api/pilot/incidents'))).toHaveLength(1);
  });
});

// Round 9 review: incidentFiledMessage/behaviorNoteMessage were never
// cleared on an athlete switch, so a stale "Incident filed" confirmation
// from athlete A kept showing under athlete B's panel.
test('switching athletes clears a stale incident-filed confirmation', async () => {
  installFetch();
  await selectAthlete();

  fireEvent.change(screen.getByLabelText('What happened'), { target: { value: 'Something happened.' } });
  fireEvent.click(screen.getByRole('button', { name: 'File Incident Report' }));
  await screen.findByText('Incident filed -- it is now in the escalation queue.');

  fireEvent.change(screen.getByPlaceholderText('athlete-id'), { target: { value: 'ath-2' } });

  await waitFor(() => expect(screen.queryByText('Incident filed -- it is now in the escalation queue.')).toBeNull());
});

// ONE LOAD FEEDS FOUR PANELS, SO ONE FAILURE SILENCES FOUR PANELS.
//
// refreshAll reads medical status, recommendations, decisions and near-misses
// together. When it throws, none of the four setters run, so all four keep
// their initial empties -- and every one of those empties is a sentence
// asserting a fact. The worst of them is "No medical administrative status
// recorded yet", which is what a coach reads immediately before putting a
// child into contact work; on a failed read the honest word is UNKNOWN, and
// the error line in the picker header is not enough while four panels
// underneath it independently say "clear".
describe('a decision loop nobody could read never reads as a clear one', () => {
  test('a failed load says all four panels are unreadable, and none of them asserts an all-clear', async () => {
    installFetch({ medicalStatus: () => jsonResponse({ error: 'Forbidden' }, false) });
    await selectAthlete();

    // The one that decides whether a child trains today. UNKNOWN, in the
    // page's own words, and explicitly not "no restriction on record".
    expect(await screen.findByText(/medical administrative status could not be read/i)).toBeTruthy();
    expect(screen.getByText(/UNKNOWN/)).toBeTruthy();
    expect(screen.queryByText('No medical administrative status recorded yet.')).toBeNull();

    // And the other three, each of which a coach reads as "nothing here".
    expect(screen.getByText(/Recommendations could not be read/i)).toBeTruthy();
    expect(screen.queryByText('No recommendations yet.')).toBeNull();

    expect(screen.getByText(/Decisions could not be read/i)).toBeTruthy();
    expect(screen.queryByText('No decisions recorded yet.')).toBeNull();

    expect(screen.getByText(/Near-misses could not be read/i)).toBeTruthy();
    expect(screen.queryByText('No near-misses flagged yet.')).toBeNull();
  });

  test('an athlete with a genuinely clean record still reads as clean, with no claim of failure', async () => {
    // The other direction, and it carries real weight here: a page that says
    // "could not be read" over four panels every time a coach opens an athlete
    // with nothing on file would make the honest banner worthless within a
    // week.
    installFetch();
    await selectAthlete();

    expect(await screen.findByText('No medical administrative status recorded yet.')).toBeTruthy();
    expect(screen.getByText('No recommendations yet.')).toBeTruthy();
    expect(screen.getByText('No decisions recorded yet.')).toBeTruthy();
    expect(screen.getByText('No near-misses flagged yet.')).toBeTruthy();

    expect(screen.queryByText(/medical administrative status could not be read/i)).toBeNull();
    expect(screen.queryByText(/Recommendations could not be read/i)).toBeNull();
    expect(screen.queryByText(/Decisions could not be read/i)).toBeNull();
    expect(screen.queryByText(/Near-misses could not be read/i)).toBeNull();
  });
});
