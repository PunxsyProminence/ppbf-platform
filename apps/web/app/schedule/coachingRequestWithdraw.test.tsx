/**
 * @jest-environment jsdom
 */

// Parent walk 2026-10-19 item 9: an August coaching request nobody answered
// could not be closed by the family. Jason 2026-10-19, Q4 "A: Family can
// withdraw (Rec.)". The server says which rows a reader may withdraw
// (can_withdraw); the page offers the button on those, and takes two presses.
//
// Pinned on the rendered DOM (jsdom). How it reads on a tablet has not been
// checked (NOT VERIFIED).

import '@testing-library/jest-dom';

import type { ReactNode } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ href, children }: { readonly href: string; readonly children: ReactNode }) => <a href={href}>{children}</a>,
}));

jest.mock('@/components/RoleSessionGate', () => ({
  __esModule: true,
  default: ({ children }: { readonly children: ReactNode }) => <>{children}</>,
}));

import SchedulerPage from './page';

const NOON = Date.parse('2026-10-14T16:00:00.000Z');
const DAY = 24 * 3600 * 1000;

function request(id: string, status: string, goals: string, canWithdraw: boolean) {
  return {
    request_id: id,
    athlete_id: 'athlete-1',
    preferred_at: new Date(NOON - 60 * DAY).toISOString(),
    goals,
    status,
    can_withdraw: canWithdraw,
    created_at: new Date(NOON - 61 * DAY).toISOString(),
  };
}

let posts: unknown[] = [];

function install(rows: ReturnType<typeof request>[]) {
  posts = [];
  global.fetch = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const json = (body: unknown) => Promise.resolve({ ok: true, json: () => Promise.resolve(body) } as Response);
    if (url.endsWith('/api/pilot/auth/session')) return json({ authenticated: true, role: 'parent', athlete_id: null });
    if (url.endsWith('/api/pilot/athletes/list')) return json({ items: [{ athlete_id: 'athlete-1', full_name: 'Jordan Price' }] });
    if (url.endsWith('/api/pilot/scheduler')) {
      if (init?.method === 'POST') {
        posts.push(JSON.parse(String(init.body)));
        return json({ ok: true, request_id: 'old', status: 'withdrawn' });
      }
      return json({ ok: true, role: 'parent', classes: [], registrations: [], coaching_requests: rows, attendance: [] });
    }
    if (url.includes('/api/pilot/')) return json({ ok: true, items: [] });
    throw new Error(`Unexpected fetch: ${url}`);
  }) as unknown as typeof fetch;
}

async function renderPage() {
  await act(async () => {
    render(<SchedulerPage />);
  });
  await screen.findByText('Coaching Requests');
}

function rowFor(goals: string): HTMLElement {
  const row = screen.getByText(goals).closest('.input');
  if (!row) throw new Error(`no request row for ${goals}`);
  return row as HTMLElement;
}

beforeEach(() => {
  jest.spyOn(Date, 'now').mockReturnValue(NOON);
});

afterEach(() => {
  jest.restoreAllMocks();
});

test('a family withdraws a pending request with two presses', async () => {
  install([request('old', 'pending', 'Footwork before the August show', true)]);
  await renderPage();

  const button = () => rowFor('Footwork before the August show').querySelector('button') as HTMLButtonElement;
  expect(button()).toHaveTextContent('Withdraw request');

  await act(async () => {
    fireEvent.click(button());
  });
  expect(posts).toEqual([]);
  expect(button()).toHaveTextContent('Press again to withdraw');

  await act(async () => {
    fireEvent.click(button());
  });
  expect(posts).toEqual([{ action: 'withdraw_coaching_request', request_id: 'old' }]);
});

test('no button where the server says the reader may not withdraw, or the request is settled', async () => {
  install([
    request('theirs', 'pending', 'Southpaw sparring prep', false),
    request('gone', 'withdrawn', 'Extra conditioning', true),
  ]);
  await renderPage();

  expect(rowFor('Southpaw sparring prep').querySelector('button')).toBeNull();
  expect(rowFor('Extra conditioning').querySelector('button')).toBeNull();
  expect(rowFor('Extra conditioning')).toHaveTextContent('Status: Withdrawn');
});
