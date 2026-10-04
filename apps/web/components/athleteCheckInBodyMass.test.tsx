/**
 * @jest-environment jsdom
 */

import '@testing-library/jest-dom';
import { act, fireEvent, render, screen } from '@testing-library/react';

import AthleteCheckInPanel from './AthleteCheckInPanel';

// Optional body mass on the athlete's check-in form (elite-boxing item 5).
// Blank is not sent; a number goes with the chosen unit.

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, status: ok ? 200 : 400, json: async () => body } as unknown as Response;
}

function installFetch(): jest.Mock {
  const fetchMock = jest.fn(async () => jsonResponse({ item: { check_in_id: 'ci-1' }, already_checked_in: false }));
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

function sentBody(fetchMock: jest.Mock): Record<string, unknown> {
  const [, init] = fetchMock.mock.calls[0] as [unknown, RequestInit];
  return JSON.parse(String(init.body)) as Record<string, unknown>;
}

async function renderPanel() {
  await act(async () => {
    render(<AthleteCheckInPanel today={null} recent={[]} loading={false} loadError="" onSaved={() => undefined} />);
  });
}

async function submit() {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /check in/i }));
  });
}

afterEach(() => jest.restoreAllMocks());

test('left blank, no body mass is sent', async () => {
  const fetchMock = installFetch();
  await renderPanel();
  await submit();

  expect(sentBody(fetchMock)).not.toHaveProperty('body_mass');
  expect(sentBody(fetchMock)).not.toHaveProperty('body_mass_unit');
});

test('a weight goes in pounds by default', async () => {
  const fetchMock = installFetch();
  await renderPanel();
  fireEvent.change(screen.getByLabelText('Body mass (optional)'), { target: { value: '152.4' } });
  await submit();

  expect(sentBody(fetchMock)).toMatchObject({ body_mass: 152.4, body_mass_unit: 'lb' });
});

test('kilograms can be chosen', async () => {
  const fetchMock = installFetch();
  await renderPanel();
  fireEvent.change(screen.getByLabelText('Body mass (optional)'), { target: { value: '69' } });
  fireEvent.change(screen.getByLabelText('Body mass unit'), { target: { value: 'kg' } });
  await submit();

  expect(sentBody(fetchMock)).toMatchObject({ body_mass: 69, body_mass_unit: 'kg' });
});
