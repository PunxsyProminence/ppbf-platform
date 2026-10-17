/**
 * @jest-environment jsdom
 */

// The memberships page: enrollments render with scholarship shown as a
// discount badge, enrolling posts the athlete LINK, the scholarship select
// PATCHes the one-act contract, and a duplicate active enrollment surfaces
// the server's message. The page states the no-billing boundary.

import { act, fireEvent, render, screen } from '@testing-library/react';

import MembershipsPage from './page';

jest.mock('@/components/RoleSessionGate', () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

const MEMBERSHIP = {
  membership_id: 'mem-1',
  athlete_id: 'ath-1',
  athlete_name: 'Jordan Little',
  program_name: 'Youth Boxing',
  status: 'active',
  started_on: '2026-09-01',
  ended_on: null,
  scholarship_percent: 100,
  scholarship_note: '',
};

function mockFetch(options: {
  capture?: { posts: unknown[]; patches: unknown[]; programPosts?: unknown[]; programPatches?: unknown[] };
  postStatus?: number;
  postError?: string;
  /** After a program create, every catalog GET fails -- the stale-list case. */
  programReloadFails?: boolean;
}) {
  // The catalog is stateful within one mock: a program created through the
  // page shows up in the next GET, exactly as the real reload would see it.
  const createdPrograms: string[] = [];
  return jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/admin/programs') && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as { program_name: string };
      options.capture?.programPosts?.push(body);
      createdPrograms.push(body.program_name);
      return {
        ok: true,
        json: async () => ({ item: { program_id: `prog-new-${createdPrograms.length}`, program_name: body.program_name, status: 'active', active_member_count: 0 } }),
      } as Response;
    }
    if (url.includes('/admin/programs') && init?.method === 'PATCH') {
      options.capture?.programPatches?.push(JSON.parse(String(init.body)));
      return { ok: true, json: async () => ({ item: {} }) } as Response;
    }
    if (url.includes('/admin/programs')) {
      if (options.programReloadFails && createdPrograms.length > 0) {
        return { ok: false, status: 500, json: async () => ({}) } as Response;
      }
      const items = [
        { program_id: 'prog-1', program_name: 'Youth Boxing', status: 'active', active_member_count: 1 },
        { program_id: 'prog-2', program_name: 'Retired Program', status: 'archived', active_member_count: 0 },
        ...createdPrograms.map((name, index) => ({ program_id: `prog-new-${index + 1}`, program_name: name, status: 'active', active_member_count: 0 })),
      ];
      return { ok: true, json: async () => ({ items }) } as Response;
    }
    if (url.includes('/admin/memberships') && init?.method === 'POST') {
      options.capture?.posts.push(JSON.parse(String(init.body)));
      if (options.postStatus) {
        return { ok: false, status: options.postStatus, json: async () => ({ error: options.postError }) } as Response;
      }
      return { ok: true, json: async () => ({ item: {} }) } as Response;
    }
    if (url.includes('/admin/memberships') && init?.method === 'PATCH') {
      options.capture?.patches.push(JSON.parse(String(init.body)));
      return { ok: true, json: async () => ({ item: {} }) } as Response;
    }
    if (url.includes('/admin/memberships')) {
      return { ok: true, json: async () => ({ items: [MEMBERSHIP] }) } as Response;
    }
    if (url.includes('/athletes/list')) {
      return { ok: true, json: async () => ({ items: [{ athlete_id: 'ath-2', full_name: 'Casey Stone' }] }) } as Response;
    }
    return { ok: true, json: async () => ({ items: [] }) } as Response;
  }) as unknown as typeof fetch;
}

afterEach(() => {
  jest.restoreAllMocks();
});

test('enrollments render with the scholarship shown as a discount, and the no-billing boundary stated', async () => {
  global.fetch = mockFetch({});

  await act(async () => {
    render(<MembershipsPage />);
  });

  expect(await screen.findByText('Jordan Little')).toBeTruthy();
  expect(screen.getByText('100% scholarship')).toBeTruthy();
  expect(screen.getByText(/No billing happens here/)).toBeTruthy();
  // Lane N4-02: fees are a plan, not a fact (paymentSetup.ts: no charging, no checkout).
  expect(screen.getByText(/fees are planned with the payment lanes, and nothing reads these records for billing yet\./)).toBeTruthy();
  expect(screen.queryByText(/fees arrive with the payment lanes/)).toBeNull();
});

test('enrolling posts the athlete link and the chosen discount', async () => {
  const capture = { posts: [] as unknown[], patches: [] as unknown[] };
  global.fetch = mockFetch({ capture });

  await act(async () => {
    render(<MembershipsPage />);
  });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Enroll athlete' }));
  });
  await act(async () => {
    fireEvent.change(screen.getByLabelText('Athlete'), { target: { value: 'ath-2' } });
    fireEvent.change(screen.getByLabelText('Program'), { target: { value: 'Youth Boxing' } });
    fireEvent.change(screen.getByLabelText('Start date'), { target: { value: '2026-09-01' } });
    // The form's select, not the per-row scholarship selects in the list.
    fireEvent.change(screen.getByLabelText('Scholarship', { selector: 'select#scholarship-percent' }), { target: { value: '100' } });
  });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Save membership' }));
  });

  expect(capture.posts).toEqual([{
    athlete_id: 'ath-2',
    program_name: 'Youth Boxing',
    started_on: '2026-09-01',
    scholarship_percent: 100,
  }]);
});

test('changing a scholarship PATCHes only the scholarship -- one act per call', async () => {
  const capture = { posts: [] as unknown[], patches: [] as unknown[] };
  global.fetch = mockFetch({ capture });

  await act(async () => {
    render(<MembershipsPage />);
  });
  await screen.findByText('Jordan Little');
  await act(async () => {
    fireEvent.change(screen.getByLabelText('Scholarship', { selector: 'select#scholarship-mem-1' }), { target: { value: '50' } });
  });

  expect(capture.patches).toEqual([{ membership_id: 'mem-1', scholarship_percent: 50 }]);
});

test('the program field is a catalog select offering only ACTIVE programs -- free text is gone', async () => {
  global.fetch = mockFetch({});

  await act(async () => {
    render(<MembershipsPage />);
  });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Enroll athlete' }));
  });

  const select = screen.getByLabelText('Program') as HTMLSelectElement;
  expect(select.tagName).toBe('SELECT');
  const optionNames = Array.from(select.options).map((option) => option.textContent);
  expect(optionNames).toContain('Youth Boxing');
  expect(optionNames).not.toContain('Retired Program');
});

test('the inline add-new affordance POSTs to the catalog and selects the new program', async () => {
  const capture = { posts: [] as unknown[], patches: [] as unknown[], programPosts: [] as unknown[], programPatches: [] as unknown[] };
  global.fetch = mockFetch({ capture });

  await act(async () => {
    render(<MembershipsPage />);
  });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Enroll athlete' }));
  });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'New program' }));
  });
  await act(async () => {
    fireEvent.change(screen.getByLabelText('New program name'), { target: { value: 'Fight Camp' } });
  });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Add program' }));
  });

  expect(capture.programPosts).toEqual([{ program_name: 'Fight Camp' }]);
  expect((screen.getByLabelText('Program') as HTMLSelectElement).value).toBe('Fight Camp');
});

test('a created program survives a failed list refresh: still selected, never reported as a failed create', async () => {
  const capture = { posts: [] as unknown[], patches: [] as unknown[], programPosts: [] as unknown[], programPatches: [] as unknown[] };
  global.fetch = mockFetch({ capture, programReloadFails: true });

  await act(async () => {
    render(<MembershipsPage />);
  });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Enroll athlete' }));
  });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'New program' }));
  });
  await act(async () => {
    fireEvent.change(screen.getByLabelText('New program name'), { target: { value: 'Fight Camp' } });
  });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Add program' }));
  });

  // The POST succeeded, so the program is real: it must be selected from
  // the optimistic row, and the only report is the stale-list banner --
  // never a create failure.
  expect(capture.programPosts).toEqual([{ program_name: 'Fight Camp' }]);
  expect((screen.getByLabelText('Program') as HTMLSelectElement).value).toBe('Fight Camp');
  expect(screen.getByText(/The program was created, but the program list could not be refreshed/)).toBeTruthy();
});

test('the catalog section lists programs with live headcounts, and archiving PATCHes the catalog only', async () => {
  const capture = { posts: [] as unknown[], patches: [] as unknown[], programPosts: [] as unknown[], programPatches: [] as unknown[] };
  global.fetch = mockFetch({ capture });

  await act(async () => {
    render(<MembershipsPage />);
  });

  expect(await screen.findByText('Retired Program')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Reactivate' })).toBeTruthy();

  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Archive' }));
  });

  expect(capture.programPatches).toEqual([{ program_id: 'prog-1', status: 'archived' }]);
  // Catalog housekeeping never PATCHes a membership.
  expect(capture.patches).toEqual([]);
});

test('a duplicate active enrollment surfaces the server message', async () => {
  global.fetch = mockFetch({
    capture: { posts: [], patches: [] },
    postStatus: 409,
    postError: 'This athlete already has an active membership in this program. End or lapse it first, or use that row.',
  });

  await act(async () => {
    render(<MembershipsPage />);
  });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Enroll athlete' }));
  });
  await act(async () => {
    fireEvent.change(screen.getByLabelText('Athlete'), { target: { value: 'ath-2' } });
    fireEvent.change(screen.getByLabelText('Program'), { target: { value: 'Youth Boxing' } });
    fireEvent.change(screen.getByLabelText('Start date'), { target: { value: '2026-09-01' } });
  });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Save membership' }));
  });

  expect(await screen.findByText(/already has an active membership/)).toBeTruthy();
});

test('a failed memberships read says so, never "No memberships on record"', async () => {
  global.fetch = jest.fn(async (input: RequestInfo | URL) =>
    String(input).includes('/admin/memberships')
      ? ({ ok: false, status: 500, json: async () => ({}) } as Response)
      : ({ ok: true, json: async () => ({ items: [] }) } as Response),
  ) as unknown as typeof fetch;

  await act(async () => {
    render(<MembershipsPage />);
  });

  expect(await screen.findByText('Memberships could not be read')).toBeTruthy();
  expect(screen.queryByText('No memberships on record')).toBeNull();
});

test('a failed programs read says so, never "No programs on record. Create the first..."', async () => {
  global.fetch = jest.fn(async (input: RequestInfo | URL) =>
    String(input).includes('/admin/programs')
      ? ({ ok: false, status: 500, json: async () => ({}) } as Response)
      : ({ ok: true, json: async () => ({ items: [MEMBERSHIP] }) } as Response),
  ) as unknown as typeof fetch;

  await act(async () => {
    render(<MembershipsPage />);
  });

  expect(await screen.findByText('Programs could not be read')).toBeTruthy();
  expect(screen.queryByText('No programs on record')).toBeNull();
});

// PH-12b: support the gym gave a family, recorded on this page.
const SUPPORT_ROW = {
  record_id: '0f8fad5b-d9cb-469f-a165-70867728950e',
  support_kind: 'Transportation to the October 12 tournament',
  provided_on: '2026-10-12',
  recorded_by_name: 'Jane Okafor',
  created_at: '2026-10-12T15:00:00.000Z',
};

function mockSupportFetch(options: {
  supportReadFails?: boolean;
  sent?: Array<{ method: string; body: unknown }>;
  /** Every POST/PATCH fails with this status and server message. */
  writeFails?: { status: number; error: string };
} = {}) {
  const rest = mockFetch({});
  // Stateful like the server: a retired row leaves the next read.
  let live = [SUPPORT_ROW];
  return jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (!url.includes('/admin/family-support')) return rest(input, init);
    if (init?.method === 'POST' || init?.method === 'PATCH') {
      const body = JSON.parse(String(init.body)) as { record_id?: string; action?: string };
      options.sent?.push({ method: init.method, body });
      // Held open a tick, so a second click lands while the first is in flight.
      await new Promise((resolve) => setTimeout(resolve, 10));
      if (options.writeFails) {
        return { ok: false, status: options.writeFails.status, json: async () => ({ error: options.writeFails?.error }) } as Response;
      }
      if (init.method === 'PATCH') live = live.filter((row) => row.record_id !== body.record_id);
      return { ok: true, json: async () => ({ item: { record_id: SUPPORT_ROW.record_id } }) } as Response;
    }
    if (options.supportReadFails) return { ok: false, status: 500, json: async () => ({}) } as Response;
    return { ok: true, json: async () => ({ items: live }) } as Response;
  }) as unknown as typeof fetch;
}

const RETIRE_NAME = 'Retire: Transportation to the October 12 tournament, October 12, 2026';

function supportReads(): number {
  return (global.fetch as jest.Mock).mock.calls.filter(
    ([url, init]) => String(url).includes('/admin/family-support?') && !(init as RequestInit | undefined)?.method,
  ).length;
}

async function openSupportForJordan() {
  await act(async () => {
    render(<MembershipsPage />);
  });
  await screen.findByText('Jordan Little');
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Support provided to Jordan Little' }));
  });
}

test("a membership row opens that athlete's support: what, when and who recorded it, and the label says the family can see it", async () => {
  global.fetch = mockSupportFetch();
  await openSupportForJordan();

  expect(await screen.findByText('Transportation to the October 12 tournament')).toBeTruthy();
  expect(screen.getByText('Jane Okafor')).toBeTruthy();
  // A calendar day, shown as that day -- not shifted into the day before.
  expect(screen.getByText('October 12, 2026')).toBeTruthy();
  expect(screen.getByLabelText('What the gym provided (the family will see this and the date)')).toBeTruthy();
  expect(String((global.fetch as jest.Mock).mock.calls.map(([url]) => String(url)))).toContain('/api/pilot/admin/family-support?athlete_id=ath-1');
});

test('recording posts the athlete, what was provided and the date, once however fast it is clicked', async () => {
  const sent: Array<{ method: string; body: unknown }> = [];
  global.fetch = mockSupportFetch({ sent });
  await openSupportForJordan();

  await act(async () => {
    fireEvent.change(screen.getByLabelText('What the gym provided (the family will see this and the date)'), { target: { value: 'Gloves and wraps' } });
    fireEvent.change(screen.getByLabelText('Date provided'), { target: { value: '2026-09-30' } });
  });
  await act(async () => {
    const button = screen.getByRole('button', { name: 'Record support' });
    fireEvent.click(button);
    fireEvent.click(button);
    await new Promise((resolve) => setTimeout(resolve, 30));
  });

  expect(sent).toEqual([{ method: 'POST', body: { athlete_id: 'ath-1', support_kind: 'Gloves and wraps', provided_on: '2026-09-30' } }]);
});

test('Retire sends the one change there is -- retire, by record id -- and nothing is deleted', async () => {
  const sent: Array<{ method: string; body: unknown }> = [];
  global.fetch = mockSupportFetch({ sent });
  await openSupportForJordan();

  await act(async () => {
    fireEvent.click(await screen.findByRole('button', { name: RETIRE_NAME }));
    await new Promise((resolve) => setTimeout(resolve, 30));
  });

  expect(sent).toEqual([{ method: 'PATCH', body: { record_id: SUPPORT_ROW.record_id, action: 'retire' } }]);
  expect((global.fetch as jest.Mock).mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === 'DELETE')).toBe(false);
});

test('each Retire button names its record, and the list is read again after a retire', async () => {
  global.fetch = mockSupportFetch();
  await openSupportForJordan();

  const button = await screen.findByRole('button', { name: RETIRE_NAME });
  expect(button.textContent).toBe('Retire');
  const readsBefore = supportReads();
  await act(async () => {
    fireEvent.click(button);
    await new Promise((resolve) => setTimeout(resolve, 30));
  });

  expect(supportReads()).toBe(readsBefore + 1);
  expect(screen.queryByText('Transportation to the October 12 tournament')).toBeNull();
  expect(screen.getByText('No support recorded for this athlete.')).toBeTruthy();
});

test('a double-clicked Retire sends once', async () => {
  const sent: Array<{ method: string; body: unknown }> = [];
  global.fetch = mockSupportFetch({ sent });
  await openSupportForJordan();

  await act(async () => {
    const button = await screen.findByRole('button', { name: RETIRE_NAME });
    fireEvent.click(button);
    fireEvent.click(button);
    await new Promise((resolve) => setTimeout(resolve, 30));
  });

  expect(sent).toEqual([{ method: 'PATCH', body: { record_id: SUPPORT_ROW.record_id, action: 'retire' } }]);
});

test("a refused record or retire shows the server's message", async () => {
  global.fetch = mockSupportFetch({ writeFails: { status: 400, error: 'The date provided cannot be in the future.' } });
  await openSupportForJordan();

  await act(async () => {
    fireEvent.change(screen.getByLabelText('What the gym provided (the family will see this and the date)'), { target: { value: 'Gloves' } });
    fireEvent.change(screen.getByLabelText('Date provided'), { target: { value: '2026-09-30' } });
  });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Record support' }));
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
  expect(screen.getByRole('alert').textContent).toBe('The date provided cannot be in the future.');

  global.fetch = mockSupportFetch({ writeFails: { status: 409, error: 'This record is already retired.' } });
  await act(async () => {
    fireEvent.click(await screen.findByRole('button', { name: RETIRE_NAME }));
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
  expect(screen.getByRole('alert').textContent).toBe('This record is already retired.');
});

test('a failed support read says so, never "No support recorded"', async () => {
  global.fetch = mockSupportFetch({ supportReadFails: true });
  await openSupportForJordan();

  expect(await screen.findByText('Support could not be read')).toBeTruthy();
  expect(screen.queryByText('No support recorded for this athlete.')).toBeNull();
});
