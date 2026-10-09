/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';

import AthleteLimitsPage from './page';

// The shell gates on a signed-in role; this page's own behaviour is what is
// under test, so the shell renders its children as given.
jest.mock('@/components/RoleStandaloneView', () => ({
  __esModule: true,
  default: ({ children }: { children: ReactNode }) => <main>{children}</main>,
}));
jest.mock('@/components/WorkAxis', () => ({ __esModule: true, default: () => null }));
jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ children, href }: { readonly children: ReactNode; readonly href: string }) => <a href={href}>{children}</a>,
}));

const ROSTER = [
  { athlete_id: 'ath-mine', full_name: 'Sam Mine' },
  { athlete_id: 'ath-covered', full_name: 'Kai Covered' },
  { athlete_id: 'ath-other', full_name: 'Lee Other' },
];
const NONE = { heat_exposure_minutes_per_session: null, weight_cut_max_percent_body_weight: null, supervision: null };

function respond(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

let calls: Array<{ url: string; init?: RequestInit }>;

function serve(handlers: { roster?: () => Response; allowed?: () => Response } = {}) {
  calls = [];
  global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.endsWith('/api/pilot/athletes/list')) {
      return handlers.roster ? handlers.roster() : respond({ items: ROSTER });
    }
    if (url.endsWith('/api/pilot/coach/athlete-minor-limits') && init?.method === 'POST') {
      return handlers.allowed ? handlers.allowed() : respond({ ok: true, athlete_ids: ['ath-mine', 'ath-covered'] });
    }
    if (url.includes('/api/pilot/coach/athlete-minor-limits')) {
      return respond({ ok: true, athlete_is_minor: true, limits: NONE, history: [] });
    }
    if (url.includes('/api/pilot/coach/athlete-contact-caps')) {
      return respond({ ok: true, cap: null, history: [] });
    }
    return respond({}, 404);
  }) as unknown as typeof fetch;
}

afterEach(() => {
  jest.restoreAllMocks();
});

test('offers only the athletes the limits route will open, asked for by the whole roster', async () => {
  serve();
  render(<AthleteLimitsPage />);
  expect(await screen.findByText('Sam Mine')).toBeTruthy();
  expect(screen.getByText('Kai Covered')).toBeTruthy();
  expect(screen.queryByText('Lee Other')).toBeNull();

  const ask = calls.find((c) => c.init?.method === 'POST');
  expect(ask?.url.endsWith('/api/pilot/coach/athlete-minor-limits')).toBe(true);
  expect(ask?.init?.credentials).toBe('include');
  expect(JSON.parse(String(ask?.init?.body))).toEqual({
    action: 'accessible_athletes',
    athlete_ids: ['ath-mine', 'ath-covered', 'ath-other'],
  });
});

test('each athlete gets a closed limits control, and nothing is read until one is opened', async () => {
  serve();
  render(<AthleteLimitsPage />);
  await screen.findByText('Sam Mine');
  const controls = screen.getAllByRole('button', { name: 'Limits' });
  expect(controls).toHaveLength(2);
  expect(calls.some((c) => c.url.includes('athlete_id='))).toBe(false);

  fireEvent.click(controls[0]);
  await screen.findByText(/Minor — these limits/);
  expect(calls.filter((c) => c.url.includes('athlete-minor-limits?athlete_id=ath-mine'))).toHaveLength(1);
  expect(calls.filter((c) => c.url.includes('athlete-contact-caps?athlete_id=ath-mine'))).toHaveLength(1);
});

test.each([
  ['the roster fails', { roster: () => respond({}, 500) }],
  ['the roster has no items', { roster: () => respond({ ok: true }) }],
  ['the access check fails', { allowed: () => respond({ error: 'no' }, 403) }],
  ['the access check has no list', { allowed: () => respond({ ok: true }) }],
])('when %s, it says the roster could not load -- never "no athletes"', async (_label, handlers) => {
  serve(handlers);
  render(<AthleteLimitsPage />);
  expect(await screen.findByText(/Your roster could not be loaded/)).toBeTruthy();
  expect(screen.queryByText(/No athletes you can set limits for/)).toBeNull();
});

test('an empty allowed list says so plainly', async () => {
  serve({ allowed: () => respond({ ok: true, athlete_ids: [] }) });
  render(<AthleteLimitsPage />);
  expect(await screen.findByText('No athletes you can set limits for.')).toBeTruthy();
});

test('sits on the kiosk surface (Law 5) and links to Sparring Caps and the clearance board', async () => {
  serve();
  render(<AthleteLimitsPage />);
  await waitFor(() => expect(screen.getByText('Sam Mine')).toBeTruthy());
  expect(document.querySelector('[data-surface="kiosk"]')?.querySelector('button')).not.toBeNull();
  expect(screen.getByRole('link', { name: 'Sparring Caps' }).getAttribute('href')).toBe('/coach/sparring-caps');
  expect(screen.getByRole('link', { name: 'Clearance Board' }).getAttribute('href')).toBe('/coach/sports-medicine');
  expect(screen.getByText(/never picks a limit/)).toBeTruthy();
});
