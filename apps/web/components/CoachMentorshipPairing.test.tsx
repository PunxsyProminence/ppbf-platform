/**
 * @jest-environment jsdom
 */

// Mentorship pairing. What this pins: a pairings read that failed is said to
// have failed, never shown as "Nothing yet for this athlete".

import { act, fireEvent, render, screen } from '@testing-library/react';

import CoachMentorshipPairing from './CoachMentorshipPairing';

const ROSTER = [
  { athlete_id: 'a1', full_name: 'Jordan P.' },
  { athlete_id: 'a2', full_name: 'Casey S.' },
];

function mockFetch(ok: boolean) {
  return jest.fn(async () => (ok
    ? { ok: true, json: async () => ({ items: [] }) }
    : { ok: false, status: 500, json: async () => ({}) }) as Response) as unknown as typeof fetch;
}

afterEach(() => {
  jest.restoreAllMocks();
});

async function pickMentor() {
  render(<CoachMentorshipPairing roster={ROSTER} />);
  await act(async () => {
    fireEvent.change(screen.getByLabelText('Mentor'), { target: { value: 'a1' } });
  });
}

test('a pairings read that succeeds empty says nothing yet', async () => {
  global.fetch = mockFetch(true);
  await pickMentor();
  expect(await screen.findByText('Nothing yet for this athlete.')).toBeTruthy();
  expect(screen.queryByTestId('pairings-unreadable')).toBeNull();
});

test('a failed pairings read says so and never claims nothing yet', async () => {
  global.fetch = mockFetch(false);
  await pickMentor();
  expect(await screen.findByTestId('pairings-unreadable')).toBeTruthy();
  expect(screen.queryByText('Nothing yet for this athlete.')).toBeNull();
});
