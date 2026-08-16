/**
 * @jest-environment jsdom
 */

// The payments settings page: the connect button per lane, honest lane
// status from pilot.payment_accounts, the outcome banner from the callback
// redirect, and the setup checklist. What these pin: the button targets the
// connect/start route (a navigation, not a fetch -- the OAuth round trip is
// a full-page redirect); a disconnected lane says so and offers reconnect;
// and the page never claims charging exists.

import { act, render, screen } from '@testing-library/react';

import PaymentsSettingsPage from './page';

jest.mock('@/components/RoleSessionGate', () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

const searchParams = new URLSearchParams();
jest.mock('next/navigation', () => ({
  useSearchParams: () => searchParams,
}));

function mockFetch(options: {
  accounts?: Array<Record<string, unknown>>;
  remainingSteps?: string[];
}) {
  return jest.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/payments/accounts')) {
      return { ok: true, json: async () => ({ items: options.accounts ?? [] }) } as Response;
    }
    if (url.includes('/payments/setup-status')) {
      return {
        ok: true,
        json: async () => ({ ready: false, enabled: false, remainingSteps: options.remainingSteps ?? [] }),
      } as Response;
    }
    return { ok: true, json: async () => ({}) } as Response;
  }) as unknown as typeof fetch;
}

afterEach(() => {
  jest.restoreAllMocks();
  searchParams.delete('connect');
});

test('both lanes offer the connect button targeting the start route', async () => {
  global.fetch = mockFetch({});

  await act(async () => {
    render(<PaymentsSettingsPage />);
  });

  const buttons = screen.getAllByRole('link', { name: 'Connect Stripe account' });
  expect(buttons).toHaveLength(2);
  const hrefs = buttons.map((el) => el.getAttribute('href'));
  expect(hrefs.some((href) => href?.includes('/api/pilot/payments/connect/start?lane=giving'))).toBe(true);
  expect(hrefs.some((href) => href?.includes('/api/pilot/payments/connect/start?lane=program'))).toBe(true);
});

test('a connected lane shows its account and offers a swap, not a first connect', async () => {
  global.fetch = mockFetch({
    accounts: [{ lane: 'giving', stripe_account_id: 'acct_g_1', status: 'connected', connected_at: '2026-08-15', revoked_at: null }],
  });

  await act(async () => {
    render(<PaymentsSettingsPage />);
  });

  expect(screen.getByText(/Account acct_g_1/)).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Swap Stripe account' })).toBeTruthy();
  // The other lane still offers a first connect.
  expect(screen.getAllByRole('link', { name: 'Connect Stripe account' })).toHaveLength(1);
});

test('a revoked lane says so instead of pretending it still settles', async () => {
  global.fetch = mockFetch({
    accounts: [{ lane: 'program', stripe_account_id: 'acct_p_1', status: 'disconnected', connected_at: '2026-08-15', revoked_at: '2026-08-16' }],
  });

  await act(async () => {
    render(<PaymentsSettingsPage />);
  });

  expect(screen.getByText('disconnected')).toBeTruthy();
  expect(screen.getByText(/revoked from the Stripe dashboard/)).toBeTruthy();
});

test('the callback outcome banner renders from the redirect param', async () => {
  searchParams.set('connect', 'ok');
  global.fetch = mockFetch({});

  await act(async () => {
    render(<PaymentsSettingsPage />);
  });

  expect(screen.getByText('Stripe account connected.')).toBeTruthy();
});

test('the remaining-steps checklist renders and the page states the no-charging boundary', async () => {
  global.fetch = mockFetch({ remainingSteps: ['Record compliance sign-off, then turn payments on in staging before production.'] });

  await act(async () => {
    render(<PaymentsSettingsPage />);
  });

  expect(screen.getByText(/Record compliance sign-off/)).toBeTruthy();
  expect(screen.getByText(/Nothing charges until\s+compliance sign-off/)).toBeTruthy();
});

test('while the platform account is unregistered, the slot shows the owner the exact setup walkthrough', async () => {
  global.fetch = mockFetch({ remainingSteps: ['Register the platform Stripe account.'] });

  await act(async () => {
    render(<PaymentsSettingsPage />);
  });

  expect(screen.getByText(/How to register the platform account/)).toBeTruthy();
  // The three secret names are stated verbatim -- the owner should never
  // have to guess what Azure wants.
  expect(screen.getByText('PAYMENT_CONNECT_CLIENT_ID')).toBeTruthy();
  expect(screen.getByText('PAYMENT_PLATFORM_SECRET_KEY')).toBeTruthy();
  expect(screen.getByText('PAYMENT_PLATFORM_WEBHOOK_SECRET')).toBeTruthy();
  expect(screen.getByText('account.application.deauthorized')).toBeTruthy();
  // And the boundary holds even here: configuration opens onboarding, not charging.
  expect(screen.getByText(/Configuration only opens onboarding/)).toBeTruthy();
});
