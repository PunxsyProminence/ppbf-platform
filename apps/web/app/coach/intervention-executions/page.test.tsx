/**
 * @jest-environment jsdom
 */

// The Work (execution ledger) page. What these pin: planned and actual
// exposure render side by side with the gap visible (an under-delivered
// execution shows both numbers and its adherence state, never a smoothed
// summary); closing out posts an explicit adherence STATE and structured
// actual exposure -- the page offers no percentage and no difficulty field;
// and the deviations text travels with the close.

import { act, fireEvent, render, screen } from '@testing-library/react';

import InterventionExecutionsPage from './page';

jest.mock('@/components/RoleSessionGate', () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

const EXECUTION = {
  execution_id: 'ex-1',
  lineage_id: 'ex-1',
  version: 1,
  athlete_id: 'ath-1',
  athlete_name: 'Jordan P.',
  protocol_id: 'p-1',
  protocol_version: 1,
  protocol_title: 'Round-3 endurance block',
  status: 'in_progress',
  planned_exposure: { rounds: 6, sessions: 2 },
  planned_task_context: 'constrained-live',
  actual_exposure: { rounds: 3 },
  trained_context: 'constrained_live',
  adherence: 'under_delivered',
  deviations: 'cut to 3 rounds -- athlete gassed',
  stop_change_reason: '',
  notes: '',
  correction_reason: '',
  created_at: '2026-08-16T00:00:00.000Z',
};

function mockFetch(capture: { patches: unknown[] }) {
  return jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/intervention-executions') && init?.method === 'PATCH') {
      capture.patches.push(JSON.parse(String(init.body)));
      return { ok: true, json: async () => ({ item: {} }) } as Response;
    }
    if (url.includes('/intervention-executions')) {
      return { ok: true, json: async () => ({ items: [EXECUTION] }) } as Response;
    }
    if (url.includes('/intervention-protocols')) {
      return {
        ok: true,
        json: async () => ({ items: [{ protocol_id: 'p-1', title: 'Round-3 endurance block', version: 1, athlete_id: null, status: 'active' }] }),
      } as Response;
    }
    if (url.includes('/athletes/list')) {
      return { ok: true, json: async () => ({ items: [{ athlete_id: 'ath-1', full_name: 'Jordan P.' }] }) } as Response;
    }
    return { ok: true, json: async () => ({ items: [] }) } as Response;
  }) as unknown as typeof fetch;
}

afterEach(() => {
  jest.restoreAllMocks();
});

test('planned and actual render side by side with the gap and adherence visible, never smoothed', async () => {
  global.fetch = mockFetch({ patches: [] });

  await act(async () => {
    render(<InterventionExecutionsPage />);
  });

  expect(await screen.findByText(/Planned:/)).toBeTruthy();
  expect(screen.getByText(/rounds: 6 · sessions: 2/)).toBeTruthy();
  expect(screen.getByText(/^Actual:/)).toBeTruthy();
  expect(screen.getByText(/rounds: 3$/)).toBeTruthy();
  expect(screen.getByText('under delivered')).toBeTruthy();
  expect(screen.getByText(/cut to 3 rounds -- athlete gassed/)).toBeTruthy();
});

test('closing out posts an explicit adherence state and structured actual exposure -- no percentage, no dose', async () => {
  const capture = { patches: [] as unknown[] };
  global.fetch = mockFetch(capture);

  await act(async () => {
    render(<InterventionExecutionsPage />);
  });
  await act(async () => {
    fireEvent.click(await screen.findByRole('button', { name: 'Close out' }));
  });
  await act(async () => {
    fireEvent.change(screen.getByLabelText('Adherence'), { target: { value: 'delivered_with_deviations' } });
    fireEvent.change(screen.getByLabelText('Deviations (required if you claimed any)'), {
      target: { value: 'swapped bag work for pads' },
    });
    fireEvent.change(screen.getByLabelText('Rounds'), { target: { value: '5' } });
  });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Record close-out' }));
  });

  expect(capture.patches).toHaveLength(1);
  const posted = capture.patches[0] as Record<string, unknown>;
  expect(posted).toMatchObject({
    action: 'close',
    execution_id: 'ex-1',
    outcome: 'completed',
    adherence: 'delivered_with_deviations',
    deviations: 'swapped bag work for pads',
    actual_exposure: { rounds: 5 },
  });
  expect(posted).not.toHaveProperty('adherence_percent');
  expect(posted.actual_exposure).not.toHaveProperty('difficulty');
});

test('an execution links to the session run it was logged against, and one with no link shows no such claim', async () => {
  const capture = { patches: [] as unknown[] };
  global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/intervention-executions') && init?.method === 'PATCH') {
      capture.patches.push(JSON.parse(String(init.body)));
      return { ok: true, json: async () => ({ item: {} }) } as Response;
    }
    if (url.includes('/intervention-executions')) {
      return {
        ok: true,
        json: async () => ({
          items: [
            { ...EXECUTION, execution_id: 'ex-linked', session_run_id: 'ssrun_1' },
            { ...EXECUTION, execution_id: 'ex-unlinked', session_run_id: null },
          ],
        }),
      } as Response;
    }
    return { ok: true, json: async () => ({ items: [] }) } as Response;
  }) as unknown as typeof fetch;

  await act(async () => {
    render(<InterventionExecutionsPage />);
  });

  expect(await screen.findAllByText('Logged during a live session')).toHaveLength(1);
});

test('a non-positive actual exposure never leaves the page', async () => {
  const capture = { patches: [] as unknown[] };
  global.fetch = mockFetch(capture);

  await act(async () => {
    render(<InterventionExecutionsPage />);
  });
  await act(async () => {
    fireEvent.click(await screen.findByRole('button', { name: 'Close out' }));
  });
  await act(async () => {
    fireEvent.change(screen.getByLabelText('Rounds'), { target: { value: '-3' } });
  });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Record close-out' }));
  });

  expect(capture.patches).toHaveLength(0);
  expect(screen.getByText(/rounds must be a positive number/)).toBeTruthy();
});
