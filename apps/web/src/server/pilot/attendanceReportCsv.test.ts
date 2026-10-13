import {
  attendanceByAthleteCsv,
  attendanceByClassCsv,
  type AttendanceAthleteSummary,
  type ClassAttendanceReportRow,
} from './attendanceReporting';

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
  return csv.replace(/^\uFEFF/, '').split('\r\n').filter(Boolean);
}

test('the file starts with a UTF-8 byte order mark, so Excel reads accented names as written', () => {
  const csv = attendanceByAthleteCsv([row({ full_name: 'José Núñez' })], { fromDay: '2026-10-01', toDay: '2026-10-13' });
  expect(csv.charCodeAt(0)).toBe(0xfeff);
  expect(csv).toContain('"José Núñez"');
});

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
      row({ full_name: '\t=Tabbed' }),
      row({ full_name: '\r=Returned' }),
    ],
    { fromDay: '2026-10-01', toDay: '2026-10-13' },
  );

  expect(csv).toContain('"O""Brien, Sam"');
  expect(csv).toContain('"Line\nBreak"');
  expect(csv).toContain(`"'=HYPERLINK(""x"")"`);
  expect(csv).toContain(`"'+1 Plus"`);
  expect(csv).toContain(`"'-Minus"`);
  expect(csv).toContain(`"'@At"`);
  expect(csv).toContain(`"'\t=Tabbed"`);
  expect(csv).toContain(`"'\r=Returned"`);
});

/*
 * THE REPORT BY CLASS AS CSV (RP-02): one row per class, counts only, the
 * rate blank when there is nothing to count or the class was cancelled, then
 * a total line over the classes held.
 */
describe('attendanceByClassCsv (RP-02)', () => {
  function cls(overrides: Partial<ClassAttendanceReportRow>): ClassAttendanceReportRow {
    return {
      class_id: 'c-1',
      title: 'Fundamentals',
      start_at: '2026-10-08T22:00:00.000Z',
      status: 'open',
      registered_count: 0,
      present_count: 0,
      absent_count: 0,
      excused_count: 0,
      unmarked_count: 0,
      attendance_rate: null,
      ...overrides,
    };
  }
  const PERIOD = { fromDay: '2026-10-01', toDay: '2026-10-13' };

  test('the period, the header, a row per class in gym time, and a total over the classes held', () => {
    const csv = attendanceByClassCsv([
      cls({ title: 'Sparring', registered_count: 3, present_count: 1, absent_count: 1, unmarked_count: 1, attendance_rate: 0.5 }),
      cls({ class_id: 'c-2', title: 'Open Gym', status: 'cancelled', start_at: '2026-10-10T03:30:00.000Z', registered_count: 1, absent_count: 1 }),
      cls({ class_id: 'c-3', title: 'Footwork', registered_count: 2, excused_count: 2 }),
    ], PERIOD);

    expect(csv.charCodeAt(0)).toBe(0xfeff);
    const out = lines(csv);
    expect(out[0]).toBe('"Attendance by class, 2026-10-01 to 2026-10-13 (by class date, gym time)"');
    expect(out[1]).toBe('"Class","Date and time (gym time)","Status","Registered","Present","Absent","Excused","Unmarked","Attendance rate"');
    // 22:00 UTC on Oct 8 is 6:00 pm in the gym.
    expect(out[2]).toMatch(/^"Sparring","[^"]*Oct[^"]*8[^"]*6:00\sPM","open","3","1","1","0","1","50%"$/);
    // 03:30 UTC on Oct 10 is 11:30 pm on Oct 9 in the gym; a cancelled class has no rate.
    expect(out[3]).toMatch(/^"Open Gym","[^"]*Oct[^"]*9[^"]*11:30\sPM","cancelled","1","0","1","0","0",""$/);
    // Excused only: no rate, never 0%.
    expect(out[4]).toMatch(/"Footwork",.*"2","0","0","2","0",""$/);
    expect(out[5]).toBe('"Total, 2 classes held (1 cancelled, not included)","","","5","1","1","2","1","50%"');
    expect(out).toHaveLength(6);
  });

  test('no names, and a title that would run as a formula is defused', () => {
    const csv = attendanceByClassCsv([cls({ title: '=HYPERLINK("x")' })], PERIOD);
    expect(csv).toContain(`"'=HYPERLINK(""x"")"`);
  });

  test('an empty period still has its header and a zero total with no rate', () => {
    const out = lines(attendanceByClassCsv([], PERIOD));
    expect(out).toHaveLength(3);
    expect(out[2]).toBe('"Total, 0 classes held","","","0","0","0","0","0",""');
  });
});
