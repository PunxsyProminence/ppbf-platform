/**
 * @jest-environment jsdom
 */

import type { ReactNode } from 'react';
import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import ActivationCodesManagementPage from './page';
import { getRoleSessionSnapshot } from '@/components/roleSession';

jest.mock('@/components/RoleSessionGate', () => ({
  __esModule: true,
  default: ({ children }: { readonly children: ReactNode }) => children,
}));

jest.mock('@/components/roleSession', () => ({
  ...jest.requireActual('@/components/roleSession'),
  getRoleSessionSnapshot: jest.fn(),
}));

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ children, href }: { readonly children: ReactNode; readonly href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

const mockGetRoleSessionSnapshot = getRoleSessionSnapshot as jest.Mock;
const originalFetch = global.fetch;

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body } as Response;
}

afterEach(() => {
  global.fetch = originalFetch;
  jest.clearAllMocks();
});

describe('ActivationCodesManagementPage', () => {
  it('renders WrongRoleNotice for platform_owner role', async () => {
    mockGetRoleSessionSnapshot.mockReturnValue({ role: 'platform_owner', expiresAt: Date.now() + 10000 });
    const fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    render(<ActivationCodesManagementPage />);

    expect(screen.getByText('Activation codes are managed per gym')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Platform console' })).toHaveAttribute('href', '/admin/platform');
  });

  it('renders activation console and loads outstanding codes for organization admin', async () => {
    mockGetRoleSessionSnapshot.mockReturnValue({ role: 'admin', expiresAt: Date.now() + 10000 });

    const outstandingCodes = [
      {
        account_id: 'ath-001',
        athlete_id: 'athlete-1',
        organization_id: 'org-1',
        issued_by_account_id: 'admin-1',
        created_at: '2026-08-01T00:00:00Z',
        expires_at: '2026-08-15T00:00:00Z',
        is_expired: false,
      },
    ];

    const fetchMock = jest.fn(async (url: string) => {
      if (String(url).includes('/api/pilot/admin/activation-codes')) {
        return jsonResponse({ ok: true, codes: outstandingCodes });
      }
      return jsonResponse({ ok: true });
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    render(<ActivationCodesManagementPage />);

    expect(screen.getByText('Issue Athlete Activation Codes')).toBeInTheDocument();
    expect(await screen.findByText('Account: ath-001')).toBeInTheDocument();
    expect(screen.getByText('Pending Redemption')).toBeInTheDocument();
  });

  it('issues an activation code when form is submitted', async () => {
    mockGetRoleSessionSnapshot.mockReturnValue({ role: 'admin', expiresAt: Date.now() + 10000 });

    const fetchMock = jest.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes('/api/pilot/admin/activation-codes')) {
        if (init?.method === 'POST') {
          return jsonResponse({
            ok: true,
            account_id: 'ath-002',
            organization_id: 'org-1',
            activation_code: 'ABCD-1234-EFGH',
            expires_at: '2026-08-20T00:00:00Z',
            code_is_shown_once: true,
          });
        }
        return jsonResponse({ ok: true, codes: [] });
      }
      return jsonResponse({ ok: true });
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    render(<ActivationCodesManagementPage />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    const input = screen.getByLabelText('Athlete Account ID');
    fireEvent.change(input, { target: { value: 'ath-002' } });

    const submitBtn = screen.getByRole('button', { name: 'Issue Activation Code' });
    fireEvent.click(submitBtn);

    await waitFor(() => expect(screen.getByText('ABCD-1234-EFGH')).toBeInTheDocument());
    expect(
      screen.getByText('▲ Write down or print this code now. It is shown ONCE and cannot be recovered later.'),
    ).toBeInTheDocument();
  });

  it('displays error when loading outstanding codes fails', async () => {
    mockGetRoleSessionSnapshot.mockReturnValue({ role: 'admin', expiresAt: Date.now() + 10000 });

    const fetchMock = jest.fn(async (url: string) => {
      if (String(url).includes('/api/pilot/admin/activation-codes')) {
        return jsonResponse({ error: 'Failed to load codes' }, false, 500);
      }
      return jsonResponse({ ok: true });
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    render(<ActivationCodesManagementPage />);

    await screen.findByRole('alert');
    expect(screen.getByRole('alert')).toHaveTextContent('Failed to load codes');
  });
});
