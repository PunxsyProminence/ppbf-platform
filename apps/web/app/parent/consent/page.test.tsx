/**
 * @jest-environment jsdom
 */

import type { ReactNode } from 'react';
import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import GuardianMediaConsentPage from './page';

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

const NEEDS_CONSENT = [
  {
    athlete_id: 'ath-1',
    consent_ok: false,
    guardian_count: 1,
    missing_guardian_count: 1,
    per_guardian: [{ parent_id: 'p1', you: true, status: null, covers_video: null, public_use_allowed: null, signed_at: null }],
  },
];

const ALREADY_SIGNED = [
  {
    athlete_id: 'ath-1',
    consent_ok: true,
    guardian_count: 1,
    missing_guardian_count: 0,
    per_guardian: [{ parent_id: 'p1', you: true, status: 'signed', covers_video: true, public_use_allowed: false, signed_at: '2026-08-01T00:00:00Z' }],
  },
];

const originalFetch = global.fetch;
const originalConfirm = window.confirm;

afterEach(() => {
  global.fetch = originalFetch;
  window.confirm = originalConfirm;
  jest.clearAllMocks();
});

test('a child needing consent shows the Grant Consent button', async () => {
  global.fetch = jest.fn().mockResolvedValue(jsonResponse({ ok: true, items: NEEDS_CONSENT })) as unknown as typeof fetch;

  render(<GuardianMediaConsentPage />);

  await screen.findByText('Consent needed');
  expect(screen.getByRole('button', { name: 'Grant Consent' })).toBeInTheDocument();
});

test('a child with consent already on file shows Withdraw Consent, not Grant', async () => {
  global.fetch = jest.fn().mockResolvedValue(jsonResponse({ ok: true, items: ALREADY_SIGNED })) as unknown as typeof fetch;

  render(<GuardianMediaConsentPage />);

  await screen.findByText('Consent on file');
  expect(screen.getByRole('button', { name: 'Withdraw Consent' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Grant Consent' })).not.toBeInTheDocument();
});

test('a multi-guardian child shows how many guardians still need to consent', async () => {
  const multiGuardian = [{ ...NEEDS_CONSENT[0], guardian_count: 2, missing_guardian_count: 1 }];
  global.fetch = jest.fn().mockResolvedValue(jsonResponse({ ok: true, items: multiGuardian })) as unknown as typeof fetch;

  render(<GuardianMediaConsentPage />);

  await screen.findByText(/This child has 2 guardians/);
});

test('granting posts decision=grant with the checkbox defaults (video included, not public)', async () => {
  const fetchMock = jest.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body));
      expect(body).toEqual({ athlete_id: 'ath-1', decision: 'grant', covers_video: true, public_use_allowed: false });
      return jsonResponse({ ok: true, athlete_id: 'ath-1', decision: 'grant' });
    }
    return jsonResponse({ ok: true, items: NEEDS_CONSENT });
  });
  global.fetch = fetchMock as unknown as typeof fetch;

  render(<GuardianMediaConsentPage />);
  await screen.findByText('Consent needed');

  fireEvent.click(screen.getByRole('button', { name: 'Grant Consent' }));

  await waitFor(() => expect(screen.getByText('Consent granted.')).toBeInTheDocument());
});

test('withdrawing asks for confirmation first and sends nothing if declined', async () => {
  window.confirm = jest.fn().mockReturnValue(false);
  const fetchMock = jest.fn().mockResolvedValue(jsonResponse({ ok: true, items: ALREADY_SIGNED }));
  global.fetch = fetchMock as unknown as typeof fetch;

  render(<GuardianMediaConsentPage />);
  await screen.findByText('Consent on file');

  fireEvent.click(screen.getByRole('button', { name: 'Withdraw Consent' }));

  await waitFor(() => expect(window.confirm).toHaveBeenCalled());
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test('withdrawing, once confirmed, posts decision=withdraw', async () => {
  window.confirm = jest.fn().mockReturnValue(true);
  const fetchMock = jest.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body));
      expect(body.decision).toBe('withdraw');
      return jsonResponse({ ok: true, athlete_id: 'ath-1', decision: 'withdraw' });
    }
    return jsonResponse({ ok: true, items: ALREADY_SIGNED });
  });
  global.fetch = fetchMock as unknown as typeof fetch;

  render(<GuardianMediaConsentPage />);
  await screen.findByText('Consent on file');

  fireEvent.click(screen.getByRole('button', { name: 'Withdraw Consent' }));

  await waitFor(() => expect(screen.getByText('Consent withdrawn.')).toBeInTheDocument());
});

test('no linked children renders the empty state', async () => {
  global.fetch = jest.fn().mockResolvedValue(jsonResponse({ ok: true, items: [] })) as unknown as typeof fetch;

  render(<GuardianMediaConsentPage />);

  await screen.findByText('No linked children found');
});

test('a failed load shows the error state, never a false empty state', async () => {
  global.fetch = jest.fn().mockResolvedValue(jsonResponse({ error: 'Database unavailable' }, false)) as unknown as typeof fetch;

  render(<GuardianMediaConsentPage />);

  await screen.findByText('Database unavailable');
  expect(screen.queryByText('No linked children found')).not.toBeInTheDocument();
});

test('a child is named, not numbered, and the withdraw confirmation names them too', async () => {
  window.confirm = jest.fn().mockReturnValue(false);
  const named = [{ ...ALREADY_SIGNED[0], athlete_name: 'Mia Cortez' }];
  global.fetch = jest.fn().mockResolvedValue(jsonResponse({ ok: true, items: named })) as unknown as typeof fetch;

  render(<GuardianMediaConsentPage />);

  await screen.findByText('Mia Cortez');
  expect(screen.queryByText('ath-1')).toBeNull();

  fireEvent.click(screen.getByRole('button', { name: 'Withdraw Consent' }));

  await waitFor(() => expect(window.confirm).toHaveBeenCalled());
  const message = (window.confirm as jest.Mock).mock.calls[0][0] as string;
  expect(message).toContain('Mia Cortez');
  expect(message).toMatch(/retracted from distribution immediately/);
});

test('a missing name falls back to the athlete id rather than a blank card', async () => {
  global.fetch = jest.fn().mockResolvedValue(jsonResponse({ ok: true, items: NEEDS_CONSENT })) as unknown as typeof fetch;

  render(<GuardianMediaConsentPage />);

  await screen.findByText('ath-1');
});
