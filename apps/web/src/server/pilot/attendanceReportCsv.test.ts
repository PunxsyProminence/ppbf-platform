import { attendanceByAthleteCsv, type AttendanceAthleteSummary } from './attendanceReporting';

// The attendance-by-athlete report's file (RP-01): one row per athlete, counts
// and dates only, the dashboard's rate left blank when there is nothing to
// count, times in gym time, and every cell safe to open in a spreadsheet.

function row(overrides: Partial<AttendanceAthleteSummary>): AttendanceAthleteSummary {
  return {
    athlete_id: 'ath-1',
    full_name: 'Ada Rivera',
    present_count: 0,
    absent_count: 0,
    excused_count: 0,
    total_marked: 0,
    last_marked_at: null,
    attendance_rate: null,
    ...overrides,
  };
}

function lines(csv: string): string[] {
  return csv.split('\r\n').filter(Boolean);
}

test('a period line, a header, and one row per athlete', () => {
  const csv = attendanceByAthleteCsv(
    [row({ present_count: 3, absent_count: 1, excused_count: 2, total_marked: 6, attendance_rate: 0.75 })],
    { fromDay: '2026-09-14', toDay: '2026-10-13' },
  );

  expect(lines(csv)).toEqual([
    '"Attendance by athlete, 2026-09-14 to 2026-10-13 (by class date, gym time)"',
    '"Athlete","Present","Absent","Excused","Marked","Attendance rate","Last marked (gym time)"',
    '"Ada Rivera","3","1","2","6","75%",""',
  ]);
});

test('no rate is blank, never 0; a real 0% is written as 0%', () => {
  const csv = attendanceByAthleteCsv(
    [
      row({ full_name: 'Never Marked' }),
      row({ full_name: 'Excused Only', excused_count: 2, total_marked: 2 }),
      row({ full_name: 'All Absent', absent_count: 3, total_marked: 3, attendance_rate: 0 }),
    ],
    { fromDay: '2026-10-01', toDay: '2026-10-13' },
  );

  const [, , never, excused, absent] = lines(csv);
  expect(never).toBe('"Never Marked","0","0","0","0","",""');
  expect(excused).toBe('"Excused Only","0","0","2","2","",""');
  expect(absent).toBe('"All Absent","0","3","0","3","0%",""');
});

test('the last mark is in gym time: an 11:30 pm Eastern mark is still that day', () => {
  // 2026-10-09 03:30 UTC is 11:30 pm on 2026-10-08 in the gym.
  const csv = attendanceByAthleteCsv(
    [row({ present_count: 1, total_marked: 1, attendance_rate: 1, last_marked_at: '2026-10-09T03:30:00Z' })],
    { fromDay: '2026-10-01', toDay: '2026-10-13' },
  );

  const last = lines(csv)[2]!;
  expect(last).toMatch(/October 8, 2026/);
  expect(last).toMatch(/11:30/);
});

test('quotes, commas and newlines stay inside their cell, and a would-be formula is defused', () => {
  const csv = attendanceByAthleteCsv(
    [
      row({ full_name: 'O"Brien, Sam' }),
      row({ full_name: 'Line\nBreak' }),
      row({ full_name: '=HYPERLINK("x")' }),
      row({ full_name: '+1 Plus' }),
      row({ full_name: '-Minus' }),
      row({ full_name: '@At' }),
    ],
    { fromDay: '2026-10-01', toDay: '2026-10-13' },
  );

  expect(csv).toContain('"O""Brien, Sam"');
  expect(csv).toContain('"Line\nBreak"');
  expect(csv).toContain(`"'=HYPERLINK(""x"")"`);
  expect(csv).toContain(`"'+1 Plus"`);
  expect(csv).toContain(`"'-Minus"`);
  expect(csv).toContain(`"'@At"`);
});
