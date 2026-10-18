/**
 * @jest-environment jsdom
 */

/**
 * The coach's standing-height panel (OD-2026-10-17-026 (b)). The route decides who may read
 * (app/api/pilot/coach/athlete-height/route.test.ts, athleteHeights.pg.test.ts). These cases are
 * about what the coach is told and what one press of Save sends: a failed read is never shown
 * as "no height recorded", the growth rate is arithmetic with no label, a retry after a lost reply
 * carries the same save key, and a correction names the reading it replaces.
 */

import { act, fireEvent, render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';

import AthleteGrowthPanel, { growthSentence, parseHeightPayload } from './AthleteGrowthPanel';

const OLD = {
  height_id: '11111111-1111-4111-8111-111111111111',
  measured_on: '2026-07-01',
  height_cm: 140,
  supersedes_height_id: null,
  superseded: false,
};
const LATEST = {
  height_id: '22222222-2222-4222-8222-222222222222',
  measured_on: '2026-10-01',
  height_cm: 151.4,
  supersedes_height_id: null,
  superseded: false,
};
const GROWTH = {
  from_measured_on: '2026-07-01',
  from_cm: 140,
  to_measured_on: '2026-10-01',
  to_cm: 151.4,
  days: 92,
  change_cm: 11.4,
  cm_per_year: 45.3,
};

function payload(readings: unknown[], growth: unknown = null) {
  const inForce = (readings as Array<{ superseded: boolean }>).find((row) => !row.superseded) ?? null;
  return { ok: true, readings, latest: inForce, growth, growth_min_days: 60, height_cm_min: 50, height_cm_max: 250 };
}

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

const fetchMock = jest.fn();

beforeEach(() => {
  fetchMock.mockReset();
  global.fetch = fetchMock as unknown as typeof fetch;
});

async function renderPanel() {
  await act(async () => {
    render(<AthleteGrowthPanel athleteId="ath-1" />);
  });
}

function postBodies(): Array<Record<string, unknown>> {
  return fetchMock.mock.calls
    .filter(([, init]) => (init as RequestInit | undefined)?.method === 'POST')
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)));
}

test('shows the latest height and the growth rate as plain arithmetic, with no label', async () => {
  fetchMock.mockResolvedValueOnce(jsonResponse(payload([LATEST, OLD], GROWTH)));
  await renderPanel();
  expect(fetchMock.mock.calls[0][0]).toContain('/api/pilot/coach/athlete-height?athlete_id=ath-1');
  expect(screen.getByText(/Height: 151\.4 cm, measured 10\/1\/2026\./)).toBeTruthy();
  expect(screen.getByTestId('coach-athlete-growth-rate').textContent).toBe(
    'Growth: +11.4 cm since 7/1/2026 (92 days): about 45.3 cm a year.',
  );
  const words = screen.getByTestId('coach-athlete-growth').textContent ?? '';
  expect(words).not.toMatch(/matur|puberty|spurt|peak height|early|late|predict|adult height|drift|percentile/i);
});

test('with no pair 60 days apart it says so instead of inventing a rate', async () => {
  fetchMock.mockResolvedValueOnce(jsonResponse(payload([LATEST])));
  await renderPanel();
  expect(screen.getByTestId('coach-athlete-growth-rate').textContent).toBe(
    'A growth rate needs two readings at least 60 days apart.',
  );
});

test('a failed read is never shown as "no height recorded"', async () => {
  fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'boom' }, 500));
  await renderPanel();
  expect(screen.getByTestId('coach-athlete-growth-unavailable')).toBeTruthy();
  expect(screen.queryByText(/No height recorded yet/)).toBeNull();
});

test('a retry after a lost reply sends the same save key; the next reading gets a new one', async () => {
  fetchMock
    .mockResolvedValueOnce(jsonResponse(payload([])))
    .mockRejectedValueOnce(new Error('network'))
    .mockResolvedValueOnce(jsonResponse(payload([LATEST]), 201))
    .mockResolvedValueOnce(jsonResponse(payload([LATEST]), 201));
  await renderPanel();
  fireEvent.change(screen.getByLabelText('Height in centimetres'), { target: { value: '151.4' } });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Save height' }));
  });
  expect(screen.getByRole('alert').textContent).toMatch(/Check the readings below before trying again/);
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Save height' }));
  });
  expect(screen.getByRole('status').textContent).toBe('Height saved: 151.4 cm.');
  fireEvent.change(screen.getByLabelText('Height in centimetres'), { target: { value: '152.0' } });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Save height' }));
  });

  const bodies = postBodies();
  expect(bodies).toHaveLength(3);
  expect(bodies[0]).toMatchObject({ athlete_id: 'ath-1', height_cm: 151.4, supersedes_height_id: null });
  expect(bodies[1].request_key).toBe(bodies[0].request_key);
  expect(bodies[2].request_key).not.toBe(bodies[0].request_key);
});

test('a refusal before anything was written starts a new save key', async () => {
  fetchMock
    .mockResolvedValueOnce(jsonResponse(payload([])))
    .mockResolvedValueOnce(jsonResponse({ error: 'Enter the height in centimetres, from 50 to 250.' }, 400))
    .mockResolvedValueOnce(jsonResponse(payload([LATEST]), 201));
  await renderPanel();
  fireEvent.change(screen.getByLabelText('Height in centimetres'), { target: { value: '251.0' } });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Save height' }));
  });
  expect(screen.getByRole('alert').textContent).toBe('Enter the height in centimetres, from 50 to 250.');
  fireEvent.change(screen.getByLabelText('Height in centimetres'), { target: { value: '151.4' } });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Save height' }));
  });
  const bodies = postBodies();
  expect(bodies[1].request_key).not.toBe(bodies[0].request_key);
});

test('a typed value that is not centimetres is refused on the screen and nothing is sent', async () => {
  fetchMock.mockResolvedValueOnce(jsonResponse(payload([])));
  await renderPanel();
  for (const typed of ['', '5', '1514', '151.44', '151,4', 'abc']) {
    fireEvent.change(screen.getByLabelText('Height in centimetres'), { target: { value: typed } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save height' }));
    });
    expect(screen.getByRole('alert').textContent).toBe('Enter the height in centimetres, like 151.4.');
  }
  expect(postBodies()).toHaveLength(0);
});

test('a correction names the reading it replaces and keeps the original on screen, marked corrected', async () => {
  const fixed = { ...LATEST, height_id: '33333333-3333-4333-8333-333333333333', height_cm: 152.4, supersedes_height_id: LATEST.height_id };
  fetchMock
    .mockResolvedValueOnce(jsonResponse(payload([LATEST, OLD], GROWTH)))
    .mockResolvedValueOnce(jsonResponse(payload([fixed, { ...LATEST, superseded: true }, OLD], GROWTH), 201));
  await renderPanel();
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Correct the 151.4 cm reading of 10/1/2026' }));
  });
  const box = screen.getByLabelText('Correct the 151.4 cm reading of 10/1/2026 (cm)') as HTMLInputElement;
  expect(box.value).toBe('151.4');
  fireEvent.change(box, { target: { value: '152.4' } });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Save correction' }));
  });
  expect(postBodies()[0]).toMatchObject({ height_cm: 152.4, supersedes_height_id: LATEST.height_id, measured_on: '2026-10-01' });
  expect(screen.getByRole('status').textContent).toBe('Correction saved: 152.4 cm. The old reading stays on record.');
  expect(screen.getByText('(corrected)')).toBeTruthy();
  // The form is back to a new reading for today, not the corrected reading's date.
  expect((screen.getByLabelText('Measured on') as HTMLInputElement).value).not.toBe('2026-10-01');
  // A corrected reading offers no second correction.
  expect(screen.queryByRole('button', { name: 'Correct the 151.4 cm reading of 10/1/2026' })).toBeNull();
});

test('the payload parser refuses a shape it cannot show', () => {
  expect(parseHeightPayload(payload([LATEST]))).not.toBeNull();
  expect(parseHeightPayload({ ...payload([LATEST]), ok: false })).toBeNull();
  expect(parseHeightPayload({ ...payload([{ ...LATEST, height_cm: '151.4' }]) })).toBeNull();
  expect(parseHeightPayload({ ...payload([LATEST]), growth: { days: 3 } })).toBeNull();
});

test('a fall between two readings is reported as it is', () => {
  expect(growthSentence({ ...GROWTH, change_cm: -0.4, cm_per_year: -1.6 })).toBe(
    '-0.4 cm since 7/1/2026 (92 days): about -1.6 cm a year.',
  );
});

test('an edited value after a lost reply is a new save, not a reuse of the first key', async () => {
  fetchMock
    .mockResolvedValueOnce(jsonResponse(payload([])))
    .mockRejectedValueOnce(new Error('network'))
    .mockResolvedValueOnce(jsonResponse(payload([])))
    .mockResolvedValueOnce(jsonResponse(payload([LATEST]), 201));
  await renderPanel();
  fireEvent.change(screen.getByLabelText('Height in centimetres'), { target: { value: '150.0' } });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Save height' }));
  });
  fireEvent.change(screen.getByLabelText('Height in centimetres'), { target: { value: '151.0' } });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Save height' }));
  });
  const bodies = postBodies();
  expect(bodies.map((body) => body.height_cm)).toEqual([150, 151]);
  expect(bodies[1].request_key).not.toBe(bodies[0].request_key);
});

test('a server error never claims the height was not saved, and the readings are read again', async () => {
  fetchMock
    .mockResolvedValueOnce(jsonResponse(payload([])))
    .mockResolvedValueOnce(jsonResponse({}, 500))
    .mockResolvedValueOnce(jsonResponse(payload([LATEST])));
  await renderPanel();
  fireEvent.change(screen.getByLabelText('Height in centimetres'), { target: { value: '151.4' } });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Save height' }));
  });
  expect(screen.getByRole('alert').textContent).not.toMatch(/not saved/i);
  expect(fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'GET')).toHaveLength(2);
  expect(screen.getByText(/Height: 151\.4 cm/)).toBeTruthy();
});

test('"already corrected" leaves correcting mode and re-reads the readings', async () => {
  fetchMock
    .mockResolvedValueOnce(jsonResponse(payload([LATEST, OLD], GROWTH)))
    .mockResolvedValueOnce(jsonResponse({ error: 'That reading was already corrected. Reload and correct the newer one.' }, 409))
    .mockResolvedValueOnce(jsonResponse(payload([LATEST, OLD], GROWTH)));
  await renderPanel();
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Correct the 151.4 cm reading of 10/1/2026' }));
  });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Save correction' }));
  });
  expect(screen.getByRole('alert').textContent).toMatch(/already corrected/);
  expect(screen.getByRole('button', { name: 'Save height' })).toBeTruthy();
  expect(fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'GET')).toHaveLength(2);
});

test('cancelling a correction puts the date back to today', async () => {
  fetchMock.mockResolvedValueOnce(jsonResponse(payload([LATEST, OLD], GROWTH)));
  await renderPanel();
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Correct the 140.0 cm reading of 7/1/2026' }));
  });
  expect((screen.getByLabelText('Measured on') as HTMLInputElement).value).toBe('2026-07-01');
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Cancel correction' }));
  });
  expect((screen.getByLabelText('Measured on') as HTMLInputElement).value).not.toBe('2026-07-01');
  expect((screen.getByLabelText('Height in centimetres') as HTMLInputElement).value).toBe('');
});

test('a reply for the previous athlete never lands after the athlete changes', async () => {
  let releaseFirst: (response: Response) => void = () => {};
  fetchMock
    .mockImplementationOnce(() => new Promise<Response>((resolve) => { releaseFirst = resolve; }))
    .mockResolvedValueOnce(jsonResponse(payload([LATEST])));
  let rerender: (ui: ReactElement) => void = () => {};
  await act(async () => {
    ({ rerender } = render(<AthleteGrowthPanel athleteId="ath-1" />));
  });
  await act(async () => {
    rerender(<AthleteGrowthPanel athleteId="ath-2" />);
  });
  expect(screen.getByText(/Height: 151\.4 cm/)).toBeTruthy();
  await act(async () => {
    releaseFirst(jsonResponse(payload([{ ...OLD, height_cm: 120.5, superseded: false }])));
  });
  expect(screen.getByText(/Height: 151\.4 cm/)).toBeTruthy();
  expect(screen.queryByText(/120\.5/)).toBeNull();
});

test('a failed read offers Try again, which reads again', async () => {
  fetchMock
    .mockResolvedValueOnce(jsonResponse({}, 503))
    .mockResolvedValueOnce(jsonResponse(payload([LATEST])));
  await renderPanel();
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  });
  expect(screen.getByText(/Height: 151\.4 cm/)).toBeTruthy();
});
