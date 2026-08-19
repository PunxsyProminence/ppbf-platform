/**
 * @jest-environment jsdom
 */

// A second file rather than more cases in page.test.tsx: that one runs in the
// default 'node' environment on purpose (its own header explains why -- it
// imports escalationLadder.ts, which pulls in 'pg' at module scope, and 'pg'
// dies under this repo's jsdom environment). A jest environment is chosen per
// FILE by docblock, so rendering this page needs its own.
//
// What these pin: the resolution note -- the durable record of why a red flag
// about a child was closed -- is taken in the room, in a real dialog, and
// never in window.prompt(); an empty one refuses without closing anything; and
// a failed read does not wear the red this room reserves for a medical or
// safeguarding fact.

import type { ReactNode } from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import EscalationsPage from './page';

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

function jsonResponse(body: unknown, ok = true) {
  return { ok, json: async () => body } as Response;
}

const ESCALATION = {
  escalation_id: 'esc-1',
  source_type: 'pain_report' as const,
  athlete_id: 'ath-1',
  severity: 'critical' as const,
  reason: 'Reported pain in the same joint three sessions running.',
  status: 'open' as const,
  escalated_to_role: 'organization_admin',
  created_at: '2026-08-10T12:00:00.000Z',
};

const originalFetch = global.fetch;
const originalPrompt = window.prompt;

afterEach(() => {
  global.fetch = originalFetch;
  window.prompt = originalPrompt;
  jest.clearAllMocks();
});

/**
 * The page reads its own role through a POST to the session route, so an admin
 * board needs that answered before Resolve is offered at all.
 */
function mockAdminFetch(options: { escalations?: unknown[]; listOk?: boolean; post?: () => Response } = {}) {
  const posted: Array<Record<string, unknown>> = [];
  const fetchMock = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/auth/session')) {
      return jsonResponse({ ok: true, role: 'admin' });
    }
    if (init?.method === 'POST') {
      posted.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      if (options.post) return options.post();
      return jsonResponse({ ok: true });
    }
    if (options.listOk === false) {
      return jsonResponse({ error: 'Unable to load escalations.' }, false);
    }
    return jsonResponse({ ok: true, escalations: options.escalations ?? [ESCALATION] });
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  return { posted };
}

async function openResolveDialog() {
  await screen.findByText('Reported pain in the same joint three sessions running.');
  const resolve = await screen.findByRole('button', { name: 'Resolve' });
  fireEvent.click(resolve);
  return screen.findByRole('dialog');
}

test('resolving asks for the durable reason in the room, never in browser chrome', async () => {
  window.prompt = jest.fn();
  const harness = mockAdminFetch();

  render(<EscalationsPage />);
  const dialog = await openResolveDialog();

  expect(dialog.getAttribute('aria-modal')).toBe('true');
  expect(within(dialog).getByRole('heading', { name: 'Close this escalation' })).toBeTruthy();

  fireEvent.change(within(dialog).getByRole('textbox'), {
    target: { value: 'Seen by the office; hold placed and guardian called.' },
  });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Resolve' }));

  await waitFor(() => expect(screen.getByText('Escalation resolved.')).toBeTruthy());
  expect(harness.posted).toEqual([
    {
      action: 'resolve',
      escalation_id: 'esc-1',
      resolution_note: 'Seen by the office; hold placed and guardian called.',
    },
  ]);
  expect(window.prompt).not.toHaveBeenCalled();
});

test('an empty resolution note closes nothing and says so inside the dialog', async () => {
  window.prompt = jest.fn();
  const harness = mockAdminFetch();

  render(<EscalationsPage />);
  const dialog = await openResolveDialog();

  fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: '   ' } });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Resolve' }));

  const stillOpen = await screen.findByRole('dialog');
  expect(within(stillOpen).getByText(/needs a stated reason/)).toBeTruthy();
  expect(harness.posted).toHaveLength(0);
});

test('cancelling the dialog resolves nothing', async () => {
  window.prompt = jest.fn();
  const harness = mockAdminFetch();

  render(<EscalationsPage />);
  const dialog = await openResolveDialog();

  fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));

  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(harness.posted).toHaveLength(0);
  expect(window.prompt).not.toHaveBeenCalled();
});

test('a queue that would not load is not stamped as a medical emergency', async () => {
  mockAdminFetch({ listOk: false });

  render(<EscalationsPage />);

  const alert = await screen.findByRole('alert');
  expect(alert.className).toContain('alert--warning');
  expect(alert.className).not.toContain('alert--critical');
  // Law 3: the glyph and the uppercase label carry it, never the colour alone.
  expect(within(alert).getByText('Attention')).toBeTruthy();
  expect(within(alert).getByText('Unable to load escalations.')).toBeTruthy();
});
