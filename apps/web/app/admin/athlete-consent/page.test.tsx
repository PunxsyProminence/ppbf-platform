/**
 * @jest-environment jsdom
 */

import type { ReactNode } from 'react';
import '@testing-library/jest-dom';
import { fireEvent, render, screen } from '@testing-library/react';

import AthleteConsentAuditPage from './page';

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

const ITEMS = [
  { athlete_id: 'ath-1', athlete_name: 'Missing Consent Athlete', consent_ok: false, guardian_count: 0, missing_guardian_count: 0 },
  { athlete_id: 'ath-2', athlete_name: 'Cleared Athlete', consent_ok: true, guardian_count: 1, missing_guardian_count: 0 },
  { athlete_id: 'ath-3', athlete_name: 'Partial Athlete', consent_ok: false, guardian_count: 2, missing_guardian_count: 1 },
];

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  jest.clearAllMocks();
});

test('defaults to the "missing" filter, showing only athletes without full consent', async () => {
  global.fetch = jest.fn().mockResolvedValue(jsonResponse({ ok: true, items: ITEMS })) as unknown as typeof fetch;

  render(<AthleteConsentAuditPage />);

  await screen.findByText('Missing Consent Athlete');
  expect(screen.getByText('Partial Athlete')).toBeInTheDocument();
  expect(screen.queryByText('Cleared Athlete')).not.toBeInTheDocument();
});

test('an athlete with zero guardians on file reads "No guardians on file", not a false 0/0 cleared', async () => {
  global.fetch = jest.fn().mockResolvedValue(jsonResponse({ ok: true, items: ITEMS })) as unknown as typeof fetch;

  render(<AthleteConsentAuditPage />);

  await screen.findByText('Missing Consent Athlete');
  expect(screen.getByText('No guardians on file')).toBeInTheDocument();
});

test('a partially-consented athlete shows the guardian fraction', async () => {
  global.fetch = jest.fn().mockResolvedValue(jsonResponse({ ok: true, items: ITEMS })) as unknown as typeof fetch;

  render(<AthleteConsentAuditPage />);

  await screen.findByText('Partial Athlete');
  expect(screen.getByText('1/2 consented')).toBeInTheDocument();
});

test('switching to "Consent on file" shows only cleared athletes', async () => {
  global.fetch = jest.fn().mockResolvedValue(jsonResponse({ ok: true, items: ITEMS })) as unknown as typeof fetch;

  render(<AthleteConsentAuditPage />);
  await screen.findByText('Missing Consent Athlete');

  fireEvent.click(screen.getByRole('button', { name: 'Consent on file' }));

  await screen.findByText('Cleared Athlete');
  expect(screen.queryByText('Missing Consent Athlete')).not.toBeInTheDocument();
});

test('switching to "All athletes" shows every row', async () => {
  global.fetch = jest.fn().mockResolvedValue(jsonResponse({ ok: true, items: ITEMS })) as unknown as typeof fetch;

  render(<AthleteConsentAuditPage />);
  await screen.findByText('Missing Consent Athlete');

  fireEvent.click(screen.getByRole('button', { name: 'All athletes' }));

  await screen.findByText('Cleared Athlete');
  expect(screen.getByText('Missing Consent Athlete')).toBeInTheDocument();
  expect(screen.getByText('Partial Athlete')).toBeInTheDocument();
});

test('an empty filtered view renders "Nothing in this view", not a loading or error state', async () => {
  global.fetch = jest.fn().mockResolvedValue(jsonResponse({ ok: true, items: [ITEMS[1]] })) as unknown as typeof fetch;

  render(<AthleteConsentAuditPage />);

  await screen.findByText('Nothing in this view');
});

test('a failed load shows the error state, never a false empty view', async () => {
  global.fetch = jest.fn().mockResolvedValue(jsonResponse({ error: 'Database unavailable' }, false)) as unknown as typeof fetch;

  render(<AthleteConsentAuditPage />);

  await screen.findByText('Database unavailable');
  expect(screen.getByText('The audit could not be loaded')).toBeInTheDocument();
  expect(screen.queryByText('Nothing in this view')).not.toBeInTheDocument();
});
