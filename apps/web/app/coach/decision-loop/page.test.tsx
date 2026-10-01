/**
 * @jest-environment jsdom
 */

import type { ReactNode } from 'react';
import '@testing-library/jest-dom';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import DecisionLoopReviewPage from './page';

/* A PROBE ON EVERY COMMIT. WorkAxis sits at the foot of the page and renders
   whenever the page does. This stand-in records, after each commit and before
   anything else can run, which athlete the ID box says is selected and all
   the text on screen -- so a test can ask whether there was EVER a commit
   with athlete B selected and athlete A's records up, not just whether the
   last one is clean. An effect that clears the old records after the new
   selection has rendered produces exactly such a commit. */
const committed: Array<{ selected: string; text: string }> = [];
jest.mock('@/components/WorkAxis', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { useLayoutEffect } = require('react') as typeof import('react');
  return {
    __esModule: true,
    default: function WorkAxisProbe() {
      useLayoutEffect(() => {
        const box = document.querySelector('input[placeholder="athlete-id"]') as HTMLInputElement | null;
        committed.push({ selected: box?.value ?? '', text: document.body.textContent ?? '' });
      });
      return null;
    },
  };
});

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

// THE PREVIOUS CHILD'S RECORDS DO NOT STAY ON SCREEN UNDER THE NEXT ONE.
//
// The four data sets were only ever replaced by a SUCCESSFUL read. A failed
// switch from athlete A to athlete B therefore left A's medical administrative
// status rendered under B, and the render tests `medicalStatus` before it
// tests the failure -- so the "could not be read" line the describe above pins
// never appeared. This is the screen a coach reads before contact work.
describe('switching athletes never leaves the previous athlete on screen', () => {
  const A_STATUS = {
    status_id: 'st-a',
    athlete_id: 'ath-a',
    status: 'cleared',
    restriction_flags: {},
    source_reference: 'ref-for-athlete-a',
    set_by_account_id: 'acct-1',
    set_by_role: 'organization_admin',
    effective_at: '2026-08-01T10:00:00.000Z',
    created_at: '2026-08-01T10:00:00.000Z',
  };
  const A_RECOMMENDATION = {
    recommendation_id: 'rec-a',
    athlete_id: 'ath-a',
    recommendation_text: 'Athlete A: return to light sparring.',
    expected_outcome: 'No symptoms after two rounds.',
    status: 'provisional',
    created_by_account_id: 'acct-1',
    created_at: '2026-08-01T10:00:00.000Z',
    expires_at: '2026-09-01T10:00:00.000Z',
    decided_by_account_id: null,
    decided_at: null,
  };
  const A_DECISION = {
    decision_id: 'dec-a',
    athlete_id: 'ath-a',
    recommendation_id: null,
    decision_text: 'Athlete A: cleared for pad work.',
    expected_outcome: 'Holds form for three rounds.',
    decided_by_account_id: 'acct-1',
    decided_by_role: 'coach',
    status: 'active',
    decided_at: '2026-08-02T10:00:00.000Z',
  };
  const A_NEAR_MISS = {
    near_miss_id: 'nm-a',
    athlete_id: 'ath-a',
    decision_id: null,
    description: 'Athlete A: slipped on the apron.',
    severity: 'low',
    detected_by: 'human',
    created_at: '2026-08-03T10:00:00.000Z',
  };

  type Responder = () => Response | Promise<Response>;

  const PREVIOUS_FAILED = /Something you submitted for the athlete you were on before did not go through/;

  /**
   * A fetch double keyed by athlete. Athlete A always has a full record;
   * what athlete B's four reads do is the test's to decide. `posts` lets a
   * test hold a write open or inspect its body.
   */
  function installSwitchFetch(options: {
    readB?: Responder;
    readA?: Responder;
    post?: (url: string, init: RequestInit) => Response | Promise<Response>;
  } = {}) {
    const fetchMock = jest.fn(async (url: string, init?: RequestInit) => {
      const key = String(url);
      if (init?.method === 'POST') {
        return options.post ? options.post(key, init) : jsonResponse({ ok: true });
      }
      if (key.includes('/api/pilot/athletes/list')) {
        return jsonResponse({
          items: [
            { athlete_id: 'ath-a', full_name: 'Athlete A' },
            { athlete_id: 'ath-b', full_name: 'Athlete B' },
          ],
        });
      }
      if (key.includes('athleteId=ath-b')) {
        if (options.readB) return options.readB();
        if (key.includes('/medical-status')) return jsonResponse({ status: null });
        if (key.includes('/recommendations')) return jsonResponse({ recommendations: [] });
        if (key.includes('/decisions')) return jsonResponse({ decisions: [] });
        return jsonResponse({ nearMisses: [] });
      }
      if (key.includes('athleteId=ath-a')) {
        if (options.readA) await options.readA();
        if (key.includes('/medical-status')) return jsonResponse({ status: A_STATUS });
        if (key.includes('/recommendations')) return jsonResponse({ recommendations: [A_RECOMMENDATION] });
        if (key.includes('/decisions')) return jsonResponse({ decisions: [A_DECISION] });
        return jsonResponse({ nearMisses: [A_NEAR_MISS] });
      }
      throw new Error(`Unexpected fetch: ${key}`);
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    return fetchMock;
  }

  function medicalSection(): HTMLElement {
    return screen.getByRole('heading', { name: 'Medical Administrative Status' }).closest('section') as HTMLElement;
  }

  async function openAthleteA() {
    render(<DecisionLoopReviewPage />);
    fireEvent.change(await screen.findByPlaceholderText('athlete-id'), { target: { value: 'ath-a' } });
    await screen.findByText(/ref-for-athlete-a/);
    expect(within(medicalSection()).getByText('cleared')).toBeTruthy();
    expect(screen.getAllByText(A_RECOMMENDATION.recommendation_text).length).toBeGreaterThan(0);
  }

  function switchToB() {
    fireEvent.change(screen.getByPlaceholderText('athlete-id'), { target: { value: 'ath-b' } });
  }

  function expectNothingOfAthleteA() {
    expect(within(medicalSection()).queryByText('cleared')).toBeNull();
    expect(screen.queryByText(/ref-for-athlete-a/)).toBeNull();
    expect(screen.queryByText(/Athlete A: return to light sparring/)).toBeNull();
    expect(screen.queryByText(/Athlete A: cleared for pad work/)).toBeNull();
    expect(screen.queryByText(/Athlete A: slipped on the apron/)).toBeNull();
  }

  test('a switch the server refuses shows UNKNOWN for the new athlete, and nothing of the previous one', async () => {
    installSwitchFetch({ readB: () => jsonResponse({ error: 'Service unavailable' }, false) });
    await openAthleteA();

    switchToB();

    expect(await screen.findByText(/medical administrative status could not be read/i)).toBeTruthy();
    expectNothingOfAthleteA();
    expect(screen.getByText(/Recommendations could not be read/i)).toBeTruthy();
    expect(screen.getByText(/Decisions could not be read/i)).toBeTruthy();
    expect(screen.getByText(/Near-misses could not be read/i)).toBeTruthy();
    // And not the all-clear either.
    expect(screen.queryByText('No medical administrative status recorded yet.')).toBeNull();
  });

  test('a switch whose read throws is treated the same as one the server refused', async () => {
    installSwitchFetch({ readB: () => Promise.reject(new Error('Network request failed')) });
    await openAthleteA();

    switchToB();

    expect(await screen.findByText(/medical administrative status could not be read/i)).toBeTruthy();
    expectNothingOfAthleteA();
    expect(screen.queryByText('No medical administrative status recorded yet.')).toBeNull();
  });

  test('while the new athlete is still being read, the previous one is already gone and nothing is claimed', async () => {
    installSwitchFetch({ readB: () => new Promise<Response>(() => {}) });
    await openAthleteA();

    switchToB();

    expect(await within(medicalSection()).findByText(/Reading medical administrative status/)).toBeTruthy();
    expectNothingOfAthleteA();
    // Not read yet is not "none on record" and not "could not be read".
    expect(screen.queryByText('No medical administrative status recorded yet.')).toBeNull();
    expect(screen.queryByText('No recommendations yet.')).toBeNull();
    expect(screen.queryByText('No decisions recorded yet.')).toBeNull();
    expect(screen.queryByText('No near-misses flagged yet.')).toBeNull();
    expect(screen.queryByText(/could not be read/i)).toBeNull();
  });

  test('a slow read for the previous athlete cannot land after the switch', async () => {
    // The ID box fires a read per keystroke, and reads come back in whatever
    // order the network likes.
    let releaseA: (() => void) | undefined;
    const heldA = new Promise<Response>((resolve) => {
      releaseA = () => resolve(jsonResponse({}));
    });
    installSwitchFetch({ readA: () => heldA });

    render(<DecisionLoopReviewPage />);
    const input = await screen.findByPlaceholderText('athlete-id');
    fireEvent.change(input, { target: { value: 'ath-a' } });
    fireEvent.change(input, { target: { value: 'ath-b' } });

    expect(await screen.findByText('No medical administrative status recorded yet.')).toBeTruthy();

    releaseA?.();
    // Give the held read every chance to paint.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    expectNothingOfAthleteA();
    expect(screen.getByText('No medical administrative status recorded yet.')).toBeTruthy();
    expect(screen.queryByText('Loading…')).toBeNull();
  });

  test('a write for the previous athlete that finishes late does not re-read them onto the new athlete', async () => {
    let releasePost: (() => void) | undefined;
    const heldPost = new Promise<Response>((resolve) => {
      releasePost = () => resolve(jsonResponse({ ok: true }));
    });
    installSwitchFetch({ post: () => heldPost });
    await openAthleteA();

    fireEvent.click(screen.getByRole('button', { name: 'Set Status' }));
    switchToB();
    expect(await screen.findByText('No medical administrative status recorded yet.')).toBeTruthy();

    releasePost?.();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    expectNothingOfAthleteA();
    expect(screen.getByText('No medical administrative status recorded yet.')).toBeTruthy();
  });

  test('a recommendation selected for the previous athlete is not linked to a decision for the new one', async () => {
    const fetchMock = installSwitchFetch();
    await openAthleteA();

    fireEvent.change(screen.getByLabelText('Link to recommendation (optional)'), { target: { value: 'rec-a' } });
    switchToB();
    await screen.findByText('No medical administrative status recorded yet.');

    fireEvent.change(screen.getByLabelText('Decision text'), { target: { value: 'Athlete B: bag work only.' } });
    const decisionSection = screen.getByRole('heading', { name: 'Decisions' }).closest('section') as HTMLElement;
    fireEvent.change(within(decisionSection).getByLabelText('Expected outcome'), { target: { value: 'No contact.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Record Decision' }));

    await waitFor(() => {
      expect(fetchMock.mock.calls.some((c) => (c[1] as RequestInit | undefined)?.method === 'POST')).toBe(true);
    });
    const call = fetchMock.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === 'POST');
    expect(String(call?.[0])).toContain('/api/pilot/shadow/decisions');
    const body = JSON.parse(String((call?.[1] as RequestInit).body));
    expect(body.athleteId).toBe('ath-b');
    expect(body.recommendationId).toBeUndefined();
  });

  test('a re-read that fails after a write does not keep showing the status from before the write', async () => {
    // Set Status succeeds, the re-read fails. What was on screen was read
    // BEFORE the write; leaving it under "Current status" is a claim about
    // now that nothing supports.
    let failReads = false;
    installSwitchFetch({
      post: () => {
        failReads = true;
        return jsonResponse({ ok: true });
      },
      readA: () => {
        if (failReads) throw new Error('Network request failed');
        return jsonResponse({});
      },
    });
    await openAthleteA();

    fireEvent.click(screen.getByRole('button', { name: 'Set Status' }));

    expect(await screen.findByText(/medical administrative status could not be read/i)).toBeTruthy();
    expect(within(medicalSection()).queryByText('cleared')).toBeNull();
    expect(screen.queryByText(/ref-for-athlete-a/)).toBeNull();
  });

  test('a switch that succeeds shows the new athlete, with no claim of failure', async () => {
    installSwitchFetch();
    await openAthleteA();

    switchToB();

    expect(await screen.findByText('No medical administrative status recorded yet.')).toBeTruthy();
    expectNothingOfAthleteA();
    expect(screen.queryByText(/could not be read/i)).toBeNull();
  });

  test('switching back reads the first athlete again', async () => {
    installSwitchFetch({ readB: () => jsonResponse({ error: 'Service unavailable' }, false) });
    await openAthleteA();
    switchToB();
    await screen.findByText(/medical administrative status could not be read/i);

    fireEvent.change(screen.getByPlaceholderText('athlete-id'), { target: { value: 'ath-a' } });

    await screen.findByText(/ref-for-athlete-a/);
    expect(within(medicalSection()).getByText('cleared')).toBeTruthy();
    expect(screen.queryByText(/could not be read/i)).toBeNull();
  });

  async function settle() {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
  }

  function heldResponse() {
    let release: ((response: Response) => void) | undefined;
    const promise = new Promise<Response>((resolve) => {
      release = resolve;
    });
    return { promise, release: (response: Response) => release?.(response) };
  }

  test('a write for the previous athlete that is refused late does not print their medical status under the new one', async () => {
    // The refusal text is the server's, and it quotes the athlete's status.
    const held = heldResponse();
    installSwitchFetch({ post: () => held.promise });
    await openAthleteA();

    fireEvent.change(screen.getByLabelText('Decision text'), { target: { value: 'Athlete A: two rounds of sparring.' } });
    const decisionSection = screen.getByRole('heading', { name: 'Decisions' }).closest('section') as HTMLElement;
    fireEvent.change(within(decisionSection).getByLabelText('Expected outcome'), { target: { value: 'No symptoms.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Record Decision' }));

    switchToB();
    await screen.findByText('No medical administrative status recorded yet.');

    held.release(
      jsonResponse({ error: "Blocked: this athlete's medical administrative status is 'restricted', not 'cleared'." }, false),
    );
    await settle();

    expect(screen.queryByText(/Blocked/)).toBeNull();
    expect(screen.queryByText(/restricted/)).toBeNull();
    expect(screen.getByText('No medical administrative status recorded yet.')).toBeTruthy();
    expect(screen.getByText(PREVIOUS_FAILED)).toBeTruthy();
  });

  test('the same refusal IS shown when the coach is still on that athlete', async () => {
    // The other direction: the guard must not swallow a refusal the coach
    // needs to read.
    installSwitchFetch({
      post: () => jsonResponse({ error: "Blocked: this athlete's medical administrative status is 'restricted', not 'cleared'." }, false),
    });
    await openAthleteA();

    fireEvent.change(screen.getByLabelText('Decision text'), { target: { value: 'Athlete A: two rounds of sparring.' } });
    const decisionSection = screen.getByRole('heading', { name: 'Decisions' }).closest('section') as HTMLElement;
    fireEvent.change(within(decisionSection).getByLabelText('Expected outcome'), { target: { value: 'No symptoms.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Record Decision' }));

    expect(await screen.findByText(/Blocked/)).toBeTruthy();
  });

  test('an incident filed for the previous athlete that lands late is not confirmed under the new one', async () => {
    const held = heldResponse();
    installSwitchFetch({ post: () => held.promise });
    await openAthleteA();

    fireEvent.change(screen.getByLabelText('What happened'), { target: { value: 'Athlete A was struck after the bell.' } });
    fireEvent.click(screen.getByRole('button', { name: 'File Incident Report' }));

    switchToB();
    await screen.findByText('No medical administrative status recorded yet.');

    held.release(jsonResponse({ ok: true, escalation_id: 'esc-1' }));
    await settle();

    expect(screen.queryByText('Incident filed -- it is now in the escalation queue.')).toBeNull();
    // The button is not left stuck on "Filing…".
    expect(screen.getByRole('button', { name: 'File Incident Report' })).not.toBeDisabled();
  });

  test('a decision selected for the previous athlete is not attached to a near-miss for the new one', async () => {
    const fetchMock = installSwitchFetch();
    await openAthleteA();

    fireEvent.change(screen.getByLabelText('Related decision (optional)'), { target: { value: 'dec-a' } });
    switchToB();
    await screen.findByText('No medical administrative status recorded yet.');

    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Athlete B: glove came loose.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Flag Near-Miss' }));

    await waitFor(() => {
      expect(fetchMock.mock.calls.some((c) => (c[1] as RequestInit | undefined)?.method === 'POST')).toBe(true);
    });
    const call = fetchMock.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === 'POST');
    const body = JSON.parse(String((call?.[1] as RequestInit).body));
    expect(body.athleteId).toBe('ath-b');
    expect(body.decisionId).toBeUndefined();
  });

  test('a decision selected for evaluation under the previous athlete cannot be evaluated from the new one', async () => {
    const fetchMock = installSwitchFetch();
    await openAthleteA();

    fireEvent.change(screen.getByLabelText('Decision'), { target: { value: 'dec-a' } });
    switchToB();
    await screen.findByText('No medical administrative status recorded yet.');

    fireEvent.click(screen.getByRole('button', { name: 'Evaluate Outcome' }));
    await settle();

    expect(fetchMock.mock.calls.some((c) => (c[1] as RequestInit | undefined)?.method === 'POST')).toBe(false);
  });

  test('a slow read for the previous athlete that FAILS late does not wipe the new athlete or show its error', async () => {
    let failA: (() => void) | undefined;
    const heldA = new Promise<Response>((_resolve, reject) => {
      failA = () => reject(new Error('Network request failed for athlete A'));
    });
    installSwitchFetch({ readA: () => heldA });

    render(<DecisionLoopReviewPage />);
    const input = await screen.findByPlaceholderText('athlete-id');
    fireEvent.change(input, { target: { value: 'ath-a' } });
    fireEvent.change(input, { target: { value: 'ath-b' } });
    await screen.findByText('No medical administrative status recorded yet.');

    failA?.();
    await settle();

    expect(screen.getByText('No medical administrative status recorded yet.')).toBeTruthy();
    expect(screen.queryByText(/could not be read/i)).toBeNull();
    expect(screen.queryByText(/Network request failed for athlete A/)).toBeNull();
  });

  /*
   * Every write on the page, one row each. `submit` fills what the form
   * needs and presses its button while athlete A is selected.
   */
  const WRITES: Array<{ name: string; route: string; submit: () => void; confirmation?: string; draft?: () => string }> = [
    { name: 'Set Status', route: '/shadow/medical-status', submit: () => {
      fireEvent.change(screen.getByLabelText('Source reference (optional)'), { target: { value: 'note for A' } });
      fireEvent.click(screen.getByRole('button', { name: 'Set Status' }));
    }, draft: () => (screen.getByLabelText('Source reference (optional)') as HTMLInputElement).value },
    { name: 'Accept a recommendation', route: '/recommendations/decide', submit: () => {
      fireEvent.click(screen.getByRole('button', { name: 'Accept' }));
    } },
    { name: 'Record Decision', route: '/shadow/decisions', submit: () => {
      fireEvent.change(screen.getByLabelText('Decision text'), { target: { value: 'decision for A' } });
      const section = screen.getByRole('heading', { name: 'Decisions' }).closest('section') as HTMLElement;
      fireEvent.change(within(section).getByLabelText('Expected outcome'), { target: { value: 'outcome for A' } });
      fireEvent.click(screen.getByRole('button', { name: 'Record Decision' }));
    }, draft: () => (screen.getByLabelText('Decision text') as HTMLTextAreaElement).value },
    { name: 'Flag Near-Miss', route: '/shadow/near-misses', submit: () => {
      fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'near miss for A' } });
      fireEvent.click(screen.getByRole('button', { name: 'Flag Near-Miss' }));
    }, draft: () => (screen.getByLabelText('Description') as HTMLTextAreaElement).value },
    { name: 'Report Incident', route: '/api/pilot/incidents', submit: () => {
      fireEvent.change(screen.getByLabelText('What happened'), { target: { value: 'incident for A' } });
      fireEvent.click(screen.getByRole('button', { name: 'File Incident Report' }));
    }, confirmation: 'Incident filed -- it is now in the escalation queue.',
      draft: () => (screen.getByLabelText('What happened') as HTMLTextAreaElement).value },
    { name: 'Behavior Note', route: '/intake/domain-upsert', submit: () => {
      fireEvent.change(screen.getByLabelText('Note'), { target: { value: 'note for A' } });
      fireEvent.click(screen.getByRole('button', { name: 'Log Note' }));
    }, confirmation: 'Note logged.', draft: () => (screen.getByLabelText('Note') as HTMLTextAreaElement).value },
    { name: 'Message Home', route: '/intake/domain-upsert', submit: () => {
      fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'message for A family' } });
      fireEvent.click(screen.getByRole('button', { name: 'Send to Family' }));
    }, confirmation: 'Sent to the family.', draft: () => (screen.getByLabelText('Message') as HTMLTextAreaElement).value },
    { name: 'Evaluate Outcome', route: '/shadow/decision-outcomes', submit: () => {
      fireEvent.change(screen.getByLabelText('Decision'), { target: { value: 'dec-a' } });
      fireEvent.change(screen.getByLabelText('Notes'), { target: { value: 'outcome notes for A' } });
      fireEvent.click(screen.getByRole('button', { name: 'Evaluate Outcome' }));
    }, draft: () => (screen.getByLabelText('Notes') as HTMLTextAreaElement).value },
  ];

  test.each(WRITES)('$name refused late: the server text about the previous athlete is withheld, and the coach is still told', async ({ route, submit }) => {
    const held = heldResponse();
    const fetchMock = installSwitchFetch({ post: () => held.promise });
    await openAthleteA();

    submit();
    await waitFor(() => {
      const post = fetchMock.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === 'POST');
      expect(String(post?.[0])).toContain(route);
    });
    switchToB();
    await screen.findByText('No medical administrative status recorded yet.');

    held.release(jsonResponse({ error: 'SERVER-TEXT-ABOUT-ATHLETE-A is restricted' }, false));
    await settle();

    expect(screen.queryByText(/SERVER-TEXT-ABOUT-ATHLETE-A/)).toBeNull();
    // Not silence: a report or a status that did not land must not vanish.
    expect(screen.getByText(PREVIOUS_FAILED)).toBeTruthy();
    expectNothingOfAthleteA();
  });

  test.each(WRITES)('$name refused while still on that athlete: the server text IS shown', async ({ submit }) => {
    installSwitchFetch({ post: () => jsonResponse({ error: 'SERVER-TEXT-ABOUT-ATHLETE-A is restricted' }, false) });
    await openAthleteA();

    submit();

    expect(await screen.findByText(/SERVER-TEXT-ABOUT-ATHLETE-A/)).toBeTruthy();
    expect(screen.queryByText(PREVIOUS_FAILED)).toBeNull();
  });

  test.each(WRITES)('$name succeeding late: no confirmation under the new athlete, and the sent draft is not left in the box', async ({ submit, confirmation, draft }) => {
    const held = heldResponse();
    const fetchMock = installSwitchFetch({ post: () => held.promise });
    await openAthleteA();

    submit();
    await waitFor(() =>
      expect(fetchMock.mock.calls.some((c) => (c[1] as RequestInit | undefined)?.method === 'POST')).toBe(true),
    );
    switchToB();
    await screen.findByText('No medical administrative status recorded yet.');

    held.release(jsonResponse({ ok: true, outcomes: [] }));
    await settle();

    if (confirmation) expect(screen.queryByText(confirmation)).toBeNull();
    // It was sent. Left in the box under B it reads as unsent, and one more
    // click would post it against B.
    if (draft) expect(draft()).toBe('');
    expect(screen.queryByText(PREVIOUS_FAILED)).toBeNull();
    expectNothingOfAthleteA();
    expect(screen.getByText('No medical administrative status recorded yet.')).toBeTruthy();
  });

  test('outcomes loaded late for the previous athlete are dropped, with no error under the new one', async () => {
    const held = heldResponse();
    const fetchMock = jest.fn(async (url: string) => {
      const key = String(url);
      if (key.includes('/decision-outcomes')) return held.promise;
      if (key.includes('/api/pilot/athletes/list')) return jsonResponse({ items: [] });
      if (key.includes('athleteId=ath-b')) {
        if (key.includes('/medical-status')) return jsonResponse({ status: null });
        if (key.includes('/recommendations')) return jsonResponse({ recommendations: [] });
        if (key.includes('/decisions')) return jsonResponse({ decisions: [] });
        return jsonResponse({ nearMisses: [] });
      }
      if (key.includes('/medical-status')) return jsonResponse({ status: A_STATUS });
      if (key.includes('/recommendations')) return jsonResponse({ recommendations: [A_RECOMMENDATION] });
      if (key.includes('/decisions')) return jsonResponse({ decisions: [A_DECISION] });
      return jsonResponse({ nearMisses: [A_NEAR_MISS] });
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    await openAthleteA();

    fireEvent.click(screen.getByRole('button', { name: 'Load Outcomes' }));
    switchToB();
    await screen.findByText('No medical administrative status recorded yet.');

    held.release(jsonResponse({ error: 'OUTCOMES-ERROR-FOR-A' }, false));
    await settle();

    expect(screen.queryByText(/OUTCOMES-ERROR-FOR-A/)).toBeNull();
    expect(screen.queryByText(PREVIOUS_FAILED)).toBeNull();
  });

  test('switching to no athlete clears the previous athlete’s error line', async () => {
    installSwitchFetch({ post: () => jsonResponse({ error: 'SERVER-TEXT-ABOUT-ATHLETE-A' }, false) });
    await openAthleteA();
    fireEvent.click(screen.getByRole('button', { name: 'Set Status' }));
    await screen.findByText(/SERVER-TEXT-ABOUT-ATHLETE-A/);

    fireEvent.change(screen.getByPlaceholderText('athlete-id'), { target: { value: '' } });

    await waitFor(() => expect(screen.queryByText(/SERVER-TEXT-ABOUT-ATHLETE-A/)).toBeNull());
  });

  /* -------------------------------------------------------------------------
     DRAFTS BELONG TO THE ATHLETE THEY WERE WRITTEN FOR.

     Every form on this page sends whatever is in its boxes with the athlete
     selected when the button is pressed. Before this, nothing emptied a box on
     a switch: a Message Home written about athlete A went to athlete B's
     family with one click; "Cleared" plus A's physician reference could be
     set on B; A's incident could be filed against B. One row per form.
     ----------------------------------------------------------------------- */

  function field<T extends HTMLElement>(label: string, sectionHeading?: string): T {
    if (!sectionHeading) return screen.getByLabelText(label) as T;
    const section = screen.getByRole('heading', { name: sectionHeading }).closest('section') as HTMLElement;
    return within(section).getByLabelText(label) as T;
  }

  function type(label: string, value: string, sectionHeading?: string) {
    fireEvent.change(field(label, sectionHeading), { target: { value } });
  }

  function posts(fetchMock: jest.Mock): Array<{ url: string; body: Record<string, unknown> }> {
    return fetchMock.mock.calls
      .filter((c) => (c[1] as RequestInit | undefined)?.method === 'POST')
      .map((c) => ({ url: String(c[0]), body: JSON.parse(String((c[1] as RequestInit).body)) as Record<string, unknown> }));
  }

  const A_TEXT = 'WRITTEN-ABOUT-ATHLETE-A';

  /**
   * `fill` writes a draft about athlete A without submitting. `values` reads
   * every box of that form back. `press` presses the form's button.
   * `defaults` is what an untouched form holds.
   */
  const FORMS: Array<{
    name: string;
    whatCouldGoWrong: string;
    fill: () => void;
    values: () => string[];
    defaults: string[];
    press: () => void;
    /** False for the one form whose draft is deliberately NOT kept. */
    keptForItsAthlete?: boolean;
  }> = [
    {
      name: 'Message Home',
      whatCouldGoWrong: 'a message about A is sent to B’s family',
      fill: () => type('Message', A_TEXT),
      values: () => [field<HTMLTextAreaElement>('Message').value],
      defaults: [''],
      press: () => fireEvent.click(screen.getByRole('button', { name: 'Send to Family' })),
    },
    {
      name: 'Behavior & Habit Note',
      whatCouldGoWrong: 'a note about A is logged on B’s record',
      fill: () => type('Note', A_TEXT),
      values: () => [field<HTMLTextAreaElement>('Note').value],
      defaults: [''],
      press: () => fireEvent.click(screen.getByRole('button', { name: 'Log Note' })),
    },
    {
      name: 'Report Incident',
      whatCouldGoWrong: 'A’s incident is filed against B, into the escalation queue',
      fill: () => {
        type('What happened', A_TEXT);
        type('Severity', 'critical', 'Report Incident');
        type('When it happened (optional, if not today)', '2026-08-05');
      },
      values: () => [
        field<HTMLTextAreaElement>('What happened').value,
        field<HTMLSelectElement>('Severity', 'Report Incident').value,
        field<HTMLInputElement>('When it happened (optional, if not today)').value,
      ],
      defaults: ['', 'high', ''],
      press: () => fireEvent.click(screen.getByRole('button', { name: 'File Incident Report' })),
    },
    {
      name: 'Record Decision',
      whatCouldGoWrong: 'a decision about A is recorded for B',
      fill: () => {
        type('Decision text', A_TEXT);
        type('Expected outcome', A_TEXT, 'Decisions');
        type('Link to recommendation (optional)', 'rec-a');
      },
      values: () => [
        field<HTMLTextAreaElement>('Decision text').value,
        field<HTMLTextAreaElement>('Expected outcome', 'Decisions').value,
        field<HTMLSelectElement>('Link to recommendation (optional)').value,
      ],
      defaults: ['', '', ''],
      press: () => fireEvent.click(screen.getByRole('button', { name: 'Record Decision' })),
    },
    {
      name: 'Flag Near-Miss',
      whatCouldGoWrong: 'A’s near-miss is flagged on B',
      fill: () => {
        type('Description', A_TEXT);
        type('Severity', 'critical', 'Near-Misses');
        type('Related decision (optional)', 'dec-a');
      },
      values: () => [
        field<HTMLTextAreaElement>('Description').value,
        field<HTMLSelectElement>('Severity', 'Near-Misses').value,
        field<HTMLSelectElement>('Related decision (optional)').value,
      ],
      defaults: ['', 'low', ''],
      press: () => fireEvent.click(screen.getByRole('button', { name: 'Flag Near-Miss' })),
    },
    {
      name: 'Set Status (medical)',
      whatCouldGoWrong: '"Cleared" and A’s physician reference are set on B',
      fill: () => {
        type('New status', 'cleared');
        type('Source reference (optional)', A_TEXT);
      },
      values: () => [
        field<HTMLSelectElement>('New status').value,
        field<HTMLInputElement>('Source reference (optional)').value,
      ],
      defaults: ['pending', ''],
      press: () => fireEvent.click(screen.getByRole('button', { name: 'Set Status' })),
      keptForItsAthlete: false,
    },
    {
      name: 'Evaluate a Decision Outcome',
      whatCouldGoWrong: 'A’s observation ids and notes are attached to a decision chosen under B',
      fill: () => {
        type('Decision', 'dec-a');
        type('Match state', 'miss');
        type('Observation IDs (comma-separated)', 'obs-of-athlete-a');
        type('Notes', A_TEXT);
      },
      values: () => [
        field<HTMLSelectElement>('Decision').value,
        field<HTMLSelectElement>('Match state').value,
        field<HTMLInputElement>('Observation IDs (comma-separated)').value,
        field<HTMLTextAreaElement>('Notes').value,
      ],
      defaults: ['', 'match', '', ''],
      press: () => fireEvent.click(screen.getByRole('button', { name: 'Evaluate Outcome' })),
    },
  ];

  /** Nothing A wrote may be in any request made while B is selected. */
  function expectNoRequestCarriesAthleteA(fetchMock: jest.Mock) {
    for (const post of posts(fetchMock)) {
      const sent = JSON.stringify(post.body);
      expect(sent).not.toContain(A_TEXT);
      expect(sent).not.toContain('obs-of-athlete-a');
      expect(sent).not.toContain('rec-a');
      expect(sent).not.toContain('dec-a');
      expect(sent).not.toContain('cleared');
      expect(sent).not.toContain('critical');
      expect(sent).not.toContain('2026-08-05');
    }
  }

  describe.each(FORMS)('$name: so that never $whatCouldGoWrong', ({ fill, values, defaults, press, keptForItsAthlete }) => {
    test('after a switch that succeeds, the form is empty and pressing its button sends nothing of the previous athlete', async () => {
      const fetchMock = installSwitchFetch();
      await openAthleteA();
      fill();
      expect(values()).not.toEqual(defaults);

      switchToB();
      await screen.findByText('No medical administrative status recorded yet.');

      expect(values()).toEqual(defaults);
      press();
      await settle();
      expectNoRequestCarriesAthleteA(fetchMock);
    });

    test('after a switch that FAILS, the same', async () => {
      const fetchMock = installSwitchFetch({ readB: () => jsonResponse({ error: 'Service unavailable' }, false) });
      await openAthleteA();
      fill();

      switchToB();
      await screen.findByText(/medical administrative status could not be read/i);

      expect(values()).toEqual(defaults);
      press();
      await settle();
      expectNoRequestCarriesAthleteA(fetchMock);
    });

    test('while the new athlete is still loading, the same -- there is no window in which the old draft can be sent', async () => {
      const fetchMock = installSwitchFetch({ readB: () => new Promise<Response>(() => {}) });
      await openAthleteA();
      fill();

      switchToB();
      // No waiting for anything: the very next thing the coach does is press.
      expect(values()).toEqual(defaults);
      press();
      await settle();
      expectNoRequestCarriesAthleteA(fetchMock);
    });

    test('on return to the athlete it was written for: kept, even after typing under the other athlete -- except the medical status form, which always starts over', async () => {
      // The ID box changes the selection on every keystroke, and a coach who
      // picks the wrong name and picks back has not thrown their writing away.
      // The medical form is the exception: a "Cleared" left selected from an
      // earlier visit is one click from being set.
      installSwitchFetch();
      await openAthleteA();
      fill();
      const written = values();

      switchToB();
      await screen.findByText('No medical administrative status recorded yet.');
      // One slot with an owner would lose A's draft right here.
      type('Note', 'typed for B');
      fireEvent.change(screen.getByPlaceholderText('athlete-id'), { target: { value: 'ath-a' } });
      await screen.findByText(/ref-for-athlete-a/);

      expect(values()).toEqual(keptForItsAthlete === false ? defaults : written);
    });
  });

  test('a message typed for A and sent from A still goes to A, with A’s text', async () => {
    // The other direction: ownership must not stop the ordinary send.
    const fetchMock = installSwitchFetch();
    await openAthleteA();

    type('Message', A_TEXT);
    fireEvent.click(screen.getByRole('button', { name: 'Send to Family' }));

    await screen.findByText('Sent to the family.');
    expect(posts(fetchMock)).toEqual([
      {
        url: expect.stringContaining('/api/pilot/intake/domain-upsert'),
        body: { entity_type: 'coach_note', athlete_id: 'ath-a', payload: { note_type: 'parent_message', note_text: A_TEXT } },
      },
    ]);
  });

  test('typing an id that passes through another valid id: each id keeps its own draft and sends only its own', async () => {
    // "ath-a" is a real athlete and so is "ath-ab": the box selects "ath-a" on
    // the way to "ath-ab", and back again on a backspace.
    const fetchMock = installSwitchFetch();
    render(<DecisionLoopReviewPage />);
    const idBox = await screen.findByPlaceholderText('athlete-id');

    fireEvent.change(idBox, { target: { value: 'ath-a' } });
    await screen.findByText('Message Home');
    type('Message', A_TEXT);

    fireEvent.change(idBox, { target: { value: 'ath-ab' } });
    expect(field<HTMLTextAreaElement>('Message').value).toBe('');
    fireEvent.click(screen.getByRole('button', { name: 'Send to Family' }));
    await settle();
    expect(posts(fetchMock)).toHaveLength(0);

    type('Message', 'written for ath-ab');
    fireEvent.change(idBox, { target: { value: 'ath-a' } });
    // Back on ath-a: its own draft, never ath-ab's.
    expect(field<HTMLTextAreaElement>('Message').value).toBe(A_TEXT);
    fireEvent.change(idBox, { target: { value: 'ath-ab' } });
    expect(field<HTMLTextAreaElement>('Message').value).toBe('written for ath-ab');

    fireEvent.click(screen.getByRole('button', { name: 'Send to Family' }));
    await waitFor(() => expect(posts(fetchMock)).toHaveLength(1));
    expect(posts(fetchMock)[0].body).toEqual({
      entity_type: 'coach_note',
      athlete_id: 'ath-ab',
      payload: { note_type: 'parent_message', note_text: 'written for ath-ab' },
    });
  });

  test('a late success for the previous athlete does not wipe what the coach has typed for the new one', async () => {
    const held = heldResponse();
    installSwitchFetch({ post: () => held.promise });
    await openAthleteA();
    type('Message', A_TEXT);
    fireEvent.click(screen.getByRole('button', { name: 'Send to Family' }));

    switchToB();
    await screen.findByText('No medical administrative status recorded yet.');
    type('Message', 'written for B');

    held.release(jsonResponse({ ok: true }));
    await settle();

    expect(field<HTMLTextAreaElement>('Message').value).toBe('written for B');
    expect(screen.queryByText('Sent to the family.')).toBeNull();
  });

  test('a late success clears only what it sent: text retyped for the same athlete since is kept', async () => {
    const held = heldResponse();
    installSwitchFetch({ post: () => held.promise });
    await openAthleteA();
    type('Note', 'first note');
    fireEvent.click(screen.getByRole('button', { name: 'Log Note' }));
    type('Note', 'a second note, typed while the first was still out');

    held.release(jsonResponse({ ok: true }));
    await screen.findByText('Note logged.');

    expect(field<HTMLTextAreaElement>('Note').value).toBe('a second note, typed while the first was still out');
  });

  test.each([
    ['Report Incident', 'What happened', 'File Incident Report', 'Filing…', 'Incident filed -- it is now in the escalation queue.'],
    ['Behavior Note', 'Note', 'Log Note', 'Logging…', 'Note logged.'],
    ['Message Home', 'Message', 'Send to Family', 'Sending…', 'Sent to the family.'],
  ])('%s still out for the previous athlete does not lock the new athlete’s form, and stays locked for its own', async (_name, label, button, busyLabel, confirmation) => {
    const held = heldResponse();
    const fetchMock = installSwitchFetch({ post: () => held.promise });
    await openAthleteA();
    type(label, A_TEXT);
    fireEvent.click(screen.getByRole('button', { name: button }));
    await screen.findByRole('button', { name: busyLabel });

    switchToB();
    await screen.findByText('No medical administrative status recorded yet.');
    expect(screen.getByRole('button', { name: button })).not.toBeDisabled();

    // Back on A, the one that is out is still out: no second submission.
    fireEvent.change(screen.getByPlaceholderText('athlete-id'), { target: { value: 'ath-a' } });
    const forA = await screen.findByRole('button', { name: busyLabel });
    expect(forA).toBeDisabled();
    fireEvent.click(forA);
    expect(posts(fetchMock)).toHaveLength(1);

    held.release(jsonResponse({ ok: true, escalation_id: 'esc-1' }));
    await screen.findByText(confirmation);
    expect(screen.getByRole('button', { name: button })).not.toBeDisabled();
  });

  /* -------------------------------------------------------------------------
     Never, in any commit: not "gone by the time the test looks".
     ----------------------------------------------------------------------- */

  const OF_ATHLETE_A = [
    'ref-for-athlete-a',
    'Athlete A: return to light sparring.',
    'Athlete A: cleared for pad work.',
    'Athlete A: slipped on the apron.',
  ];

  function commitsShowingAUnder(selected: string) {
    return committed
      .filter((commit) => commit.selected === selected)
      .filter((commit) => OF_ATHLETE_A.some((text) => commit.text.includes(text)));
  }

  test.each([
    ['the ID box', () => fireEvent.change(screen.getByPlaceholderText('athlete-id'), { target: { value: 'ath-b' } })],
    ['the dropdown', () => fireEvent.change(screen.getByLabelText('Athlete'), { target: { value: 'ath-b' } })],
  ])('switching by %s: no commit ever has the new athlete selected with the previous athlete’s records on screen', async (_how, doSwitch) => {
    installSwitchFetch();
    await openAthleteA();
    await screen.findByRole('option', { name: 'Athlete B' });
    // The probe is live: it saw A's records under A.
    expect(commitsShowingAUnder('ath-a').length).toBeGreaterThan(0);
    committed.length = 0;

    doSwitch();
    await screen.findByText('No medical administrative status recorded yet.');

    expect(committed.some((commit) => commit.selected === 'ath-b')).toBe(true);
    expect(commitsShowingAUnder('ath-b')).toEqual([]);
  });

  test('no commit has the new athlete selected with the previous athlete’s error line, confirmation or status still up', async () => {
    installSwitchFetch({ post: () => jsonResponse({ error: 'SERVER-TEXT-ABOUT-ATHLETE-A' }, false) });
    await openAthleteA();
    fireEvent.click(screen.getByRole('button', { name: 'Set Status' }));
    await screen.findByText(/SERVER-TEXT-ABOUT-ATHLETE-A/);
    committed.length = 0;

    switchToB();
    await screen.findByText('No medical administrative status recorded yet.');

    const underB = committed.filter((commit) => commit.selected === 'ath-b');
    expect(underB.length).toBeGreaterThan(0);
    expect(underB.filter((commit) => commit.text.includes('SERVER-TEXT-ABOUT-ATHLETE-A'))).toEqual([]);
  });

  test('a write for the previous athlete that resolves in the same tick as the switch is not treated as the new selection’s', async () => {
    // The refs move in the selection event, not in an effect after it.
    const held = heldResponse();
    installSwitchFetch({ post: () => held.promise });
    await openAthleteA();
    fireEvent.change(screen.getByLabelText('What happened'), { target: { value: 'incident for A' } });
    fireEvent.click(screen.getByRole('button', { name: 'File Incident Report' }));

    await act(async () => {
      fireEvent.change(screen.getByPlaceholderText('athlete-id'), { target: { value: 'ath-b' } });
      held.release(jsonResponse({ ok: true, escalation_id: 'esc-1' }));
      await Promise.resolve();
    });
    await screen.findByText('No medical administrative status recorded yet.');
    await settle();

    expect(screen.queryByText('Incident filed -- it is now in the escalation queue.')).toBeNull();
    expect(committed.filter((c) => c.selected === 'ath-b' && c.text.includes('Incident filed'))).toEqual([]);
  });

  /* -------------------------------------------------------------------------
     A 200 that does not carry the envelope is not "nothing on record".
     ----------------------------------------------------------------------- */

  const unparseable = () => ({ ok: true, json: async () => { throw new SyntaxError('Unexpected token <'); } }) as unknown as Response;

  /** B's four reads, each overridable by route fragment. */
  function installReadsForB(overrides: Record<string, () => Response>) {
    const fetchMock = jest.fn(async (url: string) => {
      const key = String(url);
      if (key.includes('/api/pilot/athletes/list')) return jsonResponse({ items: [] });
      for (const [fragment, responder] of Object.entries(overrides)) {
        if (key.includes(fragment)) return responder();
      }
      if (key.includes('/medical-status')) return jsonResponse({ status: null });
      if (key.includes('/recommendations')) return jsonResponse({ recommendations: [] });
      if (key.includes('/decisions?')) return jsonResponse({ decisions: [] });
      if (key.includes('/near-misses')) return jsonResponse({ nearMisses: [] });
      throw new Error(`Unexpected fetch: ${key}`);
    });
    global.fetch = fetchMock as unknown as typeof fetch;
  }

  const MALFORMED_READS: Array<[string, string, () => Response]> = [
    ['medical status: body will not parse', '/medical-status', unparseable],
    ['medical status: no `status` key', '/medical-status', () => jsonResponse({ ok: true })],
    ['medical status: `status` is a string', '/medical-status', () => jsonResponse({ status: 'cleared' })],
    ['medical status: a row with an unknown status value', '/medical-status', () => jsonResponse({ status: { status: 'fine' } })],
    ['medical status: body is an array', '/medical-status', () => jsonResponse([])],
    ['recommendations: body will not parse', '/recommendations', unparseable],
    ['recommendations: no list', '/recommendations', () => jsonResponse({ ok: true })],
    ['recommendations: list is null', '/recommendations', () => jsonResponse({ recommendations: null })],
    ['recommendations: a null entry', '/recommendations', () => jsonResponse({ recommendations: [null] })],
    ['decisions: body will not parse', '/decisions?', unparseable],
    ['decisions: no list', '/decisions?', () => jsonResponse({})],
    ['near-misses: body will not parse', '/near-misses', unparseable],
    ['near-misses: list is an object', '/near-misses', () => jsonResponse({ nearMisses: {} })],
    ['recommendations: a row with no text', '/recommendations', () => jsonResponse({ recommendations: [{ recommendation_id: 'r1', status: 'provisional' }] })],
    ['decisions: a row with no text', '/decisions?', () => jsonResponse({ decisions: [{ decision_id: 'd1' }] })],
    ['near-misses: a row with no description', '/near-misses', () => jsonResponse({ nearMisses: [{ near_miss_id: 'n1', severity: 'low' }] })],
  ];

  test.each(MALFORMED_READS)('%s: all four panels are unreadable, and none says "none on record"', async (_name, fragment, responder) => {
    installReadsForB({ [fragment]: responder });
    render(<DecisionLoopReviewPage />);
    fireEvent.change(await screen.findByPlaceholderText('athlete-id'), { target: { value: 'ath-b' } });

    expect(await screen.findByText(/medical administrative status could not be read/i)).toBeTruthy();
    expect(screen.getByText(/Recommendations could not be read/i)).toBeTruthy();
    expect(screen.getByText(/Decisions could not be read/i)).toBeTruthy();
    expect(screen.getByText(/Near-misses could not be read/i)).toBeTruthy();
    expect(screen.queryByText('No medical administrative status recorded yet.')).toBeNull();
    expect(screen.queryByText('No recommendations yet.')).toBeNull();
    expect(screen.queryByText('No decisions recorded yet.')).toBeNull();
    expect(screen.queryByText('No near-misses flagged yet.')).toBeNull();
  });

  test('outcomes that will not parse are an error, not "No outcomes evaluated yet."', async () => {
    const fetchMock = jest.fn(async (url: string) => {
      const key = String(url);
      if (key.includes('/decision-outcomes')) return unparseable();
      if (key.includes('/api/pilot/athletes/list')) return jsonResponse({ items: [] });
      if (key.includes('/medical-status')) return jsonResponse({ status: A_STATUS });
      if (key.includes('/recommendations')) return jsonResponse({ recommendations: [A_RECOMMENDATION] });
      if (key.includes('/decisions')) return jsonResponse({ decisions: [A_DECISION] });
      return jsonResponse({ nearMisses: [A_NEAR_MISS] });
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    await openAthleteA();

    fireEvent.click(screen.getByRole('button', { name: 'Load Outcomes' }));

    expect(await screen.findByText('Failed to load decision outcomes.')).toBeTruthy();
    expect(screen.queryByText('No outcomes evaluated yet.')).toBeNull();
  });

  test('no commit has the new athlete selected with the previous athlete’s "Incident filed" confirmation up', async () => {
    installSwitchFetch();
    await openAthleteA();
    fireEvent.change(screen.getByLabelText('What happened'), { target: { value: 'incident for A' } });
    fireEvent.click(screen.getByRole('button', { name: 'File Incident Report' }));
    await screen.findByText('Incident filed -- it is now in the escalation queue.');
    committed.length = 0;

    switchToB();
    await screen.findByText('No medical administrative status recorded yet.');

    const underB = committed.filter((commit) => commit.selected === 'ath-b');
    expect(underB.length).toBeGreaterThan(0);
    expect(underB.filter((commit) => commit.text.includes('Incident filed'))).toEqual([]);
  });

  test('"Loading…" does not stick when the coach clears the selection while a read is out', async () => {
    installSwitchFetch({ readB: () => new Promise<Response>(() => {}) });
    await openAthleteA();
    switchToB();
    await screen.findByText('Loading…');

    fireEvent.change(screen.getByPlaceholderText('athlete-id'), { target: { value: '' } });

    await waitFor(() => expect(screen.queryByText('Loading…')).toBeNull());
    expect(screen.getByText('Select or enter an athlete to review their decision loop.')).toBeTruthy();
  });

  test('a late answer for the previous athlete does not switch off the new athlete’s "Loading…"', async () => {
    let releaseA: (() => void) | undefined;
    const heldA = new Promise<Response>((resolve) => {
      releaseA = () => resolve(jsonResponse({}));
    });
    installSwitchFetch({ readA: () => heldA, readB: () => new Promise<Response>(() => {}) });
    render(<DecisionLoopReviewPage />);
    const input = await screen.findByPlaceholderText('athlete-id');
    fireEvent.change(input, { target: { value: 'ath-a' } });
    fireEvent.change(input, { target: { value: 'ath-b' } });
    await screen.findByText('Loading…');

    releaseA?.();
    await settle();

    expect(screen.getByText('Loading…')).toBeTruthy();
  });

  test('an incident report for A that fails after the coach has typed for B is still in A’s box when they go back', async () => {
    // The page says "go back to them and check". The text has to be there.
    const held = heldResponse();
    installSwitchFetch({ post: () => held.promise });
    await openAthleteA();
    type('What happened', 'Athlete A was struck after the bell.');
    fireEvent.click(screen.getByRole('button', { name: 'File Incident Report' }));

    switchToB();
    await screen.findByText('No medical administrative status recorded yet.');
    type('Note', 'typed for B');
    held.release(jsonResponse({ error: 'Service unavailable' }, false));
    await screen.findByText(/Something you submitted for the athlete you were on before did not go through/);

    fireEvent.change(screen.getByPlaceholderText('athlete-id'), { target: { value: 'ath-a' } });
    await screen.findByText(/ref-for-athlete-a/);
    expect(field<HTMLTextAreaElement>('What happened').value).toBe('Athlete A was struck after the bell.');
    // And B's note is B's.
    expect(field<HTMLTextAreaElement>('Note').value).toBe('');
  });

  test('a message that was sent late is not left in A’s box to be sent a second time', async () => {
    const held = heldResponse();
    const fetchMock = installSwitchFetch({ post: () => held.promise });
    await openAthleteA();
    type('Message', A_TEXT);
    fireEvent.click(screen.getByRole('button', { name: 'Send to Family' }));

    switchToB();
    await screen.findByText('No medical administrative status recorded yet.');
    held.release(jsonResponse({ ok: true }));
    await settle();

    fireEvent.change(screen.getByPlaceholderText('athlete-id'), { target: { value: 'ath-a' } });
    await screen.findByText(/ref-for-athlete-a/);
    expect(field<HTMLTextAreaElement>('Message').value).toBe('');
    fireEvent.click(screen.getByRole('button', { name: 'Send to Family' }));
    await settle();
    expect(posts(fetchMock)).toHaveLength(1);
  });

  test('a kept link to a record that is not on screen is not sent: what the selector shows is what goes', async () => {
    // On A: a recommendation and a decision chosen. Away and back, and this
    // time A's read fails, so the lists are empty and the selectors read
    // "None". The kept ids must not ride along unseen.
    let failA = false;
    const fetchMock = installSwitchFetch({
      readA: () => {
        if (failA) throw new Error('Network request failed');
        return jsonResponse({});
      },
    });
    await openAthleteA();
    type('Link to recommendation (optional)', 'rec-a');
    type('Related decision (optional)', 'dec-a');
    type('Decision', 'dec-a');
    type('Decision text', 'decision for A');
    type('Expected outcome', 'outcome for A', 'Decisions');
    type('Description', 'near miss for A');

    switchToB();
    await screen.findByText('No medical administrative status recorded yet.');
    failA = true;
    fireEvent.change(screen.getByPlaceholderText('athlete-id'), { target: { value: 'ath-a' } });
    await screen.findByText(/medical administrative status could not be read/i);

    expect(field<HTMLSelectElement>('Link to recommendation (optional)').value).toBe('');
    fireEvent.click(screen.getByRole('button', { name: 'Record Decision' }));
    fireEvent.click(screen.getByRole('button', { name: 'Flag Near-Miss' }));
    fireEvent.click(screen.getByRole('button', { name: 'Evaluate Outcome' }));
    await waitFor(() => expect(posts(fetchMock)).toHaveLength(2));
    await settle();

    const sent = posts(fetchMock);
    expect(sent).toHaveLength(2);
    expect(sent.find((post) => post.url.includes('/shadow/decisions'))?.body.recommendationId).toBeUndefined();
    expect(sent.find((post) => post.url.includes('/shadow/near-misses'))?.body.decisionId).toBeUndefined();
    expect(sent.some((post) => post.url.includes('/decision-outcomes'))).toBe(false);
  });

  test('and the same link IS sent once its record is back on screen', async () => {
    const fetchMock = installSwitchFetch();
    await openAthleteA();
    type('Link to recommendation (optional)', 'rec-a');
    type('Decision text', 'decision for A');
    type('Expected outcome', 'outcome for A', 'Decisions');

    switchToB();
    await screen.findByText('No medical administrative status recorded yet.');
    fireEvent.change(screen.getByPlaceholderText('athlete-id'), { target: { value: 'ath-a' } });
    await screen.findByText(/ref-for-athlete-a/);

    expect(field<HTMLSelectElement>('Link to recommendation (optional)').value).toBe('rec-a');
    fireEvent.click(screen.getByRole('button', { name: 'Record Decision' }));
    await waitFor(() => expect(posts(fetchMock)).toHaveLength(1));
    expect(posts(fetchMock)[0].body).toMatchObject({ athleteId: 'ath-a', recommendationId: 'rec-a', decisionText: 'decision for A' });
  });

  test.each([
    ['Set Status', () => { type('Source reference (optional)', 'note for A'); fireEvent.click(screen.getByRole('button', { name: 'Set Status' })); },
      () => field<HTMLInputElement>('Source reference (optional)').value],
    ['Record Decision', () => { type('Decision text', 'decision for A'); type('Expected outcome', 'outcome', 'Decisions'); fireEvent.click(screen.getByRole('button', { name: 'Record Decision' })); },
      () => field<HTMLTextAreaElement>('Decision text').value + field<HTMLTextAreaElement>('Expected outcome', 'Decisions').value],
    ['Flag Near-Miss', () => { type('Description', 'near miss for A'); fireEvent.click(screen.getByRole('button', { name: 'Flag Near-Miss' })); },
      () => field<HTMLTextAreaElement>('Description').value],
    ['Evaluate Outcome', () => { type('Decision', 'dec-a'); type('Observation IDs (comma-separated)', 'obs-1'); type('Notes', 'notes for A'); fireEvent.click(screen.getByRole('button', { name: 'Evaluate Outcome' })); },
      () => field<HTMLInputElement>('Observation IDs (comma-separated)').value + field<HTMLTextAreaElement>('Notes').value],
  ])('%s: what was sent is emptied once the server has it', async (_name, submit, sentFields) => {
    const fetchMock = installSwitchFetch({ post: () => jsonResponse({ ok: true, outcomes: [] }) });
    await openAthleteA();

    submit();

    await waitFor(() => expect(posts(fetchMock).length).toBeGreaterThan(0));
    await waitFor(() => expect(sentFields()).toBe(''));
  });
});
