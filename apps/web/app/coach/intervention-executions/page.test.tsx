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

// Lane N3-02: correcting a record. The stand-in below answers the way the
// route does -- a correction supersedes the record and the next GET returns
// the new version -- so what the coach sees next is read off a reload.

type ExecutionFixture = Omit<typeof EXECUTION, 'actual_exposure'> & { actual_exposure: Record<string, number> };

function correctionServer(start: ExecutionFixture, refuse?: { status: number; error?: string }) {
  const patches: Array<Record<string, unknown>> = [];
  let current = start;
  const fetchMock = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/intervention-executions') && init?.method === 'PATCH') {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      patches.push(body);
      if (refuse) {
        return { ok: false, status: refuse.status, json: async () => (refuse.error ? { error: refuse.error } : {}) } as Response;
      }
      current = {
        ...current,
        execution_id: 'ex-2',
        version: current.version + 1,
        status: typeof body.outcome === 'string' ? body.outcome : current.status,
        adherence: String(body.adherence),
        actual_exposure: body.actual_exposure as Record<string, number>,
        correction_reason: String(body.correction_reason),
      };
      return { ok: true, json: async () => ({ item: {} }) } as Response;
    }
    if (url.includes('/intervention-executions')) {
      return { ok: true, json: async () => ({ items: [current] }) } as Response;
    }
    return { ok: true, json: async () => ({ items: [] }) } as Response;
  }) as unknown as typeof fetch;
  return { fetchMock, patches };
}

const CLOSED_EXECUTION: ExecutionFixture = {
  ...EXECUTION,
  status: 'completed',
  adherence: 'delivered_as_planned',
  deviations: '',
  actual_exposure: { rounds: 6 },
  notes: 'worked the output floor',
};

async function openCorrection(server: ReturnType<typeof correctionServer>): Promise<void> {
  global.fetch = server.fetchMock;
  await act(async () => {
    render(<InterventionExecutionsPage />);
  });
  await act(async () => {
    fireEvent.click(await screen.findByRole('button', { name: 'Correct record' }));
  });
}

async function change(label: string, value: string): Promise<void> {
  await act(async () => {
    fireEvent.change(screen.getByLabelText(label), { target: { value } });
  });
}

async function press(name: string): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name }));
  });
}

const valueOf = (label: string) => (screen.getByLabelText(label) as HTMLInputElement | HTMLSelectElement).value;

describe('correcting a record', () => {
  test('the form opens holding what the record says now, not blanks', async () => {
    await openCorrection(correctionServer(EXECUTION));

    expect(valueOf('Adherence')).toBe('under_delivered');
    expect(valueOf('Trained context')).toBe('constrained_live');
    expect(valueOf('Rounds')).toBe('3');
    expect(valueOf('Sessions')).toBe('');
    expect(valueOf('Deviations (required if you claimed any)')).toBe('cut to 3 rounds -- athlete gassed');
    expect(valueOf('What was wrong? (required)')).toBe('');
    // Work still in progress is closed with Close out, not by a correction.
    expect(screen.queryByLabelText('Outcome')).toBeNull();
  });

  test('a correction is not sent without saying what was wrong', async () => {
    const server = correctionServer(EXECUTION);
    await openCorrection(server);

    await press('Record correction');
    expect(server.patches).toHaveLength(0);
    expect(screen.getByRole('alert').textContent).toContain('Say what was wrong with the record before correcting it.');

    await change('What was wrong? (required)', '   ');
    await press('Record correction');
    expect(server.patches).toHaveLength(0);
  });

  test('a correction sends the reason and the re-stated facts, and the reloaded record shows it', async () => {
    const server = correctionServer(EXECUTION);
    await openCorrection(server);

    await change('What was wrong? (required)', '  logged three rounds; it was four  ');
    await change('Rounds', '4');
    await press('Record correction');

    // Exactly this, and nothing else: no outcome on work still in progress,
    // no planned exposure, and no field the form does not show.
    expect(server.patches).toEqual([{
      action: 'correct',
      execution_id: 'ex-1',
      correction_reason: 'logged three rounds; it was four',
      adherence: 'under_delivered',
      trained_context: 'constrained_live',
      deviations: 'cut to 3 rounds -- athlete gassed',
      stop_change_reason: '',
      notes: '',
      actual_exposure: { rounds: 4 },
    }]);

    expect(screen.getByText(/corrected \(v2\)/)).toBeTruthy();
    expect(screen.getByText(/rounds: 4$/)).toBeTruthy();
    expect(screen.getByText('Corrected because:').parentElement?.textContent)
      .toBe('Corrected because: logged three rounds; it was four');
    expect(screen.queryByRole('button', { name: 'Record correction' })).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  test('a closed record can have its outcome corrected, and a stop still needs its reason', async () => {
    const server = correctionServer(CLOSED_EXECUTION);
    await openCorrection(server);

    expect(valueOf('Outcome')).toBe('completed');
    expect(valueOf('Notes')).toBe('worked the output floor');

    await change('What was wrong? (required)', 'it was stopped, not completed');
    await change('Outcome', 'stopped');
    await press('Record correction');
    expect(server.patches).toHaveLength(0);
    expect(screen.getByRole('alert').textContent).toContain('A stopped execution needs its stop/change reason.');

    await change('Stop/change reason (required if stopped)', 'shoulder tightened in round four');
    await press('Record correction');
    expect(server.patches).toHaveLength(1);
    expect(server.patches[0]).toMatchObject({
      action: 'correct',
      outcome: 'stopped',
      stop_change_reason: 'shoulder tightened in round four',
      adherence: 'delivered_as_planned',
      actual_exposure: { rounds: 6 },
    });
    expect(screen.getByText('stopped')).toBeTruthy();
  });

  test.each<[number, string | undefined, string]>([
    [403, 'Forbidden: coach is not assigned to athlete', 'Forbidden: coach is not assigned to athlete'],
    [404, undefined, 'Correction failed (404)'],
  ])('a correction the server refuses (%i) says so and leaves the record as it was', async (status, error, shown) => {
    const server = correctionServer(EXECUTION, { status, error });
    await openCorrection(server);

    await change('What was wrong? (required)', 'not my athlete');
    await change('Rounds', '9');
    await press('Record correction');

    expect(server.patches).toHaveLength(1);
    expect(screen.getByRole('alert').textContent).toContain(shown);
    expect(screen.queryByText(/corrected \(v2\)/)).toBeNull();
    expect(screen.getByText(/rounds: 3$/)).toBeTruthy();
    // Still open with what was typed.
    expect(valueOf('What was wrong? (required)')).toBe('not my athlete');
  });

  test('a non-positive exposure in a correction never leaves the page', async () => {
    const server = correctionServer(EXECUTION);
    await openCorrection(server);

    await change('What was wrong? (required)', 'wrong round count');
    await change('Rounds', '0');
    await press('Record correction');

    expect(server.patches).toHaveLength(0);
    expect(screen.getByText(/rounds must be a positive number/)).toBeTruthy();
  });

  test('a cancelled correction leaves nothing behind in the close-out form', async () => {
    const server = correctionServer(EXECUTION);
    await openCorrection(server);

    await change('What was wrong? (required)', 'never mind');
    await press('Cancel');
    expect(server.patches).toHaveLength(0);

    // Close out shares these fields. It must start from its own blank
    // defaults, not from the record the correction form was loaded with.
    await press('Close out');
    expect(valueOf('Adherence')).toBe('unknown');
    expect(valueOf('Trained context')).toBe('unknown');
    expect(valueOf('Rounds')).toBe('');
    expect(valueOf('Deviations (required if you claimed any)')).toBe('');
    expect(screen.queryByLabelText('What was wrong? (required)')).toBeNull();
  });

  test('closing out one record while another is being corrected does not carry the other record\'s facts across', async () => {
    const other = { ...EXECUTION, execution_id: 'ex-other', athlete_name: 'Sam R.', actual_exposure: {}, adherence: 'unknown', deviations: '' };
    const patches: Array<Record<string, unknown>> = [];
    global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'PATCH') patches.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      const items = String(input).includes('/intervention-executions') ? [EXECUTION, other] : [];
      return { ok: true, json: async () => ({ items }) } as Response;
    }) as unknown as typeof fetch;
    await act(async () => {
      render(<InterventionExecutionsPage />);
    });

    // Correct the first record (three rounds, under-delivered, a deviation)...
    await act(async () => {
      fireEvent.click((await screen.findAllByRole('button', { name: 'Correct record' }))[0]);
    });
    expect(valueOf('Rounds')).toBe('3');
    // ...then, without cancelling, close out the second.
    await press('Close out');

    expect(screen.queryByLabelText('What was wrong? (required)')).toBeNull();
    expect(valueOf('Adherence')).toBe('unknown');
    expect(valueOf('Rounds')).toBe('');
    expect(valueOf('Deviations (required if you claimed any)')).toBe('');

    await press('Record close-out');
    expect(patches).toHaveLength(1);
    expect(patches[0]).toMatchObject({
      action: 'close', execution_id: 'ex-other', adherence: 'unknown', deviations: '', actual_exposure: {},
    });
  });
});
