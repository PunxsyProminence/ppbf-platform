/**
 * @jest-environment jsdom
 */

import { act, fireEvent, render, screen } from '@testing-library/react';

import CoachWorkspace from './CoachWorkspace';

jest.mock('./CoachFloorFocus', () => ({ __esModule: true, default: () => null }));

/**
 * The Gym TVs panel on the coach dashboard (lane N1a). Only the mount is
 * CoachWorkspace's: that the panel is there, that it reads nothing until
 * opened (so the dashboard's load is unchanged), and that the live run the
 * dashboard already holds reaches the panel's send control. The panel's own
 * behaviour is GymTvPanel.test.tsx.
 */

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status < 300, status, json: async () => body } as unknown as Response;
}

const LIVE_RUN = {
  run_id: 'run_1',
  script_id: 'scr_1',
  script_version: 3,
  activity_id: null,
  delivered_by_account_id: 'acct_coach_1',
  delivered_on: '2026-08-28',
  athletes_present: 11,
  run_state: 'in_progress',
  started_at: '2026-08-28T22:00:00.000Z',
  ended_at: null,
  current_block_id: 'blk_2',
  paused_at: null,
  paused_seconds: 0,
  elapsed_seconds: 1530,
  is_paused: false,
  show_on_wall: true,
};

let urls: string[];

function installFetch(liveRun: unknown) {
  urls = [];
  global.fetch = jest.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    urls.push(`${init?.method ?? 'GET'} ${url}`);
    if (url.includes('/api/pilot/auth/session')) return jsonResponse({ authenticated: true, account_id: 'acct_coach_1' });
    if (url.includes('/api/pilot/session-scripts/runs')) return jsonResponse({ run: liveRun });
    if (url.includes('/api/pilot/gym-tvs')) {
      return jsonResponse({
        tvs: [{
          tv_id: 'gymtv_1', tv_name: 'Ring wall', status: 'paired', created_by_account_id: 'acct_coach_1',
          created_at: '2026-10-01T12:00:00.000Z', pair_code_expires_at: null, paired_at: '2026-10-01T12:05:00.000Z',
          last_seen_at: '2026-10-08T15:00:00.000Z', revoked_at: null, current_run_id: null, current_run_set_by_account_id: null,
        }],
      });
    }
    // Every other dashboard read answers empty and healthy; none of them is under test here.
    return jsonResponse({ ok: true, items: [], classes: [], athletes: [], reviews: [], escalations: [], painReports: [], barrierReports: [], announcements: [], credentials: [], plans: [], run: null });
  }) as unknown as typeof fetch;
}

afterEach(() => {
  jest.restoreAllMocks();
});

test('the dashboard mounts Gym TVs, which reads nothing until opened', async () => {
  installFetch(null);
  await act(async () => {
    render(<CoachWorkspace />);
  });
  expect(screen.getByRole('region', { name: 'Gym TVs' })).toBeTruthy();
  expect(urls.some((u) => u.includes('/api/pilot/gym-tvs'))).toBe(false);

  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Open Gym TVs' }));
  });
  await screen.findByText('Ring wall');
  expect(urls.filter((u) => u.includes('/api/pilot/gym-tvs'))).toEqual(['GET /api/pilot/gym-tvs']);
  // No session in progress: no send control, and the panel says what is missing.
  expect(screen.queryByRole('button', { name: /Send to TV/ })).toBeNull();
  expect(screen.getByText('Start a session to send it to a TV.')).toBeTruthy();
});

test('the live session the dashboard holds reaches the send control', async () => {
  installFetch(LIVE_RUN);
  await act(async () => {
    render(<CoachWorkspace />);
  });
  await screen.findByText('In progress');
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Open Gym TVs' }));
  });
  await screen.findByText('Ring wall');
  expect(screen.getByRole('button', { name: 'Send to TV Ring wall' })).toBeTruthy();
});
