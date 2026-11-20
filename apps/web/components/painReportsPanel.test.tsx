/**
 * @jest-environment jsdom
 */

// The pain list and its one read (lane U2-6b-2; Overwatch GO 6b-2, QF = A). The list moved out
// of the coach home unchanged in what it shows; the read is the one the coach home, its floor
// board and, on the class screen, the pain tile all draw. What these pin: one read with limit=50;
// a read that cannot state its window, completeness or list is a failed read, never "no athlete
// reported pain"; the newest answer wins; and a pain report never looks like a medical stop.

import '@testing-library/jest-dom';
import { useEffect } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';

import PainReportsPanel from './PainReportsPanel';
import { painTileRead, usePainReports, type PainReportsRead } from './usePainReports';

jest.mock('@/lib/apiBase', () => ({ apiBase: () => '' }));

const FEED = '/api/pilot/coach/pain-reports?limit=50';

function json(body: unknown, status = 200) {
  return { ok: status < 400, status, json: async () => body } as Response;
}

function report(id: string, overrides: Record<string, unknown> = {}) {
  return {
    nearMissId: id,
    athleteId: `ath_${id}`,
    athleteName: 'Casey R.',
    severity: 'moderate',
    painScore: 6,
    location: 'Left wrist',
    painType: 'Sharp',
    observedAt: null,
    recordedAt: null,
    reporter: 'athlete',
    ...overrides,
  };
}

const EMPTY = { ok: true, windowDays: 7, truncated: false, painReports: [] };

let answers: Array<() => Response | Promise<Response>>;
let reads: string[];

beforeEach(() => {
  answers = [];
  reads = [];
  global.fetch = jest.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    reads.push(url);
    if (url !== FEED) throw new Error(`unexpected ${url}`);
    const next = answers.length > 1 ? answers.shift()! : answers[0];
    if (!next) throw new Error('no answer queued');
    return next();
  }) as unknown as typeof fetch;
});

afterEach(() => {
  jest.useRealTimers();
});

// The read as the harness last rendered it, recorded after each render.
const seen: { read: PainReportsRead | null } = { read: null };

function Harness({ refreshMs, boardShown = false }: { refreshMs?: number; boardShown?: boolean }) {
  const read = usePainReports({ refreshMs });
  useEffect(() => {
    seen.read = read;
  });
  return <PainReportsPanel read={read} boardShown={boardShown} />;
}

async function settle() {
  await act(async () => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  });
}

async function show(props: { refreshMs?: number; boardShown?: boolean } = {}) {
  await act(async () => {
    render(<Harness {...props} />);
  });
  await settle();
}

const FAILED_WORDS = 'Pain reports may exist that are not shown here.';

describe('the read', () => {
  test('reads the feed once, with limit=50, and again only when asked', async () => {
    answers = [() => json(EMPTY)];
    await show();
    expect(reads).toEqual([FEED]);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh athlete pain reports' }));
    await settle();
    expect(reads).toEqual([FEED, FEED]);
  });

  test('a timed refresh keeps the last answer on screen until the new one arrives', async () => {
    jest.useFakeTimers();
    let held: (response: Response) => void = () => undefined;
    answers = [
      () => json({ ...EMPTY, painReports: [report('n1'), report('n2')] }),
      () => new Promise<Response>((resolve) => {
        held = resolve;
      }),
    ];
    await show({ refreshMs: 120_000 });
    expect(screen.getAllByRole('article')).toHaveLength(2);
    await act(async () => {
      jest.advanceTimersByTime(120_000);
    });
    await settle();
    expect(reads).toHaveLength(2);
    expect(screen.getAllByRole('article')).toHaveLength(2);
    expect(screen.queryByText('Checking for athlete pain reports...')).toBeNull();
    await act(async () => {
      held(json(EMPTY));
    });
    await settle();
    expect(screen.queryAllByRole('article')).toHaveLength(0);
    expect(screen.getByText(/No athlete on your roster has reported pain in the last 7 days/)).toBeInTheDocument();
  });

  test('Refresh, which the coach asks for, says it is checking while the read is out', async () => {
    answers = [() => json({ ...EMPTY, painReports: [report('n1')] }), () => new Promise<Response>(() => undefined)];
    await show();
    expect(screen.getAllByRole('article')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh athlete pain reports' }));
    await settle();
    expect(screen.getByText('Checking for athlete pain reports...')).toBeInTheDocument();
  });

  test('with a refresh pace, reads again at that pace', async () => {
    jest.useFakeTimers();
    answers = [() => json(EMPTY)];
    await show({ refreshMs: 120_000 });
    expect(reads).toHaveLength(1);
    await act(async () => {
      jest.advanceTimersByTime(119_000);
    });
    expect(reads).toHaveLength(1);
    await act(async () => {
      jest.advanceTimersByTime(1_000);
    });
    await settle();
    expect(reads).toHaveLength(2);
  });

  test.each([
    ['a server error', () => json({ error: 'boom' }, 500)],
    ['a refusal', () => json({ ok: false, error: 'Forbidden' }, 403)],
    ['a body with no window', () => json({ ok: true, truncated: false, painReports: [] })],
    ['a body with no completeness flag', () => json({ ok: true, windowDays: 7, painReports: [] })],
    ['a body with no list', () => json({ ok: true, windowDays: 7, truncated: false })],
    ['a body not marked ok', () => json({ ok: false, windowDays: 7, truncated: false, painReports: [] })],
  ])('%s is a failed read: its words, never "no athlete reported pain"', async (_label, answer) => {
    answers = [answer];
    await show();
    expect(screen.getByText('Unable to load athlete pain reports')).toBeInTheDocument();
    expect(screen.getByText(new RegExp(FAILED_WORDS))).toBeInTheDocument();
    expect(screen.queryByText(/No athlete on your roster has reported pain/)).toBeNull();
    expect(painTileRead(seen.read!)).toEqual({ state: 'failed' });
  });

  test('a network failure is a failed read too', async () => {
    answers = [() => {
      throw new Error('network down');
    }];
    await show();
    expect(screen.getByText(new RegExp(FAILED_WORDS))).toBeInTheDocument();
    expect(screen.queryByText(/No athlete on your roster has reported pain/)).toBeNull();
  });

  test('a slow earlier answer never replaces a newer one: a later failure stays', async () => {
    let late: (response: Response) => void = () => undefined;
    answers = [
      () => new Promise<Response>((resolve) => {
        late = resolve;
      }),
      () => json({ error: 'boom' }, 500),
    ];
    await show();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh athlete pain reports' }));
    await settle();
    expect(screen.getByText(new RegExp(FAILED_WORDS))).toBeInTheDocument();
    await act(async () => {
      late(json({ ...EMPTY, painReports: [report('n1')] }));
    });
    await settle();
    expect(screen.getByText(new RegExp(FAILED_WORDS))).toBeInTheDocument();
    expect(screen.queryByText('Casey R.')).toBeNull();
  });

  test('a slow earlier failure never replaces a newer answer: the list stays', async () => {
    let late: (response: Response) => void = () => undefined;
    answers = [
      () => new Promise<Response>((resolve) => {
        late = resolve;
      }),
      () => json({ ...EMPTY, painReports: [report('n1')] }),
    ];
    await show();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh athlete pain reports' }));
    await settle();
    expect(screen.getAllByRole('article')).toHaveLength(1);
    await act(async () => {
      late(json({ error: 'boom' }, 500));
    });
    await settle();
    expect(screen.getAllByRole('article')).toHaveLength(1);
    expect(screen.queryByText(new RegExp(FAILED_WORDS))).toBeNull();
  });

  test('a read slower than the next still shows when nothing newer has answered', async () => {
    const pending: Array<(response: Response) => void> = [];
    answers = [
      () => new Promise<Response>((resolve) => {
        pending.push(resolve);
      }),
    ];
    await show();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh athlete pain reports' }));
    await settle();
    expect(pending).toHaveLength(2);
    await act(async () => {
      pending[0](json({ ...EMPTY, painReports: [report('n1')] }));
    });
    await settle();
    expect(seen.read?.answered).toBe(true);
    expect(seen.read?.reports).toHaveLength(1);
    // The newer read is still out, so the list says it is checking.
    expect(seen.read?.loading).toBe(true);
    await act(async () => {
      pending[1](json(EMPTY));
    });
    await settle();
    expect(seen.read?.loading).toBe(false);
    expect(screen.getByText(/No athlete on your roster has reported pain in the last 7 days/)).toBeInTheDocument();
  });

  test('a failure clears the reports, keeps the window last read, and the tile read says failed', async () => {
    answers = [() => json({ ...EMPTY, windowDays: 7, painReports: [report('n1')] }), () => json({ error: 'boom' }, 500)];
    await show();
    expect(painTileRead(seen.read!)).toEqual({ state: 'ok', value: { count: 1, truncated: false, windowDays: 7 } });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh athlete pain reports' }));
    await settle();
    expect(seen.read?.windowDays).toBe(7);
    expect(seen.read?.reports).toEqual([]);
    expect(painTileRead(seen.read!)).toEqual({ state: 'failed' });
  });
});

describe('the tile read', () => {
  const base = { answered: true, error: '', reports: [], windowDays: 7, truncated: false };
  test('nothing yet before any answer; failed on a failure or no window; else the rows and the window', () => {
    expect(painTileRead({ ...base, answered: false })).toEqual({ state: 'loading' });
    expect(painTileRead({ ...base, error: 'Unable to load athlete pain reports' })).toEqual({ state: 'failed' });
    expect(painTileRead({ ...base, windowDays: null })).toEqual({ state: 'failed' });
    expect(painTileRead({ ...base, reports: [report('a'), report('b')] as never, truncated: true, windowDays: 14 })).toEqual({
      state: 'ok',
      value: { count: 2, truncated: true, windowDays: 14 },
    });
  });
});

describe('the list, as the coach home drew it', () => {
  test('while the first read is out it says it is checking, and nothing else', async () => {
    answers = [() => new Promise<Response>(() => undefined)];
    await show();
    expect(screen.getByText('Checking for athlete pain reports...')).toBeInTheDocument();
    expect(screen.queryByText(/No athlete on your roster/)).toBeNull();
    expect(screen.queryByText(new RegExp(FAILED_WORDS))).toBeNull();
  });

  test('an empty feed names its window', async () => {
    answers = [() => json({ ...EMPTY, windowDays: 14 })];
    await show();
    expect(screen.getByText(/No athlete on your roster has reported pain in the last 14 days\./)).toBeInTheDocument();
  });

  test('a card: the name, the id, the number, what the athlete did not state, and who reported it', async () => {
    answers = [() => json({
      ...EMPTY,
      painReports: [
        report('n1', { location: null, painType: null, painScore: 7, severity: 'critical' }),
        report('n2', { athleteName: null, reporter: 'coach', location: null, severity: 'low', painScore: 2 }),
      ],
    })];
    await show();
    const [first, second] = screen.getAllByRole('article');
    expect(first).toHaveTextContent('Casey R.');
    expect(first).toHaveTextContent('Athlete ID ath_n1');
    expect(first).toHaveTextContent('Not stated by the athlete');
    expect(first).toHaveTextContent('Not recorded');
    expect(first).toHaveTextContent('Self-reported by the athlete. This is not a coach assessment and not a medical assessment.');
    // A 7/10 stored as critical wears the restricted rung, never the medical stop.
    expect(first.querySelector('.badge')?.className).toBe('badge badge--restricted');
    expect(first.querySelector('.badge')?.textContent).toMatch(/^▲/);
    expect(second).toHaveTextContent('Athlete name unavailable');
    expect(second).toHaveTextContent('Not stated');
    expect(second).not.toHaveTextContent('Not stated by the athlete');
    expect(second).toHaveTextContent('Entered by a coach, not self-reported by the athlete.');
    expect(second.querySelector('.badge')?.className).toBe('badge badge--monitor');
  });

  test('a truncated feed says more matched than are listed', async () => {
    answers = [() => json({ ...EMPTY, truncated: true, painReports: [report('n1')] })];
    await show();
    expect(screen.getByText(/More reports matched than are listed here\./)).toBeInTheDocument();
  });

  test.each([
    [true, 'Record what you did from Needs You Now on the floor board above.', null],
    [false, null, 'Record What You Did'],
  ])('with the floor board shown = %s, "Record what you did" is where the coach can do it', async (boardShown, words, link) => {
    answers = [() => json({ ...EMPTY, painReports: [report('n1')] })];
    await show({ boardShown });
    if (words) expect(screen.getByText(words)).toBeInTheDocument();
    if (link) expect(screen.getByRole('link', { name: link })).toHaveAttribute('href', '/coach/decision-loop');
    if (!link) expect(screen.queryByRole('link', { name: 'Record What You Did' })).toBeNull();
  });

  test.each([
    ['a list', () => json({ ...EMPTY, painReports: ['critical', 'high', 'moderate', 'low'].map((severity, i) => report(`n${i}`, { severity })) })],
    ['a failed read', () => json({ error: 'boom' }, 500)],
  ])('%s is never drawn as a medical stop', async (_label, answer) => {
    answers = [answer];
    await show();
    const html = document.body.innerHTML;
    expect(html).not.toMatch(/locked/);
  });
});
