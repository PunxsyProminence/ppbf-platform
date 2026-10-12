/**
 * @jest-environment jsdom
 */

// READ HONESTY. This page's "The record" drawer links out to /notices. That
// destination is a CAPPED read: app/notices/page.tsx asks for
// NOTICE_READ_LIMIT (25) and announcements.ts clamps the authoring read to 25
// (clampLimit) ordered `created_at desc`, with no pager anywhere on it. The
// destination page was corrected to say "Recently Posted" and to state its own
// 25-row window; this link was left calling the same rows "the full record".
//
// An admin hunting for an old notice clicks a control labelled "the full
// record", reads 25 rows, does not find it, and concludes it was never posted.
// The 26th-newest notice is not reachable from any screen.

import type { ReactNode } from 'react';
import { act, render, screen } from '@testing-library/react';

import CustomizePage from './page';
import { usePilotSession, type PilotSessionState } from '@/components/usePilotSession';

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

jest.mock('@/components/Chalkboard', () => ({
  __esModule: true,
  default: () => <div data-testid="chalkboard" />,
}));

jest.mock('@/components/usePilotSession', () => ({
  ...jest.requireActual('@/components/usePilotSession'),
  usePilotSession: jest.fn(),
}));

const mockUsePilotSession = usePilotSession as jest.Mock;

function session(role: PilotSessionState['role'], loading = false): PilotSessionState {
  return {
    role,
    organizationId: 'org-1',
    authProvider: 'microsoft',
    accountId: 'someone@punxsyprominence.org',
    mustChangePin: false,
    loading,
  };
}

const originalFetch = global.fetch;

beforeEach(() => {
  mockUsePilotSession.mockReturnValue(session('organization_admin'));
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ ok: true, announcements: [] }),
  } as Response) as unknown as typeof fetch;
});

afterEach(() => {
  global.fetch = originalFetch;
  jest.clearAllMocks();
});

// WATCHED TO FAIL: restore the label "Notices — the full record" and the first
// assertion goes red naming the word.
test('the link to the capped notices register never calls it the full record', async () => {
  render(<CustomizePage />);

  const noticesLinks = (await screen.findAllByRole('link')).filter(
    (link) => link.getAttribute('href') === '/notices',
  );

  // Not vacuous: the link this test is about really is on the page.
  expect(noticesLinks.length).toBeGreaterThan(0);

  for (const link of noticesLinks) {
    expect(link.textContent ?? '').not.toMatch(/full record|complete|everything|all notices/i);
  }
});

function gymPhotoCalls(): unknown[][] {
  return (global.fetch as unknown as jest.Mock).mock.calls.filter(([url]) => String(url).includes('/api/pilot/admin/gym-photos'));
}

// The photo route refuses the platform owner (OD-2026-10-08-003): the page
// shows its own notice without first sending a request it knows is refused.
test('a platform owner gets the notice and no gym-photos request', async () => {
  mockUsePilotSession.mockReturnValue(session('platform_owner'));

  render(<CustomizePage />);

  await screen.findByText(/ADMINS ONLY/);
  expect(gymPhotoCalls()).toHaveLength(0);
  expect(screen.getByRole('link', { name: 'Back to the office' }).getAttribute('href')).toBe('/admin/platform');
});

test('nothing is asked while the session is still being read', async () => {
  mockUsePilotSession.mockReturnValue(session(null, true));

  render(<CustomizePage />);
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  expect(gymPhotoCalls()).toHaveLength(0);
  expect(screen.getByText('Opening the customization drawer')).toBeTruthy();
});

test('a gym admin still reads the photos and gets the desk', async () => {
  render(<CustomizePage />);

  await screen.findByRole('heading', { name: /look and voice/i });
  expect(gymPhotoCalls()).toHaveLength(1);
  expect(screen.queryByText(/ADMINS ONLY/)).toBeNull();
});

// Lane N4-02: each board says where it is SHOWN, not who is kept from it. The
// announcements read (api/pilot/announcements/get) carries no role check, so
// "Coaches only" and "never see it" claimed a guarantee the server does not
// make. The gym TV reads 'everywhere' notices (wallDisplayDb.ts loadWallBoard).
test('the boards say where a notice is shown and claim no audience the server does not enforce', async () => {
  render(<CustomizePage />);
  await screen.findByRole('heading', { name: /look and voice/i });

  expect(screen.getByText('Every board at once — athletes, coaches, parents, and the paired gym TV.')).toBeTruthy();
  expect(screen.getByText('Shown on the coaches’ workspace.')).toBeTruthy();
  expect(screen.getByText('Shown on the parent hub, for guardians.')).toBeTruthy();
  expect(screen.queryByText(/Coaches only/)).toBeNull();
  expect(screen.queryByText(/never see it/)).toBeNull();
  expect(screen.queryByText(/Nothing written here reaches a member/)).toBeNull();
});

test('the photographs copy names where the frames really appear', async () => {
  render(<CustomizePage />);
  await screen.findByRole('heading', { name: /look and voice/i });

  // app/page.tsx renders entrance/floor/ring through PhotoSlot with no
  // uploadedSrc, so the front page shows drawings only.
  expect(screen.getByText(/Five of these frames appear on athlete and parent dashboards, where a photograph you upload\s+replaces the drawn placeholder/)).toBeTruthy();
  expect(screen.getByText(/The front page\s+shows only the drawings \(entrance, floor, ring\); an upload does not reach it yet\./)).toBeTruthy();
  expect(screen.queryByText(/Each frame appears on member dashboards/)).toBeNull();
});
