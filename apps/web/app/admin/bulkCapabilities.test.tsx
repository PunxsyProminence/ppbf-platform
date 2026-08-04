/**
 * @jest-environment jsdom
 */

/**
 * BULK OPERATIONS ON THE CAPABILITY LIBRARY, AND THE ONE WAY THEY GO WRONG.
 *
 * bulkSelection.test.ts pins the rule as arithmetic. This file pins it as the
 * thing an administrator actually does: tick "select all", change a filter,
 * and look at what the buttons now claim they will do. The rule and the screen
 * agreeing is the whole feature — a truthful rule behind a table that displays
 * a stale count is exactly as dangerous as no rule.
 *
 * It also pins the two safety properties around the only irreversible action:
 * the confirmation names the count, and it cannot be dismissed by a stray
 * click on a backdrop.
 */

import type { ReactNode } from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import AdminCapabilitiesPage from './page';
import { usePilotSession, type PilotSessionState } from '@/components/usePilotSession';

jest.mock('@/components/RoleSessionGate', () => ({
  __esModule: true,
  default: ({ children }: { readonly children: ReactNode }) => children,
}));

jest.mock('@/components/RevenueFundingCenter', () => ({ __esModule: true, default: () => null }));
jest.mock('@/components/ShadowChatButton', () => ({ __esModule: true, default: () => null }));

jest.mock('@/components/usePilotSession', () => ({
  ...jest.requireActual('@/components/usePilotSession'),
  usePilotSession: jest.fn(),
}));

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ children, href }: { readonly children: ReactNode; readonly href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

const mockUsePilotSession = usePilotSession as jest.Mock;
const originalFetch = global.fetch;

/**
 * Five capabilities across two categories, so a filter can cut the list in a
 * way the test can reason about.
 */
const STORED = [
  { id: 1, capabilityId: 'CAP-001', name: 'Locker Rooms', group: 'Core Platform', status: 'ACTIVE', owner: 'Operations', assignedRoles: ['Admin'], description: 'a' },
  { id: 2, capabilityId: 'CAP-002', name: 'Card File', group: 'Core Platform', status: 'ACTIVE', owner: 'Operations', assignedRoles: ['Admin'], description: 'b' },
  { id: 3, capabilityId: 'CAP-003', name: 'Safety Gate', group: 'Safety & Compliance', status: 'DRAFT', owner: 'Safety Office', assignedRoles: [], description: 'c' },
  { id: 4, capabilityId: 'CAP-004', name: 'Session Logging', group: 'Program Operations', status: 'ACTIVE', owner: 'Operations', assignedRoles: ['Coach'], description: 'd' },
  { id: 5, capabilityId: 'CAP-005', name: 'Route Factory', group: 'Program Operations', status: 'DRAFT', owner: 'Program Team', assignedRoles: [], description: 'e' },
];

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body } as Response;
}

function makeFetch() {
  return jest.fn(async (url: string) => {
    if (String(url).includes('/api/pilot/admin/capabilities')) {
      return jsonResponse({ ok: true, capabilities: STORED });
    }
    return jsonResponse({ ok: true });
  });
}

async function renderLibrary() {
  const fetchMock = makeFetch();
  mockUsePilotSession.mockReturnValue({
    role: 'organization_admin',
    organizationId: 'org-1',
    authProvider: 'microsoft',
    accountId: 'admin@punxsyprominence.org',
    mustChangePin: false,
    loading: false,
  } as PilotSessionState);
  global.fetch = fetchMock as unknown as typeof fetch;

  render(<AdminCapabilitiesPage />);
  await waitFor(() => expect(fetchMock).toHaveBeenCalled());
  // Onto the library tab, where the filters and the table live.
  fireEvent.click(screen.getByRole('button', { name: /^Capability Library$/i }));
  await screen.findByText(/Showing 5 of 5 on file\./);
  return fetchMock;
}

/** The select-all control, which lives once above both breakpoint renderings. */
function selectAllBox() {
  return screen.getByRole('checkbox', { name: /select all .* shown/i });
}

/**
 * The selected count is printed in THREE places on purpose -- the summary line,
 * the note under the select-all box, and the tray -- because the whole point of
 * the feature is that those three never disagree. So the assertions count
 * matches rather than demanding exactly one.
 */
function selectedCount(pattern: RegExp): number {
  return screen.queryAllByText(pattern).length;
}

/**
 * A status cell in the desk table is a bare <span>. Scoped because the page's
 * counts strip above the tabs renders the word ACTIVE as a <p> label, and the
 * phone-width cards render "Status: ACTIVE | Visibility: ..." as one node.
 */
function statusCells(status: string) {
  return screen.queryAllByText(status, { selector: 'span' });
}

/** Type into the library search box, which is the cheapest filter to move. */
function search(value: string) {
  const box = screen.getByPlaceholderText(/search/i);
  fireEvent.change(box, { target: { value } });
}

afterEach(() => {
  global.fetch = originalFetch;
  jest.clearAllMocks();
});

/* ==========================================================================
   THE FOOTGUN, ON THE SCREEN
   ========================================================================== */

describe('select all, then change the filter', () => {
  it('selects exactly what the current filter shows', async () => {
    await renderLibrary();
    search('Core Platform');
    await screen.findByText(/Showing 2 of 5 on file\./);

    fireEvent.click(selectAllBox());
    expect(selectedCount(/2 capabilities selected/)).toBeGreaterThan(0);
    // Not five. "All" means all of what is on screen, and nothing else.
    expect(selectedCount(/5 capabilities selected/)).toBe(0);
  });

  it('drops the rows that leave when the filter narrows, and says the smaller number', async () => {
    await renderLibrary();

    fireEvent.click(selectAllBox());
    expect(selectedCount(/5 capabilities selected/)).toBeGreaterThan(0);

    // The classic footgun: select everything, then narrow.
    search('Safety Gate');
    await screen.findByText(/Showing 1 of 5 on file\./);

    // The tray now says one, and it means one.
    expect(selectedCount(/1 capability selected/)).toBeGreaterThan(0);
    expect(selectedCount(/5 capabilities selected/)).toBe(0);
    expect(screen.getByRole('button', { name: /^DELETE 1 CAPABILITY$/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /DELETE 5 CAPABILITIES/ })).toBeNull();
  });

  it('does not bring the hidden ticks back when the filter widens again', async () => {
    await renderLibrary();
    fireEvent.click(selectAllBox());
    search('Safety Gate');
    await screen.findByText(/Showing 1 of 5 on file\./);

    search('');
    await screen.findByText(/Showing 5 of 5 on file\./);

    // This is what separates a real prune from a render-time filter. A
    // render-time filter shows a truthful "1" while narrowed and then hands
    // the original five back the instant the filter widens.
    expect(selectedCount(/1 capability selected/)).toBeGreaterThan(0);
    expect(selectedCount(/5 capabilities selected/)).toBe(0);
  });

  it('empties the tray when the filter matches nothing at all', async () => {
    await renderLibrary();
    fireEvent.click(selectAllBox());
    search('nothing matches this');
    await screen.findByText(/No capability matches those filters/);
    expect(selectedCount(/selected/)).toBe(0);
  });

  it('acts on the visible selection and leaves the hidden rows untouched', async () => {
    // The proof that the count is not merely displayed correctly: the rows
    // that left the view are not written either.
    await renderLibrary();
    fireEvent.click(selectAllBox());
    search('Safety Gate');
    await screen.findByText(/Showing 1 of 5 on file\./);

    fireEvent.click(screen.getByRole('button', { name: /^SET BLOCKED$/ }));
    search('');
    await screen.findByText(/Showing 5 of 5 on file\./);

    // One row changed. The other four are as they were.
    expect(statusCells('BLOCKED').length).toBe(1);
  });
});

/* ==========================================================================
   THE COUNT, AND WHAT IT IS ATTACHED TO
   ========================================================================== */

describe('what is selected is stated plainly', () => {
  it('shows no tray until something is picked', async () => {
    await renderLibrary();
    expect(selectedCount(/selected/)).toBe(0);
    // A permanent tray of disabled bulk buttons is furniture.
    expect(screen.queryByRole('button', { name: /CLEAR SELECTION/ })).toBeNull();
  });

  it('counts one row correctly, in the singular', async () => {
    await renderLibrary();
    fireEvent.click(screen.getAllByRole('checkbox', { name: /Select CAP-003/ })[0]);
    expect(selectedCount(/1 capability selected/)).toBeGreaterThan(0);
  });

  it('puts the same number on the tray and on every button', async () => {
    await renderLibrary();
    fireEvent.click(selectAllBox());
    expect(selectedCount(/5 capabilities selected/)).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: /^DELETE 5 CAPABILITIES$/ })).toBeTruthy();
  });

  it('reports a partial selection as partial rather than as none or all', async () => {
    await renderLibrary();
    fireEvent.click(screen.getAllByRole('checkbox', { name: /Select CAP-001/ })[0]);
    const box = selectAllBox() as HTMLInputElement;
    expect(box.checked).toBe(false);
    expect(box.indeterminate).toBe(true);
  });

  it('goes from partial to all when the header box is used', async () => {
    await renderLibrary();
    fireEvent.click(screen.getAllByRole('checkbox', { name: /Select CAP-001/ })[0]);
    fireEvent.click(selectAllBox());
    expect(selectedCount(/5 capabilities selected/)).toBeGreaterThan(0);
  });
});

/* ==========================================================================
   THE CONFIRMATION FOR THE ONE THING THAT CANNOT BE TAKEN BACK
   ========================================================================== */

describe('deleting in bulk', () => {
  it('stops and names the count before anything goes', async () => {
    await renderLibrary();
    fireEvent.click(selectAllBox());
    fireEvent.click(screen.getByRole('button', { name: /^DELETE 5 CAPABILITIES$/ }));

    const confirm = screen.getByRole('alertdialog');
    expect(within(confirm).getByText(/Delete 5 capabilities from the registry\?/)).toBeTruthy();
    // Nothing has happened yet.
    expect(screen.getByText(/Showing 5 of 5 on file\./)).toBeTruthy();
  });

  it('says out loud that this one does not come back, and points at the reversible option', async () => {
    await renderLibrary();
    fireEvent.click(selectAllBox());
    fireEvent.click(screen.getByRole('button', { name: /^DELETE 5 CAPABILITIES$/ }));

    const confirm = screen.getByRole('alertdialog');
    expect(within(confirm).getByText(/does not come back/i)).toBeTruthy();
    expect(within(confirm).getByText(/SET ARCHIVED/)).toBeTruthy();
  });

  it('names the records going, not just how many', async () => {
    await renderLibrary();
    fireEvent.click(screen.getAllByRole('checkbox', { name: /Select CAP-003/ })[0]);
    fireEvent.click(screen.getByRole('button', { name: /^DELETE 1 CAPABILITY$/ }));
    expect(within(screen.getByRole('alertdialog')).getByText(/CAP-003 — Safety Gate/)).toBeTruthy();
  });

  it('cannot be dismissed by accident — there is no backdrop to click off', async () => {
    await renderLibrary();
    fireEvent.click(selectAllBox());
    fireEvent.click(screen.getByRole('button', { name: /^DELETE 5 CAPABILITIES$/ }));

    const confirm = screen.getByRole('alertdialog');
    // An overlay whose backdrop closes it is a destructive confirmation you
    // can dismiss with a stray click. This one sits in the flow and waits.
    fireEvent.mouseDown(document.body);
    fireEvent.click(document.body);
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(screen.getByRole('alertdialog')).toBe(confirm);
    expect(screen.getByText(/Showing 5 of 5 on file\./)).toBeTruthy();
  });

  it('offers cancel before it offers the deletion', async () => {
    await renderLibrary();
    fireEvent.click(selectAllBox());
    fireEvent.click(screen.getByRole('button', { name: /^DELETE 5 CAPABILITIES$/ }));

    const buttons = within(screen.getByRole('alertdialog')).getAllByRole('button');
    // First in the DOM is first for a keyboard, and first for a screen reader
    // after the warning. That should be the way out.
    expect(buttons[0].textContent).toMatch(/CANCEL/);
  });

  it('cancels without touching anything', async () => {
    await renderLibrary();
    fireEvent.click(selectAllBox());
    fireEvent.click(screen.getByRole('button', { name: /^DELETE 5 CAPABILITIES$/ }));
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: /CANCEL/ }));

    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(screen.getByText(/Showing 5 of 5 on file\./)).toBeTruthy();
    // The selection survives a cancel -- losing it would punish somebody for
    // being careful.
    expect(selectedCount(/5 capabilities selected/)).toBeGreaterThan(0);
  });

  it('goes through when confirmed', async () => {
    await renderLibrary();
    fireEvent.click(screen.getAllByRole('checkbox', { name: /Select CAP-003/ })[0]);
    fireEvent.click(screen.getByRole('button', { name: /^DELETE 1 CAPABILITY$/ }));
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: /YES, DELETE/ }));

    await screen.findByText(/Showing 4 of 4 on file\./);
    expect(screen.queryByText('Safety Gate')).toBeNull();
  });
});

/* ==========================================================================
   THE STEP BACK
   ========================================================================== */

describe('undo', () => {
  it('is offered after a bulk action, and says what it will reverse', async () => {
    await renderLibrary();
    fireEvent.click(selectAllBox());
    fireEvent.click(screen.getByRole('button', { name: /^SET ARCHIVED$/ }));

    expect(screen.getByText(/Set 5 capabilities to ARCHIVED/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /^UNDO$/ })).toBeTruthy();
  });

  it('is honest about how long it lasts', async () => {
    // The registry has no server-side history, so the offer must not imply a
    // safety net that is not there.
    await renderLibrary();
    fireEvent.click(selectAllBox());
    fireEvent.click(screen.getByRole('button', { name: /^SET DRAFT$/ }));
    expect(screen.getByText(/held on this screen only/i)).toBeTruthy();
  });

  it('puts a bulk status change back exactly', async () => {
    await renderLibrary();
    expect(statusCells('ACTIVE').length).toBe(3);

    fireEvent.click(selectAllBox());
    fireEvent.click(screen.getByRole('button', { name: /^SET BLOCKED$/ }));
    await waitFor(() => expect(statusCells('BLOCKED').length).toBe(5));

    fireEvent.click(screen.getByRole('button', { name: /^UNDO$/ }));
    await waitFor(() => expect(statusCells('ACTIVE').length).toBe(3));
    expect(statusCells('BLOCKED').length).toBe(0);
  });

  it('puts deleted records back, because the registry is written whole', async () => {
    // This is why an undo can honestly be offered for a delete here at all:
    // the save effect POSTs the entire array, so restoring the previous array
    // is a complete reversal rather than a soft-delete flag pretending to be one.
    await renderLibrary();
    fireEvent.click(selectAllBox());
    fireEvent.click(screen.getByRole('button', { name: /^DELETE 5 CAPABILITIES$/ }));
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: /YES, DELETE/ }));
    await screen.findByText(/The library is empty/);

    fireEvent.click(screen.getByRole('button', { name: /^UNDO$/ }));
    await screen.findByText(/Showing 5 of 5 on file\./);
    // Two renderings are in the DOM at every width (a media query hides one),
    // so every row name appears twice.
    expect(screen.getAllByText('Safety Gate').length).toBeGreaterThan(0);
  });

  it('withdraws the offer once an unrelated edit lands', async () => {
    // The snapshot is the whole registry, so an undo taken after other edits
    // would silently revert those too. An undo that undoes more than it
    // offered to is worse than no undo.
    await renderLibrary();
    fireEvent.click(selectAllBox());
    fireEvent.click(screen.getByRole('button', { name: /^SET DRAFT$/ }));
    expect(screen.getByRole('button', { name: /^UNDO$/ })).toBeTruthy();

    // A single-row action, from the same table.
    fireEvent.click(screen.getAllByRole('button', { name: /^ARCHIVE$/ })[0]);
    expect(screen.queryByRole('button', { name: /^UNDO$/ })).toBeNull();
  });

  it('clears the selection after acting, so the next action starts from nothing', async () => {
    await renderLibrary();
    fireEvent.click(selectAllBox());
    fireEvent.click(screen.getByRole('button', { name: /^SET DRAFT$/ }));
    expect(selectedCount(/capabilities selected/)).toBe(0);
  });
});

/* ==========================================================================
   THE REVERSIBLE ACTIONS DO NOT DEMAND A CEREMONY
   ========================================================================== */

describe('reversible bulk actions', () => {
  it('runs a status change straight away — the step back is the safety net', async () => {
    await renderLibrary();
    fireEvent.click(selectAllBox());
    fireEvent.click(screen.getByRole('button', { name: /^SET ACTIVE$/ }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    await waitFor(() => expect(statusCells('ACTIVE').length).toBe(5));
  });

  it('gives a role to everything selected, without duplicating it on rows that had it', async () => {
    await renderLibrary();
    fireEvent.click(selectAllBox());
    fireEvent.click(screen.getByRole('button', { name: /^GIVE TO ADMIN$/ }));

    // CAP-001 already had Admin; it must not now read "Admin, Admin".
    await waitFor(() => expect(screen.queryAllByText(/Admin, Admin/).length).toBe(0));
    expect(screen.queryAllByText('Unassigned', { selector: 'span' }).length).toBe(0);
  });

  it('takes a role away from everything selected', async () => {
    await renderLibrary();
    fireEvent.click(selectAllBox());
    fireEvent.click(screen.getByRole('button', { name: /^TAKE FROM ADMIN$/ }));
    // CAP-001 and CAP-002 lose their only role, CAP-003 and CAP-005 were
    // already bare. CAP-004 holds Coach and is untouched.
    await waitFor(() => expect(screen.queryAllByText('Unassigned', { selector: 'span' }).length).toBe(4));
  });
});
