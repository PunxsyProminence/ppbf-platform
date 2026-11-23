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
    reporter: 'athlete', note: null, reviewed: null,
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

function Harness({ refreshMs, boardShown = false, timed = false, showsNotes }: { refreshMs?: number; boardShown?: boolean; timed?: boolean; showsNotes?: boolean }) {
  const read = usePainReports({ refreshMs });
  useEffect(() => {
    seen.read = read;
  });
  return <PainReportsPanel read={read} boardShown={boardShown} readsEveryTwoMinutes={timed} showsNotes={showsNotes} />;
}

async function settle() {
  await act(async () => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  });
}

async function show(props: { refreshMs?: number; boardShown?: boolean; timed?: boolean; showsNotes?: boolean } = {}) {
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

  test.each([
    ['a network failure', () => {
      throw new TypeError('Failed to fetch');
    }],
    ['a body that is not JSON', () => ({ ok: true, status: 200, json: async () => {
      throw new SyntaxError('Unexpected token < in JSON at position 0');
    } }) as unknown as Response],
  ])('%s shows the panel\'s own words, never the browser\'s error text', async (_label, answer) => {
    answers = [answer];
    await show();
    expect(screen.getByText('Unable to load athlete pain reports')).toBeInTheDocument();
    expect(screen.getByText(new RegExp(FAILED_WORDS))).toBeInTheDocument();
    expect(screen.queryByText(/Failed to fetch|Unexpected token/)).toBeNull();
    expect(screen.queryByText(/No athlete on your roster has reported pain/)).toBeNull();
  });

  test('a row the panel cannot draw is skipped, not thrown, and never silently: the list says reports may not be shown', async () => {
    answers = [() => json({
      ...EMPTY,
      painReports: [
        report('n1'),
        null,
        'a string',
        { nearMissId: 7 },
        report('n2', { observedAt: { when: 'yesterday' } }),
        report('n3', { severity: 'severe' }),
        report('n4', { reporter: 'someone' }),
        report('n5', { athleteName: 'Jordan P.', painScore: null }),
      ],
    })];
    await show();
    const cards = screen.getAllByRole('article');
    expect(cards).toHaveLength(2);
    expect(cards[0]).toHaveTextContent('Athlete ID ath_n1');
    expect(cards[1]).toHaveTextContent('Jordan P.');
    // The six it could not draw are said, in the failed-read words, beside the two it could.
    expect(screen.getByText('Unable to load athlete pain reports')).toBeInTheDocument();
    expect(screen.getByText(new RegExp(FAILED_WORDS))).toBeInTheDocument();
    expect(seen.read?.unreadRows).toBe(6);
    // The tile counts the feed's rows (Q3 = A).
    expect(painTileRead(seen.read!)).toEqual({ state: 'ok', value: { count: 8, truncated: false, windowDays: 7 } });
  });

  test('when no row can be drawn, the list never says no athlete has reported pain', async () => {
    answers = [() => json({ ...EMPTY, painReports: [report('n1', { reporter: 'parent' })] })];
    await show({ timed: true });
    expect(screen.queryByRole('article')).toBeNull();
    expect(screen.queryByText(/No athlete on your roster has reported pain/)).toBeNull();
    expect(screen.getByText('Unable to load athlete pain reports')).toBeInTheDocument();
    expect(screen.getByText(new RegExp(FAILED_WORDS))).toBeInTheDocument();
    expect(painTileRead(seen.read!)).toEqual({ state: 'ok', value: { count: 1, truncated: false, windowDays: 7 } });
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
  const base = { answered: true, error: '', rowCount: 0, windowDays: 7, truncated: false };
  test('nothing yet before any answer; failed on a failure or no window; else the feed\'s rows and the window', () => {
    expect(painTileRead({ ...base, answered: false })).toEqual({ state: 'loading' });
    expect(painTileRead({ ...base, error: 'Unable to load athlete pain reports' })).toEqual({ state: 'failed' });
    expect(painTileRead({ ...base, windowDays: null })).toEqual({ state: 'failed' });
    expect(painTileRead({ ...base, rowCount: 2, truncated: true, windowDays: 14 })).toEqual({
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

  test('an empty feed names its window, and on the coach home says to press Refresh (QJ = B)', async () => {
    answers = [() => json({ ...EMPTY, windowDays: 14 })];
    await show();
    const line = screen.getByText(/No athlete on your roster has reported pain in the last 14 days\./);
    expect(line).toHaveTextContent('No athlete on your roster has reported pain in the last 14 days. Press Refresh to check for new reports.');
    expect(screen.queryByText(/as soon as an athlete submits one/)).toBeNull();
  });

  test('on a screen that reads every two minutes, it says a report appears within two minutes (QJ = B)', async () => {
    answers = [() => json(EMPTY)];
    await show({ timed: true });
    expect(screen.getByText(/No athlete on your roster/)).toHaveTextContent(
      'No athlete on your roster has reported pain in the last 7 days. A report appears here within two minutes of an athlete sending it.',
    );
    expect(screen.queryByText(/Press Refresh to check/)).toBeNull();
  });

  test.each([
    ['a list', () => json({ ...EMPTY, truncated: true, painReports: [report('n1')] })],
    ['an empty feed', () => json(EMPTY)],
    ['a failed read', () => json({ error: 'boom' }, 500)],
    ['a read still out', () => new Promise<Response>(() => undefined)],
  ])('%s: no text below the gym-floor minimum, --t-md (QI = B)', async (_label, answer) => {
    answers = [answer];
    await show();
    const panel = document.getElementById('coach-dashboard-details');
    expect(panel).not.toBeNull();
    expect(panel!.outerHTML).not.toMatch(/text-xs|text-sm|--t-xs|--t-sm/);
    expect(screen.getByRole('heading', { name: 'Athlete Pain Reports' }).className).toContain('text-[length:var(--t-md)]');
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
    [true, 'Record what you did from Needs You Now at the top of the page.', null],
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

// DR-25 (Jason 2026-11-23, DR-25 A; Overwatch GO on #2133 and its wording on #2138): the athlete's
// note on each card, and "Mark reviewed" with who and when, each state a word and a glyph.
describe('the note and Mark reviewed (DR-25)', () => {
  const REVIEW = '/api/pilot/coach/pain-reports/n1/review';
  let reviewAnswers: Array<() => Response | Promise<Response>>;

  beforeEach(() => {
    reviewAnswers = [];
    global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      reads.push(`${init?.method ?? 'GET'} ${url}`);
      if (url === FEED) return answers[0]();
      if (url === REVIEW && init?.method === 'POST') {
        const next = reviewAnswers.shift();
        if (!next) throw new Error('no review answer queued');
        return next();
      }
      throw new Error(`unexpected ${url}`);
    }) as unknown as typeof fetch;
  });

  test("a note shows under Athlete's note; none reads No note", async () => {
    answers = [() => json({ ...EMPTY, painReports: [report('n1', { note: 'left knee clicks\nwhen I squat' }), report('n2')] })];
    await show();
    const [withNote, without] = screen.getAllByRole('article');
    expect(withNote).toHaveTextContent("Athlete's note");
    expect(withNote).toHaveTextContent('left knee clicks when I squat');
    expect(without).toHaveTextContent('No note');
    expect(screen.queryByText("Only admins see this note. A coach's review does not cover it.")).toBeNull();
  });

  test("an admin's copy of a held note says only admins see it and a coach's review does not cover it", async () => {
    answers = [() => json({ ...EMPTY, painReports: [report('n1', { note: 'My coach hits me', noteAdminOnly: true })] })];
    await show();
    expect(screen.getByText('My coach hits me')).toBeInTheDocument();
    expect(screen.getByText("Only admins see this note. A coach's review does not cover it.")).toBeInTheDocument();
  });

  test('not reviewed: the word, the glyph and the button; pressed, it names who reviewed it and when', async () => {
    answers = [() => json({ ...EMPTY, painReports: [report('n1')] })];
    let release: (response: Response) => void = () => undefined;
    reviewAnswers = [() => new Promise<Response>((resolve) => {
      release = resolve;
    })];
    await show();
    expect(screen.getByText('Not reviewed yet')).toBeInTheDocument();
    expect(screen.getByText('○', { exact: false })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Mark reviewed' }));
    await settle();
    expect(screen.getByRole('button', { name: 'Saving…' })).toBeDisabled();
    expect(reads).toContain(`POST ${REVIEW}`);

    await act(async () => {
      release(json({ ok: true, reviewed: { at: '2026-11-23T16:00:00.000Z', byName: 'Rosa Coach' } }));
    });
    await settle();
    expect(screen.queryByRole('button', { name: 'Mark reviewed' })).toBeNull();
    // The time follows the name.
    expect(screen.getByText(/Reviewed by Rosa Coach, \S/)).toBeInTheDocument();
    expect(screen.getByText('✓', { exact: false })).toBeInTheDocument();
  });

  test('a report already reviewed names the reviewer, or a staff member when they cannot be named', async () => {
    answers = [() => json({
      ...EMPTY,
      painReports: [
        report('n1', { reviewed: { at: '2026-11-23T16:00:00.000Z', byName: 'Rosa Coach' } }),
        report('n2', { reviewed: { at: '2026-11-23T16:05:00.000Z', byName: null } }),
      ],
    })];
    await show();
    expect(screen.getByText(/Reviewed by Rosa Coach,/)).toBeInTheDocument();
    expect(screen.getByText(/Reviewed by a staff member,/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Mark reviewed' })).toBeNull();
  });

  test("a failed press shows the panel's own words and the button again", async () => {
    answers = [() => json({ ...EMPTY, painReports: [report('n1')] })];
    reviewAnswers = [() => json({ error: 'Not found' }, 404)];
    await show();
    fireEvent.click(screen.getByRole('button', { name: 'Mark reviewed' }));
    await settle();
    expect(screen.getByRole('alert')).toHaveTextContent('Could not mark this report reviewed. Try again.');
    expect(screen.getByRole('button', { name: 'Mark reviewed' })).toBeEnabled();
    expect(screen.getByText('Not reviewed yet')).toBeInTheDocument();
  });

  test("on the floor tablet (showsNotes false) no card draws a note field or a review control, not even for an admin's held note", async () => {
    answers = [() => json({
      ...EMPTY,
      painReports: [
        report('n1', { note: 'My coach hits me', noteAdminOnly: true }),
        report('n2', { note: 'sore after sparring', noteAdminOnly: false }),
        report('n3'),
      ],
    })];
    await show({ showsNotes: false });
    expect(screen.getAllByRole('article')).toHaveLength(3);
    expect(screen.queryByText("Athlete's note")).toBeNull();
    expect(screen.queryByText('No note')).toBeNull();
    expect(screen.queryByText('My coach hits me')).toBeNull();
    expect(screen.queryByText('sore after sparring')).toBeNull();
    expect(screen.queryByText("Only admins see this note. A coach's review does not cover it.")).toBeNull();
    // Nor is any report marked reviewed there: a review would vouch for a note nobody saw.
    expect(screen.queryByRole('button', { name: 'Mark reviewed' })).toBeNull();
    expect(screen.queryByText('Not reviewed yet')).toBeNull();
  });

  test('a row whose note or review it cannot read is not drawn, and the list says reports may be missing', async () => {
    answers = [() => json({
      ...EMPTY,
      painReports: [
        report('n1', { note: 42 }),
        report('n2', { reviewed: { at: '', byName: 'x' } }),
        report('n3', { noteAdminOnly: 'yes' }),
        report('n4'),
      ],
    })];
    await show();
    expect(screen.getAllByRole('article')).toHaveLength(1);
    expect(screen.getByText(FAILED_WORDS, { exact: false })).toBeInTheDocument();
  });
});
