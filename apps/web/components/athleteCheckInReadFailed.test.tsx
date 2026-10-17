/**
 * @jest-environment jsdom
 */

import '@testing-library/jest-dom';
import { act, fireEvent, render, screen } from '@testing-library/react';

import { useState } from 'react';

import AthleteCheckInPanel, { type AthleteCheckInRecord } from './AthleteCheckInPanel';

// UXB-06: a Wellness read that failed used to replace the panel with one line
// and no way back, and the Floor opens on this check. The form stays, with Try
// again; the server keeps one check-in per athlete per day, so it cannot make
// a second record.

afterEach(() => jest.restoreAllMocks());

test('a failed read says so with Try again, which reads it again, and keeps the form', () => {
  const onRetry = jest.fn();
  render(
    <AthleteCheckInPanel today={null} recent={[]} loading={false} loadError="Your check-in did not load." onRetry={onRetry} onSaved={() => undefined} />,
  );

  expect(screen.getByRole('alert')).toHaveTextContent('Your check-in did not load.');
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  expect(onRetry).toHaveBeenCalledTimes(1);
  // The form is still there to use.
  expect(screen.getByRole('heading', { name: 'Check in' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /check in/i })).toBeEnabled();
});

function Harness() {
  const [today, setToday] = useState<AthleteCheckInRecord | null>(null);
  const [loadError, setLoadError] = useState<string | null>('Your check-in did not load.');
  return (
    <AthleteCheckInPanel
      today={today}
      recent={today ? [today] : []}
      loading={false}
      loadError={loadError}
      onRetry={() => undefined}
      onSaved={(row) => {
        setLoadError(null);
        setToday(row);
      }}
    />
  );
}

const EARLIER = {
  check_in_id: 'ci-1', checked_in_on: '2026-10-17', energy: 4, soreness: null, focus: null, sleep_hours: 8,
  hydration: null, motivation: null, mental_clarity: null, stress: null, nutrition_compliance: null, note: 'from this morning',
};

function answering(alreadyCheckedIn: boolean) {
  global.fetch = jest.fn(async () => ({
    ok: true, status: 200, json: async () => ({ item: EARLIER, already_checked_in: alreadyCheckedIn }),
  }) as unknown as Response) as unknown as typeof fetch;
}

test('already checked in earlier: the athlete is told what they just entered was not saved, and sees the earlier answers', async () => {
  answering(true);
  render(<Harness />);

  fireEvent.change(screen.getByLabelText('How many hours did you sleep?'), { target: { value: '5' } });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /check in/i }));
  });

  expect(screen.getByRole('heading', { name: 'Already checked in today' })).toBeInTheDocument();
  expect(screen.getByRole('status')).toHaveTextContent('what you just entered was not saved');
  // The morning's answers, not the ones just typed (5 hours).
  expect(screen.getByText('Note: from this morning')).toBeInTheDocument();
  expect(screen.getByText('Sleep: 8 hours')).toBeInTheDocument();
  expect(screen.queryByText('Sleep: 5 hours')).toBeNull();
  expect(screen.queryByText('Your check-in did not load.')).toBeNull();
});

test('a first check-in today says nothing about earlier answers', async () => {
  answering(false);
  render(<Harness />);
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /check in/i }));
  });
  expect(screen.getByRole('heading', { name: 'Already checked in today' })).toBeInTheDocument();
  expect(screen.queryByText(/was not saved/)).toBeNull();
});

test('with the form kept, a check-in can still be sent and the stored one is shown', async () => {
  const fetchMock = jest.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ item: { check_in_id: 'ci-1', checked_in_on: '2026-10-17', note: '', sleep_hours: null }, already_checked_in: true }),
  }) as unknown as Response);
  global.fetch = fetchMock as unknown as typeof fetch;
  const onSaved = jest.fn();
  render(
    <AthleteCheckInPanel today={null} recent={[]} loading={false} loadError="Your check-in did not load." onRetry={() => undefined} onSaved={onSaved} />,
  );

  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /check in/i }));
  });
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ check_in_id: 'ci-1' }));
});

test('nothing to read (no athlete record, no retry given) is still a plain statement with no form', () => {
  render(
    <AthleteCheckInPanel
      today={null}
      recent={[]}
      loading={false}
      loadError="This account is not linked to an athlete record, so there is no check-in to show."
      onSaved={() => undefined}
    />,
  );
  expect(screen.getByText(/not linked to an athlete record/)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  expect(screen.queryByRole('heading', { name: 'Check in' })).toBeNull();
});
