/**
 * @jest-environment jsdom
 */

import type { ReactNode } from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';

import AttendanceDashboardPage from './page';

jest.mock('@/components/RoleSessionGate', () => ({
  __esModule: true,
  default: ({ children }: { readonly children: ReactNode }) => children,
}));

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ children, href }: { readonly children: ReactNode; readonly href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

function jsonResponse(body: unknown, ok = true) {
  return { ok, json: async () => body } as Response;
}

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  jest.clearAllMocks();
});

function installFetch(trendBody: unknown) {
  global.fetch = jest.fn(async (url: string) => {
    if (String(url).includes('trend=1')) {
      return jsonResponse(trendBody);
    }
    return jsonResponse({ ok: true, athletes: [] });
  }) as unknown as typeof fetch;
}

test('a real weekly trend renders the trend strip with a week label', async () => {
  installFetch({
    ok: true,
    trend: [
      { week_start: '2026-07-27', present_count: 5, absent_count: 1, excused_count: 0, total_marked: 6, attendance_rate: 0.833 },
    ],
  });

  render(<AttendanceDashboardPage />);

  await screen.findByText('Weekly trend (last 8 weeks)');
  expect(screen.getByRole('img', { name: /Week of Jul 27: 83%/ })).toBeDefined();
});

// Round 9 review: getWeeklyAttendanceTrend omits a week with zero marks
// rather than zero-filling it, and its own doc comment says "the page fills
// gaps on render" -- this pins that the page actually does, instead of
// silently rendering the surviving weeks back-to-back as if nothing were
// skipped.
test('an omitted week between two real weeks renders as a distinct gap, not a silent skip', async () => {
  installFetch({
    ok: true,
    trend: [
      { week_start: '2026-07-13', present_count: 4, absent_count: 0, excused_count: 0, total_marked: 4, attendance_rate: 1 },
      // 2026-07-20 is missing -- a closed-gym week with zero marks.
      { week_start: '2026-07-27', present_count: 5, absent_count: 1, excused_count: 0, total_marked: 6, attendance_rate: 0.833 },
    ],
  });

  render(<AttendanceDashboardPage />);

  await screen.findByText('Weekly trend (last 8 weeks)');
  expect(screen.getByRole('img', { name: /Week of Jul 13: 100%/ })).toBeDefined();
  expect(screen.getByRole('img', { name: /Week of Jul 27: 83%/ })).toBeDefined();
  expect(screen.getByRole('img', { name: /Week of Jul 20: no attendance data/ })).toBeDefined();
});

test('an empty trend renders no trend strip, not an empty one', async () => {
  installFetch({ ok: true, trend: [] });

  render(<AttendanceDashboardPage />);

  await screen.findByText('No active athletes in scope yet');
  expect(screen.queryByText(/Weekly trend/)).toBeNull();
});

test('a failed trend fetch does not break the rest of the dashboard', async () => {
  global.fetch = jest.fn(async (url: string) => {
    if (String(url).includes('trend=1')) {
      return jsonResponse({ error: 'nope' }, false);
    }
    return jsonResponse({ ok: true, athletes: [{ athlete_id: 'ath-1', full_name: 'Jordan T.', present_count: 1, absent_count: 0, excused_count: 0, total_marked: 1, last_marked_at: '2026-08-01T00:00:00.000Z', attendance_rate: 1 }] });
  }) as unknown as typeof fetch;

  render(<AttendanceDashboardPage />);

  await screen.findByText('Jordan T.');
  expect(screen.queryByText(/Weekly trend/)).toBeNull();
});

// The #991 class: a read that failed must never be counted as zero athletes.
function tileValue(label: string): string {
  const eyebrow = screen.getByText(label);
  const value = eyebrow.nextElementSibling;
  if (!value) throw new Error(`tile "${label}" has no value`);
  return value.textContent ?? '';
}

describe.each([
  ['refused', () => jsonResponse({ error: 'Unable to load attendance summary.' }, false)],
  ['rejected', () => { throw new Error('network down'); }],
])('a %s attendance summary read', (_label, summaryAnswer) => {
  test('leaves the counts unstated instead of showing 0 tracked and 0 never checked in', async () => {
    global.fetch = jest.fn(async (url: string) => {
      if (String(url).includes('trend=1')) return jsonResponse({ trend: [] });
      return summaryAnswer();
    }) as unknown as typeof fetch;

    render(<AttendanceDashboardPage />);

    await screen.findByText(/attendance could not be loaded/i);
    expect(tileValue('Athletes tracked')).toBe('—');
    expect(tileValue('Never checked in')).toBe('—');
  });
});

/*
 * THE ATTENDANCE-BY-ATHLETE REPORT (RP-01): From and To default to the last 30
 * gym days, the download asks the server for that period's CSV, and a refused
 * or failed download says so. The clock is fixed at noon in the gym so the
 * default period does not depend on the hour the suite runs.
 */
describe('the attendance report download (RP-01)', () => {
  // Scoped to its own section: the class report beside it (RP-02) has the same controls.
  const athleteReport = () => within(screen.getByRole('region', { name: 'Attendance report' }));

  const GYM_NOON = Date.parse('2026-10-13T16:00:00.000Z');
  const createObjectURL = jest.fn(() => 'blob:report');
  const revokeObjectURL = jest.fn();

  beforeEach(() => {
    jest.spyOn(Date, 'now').mockReturnValue(GYM_NOON);
    Object.assign(URL, { createObjectURL, revokeObjectURL });
    jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  function installReport(csv: { ok: boolean; error?: string }) {
    const fetchMock = jest.fn(async (url: string) => {
      if (String(url).includes('format=csv')) {
        return csv.ok
          ? ({ ok: true, blob: async () => new Blob(['a,b']) } as unknown as Response)
          : ({ ok: false, json: async () => ({ error: csv.error }) } as unknown as Response);
      }
      if (String(url).includes('trend=1')) return jsonResponse({ ok: true, trend: [] });
      return jsonResponse({ ok: true, athletes: [] });
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    return fetchMock;
  }

  test('defaults to the last 30 gym days and downloads that period as CSV', async () => {
    const fetchMock = installReport({ ok: true });
    render(<AttendanceDashboardPage />);

    expect((athleteReport().getByLabelText('From') as HTMLInputElement).value).toBe('2026-09-14');
    expect((athleteReport().getByLabelText('To') as HTMLInputElement).value).toBe('2026-10-13');

    await act(async () => {
      fireEvent.click(athleteReport().getByRole('button', { name: 'Download CSV' }));
    });

    const reportCalls = fetchMock.mock.calls.filter(([url]) => String(url).includes('format=csv'));
    expect(reportCalls).toHaveLength(1);
    expect(String(reportCalls[0]![0])).toContain('from=2026-09-14&to=2026-10-13&format=csv');
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(HTMLAnchorElement.prototype.click).toHaveBeenCalledTimes(1);
    expect(athleteReport().queryByRole('alert')).toBeNull();
  });

  test('a refused download says why and saves nothing', async () => {
    installReport({ ok: false, error: 'Forbidden: attendance reporting is available to coach and organization_admin/admin only' });
    render(<AttendanceDashboardPage />);

    await act(async () => {
      fireEvent.click(athleteReport().getByRole('button', { name: 'Download CSV' }));
    });

    expect(athleteReport().getByRole('alert').textContent).toContain('Forbidden');
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  test('a period that ends before it starts is not sent', async () => {
    const fetchMock = installReport({ ok: true });
    render(<AttendanceDashboardPage />);
    fireEvent.change(athleteReport().getByLabelText('From'), { target: { value: '2026-10-20' } });

    await act(async () => {
      fireEvent.click(athleteReport().getByRole('button', { name: 'Download CSV' }));
    });

    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('format=csv'))).toBe(false);
    expect(athleteReport().getByRole('alert').textContent).toContain('Choose a From date on or before the To date.');
  });
});

/*
 * THE REPORT BY CLASS (RP-02): the last 30 gym days by default; Show reads
 * the classes for the period and lists them with a total over the classes
 * held; Download CSV saves the same report; a refused report says why; a
 * period changed while one is loading drops its answer.
 */
describe('the attendance report by class (RP-02)', () => {
  const classReport = () => within(screen.getByRole('region', { name: 'Class attendance report' }));
  const GYM_NOON = Date.parse('2026-10-13T16:00:00.000Z');
  const createObjectURL = jest.fn(() => 'blob:class-report');

  const BODY = {
    ok: true,
    classes: [
      {
        class_id: 'c-1', title: 'Sparring', start_at: '2026-10-08T22:00:00.000Z', status: 'open',
        registered_count: 3, present_count: 1, absent_count: 1, excused_count: 0, unmarked_count: 1, attendance_rate: 0.5,
      },
      {
        class_id: 'c-2', title: 'Open Gym', start_at: '2026-10-09T22:00:00.000Z', status: 'cancelled',
        registered_count: 1, present_count: 0, absent_count: 1, excused_count: 0, unmarked_count: 0, attendance_rate: null,
      },
    ],
    totals: {
      classes: 1, cancelled: 1, registered_count: 3, present_count: 1, absent_count: 1, excused_count: 0, unmarked_count: 1, attendance_rate: 0.5,
    },
  };

  beforeEach(() => {
    jest.spyOn(Date, 'now').mockReturnValue(GYM_NOON);
    createObjectURL.mockClear();
    Object.assign(URL, { createObjectURL, revokeObjectURL: jest.fn() });
    jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  function installClassReport(answer: (url: string) => Promise<Response>) {
    const fetchMock = jest.fn(async (url: string) => {
      if (String(url).includes('report=classes')) return answer(String(url));
      if (String(url).includes('trend=1')) return jsonResponse({ ok: true, trend: [] });
      return jsonResponse({ ok: true, athletes: [] });
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    return fetchMock;
  }

  const reportCalls = (fetchMock: jest.Mock) => fetchMock.mock.calls.map(([url]) => String(url)).filter((url) => url.includes('report=classes'));

  test('Show lists each class for the default 30 gym days, with a total over the classes held', async () => {
    const fetchMock = installClassReport(async () => jsonResponse(BODY));
    await act(async () => {
      render(<AttendanceDashboardPage />);
    });

    expect((classReport().getByLabelText('From') as HTMLInputElement).value).toBe('2026-09-14');
    await act(async () => {
      fireEvent.click(classReport().getByRole('button', { name: 'Show' }));
    });

    expect(reportCalls(fetchMock)).toEqual([
      expect.stringContaining('/api/pilot/scheduler/attendance-summary?report=classes&from=2026-09-14&to=2026-10-13'),
    ]);
    const table = classReport().getByRole('table');
    const sparring = within(table).getByText('Sparring').closest('tr')!;
    // 22:00 UTC on Oct 8 is 6:00 pm in the gym.
    expect(sparring.textContent).toMatch(/6:00\sPM/);
    expect(Array.from(sparring.querySelectorAll('td')).map((cell) => cell.textContent).slice(1)).toEqual(['3', '1', '1', '0', '1', '50%']);
    const cancelled = within(table).getByText('Open Gym').closest('tr')!;
    expect(cancelled.textContent).toContain('(cancelled)');
    expect(cancelled.querySelectorAll('td')[6]!.textContent).toBe('—');
    expect(table.querySelector('tfoot')!.textContent).toContain('Total, 1 not cancelled (1 cancelled, not included)');
  });

  test('Download CSV asks for the same report as a file', async () => {
    const fetchMock = installClassReport(async () => ({ ok: true, blob: async () => new Blob(['x']) } as unknown as Response));
    await act(async () => {
      render(<AttendanceDashboardPage />);
    });

    await act(async () => {
      fireEvent.click(classReport().getByRole('button', { name: 'Download CSV' }));
    });

    expect(reportCalls(fetchMock)).toEqual([
      expect.stringContaining('report=classes&from=2026-09-14&to=2026-10-13&format=csv'),
    ]);
    expect(createObjectURL).toHaveBeenCalledTimes(1);
  });

  test('a refused report says why and shows no table', async () => {
    installClassReport(async () => ({ ok: false, json: async () => ({ error: 'Forbidden: attendance reporting is available to coach and organization_admin/admin only' }) } as unknown as Response));
    await act(async () => {
      render(<AttendanceDashboardPage />);
    });

    await act(async () => {
      fireEvent.click(classReport().getByRole('button', { name: 'Show' }));
    });

    expect(classReport().getByRole('alert').textContent).toContain('Forbidden');
    expect(classReport().queryByRole('table')).toBeNull();
  });

  test('a reversed period is not sent', async () => {
    const fetchMock = installClassReport(async () => jsonResponse(BODY));
    await act(async () => {
      render(<AttendanceDashboardPage />);
    });

    fireEvent.change(classReport().getByLabelText('From'), { target: { value: '2026-10-20' } });
    await act(async () => {
      fireEvent.click(classReport().getByRole('button', { name: 'Show' }));
    });

    expect(reportCalls(fetchMock)).toHaveLength(0);
    expect(classReport().getByRole('alert').textContent).toContain('Choose a From date on or before the To date.');
  });

  test('a period changed while a report is loading drops its answer', async () => {
    let finish: ((value: Response) => void) | null = null;
    installClassReport(() => new Promise<Response>((resolve) => { finish = resolve; }));
    await act(async () => {
      render(<AttendanceDashboardPage />);
    });

    act(() => {
      fireEvent.click(classReport().getByRole('button', { name: 'Show' }));
    });
    fireEvent.change(classReport().getByLabelText('From'), { target: { value: '2026-10-01' } });
    await act(async () => {
      finish?.(jsonResponse(BODY));
    });

    expect(classReport().queryByRole('table')).toBeNull();
  });
});
