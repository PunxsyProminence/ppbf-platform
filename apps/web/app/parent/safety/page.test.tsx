/**
 * @jest-environment jsdom
 */

import type { ReactNode } from 'react';
import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';

import GuardianSafetyPage from './page';

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

const HELD_ATHLETE = [
  {
    athlete_id: 'ath-1',
    athlete_name: 'Jordan T.',
    hold: {
      scope: 'all_training' as const,
      athlete_explanation: 'You need a doctor note before training resumes.',
      lift_condition_text: 'Bring a signed clearance note.',
      placed_at: '2026-08-01T00:00:00.000Z',
      expires_at: null,
    },
    gates: [
      { gate_key: 'contact_medical_clearance', name: 'Contact Requires Medical Clearance', category: 'medical', outcome: 'flagged' as const, evaluated_at: '2026-08-01T00:00:00.000Z' },
    ],
  },
];

const CLEAR_ATHLETE = [
  {
    athlete_id: 'ath-2',
    athlete_name: 'Sam R.',
    hold: null,
    gates: [
      { gate_key: 'contact_medical_clearance', name: 'Contact Requires Medical Clearance', category: 'medical', outcome: 'passed' as const, evaluated_at: '2026-08-01T00:00:00.000Z' },
    ],
  },
];

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  jest.clearAllMocks();
});

test('an athlete under an active hold shows the athlete-safe explanation and lift condition', async () => {
  global.fetch = jest.fn().mockResolvedValue(jsonResponse({ ok: true, items: HELD_ATHLETE })) as unknown as typeof fetch;

  render(<GuardianSafetyPage />);

  await screen.findByText('Training is paused right now');
  expect(screen.getByText('You need a doctor note before training resumes.')).toBeInTheDocument();
  expect(screen.getByText(/Bring a signed clearance note\./)).toBeInTheDocument();
});

test('an athlete with no active hold shows "no training pause on file", not silence', async () => {
  global.fetch = jest.fn().mockResolvedValue(jsonResponse({ ok: true, items: CLEAR_ATHLETE })) as unknown as typeof fetch;

  render(<GuardianSafetyPage />);

  await screen.findByText('No training pause on file right now.');
  expect(screen.queryByText('Training is paused right now')).not.toBeInTheDocument();
});

test('gate outcomes render with human labels, not raw enum values', async () => {
  global.fetch = jest.fn().mockResolvedValue(jsonResponse({ ok: true, items: CLEAR_ATHLETE })) as unknown as typeof fetch;

  render(<GuardianSafetyPage />);

  await screen.findByText('Contact Requires Medical Clearance');
  expect(screen.getByText('Clear')).toBeInTheDocument();
  expect(screen.queryByText('passed')).not.toBeInTheDocument();
});

test('multiple linked children each render their own card', async () => {
  global.fetch = jest.fn().mockResolvedValue(jsonResponse({ ok: true, items: [...HELD_ATHLETE, ...CLEAR_ATHLETE] })) as unknown as typeof fetch;

  render(<GuardianSafetyPage />);

  await screen.findByText('Jordan T.');
  expect(screen.getByText('Sam R.')).toBeInTheDocument();
});

test('links to the existing consent page rather than duplicating it', async () => {
  global.fetch = jest.fn().mockResolvedValue(jsonResponse({ ok: true, items: [] })) as unknown as typeof fetch;

  render(<GuardianSafetyPage />);

  await screen.findByText('No linked children found');
  expect(screen.getByRole('link', { name: 'Photo & Video Consent' })).toHaveAttribute('href', '/parent/consent');
});

test('no linked children renders the empty state', async () => {
  global.fetch = jest.fn().mockResolvedValue(jsonResponse({ ok: true, items: [] })) as unknown as typeof fetch;

  render(<GuardianSafetyPage />);

  await screen.findByText('No linked children found');
});

test('a failed load shows the error state, never a false empty state', async () => {
  global.fetch = jest.fn().mockResolvedValue(jsonResponse({ error: 'Database unavailable' }, false)) as unknown as typeof fetch;

  render(<GuardianSafetyPage />);

  await screen.findByText('Database unavailable');
  expect(screen.queryByText('No linked children found')).not.toBeInTheDocument();
});
