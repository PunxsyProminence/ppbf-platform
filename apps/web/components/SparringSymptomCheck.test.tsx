/**
 * @jest-environment jsdom
 */

import '@testing-library/jest-dom';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

import SparringSymptomCheck from './SparringSymptomCheck';

// The athlete's sparring symptom check (OD-2026-10-17-023 item 1, OD-2026-10-17-029): a flag only.
// It sends what was tapped, shows the one fixed message and the gym's own words after a tick, and
// shows nothing on "How I feel today" unless the next-day check is due.

const AFTER_Q = 'After sparring: do you have any of these right now?';
const NEXT_Q = 'You sparred last time. Do you have any of these today?';

interface Today {
  after_sparring: { symptoms: string[] } | null;
  next_day: { symptoms: string[] } | null;
  after_sparring_due: boolean;
  next_day_due: boolean;
  protocol_text: string;
  recipient_role: string;
}

function today(overrides: Partial<Today> = {}): Today {
  return { after_sparring: null, next_day: null, after_sparring_due: true, next_day_due: false, protocol_text: '', recipient_role: 'coach', ...overrides };
}

function respond(body: unknown, ok = true): Response {
  return { ok, status: ok ? 200 : 500, json: async () => body } as unknown as Response;
}

function installFetch(read: Today, post: (body: Record<string, unknown>) => Response = (body) =>
  respond({ item: { symptoms: body.symptoms }, protocol_text: read.protocol_text, recipient_role: read.recipient_role })): jest.Mock {
  const fetchMock = jest.fn(async (_url: string, init?: RequestInit) =>
    init?.method === 'POST' ? post(JSON.parse(String(init.body))) : respond(read));
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

function posted(fetchMock: jest.Mock): Array<Record<string, unknown>> {
  return fetchMock.mock.calls
    .filter(([, init]) => (init as RequestInit | undefined)?.method === 'POST')
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>);
}

async function renderCheck(context: 'after_sparring' | 'next_day', justCheckedOut = false) {
  await act(async () => {
    render(<SparringSymptomCheck context={context} justCheckedOut={justCheckedOut} />);
  });
}

afterEach(() => jest.restoreAllMocks());

test('on "How I feel today" it shows nothing unless the next-day check is due', async () => {
  installFetch(today({ next_day_due: false }));
  await renderCheck('next_day');
  expect(screen.queryByText(NEXT_Q)).toBeNull();
});

test('when due, nothing is picked, and Send waits for a pick', async () => {
  installFetch(today({ next_day_due: true }));
  await renderCheck('next_day');
  expect(await screen.findByText(NEXT_Q)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: `${NEXT_Q} Headache` })).toHaveAttribute('aria-pressed', 'false');
  expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
});

test('a tick is sent as picked, and the fixed message, the gym words and who was told follow', async () => {
  const fetchMock = installFetch(today({ protocol_text: 'Sit out the rest of the night.' }));
  await renderCheck('after_sparring');
  fireEvent.click(await screen.findByRole('button', { name: `${AFTER_Q} Dizzy or off balance` }));
  fireEvent.click(screen.getByRole('button', { name: `${AFTER_Q} Headache` }));
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Send' })); });

  expect(posted(fetchMock)).toEqual([{ context: 'after_sparring', symptoms: ['dizzy', 'headache'] }]);
  expect(await screen.findByText("Tell your coach now, and follow the gym's rules for head knocks.")).toBeInTheDocument();
  expect(screen.getByText('Sit out the rest of the night.')).toBeInTheDocument();
  expect(screen.getByText('Your coach has been sent this.')).toBeInTheDocument();
  // Nothing scored or counted on screen.
  expect(screen.queryByText(/score|\d+ of \d+|severity/i)).toBeNull();
});

test('"None of these" sends an empty list and shows no message', async () => {
  const fetchMock = installFetch(today());
  await renderCheck('after_sparring');
  fireEvent.click(await screen.findByRole('button', { name: `${AFTER_Q} None of these` }));
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Send' })); });

  expect(posted(fetchMock)).toEqual([{ context: 'after_sparring', symptoms: [] }]);
  await waitFor(() => expect(screen.getByText('Saved: none of these.')).toBeInTheDocument());
  expect(screen.queryByText(/Tell your coach now/)).toBeNull();
});

test('a saved tick is said back with the message; the gym-staff line follows a non-coach recipient', async () => {
  installFetch(today({ after_sparring: { symptoms: ['ringing'] }, after_sparring_due: false, recipient_role: 'organization_admin' }));
  await renderCheck('after_sparring');
  expect(await screen.findByText('You said: Ringing in your ears.')).toBeInTheDocument();
  expect(screen.getByText('Gym staff have been sent this.')).toBeInTheDocument();
  // A tick already sent is not offered again; what was said stays on screen; Back closes the list.
  fireEvent.click(screen.getByRole('button', { name: 'Something else now?' }));
  expect(screen.queryByRole('button', { name: `${AFTER_Q} Ringing in your ears` })).toBeNull();
  expect(screen.getByText('You said: Ringing in your ears.')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Back' }));
  expect(screen.getByRole('button', { name: 'Something else now?' })).toBeInTheDocument();
});

test('the after-sparring check shows nothing when nothing is due and nothing was said today', async () => {
  installFetch(today({ after_sparring_due: false }));
  await renderCheck('after_sparring');
  expect(screen.queryByText(AFTER_Q)).toBeNull();
});

test('right after a sparring check-out, a failed status read still asks the question', async () => {
  global.fetch = jest.fn(async () => respond({ error: 'offline' }, false)) as unknown as typeof fetch;
  await renderCheck('after_sparring', true);
  expect(await screen.findByText(AFTER_Q)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: `${AFTER_Q} Headache` })).toBeInTheDocument();
});

test('a failed status read on "How I feel today" shows nothing (nothing says the athlete sparred)', async () => {
  global.fetch = jest.fn(async () => respond({ error: 'offline' }, false)) as unknown as typeof fetch;
  await renderCheck('next_day');
  expect(screen.queryByText(NEXT_Q)).toBeNull();
});

test('a send that fails says so, and still says to tell the coach', async () => {
  installFetch(today(), () => respond({ error: 'boom' }, false));
  await renderCheck('after_sparring');
  fireEvent.click(await screen.findByRole('button', { name: `${AFTER_Q} Headache` }));
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Send' })); });
  expect(await screen.findByRole('alert')).toHaveTextContent("That was not sent. Tell your coach now, and follow the gym's rules for head knocks.");
});
