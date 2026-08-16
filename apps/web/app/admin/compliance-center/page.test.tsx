/**
 * @jest-environment jsdom
 */

// The register's lifecycle levers. These pin the two ways the buttons could
// mislead an admin: offering an action the server will refuse from the row's
// current state, and claiming success the server never committed.

import type { ReactNode } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

import ComplianceCenterPage from './page';

jest.mock('@/components/RoleStandaloneView', () => ({
  __esModule: true,
  default: ({ children }: { readonly children: ReactNode }) => <div>{children}</div>,
}));

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ children, href }: { readonly children: ReactNode; readonly href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

function violation(overrides: Record<string, unknown> = {}) {
  return {
    violation_id: 'v1',
    rule_id: 'rule-1',
    athlete_id: 'ath-1',
    severity: 'high',
    status: 'new',
    created_at: '2026-08-10T00:00:00.000Z',
    ...overrides,
  };
}

const originalFetch = global.fetch;
const originalPrompt = window.prompt;

afterEach(() => {
  global.fetch = originalFetch;
  window.prompt = originalPrompt;
  jest.clearAllMocks();
});

async function renderWithViolations(items: Array<Record<string, unknown>>, patchResponse?: () => Response) {
  const fetchMock = jest.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'PATCH') {
      return patchResponse
        ? patchResponse()
        : ({ ok: true, json: async () => ({ ok: true }) } as Response);
    }
    return { ok: true, json: async () => ({ items }) } as Response;
  });
  global.fetch = fetchMock as unknown as typeof fetch;

  await act(async () => {
    render(<ComplianceCenterPage />);
  });
  return fetchMock;
}

test('a new violation offers acknowledge, escalate, and dismiss -- not resolve', async () => {
  await renderWithViolations([violation()]);

  expect(screen.getByRole('button', { name: 'Acknowledge' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Escalate' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Dismiss' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Resolve' })).toBeNull();
});

test('an escalated violation offers resolve only -- it comes back down the ladder, never dismissed', async () => {
  await renderWithViolations([violation({ status: 'escalated' })]);

  expect(screen.getByRole('button', { name: 'Resolve' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Acknowledge' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Escalate' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Dismiss' })).toBeNull();
});

test.each(['resolved', 'dismissed'])('a %s violation is terminal: no lifecycle buttons at all', async (status) => {
  await renderWithViolations([violation({ status })]);

  for (const name of ['Acknowledge', 'Escalate', 'Resolve', 'Dismiss']) {
    expect(screen.queryByRole('button', { name })).toBeNull();
  }
});

test('acknowledge PATCHes the violation and needs no reason', async () => {
  const fetchMock = await renderWithViolations([violation()]);

  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Acknowledge' }));
  });

  const patch = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === 'PATCH');
  expect(patch).toBeTruthy();
  expect(JSON.parse(String((patch![1] as RequestInit).body))).toEqual({ violation_id: 'v1', action: 'acknowledge' });
});

test('dismiss with the reason prompt cancelled sends nothing', async () => {
  window.prompt = jest.fn().mockReturnValue(null);
  const fetchMock = await renderWithViolations([violation()]);

  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
  });

  expect(fetchMock.mock.calls.every(([, init]) => (init as RequestInit | undefined)?.method !== 'PATCH')).toBe(true);
});

test('resolve sends the stated reason and reconciles with the server', async () => {
  window.prompt = jest.fn().mockReturnValue('Coach retrained; footage reviewed.');
  const fetchMock = await renderWithViolations([violation({ status: 'acknowledged' })]);

  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Resolve' }));
  });

  const patch = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === 'PATCH');
  expect(JSON.parse(String((patch![1] as RequestInit).body))).toEqual({
    violation_id: 'v1',
    action: 'resolve',
    note: 'Coach retrained; footage reviewed.',
  });
  // Reconciliation: a reload follows the PATCH rather than an optimistic
  // local flip.
  const loads = fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method !== 'PATCH');
  expect(loads.length).toBeGreaterThanOrEqual(2);
});

test("the server's refusal is shown, not swallowed into a fake success", async () => {
  await renderWithViolations(
    [violation({ status: 'acknowledged' })],
    () => ({
      ok: false,
      json: async () => ({ error: 'This violation cannot be resolved from its current state.', status: 'dismissed' }),
    }) as Response,
  );
  window.prompt = jest.fn().mockReturnValue('reason');

  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Resolve' }));
  });

  await waitFor(() => {
    expect(screen.getByText('This violation cannot be resolved from its current state.')).toBeTruthy();
  });
});
