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
import { StrictMode } from 'react';

import { PASSBOOK_PAGE, THE_WORK_PAGE } from '@/components/athleteRecordPages';
import { handOffArrivalAthlete, takeArrivalAthlete } from '@/components/decisionLoopArrival';
import InterventionExecutionsPage from './page';

jest.mock('@/components/RoleSessionGate', () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

// A plain anchor that runs the link's own onClick, as next/link does, without
// navigating (the pattern of the Escalations test, lane AS-5).
jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ children, href, className, onClick }: {
    readonly children: React.ReactNode;
    readonly href: string;
    readonly className?: string;
    readonly onClick?: (event: React.MouseEvent<HTMLAnchorElement>) => void;
  }) => (
    <a href={href} className={className} onClick={(event) => { event.preventDefault(); onClick?.(event); }}>{children}</a>
  ),
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

  // Issue #1481 (Jason, "6B"; Codex P1 on #1507): a coach reopens a closed
  // record through the form, not only through a hand-made request.
  test('a closed record can be corrected back to in progress from the form', async () => {
    const server = correctionServer(CLOSED_EXECUTION);
    await openCorrection(server);

    const options = Array.from((screen.getByLabelText('Outcome') as HTMLSelectElement).options).map((option) => option.value);
    expect(options).toEqual(['completed', 'stopped', 'in_progress']);
    await change('What was wrong? (required)', 'it had not actually finished');
    await change('Outcome', 'in_progress');
    await press('Record correction');

    expect(server.patches).toHaveLength(1);
    expect(server.patches[0]).toMatchObject({ action: 'correct', execution_id: 'ex-1', outcome: 'in_progress' });
  });

  test('closing out work in progress never offers "in progress" as an outcome', async () => {
    global.fetch = correctionServer(EXECUTION).fetchMock;
    await act(async () => {
      render(<InterventionExecutionsPage />);
    });
    const closeButton = await screen.findByRole('button', { name: /close out/i });
    await act(async () => {
      fireEvent.click(closeButton);
    });
    const options = Array.from((screen.getByLabelText('Outcome') as HTMLSelectElement).options).map((option) => option.value);
    expect(options).not.toContain('in_progress');
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
    expect(screen.getByRole('alert').textContent).toContain('Failed');
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

  test('a cancelled correction leaves nothing it typed behind in the close-out form', async () => {
    const server = correctionServer(EXECUTION);
    await openCorrection(server);

    await change('What was wrong? (required)', 'never mind');
    await change('Rounds', '9');
    await change('Adherence', 'not_delivered');
    await press('Cancel');
    expect(server.patches).toHaveLength(0);

    // Close out shares these fields. It opens on what the RECORD says, not on
    // what was typed into the abandoned correction.
    await press('Close out');
    expect(valueOf('Rounds')).toBe('3');
    expect(valueOf('Adherence')).toBe('under_delivered');
    expect(screen.queryByLabelText('What was wrong? (required)')).toBeNull();
  });

  test('closing out a record that already has facts keeps them: the form opens holding what the record says', async () => {
    // A correction can put facts on work still in progress. Close out sends
    // every field it shows, so a form that opened blank would overwrite
    // them with "unknown" and "none recorded".
    const server = correctionServer(EXECUTION);
    global.fetch = server.fetchMock;
    await act(async () => {
      render(<InterventionExecutionsPage />);
    });
    await act(async () => {
      fireEvent.click(await screen.findByRole('button', { name: 'Close out' }));
    });

    expect(valueOf('Outcome')).toBe('completed');
    expect(valueOf('Adherence')).toBe('under_delivered');
    expect(valueOf('Trained context')).toBe('constrained_live');
    expect(valueOf('Rounds')).toBe('3');
    expect(valueOf('Deviations (required if you claimed any)')).toBe('cut to 3 rounds -- athlete gassed');

    await press('Record close-out');
    expect(server.patches).toHaveLength(1);
    expect(server.patches[0]).toMatchObject({
      action: 'close',
      execution_id: 'ex-1',
      outcome: 'completed',
      adherence: 'under_delivered',
      trained_context: 'constrained_live',
      deviations: 'cut to 3 rounds -- athlete gassed',
      actual_exposure: { rounds: 3 },
    });
  });

  test('a correction that is saved while the reload fails is shown as saved: form closed, the corrected record on screen, and the next correction aimed at it', async () => {
    const patches: Array<Record<string, unknown>> = [];
    let saved = false;
    global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === 'PATCH') {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        patches.push(body);
        saved = true;
        // The route answers a correction with the new version it wrote.
        const item = {
          ...EXECUTION, execution_id: 'ex-2', version: 2,
          actual_exposure: body.actual_exposure, correction_reason: body.correction_reason,
        };
        return { ok: true, json: async () => ({ item }) } as Response;
      }
      if (url.includes('/intervention-executions')) {
        if (saved) return { ok: false, status: 500, json: async () => ({}) } as Response;
        return { ok: true, json: async () => ({ items: [EXECUTION] }) } as Response;
      }
      return { ok: true, json: async () => ({ items: [] }) } as Response;
    }) as unknown as typeof fetch;
    await act(async () => {
      render(<InterventionExecutionsPage />);
    });
    await act(async () => {
      fireEvent.click(await screen.findByRole('button', { name: 'Correct record' }));
    });

    await change('What was wrong? (required)', 'wrong round count');
    await change('Rounds', '4');
    await press('Record correction');

    expect(patches).toHaveLength(1);
    // Said as saved, not as failed, and not by leaving the form open.
    const alert = screen.getByRole('alert').textContent ?? '';
    expect(alert).toContain('Saved');
    expect(alert).toContain('The list could not be refreshed. Reload the page to see the latest.');
    expect(alert).not.toContain('Failed');
    expect(screen.queryByRole('button', { name: 'Record correction' })).toBeNull();
    // The record on screen is the corrected one the server returned...
    expect(screen.getByText(/corrected \(v2\)/)).toBeTruthy();
    expect(screen.getByText(/rounds: 4$/)).toBeTruthy();
    expect(screen.getByText('Corrected because:').parentElement?.textContent).toBe('Corrected because: wrong round count');

    // ...so a further correction goes to it, not to the version just superseded.
    await press('Correct record');
    await change('What was wrong? (required)', 'and the adherence');
    await press('Record correction');
    expect(patches).toHaveLength(2);
    expect(patches[1]).toMatchObject({ execution_id: 'ex-2', correction_reason: 'and the adherence' });
  });

  test('a saved correction closes the form even when the answer carries no record and the reload fails', async () => {
    let saved = false;
    global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'PATCH') {
        saved = true;
        return { ok: true, json: async () => ({}) } as Response;
      }
      if (String(input).includes('/intervention-executions')) {
        if (saved) return { ok: false, status: 500, json: async () => ({}) } as Response;
        return { ok: true, json: async () => ({ items: [EXECUTION] }) } as Response;
      }
      return { ok: true, json: async () => ({ items: [] }) } as Response;
    }) as unknown as typeof fetch;
    await act(async () => {
      render(<InterventionExecutionsPage />);
    });
    await act(async () => {
      fireEvent.click(await screen.findByRole('button', { name: 'Correct record' }));
    });

    await change('What was wrong? (required)', 'wrong round count');
    await press('Record correction');

    // Nothing to show the corrected record from, so the old row stays -- but
    // the form does not sit open with the reason typed, inviting a resend.
    expect(screen.getByRole('alert').textContent).toContain('Saved');
    expect(screen.queryByRole('button', { name: 'Record correction' })).toBeNull();
    expect(screen.queryByLabelText('What was wrong? (required)')).toBeNull();
    expect(screen.getByText(/rounds: 3$/)).toBeTruthy();
  });

  test('switching straight from correcting one record to correcting another carries nothing across', async () => {
    const other = {
      ...EXECUTION, execution_id: 'ex-other', athlete_name: 'Sam R.',
      actual_exposure: { minutes: 20 }, adherence: 'delivered_as_planned', deviations: '',
    };
    const patches: Array<Record<string, unknown>> = [];
    global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'PATCH') patches.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      const items = String(input).includes('/intervention-executions') ? [EXECUTION, other] : [];
      return { ok: true, json: async () => ({ items }) } as Response;
    }) as unknown as typeof fetch;
    await act(async () => {
      render(<InterventionExecutionsPage />);
    });

    await act(async () => {
      fireEvent.click((await screen.findAllByRole('button', { name: 'Correct record' }))[0]);
    });
    await change('What was wrong? (required)', 'a reason meant for the first record');
    await change('Rounds', '9');
    // The first record's form is open, so the one Correct record button left is the second record's.
    await press('Correct record');

    expect(valueOf('What was wrong? (required)')).toBe('');
    expect(valueOf('Rounds')).toBe('');
    expect(valueOf('Minutes')).toBe('20');
    expect(valueOf('Adherence')).toBe('delivered_as_planned');

    await change('What was wrong? (required)', 'twenty minutes, not thirty');
    await press('Record correction');
    expect(patches).toEqual([expect.objectContaining({
      action: 'correct',
      execution_id: 'ex-other',
      correction_reason: 'twenty minutes, not thirty',
      adherence: 'delivered_as_planned',
      actual_exposure: { minutes: 20 },
    })]);
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

// Lane L2, item two: a form is filled from the record as it was when the form
// opened, and sends every field it shows. The version it was filled from goes
// back with the save, so the server can refuse a record that has changed since
// instead of letting the form overwrite it.
describe('the version the form was opened on travels with the save', () => {
  const VERSIONED: ExecutionFixture & { row_version: string } = { ...EXECUTION, row_version: '7001' };

  test('a correction sends the version of the record the form was filled from', async () => {
    const server = correctionServer(VERSIONED);
    await openCorrection(server);
    await change('What was wrong? (required)', 'logged three rounds; it was four');
    await press('Record correction');

    expect(server.patches).toHaveLength(1);
    expect(server.patches[0]).toMatchObject({
      action: 'correct', execution_id: 'ex-1', expected_row_version: '7001',
    });
  });

  test('a close-out sends it too', async () => {
    const server = correctionServer(VERSIONED);
    global.fetch = server.fetchMock;
    await act(async () => {
      render(<InterventionExecutionsPage />);
    });
    await act(async () => {
      fireEvent.click(await screen.findByRole('button', { name: 'Close out' }));
    });
    await press('Record close-out');

    expect(server.patches).toHaveLength(1);
    expect(server.patches[0]).toMatchObject({
      action: 'close', execution_id: 'ex-1', expected_row_version: '7001',
    });
  });

  test('it is the version the form was OPENED on, not the one a later refresh of the list brought', async () => {
    // The list is read again while the form is open (here: this coach starts
    // another execution), and by then someone has added to the record. The
    // form still holds the old facts, so it must still name the old version.
    const patches: Array<Record<string, unknown>> = [];
    let listed = VERSIONED;
    global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/intervention-executions') && init?.method === 'PATCH') {
        patches.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return { ok: true, json: async () => ({ item: {} }) } as Response;
      }
      if (url.includes('/intervention-executions') && init?.method === 'POST') {
        listed = { ...VERSIONED, notes: 'added by another coach', row_version: '7002' };
        return { ok: true, json: async () => ({ item: {} }) } as Response;
      }
      if (url.includes('/intervention-executions')) {
        return { ok: true, json: async () => ({ items: [listed] }) } as Response;
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

    await act(async () => {
      render(<InterventionExecutionsPage />);
    });
    await act(async () => {
      fireEvent.click(await screen.findByRole('button', { name: 'Correct record' }));
    });
    await change('Athlete', 'ath-1');
    await change('Protocol', 'p-1');
    await press('Start execution');
    await change('What was wrong? (required)', 'logged three rounds; it was four');
    await press('Record correction');

    expect(patches).toHaveLength(1);
    expect(patches[0]).toMatchObject({ action: 'correct', expected_row_version: '7001' });
  });

  test('a saved correction hands the screen the new version, so the next save from it names that one', async () => {
    const patches: Array<Record<string, unknown>> = [];
    global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === 'PATCH') {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        patches.push(body);
        const item = {
          ...VERSIONED, execution_id: 'ex-2', version: 2, row_version: '7005',
          actual_exposure: body.actual_exposure, correction_reason: body.correction_reason,
        };
        return { ok: true, json: async () => ({ item }) } as Response;
      }
      if (url.includes('/intervention-executions')) {
        // The reload after the save never comes back.
        if (patches.length > 0) return { ok: false, status: 500, json: async () => ({}) } as Response;
        return { ok: true, json: async () => ({ items: [VERSIONED] }) } as Response;
      }
      return { ok: true, json: async () => ({ items: [] }) } as Response;
    }) as unknown as typeof fetch;
    await act(async () => {
      render(<InterventionExecutionsPage />);
    });
    await act(async () => {
      fireEvent.click(await screen.findByRole('button', { name: 'Correct record' }));
    });
    await change('What was wrong? (required)', 'wrong round count');
    await press('Record correction');
    await press('Correct record');
    await change('What was wrong? (required)', 'and the adherence');
    await press('Record correction');

    expect(patches.map((body) => [body.execution_id, body.expected_row_version]))
      .toEqual([['ex-1', '7001'], ['ex-2', '7005']]);
  });

  test('switching straight from one record\'s form to another\'s sends the second record\'s version, not the first\'s', async () => {
    const other = { ...VERSIONED, execution_id: 'ex-other', athlete_name: 'Sam R.', row_version: '8002' };
    const patches: Array<Record<string, unknown>> = [];
    global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'PATCH') patches.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      const items = String(input).includes('/intervention-executions') ? [VERSIONED, other] : [];
      return { ok: true, json: async () => ({ items }) } as Response;
    }) as unknown as typeof fetch;
    await act(async () => {
      render(<InterventionExecutionsPage />);
    });
    await act(async () => {
      fireEvent.click((await screen.findAllByRole('button', { name: 'Correct record' }))[0]);
    });
    // The first record's form is open, so the one Correct record button left is the second record's.
    await press('Correct record');
    await change('What was wrong? (required)', 'twenty minutes, not thirty');
    await press('Record correction');

    expect(patches).toHaveLength(1);
    expect(patches[0]).toMatchObject({ execution_id: 'ex-other', expected_row_version: '8002' });
  });

  test('the server\'s refusal of a changed record is shown as it was sent, and the form is left open', async () => {
    const sentence = 'This record has changed since you opened it, so this was not saved. '
      + 'Reload to see it as it stands now, then make your change again.';
    const server = correctionServer(VERSIONED, { status: 409, error: sentence });
    await openCorrection(server);
    await change('What was wrong? (required)', 'logged three rounds; it was four');
    await press('Record correction');

    expect(screen.getByRole('alert').textContent).toContain(sentence);
    expect(screen.getByRole('button', { name: 'Record correction' })).toBeTruthy();
    expect(valueOf('What was wrong? (required)')).toBe('logged three rounds; it was four');
  });
});

// Lane AS-11 (app scrub CF-15; Q2b = A, Q4 = A). A link that opens The Work
// on one athlete (Passbook's line) sets the start form to them and narrows
// the list to their executions with the route's own athlete_id filter; "Show
// every athlete" widens it. The athlete is taken from page memory, only when
// this page's roster lists them. A name on a row opens that athlete's Passbook.
describe('arriving from a link (lane AS-11)', () => {
  const OTHER = { ...EXECUTION, execution_id: 'ex-2', lineage_id: 'ex-2', athlete_id: 'ath-2', athlete_name: 'Sam K.' };
  const ROSTER = [
    { athlete_id: 'ath-1', full_name: 'Jordan P.' },
    { athlete_id: 'ath-2', full_name: 'Sam K.' },
    // On the roster, with no execution on record.
    { athlete_id: 'ath-3', full_name: 'Tess N.' },
  ];

  interface Options {
    /** Status of a read that names an athlete. */
    narrowedStatus?: number;
    /** Status of a read that names nobody, after the first one. */
    laterWholeStatus?: number;
    /** Held open: the next read that names an athlete waits on this. */
    holdNarrowed?: Promise<void> | null;
    /** Held open: the next read that names nobody waits on this. */
    holdWhole?: Promise<void> | null;
    rosterStatus?: number;
    honourAbort?: boolean;
    /** The rows the route holds, when not the default two. */
    rows?: Array<Record<string, unknown>>;
  }

  function arrivalFetch(options: Options = {}) {
    const listReads: string[] = [];
    const writes: string[] = [];
    let wholeReads = 0;
    const fetchMock = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const respond = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body }) as Response;
      if (options.honourAbort && init?.signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      if (url.includes('/intervention-executions') && init?.method && init.method !== 'GET') {
        writes.push(init.method);
        return respond(200, { item: {} });
      }
      if (url.includes('/intervention-executions')) {
        const query = url.split('/intervention-executions')[1] ?? '';
        listReads.push(query);
        const named = /^\?athlete_id=([^&]+)$/.exec(query);
        if (named) {
          if (options.holdNarrowed) {
            const wait = options.holdNarrowed;
            options.holdNarrowed = null;
            await wait;
          }
          if (options.narrowedStatus && options.narrowedStatus >= 400) return respond(options.narrowedStatus, {});
          const id = decodeURIComponent(named[1]);
          return respond(200, { items: (options.rows ?? [EXECUTION, OTHER]).filter((row) => row.athlete_id === id) });
        }
        wholeReads += 1;
        if (options.holdWhole) {
          const wait = options.holdWhole;
          options.holdWhole = null;
          await wait;
        }
        if (wholeReads > 1 && options.laterWholeStatus) return respond(options.laterWholeStatus, {});
        return respond(200, { items: options.rows ?? [EXECUTION, OTHER] });
      }
      if (url.includes('/intervention-protocols')) {
        return respond(200, { items: [{ protocol_id: 'p-1', title: 'Round-3 endurance block', version: 1, athlete_id: null, status: 'active' }] });
      }
      if (url.includes('/athletes/list')) return respond(options.rosterStatus ?? 200, { items: ROSTER });
      return respond(200, { items: [] });
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    return { listReads, writes };
  }

  const startAthlete = () => (screen.getByLabelText('Athlete') as HTMLSelectElement).value;
  const rowNames = () => screen.getAllByRole('link').filter((link) => link.getAttribute('href') === '/coach/passbook').map((link) => link.textContent);
  const widen = () => screen.queryByRole('button', { name: 'Show every athlete' });

  async function open(strict = false) {
    await act(async () => {
      render(strict ? <StrictMode><InterventionExecutionsPage /></StrictMode> : <InterventionExecutionsPage />);
    });
    await act(async () => {});
  }

  afterEach(() => {
    takeArrivalAthlete(THE_WORK_PAGE);
    takeArrivalAthlete(PASSBOOK_PAGE);
  });

  test('with no hand-off the page opens as before: every athlete, one read, nobody chosen', async () => {
    const { listReads } = arrivalFetch();
    await open();
    expect(listReads).toEqual(['']);
    expect(startAthlete()).toBe('');
    expect(rowNames()).toEqual(['Jordan P.', 'Sam K.']);
    expect(widen()).toBeNull();
  });

  test('a hand-off sets the start form to the athlete and narrows the list to them', async () => {
    const { listReads, writes } = arrivalFetch();
    handOffArrivalAthlete('ath-2', THE_WORK_PAGE);
    await open();
    expect(listReads).toEqual(['', '?athlete_id=ath-2']);
    expect(startAthlete()).toBe('ath-2');
    expect(rowNames()).toEqual(['Sam K.']);
    expect(widen()).not.toBeNull();
    // Arriving starts nothing: no write left the page.
    expect(writes).toEqual([]);
  });

  test('the narrowed list names its athlete, and still does when that athlete has no execution', async () => {
    arrivalFetch();
    handOffArrivalAthlete('ath-3', THE_WORK_PAGE);
    await open();
    expect(rowNames()).toEqual([]);
    expect(screen.getByText('No executions on record')).toBeTruthy();
    expect(screen.getByTestId('list-athlete').textContent).toBe('Tess N.');
    expect(widen()).not.toBeNull();
    await act(async () => {
      fireEvent.click(widen()!);
    });
    expect(screen.queryByTestId('list-athlete')).toBeNull();
    expect(rowNames()).toEqual(['Jordan P.', 'Sam K.']);
  });

  test('"Show every athlete" reads the whole list again and leaves the start form alone', async () => {
    const { listReads } = arrivalFetch();
    handOffArrivalAthlete('ath-2', THE_WORK_PAGE);
    await open();
    await act(async () => {
      fireEvent.click(widen()!);
    });
    expect(listReads).toEqual(['', '?athlete_id=ath-2', '']);
    expect(rowNames()).toEqual(['Jordan P.', 'Sam K.']);
    expect(widen()).toBeNull();
    expect(startAthlete()).toBe('ath-2');
  });

  // This page has no kiosk layout, and `.btn` (unlayered) outranks a size
  // utility. The button gets the 55px floor and the 19.1px type only from a
  // kiosk surface around it, so the row carries one.
  test('the widen button is a .btn inside a kiosk surface', async () => {
    arrivalFetch();
    handOffArrivalAthlete('ath-2', THE_WORK_PAGE);
    await open();
    expect(widen()!.classList.contains('btn')).toBe(true);
    expect(widen()!.closest('[data-surface="kiosk"]')).not.toBeNull();
  });

  test('work started for another athlete while the list is narrowed reads every athlete\'s list, so the new work shows', async () => {
    const { listReads, writes } = arrivalFetch();
    handOffArrivalAthlete('ath-2', THE_WORK_PAGE);
    await open();
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Athlete'), { target: { value: 'ath-1' } });
      fireEvent.change(screen.getByLabelText('Protocol'), { target: { value: 'p-1' } });
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Start execution' }));
    });
    expect(writes).toEqual(['POST']);
    expect(listReads).toEqual(['', '?athlete_id=ath-2', '']);
    expect(rowNames()).toEqual(['Jordan P.', 'Sam K.']);
    expect(widen()).toBeNull();
  });

  test('a read that a newer one has replaced says nothing when it fails: no alert over the fresh list', async () => {
    arrivalFetch();
    handOffArrivalAthlete('ath-2', THE_WORK_PAGE);
    await open();
    // A write's reload for the narrowed list is held open, and will fail...
    let release = () => {};
    arrivalFetch({ holdNarrowed: new Promise<void>((resolve) => { release = resolve; }), narrowedStatus: 500 });
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Protocol'), { target: { value: 'p-1' } });
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Start execution' }));
    });
    // ...the coach widens, and the whole list lands first...
    await act(async () => {
      fireEvent.click(widen()!);
    });
    expect(rowNames()).toEqual(['Jordan P.', 'Sam K.']);
    // ...then the held read fails. It was replaced, so it says nothing.
    await act(async () => {
      release();
    });
    await act(async () => {});
    expect(screen.queryByRole('alert')).toBeNull();
    expect(rowNames()).toEqual(['Jordan P.', 'Sam K.']);
    expect(widen()).toBeNull();
  });

  test('a widen that a newer read has replaced does not clear that newer read\'s alert', async () => {
    arrivalFetch();
    handOffArrivalAthlete('ath-2', THE_WORK_PAGE);
    await open();
    // The coach widens, and that whole-list read is held open...
    let release = () => {};
    arrivalFetch({ holdWhole: new Promise<void>((resolve) => { release = resolve; }), narrowedStatus: 500 });
    await act(async () => {
      fireEvent.click(widen()!);
    });
    // ...then starts work for the listed athlete; that newer read fails, and says so...
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Protocol'), { target: { value: 'p-1' } });
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Start execution' }));
    });
    expect(screen.getByRole('alert').textContent).toContain('Unable to load executions.');
    // ...then the held widen lands. It was replaced: no rows from it, and the alert stays.
    await act(async () => {
      release();
    });
    await act(async () => {});
    expect(screen.getByRole('alert').textContent).toContain('Unable to load executions.');
    expect(rowNames()).toEqual(['Sam K.']);
    expect(widen()).not.toBeNull();
  });

  test('a row with no name keeps its plain id and is not a link', async () => {
    arrivalFetch({ rows: [EXECUTION, { ...OTHER, athlete_id: 'ath-7', athlete_name: null }] });
    await open();
    expect(rowNames()).toEqual(['Jordan P.']);
    expect(screen.getByText(/ath-7/)).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'ath-7' })).toBeNull();
  });

  test('a hand-off for an athlete the roster does not list chooses nobody and asks for nobody', async () => {
    const { listReads } = arrivalFetch();
    handOffArrivalAthlete('ath-9', THE_WORK_PAGE);
    await open();
    expect(listReads).toEqual(['']);
    expect(startAthlete()).toBe('');
    expect(widen()).toBeNull();
  });

  test('a hand-off with a roster that was refused chooses nobody and asks for nobody', async () => {
    const { listReads } = arrivalFetch({ rosterStatus: 403 });
    handOffArrivalAthlete('ath-2', THE_WORK_PAGE);
    await open();
    expect(listReads).toEqual(['']);
    expect(startAthlete()).toBe('');
    expect(widen()).toBeNull();
  });

  test('a hand-off meant for another page is not taken here', async () => {
    const { listReads } = arrivalFetch();
    handOffArrivalAthlete('ath-2', PASSBOOK_PAGE);
    await open();
    expect(listReads).toEqual(['']);
    expect(startAthlete()).toBe('');
  });

  test('a hand-off is taken once: the next visit opens on every athlete', async () => {
    const { listReads } = arrivalFetch();
    handOffArrivalAthlete('ath-2', THE_WORK_PAGE);
    await open();
    document.body.innerHTML = '';
    listReads.length = 0;
    await open();
    expect(listReads).toEqual(['']);
    expect(startAthlete()).toBe('');
  });

  test('under StrictMode, with fetch honouring the abort, the hand-off still narrows the list', async () => {
    const { listReads } = arrivalFetch({ honourAbort: true });
    handOffArrivalAthlete('ath-2', THE_WORK_PAGE);
    await open(true);
    expect(startAthlete()).toBe('ath-2');
    expect(rowNames()).toEqual(['Sam K.']);
    expect(listReads.filter((query) => query === '?athlete_id=ath-2')).toHaveLength(1);
  });

  test('if the narrowed read fails, the list on screen is still every athlete\'s, the failure is said, and the next read asks for every athlete', async () => {
    const { listReads } = arrivalFetch({ narrowedStatus: 500 });
    handOffArrivalAthlete('ath-2', THE_WORK_PAGE);
    await open();
    expect(screen.getByRole('alert').textContent).toContain('Unable to load executions.');
    expect(rowNames()).toEqual(['Jordan P.', 'Sam K.']);
    expect(widen()).toBeNull();
    // The start form still opened on the athlete, and still has its protocols.
    expect(startAthlete()).toBe('ath-2');
    expect(screen.getByRole('option', { name: 'Round-3 endurance block (v1)' })).toBeTruthy();
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Protocol'), { target: { value: 'p-1' } });
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Start execution' }));
    });
    expect(listReads).toEqual(['', '?athlete_id=ath-2', '']);
  });

  test('a read after a write asks for the list on screen: one athlete\'s while narrowed', async () => {
    const { listReads, writes } = arrivalFetch();
    handOffArrivalAthlete('ath-2', THE_WORK_PAGE);
    await open();
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Protocol'), { target: { value: 'p-1' } });
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Start execution' }));
    });
    expect(writes).toEqual(['POST']);
    expect(listReads).toEqual(['', '?athlete_id=ath-2', '?athlete_id=ath-2']);
    expect(widen()).not.toBeNull();
  });

  test('if widening fails, the list stays the one athlete\'s and the button stays', async () => {
    arrivalFetch({ laterWholeStatus: 500 });
    handOffArrivalAthlete('ath-2', THE_WORK_PAGE);
    await open();
    await act(async () => {
      fireEvent.click(widen()!);
    });
    expect(screen.getByRole('alert').textContent).toContain('Unable to load executions.');
    expect(rowNames()).toEqual(['Sam K.']);
    expect(widen()).not.toBeNull();
  });

  test('a slow answer for one athlete never replaces the whole list the coach asked for after it', async () => {
    const { listReads } = arrivalFetch();
    handOffArrivalAthlete('ath-2', THE_WORK_PAGE);
    await open();
    // A write's reload for the narrowed list is held open...
    let release = () => {};
    const options: Options = { holdNarrowed: new Promise<void>((resolve) => { release = resolve; }) };
    const held = arrivalFetch(options);
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Protocol'), { target: { value: 'p-1' } });
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Start execution' }));
    });
    expect(held.listReads).toEqual(['?athlete_id=ath-2']);
    // ...the coach widens, and the whole list lands first...
    await act(async () => {
      fireEvent.click(widen()!);
    });
    expect(rowNames()).toEqual(['Jordan P.', 'Sam K.']);
    expect(widen()).toBeNull();
    // ...then the held answer lands, and changes nothing.
    await act(async () => {
      release();
    });
    await act(async () => {});
    expect(rowNames()).toEqual(['Jordan P.', 'Sam K.']);
    expect(widen()).toBeNull();
    expect(listReads).toEqual(['', '?athlete_id=ath-2']);
  });

  test('an athlete\'s name on a row opens their Passbook, in page memory and not in the address', async () => {
    arrivalFetch();
    await open();
    const link = screen.getByRole('link', { name: 'Sam K.' });
    expect(link.getAttribute('href')).toBe('/coach/passbook');
    expect(link.className).toContain('min-h-[var(--tap)]');
    expect(link.className).toContain('text-[length:var(--t-md)]');
    fireEvent.click(link, { ctrlKey: true });
    expect(takeArrivalAthlete(PASSBOOK_PAGE)).toBeNull();
    fireEvent.click(link);
    expect(takeArrivalAthlete(PASSBOOK_PAGE)).toBe('ath-2');
  });
});
