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
// a failed read does not wear the --locked red this room keeps for a medical
// or safeguarding fact (red itself is not reserved, OD-2026-09-29-001).

import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { ReactNode } from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import EscalationsPage from './page';
import { ARM_SETTLE_MS } from '@/components/ArmedButton';
import { clearRoleSession, createPersistentRoleSession } from '@/components/roleSession';
import {
  CLEARANCE_BOARD_PAGE,
  DECISION_LOOP_PAGE,
  takeArrivalAthlete,
} from '@/components/decisionLoopArrival';

jest.mock('@/components/RoleSessionGate', () => ({
  __esModule: true,
  default: ({ children }: { readonly children: ReactNode }) => children,
}));

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ children, href, onClick }: { readonly children: ReactNode; readonly href: string; readonly onClick?: (event: MouseEvent) => void }) => (
    <a href={href} onClick={(event) => { event.preventDefault(); onClick?.(event.nativeEvent); }}>{children}</a>
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

// The list under the tiles already said "unavailable, not empty" after a failed
// read. The three tiles above it did not: the catch empties `items`, so they
// counted that empty array and read Critical 0 / High 0 / Total 0.
// Pain reports have their own tile (#1528 Q3).
function tileValues() {
  return ['Critical (this view)', 'High (this view)', 'Pain reports (this view)', 'Total (this view)'].map(
    (label) => screen.getByText(label).parentElement?.textContent?.replace(label, ''),
  );
}

test.each<[string, () => Promise<Response>]>([
  ['answers non-ok', async () => jsonResponse({ error: 'Unable to load escalations.' }, false)],
  ['rejects', async () => { throw new Error('network down'); }],
  ['rejects with no message', async () => { throw new Error(''); }],
  [
    'answers 200 with a body that will not parse',
    async () => ({ ok: true, json: async () => { throw new SyntaxError('Unexpected token'); } }) as unknown as Response,
  ],
  ['answers 200 without a list', async () => jsonResponse({ ok: true })],
])('the count tiles say unavailable, never zero, when the read %s', async (_label, listRead) => {
  global.fetch = jest.fn(async (input: RequestInfo | URL) => {
    if (String(input).includes('/auth/session')) return jsonResponse({ ok: true, role: 'admin' });
    return listRead();
  }) as unknown as typeof fetch;

  render(<EscalationsPage />);

  expect(await screen.findByText('Escalations could not be loaded')).toBeTruthy();
  expect(tileValues()).toEqual(['Unavailable', 'Unavailable', 'Unavailable', 'Unavailable']);
  expect(screen.queryByText('Nothing in this view')).toBeNull();
});

test('the count tiles still read zero when the read succeeded and nothing is open', async () => {
  mockAdminFetch({ escalations: [] });

  render(<EscalationsPage />);

  expect(await screen.findByText('Nothing in this view')).toBeTruthy();
  expect(tileValues()).toEqual(['0', '0', '0', '0']);
});

test('the count tiles count what was read', async () => {
  mockAdminFetch();

  render(<EscalationsPage />);

  await screen.findByText('Reported pain in the same joint three sessions running.');
  expect(tileValues()).toEqual(['1', '0', '0', '1']);
});

describe('a pain-report escalation reads "Pain report", not a severity word (#1528)', () => {
  const FROM_NEAR_MISS = {
    ...ESCALATION,
    escalation_id: 'esc-pain',
    reason: 'Pain 9/10 reported after sparring.',
    metadata: { trigger: 'athlete_pain_report', near_miss_id: 'nm-1' },
  };
  const REPEATED = {
    ...ESCALATION,
    escalation_id: 'esc-pattern',
    severity: 'high' as const,
    reason: 'Pain reported three sessions running.',
    metadata: { trigger_key: 'athlete_pain_report' },
  };
  const OTHER = {
    ...ESCALATION,
    escalation_id: 'esc-other',
    source_type: 'incident' as const,
    severity: 'moderate' as const,
    reason: 'Bloody nose during drills.',
    metadata: null,
  };

  const row = (reason: string) => screen.getByText(reason).closest('tr') as HTMLElement;
  const badgeOf = (reason: string) => row(reason).querySelector('.badge') as HTMLElement;
  const SEVERITY_WORD = /\b(low|moderate|high|critical)\b/i;

  test('the badge says "Pain report" for trigger and trigger_key, keeps its colour, and a non-pain row keeps its word (#1528)', async () => {
    mockAdminFetch({ escalations: [FROM_NEAR_MISS, REPEATED, OTHER] });

    render(<EscalationsPage />);
    await screen.findByText(FROM_NEAR_MISS.reason);

    const critical = badgeOf(FROM_NEAR_MISS.reason);
    // OW25-48 A: critical wears --restricted and ▲; --locked is a medical stop.
    expect(critical.textContent).toBe('▲Pain report');
    expect(critical.className).toContain('badge--restricted');
    expect(critical.className).not.toContain('badge--locked');
    expect(row(FROM_NEAR_MISS.reason).textContent).not.toMatch(SEVERITY_WORD);

    const high = badgeOf(REPEATED.reason);
    expect(high.textContent).toBe('▲Pain report');
    expect(high.className).toContain('badge--restricted');
    expect(row(REPEATED.reason).textContent).not.toMatch(SEVERITY_WORD);

    const other = badgeOf(OTHER.reason);
    expect(other.textContent).toBe('◉moderate');
    expect(other.className).toContain('badge--monitor');
  });

  test('the resolve dialog names a pain report the same way, and another escalation by its word (#1528)', async () => {
    mockAdminFetch({ escalations: [FROM_NEAR_MISS, OTHER] });

    render(<EscalationsPage />);
    await screen.findByText(FROM_NEAR_MISS.reason);

    fireEvent.click(within(row(FROM_NEAR_MISS.reason)).getByRole('button', { name: 'Resolve' }));
    let dialog = await screen.findByRole('dialog');
    const eyebrow = dialog.querySelector('.t-eyebrow') as HTMLElement;
    expect(eyebrow.textContent).toMatch(/· Pain report$/);
    expect(eyebrow.textContent).not.toMatch(SEVERITY_WORD);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    fireEvent.click(within(row(OTHER.reason)).getByRole('button', { name: 'Resolve' }));
    dialog = await screen.findByRole('dialog');
    expect((dialog.querySelector('.t-eyebrow') as HTMLElement).textContent).toMatch(/· moderate$/);
  });

  test('the tiles count pain reports on their own, not inside Critical or High (#1528 Q3)', async () => {
    const CRITICAL_OTHER = { ...OTHER, escalation_id: 'esc-crit', severity: 'critical' as const, reason: 'Head contact without clearance.' };
    mockAdminFetch({ escalations: [FROM_NEAR_MISS, REPEATED, OTHER, CRITICAL_OTHER] });

    render(<EscalationsPage />);
    await screen.findByText(FROM_NEAR_MISS.reason);

    // Critical 1 (not 2), High 0 (not 1), Pain reports 2, Total every row.
    expect(tileValues()).toEqual(['1', '0', '2', '4']);
  });

  test('a moderate pain-pattern escalation is in Total only, as any moderate is (#1528 Q3)', async () => {
    const MODERATE_PATTERN = { ...REPEATED, escalation_id: 'esc-mod', severity: 'moderate' as const, reason: 'Pain twice this month.' };
    mockAdminFetch({ escalations: [FROM_NEAR_MISS, MODERATE_PATTERN] });

    render(<EscalationsPage />);
    await screen.findByText(FROM_NEAR_MISS.reason);

    // The same set the header badge counts apart: high and critical only.
    expect(tileValues()).toEqual(['0', '0', '1', '2']);
  });
});

// Lane AS-5 (app scrub CS-08): each row reaches the athlete's Clearance Board
// row and Decision Loop, and the queue links Safety Flags once. The athlete
// goes in page memory, never in an address.
describe('a row reaches the athlete; the queue reaches Safety Flags (lane AS-5)', () => {
  afterEach(() => {
    takeArrivalAthlete(CLEARANCE_BOARD_PAGE);
    takeArrivalAthlete(DECISION_LOOP_PAGE);
    // Unmount first: clearing the session while the page is mounted
    // re-renders its RoleLinks outside act().
    cleanup();
    clearRoleSession();
  });

  const row = async () =>
    (await screen.findByText('Reported pain in the same joint three sessions running.')).closest('tr') as HTMLElement;

  test('the athlete cell links both pages by their titles, with no athlete id in either address', async () => {
    mockAdminFetch();
    render(<EscalationsPage />);
    const cells = within(await row());

    expect(cells.getByRole('link', { name: 'Clearance Board' }).getAttribute('href')).toBe('/coach/sports-medicine');
    expect(cells.getByRole('link', { name: 'SHADOW Decision Loop' }).getAttribute('href')).toBe('/coach/decision-loop');
    for (const link of cells.getAllByRole('link')) {
      expect(link.getAttribute('href')).not.toContain('ath-1');
    }
  });

  test('each link hands the row\'s athlete to its own page only', async () => {
    mockAdminFetch();
    render(<EscalationsPage />);
    const cells = within(await row());

    fireEvent.click(cells.getByRole('link', { name: 'Clearance Board' }));
    expect(takeArrivalAthlete(DECISION_LOOP_PAGE)).toBeNull();
    fireEvent.click(cells.getByRole('link', { name: 'Clearance Board' }));
    expect(takeArrivalAthlete(CLEARANCE_BOARD_PAGE)).toBe('ath-1');

    fireEvent.click(cells.getByRole('link', { name: 'SHADOW Decision Loop' }));
    expect(takeArrivalAthlete(DECISION_LOOP_PAGE)).toBe('ath-1');
  });

  test.each([
    ['ctrl', { ctrlKey: true }],
    ['cmd', { metaKey: true }],
    ['shift', { shiftKey: true }],
    ['alt', { altKey: true }],
    ['middle button', { button: 1 }],
  ])('a %s click, which opens another tab, hands nothing over', async (_name, init) => {
    mockAdminFetch();
    render(<EscalationsPage />);
    const cells = within(await row());
    // Read after each click: a second hand-off would replace the first, and
    // a wrong-page read spends it, so reading both at the end hides a leak.
    fireEvent.click(cells.getByRole('link', { name: 'Clearance Board' }), init);
    expect(takeArrivalAthlete(CLEARANCE_BOARD_PAGE)).toBeNull();
    fireEvent.click(cells.getByRole('link', { name: 'SHADOW Decision Loop' }), init);
    expect(takeArrivalAthlete(DECISION_LOOP_PAGE)).toBeNull();
  });

  // The row links are plain links, offered to everyone this queue admits, so
  // each page they open must admit exactly those roles; Safety Flags is a
  // RoleLink whose list must be its page's gate.
  test('every page these links open admits exactly the roles the link is shown to', () => {
    const gate = (route: string) => {
      const source = readFileSync(path.join(__dirname, '..', '..', ...route.split('/').filter(Boolean), 'page.tsx'), 'utf8');
      const match = source.match(/allowedRoles=\{\[([^\]]*)\]\}/);
      return match ? [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]).sort() : null;
    };
    const queue = gate('/admin/escalations');
    expect(queue).toEqual(['admin', 'coach']);
    expect(gate('/coach/sports-medicine')).toEqual(queue);
    expect(gate('/coach/decision-loop')).toEqual(queue);
    const own = readFileSync(path.join(__dirname, 'page.tsx'), 'utf8');
    const safetyFlags = own.match(/<RoleLink href="\/admin\/safety-flags" roles=\{\[([^\]]*)\]\}/);
    expect(safetyFlags).not.toBeNull();
    expect([...safetyFlags![1].matchAll(/'([^']+)'/g)].map((m) => m[1]).sort()).toEqual(gate('/admin/safety-flags'));
  });

  test.each(['coach', 'admin'] as const)('a %s is offered Safety Flags', async (role) => {
    createPersistentRoleSession(role);
    mockAdminFetch();
    render(<EscalationsPage />);
    await row();
    expect(screen.getByRole('link', { name: 'Safety Flags' }).getAttribute('href')).toBe('/admin/safety-flags');
  });
});

// Lane AS-10, AS10-5 (app scrub OFF-11): the queue leads back to Safety Review,
// which admits an admin only, so a coach is not offered it.
describe('the queue links Safety Review for an admin only (lane AS-10)', () => {
  afterEach(() => {
    cleanup();
    clearRoleSession();
  });

  test('an admin is offered Safety Review', async () => {
    createPersistentRoleSession('admin');
    mockAdminFetch();
    render(<EscalationsPage />);
    expect((await screen.findByRole('link', { name: 'Safety Review' })).getAttribute('href')).toBe('/admin/safety-review');
  });

  test('a coach is not', async () => {
    createPersistentRoleSession('coach');
    mockAdminFetch();
    render(<EscalationsPage />);
    await screen.findByRole('link', { name: 'Safety Flags' });
    expect(screen.queryByRole('link', { name: 'Safety Review' })).toBeNull();
  });
});

// Lane AS5-REST, AS5-4 (app scrub CS-08; #2131 QR6 = A): Acknowledge is the
// armed second press here too, as F-129 made it on the coach home (Jason's
// "Small fixes bundle", OWNER_DECISIONS.md:6629). One press only arms it.
test('Acknowledge is the armed second press: one press arms it, the second sends it', async () => {
  const harness = mockAdminFetch();
  let now = Date.parse('2026-11-23T08:00:00Z');
  const clock = jest.spyOn(Date, 'now').mockImplementation(() => now);
  try {
    render(<EscalationsPage />);
    const ack = await screen.findByRole('button', { name: 'Acknowledge' });
    now += ARM_SETTLE_MS;
    fireEvent.click(ack);
    expect(harness.posted).toEqual([]);
    const armed = screen.getByRole('button', { name: /^Press again: acknowledge / });
    now += ARM_SETTLE_MS;
    fireEvent.click(armed);
    await waitFor(() => expect(harness.posted).toEqual([{ action: 'acknowledge', escalation_id: 'esc-1' }]));
    expect(await screen.findByText('Escalation acknowledged.')).toBeTruthy();
  } finally {
    clock.mockRestore();
  }
});
