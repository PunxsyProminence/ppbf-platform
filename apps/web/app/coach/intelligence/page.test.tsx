/**
 * @jest-environment jsdom
 */

// The Morning Read (register module 111). What these pin: items render under
// their threshold-stating headings with links to the surfaces that own the
// action; the empty state never claims the floor is fine; a failed read
// admits items may exist; and the page carries the no-scores/no-predictions
// framing the owner's approval was conditioned on.

import { act, render, screen } from '@testing-library/react';

import CoachIntelligencePage from './page';

jest.mock('@/components/RoleSessionGate', () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

const DIGEST = {
  stalled_gaps: [{ athlete_id: 'ath-1', athlete_name: 'Jordan P.', gap_type: 'endurance', gap_description: 'Fades in round 3', days_open: 21 }],
  readiness_concerns: [{ athlete_id: 'ath-2', athlete_name: 'Sam R.', red_days: 4 }],
  fading_attendance: [{ athlete_id: 'ath-3', athlete_name: 'Rosa D.', training_days_early: 6, training_days_late: 2 }],
  unreviewed_sessions: [{ athlete_id: 'ath-1', athlete_name: 'Jordan P.', session_id: 's-1', session_date: '2026-08-01', days_waiting: 15 }],
  expiring_holds: [{ athlete_id: 'ath-4', athlete_name: 'Kim L.', hold_id: 'h-1', expires_at: '2026-08-20T00:00:00.000Z' }],
};

function mockFetch(options: { digest?: unknown; ok?: boolean }) {
  return jest.fn(async () => ({
    ok: options.ok ?? true,
    status: options.ok === false ? 500 : 200,
    json: async () => options.digest ?? DIGEST,
  })) as unknown as typeof fetch;
}

afterEach(() => {
  jest.restoreAllMocks();
});

test('all five sections render with thresholds stated and action links to the owning surfaces', async () => {
  global.fetch = mockFetch({});

  await act(async () => {
    render(<CoachIntelligencePage />);
  });

  expect(screen.getByText('Holds expiring within 14 days')).toBeTruthy();
  expect(screen.getByText('3+ RED readiness days this week')).toBeTruthy();
  expect(screen.getByText('Attendance fading')).toBeTruthy();
  expect(screen.getByText('Gaps waiting 14+ days for a drill')).toBeTruthy();
  expect(screen.getByText('Sessions unreviewed for 7+ days')).toBeTruthy();
  // Acting happens on the surface that owns the record, not here.
  expect(screen.getByRole('link', { name: 'Clearance board' }).getAttribute('href')).toBe('/coach/sports-medicine');
  expect(screen.getByRole('link', { name: 'Assign a drill' }).getAttribute('href')).toBe('/coach/progression-intelligence');
  // The framing the approval was conditioned on.
  expect(screen.getByText(/no scores, no predictions/i)).toBeTruthy();
});

test('the empty state never claims the floor is fine', async () => {
  global.fetch = mockFetch({
    digest: { stalled_gaps: [], readiness_concerns: [], fading_attendance: [], unreviewed_sessions: [], expiring_holds: [] },
  });

  await act(async () => {
    render(<CoachIntelligencePage />);
  });

  expect(screen.getByText('Nothing needs your eyes')).toBeTruthy();
  expect(screen.getByText(/not a guarantee the floor is fine/)).toBeTruthy();
});

test('a failed read admits items may exist', async () => {
  global.fetch = mockFetch({ ok: false });

  await act(async () => {
    render(<CoachIntelligencePage />);
  });

  expect(screen.getByText(/Items may exist that are not shown here/)).toBeTruthy();
  expect(screen.queryByText('Nothing needs your eyes')).toBeNull();
});
