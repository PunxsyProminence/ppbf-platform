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

// Enough of OrgMetrics for the SHADOW Intelligence panel to render its
// readings; the panel binds to the interface by import, so a shape change is a
// compile error rather than a NaN tile.
const growthMetrics = {
  period: 'Last 30 days',
  effectiveness: {
    unavailableReasons: {},
    avgRecommendationScore: 72,
    libraryUtilization: null,
    topicsWithGoodCoverage: [],
    concernedTopics: [],
  },
  engagement: {
    unavailableReasons: {},
    dailyActiveUsers: 4,
    avgMessagesPerSession: null,
    feedbackRate: null,
    usersByTier: { bronze: 1, silver: 0, gold: 0 },
    newUsersThisPeriod: 0,
  },
  safety: {
    unavailableReasons: {},
    highRiskFlagCount: 0,
    escalationsToHuman: 0,
    flaggedTopicsNeedingReview: [],
  },
  growth: {
    unavailableReasons: {},
    avgComplexityProgression: null,
    profileCompletionRate: null,
    tierAdvancementCount: null,
    totalInteractions: 88,
    positiveOutcomeRate: null,
    filterRate: 0.125,
    avgSatisfaction: null,
    reviewedOutcomes: 3,
    researchRequirementsCreated: 2,
    researchRequirementsClosed: 1,
    newLibraryPatterns: 0,
  },
  viewerUnlocks: {
    strongPersonalization: false,
    autoLibraryUpdates: false,
    aggressiveResearchGeneration: false,
    fineTuningPipelineReady: false,
  },
};

const feedbackSummary = {
  total_responses: 12,
  helpful_count: 9,
  satisfaction_rate: 0.75,
  avg_rating: null,
};

function consoleFetchMock({ withMetrics = false } = {}) {
  return jest.fn(async (url: string) => {
    const target = String(url);
    if (target.includes('/shadow/review-projection')) {
      return jsonResponse({ ok: true, queue: [queueEntry] });
    }
    if (target.includes('/shadow/metrics')) {
      return jsonResponse({ ok: true, metrics: withMetrics ? growthMetrics : null });
    }
    if (target.includes('/shadow/feedback')) {
      return jsonResponse({
        ok: true,
        summary: withMetrics ? feedbackSummary : null,
        items: [feedbackItem],
      });
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

async function renderConsole(role: PilotSessionState['role'], options?: { withMetrics: boolean }) {
  const fetchMock = consoleFetchMock(options);
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

// ── After Hours room DNA ────────────────────────────────────────────────────

it('reads its rates off the room instrument and its counts off .stat', async () => {
  await renderConsole('organization_admin', { withMetrics: true });

  await waitFor(() => expect(document.querySelectorAll('.gauge-bezel').length).toBeGreaterThan(0));

  const captions = [...document.querySelectorAll('.gauge-cap')].map((node) => node.textContent);
  expect(captions).toContain('Filter Rate');
  expect(captions).toContain('Satisfaction');

  const values = [...document.querySelectorAll('.gauge-val')].map((node) => node.textContent);
  expect(values).toContain('12.5%');
  expect(values).toContain('75.0%');

  // Law 2: the red band is only for a reading with a genuine danger threshold,
  // and nothing server-side defines one for these rates.
  expect(document.querySelector('.gauge-arc')).toBeNull();

  // Counts are figures, not dials.
  const statLabels = [...document.querySelectorAll('.stat-label')].map((node) => node.textContent);
  expect(statLabels).toContain('Interactions');
  expect(statLabels).toContain('Research Created');
  expect(document.querySelectorAll('.stat-val').length).toBeGreaterThan(0);
});

it('wears the slate instrument panel, not the Front Office rivets', async () => {
  await renderConsole('organization_admin');

  expect(await screen.findByText('SHADOW Data Intake + Command Console')).toBeTruthy();
  expect(document.querySelector('.rivet')).toBeNull();
  expect(document.querySelector('.frame')).toBeNull();
  expect(document.querySelectorAll('.mat-slate').length).toBeGreaterThan(0);
});
