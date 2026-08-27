/**
 * @jest-environment jsdom
 */

import type { ReactNode } from 'react';
import { render, screen, within } from '@testing-library/react';

import SafetyReviewPage from './page';

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

// The fixture carries violationsTruncated because the route now always sends
// it, and the page fails closed on its absence: a response that will not say
// whether the violations feed was cut cannot buy an all-clear. The assertion
// below is unchanged -- an untruncated, genuinely empty review still renders
// the all-clear.
test('nothing open renders the all-clear empty state', async () => {
  global.fetch = jest.fn().mockResolvedValue(
    jsonResponse({ ok: true, openHolds: [], failingGates: [], openEscalations: [], openViolations: [], violationsReadLimit: 200, violationsTruncated: false }),
  ) as unknown as typeof fetch;

  render(<SafetyReviewPage />);

  await screen.findByText('Nothing open right now');
});

test('an active hold renders in its own section with a count', async () => {
  global.fetch = jest.fn().mockResolvedValue(
    jsonResponse({
      ok: true,
      openHolds: [{ hold_id: 'hold-1', athlete_id: 'ath-1', athlete_name: 'Jordan T.', scope: 'all_training', reason_category: 'medical', placed_by_role: 'coach', placed_at: '2026-08-01T00:00:00.000Z' }],
      failingGates: [],
      openEscalations: [],
      openViolations: [],
    }),
  ) as unknown as typeof fetch;

  render(<SafetyReviewPage />);

  await screen.findByText('Active Training Holds (1)');
  expect(screen.getByText('Jordan T.')).toBeDefined();
});

test('a failing gate renders in its own section', async () => {
  global.fetch = jest.fn().mockResolvedValue(
    jsonResponse({
      ok: true,
      openHolds: [],
      failingGates: [{ athlete_id: 'ath-1', athlete_name: 'Jordan T.', gate_name: 'Contact Requires Medical Clearance', outcome: 'flagged', evaluated_at: '2026-08-01T00:00:00.000Z' }],
      openEscalations: [],
      openViolations: [],
    }),
  ) as unknown as typeof fetch;

  render(<SafetyReviewPage />);

  await screen.findByText('Failing Safety Gates (1)');
});

test('an open escalation renders with a severity badge and links to the full queue', async () => {
  global.fetch = jest.fn().mockResolvedValue(
    jsonResponse({
      ok: true,
      openHolds: [],
      failingGates: [],
      openEscalations: [{ escalation_id: 'esc-1', athlete_id: 'ath-1', athlete_name: 'Jordan T.', source_type: 'near_miss', severity: 'critical', status: 'open', created_at: '2026-08-01T00:00:00.000Z' }],
      openViolations: [],
    }),
  ) as unknown as typeof fetch;

  render(<SafetyReviewPage />);

  await screen.findByText('Open Escalations (1)');
  expect(screen.getByText('critical')).toBeDefined();
  expect((screen.getByRole('link', { name: 'Open the full escalation queue' }) as HTMLAnchorElement).getAttribute('href')).toBe('/admin/escalations');
});

test('a failed load shows the error state, never a false all-clear', async () => {
  global.fetch = jest.fn().mockResolvedValue(jsonResponse({ error: 'Database unavailable' }, false)) as unknown as typeof fetch;

  render(<SafetyReviewPage />);

  await screen.findByText('Database unavailable');
  expect(screen.queryByText('Nothing open right now')).toBeNull();
});

test('a severity badge carries a glyph, not colour alone (Law 3)', async () => {
  global.fetch = jest.fn().mockResolvedValue(
    jsonResponse({
      ok: true,
      openHolds: [],
      failingGates: [],
      openEscalations: [
        { escalation_id: 'esc-1', athlete_id: 'ath-1', athlete_name: 'Jordan T.', source_type: 'near_miss', severity: 'critical', status: 'open', created_at: '2026-08-01T00:00:00.000Z' },
        { escalation_id: 'esc-2', athlete_id: 'ath-2', athlete_name: 'Sam R.', source_type: 'near_miss', severity: 'moderate', status: 'open', created_at: '2026-08-01T00:00:00.000Z' },
      ],
      openViolations: [],
    }),
  ) as unknown as typeof fetch;

  render(<SafetyReviewPage />);

  // This page shipped a bare rung while both of its siblings -- the escalation
  // queue over the same four-value union and the compliance register -- supply
  // the glyphs, so severity here was carried by colour alone.
  const critical = await screen.findByText('critical');
  expect(critical.textContent).toContain('✕');
  expect(screen.getByText('moderate').textContent).toContain('◉');
});

test('a failed load is not stamped as a medical emergency', async () => {
  global.fetch = jest.fn().mockResolvedValue(jsonResponse({ error: 'Database unavailable' }, false)) as unknown as typeof fetch;

  render(<SafetyReviewPage />);

  const alert = await screen.findByRole('alert');
  expect(alert.className).toContain('alert--warning');
  expect(alert.className).not.toContain('alert--critical');
  expect(within(alert).getByText('Attention')).toBeTruthy();
});

// READ HONESTY (shapes 1 and 4). Three of this rollup's four feeds read the
// organization entire; the compliance-violations feed does not. safetyReview.ts
// reads VIOLATION_ROLLUP_READ_LIMIT rows `order by created_at desc` and only
// THEN filters them to the open statuses, so an open violation older than that
// window is dropped before the filter sees it.
//
// The page introduced all four with "Everything open, right now, across the
// four safety systems", and when the four lists came back empty it said
// "Nothing open right now -- No active holds, failing gate checks, open
// escalations, or open compliance violations."
//
// An admin doing the pre-session safety sweep reads that and stands the
// session up. On a gym past the cap there may be open violations the page
// never read.
//
// WATCHED TO FAIL: restore the word "Everything" in the header and the first
// test goes red naming it; drop the truncation notice and the second does.
test('the rollup header never calls a capped read everything open', async () => {
  global.fetch = jest.fn().mockResolvedValue(
    jsonResponse({ ok: true, openHolds: [], failingGates: [], openEscalations: [], openViolations: [], violationsReadLimit: 200, violationsTruncated: false }),
  ) as unknown as typeof fetch;

  render(<SafetyReviewPage />);

  const heading = await screen.findByRole('heading', { name: 'Safety Review' });
  const header = heading.closest('header') as HTMLElement;
  // Not vacuous: this really is the page's own header.
  expect(header).toBeTruthy();
  expect(within(header).getByText(/four safety systems/i)).toBeTruthy();

  expect(header.textContent ?? '').not.toMatch(/everything open/i);
});

test('a truncated violations feed says so instead of claiming nothing is open', async () => {
  global.fetch = jest.fn().mockResolvedValue(
    jsonResponse({ ok: true, openHolds: [], failingGates: [], openEscalations: [], openViolations: [], violationsReadLimit: 200, violationsTruncated: true }),
  ) as unknown as typeof fetch;

  render(<SafetyReviewPage />);

  // The window is named, with its number.
  const notice = await screen.findByText(/200 most recently filed/i);
  expect(notice).toBeTruthy();

  // And the all-clear does not get to speak for compliance violations while
  // the feed that backs it was cut short.
  expect(screen.queryByText('Nothing open right now')).toBeNull();
});

test('an untruncated all-clear still reads as an all-clear', async () => {
  global.fetch = jest.fn().mockResolvedValue(
    jsonResponse({ ok: true, openHolds: [], failingGates: [], openEscalations: [], openViolations: [], violationsReadLimit: 200, violationsTruncated: false }),
  ) as unknown as typeof fetch;

  render(<SafetyReviewPage />);

  await screen.findByText('Nothing open right now');
  expect(screen.queryByText(/200 most recently filed/i)).toBeNull();
});
