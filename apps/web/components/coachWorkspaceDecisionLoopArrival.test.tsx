/**
 * @jest-environment jsdom
 */

// #1474 item 5, the workspace's half: the floor's pain report hands the
// report's own athlete to the Decision Loop when the coach follows "Record
// what you did". coachFloorFocus.test.tsx pins the link itself; this pins
// that the workspace puts the report's athlete on it.

import type { ReactNode } from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';

import CoachWorkspace from './CoachWorkspace';
import { takeArrivalAthlete } from './decisionLoopArrival';

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ href, children, onClick, ...rest }: { href: string; children: ReactNode; onClick?: (event: unknown) => void }) => (
    <a
      href={href}
      {...rest}
      onClick={(event) => {
        onClick?.(event);
        event.preventDefault();
      }}
    >
      {children}
    </a>
  ),
}));

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

const HEALTHY_EMPTY = {
  ok: true, authenticated: true, account_id: 'acct_coach_1', items: [], queue: [], run: null,
  classes: [], goals: [], activities: [], marks: [], covered: [], announcements: [],
  painReports: [], barrierReports: [], escalations: [], windowDays: 14, truncated: false,
};

jest.setTimeout(20000);

afterEach(() => {
  takeArrivalAthlete();
  jest.restoreAllMocks();
});

test('following a pain report\'s "Record what you did" hands that report\'s athlete over', async () => {
  global.fetch = jest.fn(async (input: unknown) => {
    const url = String(input);
    if (url.includes('/api/pilot/athletes/list')) {
      return jsonResponse({ items: [{ athlete_id: 'ath_1', full_name: 'Jordan P.' }, { athlete_id: 'ath_7', full_name: 'Casey R.' }] });
    }
    if (url.includes('/api/pilot/coach/pain-reports')) {
      return jsonResponse({
        ok: true, windowDays: 14, truncated: false,
        painReports: [{
          nearMissId: 'nm_1', athleteId: 'ath_7', athleteName: 'Casey R.', severity: 'moderate', painScore: 2,
          location: 'Calf', painType: null, observedAt: null, recordedAt: '2026-10-11T18:00:00.000Z', reporter: 'athlete',
        }],
      });
    }
    return jsonResponse(HEALTHY_EMPTY);
  }) as unknown as typeof fetch;
  await act(async () => {
    render(<CoachWorkspace />);
  });

  const floor = within(await screen.findByRole('region', { name: 'The floor' }));
  fireEvent.click(await floor.findByRole('button', { name: 'Open' }));
  const link = floor.getByRole('link', { name: 'Record what you did' });
  expect(link.getAttribute('href')).toBe('/coach/decision-loop');

  fireEvent.click(link);
  expect(takeArrivalAthlete()).toBe('ath_7');
});
