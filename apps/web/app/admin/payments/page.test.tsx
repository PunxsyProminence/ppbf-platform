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

// Lane BT, BOA-13: the Stripe platform registration steps name the secret keys and the
// Container App secrets, so they are the platform owner's (on System's platform view,
// app/admin/system/page.test.tsx). The gym admin's page, read by organization admins,
// carries none of them even while the platform account is unregistered.
test('while the platform account is unregistered, the gym admin is shown no secret and no setup walkthrough', async () => {
  const firstStep = "PPBF registers the platform's Stripe account and Connect OAuth client — done once, for every organization.";
  global.fetch = mockFetch({ remainingSteps: [firstStep] });

  await act(async () => {
    render(<PaymentsSettingsPage />);
  });

  expect(screen.getByText('Remaining setup')).toBeTruthy();
  expect(screen.getByText(firstStep)).toBeTruthy();
  expect(screen.queryByText(/Platform account registration/)).toBeNull();
  const text = document.body.textContent ?? '';
  for (const secret of ['PAYMENT_CONNECT_CLIENT_ID', 'PAYMENT_PLATFORM_SECRET_KEY', 'PAYMENT_PLATFORM_WEBHOOK_SECRET', 'sk_test_', 'sk_live_', 'whsec_', 'secret key', 'signing secret']) {
    expect(text).not.toContain(secret);
  }
});

test('a failed read never says a lane is "not connected" or offers a first connect', async () => {
  global.fetch = jest.fn(async (input: RequestInfo | URL) =>
    String(input).includes('/payments/accounts')
      ? ({ ok: false, status: 500, json: async () => ({}) } as Response)
      : ({ ok: true, json: async () => ({ ready: false, enabled: false, remainingSteps: [] }) } as Response),
  ) as unknown as typeof fetch;

  await act(async () => {
    render(<PaymentsSettingsPage />);
  });

  expect(screen.getByText('Payment settings could not be read')).toBeTruthy();
  expect(screen.queryByText('not connected')).toBeNull();
  expect(screen.queryByRole('link', { name: 'Connect Stripe account' })).toBeNull();
});

test('disconnecting is described as what the webhook does: the account is marked disconnected', async () => {
  global.fetch = mockFetch({});

  await act(async () => {
    render(<PaymentsSettingsPage />);
  });

  expect(screen.getByText(/the platform is notified and\s+marks the account disconnected\./)).toBeTruthy();
  expect(screen.queryByText(/stops using the account immediately/)).toBeNull();
});
