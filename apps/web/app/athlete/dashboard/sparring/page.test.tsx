/**
 * @jest-environment jsdom
 */

// The Deep-Track submit path reports to the athlete whether their session was
// kept. Telling someone their work was "partially saved" -- and stamping a save
// time -- when the server accepted nothing is the one failure they cannot
// recover from, because the message tells them not to re-enter it.

import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import SparringTelemetryPage from './page';

const SESSION_PATH = '/api/pilot/auth/session';

function mockFetch(observationOk: (index: number) => boolean) {
  let index = 0;
  return jest.fn(async (input: RequestInfo | URL) => {
    if (String(input).endsWith(SESSION_PATH)) {
      return {
        ok: true,
        json: async () => ({ authenticated: true, athlete_id: 'athlete-001' }),
      } as Response;
    }

    return {
      ok: observationOk(index++),
      json: async () => ({}),
    } as Response;
  });
}

async function renderAndSubmit(observationOk: (index: number) => boolean) {
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
});
