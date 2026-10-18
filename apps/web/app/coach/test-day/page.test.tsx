/**
 * @jest-environment jsdom
 */

/*
 * The test-day screen (OD-2026-10-17-026). The route decides who may record for whom
 * (route.test.ts, testDay.pg.test.ts). Pinned here: only the athletes the route will record for
 * are offered; a blank box sends nothing and an all-blank athlete is left off; a typed non-number
 * is caught before anything is sent; a retry after an unknown outcome reuses the save key and an
 * edited form does not; a confirmed save clears the boxes; a refusal says nothing was saved, an
 * unknown outcome never does; cells an earlier press saved are named.
 */

import { act, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';

import TestDayPage from './page';

jest.mock('@/components/RoleStandaloneView', () => ({
  __esModule: true,
  default: ({ children }: { readonly children: ReactNode }) => <div>{children}</div>,
}));

const ROSTER = [
  { athlete_id: 'ath-1', full_name: 'Ana Boxer' },
  { athlete_id: 'ath-2', full_name: 'Ben Boxer' },
  { athlete_id: 'ath-3', full_name: 'Not Yours' },
];

function respond(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

let saveAnswers: Array<Response | Error>;
let fetchMock: jest.Mock;

beforeEach(() => {
  saveAnswers = [];
  fetchMock = jest.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/api/pilot/athletes/list')) return respond(200, { items: ROSTER });
    if (url.includes('/api/pilot/coach/test-day')) {
      const body = JSON.parse(String(init?.body ?? '{}'));
      if (body.action === 'accessible_athletes') return respond(200, { ok: true, athlete_ids: ['ath-1', 'ath-2'] });
      const next = saveAnswers.shift();
      if (next instanceof Error) throw next;
      return next ?? respond(201, { ok: true, written: 1, already_saved: 0, earlier_not_on_form: [] });
    }
    return respond(404, {});
  });
  global.fetch = fetchMock as unknown as typeof fetch;
});

async function renderPage() {
  await act(async () => {
    render(<TestDayPage />);
  });
}

function type(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

async function pressSave() {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Save test day' }));
  });
}

function saves(): Array<Record<string, unknown>> {
  return fetchMock.mock.calls
    .filter(([url, init]) => String(url).includes('/api/pilot/coach/test-day')
      && JSON.parse(String((init as RequestInit).body)).action === undefined)
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)));
}

test('offers only the athletes the route will record for', async () => {
  await renderPage();
  expect(screen.getByText('Ana Boxer')).toBeTruthy();
  expect(screen.getByText('Ben Boxer')).toBeTruthy();
  expect(screen.queryByText('Not Yours')).toBeNull();
});

test('a roster that cannot be read is never shown as "no athletes"', async () => {
  fetchMock.mockImplementationOnce(async () => respond(500, {}));
  await renderPage();
  expect(screen.getByRole('alert').textContent).toMatch(/could not be loaded/);
  expect(screen.queryByText(/No athletes/)).toBeNull();
});

test('a blank box sends nothing and an all-blank athlete is left off', async () => {
  await renderPage();
  type('Ana Boxer: Height (cm)', '151.4');
  type('Ana Boxer: Shuttle level', '7');
  type('Ana Boxer: Shuttle', '4');
  await pressSave();
  const [body] = saves();
  expect(body.rows).toEqual([{ athlete_id: 'ath-1', height_cm: 151.4, shuttle_level: 7, shuttle_number: 4 }]);
  expect(body.administered_on).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  expect(typeof body.request_key).toBe('string');
});

test('a typed non-number is caught on the screen and nothing is sent', async () => {
  await renderPage();
  type('Ben Boxer: CMJ (cm)', '31,5');
  await pressSave();
  expect(screen.getByRole('alert').textContent).toBe('Ben Boxer: "31,5" in CMJ (cm) is not a number. Nothing was sent.');
  expect(saves()).toHaveLength(0);
});

test('nothing filled in sends nothing', async () => {
  await renderPage();
  await pressSave();
  expect(screen.getByRole('alert').textContent).toBe('Fill in at least one box first.');
  expect(saves()).toHaveLength(0);
});

test('a retry after a lost reply reuses the key, never claims "not saved", and a confirmed save clears the boxes', async () => {
  saveAnswers = [new Error('network'), respond(201, { ok: true, written: 1, already_saved: 0, earlier_not_on_form: [] })];
  await renderPage();
  type('Ana Boxer: Height (cm)', '151.4');
  await pressSave();
  expect(screen.getByRole('alert').textContent).toMatch(/may or may not have saved/);
  expect(screen.getByRole('alert').textContent).not.toMatch(/Nothing was saved/);
  await pressSave();
  expect(screen.getByRole('status').textContent).toMatch(/Saved 1 result\./);
  expect((screen.getByLabelText('Ana Boxer: Height (cm)') as HTMLInputElement).value).toBe('');
  const [first, second] = saves();
  expect(second.request_key).toBe(first.request_key);
});

test('an edited form after a lost reply is a new save', async () => {
  saveAnswers = [respond(502, {}), respond(201, { ok: true, written: 1, already_saved: 0, earlier_not_on_form: [] })];
  await renderPage();
  type('Ana Boxer: Height (cm)', '151.4');
  await pressSave();
  type('Ana Boxer: Height (cm)', '152.4');
  await pressSave();
  const [first, second] = saves();
  expect(second.request_key).not.toBe(first.request_key);
});

test('a refusal says nothing was saved, in the server\'s words, and the next press is a new save', async () => {
  saveAnswers = [respond(400, { error: 'The shuttle level must be a whole number from 1 to 21.' })];
  await renderPage();
  type('Ana Boxer: Shuttle level', '22');
  type('Ana Boxer: Shuttle', '1');
  await pressSave();
  expect(screen.getByRole('alert').textContent).toBe('The shuttle level must be a whole number from 1 to 21.');
  type('Ana Boxer: Shuttle level', '21');
  await pressSave();
  const [first, second] = saves();
  expect(second.request_key).not.toBe(first.request_key);
});

test('cells an earlier press saved that this form no longer carries are named', async () => {
  saveAnswers = [respond(201, {
    ok: true,
    written: 0,
    already_saved: 2,
    earlier_not_on_form: [{ athlete_id: 'ath-1', measure: 'ppbf-jump-cmj-height' }],
  })];
  await renderPage();
  type('Ana Boxer: Height (cm)', '151.4');
  await pressSave();
  const status = screen.getByRole('status').textContent ?? '';
  expect(status).toMatch(/Saved 0 results\. 2 were already saved from an earlier press\./);
  expect(status).toMatch(/Ana Boxer: CMJ/);
});
