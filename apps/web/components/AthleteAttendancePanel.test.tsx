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

import { attendanceRateWords, attendanceWindowWords, daysSinceWords, isAttendanceWindow } from '@/src/lib/attendanceWords';

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

test('the words say the source and the denominator, and no register is not 0%', () => {
  expect(attendanceRateWords(WINDOW)).toBe('75% (present 3 of 4 days marked on the class register, 2 excused)');
  expect(attendanceRateWords({ ...WINDOW, days_present: 0, days_absent: 0, days_excused: 0, attendance_rate: null }))
    .toBe('No class register in the last 28 days');
  expect(attendanceRateWords({ ...WINDOW, days_present: 0, days_absent: 0, days_excused: 2, attendance_rate: null }))
    .toBe('No present or absent marks on the class register in the last 28 days (2 excused)');
  expect(attendanceRateWords({ ...WINDOW, days_present: 0, days_absent: 3, days_excused: 0, attendance_rate: 0 }))
    .toBe('0% (present 0 of 3 days marked on the class register)');
  expect(attendanceRateWords({ ...WINDOW, days_present: 1, days_absent: 0, days_excused: 0, attendance_rate: 1 }))
    .toBe('100% (present 1 of 1 day marked on the class register)');
  expect(attendanceWindowWords(WINDOW)).toBe('9/20/2026 to 10/17/2026');
});

test('the whole percent is worked out from the counts, never rounded twice', () => {
  // 5/11 is 45.45%; rounding the stored 0.455 again would say 46%.
  expect(attendanceRateWords({ ...WINDOW, days_present: 5, days_absent: 6, days_excused: 0, attendance_rate: 0.455 }))
    .toMatch(/^45% /);
  // 13/23 is 56.52%; 0.565 * 100 is 56.4999... and would say 56%.
  expect(attendanceRateWords({ ...WINDOW, days_present: 13, days_absent: 10, days_excused: 0, attendance_rate: 0.565 }))
    .toMatch(/^57% /);
  for (let marked = 1; marked <= 28; marked += 1) {
    for (let present = 0; present <= marked; present += 1) {
      const rate = Math.round((present / marked) * 1000) / 1000;
      const words = attendanceRateWords({ ...WINDOW, days_present: present, days_absent: marked - present, days_excused: 0, attendance_rate: rate });
      expect(words.startsWith(`${Math.round((100 * present) / marked)}% `)).toBe(true);
    }
  }
});

test('the last day marked present, today, and not at all -- said as the register says it', () => {
  expect(daysSinceWords(WINDOW)).toBe('Last marked present on the class register 12 days ago (10/5/2026)');
  expect(daysSinceWords({ ...WINDOW, days_since_last_present: 1 })).toBe('Last marked present on the class register 1 day ago (10/5/2026)');
  expect(daysSinceWords({ ...WINDOW, days_since_last_present: 0, last_present_day: '2026-10-17' })).toBe('Marked present on the class register today');
  expect(daysSinceWords({ ...WINDOW, days_since_last_present: null, last_present_day: null })).toBe('Not marked present on the class register');
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
  expect(screen.getByText('Last 28 days: 75% (present 3 of 4 days marked on the class register, 2 excused)')).toBeTruthy();
  expect(screen.getByText('9/20/2026 to 10/17/2026')).toBeTruthy();
  expect(screen.getByText('Last marked present on the class register 12 days ago (10/5/2026)')).toBeTruthy();
});

test('a failed read is never shown as "no register"', async () => {
  fetchMock.mockResolvedValueOnce(respond(500, {}));
  await act(async () => {
    render(<AthleteAttendancePanel athleteId="ath-1" />);
  });
  const text = screen.getByTestId('coach-athlete-attendance').textContent ?? '';
  expect(text).toMatch(/could not be read/);
  expect(text).not.toMatch(/No class register in the last/);
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
  expect(screen.getByText('Marked present on the class register today')).toBeTruthy();
  await act(async () => {
    release(respond(200, { ok: true, attendance: WINDOW }));
  });
  expect(screen.getByText('Marked present on the class register today')).toBeTruthy();
  expect(screen.queryByText(/12 days ago/)).toBeNull();
});
