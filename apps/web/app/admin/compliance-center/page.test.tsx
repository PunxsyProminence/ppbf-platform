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

// Lane N4-01: the one cleared-tonight answer lives on Waiver Compliance. The
// link opens that screen on every athlete, not on its "Missing a waiver"
// default, which would hide an athlete on a hold whose papers are all signed.
test('the Cleared tonight link opens Waiver Compliance on every athlete', async () => {
  await renderWithViolations([violation()]);

  expect(screen.getByRole('link', { name: 'Cleared tonight' }).getAttribute('href')).toBe('/admin/waiver-status?view=all');
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

// LANE N4-01 (ADMIN-05): the card read "Athlete: ath-017 / Rule: rule-xxx" and
// the status tabs had no Dismissed tab.
test('a violation is identified by the athlete’s name and the rule’s name, not two ids', async () => {
  await renderWithViolations([violation({ athlete_name: 'Jordan T.', rule_name: 'Headgear worn' })]);

  expect(screen.getByText('Athlete: Jordan T.')).toBeTruthy();
  expect(screen.getByText('Rule: Headgear worn')).toBeTruthy();
  expect(screen.queryByText(/ath-1/)).toBeNull();
  expect(screen.queryByText(/rule-1/)).toBeNull();
});

test('a record whose names are not on file still shows its ids rather than a blank', async () => {
  await renderWithViolations([violation({ athlete_name: null, rule_name: null })]);

  expect(screen.getByText('Athlete: ath-1')).toBeTruthy();
  expect(screen.getByText('Rule: rule-1')).toBeTruthy();
});

test('the escalate dialog names the athlete it is about', async () => {
  await renderWithViolations([violation({ athlete_name: 'Jordan T.' })]);

  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Escalate' }));
  });

  const dialog = await screen.findByRole('dialog');
  expect(within(dialog).getByText('Jordan T.')).toBeTruthy();
});

/** Every read of the violations register the page made, as the URL it asked for. */
function readsOf(fetchMock: jest.Mock): string[] {
  return fetchMock.mock.calls
    .filter(([, init]) => (init as RequestInit | undefined)?.method !== 'PATCH')
    .map(([input]) => String(input))
    // The deletion-request queue on the same page reads its own route.
    .filter((url) => url.includes('/api/pilot/compliance/violations'));
}

function statusOf(input: RequestInfo | URL): string {
  return new URL(String(input), 'http://localhost').searchParams.get('status') ?? 'all';
}

/** A server that answers each status tab with its own rows. */
function serveByStatus(byStatus: Record<string, Array<Record<string, unknown>>>, failing: string[] = []) {
  const fetchMock = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'PATCH') {
      return { ok: true, json: async () => ({ ok: true }) } as Response;
    }
    const status = statusOf(input);
    if (failing.includes(status)) {
      return { ok: false, json: async () => ({}) } as Response;
    }
    return { ok: true, json: async () => ({ items: byStatus[status] ?? [], limit: 50 }) } as Response;
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

async function openTab(name: string) {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name }));
  });
}

test('the Dismissed tab retrieves dismissed records from the server, beyond the newest rows of the register', async () => {
  // The register's newest rows hold no dismissed record at all: the one on
  // file is older than that window, which is the case a client-side filter
  // over "all" could never reach.
  const fetchMock = serveByStatus({
    all: [violation({ violation_id: 'v-new', athlete_name: 'Sam R.' })],
    dismissed: [violation({ violation_id: 'v-old', status: 'dismissed', athlete_name: 'Jordan T.' })],
  });

  await act(async () => {
    render(<ComplianceCenterPage />);
  });
  expect(screen.getByText('Athlete: Sam R.')).toBeTruthy();
  expect(screen.queryByText('Athlete: Jordan T.')).toBeNull();

  await openTab('dismissed');

  expect(await screen.findByText('Athlete: Jordan T.')).toBeTruthy();
  expect(screen.queryByText('Athlete: Sam R.')).toBeNull();
  expect(readsOf(fetchMock).some((url) => url.endsWith('/api/pilot/compliance/violations?status=dismissed'))).toBe(true);
  // Identifiable as dismissed, and terminal: nothing left to press.
  expect(badgeFor('dismissed')).toBeTruthy();
  for (const name of ['Acknowledge', 'Escalate', 'Resolve', 'Dismiss']) {
    expect(screen.queryByRole('button', { name })).toBeNull();
  }
  expect(screen.getByText(/50 most recently filed dismissed violations/i)).toBeTruthy();
});

test('"all" still asks for the whole register and still shows a dismissed record, labelled', async () => {
  const fetchMock = serveByStatus({
    all: [violation(), violation({ violation_id: 'v2', status: 'dismissed', athlete_name: 'Jordan T.' })],
  });

  await act(async () => {
    render(<ComplianceCenterPage />);
  });

  const reads = readsOf(fetchMock);
  expect(reads).toHaveLength(1);
  expect(reads[0].endsWith('/api/pilot/compliance/violations')).toBe(true);
  expect(screen.getByText('Athlete: Jordan T.')).toBeTruthy();
  expect(badgeFor('dismissed')).toBeTruthy();
});

test('a status tab keeps resolved, dismissed and open records apart', async () => {
  serveByStatus({
    all: [],
    resolved: [violation({ violation_id: 'v-res', status: 'resolved', athlete_name: 'Resolved Kid' })],
    dismissed: [violation({ violation_id: 'v-dis', status: 'dismissed', athlete_name: 'Dismissed Kid' })],
  });

  await act(async () => {
    render(<ComplianceCenterPage />);
  });
  await openTab('resolved');

  expect(await screen.findByText('Athlete: Resolved Kid')).toBeTruthy();
  expect(screen.queryByText('Athlete: Dismissed Kid')).toBeNull();
});

test('a Dismissed tab that would not load says unavailable, never "no dismissed records"', async () => {
  serveByStatus({ all: [violation()] }, ['dismissed']);

  await act(async () => {
    render(<ComplianceCenterPage />);
  });
  await openTab('dismissed');

  expect(await screen.findByText(/could not be loaded/i)).toBeTruthy();
  expect(screen.queryByText(/No violations match the current filters/i)).toBeNull();
});

test('an empty Dismissed tab is a loaded, empty answer', async () => {
  serveByStatus({ all: [violation()], dismissed: [] });

  await act(async () => {
    render(<ComplianceCenterPage />);
  });
  await openTab('dismissed');

  expect(await screen.findByText(/No violations match the current filters/i)).toBeTruthy();
  expect(screen.queryByText(/could not be loaded/i)).toBeNull();
});

test('after a transition the page re-reads the tab that is showing, not the whole register', async () => {
  const fetchMock = serveByStatus({ all: [], new: [violation()] });

  await act(async () => {
    render(<ComplianceCenterPage />);
  });
  await openTab('new');
  await screen.findByRole('button', { name: 'Acknowledge' });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Acknowledge' }));
  });

  const reads = readsOf(fetchMock);
  expect(reads[reads.length - 1].endsWith('?status=new')).toBe(true);
});

/** A response the test releases by hand, to put two reads in a chosen order. */
function deferred() {
  let release!: (response: Response) => void;
  const promise = new Promise<Response>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

const rowsResponse = (items: Array<Record<string, unknown>>) =>
  ({ ok: true, json: async () => ({ items, limit: 50 }) }) as Response;

// REVIEW FINDING (PR #1456): a re-read sent from one tab and answered after
// the admin moved to another put the old tab's rows under the new tab. The
// status filter then hid every one of them and the list read "No violations
// match" over a loaded register -- the false empty this page exists to avoid.
test('a re-read that answers after the tab changed does not replace the new tab’s rows', async () => {
  const lateReload = deferred();
  let newTabReads = 0;
  global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'PATCH') return { ok: true, json: async () => ({ ok: true }) } as Response;
    const status = statusOf(input);
    if (status === 'new') {
      newTabReads += 1;
      // The first read of the tab answers at once; the re-read after the
      // transition is the one held back.
      return newTabReads === 1 ? rowsResponse([violation({ athlete_name: 'New Kid' })]) : lateReload.promise;
    }
    if (status === 'dismissed') {
      return rowsResponse([violation({ violation_id: 'v-dis', status: 'dismissed', athlete_name: 'Dismissed Kid' })]);
    }
    return rowsResponse([]);
  }) as unknown as typeof fetch;

  await act(async () => {
    render(<ComplianceCenterPage />);
  });
  await openTab('new');
  await screen.findByText('Athlete: New Kid');
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Acknowledge' }));
  });
  await openTab('dismissed');
  expect(await screen.findByText('Athlete: Dismissed Kid')).toBeTruthy();

  await act(async () => {
    lateReload.release(rowsResponse([violation({ status: 'acknowledged', athlete_name: 'New Kid' })]));
  });

  expect(screen.getByText('Athlete: Dismissed Kid')).toBeTruthy();
  expect(screen.queryByText(/No violations match the current filters/i)).toBeNull();
});

test('the tiles count the rows on screen after a transition’s re-read', async () => {
  let newTabReads = 0;
  global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'PATCH') return { ok: true, json: async () => ({ ok: true }) } as Response;
    if (statusOf(input) !== 'new') return rowsResponse([]);
    newTabReads += 1;
    // Acknowledged, so it has left the "new" tab by the re-read.
    return rowsResponse(newTabReads === 1 ? [violation({ severity: 'critical' })] : []);
  }) as unknown as typeof fetch;

  await act(async () => {
    render(<ComplianceCenterPage />);
  });
  await openTab('new');
  const tile = () => screen.getByText(/^Total/).closest('article') as HTMLElement;
  await waitFor(() => expect(within(tile()).getByText('1')).toBeTruthy());

  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Acknowledge' }));
  });

  await waitFor(() => expect(within(tile()).getByText('0')).toBeTruthy());
  expect(screen.getByText(/Violations \(0 of 0 loaded\)/)).toBeTruthy();
});

test('while a tab’s read is in flight no count is stated over the previous tab’s rows', async () => {
  const slowTab = deferred();
  global.fetch = jest.fn(async (input: RequestInfo | URL) =>
    (statusOf(input) === 'dismissed' ? slowTab.promise : rowsResponse([violation(), violation({ violation_id: 'v2' })]))) as unknown as typeof fetch;

  await act(async () => {
    render(<ComplianceCenterPage />);
  });
  expect(screen.getByText(/Violations \(2 of 2 loaded\)/)).toBeTruthy();

  await openTab('dismissed');

  expect(screen.getByText(/Violations \(\.\.\. of \.\.\. loaded\)/)).toBeTruthy();
  expect(screen.queryByText(/most recently filed/i)).toBeNull();
  expect(screen.queryByText(/No violations match the current filters/i)).toBeNull();

  await act(async () => {
    slowTab.release(rowsResponse([]));
  });
  expect(await screen.findByText(/Violations \(0 of 0 loaded\)/)).toBeTruthy();
});

// CODEX REVIEW (PR #1456, P2): dropping a re-read by comparing the tab NAME
// was not enough. Tab A, then B, then back to A makes an old answer for A
// acceptable again, and it can land after the newer read of A. Every read
// now takes a number when it is sent, and only the latest one sent may put
// rows on the screen.
test('A, then B, then back to A: a late answer to the old re-read of A does not replace the newer rows', async () => {
  const lateReload = deferred();
  let newTabReads = 0;
  global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'PATCH') return { ok: true, json: async () => ({ ok: true }) } as Response;
    const status = statusOf(input);
    if (status !== 'new') return rowsResponse([]);
    newTabReads += 1;
    // 1: the tab's first read. 2: the re-read after the transition, held back.
    // 3: the read when the admin comes back to the tab.
    if (newTabReads === 1) return rowsResponse([violation({ athlete_name: 'First Kid' })]);
    if (newTabReads === 2) return lateReload.promise;
    return rowsResponse([
      violation({ violation_id: 'v-a', athlete_name: 'Newer Kid' }),
      violation({ violation_id: 'v-b', athlete_name: 'Second Newer Kid' }),
    ]);
  }) as unknown as typeof fetch;

  await act(async () => {
    render(<ComplianceCenterPage />);
  });
  await openTab('new');
  await screen.findByText('Athlete: First Kid');
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Acknowledge' }));
  });
  await openTab('dismissed');
  await openTab('new');
  expect(await screen.findByText('Athlete: Newer Kid')).toBeTruthy();

  await act(async () => {
    lateReload.release(rowsResponse([violation({ violation_id: 'v-old', athlete_name: 'Stale Kid' })]));
  });

  expect(screen.getByText('Athlete: Newer Kid')).toBeTruthy();
  expect(screen.queryByText('Athlete: Stale Kid')).toBeNull();
  // The counts are the newer read's too.
  expect(screen.getByText(/Violations \(2 of 2 loaded\)/)).toBeTruthy();
  const total = screen.getByText(/^Total/).closest('article') as HTMLElement;
  expect(within(total).getByText('2')).toBeTruthy();
});

// The other side of "only the latest read counts": a re-read that overtakes a
// tab's own load makes that load's answer unusable, so the re-read has to
// finish the load's job. Otherwise the tab would sit on "Loading" for ever.
test('a re-read that overtakes a tab’s load fills the tab, and the overtaken load is dropped', async () => {
  const heldPatch = deferred();
  const overtakenLoad = deferred();
  let dismissedReads = 0;
  global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'PATCH') return heldPatch.promise;
    const status = statusOf(input);
    if (status === 'new') return rowsResponse([violation({ athlete_name: 'New Kid' })]);
    if (status === 'dismissed') {
      dismissedReads += 1;
      // 1: the tab's own load, held back. 2: the re-read sent when the PATCH answers.
      return dismissedReads === 1
        ? overtakenLoad.promise
        : rowsResponse([violation({ violation_id: 'v-dis', status: 'dismissed', athlete_name: 'Dismissed Kid' })]);
    }
    return rowsResponse([]);
  }) as unknown as typeof fetch;

  await act(async () => {
    render(<ComplianceCenterPage />);
  });
  await openTab('new');
  await screen.findByText('Athlete: New Kid');
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Acknowledge' }));
  });
  await openTab('dismissed');
  expect(screen.getByText('Loading…')).toBeTruthy();

  // The transition answers: its re-read is for the tab showing NOW.
  await act(async () => {
    heldPatch.release({ ok: true, json: async () => ({ ok: true }) } as Response);
  });

  expect(await screen.findByText('Athlete: Dismissed Kid')).toBeTruthy();
  expect(screen.queryByText('Loading…')).toBeNull();
  expect(screen.queryByText('Athlete: New Kid')).toBeNull();

  await act(async () => {
    overtakenLoad.release(rowsResponse([]));
  });

  expect(screen.getByText('Athlete: Dismissed Kid')).toBeTruthy();
  expect(screen.queryByText(/No violations match the current filters/i)).toBeNull();
});

test('a re-read that fails leaves the rows on screen and the action’s own message standing', async () => {
  let reads = 0;
  global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'PATCH') {
      return { ok: false, json: async () => ({ error: 'This violation cannot be acknowledged from its current state.' }) } as Response;
    }
    // The deletion-request queue on the same page reads its own route.
    if (!String(input).includes('/api/pilot/compliance/violations')) return rowsResponse([]);
    reads += 1;
    return reads === 1 ? rowsResponse([violation({ athlete_name: 'Jordan T.' })]) : ({ ok: false, json: async () => ({}) } as Response);
  }) as unknown as typeof fetch;

  await act(async () => {
    render(<ComplianceCenterPage />);
  });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Acknowledge' }));
  });

  expect(await screen.findByText('This violation cannot be acknowledged from its current state.')).toBeTruthy();
  expect(screen.getByText('Athlete: Jordan T.')).toBeTruthy();
  expect(screen.queryByText(/could not be loaded/i)).toBeNull();
  expect(screen.queryByText(/Unable to load compliance violations/i)).toBeNull();
});
