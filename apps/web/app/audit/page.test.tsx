/**
 * @jest-environment jsdom
 */

// The page shipped with five invented events -- named users, plausible
// objects, "Approved"/"Pending" statuses -- and called itself ready. An audit
// trail that shows anything other than what was recorded is worse than no
// audit trail, so these tests pin the three states it must tell apart.

import type { ReactNode } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';

import AuditTracePage from './page';

jest.mock('@/components/RoleSessionGate', () => ({
  __esModule: true,
  default: ({ children }: { readonly children: ReactNode }) => children,
}));

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ children, href }: { readonly children: ReactNode; readonly href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, json: async () => body } as Response;
}

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  jest.clearAllMocks();
});

async function renderPage(fetchMock: jest.Mock) {
  global.fetch = fetchMock as unknown as typeof fetch;
  await act(async () => {
    render(<AuditTracePage />);
  });
  return fetchMock;
}

function auditCalls(fetchMock: jest.Mock): unknown[][] {
  return fetchMock.mock.calls.filter((call) => String(call[0]).includes('/api/pilot/audit/get'));
}

test('reads the real audit endpoint and renders what it returned', async () => {
  const fetchMock = await renderPage(
    jest.fn(async () =>
      jsonResponse({
        ok: true,
        events: [
          {
            audit_id: 12,
            event_type: 'create',
            actor_account_id: 'coach-1',
            actor_role: 'coach',
            entity_type: 'announcement',
            entity_id: 'ann-1',
            details: { placement: 'gym_notices' },
            created_at: '2026-07-30T12:00:00.000Z',
          },
        ],
      }),
    ),
  );

  expect(auditCalls(fetchMock)).toHaveLength(1);
  expect(screen.getByText('ann-1')).toBeTruthy();
  expect(screen.getByText('coach-1')).toBeTruthy();

  // None of the fabricated timeline survives.
  expect(screen.queryByText(/Coach Ramos/)).toBeNull();
  expect(screen.queryByText(/Southpaw Footwork Progression Concept/)).toBeNull();
  expect(screen.queryByText(/Governance Review/)).toBeNull();
});

test('an empty trail says so, and says nothing more', async () => {
  await renderPage(jest.fn(async () => jsonResponse({ ok: true, events: [] })));

  expect(screen.getByText(/No audit events have been recorded/i)).toBeTruthy();
  expect(screen.queryByText(/could not be loaded/i)).toBeNull();
});

test('a failed load never looks like an empty trail, and offers a retry that refetches', async () => {
  const fetchMock = await renderPage(jest.fn(async () => jsonResponse({}, false)));

  expect(screen.queryByText(/No audit events have been recorded/i)).toBeNull();
  expect(screen.getByText(/nothing being read/i)).toBeTruthy();

  expect(auditCalls(fetchMock)).toHaveLength(1);
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Retry loading the audit trail' }));
  });
  expect(auditCalls(fetchMock)).toHaveLength(2);
});

test('a rejected request is reported as a failed read, not as no activity', async () => {
  await renderPage(
    jest.fn(async () => {
      throw new Error('offline');
    }),
  );

  expect(screen.queryByText(/No audit events have been recorded/i)).toBeNull();
  expect(screen.getByText(/nothing being read/i)).toBeTruthy();
});
