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

test('a pain-report escalation badge reads "Pain report" in its severity colour; another escalation keeps its word (#1528)', async () => {
  const escalation = { source_type: 'near_miss', created_at: '2026-08-10T12:00:00.000Z' };
  global.fetch = mockFetch({
    digest: {
      ...DIGEST,
      open_safety_escalations: [
        { ...escalation, athlete_id: 'ath-1', athlete_name: 'Jordan P.', escalation_id: 'esc-1', severity: 'critical', reason: 'Pain 9/10 reported after sparring.', pain_report: true },
        { ...escalation, athlete_id: 'ath-2', athlete_name: 'Sam R.', escalation_id: 'esc-2', severity: 'moderate', reason: 'Slipped on the apron.', pain_report: false },
      ],
      open_compliance_violations: [],
    },
  });

  await act(async () => {
    render(<CoachIntelligencePage />);
  });

  const item = (reason: string) => screen.getByText(new RegExp(reason)).closest('li') as HTMLElement;
  const badgeOf = (reason: string) => item(reason).querySelector('.badge') as HTMLElement;

  const pain = badgeOf('Pain 9/10 reported');
  expect(pain.textContent).toBe('Pain report');
  expect(pain.className).toContain('badge--locked');
  expect(item('Pain 9/10 reported').textContent).not.toMatch(/\b(low|moderate|medium|high|critical)\b/i);

  const other = badgeOf('Slipped on the apron');
  expect(other.textContent).toBe('moderate');
  expect(other.className).toContain('badge--monitor');
});

// LC-05. Computer-form dates, and a UTC day for an instant.
test('dates read as dates, and an instant is the gym day, not the UTC day', async () => {
  global.fetch = mockFetch({});

  await act(async () => {
    render(<CoachIntelligencePage />);
  });

  // 2026-08-20T00:00:00Z is 8 PM on August 19 at the gym.
  expect(screen.getByText(/hold expires Aug 19, 2026/)).toBeTruthy();
  expect(screen.getByText(/session on Aug 1, 2026, waiting 15 days/)).toBeTruthy();
  expect(screen.queryByText(/2026-08-/)).toBeNull();
  expect(screen.queryByText(/deterministic/i)).toBeNull();
});
