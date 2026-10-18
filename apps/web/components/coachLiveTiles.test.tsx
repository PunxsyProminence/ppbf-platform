/**
 * @jest-environment jsdom
 */

// The coach's top row (lane L39 PR 3; Jason 2026-10-17 "A: Coach screen only", OD-2026-10-17-008):
// attendance, need attention and the SHADOW queue as counts, from three reads the coach already
// makes. What these pin is the honesty: no mark is never an absence, and a read that fails is never
// a zero.

import '@testing-library/jest-dom';
import { act, render, screen, within } from '@testing-library/react';

import CoachLiveTiles, { attendanceCounts, attentionCounts, queueTotal } from './CoachLiveTiles';
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

let routes: Record<string, () => Response>;

beforeEach(() => {
  jest.useFakeTimers();
  routes = {
    '/api/pilot/coach/attendance-today': () => json(ATTENDANCE),
    '/api/pilot/escalations?status=open': () => json(ESCALATIONS),
    '/api/pilot/shadow/review-projection': () => json(QUEUE),
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

  test('need attention counts open escalations by their own severity, and pain reports apart, with no word', () => {
    expect(attentionCounts(ESCALATIONS)).toEqual({ critical: 1, high: 2, moderate: 1, low: 0, painReports: 1 });
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
    expect(attention.getByText('Pain reports').closest('li')).toHaveTextContent('1');
    expect(attention.getByText('Pain reports').closest('.badge')).toBeNull();
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

  test('reads the three routes coaches already read, and again every two minutes', async () => {
    render(<CoachLiveTiles />);
    await settle();
    const calls = () => (global.fetch as jest.Mock).mock.calls.map((call) => String(call[0]));
    expect(calls().sort()).toEqual([
      '/api/pilot/coach/attendance-today',
      '/api/pilot/escalations?status=open',
      '/api/pilot/shadow/review-projection',
    ]);
    await act(async () => {
      jest.advanceTimersByTime(60_000);
    });
    await settle();
    expect(calls()).toHaveLength(3);
    await act(async () => {
      jest.advanceTimersByTime(60_000);
    });
    await settle();
    expect(calls()).toHaveLength(6);
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
    for (const leak of ['a1', 'a2', 'a3', 'zz', 'Jordan', 'fall']) expect(text).not.toContain(leak);
  });
});
