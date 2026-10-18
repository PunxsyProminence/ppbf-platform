/**
 * @jest-environment jsdom
 */

import '@testing-library/jest-dom';
import { act, fireEvent, render, screen } from '@testing-library/react';

import AthleteCheckInPanel, { type AthleteCheckInRecord } from './AthleteCheckInPanel';

// Mood and stress on the short "How I feel today" form (Jason 2026-10-18,
// "Mood + stress (Rec.)"): asked without pressing "+ Add more detail", sent
// only when picked, and read back in the words the athlete picked.

const MOOD_Q = 'How is your mood?';
const STRESS_Q = 'How stressed do you feel?';

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
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

async function renderPanel(today: AthleteCheckInRecord | null = null) {
  await act(async () => {
    render(<AthleteCheckInPanel today={today} recent={[]} loading={false} loadError="" onSaved={() => undefined} />);
  });
}

async function submit() {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /save how i feel/i }));
  });
}

afterEach(() => jest.restoreAllMocks());

test('mood and stress are on the short form, before "+ Add more detail"', async () => {
  await renderPanel();
  expect(screen.getByRole('button', { name: '+ Add more detail' })).toHaveAttribute('aria-expanded', 'false');
  for (const [question, anchors] of [
    [MOOD_Q, ['Really down', 'Low', 'Okay', 'Good', 'Great']],
    [STRESS_Q, ['Not stressed', 'A little', 'Some', 'Stressed', 'Very stressed']],
  ] as const) {
    anchors.forEach((anchor, index) => {
      expect(screen.getByRole('button', { name: `${question} ${index + 1}: ${anchor}` })).toHaveAttribute('aria-pressed', 'false');
    });
  }
  // Still behind "+ Add more detail".
  expect(screen.queryByText('How focused do you feel?')).toBeNull();
});

test('motivation is behind "+ Add more detail": the short form is sleep, energy, soreness, mood, stress', async () => {
  await renderPanel();
  const shortForm = screen.getAllByRole('group').map((group) => group.querySelector('legend')?.textContent);
  expect(shortForm).toEqual(['How much energy do you have?', 'How sore are you?', MOOD_Q, STRESS_Q]);
  expect(screen.getByLabelText('How many hours did you sleep?')).toBeInTheDocument();
  expect(screen.queryByText('How much do you want to train today?')).toBeNull();

  fireEvent.click(screen.getByRole('button', { name: '+ Add more detail' }));
  expect(screen.getByText('How much do you want to train today?')).toBeInTheDocument();
});

test('a motivation answer given in the detail is still sent under its own name', async () => {
  const fetchMock = installFetch();
  await renderPanel();
  fireEvent.click(screen.getByRole('button', { name: '+ Add more detail' }));
  fireEvent.click(screen.getByRole('button', { name: 'How much do you want to train today? 4: Want to' }));
  await submit();
  expect(sentBody(fetchMock)).toEqual({ motivation: 4 });
});

test('picked answers are sent under their own names; skipped ones are not sent at all', async () => {
  const fetchMock = installFetch();
  await renderPanel();
  fireEvent.click(screen.getByRole('button', { name: `${MOOD_Q} 4: Good` }));
  await submit();
  expect(sentBody(fetchMock)).toEqual({ mood: 4 });

  fetchMock.mockClear();
  fireEvent.click(screen.getByRole('button', { name: `${STRESS_Q} 2: A little` }));
  await submit();
  expect(sentBody(fetchMock)).toEqual({ mood: 4, stress: 2 });
});

test('a saved check-in reads mood back in the words picked', async () => {
  const stored: AthleteCheckInRecord = {
    check_in_id: 'ci-1', checked_in_on: '2026-10-17', energy: null, soreness: null, focus: null,
    sleep_hours: null, hydration: null, motivation: null, mental_clarity: null, stress: null,
    nutrition_compliance: null, mood: 2, note: '',
  };
  await renderPanel(stored);
  expect(screen.getByText(`${MOOD_Q} Low`)).toBeInTheDocument();
});
