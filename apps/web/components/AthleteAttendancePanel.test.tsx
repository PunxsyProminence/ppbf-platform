/**
 * @jest-environment jsdom
 */

/*
 * The coach's attendance lines (OD-2026-10-17-026 (c)). Pinned: the rate always says its
 * denominator (marked days), no register is never 0%, a failed read is never "no register",
 * never marked present is said as that, and a reply for the previous athlete never lands.
 */

import { act, render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';

import { attendanceRateWords, daysSinceWords, isAttendanceWindow } from '@/src/lib/attendanceWords';

import AthleteAttendancePanel from './AthleteAttendancePanel';

const WINDOW = {
  athlete_id: 'ath-1', window_from: '2026-09-20', window_to: '2026-10-17', days_present: 3, days_absent: 1,
  days_excused: 2, attendance_rate: 0.75, last_present_day: '2026-10-05', days_since_last_present: 12,
};

function respond(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

const fetchMock = jest.fn();
beforeEach(() => {
  fetchMock.mockReset();
  global.fetch = fetchMock as unknown as typeof fetch;
});

test('the words say the denominator, and no register is not 0%', () => {
  expect(attendanceRateWords(WINDOW)).toBe('75% (present 3 of 4 marked days, 2 excused)');
  expect(attendanceRateWords({ ...WINDOW, days_present: 0, days_absent: 0, days_excused: 0, attendance_rate: null }))
    .toBe('No register in the last 28 days');
  expect(attendanceRateWords({ ...WINDOW, days_present: 0, days_absent: 0, days_excused: 2, attendance_rate: null }))
    .toBe('No present or absent marks in the last 28 days (2 excused)');
  expect(attendanceRateWords({ ...WINDOW, days_present: 0, days_absent: 3, days_excused: 0, attendance_rate: 0 }))
    .toBe('0% (present 0 of 3 marked days)');
  expect(attendanceRateWords({ ...WINDOW, days_present: 1, days_absent: 0, days_excused: 0, attendance_rate: 1 }))
    .toBe('100% (present 1 of 1 marked day)');
});

test('days since the last session, today, and never', () => {
  expect(daysSinceWords(WINDOW)).toBe('12 days since the last session (10/5/2026)');
  expect(daysSinceWords({ ...WINDOW, days_since_last_present: 1 })).toBe('1 day since the last session (10/5/2026)');
  expect(daysSinceWords({ ...WINDOW, days_since_last_present: 0, last_present_day: '2026-10-17' })).toBe('Trained today');
  expect(daysSinceWords({ ...WINDOW, days_since_last_present: null, last_present_day: null })).toBe('Never marked present');
});

test('the shape check refuses what the words cannot honestly show', () => {
  expect(isAttendanceWindow(WINDOW)).toBe(true);
  expect(isAttendanceWindow({ ...WINDOW, attendance_rate: 1.5 })).toBe(false);
  expect(isAttendanceWindow({ ...WINDOW, days_present: -1 })).toBe(false);
  expect(isAttendanceWindow({ ...WINDOW, days_present: '3' })).toBe(false);
  expect(isAttendanceWindow(null)).toBe(false);
});

test('shows both lines for the picked athlete', async () => {
  fetchMock.mockResolvedValueOnce(respond(200, { ok: true, attendance: WINDOW }));
  await act(async () => {
    render(<AthleteAttendancePanel athleteId="ath-1" />);
  });
  expect(fetchMock.mock.calls[0][0]).toContain('/api/pilot/coach/athlete-attendance?athlete_id=ath-1');
  expect(screen.getByText('Last 28 days: 75% (present 3 of 4 marked days, 2 excused)')).toBeTruthy();
  expect(screen.getByText('12 days since the last session (10/5/2026)')).toBeTruthy();
});

test('a failed read is never shown as "no register"', async () => {
  fetchMock.mockResolvedValueOnce(respond(500, {}));
  await act(async () => {
    render(<AthleteAttendancePanel athleteId="ath-1" />);
  });
  const text = screen.getByTestId('coach-athlete-attendance').textContent ?? '';
  expect(text).toMatch(/could not be read/);
  expect(text).not.toMatch(/No register in the last/);
});

test('a reply for the previous athlete never lands', async () => {
  let release: (response: Response) => void = () => {};
  fetchMock
    .mockImplementationOnce(() => new Promise<Response>((resolve) => { release = resolve; }))
    .mockResolvedValueOnce(respond(200, { ok: true, attendance: { ...WINDOW, athlete_id: 'ath-2', days_since_last_present: 0, last_present_day: '2026-10-17' } }));
  let rerender: (ui: ReactElement) => void = () => {};
  await act(async () => {
    ({ rerender } = render(<AthleteAttendancePanel athleteId="ath-1" />));
  });
  await act(async () => {
    rerender(<AthleteAttendancePanel athleteId="ath-2" />);
  });
  expect(screen.getByText('Trained today')).toBeTruthy();
  await act(async () => {
    release(respond(200, { ok: true, attendance: WINDOW }));
  });
  expect(screen.getByText('Trained today')).toBeTruthy();
  expect(screen.queryByText(/12 days since/)).toBeNull();
});
