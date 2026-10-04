/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';

import SparringCapsPage from './page';

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

function respond(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

let calls: Array<{ url: string; init?: RequestInit }>;

function serve(handlers: {
  roster?: () => Response;
  allowed?: () => Response;
  caps?: () => Response;
} = {}) {
  calls = [];
  global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.endsWith('/api/pilot/athletes/list')) {
      return handlers.roster ? handlers.roster() : respond({ items: ROSTER });
    }
    if (url.endsWith('/api/pilot/coach/athlete-contact-caps') && init?.method === 'POST') {
      return handlers.allowed ? handlers.allowed() : respond({ ok: true, athlete_ids: ['ath-mine', 'ath-covered'] });
    }
    if (url.includes('/api/pilot/coach/athlete-contact-caps')) {
      return handlers.caps ? handlers.caps() : respond({ ok: true, cap: null, history: [] });
    }
    return respond({}, 404);
  }) as unknown as typeof fetch;
}

afterEach(() => {
  jest.restoreAllMocks();
});

test('offers only the athletes the cap route will open, asked for by the whole roster', async () => {
  serve();
  render(<SparringCapsPage />);
  expect(await screen.findByText('Sam Mine')).toBeTruthy();
  expect(screen.getByText('Kai Covered')).toBeTruthy();
  expect(screen.queryByText('Lee Other')).toBeNull();

  const ask = calls.find((c) => c.init?.method === 'POST');
  expect(ask?.url.endsWith('/api/pilot/coach/athlete-contact-caps')).toBe(true);
  expect(ask?.init?.credentials).toBe('include');
  expect(JSON.parse(String(ask?.init?.body))).toEqual({
    action: 'accessible_athletes',
    athlete_ids: ['ath-mine', 'ath-covered', 'ath-other'],
  });
});

test('each athlete gets a closed cap control, and no cap is read until one is opened', async () => {
  serve();
  render(<SparringCapsPage />);
  await screen.findByText('Sam Mine');
  const controls = screen.getAllByRole('button', { name: 'Sparring cap' });
  expect(controls).toHaveLength(2);
  expect(calls.some((c) => c.url.includes('athlete_id='))).toBe(false);

  fireEvent.click(controls[0]);
  await screen.findByText(/No cap set/);
  expect(calls.filter((c) => c.url.includes('athlete_id=ath-mine'))).toHaveLength(1);
});

test.each([
  ['the roster fails', { roster: () => respond({}, 500) }],
  ['the roster has no items', { roster: () => respond({ ok: true }) }],
  ['the access check fails', { allowed: () => respond({ error: 'no' }, 403) }],
  ['the access check has no list', { allowed: () => respond({ ok: true }) }],
])('when %s, it says the roster could not load -- never "no athletes"', async (_label, handlers) => {
  serve(handlers);
  render(<SparringCapsPage />);
  expect(await screen.findByText(/Your roster could not be loaded/)).toBeTruthy();
  expect(screen.queryByText(/No athletes you can set caps for/)).toBeNull();
});

test('an empty allowed list says so plainly', async () => {
  serve({ allowed: () => respond({ ok: true, athlete_ids: [] }) });
  render(<SparringCapsPage />);
  expect(await screen.findByText('No athletes you can set caps for.')).toBeTruthy();
});

test('links back to the clearance board and promises no block', async () => {
  serve();
  render(<SparringCapsPage />);
  await waitFor(() => expect(screen.getByText('Sam Mine')).toBeTruthy());
  expect(screen.getByRole('link', { name: 'Clearance Board' }).getAttribute('href')).toBe('/coach/sports-medicine');
  expect(screen.getByText(/never blocks sparring/)).toBeTruthy();
});
