/**
 * @jest-environment jsdom
 */

// The content-import screen loads the gym's reference content. Pinned here:
// the role it admits; that choosing files and checking sends the files and
// nothing else (no commit, no organization); that the plan is shown -- new,
// new version, unchanged, absent, blocking findings, warnings; that Apply is
// off while anything blocks and when there is nothing to write; that Apply
// sends the hash of the plan on screen; that a refusal clears the plan
// rather than leaving a stale one beside it; that a Check after an Apply is a
// proposal again, never "loaded"; that the file input is emptied once read, so
// an edited file chosen again is read again; and that outcomes are contract
// badges (Law 3).

import type { ReactNode } from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import ContentImportPage from './page';

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

type Reply = { status: number; body?: unknown } | 'network-error';

const HASH = 'c'.repeat(64);
const DRILLS_CSV = 'drill_id,name\ndrl_0000000000000a,Jab Ladder\n';

function planBody(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    committed: false,
    plan: {
      organization_id: 'org-1',
      actor: { account_id: 'admin-1', role: 'organization_admin' },
      datasets: ['drill-library'],
      counts: { 'drill-library': { new: 1, new_version: 1, unchanged: 1, absent: 1, reject: 0 } },
      totals: { new: 1, new_version: 1, unchanged: 1, absent: 1, reject: 0 },
      changes: 2,
      plan_hash: HASH,
      units: [
        { dataset: 'drill-library', key: 'drl_0000000000000a', outcome: 'new', label: 'Jab Ladder', to_version: 1 },
        { dataset: 'drill-library', key: 'drl_0000000000000b', outcome: 'new_version', label: 'Slip Line', from_version: 1, to_version: 2 },
        { dataset: 'drill-library', key: 'drl_0000000000000c', outcome: 'unchanged', label: 'Shadow Rounds' },
        { dataset: 'drill-library', key: 'drl_0000000000000d', outcome: 'absent' },
      ],
      blocking: [],
      warnings: [{ code: 'repeated_text', file: 'seed_drill_cues.csv', column: 'evidence_note', count: 12, message: 'the same text in 12 rows' }],
      ...overrides,
    },
  };
}

// Two changes AND a blocking finding: Apply must be off because of the
// finding, not because there is nothing to write. With changes: 0 here, a page
// that ignored blocking findings still passed (mutation M6, 2026-09-29).
const BLOCKED = planBody({
  changes: 2,
  blocking: [
    {
      code: 'literal_organization',
      file: 'seed_drill_library.csv',
      line: 2,
      column: 'organization_id',
      key: 'drl_0000000000000a',
      message: "a real organization id ('org-2') is refused; write {{PPBF_ORG_ID}} or leave it blank",
    },
  ],
});

let reply: Reply;
let fetchMock: jest.Mock;

function respond(next: Reply): Response {
  if (next === 'network-error') throw new TypeError('Failed to fetch');
  return {
    ok: next.status >= 200 && next.status < 300,
    status: next.status,
    json: async () => next.body,
  } as unknown as Response;
}

beforeEach(() => {
  mockGate.allowedRoles = null;
  reply = { status: 200, body: planBody() };
  fetchMock = jest.fn(async (url: string) => {
    if (String(url).includes('/api/pilot/admin/content-import')) return respond(reply);
    throw new Error(`unexpected fetch ${String(url)}`);
  });
  global.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  global.fetch = originalFetch;
  jest.clearAllMocks();
});

function sent(index = 0): Record<string, unknown> {
  const init = fetchMock.mock.calls[index][1] as RequestInit;
  return JSON.parse(String(init.body)) as Record<string, unknown>;
}

async function chooseFiles(list: File[]) {
  const input = screen.getByLabelText('Content files (CSV)');
  await act(async () => {
    fireEvent.change(input, { target: { files: list } });
  });
  await screen.findByRole('list', { name: 'Chosen files' });
}

async function checkFiles() {
  fireEvent.click(screen.getByRole('button', { name: 'Check these files' }));
  await screen.findByRole('heading', { name: 'What this would do' });
}

test('admits the organization-admin client role only, the route\'s own list', () => {
  render(<ContentImportPage />);

  expect(mockGate.allowedRoles).toEqual(['admin']);
});

test('nothing is sent until Check, and Check sends the files as text with no commit and no organization', async () => {
  render(<ContentImportPage />);
  expect((screen.getByRole('button', { name: 'Check these files' }) as HTMLButtonElement).disabled).toBe(true);

  await chooseFiles([
    new File([DRILLS_CSV], 'seed_drill_library.csv', { type: 'text/csv' }),
    new File(['not text'], 'clip.mp4', { type: 'video/mp4' }),
  ]);
  expect(fetchMock).not.toHaveBeenCalled();

  await checkFiles();

  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  expect(url).toContain('/api/pilot/admin/content-import');
  expect(init.method).toBe('POST');
  // The video goes by name only: the core refuses it as media, and its bytes
  // never leave the device.
  expect(sent()).toEqual({
    files: [
      { name: 'seed_drill_library.csv', text: DRILLS_CSV },
      { name: 'clip.mp4', text: '' },
    ],
  });
});

test('the plan shows new, new version, unchanged, absent and warnings, and Apply sends the plan\'s hash', async () => {
  render(<ContentImportPage />);
  await chooseFiles([new File([DRILLS_CSV], 'seed_drill_library.csv', { type: 'text/csv' })]);
  await checkFiles();

  const plan = screen.getByRole('region', { name: 'Plan' });
  // The gym the server planned for -- the session's -- is named before Apply.
  expect(plan.textContent).toContain('Gym org-1, as admin-1 (organization_admin)');
  expect(within(plan).getByText(/1 new · 1 new version · 1 unchanged · 1 absent · 0 reject/)).not.toBeNull();
  expect(within(plan).getByText(/Jab Ladder · drl_0000000000000a/)).not.toBeNull();
  expect(within(plan).getByText(/Slip Line · drl_0000000000000b/)).not.toBeNull();
  expect(within(plan).getByText('(history v1 → v2)', { exact: false })).not.toBeNull();
  expect(within(plan).getByText(/UNCHANGED \(1\)/)).not.toBeNull();
  expect(within(plan).getByText(/drl_0000000000000d/)).not.toBeNull();
  expect(within(plan).getByText(/Left alone; nothing is removed/)).not.toBeNull();
  expect(within(plan).getByRole('region', { name: 'Warnings' }).textContent).toContain('repeated_text');
  expect(within(plan).queryByRole('region', { name: 'Blocking findings' })).toBeNull();

  const apply = screen.getByRole('button', { name: 'Apply 2 changes' });
  expect((apply as HTMLButtonElement).disabled).toBe(false);

  reply = {
    status: 200,
    body: {
      ...planBody(),
      committed: true,
      import_id: 'imp_1',
      audit_id: '42',
      written: { 'drill-library': { inserted: ['drl_0000000000000a'], updated: ['drl_0000000000000b'], ledgerRows: 0 } },
      ledger_rows: 0,
      audit_mirror: 'written',
    },
  };
  fireEvent.click(apply);

  await screen.findByText('✓ Applied: 2 items written.');
  expect(sent(1)).toEqual({
    files: [{ name: 'seed_drill_library.csv', text: DRILLS_CSV }],
    commit: true,
    plan_hash: HASH,
  });
  expect(screen.getByText(/1 added, 1 revised, 0 history rows/)).not.toBeNull();
  expect(screen.getByRole('heading', { name: 'What was loaded' })).not.toBeNull();
  expect(screen.queryByRole('button', { name: /^Apply/ })).toBeNull();
});

test('blocking findings are listed and Apply is disabled', async () => {
  reply = { status: 200, body: BLOCKED };
  render(<ContentImportPage />);
  await chooseFiles([new File([DRILLS_CSV], 'seed_drill_library.csv', { type: 'text/csv' })]);
  await checkFiles();

  const blocking = screen.getByRole('region', { name: 'Blocking findings' });
  expect(blocking.textContent).toContain('BLOCKING (1)');
  expect(blocking.textContent).toContain('literal_organization · seed_drill_library.csv:2 organization_id (drl_0000000000000a)');
  expect(blocking.textContent).toContain("a real organization id ('org-2') is refused");

  const apply = screen.getByRole('button', { name: 'Apply 2 changes' });
  expect((apply as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText('Apply is off: 1 blocking finding above.')).not.toBeNull();

  fireEvent.click(apply);
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test('Apply is off when every item is unchanged or absent', async () => {
  reply = {
    status: 200,
    body: planBody({
      changes: 0,
      counts: { 'drill-library': { new: 0, new_version: 0, unchanged: 1, absent: 0, reject: 0 } },
      units: [{ dataset: 'drill-library', key: 'drl_0000000000000c', outcome: 'unchanged' }],
      warnings: [],
    }),
  };
  render(<ContentImportPage />);
  await chooseFiles([new File([DRILLS_CSV], 'seed_drill_library.csv', { type: 'text/csv' })]);
  await checkFiles();

  expect((screen.getByRole('button', { name: 'Apply 0 changes' }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText('Nothing to apply: every item is unchanged or absent.')).not.toBeNull();
});

test('a stale plan at Apply is refused: the plan goes, the reason shows, and it says to check again', async () => {
  render(<ContentImportPage />);
  await chooseFiles([new File([DRILLS_CSV], 'seed_drill_library.csv', { type: 'text/csv' })]);
  await checkFiles();

  reply = {
    status: 409,
    body: { error: 'the database changed after the plan was made (plan cccccccccccc, now dddddddddddd); nothing was written.', code: 'STALE_PLAN' },
  };
  fireEvent.click(screen.getByRole('button', { name: 'Apply 2 changes' }));

  await screen.findByText(/the database changed after the plan was made/);
  expect(screen.getByText(/Nothing was written\. Check the files again/)).not.toBeNull();
  expect(screen.queryByRole('region', { name: 'Plan' })).toBeNull();
  expect(screen.queryByRole('button', { name: /^Apply/ })).toBeNull();
});

test('a lost connection at Apply never reads as "nothing happened"', async () => {
  render(<ContentImportPage />);
  await chooseFiles([new File([DRILLS_CSV], 'seed_drill_library.csv', { type: 'text/csv' })]);
  await checkFiles();

  reply = 'network-error';
  fireEvent.click(screen.getByRole('button', { name: 'Apply 2 changes' }));

  await screen.findByText(/could not tell whether the content was applied/);
  expect(screen.queryByText(/Nothing was written/)).toBeNull();
  expect(screen.queryByRole('region', { name: 'Plan' })).toBeNull();
});

test('a cap refusal at Check shows the server\'s number', async () => {
  reply = { status: 413, body: { error: 'Unsupported upload: the files hold 10,001 rows, and this accepts 10,000 at a time.', code: 'UPLOAD_TOO_MANY_ROWS' } };
  render(<ContentImportPage />);
  await chooseFiles([new File([DRILLS_CSV], 'seed_drill_library.csv', { type: 'text/csv' })]);
  fireEvent.click(screen.getByRole('button', { name: 'Check these files' }));

  await screen.findByText(/10,001 rows, and this accepts 10,000 at a time/);
  expect(screen.queryByRole('region', { name: 'Plan' })).toBeNull();
});

test('Check pressed after an Apply shows the new plan as a proposal, with its own Apply', async () => {
  render(<ContentImportPage />);
  await chooseFiles([new File([DRILLS_CSV], 'seed_drill_library.csv', { type: 'text/csv' })]);
  await checkFiles();
  reply = {
    status: 200,
    body: { ...planBody(), committed: true, import_id: 'imp_1', audit_id: '42', written: {}, audit_mirror: 'written' },
  };
  fireEvent.click(screen.getByRole('button', { name: 'Apply 2 changes' }));
  await screen.findByRole('heading', { name: 'What was loaded' });

  // "Did it go through?" -- and in the meantime the gym's content moved, so
  // this plan has changes of its own. It was NOT applied: it must not read
  // as loaded, and it must be appliable without choosing the files again.
  const NEXT = 'd'.repeat(64);
  reply = { status: 200, body: planBody({ plan_hash: NEXT }) };
  fireEvent.click(screen.getByRole('button', { name: 'Check these files' }));

  await screen.findByRole('heading', { name: 'What this would do' });
  expect(screen.queryByRole('heading', { name: 'What was loaded' })).toBeNull();
  expect(screen.queryByText(/✓ Applied/)).toBeNull();
  expect(sent(2)).toEqual({ files: [{ name: 'seed_drill_library.csv', text: DRILLS_CSV }] });
  const apply = screen.getByRole('button', { name: 'Apply 2 changes' });
  expect((apply as HTMLButtonElement).disabled).toBe(false);

  fireEvent.click(apply);
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
  expect(sent(3)).toMatchObject({ commit: true, plan_hash: NEXT });
});

test('the file input is emptied after its files are read, so the same file edited and chosen again is read again', async () => {
  render(<ContentImportPage />);
  const input = screen.getByLabelText('Content files (CSV)') as HTMLInputElement;
  // A browser fires no change event when the path chosen is the one already
  // selected, and setting value to '' empties the selection. Both are browser
  // behaviour the test DOM does not have, so the second is stood in for here:
  // a page that emptied the input BEFORE taking its files would read none.
  const emptied: string[] = [];
  Object.defineProperty(input, 'value', {
    configurable: true,
    get: () => '',
    set: (next: string) => {
      emptied.push(next);
      Object.defineProperty(input, 'files', { configurable: true, writable: true, value: [] });
    },
  });

  await chooseFiles([new File([DRILLS_CSV], 'seed_drill_library.csv', { type: 'text/csv' })]);
  expect(emptied).toEqual(['']);
  await checkFiles();
  expect(sent(0)).toEqual({ files: [{ name: 'seed_drill_library.csv', text: DRILLS_CSV }] });

  const EDITED = 'drill_id,name\ndrl_0000000000000a,Jab Ladder (fixed)\n';
  await act(async () => {
    fireEvent.change(input, { target: { files: [new File([EDITED], 'seed_drill_library.csv', { type: 'text/csv' })] } });
  });
  expect(emptied).toEqual(['', '']);
  await waitFor(() => expect(screen.queryByRole('region', { name: 'Plan' })).toBeNull());
  // Check is off while the files are being read.
  const check = screen.getByRole('button', { name: 'Check these files' }) as HTMLButtonElement;
  await waitFor(() => expect(check.disabled).toBe(false));
  fireEvent.click(check);
  await screen.findByRole('heading', { name: 'What this would do' });
  expect(sent(1)).toEqual({ files: [{ name: 'seed_drill_library.csv', text: EDITED }] });
});

test('every outcome is a .badge with one of the contract\'s four glyphs and an uppercase label, never colour alone', async () => {
  reply = {
    status: 200,
    body: planBody({
      units: [
        ...planBody().plan.units,
        { dataset: 'drill-library', key: 'drl_0000000000000e', outcome: 'reject', label: 'Bad Row', reasons: ['refused'] },
      ],
    }),
  };
  render(<ContentImportPage />);
  await chooseFiles([new File([DRILLS_CSV], 'seed_drill_library.csv', { type: 'text/csv' })]);
  await checkFiles();

  const plan = screen.getByRole('region', { name: 'Plan' });
  const badges = Array.from(plan.querySelectorAll('.badge'));
  // docs/FRONTEND_STYLE_CONTRACT.md:43-45 (Law 3). Administrative rung only:
  // no plan outcome is a safety state (Law 2).
  expect(badges.map((badge) => badge.textContent)).toEqual(['✕REJECT', '✓NEW', '✓NEW VERSION', '◉ABSENT', '✓UNCHANGED']);
  for (const badge of badges) {
    expect(badge.className).toBe('badge badge--filed');
    expect(['✓', '◉', '▲', '✕']).toContain(badge.querySelector('i')?.textContent);
  }
});

test('choosing other files clears the plan, so Apply can never run against files no longer on screen', async () => {
  render(<ContentImportPage />);
  await chooseFiles([new File([DRILLS_CSV], 'seed_drill_library.csv', { type: 'text/csv' })]);
  await checkFiles();
  expect((screen.getByRole('button', { name: 'Apply 2 changes' }) as HTMLButtonElement).disabled).toBe(false);

  await chooseFiles([new File(['drill_id,name\n'], 'seed_drill_cues.csv', { type: 'text/csv' })]);

  await waitFor(() => expect(screen.queryByRole('region', { name: 'Plan' })).toBeNull());
  expect(screen.queryByRole('button', { name: /^Apply/ })).toBeNull();
});
