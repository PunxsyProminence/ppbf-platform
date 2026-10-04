/**
 * @jest-environment jsdom
 */

// Map items 20 and 10: the sleep trend (shared by athlete and coach views)
// and the coach's per-athlete bout history. fetch is faked per URL; the
// components are real.

import { render, screen, waitFor, fireEvent } from '@testing-library/react';

import { CoachAthleteHistory, CoachBoutHistory, CoachSleepTrend, boutOutcomeText, type BoutHistoryItem } from './CoachAthleteRecords';
import SleepTrend, { sleepBarPercent } from './SleepTrend';

const fetchMock = jest.fn();

beforeEach(() => {
  global.fetch = fetchMock as unknown as typeof fetch;
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  fetchMock.mockReset();
  jest.restoreAllMocks();
});

function respond(status: number, body: unknown) {
  return Promise.resolve({ ok: status >= 200 && status < 300, status, json: async () => body });
}

describe('SleepTrend', () => {
  test('shows each day and its hours, newest first, and a skipped night as not answered', () => {
    render(
      <SleepTrend
        heading="Your sleep on recent check-ins"
        items={[
          { checked_in_on: '2026-09-22', sleep_hours: 7.5 },
          { checked_in_on: '2026-09-21', sleep_hours: null },
        ]}
      />,
    );
    const rows = screen.getAllByRole('listitem').map((row) => row.textContent);
    expect(rows).toEqual(['2026-09-227.5 hours', '2026-09-21not answered']);
  });

  test('adds no average, rating or advice', () => {
    const { container } = render(
      <SleepTrend heading="Sleep" items={[{ checked_in_on: '2026-09-22', sleep_hours: 5 }, { checked_in_on: '2026-09-21', sleep_hours: 9 }]} />,
    );
    expect(container.textContent).not.toMatch(/average|mean|good|poor|should|recommend|target|7 hours/i);
  });

  test('empty history says so', () => {
    render(<SleepTrend heading="Sleep" items={[]} />);
    expect(screen.getByText('No check-ins recorded yet.')).toBeTruthy();
  });

  test('the bar is a clamped visual length only', () => {
    expect(sleepBarPercent(0)).toBe(0);
    expect(sleepBarPercent(6)).toBe(50);
    expect(sleepBarPercent(20)).toBe(100);
  });
});

describe('CoachSleepTrend', () => {
  test('reads the sleep-trend route for the selected athlete and draws it', async () => {
    fetchMock.mockImplementation(() => respond(200, { items: [{ checked_in_on: '2026-09-22', sleep_hours: 8 }] }));
    render(<CoachSleepTrend athleteId="ath 1" athleteName="Marisol" />);

    expect(await screen.findByText('8 hours')).toBeTruthy();
    expect(screen.getByText('Sleep on recent check-ins: Marisol')).toBeTruthy();
    expect(fetchMock.mock.calls[0][0]).toContain('/api/pilot/coach/athlete-sleep-trend?athlete_id=ath%201');
  });

  test('a 403 is a no-access sentence, never "no check-ins"', async () => {
    fetchMock.mockImplementation(() => respond(403, { error: 'Forbidden' }));
    render(<CoachSleepTrend athleteId="ath-1" athleteName="Marisol" />);

    expect(await screen.findByText(/don’t have access/)).toBeTruthy();
    expect(screen.queryByText('No check-ins recorded yet.')).toBeNull();
  });
});

const LOSS: BoutHistoryItem = {
  entry_id: 'e-1', competition_name: 'Golden Gloves Regional', competition_date: '2026-09-01',
  competition_status: 'completed', location: 'Altoona', sanctioning_body: 'USA Boxing',
  result: 'lost', lesson_note: 'dropped the right hand',
};

describe('CoachBoutHistory', () => {
  test('lists each bout with outcome and lesson note', async () => {
    fetchMock.mockImplementation(() => respond(200, {
      items: [
        { ...LOSS, entry_id: 'e-2', competition_name: 'Winter Classic', competition_date: '2026-12-01', competition_status: 'planned', result: null, lesson_note: '', location: '', sanctioning_body: '' },
        LOSS,
      ],
    }));
    render(<CoachBoutHistory athleteId="ath-1" athleteName="Marisol" />);

    expect(await screen.findByText('Lesson: dropped the right hand')).toBeTruthy();
    expect(screen.getByText('Bout History: Marisol')).toBeTruthy();
    expect(screen.getByText('2026-09-01 · Golden Gloves Regional · Altoona · USA Boxing')).toBeTruthy();
    expect(screen.getByText('Lost')).toBeTruthy();
    expect(screen.getByText('Entered, not yet fought')).toBeTruthy();
    expect(fetchMock.mock.calls[0][0]).toContain('/api/pilot/coach/athlete-competition-history?athlete_id=ath-1');
  });

  test('no entries says so; a failed read says it failed and can retry', async () => {
    fetchMock.mockImplementationOnce(() => respond(200, { items: [] }));
    const { unmount } = render(<CoachBoutHistory athleteId="ath-1" athleteName="Marisol" />);
    expect(await screen.findByText('No competition entries recorded for this athlete.')).toBeTruthy();
    unmount();

    fetchMock.mockImplementationOnce(() => respond(500, {})).mockImplementationOnce(() => respond(200, { items: [LOSS] }));
    render(<CoachBoutHistory athleteId="ath-1" athleteName="Marisol" />);
    expect(await screen.findByText(/could not be loaded/)).toBeTruthy();
    expect(screen.queryByText('No competition entries recorded for this athlete.')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Try loading the bout history again' }));
    await waitFor(() => expect(screen.getByText('Lost')).toBeTruthy());
  });

  test('outcome wording for every result and for unresolved entries', () => {
    expect(['won', 'lost', 'draw', 'no_contest'].map((result) => boutOutcomeText({ ...LOSS, result } as BoutHistoryItem)))
      .toEqual(['Won', 'Lost', 'Draw', 'No contest']);
    expect(boutOutcomeText({ ...LOSS, result: null, competition_status: 'cancelled' })).toBe('Competition cancelled');
    expect(boutOutcomeText({ ...LOSS, result: null, competition_status: 'completed' })).toBe('No result recorded');
  });
});

describe('CoachAthleteHistory', () => {
  test('draws the sleep trend and bout history as two sections for the one athlete', async () => {
    fetchMock.mockImplementation((url: string) => respond(200, {
      items: url.includes('athlete-sleep-trend') ? [{ checked_in_on: '2026-09-22', sleep_hours: 6 }] : [LOSS],
    }));
    render(<CoachAthleteHistory athleteId="ath-1" athleteName="Marisol" />);

    expect(await screen.findByText('6 hours')).toBeTruthy();
    expect(await screen.findByText('Lost')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Sleep Trend' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Bout History: Marisol' })).toBeTruthy();
    expect(fetchMock.mock.calls.map(([url]) => String(url)).every((url) => url.endsWith('athlete_id=ath-1'))).toBe(true);
  });
});
