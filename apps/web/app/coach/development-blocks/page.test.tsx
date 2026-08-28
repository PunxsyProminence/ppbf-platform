/**
 * @jest-environment jsdom
 */

/*
 * The coach UI over athlete development blocks.
 *
 * Two properties are worth a test here and the rest is the route's job:
 *
 *   1. the page never invents training science. No score, no percentage, no
 *      progress bar, no periodization label, and no status that advanced
 *      because a date passed. The order this slice serves names each of those
 *      explicitly, and the way to keep them out of a UI is to assert their
 *      absence rather than to remember.
 *   2. a failed read is never rendered as "this athlete has no plan". A coach
 *      who reads that writes a second block over a first one they could not
 *      see.
 */

import { act, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';

import CoachDevelopmentBlocksPage from './page';

/* The ten domains, mirrored ONLY as stub data. The page holds no copy of the
   vocabulary -- it renders what the route serves -- so this list exists to
   make the stub realistic, not to pin anything. The real pin (that every
   served domain has a human label) lives in the route's own test, which runs
   under node and can import both the module and the page; importing the
   server module here pulls in `pg` and jsdom has no TextEncoder for it. */
const SERVED_DOMAINS = [
  'technical', 'physical', 'conditioning', 'mental', 'recovery_load',
  'sparring_live_progression', 'competition_preparation', 'tactical_film_study',
  'lifestyle_athlete_identity', 'nutrition_body_composition',
];

jest.mock('@/components/RoleStandaloneView', () => ({
  __esModule: true,
  default: ({ children }: { readonly children: ReactNode }) => <div>{children}</div>,
}));

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ children, href }: { readonly children: ReactNode; readonly href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

const ROSTER = [
  { athlete_id: 'ath-1', full_name: 'Rosa Delgado' },
  { athlete_id: 'ath-2', full_name: 'Marcus Webb' },
];

function blockRow(overrides: Record<string, unknown> = {}) {
  return {
    block_id: 'blk-1',
    athlete_id: 'ath-1',
    title: 'Winter technical block',
    training_emphasis: 'Guard recovery off the jab.',
    starts_on: '2026-09-01',
    ends_on: '2026-10-13',
    status: 'draft',
    target_competition_id: null,
    target_wrestling_event_id: null,
    target: null,
    created_by_account_id: 'acct-coach-a',
    created_by_name: 'Coach Rivera',
    created_at: '2026-08-28T00:00:00.000Z',
    updated_at: '2026-08-28T00:00:00.000Z',
    ...overrides,
  };
}

function objectiveRow(overrides: Record<string, unknown> = {}) {
  return {
    objective_id: 'obj-1',
    block_id: 'blk-1',
    domain: 'technical',
    objective: 'Jab off the back foot under pressure, not just off the front.',
    status: 'draft',
    created_by_account_id: 'acct-coach-a',
    created_at: '2026-08-28T00:00:00.000Z',
    updated_at: '2026-08-28T00:00:00.000Z',
    ...overrides,
  };
}

interface Stubs {
  rosterOk?: boolean;
  roster?: typeof ROSTER;
  blocksOk?: boolean;
  blocks?: Array<Record<string, unknown>>;
  writeOk?: boolean;
  writeError?: string;
  targetOptionsOk?: boolean;
  targetOptions?: Array<Record<string, unknown>>;
  domainsOk?: boolean;
  domains?: string[];
  objectivesOk?: boolean;
  objectives?: Array<Record<string, unknown>>;
  objectiveWriteOk?: boolean;
  objectiveWriteError?: string;
  runOptionsOk?: boolean;
  runOptions?: Array<Record<string, unknown>>;
  linkedSessionsOk?: boolean;
  linkedSessions?: Array<Record<string, unknown>>;
  linkOk?: boolean;
  linkError?: string;
  linkCreated?: boolean;
  /* objectivesOk / objectives / objectiveWriteOk / objectiveWriteError are
     declared once above -- both lanes added the same four and the merge kept
     both sets with no conflict marker. objectiveLinks is the only field
     unique to this set, so it is the only one that survives here. */
  objectiveLinks?: Array<Record<string, unknown>>;
  reviewReadOk?: boolean;
  reviews?: Array<Record<string, unknown>>;
  evidence?: Array<Record<string, unknown>>;
  reviewWriteOk?: boolean;
  reviewWriteError?: string;
  /** Delays the write response, so a second click lands while the first is in
      flight. Without this a double-submit test proves nothing. */
  holdWrite?: () => Promise<void>;
}

function sessionRow(overrides: Record<string, unknown> = {}) {
  return {
    run_id: 'run-1',
    script_id: 'scr-1',
    script_name: 'Tuesday Technical',
    delivered_on: '2026-09-08',
    delivered_by_account_id: 'acct-coach-a',
    run_state: 'completed',
    athletes_present: 9,
    blocks_completed: 4,
    deviation_note: '',
    what_worked: '',
    what_did_not: '',
    linked_by_account_id: 'acct-coach-a',
    linked_at: '2026-09-08T20:00:00.000Z',
    ...overrides,
  };
}


function evidenceRow(overrides: Record<string, unknown> = {}) {
  return {
    key: 'training_attempts',
    label: 'Training attempts recorded',
    recorded: 0,
    undated: 0,
    recent: [],
    ...overrides,
  };
}

function reviewRow(overrides: Record<string, unknown> = {}) {
  return {
    review_id: 'rev-1',
    block_id: 'blk-1',
    adherence_state: 'under_delivered',
    deviations: '',
    reason: '',
    what_worked: '',
    what_did_not: '',
    next_adjustment: '',
    reviewed_by_account_id: 'acct-coach-a',
    created_at: '2026-10-14T00:00:00.000Z',
    ...overrides,
  };
}

function runOptionRow(overrides: Record<string, unknown> = {}) {
  return {
    run_id: 'run-1',
    script_id: 'scr-1',
    script_name: 'Tuesday Technical',
    delivered_on: '2026-09-08',
    run_state: 'completed',
    ...overrides,
  };
}

const writes: Array<{ method: string; url: string; body: Record<string, unknown> }> = [];

function installFetch(stubs: Stubs = {}): jest.Mock {
  writes.length = 0;
  const fetchMock = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/api/pilot/coach/athletes')) {
      return {
        ok: stubs.rosterOk ?? true,
        status: stubs.rosterOk === false ? 503 : 200,
        json: async () => ({ ok: true, items: stubs.roster ?? ROSTER }),
      } as Response;
    }
    /* Matched BEFORE the blocks branch. The two paths are distinct --
       'development-block-objectives' does not contain 'development-blocks' --
       but ordering them this way keeps the file honest if either name ever
       moves. */
    if (url.includes('/api/pilot/coach/development-block-objectives')) {
      const method = init?.method ?? 'GET';
      if (method === 'GET' && url.includes('domains=options')) {
        return {
          ok: stubs.domainsOk ?? true,
          status: stubs.domainsOk === false ? 503 : 200,
          json: async () => ({ ok: true, domains: stubs.domains ?? SERVED_DOMAINS }),
        } as Response;
      }
      if (method === 'GET') {
        return {
          ok: stubs.objectivesOk ?? true,
          status: stubs.objectivesOk === false ? 503 : 200,
          json: async () => ({ ok: true, objectives: stubs.objectives ?? [] }),
        } as Response;
      }
      writes.push({ method, url, body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> });
      return {
        ok: stubs.objectiveWriteOk ?? true,
        status: stubs.objectiveWriteOk === false ? 400 : 200,
        json: async () => (stubs.objectiveWriteOk === false
          ? { error: stubs.objectiveWriteError ?? 'refused' }
          : { ok: true, objective: objectiveRow() }),
      } as Response;
    }
    if (url.includes('/api/pilot/coach/development-blocks')) {
      const method = init?.method ?? 'GET';
      // The picker branch, matched before the block reads: both live on the
      // same path and are told apart by ?targets=options, exactly as the route
      // tells them apart.
      if (method === 'GET' && url.includes('targets=options')) {
        return {
          ok: stubs.targetOptionsOk ?? true,
          status: stubs.targetOptionsOk === false ? 503 : 200,
          json: async () => ({ ok: true, options: stubs.targetOptions ?? [] }),
        } as Response;
      }
      if (method === 'GET') {
        return {
          ok: stubs.blocksOk ?? true,
          status: stubs.blocksOk === false ? 503 : 200,
          json: async () => ({ ok: true, blocks: stubs.blocks ?? [] }),
        } as Response;
      }
      writes.push({ method, url, body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> });
      if (stubs.holdWrite) {
        await stubs.holdWrite();
      }
      return {
        ok: stubs.writeOk ?? true,
        status: stubs.writeOk === false ? 400 : 200,
        json: async () => (stubs.writeOk === false
          ? { error: stubs.writeError ?? 'refused' }
          : { ok: true, block: blockRow() }),
      } as Response;
    }
    if (url.includes('/api/pilot/coach/block-review')) {
      const method = init?.method ?? 'GET';
      if (method === 'GET') {
        return {
          ok: stubs.reviewReadOk ?? true,
          status: stubs.reviewReadOk === false ? 503 : 200,
          json: async () => ({
            ok: true,
            reviews: stubs.reviews ?? [],
            evidence: stubs.evidence ?? [],
          }),
        } as Response;
      }
      writes.push({ method, url, body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> });
      return {
        ok: stubs.reviewWriteOk ?? true,
        status: stubs.reviewWriteOk === false ? 400 : 201,
        json: async () => (stubs.reviewWriteOk === false
          ? { error: stubs.reviewWriteError ?? 'refused' }
          : { ok: true, review: reviewRow() }),
      } as Response;
    }
    if (url.includes('/api/pilot/coach/session-objective-links')) {
      const method = init?.method ?? 'GET';
      if (method === 'GET') {
        return {
          ok: stubs.objectivesOk ?? true,
          status: stubs.objectivesOk === false ? 503 : 200,
          json: async () => ({
            ok: true,
            objectives: stubs.objectives ?? [],
            links: stubs.objectiveLinks ?? [],
          }),
        } as Response;
      }
      writes.push({ method, url, body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> });
      return {
        ok: stubs.objectiveWriteOk ?? true,
        status: stubs.objectiveWriteOk === false ? 400 : 200,
        json: async () => (stubs.objectiveWriteOk === false
          ? { error: stubs.objectiveWriteError ?? 'refused' }
          : { ok: true, created: true }),
      } as Response;
    }
    if (url.includes('/api/pilot/coach/session-block-links')) {
      const method = init?.method ?? 'GET';
      // The picker branch, matched before the per-block read exactly as the
      // route tells them apart.
      if (method === 'GET' && url.includes('runs=options')) {
        return {
          ok: stubs.runOptionsOk ?? true,
          status: stubs.runOptionsOk === false ? 503 : 200,
          json: async () => ({ ok: true, runs: stubs.runOptions ?? [runOptionRow()] }),
        } as Response;
      }
      if (method === 'GET') {
        return {
          ok: stubs.linkedSessionsOk ?? true,
          status: stubs.linkedSessionsOk === false ? 503 : 200,
          json: async () => ({ ok: true, sessions: stubs.linkedSessions ?? [] }),
        } as Response;
      }
      writes.push({ method, url, body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> });
      if (stubs.holdWrite) {
        await stubs.holdWrite();
      }
      return {
        ok: stubs.linkOk ?? true,
        status: stubs.linkOk === false ? 400 : 200,
        json: async () => (stubs.linkOk === false
          ? { error: stubs.linkError ?? 'refused' }
          : { ok: true, created: stubs.linkCreated ?? true }),
      } as Response;
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

async function renderPage(stubs: Stubs = {}) {
  const fetchMock = installFetch(stubs);
  await act(async () => {
    render(<CoachDevelopmentBlocksPage />);
  });
  return fetchMock;
}

async function pickAthlete(id: string) {
  await act(async () => {
    fireEvent.change(screen.getByLabelText('Which athlete'), { target: { value: id } });
  });
}

/* The sessions and plan-vs-actual panels load when a coach opens them, the
   same way the objectives panel does -- a dozen blocks must not mean a dozen
   extra reads. Tests that assert on their contents open them first, which is
   also what a coach does. */
async function openSessions() {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Sessions' }));
  });
}

async function openReview() {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Plan vs actual' }));
  });
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('choosing an athlete', () => {
  test('the picker offers exactly the athletes the access route returned', async () => {
    await renderPage();

    const picker = screen.getByLabelText('Which athlete') as HTMLSelectElement;
    expect(Array.from(picker.options).map((option) => option.value).filter(Boolean))
      .toEqual(['ath-1', 'ath-2']);
  });

  test('the roster comes from the access contract, not the whole-gym roster read', async () => {
    const fetchMock = await renderPage();

    const urls = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(urls.some((url) => url.includes('/api/pilot/coach/athletes'))).toBe(true);
    expect(urls.some((url) => url.includes('/api/pilot/athletes/list'))).toBe(false);
  });

  test('a failed roster read is not rendered as "you have no athletes"', async () => {
    await renderPage({ rosterOk: false });

    expect(screen.getByText(/could not be loaded/i)).toBeTruthy();
    expect(screen.queryByText(/not the coach of record for any athlete/i)).toBeNull();
  });

  test('a coach with genuinely none is told that, distinctly', async () => {
    await renderPage({ roster: [] });

    expect(screen.getByText(/not the coach of record for any athlete/i)).toBeTruthy();
    expect(screen.queryByText(/could not be loaded/i)).toBeNull();
  });
});

describe('reading blocks back', () => {
  test('a stored block is shown with the words the coach wrote', async () => {
    await renderPage({ blocks: [blockRow()] });
    await pickAthlete('ath-1');

    expect(screen.getByText('Winter technical block')).toBeTruthy();
    expect(screen.getByText('Guard recovery off the jab.')).toBeTruthy();
    // Matched as the badge, not as an <option> in either status picker --
    // 'Draft' is a word this page renders in three places.
    expect(document.body.querySelector('.badge.badge--filed')?.textContent).toBe('Draft');
  });

  test('the block is read scoped to the chosen athlete', async () => {
    const fetchMock = await renderPage({ blocks: [] });
    await pickAthlete('ath-2');

    const reads = fetchMock.mock.calls
      .map((call) => String(call[0]))
      .filter((url) => url.includes('development-blocks'));
    expect(reads.some((url) => url.includes('athlete_id=ath-2'))).toBe(true);
  });

  test('an athlete with no block is told so, plainly', async () => {
    await renderPage({ blocks: [] });
    await pickAthlete('ath-1');

    expect(screen.getByText(/No development block has been written/i)).toBeTruthy();
  });

  test('a failed block read never reads as "no plan"', async () => {
    // The consequence is concrete: a coach who believes there is no plan
    // writes a second one over a first one they could not see.
    await renderPage({ blocksOk: false });
    await pickAthlete('ath-1');

    expect(screen.getByText(/could not be read/i)).toBeTruthy();
    expect(screen.queryByText(/No development block has been written/i)).toBeNull();
  });

  test('the creator is shown, and the page offers no way to change it', async () => {
    await renderPage({ blocks: [blockRow()] });
    await pickAthlete('ath-1');

    /* Asserts a NAME now: this line used to render the raw
       created_by_account_id, which is the absence of attribution rather than
       attribution. The point of this case is unchanged -- the creator is
       shown, and no edit path can rewrite who wrote the plan. */
    expect(screen.getByText(/Written by Coach Rivera/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Edit block' }));
    expect(screen.queryByLabelText(/written by/i)).toBeNull();
    expect(screen.queryByLabelText(/created by/i)).toBeNull();
  });
});

describe('writing a block', () => {
  test('the chosen athlete is the subject, and the form sends what was typed', async () => {
    await renderPage({ blocks: [] });
    await pickAthlete('ath-1');

    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Winter technical block' } });
    fireEvent.change(screen.getByLabelText('Training emphasis'), { target: { value: 'Guard recovery off the jab.' } });
    fireEvent.change(screen.getByLabelText('Starts on'), { target: { value: '2026-09-01' } });
    fireEvent.change(screen.getByLabelText('Ends on'), { target: { value: '2026-10-13' } });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save block' }));
    });

    expect(writes).toHaveLength(1);
    expect(writes[0].method).toBe('POST');
    expect(writes[0].body).toEqual({
      athlete_id: 'ath-1',
      title: 'Winter technical block',
      training_emphasis: 'Guard recovery off the jab.',
      starts_on: '2026-09-01',
      ends_on: '2026-10-13',
      status: 'draft',
    });
  });

  test('no organization id is ever sent', async () => {
    await renderPage({ blocks: [] });
    await pickAthlete('ath-1');
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'T' } });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save block' }));
    });

    expect(Object.keys(writes[0].body)).not.toContain('organization_id');
    expect(Object.keys(writes[0].body)).not.toContain('created_by_account_id');
  });

  test('a double click writes exactly one block', async () => {
    /* The write is held open so the second click lands while the first is
       genuinely in flight -- which is the only moment a duplicate plan can be
       written. Clicking twice inside one act() flushes nothing in between and
       would pass against a component with no guard at all. */
    let release: (() => void) | undefined;
    await renderPage({ blocks: [], holdWrite: () => new Promise<void>((resolve) => { release = resolve; }) });
    await pickAthlete('ath-1');
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'T' } });

    const save = screen.getByRole('button', { name: 'Save block' });
    fireEvent.click(save);
    fireEvent.click(save);
    fireEvent.click(screen.getByRole('button', { name: /Saving/i }));

    expect(writes.filter((write) => write.method === 'POST')).toHaveLength(1);

    await act(async () => { release?.(); });
    expect(writes.filter((write) => write.method === 'POST')).toHaveLength(1);

    // The guard releases once the request settles, so a genuine second block
    // is still possible.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save block' }));
    });
    expect(writes.filter((write) => write.method === 'POST')).toHaveLength(2);
  });

  test("the server's refusal is shown in the server's own words", async () => {
    await renderPage({
      blocks: [],
      writeOk: false,
      writeError: 'A development block cannot end before it begins.',
    });
    await pickAthlete('ath-1');
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'T' } });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save block' }));
    });

    expect(screen.getByText('A development block cannot end before it begins.')).toBeTruthy();
    expect(screen.queryByText('Block saved.')).toBeNull();
  });

  test('a refused write does not report a save', async () => {
    await renderPage({ blocks: [], writeOk: false });
    await pickAthlete('ath-1');
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'T' } });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save block' }));
    });

    expect(screen.queryByText('Block saved.')).toBeNull();
  });
});

describe('editing a block', () => {
  test('an edit sends the block id and the changed fields, never an athlete', async () => {
    await renderPage({ blocks: [blockRow()] });
    await pickAthlete('ath-1');

    fireEvent.click(screen.getByRole('button', { name: 'Edit block' }));
    // Both forms carry a "Title" label once the editor opens, so this asks for
    // the editor's own field by its per-block id rather than by the label.
    fireEvent.change(screen.getByLabelText('Title', { selector: '#edit-title-blk-1' }), {
      target: { value: 'Renamed block' },
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    });

    const patch = writes.find((write) => write.method === 'PATCH');
    expect(patch?.body.block_id).toBe('blk-1');
    expect(patch?.body.title).toBe('Renamed block');
    expect(Object.keys(patch?.body ?? {})).not.toContain('athlete_id');
    expect(Object.keys(patch?.body ?? {})).not.toContain('created_by_account_id');
  });

  test('a double click sends exactly one update', async () => {
    let release: (() => void) | undefined;
    await renderPage({
      blocks: [blockRow()],
      holdWrite: () => new Promise<void>((resolve) => { release = resolve; }),
    });
    await pickAthlete('ath-1');
    fireEvent.click(screen.getByRole('button', { name: 'Edit block' }));

    const save = screen.getByRole('button', { name: 'Save changes' });
    fireEvent.click(save);
    fireEvent.click(save);
    fireEvent.click(screen.getByRole('button', { name: /Saving/i }));

    expect(writes.filter((write) => write.method === 'PATCH')).toHaveLength(1);

    await act(async () => { release?.(); });
    expect(writes.filter((write) => write.method === 'PATCH')).toHaveLength(1);
  });

  test('a refused edit leaves the form open and says why', async () => {
    await renderPage({
      blocks: [blockRow()],
      writeOk: false,
      writeError: 'A development block needs a stated training emphasis, in the coach\'s own words.',
    });
    await pickAthlete('ath-1');
    fireEvent.click(screen.getByRole('button', { name: 'Edit block' }));

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    });

    expect(screen.getByText(/needs a stated training emphasis/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeTruthy();
  });

  test('every status a coach may choose is offered, and none of them is computed', async () => {
    await renderPage({ blocks: [blockRow()] });
    await pickAthlete('ath-1');
    fireEvent.click(screen.getByRole('button', { name: 'Edit block' }));

    const statuses = screen.getAllByLabelText('Status')
      .flatMap((node) => Array.from((node as HTMLSelectElement).options).map((option) => option.value));
    expect(new Set(statuses)).toEqual(new Set(['draft', 'active', 'completed', 'cancelled']));
  });
});

describe('the page invents no training science', () => {
  test('no score, percentage, progress bar, or periodization label anywhere', async () => {
    /* Each of these is named in the order as a thing this slice must not
       produce: workload score, readiness-adjusted volume, ACWR, fatigue
       score, injury-risk score, taper percentage, automatic periodization
       classification, automatic completion. */
    const { container } = { container: document.body };
    await renderPage({ blocks: [blockRow({ status: 'active' })] });
    await pickAthlete('ath-1');

    const text = container.textContent ?? '';
    expect(text).not.toMatch(/\d+%/);
    expect(text).not.toMatch(/workload/i);
    expect(text).not.toMatch(/ACWR/i);
    expect(text).not.toMatch(/fatigue/i);
    expect(text).not.toMatch(/injury risk/i);
    expect(text).not.toMatch(/taper/i);
    expect(text).not.toMatch(/peaking/i);
    expect(text).not.toMatch(/readiness/i);
    expect(container.querySelector('progress')).toBeNull();
    expect(container.querySelector('[role="progressbar"]')).toBeNull();
  });

  test('a block whose window has passed is still whatever the coach set', async () => {
    // "The window has elapsed" and "the plan was carried out" are different
    // claims, and nothing here makes the second one.
    await renderPage({
      blocks: [blockRow({ starts_on: '2020-01-01', ends_on: '2020-02-01', status: 'active' })],
    });
    await pickAthlete('ath-1');

    expect(document.body.querySelector('.badge.badge--cleared')?.textContent).toBe('Active');
    expect(document.body.querySelector('.badge.badge--monitor')).toBeNull();
  });
});


/*
 * WHAT A BLOCK IS PREPARING FOR.
 *
 * Open Question 2 of module 036's engine-unlock proposal, answered (a): an
 * optional link to an existing competition or league event, "as a target date
 * only (name and date, nothing else)".
 *
 * The two things worth a test here are the two ways this could quietly go
 * wrong: a countdown or a taper appearing because a date is now on screen,
 * and a cancelled event being dropped instead of marked -- which would leave a
 * coach planning around a show that is not happening.
 */
function targetOption(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'competition',
    id: 'comp-1',
    name: 'Keystone Open',
    date: '2026-11-14',
    location: 'Altoona, PA',
    sanctioning_body: 'USA Boxing',
    status: 'planned',
    ...overrides,
  };
}

describe('the competition target on a block', () => {
  test('a named target shows its date, location and sanctioning body', async () => {
    await renderPage({ blocks: [blockRow({ target: targetOption() })] });
    await pickAthlete('ath-1');

    expect(screen.getByText('Keystone Open')).toBeTruthy();
    expect(screen.getByText(/November 14, 2026/)).toBeTruthy();
    expect(screen.getByText(/Altoona, PA/)).toBeTruthy();
    expect(screen.getByText(/USA Boxing/)).toBeTruthy();
  });

  test('a wrestling event shows no sanctioning body, because that table has no such column', async () => {
    // "Where stored" is the rule. Inventing a body would be the failure.
    await renderPage({
      blocks: [blockRow({
        target: targetOption({
          kind: 'wrestling_event',
          id: 'evt-1',
          name: 'Punxsutawney Duals',
          sanctioning_body: null,
        }),
      })],
    });
    await pickAthlete('ath-1');

    expect(screen.getByText('Punxsutawney Duals')).toBeTruthy();
    expect(screen.getByText(/Wrestling event/)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/USA Boxing|sanction/i);
  });

  test('a block with no target says so, rather than showing an empty event', async () => {
    await renderPage({ blocks: [blockRow()] });
    await pickAthlete('ath-1');

    expect(screen.getByText(/No event named/i)).toBeTruthy();
  });

  test('a cancelled event stays on the block and is called cancelled', async () => {
    await renderPage({
      blocks: [blockRow({ target: targetOption({ status: 'cancelled' }) })],
    });
    await pickAthlete('ath-1');

    expect(screen.getByText('Keystone Open')).toBeTruthy();
    expect(screen.getByText(/This event was cancelled/i)).toBeTruthy();
  });

  test('choosing a target sends the kind and id the server offered', async () => {
    await renderPage({ blocks: [blockRow()], targetOptions: [targetOption()] });
    await pickAthlete('ath-1');

    await act(async () => {
      fireEvent.change(screen.getByLabelText('Change what this block is preparing for'), {
        target: { value: 'competition:comp-1' },
      });
    });

    const patch = writes.find((write) => write.method === 'PATCH');
    expect(patch?.body).toEqual({ block_id: 'blk-1', target: { kind: 'competition', id: 'comp-1' } });
  });

  test('choosing "No event" clears the target explicitly', async () => {
    await renderPage({
      blocks: [blockRow({ target: targetOption() })],
      targetOptions: [targetOption()],
    });
    await pickAthlete('ath-1');

    await act(async () => {
      fireEvent.change(screen.getByLabelText('Change what this block is preparing for'), {
        target: { value: '' },
      });
    });

    const patch = writes.find((write) => write.method === 'PATCH');
    expect(patch?.body).toEqual({ block_id: 'blk-1', target: null });
  });

  test('the submitted target is looked up, not parsed out of the select value', async () => {
    /* The option value is `kind:id`, and an id may itself contain a colon --
       nothing constrains these ids to avoid one. Splitting the string would
       send the id truncated at the first colon, filing the plan against a
       different fixture or none. The page resolves the value against the list
       the server sent instead, which is also what stops a client-composed id
       ever reaching the route.

       Written with a colon-bearing id on purpose: a test using a plain id
       passes against a naive split and proves nothing. */
    const awkward = targetOption({ id: 'comp:2026:keystone', name: 'Keystone Open' });
    await renderPage({ blocks: [blockRow()], targetOptions: [awkward] });
    await pickAthlete('ath-1');

    await act(async () => {
      fireEvent.change(screen.getByLabelText('Change what this block is preparing for'), {
        target: { value: 'competition:comp:2026:keystone' },
      });
    });

    const patch = writes.find((write) => write.method === 'PATCH');
    expect(patch?.body.target).toEqual({ kind: 'competition', id: 'comp:2026:keystone' });
  });

  test('a selection the picker never offered sends no invented id', async () => {
    await renderPage({ blocks: [blockRow()], targetOptions: [targetOption()] });
    await pickAthlete('ath-1');

    const picker = screen.getByLabelText('Change what this block is preparing for') as HTMLSelectElement;
    await act(async () => {
      fireEvent.change(picker, { target: { value: 'competition:comp-not-offered' } });
    });

    const patch = writes.find((write) => write.method === 'PATCH');
    expect(patch?.body.target).not.toEqual({ kind: 'competition', id: 'comp-not-offered' });
  });

  test('an unrecorded location and body leave no empty fields behind', async () => {
    /* Both tables default location to '' and external_competitions defaults
       sanctioning_body to '', so a blank is an ABSENCE. Rendering it anyway
       leaves a dangling separator and an empty slot that reads as data the
       gym has and did not show. */
    await renderPage({
      blocks: [blockRow({
        target: targetOption({ name: 'Club Show', location: '', sanctioning_body: null }),
      })],
    });
    await pickAthlete('ath-1');

    const line = screen.getByText(/Competition ·/).textContent ?? '';
    expect(line).toMatch(/Competition · November 14, 2026$/);
    expect(line).not.toMatch(/·\s*$/);
    expect(line).not.toMatch(/·\s+·/);
  });

  test('a cancelled fixture stays selectable, marked, so a coach can retarget away from it', async () => {
    await renderPage({
      blocks: [blockRow()],
      targetOptions: [targetOption({ status: 'cancelled' })],
    });
    await pickAthlete('ath-1');

    const picker = screen.getByLabelText('Change what this block is preparing for') as HTMLSelectElement;
    expect(Array.from(picker.options).map((option) => option.textContent).join(' ')).toMatch(/cancelled/);
  });

  test('a failed picker read is not rendered as "no competitions scheduled"', async () => {
    await renderPage({ blocks: [blockRow()], targetOptionsOk: false });
    await pickAthlete('ath-1');

    expect(screen.getByText(/could not be loaded, so there is nothing to choose/i)).toBeTruthy();
    expect(screen.queryByText(/No competition or league event has been recorded/i)).toBeNull();
  });

  test('a gym with genuinely nothing on the calendar is told that, distinctly', async () => {
    await renderPage({ blocks: [blockRow()], targetOptions: [] });
    await pickAthlete('ath-1');

    expect(screen.getByText(/No competition or league event has been recorded/i)).toBeTruthy();
    expect(screen.queryByText(/could not be loaded, so there is nothing to choose/i)).toBeNull();
  });

  test('naming a target still invents no training science', async () => {
    /* The risk this whole slice carries: a date on screen invites a countdown,
       and a countdown invites a taper. Neither competition table holds
       anything either could honestly be built from. */
    await renderPage({
      blocks: [blockRow({ target: targetOption() })],
      targetOptions: [targetOption()],
    });
    await pickAthlete('ath-1');

    const text = document.body.textContent ?? '';
    expect(text).not.toMatch(/\d+%/);
    expect(text).not.toMatch(/weeks out|peak week|taper|workload|ACWR|fatigue|injury risk/i);
    expect(document.body.querySelector('progress')).toBeNull();
    expect(document.body.querySelector('[role="progressbar"]')).toBeNull();
  });
});

/*
 * A SLOW READ FOR THE WRONG CHILD.
 *
 * Review finding on #771 (P1), verified and confirmed. Nothing on a block
 * card names its athlete, and the edit and target controls submit only a
 * block id -- so a coach authorised for two children who switched athletes
 * mid-read could have been editing A's plan while the picker said B, with
 * nothing on screen disagreeing. The server would have accepted every one of
 * those writes, because the coach IS authorised for A.
 *
 * CoachWorkspace already carries this guard (reviewAthleteRef) for the same
 * reason on the same shape of read. This file should have copied it.
 */
describe('a block list never lands under the wrong athlete', () => {
  /** A stub whose per-athlete reads resolve only when released, so the two
   *  can be finished out of order -- which is the whole scenario. */
  function installOrderedFetch(release: Record<string, () => void>) {
    writes.length = 0;
    const pending: Record<string, (value: Response) => void> = {};
    const fetchMock = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/pilot/coach/athletes')) {
        return { ok: true, status: 200, json: async () => ({ ok: true, items: ROSTER }) } as Response;
      }
      if (url.includes('targets=options')) {
        return { ok: true, status: 200, json: async () => ({ ok: true, options: [] }) } as Response;
      }
      if (url.includes('/api/pilot/coach/development-blocks') && (init?.method ?? 'GET') === 'GET') {
        const athlete = new URL(url, 'http://localhost').searchParams.get('athlete_id') ?? '';
        return new Promise<Response>((resolve) => {
          pending[athlete] = resolve;
          release[athlete] = () => resolve({
            ok: true,
            status: 200,
            json: async () => ({
              ok: true,
              blocks: [blockRow({ block_id: `blk-${athlete}`, athlete_id: athlete, title: `Plan for ${athlete}` })],
            }),
          } as Response);
        });
      }
      writes.push({ method: init?.method ?? 'GET', url, body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> });
      return { ok: true, status: 200, json: async () => ({ ok: true, block: blockRow() }) } as Response;
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    return { fetchMock, pending };
  }

  test("a late answer for the previous athlete never renders under the current one", async () => {
    const release: Record<string, () => void> = {};
    installOrderedFetch(release);
    await act(async () => { render(<CoachDevelopmentBlocksPage />); });

    // Ask for ath-1, then switch to ath-2 before ath-1 answers.
    await pickAthlete('ath-1');
    await pickAthlete('ath-2');

    // ath-2 answers first, then the stale ath-1 answer arrives.
    await act(async () => { release['ath-2']?.(); });
    await act(async () => { release['ath-1']?.(); });

    expect(screen.getByText('Plan for ath-2')).toBeTruthy();
    expect(screen.queryByText('Plan for ath-1')).toBeNull();
  });

  test('a late FAILURE for the previous athlete does not blank the current one', async () => {
    // The error path needs the same guard: an unrelated failure must not
    // replace a panel that loaded correctly with "could not be read".
    writes.length = 0;
    let failPrevious: (() => void) | undefined;
    global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/pilot/coach/athletes')) {
        return { ok: true, status: 200, json: async () => ({ ok: true, items: ROSTER }) } as Response;
      }
      if (url.includes('targets=options')) {
        return { ok: true, status: 200, json: async () => ({ ok: true, options: [] }) } as Response;
      }
      if (url.includes('/api/pilot/coach/development-blocks') && (init?.method ?? 'GET') === 'GET') {
        const athlete = new URL(url, 'http://localhost').searchParams.get('athlete_id') ?? '';
        if (athlete === 'ath-1') {
          return new Promise<Response>((_resolve, reject) => { failPrevious = () => reject(new Error('slow')); });
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: true, blocks: [blockRow({ block_id: 'blk-2', title: 'Plan for ath-2' })] }),
        } as Response;
      }
      return { ok: true, status: 200, json: async () => ({}) } as Response;
    }) as unknown as typeof fetch;

    await act(async () => { render(<CoachDevelopmentBlocksPage />); });
    await pickAthlete('ath-1');
    await pickAthlete('ath-2');
    await act(async () => { failPrevious?.(); });

    expect(screen.getByText('Plan for ath-2')).toBeTruthy();
    expect(screen.queryByText(/could not be read/i)).toBeNull();
  });

  test('the previous list is off screen for the whole flight of the new read', async () => {
    /* The property that matters: while B's read is in flight, A's blocks are
       not on screen under B's name. It is the 'loading' state that provides
       this -- the list renders only in 'loaded' -- which a mutation test
       established by deleting a redundant setBlocks([]) and breaking nothing.
       So this asserts the state machine, not the belt-and-braces line that
       used to sit beside it. */
    const release: Record<string, () => void> = {};
    installOrderedFetch(release);
    await act(async () => { render(<CoachDevelopmentBlocksPage />); });

    await pickAthlete('ath-1');
    await act(async () => { release['ath-1']?.(); });
    expect(screen.getByText('Plan for ath-1')).toBeTruthy();

    await pickAthlete('ath-2');

    // B's read has not answered yet, and A's plan is already gone.
    expect(screen.queryByText('Plan for ath-1')).toBeNull();
    expect(screen.getByText('Loading blocks...')).toBeTruthy();

    await act(async () => { release['ath-2']?.(); });
    expect(screen.getByText('Plan for ath-2')).toBeTruthy();
  });
});

describe('objectives: what a block is trying to move', () => {
  async function openObjectives(stubs: Stubs = {}) {
    const fetchMock = await renderPage({ blocks: [blockRow()], ...stubs });
    await pickAthlete('ath-1');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Objectives' }));
    });
    return fetchMock;
  }

  test('nothing is read until a coach opens the panel', async () => {
    /* A dozen blocks on screen must not mean a dozen extra reads, and each
       one is a separate authorization decision at the route. Only the opened
       block is fetched. */
    const fetchMock = await renderPage({ blocks: [blockRow()] });
    await pickAthlete('ath-1');

    const before = fetchMock.mock.calls.map((call) => String(call[0]));
    /* Scoped to the OBJECTIVES endpoint, which is what this test is about.
       It matched any url carrying `block_id=blk-1`, which was unambiguous
       when objectives were the only per-block read; the session-block-link
       panel added by the plan-to-session slice is a second one, and it loads
       with the card rather than behind a button, so the broad matcher caught
       an endpoint this test was never asserting about.

       The property itself is unchanged and still holds: opening a block does
       not read its objectives until a coach asks for them.

       NOTE THE TENSION THIS EXPOSES, because it is real and is not resolved
       here: the comment above says a dozen blocks must not mean a dozen extra
       reads, and the sessions panel currently does exactly that -- one read
       per block, eagerly, on every roster load. Objectives avoid it by
       sitting behind a toggle; sessions render inline, so making them lazy is
       a UI change rather than a loader change. Worth doing, and worth doing
       deliberately rather than inside a merge. */
    expect(before.some((url) => url.includes('development-block-objectives?block_id=blk-1'))).toBe(false);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Objectives' }));
    });

    const after = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(after.some((url) => url.includes('development-block-objectives?block_id=blk-1'))).toBe(true);
  });

  test('a failed read is not rendered as "this block has no objectives"', async () => {
    await openObjectives({ objectivesOk: false });

    expect(screen.getByText(/could not be loaded/i)).toBeTruthy();
    expect(screen.queryByText(/Nothing recorded yet/i)).toBeNull();
  });

  test('a block with genuinely none is told that, distinctly', async () => {
    await openObjectives({ objectives: [] });

    expect(screen.getByText(/Nothing recorded yet/i)).toBeTruthy();
    expect(screen.queryByText(/could not be loaded/i)).toBeNull();
  });

  test('the coach\'s sentence is read back exactly as written', async () => {
    await openObjectives({
      objectives: [objectiveRow({ objective: '  Keep the jab honest  in the third.' })],
    });

    /* Asserted on textContent rather than through getByText, which
       normalizes runs of whitespace and so cannot express "exactly". The
       double space is the point: the coach typed it and the screen does not
       tidy it away. */
    const paragraphs = Array.from(document.querySelectorAll('p'))
      .map((node) => node.textContent ?? '');
    expect(paragraphs).toContain('  Keep the jab honest  in the third.');
  });

  test('the domain picker offers what the ROUTE served, under human labels', async () => {
    await openObjectives();

    const picker = screen.getByLabelText('Domain') as HTMLSelectElement;
    const values = Array.from(picker.options).map((option) => option.value).filter(Boolean);
    expect(values).toEqual(SERVED_DOMAINS);
    // Labelled, not passed through as stored slugs.
    expect(Array.from(picker.options).map((option) => option.text))
      .toContain('Nutrition & body composition');
    expect(Array.from(picker.options).map((option) => option.text))
      .not.toContain('nutrition_body_composition');
  });

  test('a failed domain read is not rendered as "there are no domains"', async () => {
    await openObjectives({ domainsOk: false });

    expect(screen.getByText(/domains could not be loaded/i)).toBeTruthy();
    expect(screen.queryByLabelText('Domain')).toBeNull();
  });

  test('adding one sends the block, the domain and the words, and nothing else', async () => {
    await openObjectives();

    await act(async () => {
      fireEvent.change(screen.getByLabelText('Domain'), { target: { value: 'conditioning' } });
      fireEvent.change(screen.getByLabelText('What this is trying to move'), {
        target: { value: 'Three hard rounds without the pace dropping.' },
      });
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Add objective' }));
    });

    const write = writes.find((entry) => entry.method === 'POST');
    expect(write?.body).toEqual({
      block_id: 'blk-1',
      domain: 'conditioning',
      objective: 'Three hard rounds without the pace dropping.',
      status: 'draft',
    });
    // No athlete id, no organization, no author: the route takes all three
    // from the session and this screen has no business sending them.
    expect(Object.keys(write?.body ?? {})).not.toContain('athlete_id');
    expect(Object.keys(write?.body ?? {})).not.toContain('organization_id');
    expect(Object.keys(write?.body ?? {})).not.toContain('created_by_account_id');
  });

  test('a refused objective shows the server\'s own words', async () => {
    await openObjectives({
      objectiveWriteOk: false,
      objectiveWriteError: 'An objective needs to say what it is, in the coach\'s own words.',
    });

    await act(async () => {
      fireEvent.change(screen.getByLabelText('Domain'), { target: { value: 'technical' } });
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Add objective' }));
    });

    expect(screen.getByText(/needs to say what it is/i)).toBeTruthy();
  });

  test('moving one sends only the id and the new status', async () => {
    await openObjectives({ objectives: [objectiveRow()] });

    await act(async () => {
      fireEvent.change(screen.getByLabelText('Objective status'), { target: { value: 'completed' } });
    });

    const patch = writes.find((entry) => entry.method === 'PATCH');
    expect(patch?.body).toEqual({ objective_id: 'obj-1', status: 'completed' });
    // The domain and the sentence are not patchable, and the screen offers no
    // control that would send them.
    expect(Object.keys(patch?.body ?? {})).not.toContain('domain');
    expect(Object.keys(patch?.body ?? {})).not.toContain('objective');
  });

  test('the panel invents no roll-up, no proportion and no grade', async () => {
    /* THE REFUSAL THAT IS TEMPTING RATHER THAN OBVIOUS. Five objectives with
       three completed is a count anyone could render, and rendering it turns
       a coach's plan into a score about a child. Whether a block went well is
       a coach's judgment; the count is not it. */
    await openObjectives({
      objectives: [
        objectiveRow({ objective_id: 'obj-1', status: 'completed' }),
        objectiveRow({ objective_id: 'obj-2', status: 'completed' }),
        objectiveRow({ objective_id: 'obj-3', status: 'completed', domain: 'mental' }),
        objectiveRow({ objective_id: 'obj-4', status: 'draft', domain: 'physical' }),
        objectiveRow({ objective_id: 'obj-5', status: 'cancelled', domain: 'recovery_load' }),
      ],
    });

    /* SCOPED TO THE PANEL, not to the document. The page header contains the
       sentence "It does not score it, grade it, or move it along on its own"
       -- its own promise not to do this -- so a body-wide substring check
       fails on the disclaimer rather than on a defect. The claim under test
       is about what the objectives panel renders. */
    const panel = screen.getAllByLabelText('Objective status')[0]
      .closest('ul') as HTMLElement;
    const text = (panel.textContent ?? '').toLowerCase();

    // No count of completed objectives, in any of the shapes one takes.
    expect(text).not.toMatch(/\b3\s*(of|\/|out of)\s*5\b/);
    expect(text).not.toMatch(/\d+\s*%/);
    /* 'progress' is deliberately NOT in this list: 'sparring & live
       progression' is a real Full Spectrum domain and a blunt substring check
       would fail on the vocabulary itself. The progress INDICATOR is asserted
       structurally below, which is the actual claim. */
    for (const forbidden of [
      'score', 'rating', 'grade', 'adherence', 'compliance', 'on track', 'behind',
    ]) {
      expect(text).not.toContain(forbidden);
    }
    expect(panel.querySelector('progress')).toBeNull();
    expect(panel.querySelector('[role="progressbar"]')).toBeNull();
    expect(panel.querySelector('meter')).toBeNull();
  });

  test('a body-composition objective renders like any other, with no extra apparatus', async () => {
    /* Admitted by owner decision 2026-08-28. It is a domain label on a
       sentence a coach wrote -- there is no weight field, no target number
       and no chart, and this asserts the screen adds none. */
    await openObjectives({
      objectives: [objectiveRow({
        domain: 'nutrition_body_composition',
        objective: 'Eat a real breakfast before morning conditioning.',
      })],
    });

    /* getAllByText, because the label legitimately appears twice: once
       naming this objective's domain and once as an option in the picker
       below it. */
    expect(screen.getAllByText('Nutrition & body composition').length).toBeGreaterThan(0);
    expect(screen.getByText('Eat a real breakfast before morning conditioning.')).toBeTruthy();
    const body = (document.body.textContent ?? '').toLowerCase();
    for (const forbidden of ['kg', 'lbs', 'weight class', 'body fat', 'bmi', 'target weight']) {
      expect(body).not.toContain(forbidden);
    }
  });

  test('closing the panel stops rendering the objectives', async () => {
    await openObjectives({ objectives: [objectiveRow()] });

    expect(screen.getByText(/Jab off the back foot/i)).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Hide objectives' }));
    });

    expect(screen.queryByText(/Jab off the back foot/i)).toBeNull();
  });
});

describe('attribution names a person', () => {
  test('the resolved name is shown, not the account id', async () => {
    await renderPage({ blocks: [blockRow()] });
    await pickAthlete('ath-1');

    expect(screen.getByText(/Written by Coach Rivera/)).toBeTruthy();
    // The id was what this line used to print, and it is not attribution.
    expect(document.body.textContent ?? '').not.toContain('acct-coach-a');
  });

  test('a block whose name did not resolve falls back to the id, not to nothing', async () => {
    /* An ugly true string beats a line that quietly reads "Written by". If the
       route ever stops resolving names, a coach should see that something is
       wrong rather than see a blank where a colleague's name belongs. */
    const withoutName: Record<string, unknown> = { ...blockRow() };
    delete withoutName.created_by_name;
    await renderPage({ blocks: [withoutName] });
    await pickAthlete('ath-1');

    expect(screen.getByText(/Written by acct-coach-a/)).toBeTruthy();
  });
});

/*
 * PLAN -> SESSION: which delivered sessions a coach says worked this block.
 *
 * Two properties are worth a test here and the rest belongs to the route:
 *
 *   1. nothing is counted. The build order's NEXT slice is plan-versus-actual,
 *      and the moment sessions are countable against a plan a "4 of 12" or a
 *      coverage bar is one aggregate away -- a figure about a coach's work
 *      with a child, assembled out of links nobody validated. Asserting its
 *      absence is how it stays absent.
 *   2. a failed read is never rendered as "no session worked this block". A
 *      coach who believes that re-links sessions that are already linked, or
 *      concludes the plan was never delivered against.
 */
describe('the sessions panel counts nothing', () => {
  test('linked sessions show what the run recorded, and no total or coverage figure', async () => {
    await renderPage({
      blocks: [blockRow()],
      linkedSessions: [
        sessionRow({ run_id: 'run-1', what_worked: 'Guard held up in round three.' }),
        sessionRow({ run_id: 'run-2', delivered_on: '2026-09-15', what_did_not: 'Body work faded.' }),
      ],
    });
    await pickAthlete('ath-1');
    await openSessions();

    // Both sessions render, with the run's own words carried through.
    expect(screen.getByText('What worked: Guard held up in round three.')).toBeTruthy();
    expect(screen.getByText('What did not: Body work faded.')).toBeTruthy();

    const body = document.body.textContent ?? '';
    // No count of them, and no figure derived from them.
    expect(body).not.toMatch(/\d+\s*of\s*\d+/);
    expect(body).not.toMatch(/\d+\s*%/);
    expect(body).not.toMatch(/coverage|adherence|compliance|on track|behind/i);
    expect(document.querySelectorAll('progress')).toHaveLength(0);
    expect(document.querySelectorAll('[role="progressbar"]')).toHaveLength(0);
  });

  test('a run field the coach left blank shows no heading at all', async () => {
    await renderPage({
      blocks: [blockRow()],
      linkedSessions: [sessionRow({ what_worked: '', what_did_not: '', deviation_note: '' })],
    });
    await pickAthlete('ath-1');
    await openSessions();

    // The session is there...
    expect(screen.getByText('Tuesday Technical')).toBeTruthy();
    // ...and an empty heading over nothing would suggest the session had no
    // account of itself rather than that the field was left blank.
    const body = document.body.textContent ?? '';
    expect(body).not.toContain('What worked:');
    expect(body).not.toContain('What did not:');
    expect(body).not.toContain('Deviation:');
    expect(body).not.toContain('null');
    expect(body).not.toContain('undefined');
  });

  test('a failed session read is not rendered as "no session worked this block"', async () => {
    await renderPage({ blocks: [blockRow()], linkedSessionsOk: false });
    await pickAthlete('ath-1');
    await openSessions();

    expect(screen.getByText(/linked sessions could not be read/i)).toBeTruthy();
    expect(screen.queryByText(/No session has been linked to this block yet/i)).toBeNull();
  });

  test('a genuinely empty list says so, and is not the same message', async () => {
    await renderPage({ blocks: [blockRow()], linkedSessions: [] });
    await pickAthlete('ath-1');
    await openSessions();

    expect(screen.getByText(/No session has been linked to this block yet/i)).toBeTruthy();
    expect(screen.queryByText(/linked sessions could not be read/i)).toBeNull();
  });

  test('a failed picker read is not rendered as "no sessions have been delivered"', async () => {
    await renderPage({ blocks: [blockRow()], runOptionsOk: false });
    await pickAthlete('ath-1');
    await openSessions();

    expect(screen.getByText(/list of delivered sessions could not be read/i)).toBeTruthy();
    expect(screen.queryByText(/No session has been delivered and finished/i)).toBeNull();
  });
});

describe('linking a session to a block', () => {
  test('the submitted run is looked up, not parsed out of the select value', async () => {
    // A run id containing the separator the label uses. A build that split the
    // option's text would send a truncated id, and this is the fixture that
    // catches it.
    await renderPage({
      blocks: [blockRow()],
      runOptions: [runOptionRow({ run_id: 'run — with — dashes' })],
    });
    await pickAthlete('ath-1');
    await openSessions();

    await act(async () => {
      fireEvent.change(screen.getByLabelText('Link a session'), {
        target: { value: 'run — with — dashes' },
      });
    });

    const link = writes.find((entry) => entry.method === 'POST' && 'run_id' in entry.body);
    expect(link?.body).toEqual({ run_id: 'run — with — dashes', block_id: 'blk-1' });
  });

  test('the block id comes from the card, and no athlete or organization is sent', async () => {
    await renderPage({ blocks: [blockRow({ block_id: 'blk-9' })] });
    await pickAthlete('ath-1');
    await openSessions();

    await act(async () => {
      fireEvent.change(screen.getByLabelText('Link a session'), { target: { value: 'run-1' } });
    });

    const link = writes.find((entry) => entry.method === 'POST' && 'run_id' in entry.body);
    expect(link?.body.block_id).toBe('blk-9');
    // The session decides both, and the route reads neither from the body.
    expect(link?.body).not.toHaveProperty('athlete_id');
    expect(link?.body).not.toHaveProperty('organization_id');
  });

  test('linking something already linked says so rather than claiming a new link', async () => {
    await renderPage({ blocks: [blockRow()], linkCreated: false });
    await pickAthlete('ath-1');
    await openSessions();

    await act(async () => {
      fireEvent.change(screen.getByLabelText('Link a session'), { target: { value: 'run-1' } });
    });

    expect(screen.getByText('Already linked.')).toBeTruthy();
    expect(screen.queryByText('Session linked.')).toBeNull();
  });

  test('a refused link shows the server\'s own reason', async () => {
    await renderPage({
      blocks: [blockRow()], linkOk: false, linkError: 'Session not found.',
    });
    await pickAthlete('ath-1');
    await openSessions();

    await act(async () => {
      fireEvent.change(screen.getByLabelText('Link a session'), { target: { value: 'run-1' } });
    });

    expect(screen.getByText('Session not found.')).toBeTruthy();
  });

  test('unlinking sends both ids and removes the statement, not the session', async () => {
    await renderPage({ blocks: [blockRow()], linkedSessions: [sessionRow()] });
    await pickAthlete('ath-1');
    await openSessions();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Unlink' }));
    });

    /* Both ids, asserted from the URL rather than from "a DELETE happened":
       an unlink that sent the wrong run, or dropped the block id, would pass
       the weaker check while removing somebody else's link. */
    const removal = writes.find((entry) => entry.method === 'DELETE');
    expect(removal?.url).toContain('run_id=run-1');
    expect(removal?.url).toContain('block_id=blk-1');

    // The session record itself is never touched -- only the claim that it
    // belonged to this plan.
    expect(writes.some((entry) => entry.url.includes('/session-scripts'))).toBe(false);
  });
});

/*
 * WHICH OBJECTIVES A SESSION ADDRESSED — the build order's second bullet, and
 * the last piece of PR F.
 *
 * Two properties, and the first is the one this whole slice is shaped around:
 *
 *   1. nothing is counted. Objectives carry a DOMAIN, so a tally here is one
 *      step from a per-domain coverage chart about a child's training, and a
 *      step further from an objective completed because enough sessions
 *      pointed at it. An objective with no mark means nobody recorded one --
 *      never that the domain was neglected.
 *   2. an unmarked objective is still shown. A coach has to see what the class
 *      did NOT touch in order to mark it, and a list of only the marked ones
 *      would be a summary of itself.
 */
describe('marking the objectives a session addressed', () => {
  test('every objective is listed, marked and unmarked alike, with no count', async () => {
    await renderPage({
      blocks: [blockRow()],
      linkedSessions: [sessionRow({ run_id: 'run-1' })],
      objectives: [
        objectiveRow({ objective_id: 'obj-a', objective: 'Stop drifting to the ropes.' }),
        objectiveRow({ objective_id: 'obj-b', domain: 'mental', objective: 'Settle after a clean shot.' }),
        objectiveRow({ objective_id: 'obj-c', domain: 'nutrition_body_composition', objective: 'Eat before the session.' }),
      ],
      objectiveLinks: [{ run_id: 'run-1', objective_id: 'obj-a', linked_by_account_id: 'acct-coach-a' }],
    });
    await pickAthlete('ath-1');
    await openSessions();

    // The marked one and the two unmarked ones all render.
    expect(screen.getByRole('button', { name: 'Addressed: Stop drifting to the ropes.' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Not marked: Settle after a clean shot.' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Not marked: Eat before the session.' })).toBeTruthy();

    const body = document.body.textContent ?? '';
    // No tally of any kind. "1 of 3" and a nutrition domain reading zero are
    // the two shapes this refuses.
    expect(body).not.toMatch(/\d+\s*of\s*\d+/);
    expect(body).not.toMatch(/\d+\s*%/);
    expect(body).not.toMatch(/coverage|adherence|tally|neglect/i);
    expect(document.querySelectorAll('progress')).toHaveLength(0);
  });

  test('the marked state is the stored link, not a local guess', async () => {
    await renderPage({
      blocks: [blockRow()],
      linkedSessions: [sessionRow({ run_id: 'run-1' }), sessionRow({ run_id: 'run-2', delivered_on: '2026-09-15' })],
      objectives: [objectiveRow({ objective_id: 'obj-a', objective: 'Stop drifting to the ropes.' })],
      // Marked on run-1 only.
      objectiveLinks: [{ run_id: 'run-1', objective_id: 'obj-a', linked_by_account_id: 'acct-coach-a' }],
    });
    await pickAthlete('ath-1');
    await openSessions();

    // The same objective under two sessions: addressed in one, not the other.
    // A build that keyed the mark by objective alone would show both.
    const pressed = screen.getAllByRole('button', { name: /Stop drifting to the ropes\./ });
    expect(pressed).toHaveLength(2);
    const states = pressed.map((node) => node.getAttribute('aria-pressed'));
    expect(states.sort()).toEqual(['false', 'true']);
  });

  test('marking one sends the run, the objective AND the block', async () => {
    await renderPage({
      blocks: [blockRow({ block_id: 'blk-9' })],
      linkedSessions: [sessionRow({ run_id: 'run-7' })],
      objectives: [objectiveRow({ objective_id: 'obj-a', block_id: 'blk-9', objective: 'Stop drifting to the ropes.' })],
      objectiveLinks: [],
    });
    await pickAthlete('ath-1');
    await openSessions();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Not marked: Stop drifting/ }));
    });

    const write = writes.find((entry) => entry.method === 'POST' && 'objective_id' in entry.body);
    /* The block id travels with every write because the route gates on it: a
       group session serves several children's blocks, and a run-wide write
       would be a write about a child this coach may not have. */
    expect(write?.body).toEqual({
      run_id: 'run-7', objective_id: 'obj-a', block_id: 'blk-9',
    });
  });

  test('unmarking sends all three ids on the query string', async () => {
    await renderPage({
      blocks: [blockRow()],
      linkedSessions: [sessionRow({ run_id: 'run-1' })],
      objectives: [objectiveRow({ objective_id: 'obj-a', objective: 'Stop drifting to the ropes.' })],
      objectiveLinks: [{ run_id: 'run-1', objective_id: 'obj-a', linked_by_account_id: 'acct-coach-a' }],
    });
    await pickAthlete('ath-1');
    await openSessions();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Addressed: Stop drifting/ }));
    });

    const removal = writes.find((entry) => entry.method === 'DELETE' && entry.url.includes('objective_id'));
    expect(removal?.url).toContain('run_id=run-1');
    expect(removal?.url).toContain('objective_id=obj-a');
    expect(removal?.url).toContain('block_id=blk-1');
  });

  test('a refused mark shows the server\'s own reason', async () => {
    await renderPage({
      blocks: [blockRow()],
      linkedSessions: [sessionRow({ run_id: 'run-1' })],
      objectives: [objectiveRow({ objective: 'Stop drifting to the ropes.' })],
      objectiveWriteOk: false,
      objectiveWriteError: 'That objective is not on a block this session supports.',
    });
    await pickAthlete('ath-1');
    await openSessions();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Not marked: Stop drifting/ }));
    });

    expect(screen.getByText('That objective is not on a block this session supports.')).toBeTruthy();
  });

  test('a failed objective read is not rendered as "this block has no objectives"', async () => {
    await renderPage({
      blocks: [blockRow()],
      linkedSessions: [sessionRow({ run_id: 'run-1' })],
      objectivesOk: false,
    });
    await pickAthlete('ath-1');
    await openSessions();

    expect(screen.getByText(/objectives could not be read/i)).toBeTruthy();
    // And no control offering to mark something the page could not read.
    expect(screen.queryByText('Objectives this session addressed')).toBeNull();
  });

  test('a block with no objectives shows no marking controls, and says nothing about domains', async () => {
    await renderPage({
      blocks: [blockRow()],
      linkedSessions: [sessionRow({ run_id: 'run-1' })],
      objectives: [],
    });
    await pickAthlete('ath-1');
    await openSessions();

    expect(screen.queryByText('Objectives this session addressed')).toBeNull();
    // Silence, not a finding. A block with no objectives recorded is not a
    // block whose domains were neglected.
    expect(document.body.textContent ?? '').not.toMatch(/no objectives|missing|gap|neglect/i);
  });
});

/*
 * PLAN VERSUS WHAT WAS ACTUALLY RECORDED.
 *
 * The slice the two panels above deliberately stopped short of, and the one
 * place in this lane where a number could plausibly be assembled: a plan and a
 * record of activity are on screen together for the first time. Four
 * properties are worth asserting here and the rest belongs to the route and to
 * Postgres:
 *
 *   1. counts are of RECORDS and never of a plan. "3 recorded" is a fact about
 *      the database; "3 of 12 delivered" would be a fact about a coach, and
 *      there is no denominator anywhere that could honestly produce one.
 *   2. a zero renders as a zero and never as a finding. Nothing recorded means
 *      nobody wrote anything down.
 *   3. a failed read renders as a failure. This is the surface where that
 *      matters most: six silent zeroes are indistinguishable from an athlete
 *      with nothing logged.
 *   4. the judgement is the coach's. No state is pre-selected from the counts,
 *      nothing is drafted for them, and reviews accumulate rather than being
 *      edited.
 */
describe('plan versus what was recorded', () => {
  test('each source is a count of records, with no figure derived from them', async () => {
    await renderPage({
      blocks: [blockRow()],
      evidence: [
        evidenceRow({ key: 'sessions', label: 'Sessions linked to this block', recorded: 3 }),
        evidenceRow({ key: 'training_attempts', recorded: 12 }),
      ],
    });
    await pickAthlete('ath-1');
    await openReview();

    expect(screen.getByText('Sessions linked to this block: 3 recorded')).toBeTruthy();
    expect(screen.getByText('Training attempts recorded: 12 recorded')).toBeTruthy();

    const body = document.body.textContent ?? '';
    /* The two shapes this refuses, and the reason each is refused. "3 of 12"
       needs a denominator nothing here has; a percentage would be a machine's
       verdict on a coach's work with a child, believed precisely because it
       looked measured. */
    expect(body).not.toMatch(/\d+\s*of\s*\d+/);
    expect(body).not.toMatch(/\d+\s*%/);
    expect(body).not.toMatch(/on track|behind schedule|compliance/i);
    /* And the positive half, which is the one that would silently rot: every
       number this panel shows carries the word saying what it is a count OF.
       A bare "3" beside "Sessions linked to this block" reads as three
       sessions' worth of a plan; "3 recorded" reads as three rows. */
    for (const count of ['3 recorded', '12 recorded']) {
      expect(body).toContain(count);
    }
    expect(document.querySelectorAll('progress')).toHaveLength(0);
    expect(document.querySelectorAll('[role="progressbar"]')).toHaveLength(0);
  });

  test('rows no window can place are shown apart from the count, not folded into it', async () => {
    await renderPage({
      blocks: [blockRow()],
      evidence: [
        evidenceRow({ key: 'assessments', label: 'Assessments administered', recorded: 2, undated: 3 }),
        evidenceRow({ key: 'sessions', label: 'Sessions linked to this block', recorded: 1, undated: 0 }),
      ],
    });
    await pickAthlete('ath-1');
    await openReview();

    /* An assessment scheduled and never administered has no date, so no
       window contains it. Counting it would claim a test happened; dropping
       it would hide three records a coach is looking for. Two counts, said
       separately. */
    expect(screen.getByText('Assessments administered: 2 recorded')).toBeTruthy();
    expect(screen.getByText(/3 more on record with no date/i)).toBeTruthy();
    // And a source with none says nothing, rather than "0 more on record".
    expect(document.body.textContent ?? '').not.toMatch(/0 more on record/);
  });

  test('a zero is shown as a zero, with the reading it does NOT support said out loud', async () => {
    await renderPage({
      blocks: [blockRow()],
      evidence: [evidenceRow({ key: 'activity_log', label: 'Activity entries recorded', recorded: 0 })],
    });
    await pickAthlete('ath-1');
    await openReview();

    // The source is still on screen saying zero. Dropping empty sources would
    // turn "nobody recorded anything" into a source that does not exist.
    expect(screen.getByText('Activity entries recorded: 0 recorded')).toBeTruthy();
    /* The zero is stated AND the reading it does not support is stated with
       it. The denial has to be on screen rather than in a comment: a coach
       looking at a column of zeroes will draw a conclusion, and the only
       place to stop the wrong one is next to the zeroes. */
    expect(screen.getByText(/nobody wrote anything down/i)).toBeTruthy();
    expect(screen.getByText(/not a statement that the athlete did not train/i)).toBeTruthy();
    // And no word that would turn the zero into a finding on its own.
    expect(document.body.textContent ?? '').not.toMatch(/\bgap\b|\bmissing\b|\bneglect/i);
  });

  test('a failed read is not rendered as an athlete who recorded nothing', async () => {
    await renderPage({ blocks: [blockRow()], reviewReadOk: false });
    await pickAthlete('ath-1');
    await openReview();

    /* THE HONESTY RULE at the surface where breaking it looks most like
       insight: six zeroes from a failed read and six zeroes from an empty
       record are the same picture, and only one of them is true. */
    expect(screen.getByText(/record for this block could not be read/i)).toBeTruthy();
    expect(document.body.textContent ?? '').not.toMatch(/0 recorded/);
  });

  test('the form opens undecided and nothing pre-selects a state from the counts', async () => {
    await renderPage({
      blocks: [blockRow()],
      evidence: [evidenceRow({ key: 'sessions', label: 'Sessions linked to this block', recorded: 0 })],
    });
    await pickAthlete('ath-1');
    await openReview();

    /* Zero sessions recorded and the state still reads 'unknown'. A page that
       read the counts and chose 'not_delivered' would be the machine making
       the judgement the order reserves for a human -- and it would be wrong
       whenever the real cause was that nobody filled the log in. */
    const select = screen.getByLabelText('How did it go') as HTMLSelectElement;
    expect(select.value).toBe('unknown');
    // And no drafted words anywhere in the fields the coach must write.
    for (const label of ['What departed from the plan', 'Why', 'What worked', 'What did not', 'What you will adjust']) {
      expect((screen.getByLabelText(label) as HTMLTextAreaElement).value).toBe('');
    }
  });

  test('the coach\'s chosen state and words are what gets sent', async () => {
    await renderPage({ blocks: [blockRow()] });
    await pickAthlete('ath-1');
    await openReview();

    await act(async () => {
      fireEvent.change(screen.getByLabelText('How did it go'), {
        target: { value: 'delivered_with_deviations' },
      });
      fireEvent.change(screen.getByLabelText('What departed from the plan'), {
        target: { value: 'Two weeks lost to a hall closure.' },
      });
      fireEvent.change(screen.getByLabelText('What you will adjust'), {
        target: { value: 'Move the southpaw work forward.' },
      });
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Record review' }));
    });

    const write = writes.find((entry) => entry.url.includes('block-review'));
    expect(write?.body).toMatchObject({
      block_id: 'blk-1',
      adherence_state: 'delivered_with_deviations',
      deviations: 'Two weeks lost to a hall closure.',
      next_adjustment: 'Move the southpaw work forward.',
    });
    expect(screen.getByText('Review recorded.')).toBeTruthy();
  });

  test('the server\'s own refusal is what the coach reads', async () => {
    await renderPage({
      blocks: [blockRow()],
      reviewWriteOk: false,
      reviewWriteError: 'Recording "delivered with deviations" means saying what the deviations were.',
    });
    await pickAthlete('ath-1');
    await openReview();

    await act(async () => {
      fireEvent.change(screen.getByLabelText('How did it go'), {
        target: { value: 'delivered_with_deviations' },
      });
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Record review' }));
    });

    // The reason, not "something went wrong" -- a coach who cannot see which
    // rule they broke cannot fix it.
    expect(screen.getByText(/means saying what the deviations were/i)).toBeTruthy();
  });

  test('every review is shown, not just the latest, and none of them is edited', async () => {
    await renderPage({
      blocks: [blockRow()],
      reviews: [
        reviewRow({
          review_id: 'rev-2',
          adherence_state: 'delivered_with_deviations',
          deviations: 'Two weeks lost to a hall closure.',
          created_at: '2026-10-14T00:00:00.000Z',
        }),
        reviewRow({
          review_id: 'rev-1',
          adherence_state: 'under_delivered',
          reason: 'Hall closed.',
          created_at: '2026-09-20T00:00:00.000Z',
        }),
      ],
    });
    await pickAthlete('ath-1');
    await openReview();

    /* Both readings, in the coach's chosen words. An earlier review saying the
       block was off track and a later one saying it recovered are both true,
       and showing only the second erases the more useful half. */
    /* getAllByText, because the picker's options carry the same five words --
       deliberately: the vocabulary a coach chooses from and the vocabulary a
       recorded review reads back in are ONE vocabulary, and a second spelling
       for the review card would be a second answer to one question. What this
       asserts is that each state is also rendered as a recorded review, not
       only as an option nobody has picked. */
    const recorded = (label: string) => screen.getAllByText(label)
      .some((element) => element.tagName === 'P');
    expect(recorded('Delivered with deviations')).toBe(true);
    expect(recorded('Under-delivered')).toBe(true);
    expect(screen.getByText('Deviations: Two weeks lost to a hall closure.')).toBeTruthy();
    expect(screen.getByText('Reason: Hall closed.')).toBeTruthy();

    // No edit path: a judgement recorded at the time is a fact about that time.
    expect(screen.queryByRole('button', { name: /edit review/i })).toBeNull();
    expect(screen.getByText(/Reviews are not edited/i)).toBeTruthy();
  });

  test('a review carries who made it, because that is the point of the record', async () => {
    await renderPage({
      blocks: [blockRow()],
      reviews: [reviewRow({ reviewed_by_account_id: 'acct-coach-b' })],
    });
    await pickAthlete('ath-1');
    await openReview();

    expect(screen.getByText(/Reviewed by acct-coach-b/)).toBeTruthy();
  });

  test('nothing on this page consults SHADOW or offers a generated reading', async () => {
    const fetchMock = await renderPage({
      blocks: [blockRow()],
      evidence: [evidenceRow({ key: 'sessions', label: 'Sessions linked to this block', recorded: 4 })],
    });
    await pickAthlete('ath-1');
    await openReview();

    /* The order permits a SHADOW summary and does not require one: "SHADOW may
       summarize evidence, but must not silently become the final evaluator."
       An automated reading of a child's training record needs its own evidence
       and safety contract rather than arriving as a side effect of a review
       panel, so nothing here asks for one. */
    for (const call of fetchMock.mock.calls) {
      expect(String(call[0])).not.toMatch(/shadow/i);
    }
    expect(document.body.textContent ?? '').not.toMatch(/suggest|recommend|SHADOW|AI |generated/i);
  });
});

/*
 * A DOZEN BLOCKS MUST NOT MEAN A DOZEN EXTRA READS.
 *
 * The objectives panel has always loaded on open, and its test says why in
 * exactly those words. The sessions, objective-mark and plan-vs-actual panels
 * did not: all three fired for every block on every roster load, so a coach
 * with a dozen blocks issued thirty-six requests -- each a separate
 * authorization decision at its route -- for panels they had not asked to see.
 *
 * This is the test that holds the page to one interaction model.
 */
describe('nothing about a block is read until a coach asks for it', () => {
  const threeBlocks = [
    blockRow({ block_id: 'blk-1' }),
    blockRow({ block_id: 'blk-2' }),
    blockRow({ block_id: 'blk-3' }),
  ];

  test('choosing an athlete reads the blocks and nothing per block', async () => {
    const fetchMock = await renderPage({ blocks: threeBlocks });
    await pickAthlete('ath-1');

    const urls = fetchMock.mock.calls.map((call) => String(call[0]));
    for (const perBlock of ['session-block-links?block_id=', 'session-objective-links?block_id=',
                            'block-review?block_id=', 'development-block-objectives?block_id=']) {
      expect([perBlock, urls.some((url) => url.includes(perBlock))]).toEqual([perBlock, false]);
    }
  });

  test('opening one block\'s sessions reads that block only', async () => {
    const fetchMock = await renderPage({ blocks: threeBlocks });
    await pickAthlete('ath-1');
    await act(async () => {
      fireEvent.click(screen.getAllByRole('button', { name: 'Sessions' })[0]);
    });

    const urls = fetchMock.mock.calls.map((call) => String(call[0]));
    const asked = urls.filter((url) => url.includes('session-block-links?block_id='));
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain('block_id=blk-1');
    // The other two blocks were not read.
    expect(urls.some((url) => url.includes('block_id=blk-2'))).toBe(false);
    expect(urls.some((url) => url.includes('block_id=blk-3'))).toBe(false);
  });

  test('opening the plan-vs-actual panel reads the review, and only on request', async () => {
    const fetchMock = await renderPage({ blocks: [blockRow()] });
    await pickAthlete('ath-1');
    expect(fetchMock.mock.calls.map((c) => String(c[0])).some((u) => u.includes('block-review'))).toBe(false);

    await openReview();

    expect(fetchMock.mock.calls.map((c) => String(c[0])).some((u) => u.includes('block-review'))).toBe(true);
  });
});
