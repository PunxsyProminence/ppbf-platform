/**
 * @jest-environment jsdom
 */

// The coach's top row (lane L39 PR 3; Jason 2026-10-17 "A: Coach screen only", OD-2026-10-17-008):
// attendance, need attention and the SHADOW queue as counts, from three reads the coach already
// makes. What these pin is the honesty: no mark is never an absence, and a read that fails is never
// a zero. Lane U2-6b: the pain tile reads the pain list's own feed over the feed's own window
// (Overwatch's 6b ruling, Q2 = A, Q3 = A), says "?" and "not checked" when it cannot, and is never
// drawn as a medical stop.

import '@testing-library/jest-dom';
import { act, render, screen, within } from '@testing-library/react';

import CoachLiveTiles, {
  attendanceCounts,
  attentionCounts,
  painReportCount,
  painTileWords,
  queueTotal,
} from './CoachLiveTiles';
import { PAIN_REPORT_TRIGGER } from '@/src/shared/painScoreLabel';

jest.mock('@/lib/apiBase', () => ({ apiBase: () => '' }));

function json(body: unknown, status = 200) {
  return { ok: status < 400, status, json: async () => body } as Response;
}

const ATTENDANCE = {
  ok: true,
  day: '2026-10-17',
  covered: ['a1', 'a2', 'a3', 'a4', 'a5', 'a6'],
  marks: [
    { athlete_id: 'a1', status: 'present', source: 'activity_log' },
    { athlete_id: 'a2', status: 'present', source: 'scheduler' },
    { athlete_id: 'a3', status: 'absent', source: 'scheduler' },
    { athlete_id: 'a4', status: 'excused', source: 'scheduler' },
    // A mark for an athlete the read did not cover is not counted.
    { athlete_id: 'zz', status: 'present', source: 'scheduler' },
  ],
};
const ESCALATIONS = {
  ok: true,
  escalations: [
    { severity: 'critical' },
    { severity: 'high' },
    { severity: 'high' },
    { severity: 'moderate' },
    { severity: 'odd' },
    // A 7/10 pain report is stored as critical; the board shows it as a number, never a word.
    { severity: 'critical', metadata: { trigger: PAIN_REPORT_TRIGGER } },
  ],
};
const QUEUE = { ok: true, queue: [], total: 7 };
const PAIN_FEED = '/api/pilot/coach/pain-reports?limit=50';
function painRow(id: string) {
  return { nearMissId: id, athleteId: `ath-${id}`, athleteName: 'Jordan Fixture', painScore: 6, bodyArea: 'left wrist' };
}
const PAIN = { ok: true, windowDays: 7, truncated: false, painReports: [painRow('n1'), painRow('n2'), painRow('n3')] };

let routes: Record<string, () => Response>;

beforeEach(() => {
  jest.useFakeTimers();
  routes = {
    '/api/pilot/coach/attendance-today': () => json(ATTENDANCE),
    '/api/pilot/escalations?status=open': () => json(ESCALATIONS),
    '/api/pilot/shadow/review-projection': () => json(QUEUE),
    [PAIN_FEED]: () => json(PAIN),
  };
  global.fetch = jest.fn(async (input: RequestInfo | URL) => {
    const handler = routes[String(input)];
    if (!handler) throw new Error(`unexpected ${String(input)}`);
    return handler();
  }) as unknown as typeof fetch;
});

afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
});

async function settle() {
  await act(async () => {
    for (let i = 0; i < 4; i += 1) await Promise.resolve();
  });
}

function group(name: string) {
  return within(screen.getByRole('region', { name }));
}

describe('the counts', () => {
  test('attendance counts marks over the covered athletes; no mark is "not marked", never absent', () => {
    expect(attendanceCounts(ATTENDANCE)).toEqual({ present: 2, absent: 1, excused: 1, notMarked: 2 });
  });

  test('before the register is taken, every covered athlete is not marked and nobody is absent', () => {
    expect(attendanceCounts({ ok: true, covered: ['a1', 'a2'], marks: [] })).toEqual({
      present: 0,
      absent: 0,
      excused: 0,
      notMarked: 2,
    });
  });

  test('need attention counts open escalations by their own severity, and skips pain reports', () => {
    // The 7/10 pain report stored as critical is not a "Critical": it is the pain tile's, from its own feed.
    expect(attentionCounts(ESCALATIONS)).toEqual({ critical: 1, high: 2, moderate: 1, low: 0 });
  });

  test('the pain tile counts exactly the feed\'s rows, over the feed\'s own window', () => {
    expect(painReportCount(PAIN)).toEqual({ count: 3, truncated: false, windowDays: 7 });
    expect(painReportCount({ ...PAIN, windowDays: 14, painReports: [] })).toEqual({ count: 0, truncated: false, windowDays: 14 });
  });

  test('a pain payload whose window or completeness cannot be stated is unread, not a count', () => {
    expect(painReportCount(null)).toBeNull();
    expect(painReportCount({ ...PAIN, ok: false })).toBeNull();
    expect(painReportCount({ ...PAIN, painReports: undefined })).toBeNull();
    expect(painReportCount({ ...PAIN, truncated: undefined })).toBeNull();
    expect(painReportCount({ ...PAIN, truncated: 'no' })).toBeNull();
    expect(painReportCount({ ...PAIN, windowDays: undefined })).toBeNull();
    expect(painReportCount({ ...PAIN, windowDays: '7' })).toBeNull();
    expect(painReportCount({ ...PAIN, windowDays: 0 })).toBeNull();
    expect(painReportCount({ ...PAIN, windowDays: -7 })).toBeNull();
    expect(painReportCount({ ...PAIN, windowDays: 7.5 })).toBeNull();
  });

  test('the pain tile\'s words: the count and the named window; "50+" when the feed has more; "?" and "not checked" when unread', () => {
    expect(painTileWords({ state: 'ok', value: { count: 3, truncated: false, windowDays: 7 } })).toEqual({
      value: '3',
      label: 'Pain reports, last 7 days',
    });
    expect(painTileWords({ state: 'ok', value: { count: 0, truncated: false, windowDays: 14 } })).toEqual({
      value: '0',
      label: 'Pain reports, last 14 days',
    });
    expect(painTileWords({ state: 'ok', value: { count: 50, truncated: true, windowDays: 7 } })).toEqual({
      value: '50+',
      label: 'Pain reports, last 7 days',
    });
    expect(painTileWords({ state: 'failed' })).toEqual({ value: '?', label: 'Pain reports: not checked' });
  });

  test('a payload that is not what the route sends counts as unread, not as zero', () => {
    expect(attendanceCounts({ ok: true, marks: [] })).toBeNull();
    expect(attendanceCounts(null)).toBeNull();
    expect(attentionCounts({ ok: false })).toBeNull();
    expect(queueTotal({ ok: true })).toBeNull();
    expect(queueTotal({ ok: true, total: -1 })).toBeNull();
    expect(queueTotal(QUEUE)).toBe(7);
  });
});

describe('the tiles', () => {
  test('show each count with its word, and the severities with glyph and word', async () => {
    render(<CoachLiveTiles />);
    await settle();
    const attendance = group('Attendance today');
    expect(attendance.getByText('Present').previousSibling).toHaveTextContent(/^2$/);
    expect(attendance.getByText('Not marked').previousSibling).toHaveTextContent(/^2$/);
    const attention = group('Need attention · your athletes');
    expect(attention.getByText('Critical').closest('li')).toHaveTextContent('1');
    expect(attention.getByText('High').closest('li')).toHaveTextContent('2');
    expect(attention.getByText('High').closest('.badge')?.textContent).toBe('▲High');
    expect(attention.getByText('Moderate').closest('.badge')?.textContent).toBe('◉Moderate');
    // The pain tile is not under "your athletes": its feed is every athlete the coach may see.
    expect(attention.queryByText(/Pain reports/)).toBeNull();
    const pain = group('Athlete pain reports');
    expect(pain.getByText('Pain reports, last 7 days').previousSibling).toHaveTextContent(/^3$/);
    expect(pain.getByText('Pain reports, last 7 days').closest('.badge')).toBeNull();
    expect(group('SHADOW queue').getByText('In the queue').previousSibling).toHaveTextContent(/^7$/);
  });

  test('a read that fails says "Could not read" and shows no number at all', async () => {
    routes['/api/pilot/escalations?status=open'] = () => json({ error: 'boom' }, 500);
    routes['/api/pilot/shadow/review-projection'] = () => {
      throw new Error('network');
    };
    render(<CoachLiveTiles />);
    await settle();
    expect(group('Need attention · your athletes').getByText('Could not read')).toBeInTheDocument();
    expect(group('Need attention · your athletes').queryByRole('listitem')).toBeNull();
    expect(group('SHADOW queue').getByText('Could not read')).toBeInTheDocument();
    expect(group('SHADOW queue').queryByText('0')).toBeNull();
    // The read that worked still shows.
    expect(group('Attendance today').getByText('Present')).toBeInTheDocument();
  });

  test('reads the four routes coaches already read, and again every two minutes', async () => {
    render(<CoachLiveTiles />);
    await settle();
    const calls = () => (global.fetch as jest.Mock).mock.calls.map((call) => String(call[0]));
    expect(calls().sort()).toEqual([
      '/api/pilot/coach/attendance-today',
      PAIN_FEED,
      '/api/pilot/escalations?status=open',
      '/api/pilot/shadow/review-projection',
    ]);
    await act(async () => {
      jest.advanceTimersByTime(60_000);
    });
    await settle();
    expect(calls()).toHaveLength(4);
    await act(async () => {
      jest.advanceTimersByTime(60_000);
    });
    await settle();
    expect(calls()).toHaveLength(8);
  });

  test('carries no names: whatever else the reads carry, only counts reach the tiles', async () => {
    routes['/api/pilot/coach/attendance-today'] = () =>
      json({ ...ATTENDANCE, marks: ATTENDANCE.marks.map((mark) => ({ ...mark, full_name: 'Jordan Fixture' })) });
    routes['/api/pilot/escalations?status=open'] = () =>
      json({ ok: true, escalations: [{ severity: 'high', athlete_id: 'a1', reason: 'Jordan Fixture reported a fall' }] });
    render(<CoachLiveTiles />);
    await settle();
    const text = screen.getByRole('group', { name: 'The gym at a glance' }).textContent ?? '';
    expect(text).toContain('Present');
    expect(text).toContain('Pain reports, last 7 days');
    for (const leak of ['a1', 'a2', 'a3', 'zz', 'Jordan', 'fall', 'ath-', 'n1', 'wrist']) expect(text).not.toContain(leak);
  });
});

describe('the pain tile (lane U2-6b)', () => {
  // The tile and the coach home's pain list read one feed over one stated window (Overwatch's 6b
  // ruling). An older open pain escalation still shows on the escalations page; the tile no longer
  // counts it (Q3 = A).
  test('counts the feed\'s rows, not the open pain escalations', async () => {
    routes['/api/pilot/escalations?status=open'] = () =>
      json({
        ok: true,
        escalations: [
          { severity: 'critical', metadata: { trigger: PAIN_REPORT_TRIGGER } },
          { severity: 'high', metadata: { trigger: PAIN_REPORT_TRIGGER } },
          { severity: 'moderate', metadata: { trigger: PAIN_REPORT_TRIGGER } },
          { severity: 'low', metadata: { trigger: PAIN_REPORT_TRIGGER } },
        ],
      });
    routes[PAIN_FEED] = () => json({ ...PAIN, painReports: [painRow('n1')] });
    render(<CoachLiveTiles />);
    await settle();
    expect(group('Athlete pain reports').getByText('Pain reports, last 7 days').previousSibling).toHaveTextContent(/^1$/);
    // None of the four pain escalations is counted under a severity either.
    const attention = group('Need attention · your athletes');
    for (const word of ['Critical', 'High', 'Moderate', 'Low']) {
      expect(attention.getByText(word).closest('li')?.querySelector('.ge-tile__value')).toHaveTextContent(/^0$/);
    }
  });

  test('names the window the feed states', async () => {
    routes[PAIN_FEED] = () => json({ ...PAIN, windowDays: 14 });
    render(<CoachLiveTiles />);
    await settle();
    expect(group('Athlete pain reports').getByText('Pain reports, last 14 days').previousSibling).toHaveTextContent(/^3$/);
  });

  test('shows "50+" when the feed matched more than it returned', async () => {
    routes[PAIN_FEED] = () =>
      json({ ...PAIN, truncated: true, painReports: Array.from({ length: 50 }, (_, i) => painRow(`n${i}`)) });
    render(<CoachLiveTiles />);
    await settle();
    expect(group('Athlete pain reports').getByText('Pain reports, last 7 days').previousSibling).toHaveTextContent(/^50\+$/);
  });

  test('an empty feed is a checked zero, with its window named', async () => {
    routes[PAIN_FEED] = () => json({ ...PAIN, painReports: [] });
    render(<CoachLiveTiles />);
    await settle();
    expect(group('Athlete pain reports').getByText('Pain reports, last 7 days').previousSibling).toHaveTextContent(/^0$/);
  });

  test.each([
    ['a server error', () => json({ error: 'boom' }, 500)],
    ['a refusal', () => json({ ok: false, error: 'Forbidden' }, 403)],
    ['a signed-out read', () => json({ ok: false, error: 'Unauthorized' }, 401)],
    ['a network failure', () => {
      throw new Error('network');
    }],
    ['a payload with no window', () => json({ ok: true, truncated: false, painReports: [] })],
  ])('%s says "?" and "Pain reports: not checked", never 0 and never "Could not read"', async (_label, handler) => {
    routes[PAIN_FEED] = handler;
    render(<CoachLiveTiles />);
    await settle();
    const pain = group('Athlete pain reports');
    expect(pain.getByText('Pain reports: not checked').previousSibling).toHaveTextContent(/^\?$/);
    expect(pain.queryByText('0')).toBeNull();
    expect(pain.queryByText(/last \d+ days/)).toBeNull();
    expect(pain.queryByText('Could not read')).toBeNull();
    // The other reads still show.
    expect(group('Need attention · your athletes').getByText('Critical')).toBeInTheDocument();
  });

  test('a later failed read replaces the count with "?": an old number is never left standing', async () => {
    render(<CoachLiveTiles />);
    await settle();
    expect(group('Athlete pain reports').getByText('Pain reports, last 7 days').previousSibling).toHaveTextContent(/^3$/);
    routes[PAIN_FEED] = () => json({ error: 'boom' }, 500);
    await act(async () => {
      jest.advanceTimersByTime(120_000);
    });
    await settle();
    const pain = group('Athlete pain reports');
    expect(pain.getByText('Pain reports: not checked').previousSibling).toHaveTextContent(/^\?$/);
    expect(pain.queryByText('3')).toBeNull();
  });

  test.each([
    ['counted', () => json(PAIN)],
    ['not checked', () => json({ error: 'boom' }, 500)],
  ])('is never drawn as a medical stop or in the restricted red (%s)', async (_label, handler) => {
    routes[PAIN_FEED] = handler;
    render(<CoachLiveTiles />);
    await settle();
    const section = screen.getByRole('region', { name: 'Athlete pain reports' });
    expect(section.querySelector('.badge')).toBeNull();
    expect(section.innerHTML).not.toMatch(/locked|restricted/);
  });
});
