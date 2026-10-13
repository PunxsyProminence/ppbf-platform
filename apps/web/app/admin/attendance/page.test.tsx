/**
 * @jest-environment jsdom
 */

import type { ReactNode } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';

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

    expect((screen.getByLabelText('From') as HTMLInputElement).value).toBe('2026-09-14');
    expect((screen.getByLabelText('To') as HTMLInputElement).value).toBe('2026-10-13');

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Download CSV' }));
    });

    const reportCalls = fetchMock.mock.calls.filter(([url]) => String(url).includes('format=csv'));
    expect(reportCalls).toHaveLength(1);
    expect(String(reportCalls[0]![0])).toContain('from=2026-09-14&to=2026-10-13&format=csv');
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(HTMLAnchorElement.prototype.click).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  test('a refused download says why and saves nothing', async () => {
    installReport({ ok: false, error: 'Forbidden: attendance reporting is available to coach and organization_admin/admin only' });
    render(<AttendanceDashboardPage />);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Download CSV' }));
    });

    expect(screen.getByRole('alert').textContent).toContain('Forbidden');
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  test('a period that ends before it starts is not sent', async () => {
    const fetchMock = installReport({ ok: true });
    render(<AttendanceDashboardPage />);
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-10-20' } });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Download CSV' }));
    });

    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('format=csv'))).toBe(false);
    expect(screen.getByRole('alert').textContent).toContain('Choose a From date on or before the To date.');
  });
});
