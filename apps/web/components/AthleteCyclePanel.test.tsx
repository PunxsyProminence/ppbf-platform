/**
 * @jest-environment jsdom
 */

import '@testing-library/jest-dom';
import { act, fireEvent, render, screen } from '@testing-library/react';

import AthleteCyclePanel from './AthleteCyclePanel';

// The athlete's private cycle card (OD-2026-10-17-023 item 4): off until the athlete turns it on,
// dates only, every date removable, and turning it off deletes them all after one confirm.

interface View { opted_in: boolean; entries: Array<{ entry_id: string; period_started_on: string }> }

function respond(body: unknown, ok = true): Response {
  return { ok, status: ok ? 200 : 400, json: async () => body } as unknown as Response;
}

function installFetch(initial: View, afterPost: (body: Record<string, unknown>) => Response): jest.Mock {
  const fetchMock = jest.fn(async (_url: string, init?: RequestInit) =>
    init?.method === 'POST' ? afterPost(JSON.parse(String(init.body))) : respond(initial));
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

function posted(fetchMock: jest.Mock): Array<Record<string, unknown>> {
  return fetchMock.mock.calls
    .filter(([, init]) => (init as RequestInit | undefined)?.method === 'POST')
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>);
}

async function renderPanel() {
  await act(async () => { render(<AthleteCyclePanel />); });
}

const ON: View = { opted_in: true, entries: [{ entry_id: 'e-1', period_started_on: '2026-10-01' }] };

afterEach(() => jest.restoreAllMocks());

test('off: says who can see it, asks nothing, and turning on is one tap', async () => {
  const fetchMock = installFetch({ opted_in: false, entries: [] }, () => respond({ opted_in: true, entries: [] }));
  await renderPanel();
  expect(await screen.findByText(/Only you can see this in the app: not your coaches, your parents or the gym TV\./)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'My period started today' })).toBeNull();
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Turn on' })); });
  expect(posted(fetchMock)).toEqual([{ action: 'turn_on' }]);
  expect(await screen.findByRole('button', { name: 'My period started today' })).toBeInTheDocument();
});

test('on: today is one tap, another day is a date, and each date can be removed', async () => {
  const fetchMock = installFetch(ON, () => respond(ON));
  await renderPanel();
  await act(async () => { fireEvent.click(await screen.findByRole('button', { name: 'My period started today' })); });
  fireEvent.change(screen.getByLabelText('It started on another day'), { target: { value: '2026-09-03' } });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Add that day' })); });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: /^Remove / })); });
  expect(posted(fetchMock)).toEqual([
    { action: 'add' },
    { action: 'add', day: '2026-09-03' },
    { action: 'remove', entry_id: 'e-1' },
  ]);
});

test('turning off asks once, then deletes everything; "Keep it on" changes nothing', async () => {
  const fetchMock = installFetch(ON, () => respond({ opted_in: false, entries: [] }));
  await renderPanel();
  fireEvent.click(await screen.findByRole('button', { name: 'Turn off and delete all' }));
  fireEvent.click(screen.getByRole('button', { name: 'Keep it on' }));
  expect(posted(fetchMock)).toEqual([]);

  fireEvent.click(screen.getByRole('button', { name: 'Turn off and delete all' }));
  expect(screen.getByText('Turning this off deletes every date you logged.')).toBeInTheDocument();
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Delete all and turn off' })); });
  expect(posted(fetchMock)).toEqual([{ action: 'turn_off' }]);
  expect(await screen.findByRole('button', { name: 'Turn on' })).toBeInTheDocument();
});

test('shows dates only: no cycle length, phase or prediction', async () => {
  installFetch(ON, () => respond(ON));
  await renderPanel();
  await screen.findByRole('button', { name: 'My period started today' });
  expect(screen.queryByText(/length|phase|next period|predict|days? (late|until)/i)).toBeNull();
});

test('a refused save says why', async () => {
  installFetch(ON, () => respond({ error: 'day cannot be after today.' }, false));
  await renderPanel();
  fireEvent.change(await screen.findByLabelText('It started on another day'), { target: { value: '2999-01-01' } });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Add that day' })); });
  expect(await screen.findByRole('alert')).toHaveTextContent('day cannot be after today.');
});
