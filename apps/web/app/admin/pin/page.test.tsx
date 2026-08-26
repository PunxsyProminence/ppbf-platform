/**
 * @jest-environment jsdom
 */

/**
 * THE DESK THAT LOCKED ATHLETES OUT.
 *
 * This page had no test at all, and the defect it shipped is exactly the kind
 * a test would have caught in one line: it POSTed `{account_id, pin, mode}` to
 * /api/pilot/admin/accounts/pin-reset and never read the response.
 *
 * The shared-PIN retirement had rewritten that route to read ONLY account_id
 * and answer with a one-time activation code. So every click discarded the
 * administrator's typed PIN, DEACTIVATED the athlete and revoked their
 * sessions, minted a code, threw it away, and reported "PIN activated. Tell
 * the athlete this PIN." The athlete could not sign in, the administrator did
 * not know, and the only credential that could have fixed it was gone.
 *
 * Two properties are pinned below, and they are the two halves of that bug:
 * what leaves the browser, and what comes back onto the screen.
 */

import type { ReactNode } from 'react';
import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import PinManagementPage from './page';
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

const ATHLETE = {
  athlete_id: 'ath-1',
  full_name: 'Rosa Delgado',
  account_id: 'acct-rosa',
  account_active: true,
  has_pin: true,
  account_updated_at: null,
};

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body } as Response;
}

/** Directory load, then whatever the issue call should answer with. */
function installFetch(issueBody: unknown, issueOk = true) {
  // `init` is declared even though only the body is read: without it the mock's
  // call tuple types as length 1 and `call[1]` does not compile. jest does not
  // typecheck, so this only shows up under `npm run typecheck`.
  const fetchMock = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    void init;
    const url = String(input);
    if (url.includes('/api/pilot/admin/accounts/pin-reset')) {
      return jsonResponse(issueBody, issueOk, issueOk ? 200 : 500);
    }
    return jsonResponse({ ok: true, items: [ATHLETE] });
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

/* By role, not by text: the athlete's name now appears twice on this screen --
   once in the list and once in the line naming who the code is for. */
async function selectAthleteAndIssue() {
  const row = await screen.findByRole('button', { name: /Rosa Delgado/ });
  fireEvent.click(row);
  fireEvent.click(screen.getByRole('button', { name: /Issue Activation Code/i }));
}

beforeEach(() => {
  mockGetRoleSessionSnapshot.mockReturnValue({ role: 'admin', expiresAt: Date.now() + 100000 });
});

afterEach(() => {
  global.fetch = originalFetch;
  jest.clearAllMocks();
});

describe('the athlete credential desk', () => {
  /* WHAT LEAVES THE BROWSER. The route ignores `pin` and `mode`, so sending
     them is not merely useless -- it is the shape that let this page believe,
     and tell an administrator, that a PIN had been set. */
  it('sends the account id alone, never a PIN or a mode', async () => {
    const fetchMock = installFetch({ ok: true, activation_code: 'ABCD-1234-EFGH', expires_at: null });
    render(<PinManagementPage />);
    await selectAthleteAndIssue();

    await waitFor(() => {
      const call = fetchMock.mock.calls.find((c) => String(c[0]).includes('pin-reset'));
      expect(call).toBeDefined();
      const body = JSON.parse((call?.[1] as RequestInit).body as string);
      expect(body).toEqual({ account_id: 'acct-rosa' });
    });
  });

  /* WHAT COMES BACK. The code is the only way into an account this request
     just deactivated. Dropping it is the lockout. */
  it('shows the one-time code it was handed', async () => {
    installFetch({ ok: true, activation_code: 'ABCD-1234-EFGH', expires_at: '2026-08-27T00:00:00Z' });
    render(<PinManagementPage />);
    await selectAthleteAndIssue();

    await waitFor(() => expect(screen.getByText('ABCD-1234-EFGH')).toBeInTheDocument());
    // Announced, because it appears with no navigation and a screen-reader
    // administrator would otherwise never learn it is on screen.
    expect(screen.getByRole('status')).toHaveTextContent('ABCD-1234-EFGH');
  });

  /* A 200 WITH NO CODE IS A LOCKOUT, NOT A SUCCESS. The account is already
     deactivated by the time this response arrives, so reporting success would
     send the administrator away believing the athlete can still sign in. */
  it('refuses to report success when no code came back', async () => {
    installFetch({ ok: true });
    render(<PinManagementPage />);
    await selectAthleteAndIssue();

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/cannot sign in/i);
    });
    expect(screen.queryByRole('status')).toBeNull();
  });

  /* The retired model must not come back by copy either: this page told
     administrators to read a PIN out loud, which is the sentence the whole
     shared-PIN retirement exists to delete. */
  it('never tells an administrator to hand a PIN to an athlete', async () => {
    installFetch({ ok: true, activation_code: 'ABCD-1234-EFGH', expires_at: null });
    render(<PinManagementPage />);
    await screen.findByRole('button', { name: /Rosa Delgado/ });

    expect(screen.queryByText(/Tell the athlete this PIN/i)).toBeNull();
    expect(screen.queryByLabelText(/Enter PIN/i)).toBeNull();
    expect(screen.queryByLabelText(/Confirm PIN/i)).toBeNull();
  });
});
