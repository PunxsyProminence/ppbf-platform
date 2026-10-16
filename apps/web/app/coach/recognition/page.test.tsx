/**
 * @jest-environment jsdom
 */

import { act, fireEvent, render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';

import CoachRecognitionPage from './page';

// The recognition room wires the pad to the read-back (audit finding F-071): a
// send reads the open athlete again, and the page's own failed roster read is
// said, not shown as no athletes. The pad and the read-back have their own
// suites; this pins only the wiring.

jest.mock('@/components/RoleSessionGate', () => ({
  __esModule: true,
  default: ({ children }: { readonly children: ReactNode }) => <>{children}</>,
}));
jest.mock('@/components/CoachMilestoneMarker', () => ({ __esModule: true, default: () => null }));
jest.mock('@/components/CoachMentorshipPairing', () => ({ __esModule: true, default: () => null }));
jest.mock('@/components/useGymSound', () => ({
  __esModule: true,
  default: () => ({ enabled: false, ready: false, status: 'off', play: () => false, setEnabled: async () => false }),
}));
jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ children, href }: { readonly children: ReactNode; readonly href: string }) => <a href={href}>{children}</a>,
}));

const ROSTER = [{ athlete_id: 'ath-1', full_name: 'Ada Reyes' }];
const SENT = {
  recognition_id: 'rec-1',
  athlete_id: 'ath-1',
  coach_display_name: 'Coach Dee',
  kind: 'helped_someone',
  note: '',
  created_at: '2026-10-14T16:00:00.000Z',
};

function respond(body: unknown, ok = true): Response {
  return { ok, status: ok ? 200 : 500, json: async () => body } as Response;
}

afterEach(() => jest.restoreAllMocks());

test('a send from the pad reads the picked athlete’s list again, and it shows what was just sent', async () => {
  let sent = false;
  global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/athletes/list')) return respond({ items: ROSTER });
    if (url.includes('/achievements/recognition') && init?.method === 'POST') {
      sent = true;
      return respond({ ok: true, recognition: {} });
    }
    if (url.includes('/achievements/recognition')) return respond({ ok: true, items: sent ? [SENT] : [] });
    return respond({});
  }) as unknown as typeof fetch;

  render(<CoachRecognitionPage />);
  await screen.findByRole('option', { name: 'Ada Reyes' });
  fireEvent.change(screen.getByLabelText('Athlete'), { target: { value: 'ath-1' } });
  await screen.findByText('Nothing has been sent to Ada Reyes yet.');

  fireEvent.click(screen.getByRole('button', { name: 'Ada Reyes' }));
  await act(async () => {
    fireEvent.click(await screen.findByRole('button', { name: 'Helped someone' }));
  });

  const list = await screen.findByRole('list', { name: 'Recognition sent to Ada Reyes, newest first' });
  expect(within(list).getByText('You helped somebody who needed it.')).toBeTruthy();
});

test('a roster the page could not read is said in the read-back, not shown as no athletes', async () => {
  global.fetch = jest.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/athletes/list')) return respond({ error: 'nope' }, false);
    return respond({});
  }) as unknown as typeof fetch;

  render(<CoachRecognitionPage />);
  const section = screen.getByRole('region', { name: 'What has been said to them' });
  await within(section).findByText(/athlete list could not be read/);
  expect(within(section).queryByText('No athletes on your roster.')).toBeNull();
});
