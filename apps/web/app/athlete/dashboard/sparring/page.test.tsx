/**
 * @jest-environment jsdom
 */

// The Deep-Track submit path reports to the athlete whether their session was
// kept. Telling someone their work was "partially saved" -- and stamping a save
// time -- when the server accepted nothing is the one failure they cannot
// recover from, because the message tells them not to re-enter it.

import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import { FORMULA_UNITS, OBSERVATION_KINDS } from '@/src/server/pilot/formulas/types';
import SparringTelemetryPage from './page';

const SESSION_PATH = '/api/pilot/auth/session';

const submittedObservations: Array<Record<string, unknown>> = [];

function mockFetch(observationOk: (index: number) => boolean) {
  let index = 0;
  return jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith(SESSION_PATH)) {
      return {
        ok: true,
        json: async () => ({ authenticated: true, athlete_id: 'athlete-001' }),
      } as Response;
    }

    if (typeof init?.body === 'string') {
      submittedObservations.push(JSON.parse(init.body) as Record<string, unknown>);
    }

    return {
      ok: observationOk(index++),
      json: async () => ({}),
    } as Response;
  });
}

async function renderAndSubmit(observationOk: (index: number) => boolean) {
  submittedObservations.length = 0;
  global.fetch = mockFetch(observationOk) as unknown as typeof fetch;
  const { container } = render(<SparringTelemetryPage />);

  const submit = await screen.findByRole('button', { name: 'Log Combat Session' });
  await waitFor(() => expect((submit as HTMLButtonElement).disabled).toBe(false));

  fireEvent.submit(container.querySelector('form') as HTMLFormElement);
}

describe('Deep-Track sparring submission status', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('a submission the server rejected entirely is not reported as saved', async () => {
    await renderAndSubmit(() => false);

    await screen.findByText(/Nothing was saved/);
    expect(screen.queryByText(/partially saved/)).toBeNull();
    // The stamp is the athlete's only evidence a record exists, so it must not
    // move when no record was created.
    expect(screen.getByText('Not submitted yet')).toBeTruthy();
  });

  test('a submission the server partly accepted is reported as partial and stamped', async () => {
    await renderAndSubmit((index) => index > 0);

    await screen.findByText(/partially saved/);
    expect(screen.queryByText('Not submitted yet')).toBeNull();
  });

  test('a fully accepted submission is reported as saved and stamped', async () => {
    await renderAndSubmit(() => true);

    await screen.findByText(/Telemetry saved and sent to the SHADOW formula engine/);
    expect(screen.queryByText('Not submitted yet')).toBeNull();
  });

  // Every field on this form is submitted as a typed observation, and the API
  // rejects an unknown kind or unit outright -- so a term the server does not
  // share is a whole field silently lost, not a degraded one.
  test('every observation submitted uses vocabulary the observations API accepts', async () => {
    global.fetch = mockFetch(() => true) as unknown as typeof fetch;
    submittedObservations.length = 0;
    const { container } = render(<SparringTelemetryPage />);

    const submit = await screen.findByRole('button', { name: 'Log Combat Session' });
    await waitFor(() => expect((submit as HTMLButtonElement).disabled).toBe(false));

    fireEvent.change(screen.getByLabelText('Body Weight (kg, optional)'), { target: { value: '61.5' } });
    fireEvent.change(screen.getByLabelText('Recovery Notes'), { target: { value: 'Right wrist sore.' } });
    fireEvent.submit(container.querySelector('form') as HTMLFormElement);

    await waitFor(() => expect(submittedObservations.length).toBeGreaterThan(0));
    expect(submittedObservations.map((observation) => observation.kind)).toContain('recovery_notes');
    for (const observation of submittedObservations) {
      expect(OBSERVATION_KINDS).toContain(observation.kind);
      expect(FORMULA_UNITS).toContain(observation.unit);
      const notes = (observation.dimensions as { notes?: string } | undefined)?.notes;
      if (typeof notes === 'string') {
        expect(notes.length).toBeLessThanOrEqual(300);
      }
    }
  });
});
