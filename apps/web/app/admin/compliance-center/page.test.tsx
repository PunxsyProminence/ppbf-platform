/**
 * @jest-environment jsdom
 */

// The register's lifecycle levers. These pin the two ways the buttons could
// mislead an admin: offering an action the server will refuse from the row's
// current state, and claiming success the server never committed.

import type { ReactNode } from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

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

/**
 * Resolving or dismissing a violation on a child's record takes a written
 * reason, and that reason used to be collected in window.prompt(): browser
 * chrome, no room, no glyph, no kiosk sizing. It is a role="dialog" now.
 * window.prompt stays mocked in every test that drives one so
 * `expect(window.prompt).not.toHaveBeenCalled()` keeps its teeth -- putting
 * the browser prompt back fails these rather than quietly passing.
 */
async function closeWithReason(reason: string, confirmName: 'Resolve' | 'Dismiss') {
  const dialog = await screen.findByRole('dialog');
  fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: reason } });
  await act(async () => {
    fireEvent.click(within(dialog).getByRole('button', { name: confirmName }));
  });
}

async function renderWithViolations(
  items: Array<Record<string, unknown>>,
  patchResponse?: () => Response,
  readLimit = 50,
) {
  const fetchMock = jest.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'PATCH') {
      return patchResponse
        ? patchResponse()
        : ({ ok: true, json: async () => ({ ok: true }) } as Response);
    }
    return { ok: true, json: async () => ({ items, limit: readLimit }) } as Response;
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

// The badge ladder is what a reviewer scans, so these hold the one rule the
// room cannot afford to lose: red is a medical or safeguarding fact.
function badgeFor(text: string): HTMLElement {
  // The status filter bar carries the same words as the badges, so the lookup
  // has to name the badge and not the button beside it.
  const badge = screen.getAllByText(text).find((node) => node.className.includes('badge'));
  expect(badge).toBeTruthy();
  return badge as HTMLElement;
}

test('escalated is a workflow state and does not wear the room\u2019s medical red', async () => {
  await renderWithViolations([violation({ status: 'escalated', severity: 'low' })]);

  const status = badgeFor('escalated');
  expect(status.className).toContain('badge--restricted');
  expect(status.className).not.toContain('badge--locked');
  // A distinct glyph is what keeps it apart from `new` now that they share a
  // rung -- Law 3 was never colour's job alone.
  expect(status.textContent).toContain('\u25c8');
});

test('critical severity keeps the medical red', async () => {
  await renderWithViolations([violation({ severity: 'critical' })]);

  const severity = badgeFor('critical');
  expect(severity.className).toContain('badge--locked');
  expect(severity.textContent).toContain('\u2715');
});

test('a register that would not load is not stamped as a medical emergency', async () => {
  global.fetch = jest.fn(async () => ({ ok: false, json: async () => ({}) }) as Response) as unknown as typeof fetch;

  await act(async () => {
    render(<ComplianceCenterPage />);
  });

  const alert = await screen.findByRole('alert');
  expect(alert.className).toContain('alert--warning');
  expect(alert.className).not.toContain('alert--critical');
  expect(within(alert).getByText('Attention')).toBeTruthy();
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

test('dismiss asks for its reason in the room, not in browser chrome', async () => {
  window.prompt = jest.fn();
  await renderWithViolations([violation()]);

  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
  });

  const dialog = await screen.findByRole('dialog');
  expect(dialog.getAttribute('aria-modal')).toBe('true');
  expect(within(dialog).getByRole('heading', { name: 'Dismiss this violation' })).toBeTruthy();
  expect(window.prompt).not.toHaveBeenCalled();
});

test('dismiss with the dialog cancelled sends nothing', async () => {
  window.prompt = jest.fn();
  const fetchMock = await renderWithViolations([violation()]);

  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
  });
  const dialog = await screen.findByRole('dialog');
  await act(async () => {
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
  });

  expect(screen.queryByRole('dialog')).toBeNull();
  expect(fetchMock.mock.calls.every(([, init]) => (init as RequestInit | undefined)?.method !== 'PATCH')).toBe(true);
});

test('a closing reason of only whitespace keeps the dialog open and sends nothing', async () => {
  window.prompt = jest.fn();
  const fetchMock = await renderWithViolations([violation({ status: 'acknowledged' })]);

  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Resolve' }));
  });
  await closeWithReason('   ', 'Resolve');

  const dialog = await screen.findByRole('dialog');
  expect(within(dialog).getByText(/needs a stated reason/)).toBeTruthy();
  expect(fetchMock.mock.calls.every(([, init]) => (init as RequestInit | undefined)?.method !== 'PATCH')).toBe(true);
});

test('resolve sends the stated reason and reconciles with the server', async () => {
  window.prompt = jest.fn();
  const fetchMock = await renderWithViolations([violation({ status: 'acknowledged' })]);

  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Resolve' }));
  });
  await closeWithReason('Coach retrained; footage reviewed.', 'Resolve');

  expect(window.prompt).not.toHaveBeenCalled();
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
  window.prompt = jest.fn();

  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Resolve' }));
  });
  await closeWithReason('reason', 'Resolve');

  await waitFor(() => {
    expect(screen.getByText('This violation cannot be resolved from its current state.')).toBeTruthy();
  });
});

// READ HONESTY (shapes 2 and 4: a count of the page shown as a count of the
// set, and severity aggregates over an incomplete window).
//
// GET /api/pilot/compliance/violations reads
// `order by created_at desc limit N` (parseSafeLimit default 50, hard max
// 100) and this page sends no limit at all, so it always holds the 50 most
// recently filed rows. Every figure on the page was then computed off that
// slice and labelled as if it were the register: a "Total" tile, and two
// "X of Y" counts whose Y is the page size.
//
// So a gym with 320 violations on file reads "Total 50". Worse, the severity
// tiles are aggregates over the same slice: two critical violations filed
// three months ago sit outside the 50 newest rows and the tile reads
// "Critical 0". An admin closes the page believing there are none.
//
// The honest fix is the one /notices took -- name the window; not a pager.
//
// WATCHED TO FAIL: put the bare "Total" label back and the first test goes
// red on the word; drop the window line and the second does.
test('the metric tiles never call a capped slice the whole register', async () => {
  await renderWithViolations([violation()]);

  const total = await screen.findByText(/^Total/);
  const tile = total.closest('article') as HTMLElement;
  // Not vacuous: the tile really is on the page, carrying its figure.
  expect(tile).toBeTruthy();
  expect(within(tile).getByText('1')).toBeTruthy();

  // "Total" alone is a claim about the register. It must be qualified.
  expect(total.textContent ?? '').toMatch(/this view/i);
});

test('the page states the read window its figures were computed over', async () => {
  await renderWithViolations([violation()]);

  expect(await screen.findByText(/50 most recently filed/i)).toBeTruthy();
});

test('the stated window follows the limit the server actually applied', async () => {
  await renderWithViolations([violation()], undefined, 100);

  expect(await screen.findByText(/100 most recently filed/i)).toBeTruthy();
  expect(screen.queryByText(/50 most recently filed/i)).toBeNull();
});

// READ HONESTY (shape 6). The header already refuses to draw the metrics as
// zeroes when the read failed ("intentionally not shown as zero"), but the
// list below it did not hold the same line: violations stays [] after a
// failed read, so the register rendered "No violations match the current
// filters", inviting the admin to widen filters that were never the reason
// they saw nothing.
//
// WATCHED TO FAIL: drop the dataAuthoritative guard on the empty state and
// this goes red on the filter wording.
test('a failed read does not render the register as filtered-to-empty', async () => {
  global.fetch = jest.fn(async () => ({ ok: false, json: async () => ({}) }) as Response) as unknown as typeof fetch;

  await act(async () => {
    render(<ComplianceCenterPage />);
  });

  // The failure is stated.
  expect(await screen.findByText(/Unable to load compliance violations/i)).toBeTruthy();

  // The tiles withhold their figures rather than printing zeroes.
  const total = screen.getByText(/^Total/).closest('article') as HTMLElement;
  expect(total).toBeTruthy();
  expect(within(total).queryByText('0')).toBeNull();

  // ...and the list does not blame the filters for it.
  expect(screen.queryByText(/No violations match the current filters/i)).toBeNull();
  expect(screen.getByText(/could not be loaded/i)).toBeTruthy();
});
