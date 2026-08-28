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
  runOptionsOk?: boolean;
  runOptions?: Array<Record<string, unknown>>;
  linkedSessionsOk?: boolean;
  linkedSessions?: Array<Record<string, unknown>>;
  linkOk?: boolean;
  linkError?: string;
  linkCreated?: boolean;
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

    expect(screen.getByText(/Written by acct-coach-a/)).toBeTruthy();
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

    expect(screen.getByText(/linked sessions could not be read/i)).toBeTruthy();
    expect(screen.queryByText(/No session has been linked to this block yet/i)).toBeNull();
  });

  test('a genuinely empty list says so, and is not the same message', async () => {
    await renderPage({ blocks: [blockRow()], linkedSessions: [] });
    await pickAthlete('ath-1');

    expect(screen.getByText(/No session has been linked to this block yet/i)).toBeTruthy();
    expect(screen.queryByText(/linked sessions could not be read/i)).toBeNull();
  });

  test('a failed picker read is not rendered as "no sessions have been delivered"', async () => {
    await renderPage({ blocks: [blockRow()], runOptionsOk: false });
    await pickAthlete('ath-1');

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

    await act(async () => {
      fireEvent.change(screen.getByLabelText('Link a session'), { target: { value: 'run-1' } });
    });

    expect(screen.getByText('Session not found.')).toBeTruthy();
  });

  test('unlinking sends both ids and removes the statement, not the session', async () => {
    await renderPage({ blocks: [blockRow()], linkedSessions: [sessionRow()] });
    await pickAthlete('ath-1');

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
