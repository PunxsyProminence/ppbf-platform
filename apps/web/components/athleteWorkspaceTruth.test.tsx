/**
 * @jest-environment jsdom
 */

// Audit batch A1 (2026-10-07): three places where the athlete workspace told
// the athlete, or the record, something that was not so.
//   ATH-01   an evening check-in was filed under the UTC day (tomorrow).
//   ATH-02   a failed identity read left Goals on "Loading..." forever.
//   SHADOW-01 "Saved to your SHADOW conversation" was shown when nothing was
//             stored (the AI provider was down; the server answered 200 with
//             state 'degraded' and wrote no row).

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';

jest.mock('next/link', () => ({
  __esModule: true,
  default: function MockLink({ href, children, ...rest }: { href: string; children: React.ReactNode }) {
    return React.createElement('a', { href, ...rest }, children);
  },
}));

import AthleteWorkspace from './AthleteWorkspace';

jest.setTimeout(30000);

type Call = { url: string; method: string; body: Record<string, unknown> };

let calls: Call[] = [];
let identity: 'ok' | 'fails' = 'ok';
let identityReads = 0;
let chatAnswer: { ok: boolean; body: Record<string, unknown> } = { ok: true, body: {} };

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, status: ok ? 200 : 500, json: async () => body } as unknown as Response;
}

function bodyOf(init?: RequestInit): Record<string, unknown> {
  if (typeof init?.body !== 'string') return {};
  try {
    return JSON.parse(init.body) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function posted(path: string): Call[] {
  return calls.filter((call) => call.method === 'POST' && call.url.endsWith(path));
}

beforeEach(() => {
  calls = [];
  identity = 'ok';
  identityReads = 0;
  chatAnswer = { ok: true, body: {} };
  global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? 'GET', body: bodyOf(init) });
    if (url.includes('/api/pilot/auth/session')) {
      identityReads += 1;
      if (identity === 'fails') throw new Error('identity offline');
      return jsonResponse({ authenticated: true, athlete_id: 'ath_test' });
    }
    if (url.includes('/api/pilot/athlete/chat')) return jsonResponse(chatAnswer.body, chatAnswer.ok);
    if (url.includes('/api/pilot/athlete/check-in')) {
      return jsonResponse({ today: { check_in_id: 'ci_test' }, recent: [] });
    }
    if (url.endsWith('/api/pilot/sessions') && init?.method === 'POST') return jsonResponse({ ok: true });
    if (url.includes('/api/pilot/goals/list')) return jsonResponse({ items: [] });
    if (url.includes('/api/pilot/sessions/list')) return jsonResponse({ items: [] });
    return jsonResponse({ ok: true, items: [] });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

async function renderWorkspace() {
  render(<AthleteWorkspace />);
  await act(async () => {
    await Promise.resolve();
  });
}

async function checkInAt(instant: string): Promise<Record<string, unknown>> {
  jest.useFakeTimers({ now: new Date(instant), advanceTimers: true });
  await renderWorkspace();
  const before = posted('/api/pilot/sessions').length;
  fireEvent.click(await screen.findByRole('button', { name: 'Check In' }));
  await waitFor(() => expect(posted('/api/pilot/sessions')).toHaveLength(before + 1));
  return posted('/api/pilot/sessions')[before].body;
}

describe('ATH-01: a check-in is filed under the gym day', () => {
  // 9 pm Eastern (EDT, UTC-4) is 01:00 the next day in UTC.
  test('9 pm Eastern in summer carries that day, not the UTC day', async () => {
    const body = await checkInAt('2026-09-26T01:00:00.000Z');
    expect(body.date).toBe('2026-09-25');
  });

  // 9 pm Eastern (EST, UTC-5) is 02:00 the next day in UTC.
  test('9 pm Eastern in winter carries that day, not the UTC day', async () => {
    const body = await checkInAt('2026-01-16T02:00:00.000Z');
    expect(body.date).toBe('2026-01-15');
  });

  test('a morning check-in still carries its own day', async () => {
    const body = await checkInAt('2026-09-25T14:00:00.000Z');
    expect(body.date).toBe('2026-09-25');
  });
});

describe('ATH-02: a failed identity read is a failed read, not endless loading', () => {
  async function openGoals() {
    fireEvent.click(screen.getByRole('button', { name: 'Development' }));
    const goals = screen.queryByRole('button', { name: 'Goals' });
    if (goals) fireEvent.click(goals);
  }

  test('Goals says it could not load, and the training card does not claim "No sessions"', async () => {
    identity = 'fails';
    await renderWorkspace();
    await openGoals();

    expect(await screen.findByText('Could not load your goals')).toBeTruthy();
    expect(screen.queryByText('Loading your goals...')).toBeNull();
    expect(await screen.findByText('Your card could not be loaded right now.')).toBeTruthy();
    expect(screen.queryByText('No sessions on the card yet')).toBeNull();
    // No athlete id, so no goals read was ever made.
    expect(calls.some((call) => call.url.includes('/api/pilot/goals/list'))).toBe(false);
  });

  test('Retry reads who the athlete is again and then loads the goals', async () => {
    identity = 'fails';
    await renderWorkspace();
    await openGoals();
    expect(await screen.findByText('Could not load your goals')).toBeTruthy();

    // The connection comes back; the athlete presses Retry.
    identity = 'ok';
    const readsBefore = identityReads;
    fireEvent.click(screen.getByRole('button', { name: 'Retry loading goals' }));

    await waitFor(() => expect(identityReads).toBeGreaterThan(readsBefore));
    await waitFor(() => expect(calls.some((call) => call.url.includes('/api/pilot/goals/list'))).toBe(true));
    await waitFor(() => expect(screen.queryByText('Could not load your goals')).toBeNull());
    expect(screen.queryByText('Loading your goals...')).toBeNull();
    expect(await screen.findByText(/Nothing on the board yet/)).toBeTruthy();
  });

  test('a signed-in athlete still sees the normal empty goals state', async () => {
    await renderWorkspace();
    await openGoals();
    expect(await screen.findByText(/Nothing on the board yet/)).toBeTruthy();
    expect(screen.queryByText('Could not load your goals')).toBeNull();
  });
});

describe('SHADOW-01: "Saved" is said only when the server stored the exchange', () => {
  const SAVED = /Saved to your SHADOW conversation/;
  const NOT_SAVED = 'That message was not saved -- SHADOW could not answer right now. Try it again.';

  async function ask(): Promise<HTMLTextAreaElement> {
    await renderWorkspace();
    fireEvent.click(screen.getByRole('button', { name: 'Messages' }));
    const box = (await screen.findByLabelText('Your Question')) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: 'What should I work on?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Ask SHADOW' }));
    await waitFor(() => expect(posted('/api/pilot/athlete/chat')).toHaveLength(1));
    return box;
  }

  test('a stored exchange (ok, with a conversation) says saved and clears the box', async () => {
    chatAnswer = { ok: true, body: { success: true, state: 'ok', conversationId: 'conv_1', messageId: 'msg_1' } };
    const box = await ask();
    expect(await screen.findByText(SAVED)).toBeTruthy();
    expect(box.value).toBe('');
  });

  test('a filtered answer is still a stored exchange', async () => {
    chatAnswer = { ok: true, body: { success: true, state: 'filtered', conversationId: 'conv_1', messageId: 'msg_1' } };
    await ask();
    expect(await screen.findByText(SAVED)).toBeTruthy();
  });

  test('a degraded 200 (provider down, nothing stored) says it was not saved and keeps the draft', async () => {
    chatAnswer = { ok: true, body: { success: false, state: 'degraded', messageId: 'msg_transient' } };
    const box = await ask();
    expect(await screen.findByText(NOT_SAVED)).toBeTruthy();
    expect(screen.queryByText(SAVED)).toBeNull();
    expect(box.value).toBe('What should I work on?');
  });

  test('an ok state with no conversation id is not claimed as saved', async () => {
    chatAnswer = { ok: true, body: { success: true, state: 'ok', messageId: 'msg_transient' } };
    await ask();
    expect(await screen.findByText(NOT_SAVED)).toBeTruthy();
    expect(screen.queryByText(SAVED)).toBeNull();
  });

  test('a refused request keeps its own message', async () => {
    chatAnswer = { ok: false, body: { error: 'Enter a question for SHADOW.' } };
    await ask();
    expect(await screen.findByText('Enter a question for SHADOW.')).toBeTruthy();
    expect(screen.queryByText(SAVED)).toBeNull();
  });
});
