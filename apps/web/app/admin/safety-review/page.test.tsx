/**
 * @jest-environment jsdom
 */

import type { ReactNode } from 'react';
import { render, screen } from '@testing-library/react';

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

test('nothing open renders the all-clear empty state', async () => {
  global.fetch = jest.fn().mockResolvedValue(
    jsonResponse({ ok: true, openHolds: [], failingGates: [], openEscalations: [], openViolations: [] }),
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
