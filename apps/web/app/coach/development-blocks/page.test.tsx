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
  /** Delays the write response, so a second click lands while the first is in
      flight. Without this a double-submit test proves nothing. */
  holdWrite?: () => Promise<void>;
}

const writes: Array<{ method: string; body: Record<string, unknown> }> = [];

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
      if (method === 'GET') {
        return {
          ok: stubs.blocksOk ?? true,
          status: stubs.blocksOk === false ? 503 : 200,
          json: async () => ({ ok: true, blocks: stubs.blocks ?? [] }),
        } as Response;
      }
      writes.push({ method, body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> });
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
