/**
 * @jest-environment jsdom
 */

/*
 * The coach screen over sparring exposure. The route owns authorization and
 * validation (route.test.ts); what this page must hold:
 *
 *   1. It posts what the coach entered, in the route's field names, and never
 *      an organization, supervising account, device field or segment number.
 *   2. It shows only stored values and the route's raw counts: no score,
 *      percentage, limit or clearance language.
 *   3. A failed read is never rendered as "no sparring".
 *   4. A refused save shows the route's own reason and is not reported as saved.
 */

import { act, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';

import CoachSparringExposurePage, { CONTACT_STAGES } from './page';
// The shared ladder (vocabularies.ts imports nothing server-side, so jsdom can load it).
import { VOCABULARIES } from '@/src/server/pilot/contentImport/vocabularies';

jest.mock('@/components/RoleStandaloneView', () => ({
  __esModule: true,
  default: ({ children }: { readonly children: ReactNode }) => <div>{children}</div>,
}));

const NO_CAP = { cap_state: 'none', cap: null, hard_open_days_in_7: 0, through_day: '2026-10-03' };
const CAP = { highest_allowed_stage: 'controlled_sparring', max_hard_open_sessions_per_7_days: 1, set_by_name: 'Coach J' };

const ROSTER = [
  { athlete_id: 'ath-1', full_name: 'Rosa Delgado' },
  { athlete_id: 'ath-2', full_name: 'Marcus Webb' },
];

function entry(overrides: Record<string, unknown> = {}) {
  return {
    exposure_id: 'e1',
    sparring_day: '2026-10-02',
    segment_number: 1,
    sparring_type: 'technical',
    time_under_impact_sec: 75,
    round_equivalent: '2.00',
    headgear_worn: true,
    glove_oz: 16,
    coach_observed_intensity: 'light',
    coach_observed_head_contact: 'incidental',
    athlete_presentation: 'normal',
    coach_note: 'Kept hands up.',
    stopped_early: false,
    stop_reason: null,
    ...overrides,
  };
}

interface Stubs {
  rosterOk?: boolean;
  recentOk?: boolean;
  entries?: unknown[];
  truncated?: boolean;
  postStatus?: number;
  postError?: string;
  /** cap_check on the GET; 'omit' leaves the key out. */
  capCheck?: unknown;
  /** cap_check on the POST reply; 'omit' leaves the key out. */
  postCheck?: unknown;
}

let posts: Array<Record<string, unknown>>;
let gets: string[];

function installFetch(stubs: Stubs = {}) {
  posts = [];
  gets = [];
  const fetchMock = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/api/pilot/coach/athletes')) {
      return { ok: stubs.rosterOk ?? true, status: 200, json: async () => ({ items: ROSTER }) } as Response;
    }
    if (url.includes('/api/pilot/coach/sparring-exposure')) {
      if (init?.method === 'POST') {
        posts.push(JSON.parse(String(init.body)));
        const status = stubs.postStatus ?? 201;
        return {
          ok: status < 300,
          status,
          json: async () => (status < 300
            ? { entry: {}, ...(stubs.postCheck === 'omit' ? {} : { cap_check: stubs.postCheck ?? NO_CAP }) }
            : { error: stubs.postError }),
        } as Response;
      }
      gets.push(url);
      return {
        ok: stubs.recentOk ?? true,
        status: stubs.recentOk === false ? 500 : 200,
        json: async () => ({
          window_days: 28,
          since_day: '2026-09-06',
          entries: stubs.entries ?? [entry()],
          entries_truncated: stubs.truncated ?? false,
          counts: {
            total_segments: 3,
            total_time_under_impact_sec: 185,
            segments_by_type: { hard: 1, play: 0, technical: 2, game: 0, conditioned: 0 },
          },
          stop_rules: [{ universal_rule_id: 'ust_bleeding', ordinal: 1, condition_text: 'Bleeding', rule_kind: 'safety' }],
          ...(stubs.capCheck === 'omit' ? {} : { cap_check: stubs.capCheck ?? NO_CAP }),
        }),
      } as Response;
    }
    throw new Error(`unexpected fetch ${url}`);
  });
  global.fetch = fetchMock as unknown as typeof fetch;
}

async function renderAndPick(stubs: Stubs = {}) {
  installFetch(stubs);
  await act(async () => {
    render(<CoachSparringExposurePage />);
  });
  await act(async () => {
    fireEvent.change(screen.getByLabelText('Which athlete'), { target: { value: 'ath-1' } });
  });
}

function choose(labelText: string, value: string) {
  fireEvent.change(screen.getByLabelText(labelText), { target: { value } });
}

function fillRequired() {
  choose('Type of sparring', 'hard');
  fireEvent.change(screen.getByLabelText('Minutes'), { target: { value: '1' } });
  fireEvent.change(screen.getByLabelText('Seconds'), { target: { value: '5' } });
  choose('Intensity you saw', 'firm');
  choose('Head contact you saw', 'regular');
  choose('After sparring, the athlete looked', 'slowed');
}

describe('coach sparring record screen', () => {
  test('reads the chosen athlete through the route and shows raw counts and entries', async () => {
    await renderAndPick();
    expect(gets).toEqual([expect.stringContaining('/api/pilot/coach/sparring-exposure?athlete_id=ath-1&days=28')]);
    expect(screen.getByTestId('spar-counts').textContent).toContain('3 segments, 3:05 in live exchanges.');
    expect(screen.getByTestId('spar-counts').textContent).toContain('Technical: 2, Hard: 1');
    expect(screen.getByText(/segment 1 · Technical · 1:15 · 2 rounds/)).toBeTruthy();
    expect(screen.getByText('Kept hands up.')).toBeTruthy();
  });

  test('never shows score, percentage, limit or clearance language', async () => {
    await renderAndPick({ entries: [entry(), entry({ exposure_id: 'e2', stopped_early: true, stop_reason: 'Nose bleed' })] });
    // The data region only: the header's own "does not score it, set a limit,
    // or clear anyone" is the disclaimer, not a figure.
    const text = screen.getByText('Recent sparring').closest('section')?.textContent ?? '';
    expect(text).toContain('3 segments');
    expect(text).not.toMatch(/%|score|risk|recommended|clear|limit|safe to/i);
    expect(screen.getByText('Stopped early: Nose bleed')).toBeTruthy();
  });

  test('a failed read says it failed, not that there was no sparring', async () => {
    await renderAndPick({ recentOk: false });
    expect(screen.getByRole('alert').textContent).toContain('This does not mean there was none.');
    expect(screen.queryByText('No sparring recorded in this window.')).toBeNull();
  });

  test('switching athlete never leaves the previous athlete\'s entries on screen', async () => {
    await renderAndPick();
    expect(screen.getByText('Kept hands up.')).toBeTruthy();
    // Marcus's read is still in flight: until it lands, the screen must show
    // loading, not Rosa's record under Marcus's name.
    global.fetch = jest.fn(() => new Promise<Response>(() => {})) as unknown as typeof fetch;
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Which athlete'), { target: { value: 'ath-2' } });
    });
    expect(screen.queryByText('Kept hands up.')).toBeNull();
    expect(screen.getByText('Loading...')).toBeTruthy();
  });

  test('switching athlete clears what was observed, keeping only the day and gear', async () => {
    await renderAndPick();
    fillRequired();
    choose('Headgear (optional)', 'yes');
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Which athlete'), { target: { value: 'ath-2' } });
    });
    expect((screen.getByLabelText('After sparring, the athlete looked') as HTMLSelectElement).value).toBe('');
    expect((screen.getByLabelText('Minutes') as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText('Headgear (optional)') as HTMLSelectElement).value).toBe('yes');
    expect((screen.getByRole('button', { name: 'Save segment' }) as HTMLButtonElement).disabled).toBe(true);
  });

  test('time over 30:00 or with seconds over 59 cannot be saved and says why', async () => {
    await renderAndPick();
    fillRequired();
    const save = screen.getByRole('button', { name: 'Save segment' }) as HTMLButtonElement;
    fireEvent.change(screen.getByLabelText('Minutes'), { target: { value: '30' } });
    fireEvent.change(screen.getByLabelText('Seconds'), { target: { value: '30' } });
    expect(save.disabled).toBe(true);
    expect(screen.getByText('Whole minutes and seconds, from 0:01 up to 30:00.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Seconds'), { target: { value: '0' } });
    expect(save.disabled).toBe(false);
    fireEvent.change(screen.getByLabelText('Minutes'), { target: { value: '1' } });
    fireEvent.change(screen.getByLabelText('Seconds'), { target: { value: '75' } });
    expect(save.disabled).toBe(true);
  });

  test('the athlete picker is locked while a save is in flight', async () => {
    await renderAndPick();
    fillRequired();
    let release: (value: Response) => void = () => {};
    const previous = global.fetch;
    global.fetch = jest.fn((input: RequestInfo | URL, init?: RequestInit) => (init?.method === 'POST'
      ? new Promise<Response>((resolve) => { release = resolve; })
      : (previous as jest.Mock)(input, init))) as unknown as typeof fetch;
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save segment' }));
    });
    expect((screen.getByLabelText('Which athlete') as HTMLSelectElement).disabled).toBe(true);
    expect((screen.getByLabelText('Window') as HTMLSelectElement).disabled).toBe(true);
    // The observation fields too: the reset after the save would discard
    // anything typed for the next segment while this one was in flight.
    expect(screen.getByLabelText('Intensity you saw').matches(':disabled')).toBe(true);
    expect(screen.getByLabelText('Note (optional)').matches(':disabled')).toBe(true);
    await act(async () => {
      release({ ok: true, status: 201, json: async () => ({ entry: {} }) } as Response);
    });
    expect((screen.getByLabelText('Which athlete') as HTMLSelectElement).disabled).toBe(false);
  });

  test('an older read still in flight cannot overwrite the refresh after a save', async () => {
    installFetch();
    const stubbed = global.fetch as jest.Mock;
    // The first entries read hangs until aborted; everything else is the stub.
    let firstRead = true;
    global.fetch = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('sparring-exposure?') && firstRead) {
        firstRead = false;
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
          // Resolves with a stale, empty list later -- unless it was aborted.
          setTimeout(() => _resolve({
            ok: true, status: 200,
            json: async () => ({ entries: [], entries_truncated: false, stop_rules: [],
              counts: { total_segments: 0, total_time_under_impact_sec: 0, segments_by_type: {} } }),
          } as Response), 0);
        });
      }
      return stubbed(input, init);
    }) as unknown as typeof fetch;

    await act(async () => {
      render(<CoachSparringExposurePage />);
    });
    fireEvent.change(screen.getByLabelText('Which athlete'), { target: { value: 'ath-1' } });
    fillRequired();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save segment' }));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    // The post-save read (the stub's list) stands; the stale empty one never lands.
    expect(screen.getByText('Kept hands up.')).toBeTruthy();
    expect(screen.queryByText('No sparring recorded in this window.')).toBeNull();
  });

  test('an empty successful read says none in this window', async () => {
    await renderAndPick({ entries: [] });
    expect(screen.getByText('No sparring recorded in this window.')).toBeTruthy();
  });

  test('a truncated list says so', async () => {
    await renderAndPick({ truncated: true });
    expect(screen.getByText('Showing the latest 1 entries.')).toBeTruthy();
  });

  test('changing the window re-reads with that many days', async () => {
    await renderAndPick();
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Window'), { target: { value: '7' } });
    });
    expect(gets[gets.length - 1]).toContain('days=7');
  });

  test('save stays disabled until the required observations are in', async () => {
    await renderAndPick();
    const save = screen.getByRole('button', { name: 'Save segment' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fillRequired();
    expect(save.disabled).toBe(false);
    fireEvent.click(screen.getByLabelText('Stopped early'));
    expect(save.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('What ended it'), { target: { value: 'Unsteady after a cross' } });
    expect(save.disabled).toBe(false);
  });

  test('posts the route\'s field names and nothing the server owns', async () => {
    await renderAndPick();
    fillRequired();
    fireEvent.change(screen.getByLabelText('Rounds (optional)'), { target: { value: '1.5' } });
    choose('Headgear (optional)', 'yes');
    fireEvent.change(screen.getByLabelText('Glove oz (optional)'), { target: { value: '16' } });
    fireEvent.click(screen.getByLabelText('Stopped early'));
    choose('Stop rule (optional)', 'ust_bleeding');
    fireEvent.change(screen.getByLabelText('What ended it'), { target: { value: 'Nose bleed' } });
    fireEvent.change(screen.getByLabelText('Note (optional)'), { target: { value: 'Stopped by me.' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save segment' }));
    });

    expect(posts).toHaveLength(1);
    expect(posts[0]).toEqual({
      athlete_id: 'ath-1',
      session_date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      sparring_type: 'hard',
      time_under_impact_sec: 65,
      coach_observed_intensity: 'firm',
      coach_observed_head_contact: 'regular',
      athlete_presentation: 'slowed',
      round_equivalent: 1.5,
      headgear_worn: true,
      glove_oz: 16,
      coach_note: 'Stopped by me.',
      stopped_early: true,
      stop_reason: 'Nose bleed',
      stop_rule_id: 'ust_bleeding',
    });
    expect(screen.getByRole('status').textContent).toBe('Saved.');
    // The list was re-read after the save.
    expect(gets).toHaveLength(2);
  });

  test('a refused save shows the route\'s reason and is not reported as saved', async () => {
    await renderAndPick({ postStatus: 400, postError: 'Unsupported session_date: cannot be after today' });
    fillRequired();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save segment' }));
    });
    expect(screen.getByRole('alert').textContent).toBe('Unsupported session_date: cannot be after today');
    expect(screen.queryByRole('status')).toBeNull();
  });

  test('a roster failure is said, not shown as an empty gym', async () => {
    installFetch({ rosterOk: false });
    await act(async () => {
      render(<CoachSparringExposurePage />);
    });
    expect(screen.getByRole('alert').textContent).toContain('could not be loaded');
    expect(screen.queryByText('No athletes are available to you.')).toBeNull();
  });
});

describe('contact stage and the coach-set cap (map item 15)', () => {
  test("the stage choices are the server's ladder, in order", () => {
    expect([...CONTACT_STAGES]).toEqual([...VOCABULARIES.contact_level.values]);
  });

  test('the stage is optional: "Not recorded" sends nothing, a chosen stage is sent and kept for the next round', async () => {
    await renderAndPick();
    fillRequired();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save segment' }));
    });
    expect('contact_stage' in posts[0]).toBe(false);

    fillRequired();
    choose('Contact stage (optional)', 'open_sparring');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save segment' }));
    });
    expect(posts[1].contact_stage).toBe('open_sparring');
    expect((screen.getByLabelText('Contact stage (optional)') as HTMLSelectElement).value).toBe('open_sparring');
  });

  test('a set cap is shown as the coach set it, with the raw gym-day count', async () => {
    await renderAndPick({ capCheck: { cap_state: 'set', cap: CAP, hard_open_days_in_7: 2, through_day: '2026-10-03' } });
    const section = screen.getByTestId('spar-cap').textContent ?? '';
    expect(section).toContain('Highest stage: Controlled sparring');
    expect(section).toContain('At most 1 hard or open sparring sessions in any 7 days (sessions = gym days).');
    expect(screen.getByTestId('spar-hard-open-days').textContent).toMatch(/: 2\.$/);
    expect(section).toContain('A cap never blocks a segment');
  });

  test('no cap set is said plainly', async () => {
    await renderAndPick();
    expect(screen.getByTestId('spar-cap').textContent).toContain('No cap set for this athlete.');
  });

  test.each([
    ['an unknown cap', { cap_state: 'unknown', cap: null, hard_open_days_in_7: 0, through_day: '2026-10-03' }],
    ['a reply without cap_check', 'omit'],
    // Malformed in ONE way only (a "set" cap with no cap), so only that guard can catch it.
    ['a "set" cap_check with no cap', { cap_state: 'set', cap: null, hard_open_days_in_7: 0, through_day: '2026-10-03' }],
    ['a cap_check with a non-numeric count', { cap_state: 'none', cap: null, hard_open_days_in_7: 'two', through_day: '2026-10-03' }],
  ])('%s is "could not be read" -- never "no cap"', async (_label, capCheck) => {
    await renderAndPick({ capCheck });
    const section = screen.getByTestId('spar-cap').textContent ?? '';
    expect(section).toContain('could not be read just now');
    expect(section).not.toContain('No cap set');
  });

  test('a count that could not be taken is said, never shown as 0', async () => {
    await renderAndPick({ capCheck: { cap_state: 'set', cap: CAP, hard_open_days_in_7: null, through_day: '2026-10-03' } });
    expect(screen.getByTestId('spar-hard-open-days').textContent).toContain('could not be counted');
  });

  test('an entry over the cap is SAVED, and the warnings are shown under it', async () => {
    const warnings = [
      { kind: 'stage_above_cap', message: "Above this athlete's cap: recorded at Open sparring. Saved. The coach decides." },
      { kind: 'hard_open_days_over_cap', message: 'Over this athlete\'s cap: 2 ... (sessions = gym days). Saved. The coach decides.' },
    ];
    await renderAndPick({
      postCheck: { cap_state: 'set', cap: CAP, hard_open_days_in_7: 2, through_day: '2026-10-03', warnings },
    });
    fillRequired();
    choose('Contact stage (optional)', 'open_sparring');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save segment' }));
    });
    expect(screen.getByRole('status').textContent).toBe('Saved.');
    const shown = screen.getByTestId('spar-cap-warnings').textContent ?? '';
    expect(shown).toContain('Over the coach-set cap');
    expect(shown).toContain('recorded at Open sparring');
    expect(shown).toContain('sessions = gym days');
  });

  test('within the cap: saved, no warning block', async () => {
    await renderAndPick({
      postCheck: { cap_state: 'set', cap: CAP, hard_open_days_in_7: 1, through_day: '2026-10-03', warnings: [] },
    });
    fillRequired();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save segment' }));
    });
    expect(screen.getByRole('status').textContent).toBe('Saved.');
    expect(screen.queryByTestId('spar-cap-warnings')).toBeNull();
  });

  test('a save reply without a usable cap check says the segment was not checked', async () => {
    await renderAndPick({ postCheck: 'omit' });
    fillRequired();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save segment' }));
    });
    expect(screen.getByText(/was not checked against a cap/)).toBeTruthy();
  });

  test('a recorded stage shows on the entry; the recent section stays counts only', async () => {
    await renderAndPick({ entries: [entry({ contact_stage: 'open_sparring' })] });
    expect(screen.getByText(/segment 1 · Technical · Open sparring · 1:15/)).toBeTruthy();
    const text = screen.getByText('Recent sparring').closest('section')?.textContent ?? '';
    expect(text).not.toMatch(/%|score|risk|recommended|clear|limit|safe to/i);
  });
});
