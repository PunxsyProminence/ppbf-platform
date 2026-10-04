/**
 * @jest-environment jsdom
 */

/**
 * The drill-exposure panel, and the ways it could mis-say the read:
 *   - a failed read shown as an empty record;
 *   - "not recorded" reps or unset planned minutes shown as zero;
 *   - planned minutes shown without saying they are planned;
 *   - leaving out that group class sessions are not counted.
 */

import { act, fireEvent, render, screen, within } from '@testing-library/react';

import AthleteDrillExposurePanel from './AthleteDrillExposurePanel';

function bucket(overrides: Record<string, unknown> = {}) {
  return {
    key: 'none', label: 'No contact', sessions: 2, reps: 30, sessionsWithReps: 1,
    plannedMinutes: 40, sessionsWithPlannedMinutes: 2, ...overrides,
  };
}

function payload(overrides: Record<string, unknown> = {}) {
  return {
    athleteId: 'ath-1',
    window: { from: '2026-09-06', to: '2026-10-03' },
    drillSessions: {
      total: bucket({ key: 'total', label: 'All drill sessions', sessions: 3, sessionsWithPlannedMinutes: 2 }),
      byContactLevel: [
        bucket(),
        bucket({ key: 'controlled_sparring', label: 'Controlled sparring', sessions: 1, reps: 0,
          sessionsWithReps: 0, plannedMinutes: 0, sessionsWithPlannedMinutes: 0 }),
      ],
      bySkillFamily: [bucket({ key: 'SKILL-01', label: 'SKILL-01 Stance / Guard / Reset' })],
      pendingVerification: 1,
      disputedExcluded: 2,
    },
    rounds: {
      total: 7, attempts: 2,
      byContext: [{ contextType: 'open_sparring', rounds: 3, attempts: 1 },
        { contextType: 'technical_sparring', rounds: 4, attempts: 1 }],
      disputedExcluded: 1,
    },
    groupSessionsCounted: false,
    ...overrides,
  };
}

function installFetch(body: unknown, ok = true) {
  const fetchMock = jest.fn(async () => ({ ok, status: ok ? 200 : 403, json: async () => body }));
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

async function renderPanel() {
  await act(async () => {
    render(<AthleteDrillExposurePanel athleteId="ath-1" />);
  });
}

afterEach(() => {
  jest.restoreAllMocks();
});

it('asks for the athlete with no window first, then shows the window the server used', async () => {
  const fetchMock = installFetch(payload());
  await renderPanel();

  expect(String((fetchMock.mock.calls[0] as unknown[])[0]))
    .toContain('/api/pilot/coach/athlete-drill-exposure?athlete_id=ath-1');
  expect(String((fetchMock.mock.calls[0] as unknown[])[0])).not.toContain('from=');
  expect((screen.getByLabelText('From') as HTMLInputElement).value).toBe('2026-09-06');
  expect((screen.getByLabelText('To') as HTMLInputElement).value).toBe('2026-10-03');
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it('re-reads with the window the coach picks', async () => {
  const fetchMock = installFetch(payload());
  await renderPanel();
  await act(async () => {
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-09-01' } });
  });

  const last = String((fetchMock.mock.calls.at(-1) as unknown[])[0]);
  expect(last).toContain('from=2026-09-01');
  expect(last).toContain('to=2026-10-03');
});

it('renders totals by contact level with unrecorded values said, not zeroed', async () => {
  installFetch(payload());
  await renderPanel();

  const table = screen.getByRole('table', { name: 'By contact level' });
  const spar = within(table).getByRole('row', { name: /Controlled sparring/ });
  expect(spar.textContent).toContain('not recorded');
  expect(spar.textContent).toContain('not set');
  const none = within(table).getByRole('row', { name: /No contact/ });
  expect(none.textContent).toContain('30 (1 of 2 sessions)');
  expect(within(table).getByRole('columnheader', { name: 'Planned minutes' })).toBeTruthy();
  expect(within(table).getByRole('row', { name: /All drill sessions/ })).toBeTruthy();
  expect(screen.getByRole('table', { name: 'By skill family' }).textContent)
    .toContain('SKILL-01 Stance / Guard / Reset');
});

it('says what is pending, what is excluded, the rounds, and that group sessions are not counted', async () => {
  installFetch(payload());
  await renderPanel();

  expect(screen.getByText(/1 counted session\(s\) are not yet verified/)).toBeTruthy();
  expect(screen.getByText(/2 disputed session\(s\) are left out/)).toBeTruthy();
  expect(screen.getByTestId('rounds').textContent).toContain('Open sparring: 3 rounds');
  expect(screen.getByTestId('rounds').textContent).toContain('Total: 7 rounds');
  expect(screen.getByTestId('rounds-disputed').textContent).toContain('1 disputed round entry is');
  expect(screen.getByTestId('group-sessions-note').textContent).toContain('not included');
});

it('says an empty window is empty', async () => {
  installFetch(payload({
    drillSessions: { ...payload().drillSessions, total: bucket({ sessions: 0 }), byContactLevel: [],
      bySkillFamily: [], pendingVerification: 0, disputedExcluded: 0 },
    rounds: { total: 0, attempts: 0, byContext: [], disputedExcluded: 3 },
  }));
  await renderPanel();

  expect(screen.getByTestId('no-drill-sessions')).toBeTruthy();
  expect(screen.getByText('No rounds counted in this window.')).toBeTruthy();
  // A window whose only rounds were disputed must not read as a window with no rounds at all.
  expect(screen.getByTestId('rounds-disputed').textContent).toContain('3 disputed round entries are');
});

it('clears an old error as soon as the coach changes the window', async () => {
  installFetch({ error: 'from must be on or before to.' }, false);
  await renderPanel();
  expect(screen.getByRole('alert')).toBeTruthy();

  installFetch(payload());
  await act(async () => {
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-09-01' } });
  });
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.getByRole('table', { name: 'By contact level' })).toBeTruthy();
});

it('shows a failed read as a failure, never as an empty record', async () => {
  installFetch({ error: 'Forbidden' }, false);
  await renderPanel();

  expect(screen.getByRole('alert').textContent).toContain('Forbidden');
  expect(screen.queryByTestId('no-drill-sessions')).toBeNull();
  expect(screen.queryByRole('table')).toBeNull();
});
