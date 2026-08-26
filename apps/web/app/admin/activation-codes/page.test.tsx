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
    // Reworded from "Write down or print" — this screen offers no print, and
    // an instruction naming a control that does not exist is the same defect
    // class as the review-action error corrected in #680.
    expect(
      screen.getByText('▲ Copy or write down this code now. It is shown ONCE and cannot be recovered later.'),
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

  /**
   * The issued code is shown once and its plaintext is never stored, so an
   * admin who does not notice it has permanently lost it. That makes both the
   * announcement and a working way to capture it load-bearing rather than
   * polish.
   */
  describe('the one-time code an admin cannot get back', () => {
    async function issueCode(clipboard?: { writeText: jest.Mock }) {
      mockGetRoleSessionSnapshot.mockReturnValue({ role: 'admin', expiresAt: Date.now() + 10000 });
      if (clipboard) {
        Object.defineProperty(navigator, 'clipboard', { value: clipboard, configurable: true });
      }

      let issued = 0;
      const fetchMock = jest.fn(async (url: string, init?: RequestInit) => {
        if (String(url).includes('/api/pilot/admin/activation-codes')) {
          if (init?.method === 'POST') {
            issued += 1;
            return jsonResponse({
              ok: true,
              account_id: `ath-00${issued}`,
              activation_code: issued === 1 ? 'ABCD-1234-EFGH' : 'WXYZ-9876-MNOP',
              expires_at: '2026-08-20T00:00:00Z',
            });
          }
          return jsonResponse({ ok: true, codes: [] });
        }
        return jsonResponse({ ok: true });
      });
      global.fetch = fetchMock as unknown as typeof fetch;

      render(<ActivationCodesManagementPage />);
      await waitFor(() => expect(fetchMock).toHaveBeenCalled());

      fireEvent.change(screen.getByLabelText('Athlete Account ID'), { target: { value: 'ath-001' } });
      fireEvent.click(screen.getByRole('button', { name: 'Issue Activation Code' }));
      await screen.findByText('ABCD-1234-EFGH');
    }

    it('announces the issued code to a screen reader', async () => {
      await issueCode();

      // The panel appears in response to a submit that moves no focus, so
      // without a live region the announcement never happens at all.
      const live = screen.getByRole('status');
      expect(live).toHaveAttribute('aria-live', 'polite');
      expect(live).toHaveTextContent('ABCD-1234-EFGH');
    });

    it('copies the code to the clipboard and confirms it', async () => {
      const writeText = jest.fn(async () => undefined);
      await issueCode({ writeText });

      fireEvent.click(screen.getByRole('button', { name: 'Copy code' }));

      await waitFor(() => expect(writeText).toHaveBeenCalledWith('ABCD-1234-EFGH'));
      expect(await screen.findByRole('button', { name: '✓ Copied' })).toBeInTheDocument();
    });

    it('says so when the copy fails instead of claiming success', async () => {
      // navigator.clipboard is undefined outside a secure context and
      // writeText rejects when the document is unfocused or permission is
      // refused. Reporting success there would send the admin away believing
      // they hold a code that cannot be recovered.
      const writeText = jest.fn(async () => {
        throw new Error('NotAllowedError');
      });
      await issueCode({ writeText });

      fireEvent.click(screen.getByRole('button', { name: 'Copy code' }));

      expect(
        await screen.findByRole('button', { name: 'Copy failed — select it by hand' }),
      ).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: '✓ Copied' })).not.toBeInTheDocument();
    });

    it('does not carry the previous code’s confirmation onto a new one', async () => {
      const writeText = jest.fn(async () => undefined);
      await issueCode({ writeText });

      fireEvent.click(screen.getByRole('button', { name: 'Copy code' }));
      await screen.findByRole('button', { name: '✓ Copied' });

      fireEvent.change(screen.getByLabelText('Athlete Account ID'), { target: { value: 'ath-002' } });
      fireEvent.click(screen.getByRole('button', { name: 'Issue Activation Code' }));
      await screen.findByText('WXYZ-9876-MNOP');

      // A stale "✓ Copied" over a code the admin has never seen is worse than
      // no affordance: it is an affirmative claim that they hold it.
      expect(await screen.findByRole('button', { name: 'Copy code' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: '✓ Copied' })).not.toBeInTheDocument();
    });
  });
});
