/**
 * @jest-environment jsdom
 */

// Every intake write on this console (upload, case review-action, document
// review, feedback promotion) is refused for a platform owner by the route
// behind it, so the controls must not offer the action.

import type { ReactNode } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import AdminShadowConsolePage from './page';
import { usePilotSession, type PilotSessionState } from '@/components/usePilotSession';

jest.mock('@/components/RoleStandaloneView', () => ({
  __esModule: true,
  default: ({ children }: { readonly children: ReactNode }) => children,
}));

jest.mock('@/components/usePilotSession', () => ({
  ...jest.requireActual('@/components/usePilotSession'),
  usePilotSession: jest.fn(),
}));

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ children, href }: { readonly children: ReactNode; readonly href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

const mockUsePilotSession = usePilotSession as jest.Mock;

const originalFetch = global.fetch;

beforeAll(() => {
  window.HTMLElement.prototype.scrollIntoView = jest.fn();
});

function session(role: PilotSessionState['role']): PilotSessionState {
  return {
    role,
    organizationId: 'org-1',
    authProvider: 'microsoft',
    accountId: 'someone@punxsyprominence.org',
    mustChangePin: false,
    loading: false,
  };
}

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body } as Response;
}

const queueEntry = {
  intake_case_id: 'case-1',
  status: 'pending_review' as const,
  summary: 'Board packet intake',
  primary_athlete_id: null,
  created_at: '2026-07-30T12:00:00.000Z',
  updated_at: '2026-07-30T12:00:00.000Z',
  document_count: 1,
};

const feedbackItem = {
  feedback_id: 42,
  account_id: 'athlete-1',
  role: 'athlete',
  helpful: false,
  rating: 2,
  comment: 'Missed the point',
  outcome_signal: 'negative',
  correlation_type: 'shadow_message',
  correlation_id: 'msg-1',
  verification_state: 'durable_client' as const,
  human_review_required: true,
  created_at: '2026-07-30T12:00:00.000Z',
};

function consoleFetchMock() {
  return jest.fn(async (url: string) => {
    const target = String(url);
    if (target.includes('/shadow/review-projection')) {
      return jsonResponse({ ok: true, queue: [queueEntry] });
    }
    if (target.includes('/shadow/feedback')) {
      return jsonResponse({ ok: true, summary: null, items: [feedbackItem] });
    }
    if (target.includes('/shadow/telemetry')) {
      return jsonResponse({ ok: true, telemetry: [] });
    }
    if (target.includes('/shadow/authority')) {
      return jsonResponse({ ok: true, authority_checks: [] });
    }
    if (target.includes('/shadow/library/review-flags')) {
      return jsonResponse({ ok: true, flags: [] });
    }
    if (target.includes('/shadow/unlocks')) {
      return jsonResponse({ ok: true, thresholds: [], state: { features: {} } });
    }
    return jsonResponse({ ok: true, metrics: null });
  });
}

afterEach(() => {
  global.fetch = originalFetch;
  jest.clearAllMocks();
});

async function renderConsole(role: PilotSessionState['role']) {
  const fetchMock = consoleFetchMock();
  mockUsePilotSession.mockReturnValue(session(role));
  global.fetch = fetchMock as unknown as typeof fetch;
  render(<AdminShadowConsolePage />);
  await screen.findByText(/Board packet intake/);
  return fetchMock;
}

it('offers no intake write control to a platform owner', async () => {
  await renderConsole('platform_owner');

  expect(screen.queryByRole('button', { name: /upload pdf/i })).toBeNull();
  expect(screen.getAllByText(/read-only in a platform-owner session/i).length).toBeGreaterThan(0);

  expect((screen.getByRole('button', { name: 'VIEW' }) as HTMLButtonElement).disabled).toBe(false);
  for (const action of ['APPROVE', 'REJECT', 'IMPORT']) {
    expect((screen.getByRole('button', { name: action }) as HTMLButtonElement).disabled).toBe(true);
  }

  expect((screen.getByRole('button', { name: /approve for learning/i }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.queryByRole('button', { name: /document security review/i })).toBeNull();
});

it('leaves the intake write controls to a gym admin', async () => {
  await renderConsole('organization_admin');

  await waitFor(() => expect(screen.getByRole('button', { name: /upload pdf/i })).toBeTruthy());
  expect(screen.queryByText(/read-only in a platform-owner session/i)).toBeNull();
  expect((screen.getByRole('button', { name: 'APPROVE' }) as HTMLButtonElement).disabled).toBe(false);
  expect((screen.getByRole('button', { name: /approve for learning/i }) as HTMLButtonElement).disabled).toBe(false);
  expect(screen.getByRole('button', { name: /document security review/i })).toBeTruthy();
});

it('records the refusal instead of calling the review route for a platform owner', async () => {
  const fetchMock = await renderConsole('platform_owner');

  fireEvent.click(screen.getByRole('button', { name: 'VIEW' }));
  fireEvent.keyDown(window, { key: 'a' });

  await screen.findByText(/STATUS: Blocked/);
  expect(
    fetchMock.mock.calls.some(([url]) => String(url).includes('/intake/review-action')),
  ).toBe(false);
});
