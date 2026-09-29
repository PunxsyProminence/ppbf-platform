/**
 * @jest-environment jsdom
 */

// The deletion screen marks a real person deleted. Pinned here: the role it
// admits, that nothing is sent before the second confirmation and that the
// second confirmation names the person, the exact request, that the result is
// the API's own answer (a missing count reads "not reported", never 0), and
// that every failure reads as a failure -- never as a deletion, and a lost
// connection never as "nothing happened".

import type { ReactNode } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

import DataDeletionPage from './page';

const mockGate: { allowedRoles: string[] | null } = { allowedRoles: null };

jest.mock('@/components/RoleSessionGate', () => ({
  __esModule: true,
  default: ({ allowedRoles, children }: { readonly allowedRoles: string[]; readonly children: ReactNode }) => {
    mockGate.allowedRoles = allowedRoles;
    return children;
  },
}));

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ children, href, className }: { readonly children: ReactNode; readonly href: string; readonly className?: string }) => (
    <a href={href} className={className}>{children}</a>
  ),
}));

const originalFetch = global.fetch;

type Reply = { status: number; body?: unknown; unreadable?: boolean } | 'network-error';

const ATHLETES = {
  items: [
    { athlete_id: 'ath-1', full_name: 'Ada Boxer', deleted_at: null },
    { athlete_id: 'ath-2', full_name: 'Gone Already', deleted_at: '2026-09-01 16:00:00+00' },
    // No deleted_at field at all: read as not deleted.
    { athlete_id: 'ath-3', full_name: 'Cal Southpaw' },
  ],
};

const STAFF = {
  ok: true,
  members: [
    { account_id: 'acct-coach', login_email: 'coach@gym.test', role: 'coach', active_flag: true, membership_active: true },
    { account_id: 'acct-parent', login_email: 'parent@gym.test', role: 'parent', active_flag: true, membership_active: true },
    { account_id: 'acct-parent-off', login_email: null, role: 'parent', active_flag: false, membership_active: false },
  ],
  guardian_links: [
    { account_id: 'acct-parent', parent_id: 'p-1', athlete_id: 'ath-1', athlete_full_name: 'Ada Boxer', relationship_to_athlete: 'mother' },
  ],
};

let deleteReply: Reply;
let athletesReply: Reply;
let staffReply: Reply;
let fetchMock: jest.Mock;

function respond(reply: Reply): Response {
  if (reply === 'network-error') {
    throw new TypeError('Failed to fetch');
  }
  return {
    ok: reply.status >= 200 && reply.status < 300,
    status: reply.status,
    json: async () => {
      if (reply.unreadable) throw new SyntaxError('not json');
      return reply.body;
    },
  } as unknown as Response;
}

beforeEach(() => {
  mockGate.allowedRoles = null;
  athletesReply = { status: 200, body: ATHLETES };
  staffReply = { status: 200, body: STAFF };
  deleteReply = {
    status: 200,
    body: {
      deletedEntityType: 'athlete',
      deletedEntityId: 'ath-1',
      deletedRecordsCounts: { athletes: 1, accounts: 1, coachObservationsRetained: 4 },
      deletedAt: '2026-09-29T16:00:00.000Z',
      auditEventId: 812,
    },
  };
  fetchMock = jest.fn(async (url: string, init?: RequestInit) => {
    if (String(url).includes('/api/pilot/admin/data-deletion')) return respond(deleteReply);
    if (String(url).includes('/api/pilot/athletes/list')) return respond(athletesReply);
    if (String(url).includes('/api/pilot/admin/staff')) return respond(staffReply);
    throw new Error(`unexpected fetch ${String(url)} ${init?.method ?? 'GET'}`);
  });
  global.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  global.fetch = originalFetch;
  jest.clearAllMocks();
});

function deleteCalls(): [string, RequestInit][] {
  return (fetchMock.mock.calls as [string, RequestInit][]).filter(([url]) =>
    String(url).includes('/api/pilot/admin/data-deletion'));
}

function listCalls(fragment: string): number {
  return (fetchMock.mock.calls as [string][]).filter(([url]) => String(url).includes(fragment)).length;
}

async function choose(type: 'athlete' | 'guardian', personLabel: RegExp, reason = '  Family moved away  ') {
  fireEvent.change(screen.getByLabelText('Who is being deleted'), { target: { value: type } });
  const picker = await screen.findByLabelText(type === 'athlete' ? 'Athlete' : 'Guardian');
  const option = Array.from((picker as HTMLSelectElement).options).find((entry) => personLabel.test(entry.text));
  if (!option) throw new Error(`no option matching ${personLabel}`);
  fireEvent.change(picker, { target: { value: option.value } });
  fireEvent.change(screen.getByLabelText(/^Reason/), { target: { value: reason } });
}

function optionTexts(label: string): string[] {
  return Array.from((screen.getByLabelText(label) as HTMLSelectElement).options).map((entry) => entry.text);
}

/** Renders and lets the two list reads the page starts with settle. */
async function renderPage() {
  let utils!: ReturnType<typeof render>;
  await act(async () => {
    utils = render(<DataDeletionPage />);
  });
  return utils;
}

/** Presses a button whose handler awaits fetches, and lets them settle. */
async function press(name: string) {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name }));
  });
}

describe('who can open the deletion screen', () => {
  test('the gate admits the organization admin role only (never platform_owner)', async () => {
    await renderPage();
    expect(mockGate.allowedRoles).toEqual(['admin']);
  });

  test('renders on the kiosk surface (Law 5 tap and type floors)', async () => {
    const { container } = await renderPage();
    const main = container.querySelector('main');
    expect(main?.getAttribute('data-surface')).toBe('kiosk');
  });
});

describe('the pickers', () => {
  test('athletes already deleted are not offered; a row with no deleted_at is', async () => {
    await renderPage();
    fireEvent.change(screen.getByLabelText('Who is being deleted'), { target: { value: 'athlete' } });
    await screen.findByLabelText('Athlete');

    const texts = optionTexts('Athlete');
    expect(texts).toContain('Ada Boxer (ath-1)');
    expect(texts).toContain('Cal Southpaw (ath-3)');
    expect(texts.join('|')).not.toContain('Gone Already');
  });

  test('guardians are the parent accounts only, with their children and a switched-off sign-in named', async () => {
    await renderPage();
    fireEvent.change(screen.getByLabelText('Who is being deleted'), { target: { value: 'guardian' } });
    await screen.findByLabelText('Guardian');

    const texts = optionTexts('Guardian');
    expect(texts).toContain('guardian parent@gym.test — guardian of Ada Boxer');
    expect(texts).toContain('guardian acct-parent-off — no linked children; sign-in off');
    expect(texts.join('|')).not.toContain('coach@gym.test');
  });

  test('a list that cannot be read is shown as a refusal, with no picker', async () => {
    athletesReply = { status: 403, body: { error: 'Forbidden: role not allowed' } };
    await renderPage();
    fireEvent.change(screen.getByLabelText('Who is being deleted'), { target: { value: 'athlete' } });

    await screen.findByText(/the athlete list could not be read \(Forbidden: role not allowed\)/);
    expect(screen.queryByLabelText('Athlete')).toBeNull();
  });

  test('a signed-out list read shows the signed-out stamp', async () => {
    staffReply = { status: 401, body: { error: 'Unauthorized' } };
    const { container } = await renderPage();
    fireEvent.change(screen.getByLabelText('Who is being deleted'), { target: { value: 'guardian' } });

    await waitFor(() => expect(container.querySelector('[data-refusal-stamp="signed_out"]')).not.toBeNull());
  });
});

describe('two confirmations before anything is sent', () => {
  test('Review stays disabled until type, person and a non-blank reason are all given', async () => {
    await renderPage();
    const review = screen.getByRole('button', { name: 'Review deletion' }) as HTMLButtonElement;
    expect(review.disabled).toBe(true);

    await choose('athlete', /Ada Boxer/, '   ');
    expect(review.disabled).toBe(true);

    fireEvent.change(screen.getByLabelText(/^Reason/), { target: { value: 'Withdrew' } });
    expect(review.disabled).toBe(false);
    expect(deleteCalls()).toHaveLength(0);
  });

  test('the first confirmation sends nothing, and the second names the person', async () => {
    await renderPage();
    await choose('athlete', /Ada Boxer/);

    fireEvent.click(screen.getByRole('button', { name: 'Review deletion' }));

    expect(screen.getByRole('heading', { name: 'Delete Ada Boxer (ath-1)?' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Delete Ada Boxer (ath-1)' })).toBeTruthy();
    // The reason as it will be sent: trimmed.
    expect(screen.getByText('Family moved away', { selector: 'span' })).toBeTruthy();
    expect(deleteCalls()).toHaveLength(0);
  });

  test('Go back sends nothing and returns to the form', async () => {
    await renderPage();
    await choose('athlete', /Ada Boxer/);
    fireEvent.click(screen.getByRole('button', { name: 'Review deletion' }));

    fireEvent.click(screen.getByRole('button', { name: 'Go back' }));

    expect(screen.queryByRole('button', { name: 'Delete Ada Boxer (ath-1)' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Review deletion' })).toBeTruthy();
    expect(deleteCalls()).toHaveLength(0);
  });

  test('the fields are locked while the second confirmation is showing', async () => {
    await renderPage();
    await choose('athlete', /Ada Boxer/);
    fireEvent.click(screen.getByRole('button', { name: 'Review deletion' }));

    expect((screen.getByLabelText('Who is being deleted') as HTMLSelectElement).disabled).toBe(true);
    expect((screen.getByLabelText('Athlete') as HTMLSelectElement).disabled).toBe(true);
    expect((screen.getByLabelText(/^Reason/) as HTMLTextAreaElement).disabled).toBe(true);
  });
});

describe('the request and the answer', () => {
  test('sends DELETE with the session cookie and exactly the chosen person and trimmed reason', async () => {
    await renderPage();
    await choose('athlete', /Ada Boxer/);
    fireEvent.click(screen.getByRole('button', { name: 'Review deletion' }));
    await press('Delete Ada Boxer (ath-1)');

    await waitFor(() => expect(deleteCalls()).toHaveLength(1));
    const [url, init] = deleteCalls()[0];
    expect(String(url)).toContain('/api/pilot/admin/data-deletion');
    expect(init.method).toBe('DELETE');
    expect(init.credentials).toBe('include');
    expect(JSON.parse(String(init.body))).toEqual({
      entityType: 'athlete',
      entityId: 'ath-1',
      reason: 'Family moved away',
    });
  });

  test('an athlete result shows what the API reported, and the lists are read again', async () => {
    await renderPage();
    await choose('athlete', /Ada Boxer/);
    const athleteReadsBefore = listCalls('/api/pilot/athletes/list');
    fireEvent.click(screen.getByRole('button', { name: 'Review deletion' }));
    await press('Delete Ada Boxer (ath-1)');

    await screen.findByText(/Done: Ada Boxer \(ath-1\) is now marked deleted\./);
    expect(screen.getByText('closed and signed out everywhere')).toBeTruthy();
    expect(screen.getByText('4')).toBeTruthy();
    expect(screen.getByText('812')).toBeTruthy();
    // Gym time (America/New_York), not the viewer's. \s because ICU may put a
    // narrow no-break space before PM.
    expect(screen.getByText(/^September 29, 2026 at 12:00\sPM$/)).toBeTruthy();
    await waitFor(() => expect(listCalls('/api/pilot/athletes/list')).toBeGreaterThan(athleteReadsBefore));
  });

  test('an athlete with no login is reported as having none', async () => {
    deleteReply = {
      status: 200,
      body: {
        deletedEntityType: 'athlete',
        deletedEntityId: 'ath-1',
        deletedRecordsCounts: { athletes: 1, accounts: 0, coachObservationsRetained: 0 },
        deletedAt: '2026-09-29T16:00:00.000Z',
        auditEventId: 813,
      },
    };
    await renderPage();
    await choose('athlete', /Ada Boxer/);
    fireEvent.click(screen.getByRole('button', { name: 'Review deletion' }));
    await press('Delete Ada Boxer (ath-1)');

    await screen.findByText('had no login');
    // A real zero from the server is drawn as a zero.
    expect(screen.getByText('0')).toBeTruthy();
  });

  test('a count the server did not send reads "not reported", never 0', async () => {
    deleteReply = {
      status: 200,
      body: { deletedEntityType: 'athlete', deletedEntityId: 'ath-1', deletedRecordsCounts: {}, deletedAt: '2026-09-29T16:00:00.000Z' },
    };
    await renderPage();
    await choose('athlete', /Ada Boxer/);
    fireEvent.click(screen.getByRole('button', { name: 'Review deletion' }));
    await press('Delete Ada Boxer (ath-1)');

    await screen.findByText(/Done: .* is now marked deleted\./);
    expect(screen.getAllByText('not reported').length).toBe(3);
    expect(screen.queryByText('0')).toBeNull();
  });

  test('a 200 whose answer cannot be read says so and invents no counts', async () => {
    deleteReply = { status: 200, unreadable: true };
    await renderPage();
    await choose('athlete', /Ada Boxer/);
    fireEvent.click(screen.getByRole('button', { name: 'Review deletion' }));
    await press('Delete Ada Boxer (ath-1)');

    await screen.findByText(/The server accepted it, but its answer could not be read\./);
    expect(screen.getAllByText('not reported').length).toBe(4);
  });

  test('a guardian result reports the children withdrawn with them', async () => {
    deleteReply = {
      status: 200,
      body: {
        deletedEntityType: 'guardian',
        deletedEntityId: 'acct-parent',
        deletedRecordsCounts: { accounts: 1, athletes: 2 },
        deletedAt: '2026-09-29T16:00:00.000Z',
        auditEventId: 900,
      },
    };
    await renderPage();
    await choose('guardian', /parent@gym\.test/);
    fireEvent.click(screen.getByRole('button', { name: 'Review deletion' }));
    expect(screen.getByRole('heading', { name: 'Delete guardian parent@gym.test?' })).toBeTruthy();
    await press('Delete guardian parent@gym.test');

    await screen.findByText(/Done: guardian parent@gym\.test is now marked deleted\./);
    expect(screen.getByText('Children withdrawn with them')).toBeTruthy();
    expect(screen.getByText('2')).toBeTruthy();
    expect(JSON.parse(String(deleteCalls()[0][1].body))).toMatchObject({ entityType: 'guardian', entityId: 'acct-parent' });
  });
});

describe('failures read as failures', () => {
  async function submitAthlete() {
    await renderPage();
    await choose('athlete', /Ada Boxer/);
    fireEvent.click(screen.getByRole('button', { name: 'Review deletion' }));
    await press('Delete Ada Boxer (ath-1)');
  }

  test('409 already deleted shows the server sentence in a brass stamp, and no success', async () => {
    deleteReply = {
      status: 409,
      body: { error: 'This athlete was already deleted on September 1, 2026. Nothing was changed.', code: 'ALREADY_DELETED' },
    };
    await submitAthlete();

    await screen.findByText(/This athlete was already deleted on September 1, 2026\. Nothing was changed\./);
    const stamp = document.querySelector('[data-refusal-stamp="cannot_be_done"]');
    expect(stamp).not.toBeNull();
    expect(stamp?.querySelector('.stamp--brass')).not.toBeNull();
    expect(screen.queryByText(/Done: .* is now marked deleted\./)).toBeNull();
  });

  test.each([
    [403, 'Forbidden: Microsoft-authenticated session required'],
    [404, 'Not found: athlete does not exist in this organization'],
  ])('HTTP %s shows the API text and says nothing was deleted', async (status, error) => {
    deleteReply = { status, body: { error } };
    await submitAthlete();

    await screen.findByText(new RegExp(error));
    expect(screen.getByText('Nothing was deleted.')).toBeTruthy();
    expect(screen.queryByText(/Done: .* is now marked deleted\./)).toBeNull();
  });

  test('401 shows the signed-out stamp', async () => {
    deleteReply = { status: 401, body: { error: 'Unauthorized' } };
    await submitAthlete();

    await waitFor(() => expect(document.querySelector('[data-refusal-stamp="signed_out"]')).not.toBeNull());
    expect(screen.queryByText(/Done: .* is now marked deleted\./)).toBeNull();
  });

  test('a 500 shows the API text and does not claim nothing happened', async () => {
    deleteReply = { status: 500, body: { error: 'Internal server error' } };
    await submitAthlete();

    await screen.findByText(/HTTP 500: Internal server error/);
    expect(screen.queryByText('Nothing was deleted.')).toBeNull();
    expect(screen.queryByText(/Done: .* is now marked deleted\./)).toBeNull();
  });

  test('an unreadable error body falls back to the status', async () => {
    deleteReply = { status: 400, unreadable: true };
    await submitAthlete();

    await screen.findByText(/HTTP 400/);
  });

  test('a lost connection says the outcome is unknown, never that nothing happened', async () => {
    deleteReply = 'network-error';
    await submitAthlete();

    await screen.findByText(/could not tell whether the deletion went through/);
    expect(screen.queryByText('Nothing was deleted.')).toBeNull();
    expect(screen.queryByText(/Done: .* is now marked deleted\./)).toBeNull();
  });

  test('never paints the medical --locked red', async () => {
    deleteReply = { status: 409, body: { error: 'This athlete was already deleted on September 1, 2026. Nothing was changed.' } };
    const { container } = await renderPage();
    await choose('athlete', /Ada Boxer/);
    fireEvent.click(screen.getByRole('button', { name: 'Review deletion' }));
    await press('Delete Ada Boxer (ath-1)');
    await screen.findByText(/already deleted on/);

    expect(container.innerHTML).not.toMatch(/--locked|alert--critical|btn--danger|medically_not_allowed/);
  });
});
