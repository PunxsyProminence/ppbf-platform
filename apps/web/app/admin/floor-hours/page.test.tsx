/**
 * @jest-environment jsdom
 */

/**
 * The correction desk for the floor-hours ledger.
 *
 * GET and POST /api/pilot/admin/floor-hours have existed since the ledger
 * shipped and nothing called either. That mattered more than a usual missing
 * door: the numbers this corrects are already PUBLISHED — hours accumulate
 * from live application code, and /api/pilot/floor-hours/public exposes the
 * organization totals on an unauthenticated endpoint. An operator who spotted
 * a wrong figure there had nowhere to go.
 *
 * These cases are about the ways a correction desk lies. It can net a
 * recorded figure and a correction into one number, which is how a gym's
 * record stops being auditable. It can compute the effective minutes itself
 * and drift from the view the public page publishes. It can hide half of
 * somebody's sessions behind a silent cap. Or it can report a correction that
 * was refused.
 */

import type { ReactNode } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

import AdminFloorHoursPage from './page';

jest.mock('@/components/RoleStandaloneView', () => ({
  __esModule: true,
  default: ({ children }: { readonly children: ReactNode }) => children,
}));

const originalFetch = global.fetch;

function totalsRow(overrides: Record<string, unknown> = {}) {
  return {
    person_account_id: 'coach-1',
    athlete_id: null,
    activity_domain: 'boxing',
    period_year: 2026,
    period_quarter: 3,
    hours: '5.5',
    recorded_minutes: '360',
    adjustment_minutes: '-30',
    sessions_recorded: '6',
    first_recorded: '2026-07-01',
    last_recorded: '2026-08-01',
    ...overrides,
  };
}

function activityRow(overrides: Record<string, unknown> = {}) {
  return {
    activity_id: 'act-1',
    person_account_id: 'coach-1',
    activity_domain: 'boxing',
    activity_type: 'session',
    occurred_on: '2026-08-01',
    recorded_minutes: 90,
    adjustment_minutes: 0,
    effective_minutes: 90,
    ...overrides,
  };
}

interface Routes {
  totals?: () => { ok: boolean; body: unknown };
  person?: () => { ok: boolean; body: unknown };
  post?: (body: Record<string, unknown>) => { ok: boolean; status?: number; body: unknown };
}

function installFetch(routes: Routes = {}): jest.Mock {
  const mock = jest.fn(async (url: string, init?: RequestInit) => {
    if (!String(url).includes('/api/pilot/admin/floor-hours')) {
      throw new Error(`Unexpected fetch: ${url}`);
    }
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body ?? '{}')) as Record<string, unknown>;
      const outcome = routes.post?.(body) ?? {
        ok: true,
        body: {
          adjustment: {
            adjustment_id: 'adj-1',
            activity_id: body.activity_id,
            delta_minutes: body.delta_minutes,
            reason: body.reason,
            adjusted_by_account_id: 'admin-1',
            adjusted_by_role: 'organization_admin',
            adjusted_at: '2026-08-28T23:00:00.000Z',
          },
        },
      };
      return {
        ok: outcome.ok,
        status: outcome.status ?? (outcome.ok ? 201 : 400),
        json: async () => outcome.body,
      } as Response;
    }
    if (String(url).includes('person_account_id=')) {
      const outcome = routes.person?.() ?? {
        ok: true,
        body: {
          floor_hours: [totalsRow()],
          activities: { rows: [activityRow()], total: 1, limit: 200 },
          adjustments: [],
        },
      };
      return { ok: outcome.ok, status: outcome.ok ? 200 : 500, json: async () => outcome.body } as Response;
    }
    const outcome = routes.totals?.() ?? {
      ok: true,
      body: { floor_hours: [totalsRow()], activities: null, adjustments: null },
    };
    return { ok: outcome.ok, status: outcome.ok ? 200 : 500, json: async () => outcome.body } as Response;
  });
  global.fetch = mock as never;
  return mock;
}

async function renderPage(routes: Routes = {}): Promise<jest.Mock> {
  const mock = installFetch(routes);
  await act(async () => {
    render(<AdminFloorHoursPage />);
  });
  return mock;
}

async function openSessions(): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /Open the sessions behind/ }));
  });
}

async function openCorrection(): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /Correct the session on/ }));
  });
}

afterEach(() => {
  global.fetch = originalFetch;
  jest.restoreAllMocks();
});

describe('an unreadable ledger is never shown as an empty one', () => {
  it('says the read failed rather than "no recorded hours"', async () => {
    await renderPage({ totals: () => ({ ok: false, body: {} }) });

    expect(screen.getByText(/could not be read/)).not.toBeNull();
    expect(screen.queryByText(/No hours are recorded/)).toBeNull();
  });

  it('says the gym is empty only when it actually read an empty ledger', async () => {
    await renderPage({ totals: () => ({ ok: true, body: { floor_hours: [] } }) });

    expect(screen.getByText('No hours are recorded for this gym yet.')).not.toBeNull();
    expect(screen.queryByText(/could not be read/)).toBeNull();
  });
});

describe('recorded and corrected are shown apart, never netted', () => {
  it('shows both figures on the totals row', async () => {
    // THE CASE THIS FILE EXISTS FOR. "5.5 hours" and "360 minutes recorded,
    // 30 corrected away" are different facts about a gym's record, and only
    // one of them survives being collapsed into a single number.
    await renderPage();

    expect(screen.getByText('360 min')).not.toBeNull();
    expect(screen.getByText('-30 min')).not.toBeNull();
    expect(screen.getByText('5.5')).not.toBeNull();
  });

  it('shows a corrected session as recorded, corrected and counted', async () => {
    await renderPage({
      person: () => ({
        ok: true,
        body: {
          floor_hours: [totalsRow()],
          activities: {
            rows: [activityRow({ recorded_minutes: 90, adjustment_minutes: -30, effective_minutes: 60 })],
            total: 1,
            limit: 200,
          },
          adjustments: [],
        },
      }),
    });
    await openSessions();

    const line = await screen.findByText(/90 min recorded/);
    expect(line.textContent).toContain('-30 corrected');
    expect(line.textContent).toContain('60 min counted');
  });
});

describe('the cap is stated', () => {
  it('says how many sessions are not listed and cannot be corrected here', async () => {
    // Silently showing the newest 200 of 400 would hide the older half, which
    // is exactly where a stale mistake sits.
    await renderPage({
      person: () => ({
        ok: true,
        body: {
          floor_hours: [totalsRow()],
          activities: { rows: [activityRow()], total: 400, limit: 200 },
          adjustments: [],
        },
      }),
    });
    await openSessions();

    const notice = await screen.findByText(/Showing the most recent 1 of 400 sessions/);
    expect(notice.textContent).toContain('cannot be corrected from this screen');
  });

  it('says nothing about a cap when everything is listed', async () => {
    await renderPage();
    await openSessions();

    await screen.findByText(/90 min recorded/);
    expect(screen.queryByText(/Showing the most recent/)).toBeNull();
  });
});

describe('filing a correction', () => {
  it('refuses a zero delta before sending anything', async () => {
    const mock = await renderPage();
    await openSessions();
    await openCorrection();

    fireEvent.change(screen.getByLabelText('Minutes to add or subtract'), { target: { value: '0' } });
    fireEvent.change(screen.getByLabelText('Why this correction is being made'), {
      target: { value: 'Timer was left running after the session' },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'File the correction' }));
    });

    expect(screen.getByText(/not zero/)).not.toBeNull();
    expect(mock.mock.calls.filter(([, init]) => (init as RequestInit)?.method === 'POST')).toHaveLength(0);
  });

  it('refuses a reason under ten characters, and says why that rule exists', async () => {
    // pilot_activity_adj_reason enforces it too. Both refusals exist: the
    // server's arrives after a round trip, this one while the operator is
    // still looking at the box.
    const mock = await renderPage();
    await openSessions();
    await openCorrection();

    fireEvent.change(screen.getByLabelText('Minutes to add or subtract'), { target: { value: '-30' } });
    fireEvent.change(screen.getByLabelText('Why this correction is being made'), { target: { value: 'typo' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'File the correction' }));
    });

    expect(screen.getByText(/cannot be told apart from tampering/)).not.toBeNull();
    expect(mock.mock.calls.filter(([, init]) => (init as RequestInit)?.method === 'POST')).toHaveLength(0);
  });

  it('sends the activity id, the delta and the reason', async () => {
    const mock = await renderPage();
    await openSessions();
    await openCorrection();

    fireEvent.change(screen.getByLabelText('Minutes to add or subtract'), { target: { value: '-30' } });
    fireEvent.change(screen.getByLabelText('Why this correction is being made'), {
      target: { value: 'Timer was left running after the session' },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'File the correction' }));
    });

    const posted = mock.mock.calls.find(([, init]) => (init as RequestInit)?.method === 'POST');
    expect(JSON.parse(String((posted?.[1] as RequestInit).body))).toEqual({
      activity_id: 'act-1',
      delta_minutes: -30,
      reason: 'Timer was left running after the session',
    });
  });

  it('says the original entry is unchanged', async () => {
    // The ledger is append-only. An operator who thought this edited the
    // session would file a second correction to "undo" the first.
    await renderPage();
    await openSessions();
    await openCorrection();

    fireEvent.change(screen.getByLabelText('Minutes to add or subtract'), { target: { value: '-30' } });
    fireEvent.change(screen.getByLabelText('Why this correction is being made'), {
      target: { value: 'Timer was left running after the session' },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'File the correction' }));
    });

    const notice = await screen.findByRole('status');
    expect(notice.textContent).toContain('The original entry is unchanged');
  });

  it('re-reads instead of doing the arithmetic itself', async () => {
    // The effective minutes are computed by the view from the recorded row
    // plus every adjustment. A screen that added the delta locally would be a
    // second definition of the figure the public clock publishes.
    const mock = await renderPage();
    await openSessions();
    await openCorrection();

    const before = mock.mock.calls.filter(([, init]) => (init as RequestInit)?.method !== 'POST').length;

    fireEvent.change(screen.getByLabelText('Minutes to add or subtract'), { target: { value: '-30' } });
    fireEvent.change(screen.getByLabelText('Why this correction is being made'), {
      target: { value: 'Timer was left running after the session' },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'File the correction' }));
    });

    await waitFor(() => {
      const after = mock.mock.calls.filter(([, init]) => (init as RequestInit)?.method !== 'POST').length;
      // Both the person's sessions and the totals are re-read.
      expect(after).toBeGreaterThanOrEqual(before + 2);
    });
  });

  it('shows the corrections already filed against a session', async () => {
    // Filing a second correction for a mistake a colleague fixed an hour ago
    // is the obvious way an append-only ledger goes wrong.
    await renderPage({
      person: () => ({
        ok: true,
        body: {
          floor_hours: [totalsRow()],
          activities: { rows: [activityRow()], total: 1, limit: 200 },
          adjustments: [{
            adjustment_id: 'adj-0',
            activity_id: 'act-1',
            delta_minutes: -15,
            reason: 'Session ended early, timer kept running',
            adjusted_by_account_id: 'admin-2',
            adjusted_by_role: 'organization_admin',
            adjusted_at: '2026-08-27T10:00:00.000Z',
          }],
        },
      }),
    });
    await openSessions();
    await openCorrection();

    expect(await screen.findByText(/Session ended early, timer kept running/)).not.toBeNull();
    expect(screen.getByText(/admin-2/)).not.toBeNull();
  });
});

describe('a correction that did not happen', () => {
  it('surfaces the refusal and claims nothing', async () => {
    await renderPage({
      post: () => ({ ok: false, status: 400, body: { error: 'ACTIVITY_ADJUSTMENT_REASON_TOO_SHORT' } }),
    });
    await openSessions();
    await openCorrection();

    fireEvent.change(screen.getByLabelText('Minutes to add or subtract'), { target: { value: '-30' } });
    fireEvent.change(screen.getByLabelText('Why this correction is being made'), {
      target: { value: 'Timer was left running after the session' },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'File the correction' }));
    });

    expect(await screen.findByText('ACTIVITY_ADJUSTMENT_REASON_TOO_SHORT')).not.toBeNull();
    expect(screen.queryByText(/Correction recorded/)).toBeNull();
  });

  it('says nothing was recorded when the request never landed', async () => {
    await renderPage({
      post: () => {
        throw new Error('offline');
      },
    });
    await openSessions();
    await openCorrection();

    fireEvent.change(screen.getByLabelText('Minutes to add or subtract'), { target: { value: '-30' } });
    fireEvent.change(screen.getByLabelText('Why this correction is being made'), {
      target: { value: 'Timer was left running after the session' },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'File the correction' }));
    });

    expect(await screen.findByText(/nothing was recorded/)).not.toBeNull();
  });
});
