/**
 * @jest-environment jsdom
 */

// The memberships page: enrollments render with scholarship shown as a
// discount badge, enrolling posts the athlete LINK, the scholarship select
// PATCHes the one-act contract, and a duplicate active enrollment surfaces
// the server's message. The page states the no-billing boundary.

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';

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
      const sent = JSON.parse(String(init.body)) as { athlete_id: string; program_name: string; started_on: string; scholarship_percent: number };
      options.capture?.posts.push(sent);
      if (options.postStatus) {
        return { ok: false, status: options.postStatus, json: async () => ({ error: options.postError }) } as Response;
      }
      // The route answers with the saved row (route.ts POST).
      return { ok: true, json: async () => ({ item: { ...MEMBERSHIP, ...sent, membership_id: 'mem-new', athlete_name: 'Casey Stone' } }) } as Response;
    }
    if (url.includes('/admin/memberships') && init?.method === 'PATCH') {
      const change = JSON.parse(String(init.body)) as Record<string, unknown>;
      options.capture?.patches.push(change);
      // The route answers with the changed row.
      return { ok: true, json: async () => ({ item: { ...MEMBERSHIP, ...change } }) } as Response;
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
  // A plain start date is its own calendar day at the gym, not the day before.
  expect(screen.getByText(/since September 1, 2026/)).toBeTruthy();
  expect(screen.queryByText(/8\/31\/2026|August 31, 2026/)).toBeNull();
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

  expect(await screen.findByText("Couldn't load memberships.")).toBeTruthy();
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

// Lane L41 (pilot audit 2026-10-17, item 3): the athlete list says loading,
// failed or empty; a save says Saved, Not saved or what the list shows -- and
// the form keeps what was typed until one of those is known. Each case fails
// on main.
describe('truthful roster and save states', () => {
  type Reply = { status: number; body?: unknown } | 'network';
  const CASEY_ROW = { ...MEMBERSHIP, membership_id: 'mem-2', athlete_id: 'ath-2', athlete_name: 'Casey Stone', scholarship_percent: 0 };
  const PROGRAMS = { items: [{ program_id: 'prog-1', program_name: 'Youth Boxing', status: 'active', active_member_count: 1 }] };

  /** Each queue answers in order; its last reply repeats. */
  function scriptedFetch(script: { roster?: Reply[]; list?: Reply[]; post?: Reply; patch?: Reply }) {
    const roster = script.roster ?? [{ status: 200, body: { items: [{ athlete_id: 'ath-2', full_name: 'Casey Stone' }] } }];
    const list = script.list ?? [{ status: 200, body: { items: [MEMBERSHIP] } }];
    const next = (queue: Reply[]) => (queue.length > 1 ? queue.shift()! : queue[0]);
    const answer = (reply: Reply): Response => {
      if (reply === 'network') throw new TypeError('Failed to fetch');
      return { ok: reply.status >= 200 && reply.status < 300, status: reply.status, json: async () => reply.body ?? {} } as Response;
    };
    return jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/athletes/list')) return answer(next(roster));
      if (url.includes('/admin/programs')) return answer({ status: 200, body: PROGRAMS });
      if (url.includes('/admin/memberships') && init?.method === 'POST') return answer(script.post ?? { status: 200, body: { item: CASEY_ROW } });
      if (url.includes('/admin/memberships') && init?.method === 'PATCH') {
        return answer(script.patch ?? { status: 200, body: { item: { ...MEMBERSHIP, ...(JSON.parse(String(init.body)) as object) } } });
      }
      if (url.includes('/admin/memberships')) return answer(next(list));
      return answer({ status: 200, body: { items: [] } });
    }) as unknown as typeof fetch;
  }

  async function renderPage() {
    await act(async () => {
      render(<MembershipsPage />);
    });
  }

  async function fillAndSave() {
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
  }

  const athleteField = () => screen.getByLabelText('Athlete').closest('.field') as HTMLElement;

  test('a failed athlete list says so under the picker, and Check again fills it', async () => {
    global.fetch = scriptedFetch({ roster: [{ status: 500 }, { status: 200, body: { items: [{ athlete_id: 'ath-2', full_name: 'Casey Stone' }] } }] });
    await renderPage();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Enroll athlete' }));
    });

    expect(within(athleteField()).getByText("Couldn't load the athlete list.")).toBeTruthy();
    expect(screen.queryByText("No athletes on this gym's roster yet.")).toBeNull();

    await act(async () => {
      fireEvent.click(within(athleteField()).getByRole('button', { name: 'Check again' }));
    });

    expect(within(athleteField()).queryByText("Couldn't load the athlete list.")).toBeNull();
    expect(within(athleteField()).getByRole('option', { name: 'Casey Stone' })).toBeTruthy();
  });

  test('an empty athlete list says the roster is empty, not that it failed', async () => {
    global.fetch = scriptedFetch({ roster: [{ status: 200, body: { items: [] } }] });
    await renderPage();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Enroll athlete' }));
    });

    expect(within(athleteField()).getByText("No athletes on this gym's roster yet.")).toBeTruthy();
    expect(screen.queryByText("Couldn't load the athlete list.")).toBeNull();
  });

  test('a confirmed save whose list refresh fails says Saved, keeps the row, and Check again refreshes', async () => {
    global.fetch = scriptedFetch({
      list: [{ status: 200, body: { items: [MEMBERSHIP] } }, { status: 500 }, { status: 200, body: { items: [MEMBERSHIP, CASEY_ROW] } }],
    });
    await renderPage();
    await fillAndSave();

    expect(screen.getByText("Saved: Casey Stone in Youth Boxing. The list didn't refresh.")).toBeTruthy();
    expect(screen.queryByText('Failed')).toBeNull();
    expect(screen.getByRole('cell', { name: 'Casey Stone' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Save membership' })).toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    });

    expect(screen.queryByText(/The list didn't refresh/)).toBeNull();
    expect(screen.getByRole('cell', { name: 'Casey Stone' })).toBeTruthy();
  });

  test('a 200 whose reply does not carry the row is not taken as saved: the list decides, and the form stays', async () => {
    global.fetch = scriptedFetch({ post: { status: 200, body: { item: {} } } });
    await renderPage();
    await fillAndSave();

    expect(screen.getByText('Not saved: the list does not show Casey Stone active in Youth Boxing. Save again when ready.')).toBeTruthy();
    expect((screen.getByLabelText('Athlete') as HTMLSelectElement).value).toBe('ath-2');
    expect((screen.getByLabelText('Start date') as HTMLInputElement).value).toBe('2026-09-01');
  });

  test('a 500 on save re-reads the list and says what it shows', async () => {
    global.fetch = scriptedFetch({
      post: { status: 500 },
      list: [{ status: 200, body: { items: [MEMBERSHIP] } }, { status: 200, body: { items: [MEMBERSHIP, CASEY_ROW] } }],
    });
    await renderPage();
    await fillAndSave();

    expect(screen.getByText('The list now shows Casey Stone active in Youth Boxing. No need to save again.')).toBeTruthy();
    expect(screen.queryByText('Failed')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save membership' })).toBeNull();
  });

  test('a lost reply with the row absent from the list says Not saved and keeps the form', async () => {
    global.fetch = scriptedFetch({ post: 'network' });
    await renderPage();
    await fillAndSave();

    expect(screen.getByText('Not saved: the list does not show Casey Stone active in Youth Boxing. Save again when ready.')).toBeTruthy();
    expect(screen.queryByText(/Failed to fetch/)).toBeNull();
    expect((screen.getByLabelText('Athlete') as HTMLSelectElement).value).toBe('ath-2');
  });

  test('a lost reply with an unreadable list says not sure, keeps the form, and Check again settles it', async () => {
    global.fetch = scriptedFetch({
      post: { status: 502 },
      list: [{ status: 200, body: { items: [MEMBERSHIP] } }, { status: 500 }, { status: 200, body: { items: [MEMBERSHIP, CASEY_ROW] } }],
    });
    await renderPage();
    await fillAndSave();

    expect(screen.getByText('Not sure it was saved, and the list could not be read. Check before saving again.')).toBeTruthy();
    expect((screen.getByLabelText('Athlete') as HTMLSelectElement).value).toBe('ath-2');

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    });

    expect(screen.getByText('The list now shows Casey Stone active in Youth Boxing. No need to save again.')).toBeTruthy();
    expect(screen.queryByText(/Not sure it was saved/)).toBeNull();
  });

  test('a refused save says Not saved in words and keeps the form', async () => {
    global.fetch = scriptedFetch({ post: { status: 400, body: { error: 'Missing athlete_id.' } } });
    await renderPage();
    await fillAndSave();

    expect(screen.getByText('Not saved. Choose an athlete.')).toBeTruthy();
    expect(screen.queryByText(/athlete_id/)).toBeNull();
    expect((screen.getByLabelText('Start date') as HTMLInputElement).value).toBe('2026-09-01');
  });

  test('a saved row change whose refresh fails says Saved, not Failed', async () => {
    global.fetch = scriptedFetch({ list: [{ status: 200, body: { items: [MEMBERSHIP] } }, { status: 500 }] });
    await renderPage();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Mark lapsed' }));
    });

    expect(screen.getByText("Saved. The list didn't refresh.")).toBeTruthy();
    expect(screen.queryByText('Failed')).toBeNull();
    expect(screen.queryByText('Unable to load memberships.')).toBeNull();
  });

  test('a failed memberships read offers Check again, which loads the list', async () => {
    global.fetch = scriptedFetch({ list: [{ status: 500 }, { status: 200, body: { items: [MEMBERSHIP] } }] });
    await renderPage();

    expect(screen.getByText("Couldn't load memberships.")).toBeTruthy();
    expect(screen.queryByText(/Reload the page/)).toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    });

    expect(screen.getByRole('cell', { name: 'Jordan Little' })).toBeTruthy();
  });

  /** Holds every request whose URL and method match until release() is called. */
  function holding(base: typeof fetch, match: (url: string, method?: string) => boolean) {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const held = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (match(String(input), init?.method)) await gate;
      return base(input, init);
    }) as unknown as typeof fetch;
    return { held, release: () => release() };
  }

  test('the athlete picker says the list is loading until it arrives', async () => {
    const { held, release } = holding(scriptedFetch({}), (url) => url.includes('/athletes/list'));
    global.fetch = held;
    await renderPage();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Enroll athlete' }));
    });

    expect(within(athleteField()).getByText('Loading the athlete list…')).toBeTruthy();
    expect(screen.queryByText("No athletes on this gym's roster yet.")).toBeNull();

    await act(async () => {
      release();
    });
    expect(within(athleteField()).queryByText('Loading the athlete list…')).toBeNull();
  });

  test('a 200 without a list is a failed read, not an empty roster', async () => {
    global.fetch = scriptedFetch({ roster: [{ status: 200, body: {} }] });
    await renderPage();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Enroll athlete' }));
    });

    expect(within(athleteField()).getByText("Couldn't load the athlete list.")).toBeTruthy();
    expect(screen.queryByText("No athletes on this gym's roster yet.")).toBeNull();
  });

  test('a duplicate enrollment says Not saved with the server sentence, and keeps the form', async () => {
    global.fetch = scriptedFetch({
      post: { status: 409, body: { error: 'This athlete already has an active membership in this program. End or lapse it first, or use that row.' } },
    });
    await renderPage();
    await fillAndSave();

    expect(screen.getByText('Not saved. This athlete already has an active membership in this program. End or lapse it first, or use that row.')).toBeTruthy();
    expect((screen.getByLabelText('Athlete') as HTMLSelectElement).value).toBe('ath-2');
  });

  test('typing done while a save is in flight is kept when the save confirms', async () => {
    const { held, release } = holding(
      scriptedFetch({ list: [{ status: 200, body: { items: [MEMBERSHIP] } }, { status: 200, body: { items: [MEMBERSHIP, CASEY_ROW] } }] }),
      (url, method) => url.includes('/admin/memberships') && method === 'POST',
    );
    global.fetch = held;
    await renderPage();
    await fillAndSave();
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Start date'), { target: { value: '2026-09-15' } });
    });
    await act(async () => {
      release();
    });

    expect((screen.getByLabelText('Start date') as HTMLInputElement).value).toBe('2026-09-15');
    expect(screen.getByRole('cell', { name: 'Casey Stone' })).toBeTruthy();
  });

  test('a refused row change says Not saved in words', async () => {
    global.fetch = scriptedFetch({ patch: { status: 404, body: { error: 'Not found' } } });
    await renderPage();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Mark lapsed' }));
    });

    expect(screen.getByText('Not saved. That membership could not be found.')).toBeTruthy();
  });

  test('a row change whose answer is lost says what the list shows', async () => {
    global.fetch = scriptedFetch({
      patch: { status: 500 },
      list: [{ status: 200, body: { items: [MEMBERSHIP] } }, { status: 200, body: { items: [{ ...MEMBERSHIP, status: 'lapsed' }] } }],
    });
    await renderPage();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Mark lapsed' }));
    });
    expect(screen.getByText('Saved: the list now shows the change for Jordan Little.')).toBeTruthy();
    expect(screen.queryByText(/did not go through/)).toBeNull();

    cleanup();
    global.fetch = scriptedFetch({ patch: 'network' });
    await renderPage();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Mark lapsed' }));
    });
    expect(screen.getByText('Not saved: the list does not show the change for Jordan Little. Try again when ready.')).toBeTruthy();
  });

  test('a refused row change never wipes what an unsettled enrollment still has to say', async () => {
    global.fetch = scriptedFetch({
      post: { status: 502 },
      patch: { status: 404, body: { error: 'Not found' } },
      list: [{ status: 200, body: { items: [MEMBERSHIP] } }, { status: 500 }],
    });
    await renderPage();
    await fillAndSave();
    expect(screen.getByText('Not sure it was saved, and the list could not be read. Check before saving again.')).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Mark lapsed' }));
    });

    expect(screen.getByText('Not saved. That membership could not be found.')).toBeTruthy();
    expect(screen.getByText('Not sure it was saved, and the list could not be read. Check before saving again.')).toBeTruthy();
  });

  test('any list read that comes back settles an unsettled enrollment, so "could not be read" never goes stale', async () => {
    global.fetch = scriptedFetch({
      post: { status: 502 },
      list: [
        { status: 200, body: { items: [MEMBERSHIP] } },
        { status: 500 },
        { status: 200, body: { items: [{ ...MEMBERSHIP, status: 'lapsed' }, CASEY_ROW] } },
      ],
    });
    await renderPage();
    await fillAndSave();
    expect(screen.getByText(/Not sure it was saved/)).toBeTruthy();

    // A row change's refresh is a list read like any other.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Mark lapsed' }));
    });

    expect(screen.queryByText(/Not sure it was saved/)).toBeNull();
    expect(screen.getByText('The list now shows Casey Stone active in Youth Boxing. No need to save again.')).toBeTruthy();
  });

  test('a Check again that lands after a newer save neither repaints the list nor overwrites that save', async () => {
    const posts: Reply[] = [{ status: 502 }, { status: 200, body: { item: CASEY_ROW } }];
    const base = scriptedFetch({
      list: [
        { status: 200, body: { items: [MEMBERSHIP] } },
        { status: 500 },
        { status: 200, body: { items: [MEMBERSHIP] } },
        { status: 200, body: { items: [MEMBERSHIP, CASEY_ROW] } },
      ],
    });
    let reads = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/admin/memberships') && init?.method === 'POST') {
        const reply = posts.shift()!;
        return { ok: reply !== 'network' && reply.status === 200, status: reply === 'network' ? 0 : reply.status, json: async () => (reply === 'network' ? {} : reply.body ?? {}) } as Response;
      }
      // The third list read (the Check again) is held until after the second save.
      if (url.includes('/admin/memberships') && (init?.method ?? 'GET') === 'GET' && ++reads === 3) {
        const answer = base(input, init);
        await gate;
        return answer;
      }
      return base(input, init);
    }) as unknown as typeof fetch;
    await renderPage();
    await fillAndSave();
    expect(screen.getByText(/Not sure it was saved/)).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save membership' }));
    });
    expect(screen.getByRole('cell', { name: 'Casey Stone' })).toBeTruthy();

    await act(async () => {
      release();
    });

    expect(screen.getByRole('cell', { name: 'Casey Stone' })).toBeTruthy();
    expect(screen.queryByText(/Not saved: the list does not show/)).toBeNull();
    expect(screen.queryByText(/Not sure it was saved/)).toBeNull();
  });

  test('an overtaken list read does not clear a newer "didn\'t refresh"', async () => {
    const posts: Reply[] = [{ status: 502 }, { status: 200, body: { item: CASEY_ROW } }];
    const base = scriptedFetch({
      list: [
        { status: 200, body: { items: [MEMBERSHIP] } },
        { status: 500 },
        { status: 200, body: { items: [MEMBERSHIP] } },
        { status: 500 },
      ],
    });
    let reads = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/admin/memberships') && init?.method === 'POST') {
        const reply = posts.shift() as { status: number; body?: unknown };
        return { ok: reply.status === 200, status: reply.status, json: async () => reply.body ?? {} } as Response;
      }
      // The third list read (the Check again) is held until after the second save's refresh fails.
      if (url.includes('/admin/memberships') && (init?.method ?? 'GET') === 'GET' && ++reads === 3) {
        const answer = base(input, init);
        await gate;
        return answer;
      }
      return base(input, init);
    }) as unknown as typeof fetch;
    await renderPage();
    await fillAndSave();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save membership' }));
    });
    expect(screen.getByText("Saved: Casey Stone in Youth Boxing. The list didn't refresh.")).toBeTruthy();

    await act(async () => {
      release();
    });

    expect(screen.getByText("Saved: Casey Stone in Youth Boxing. The list didn't refresh.")).toBeTruthy();
  });

  test("a late answer for one row's change does not speak over a newer change", async () => {
    const OTHER = { ...MEMBERSHIP, membership_id: 'mem-3', athlete_id: 'ath-3', athlete_name: 'Riley Fox' };
    const base = scriptedFetch({ list: [{ status: 200, body: { items: [MEMBERSHIP, OTHER] } }] });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'PATCH' && String(init.body).includes('mem-1')) {
        // Jordan's change is held, then refused.
        await gate;
        return { ok: false, status: 404, json: async () => ({ error: 'Not found' }) } as Response;
      }
      return base(input, init);
    }) as unknown as typeof fetch;
    await renderPage();
    const [jordanLapse, rileyLapse] = screen.getAllByRole('button', { name: 'Mark lapsed' });
    await act(async () => {
      fireEvent.click(jordanLapse);
    });
    await act(async () => {
      fireEvent.click(rileyLapse);
    });
    await act(async () => {
      release();
    });

    expect(screen.queryByText('Not saved. That membership could not be found.')).toBeNull();
  });

  test('a row change answered 200 without the change is not taken as saved: the list decides', async () => {
    global.fetch = scriptedFetch({
      patch: { status: 200, body: { item: {} } },
      list: [{ status: 200, body: { items: [MEMBERSHIP] } }],
    });
    await renderPage();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Mark lapsed' }));
    });

    expect(screen.getByText('Not saved: the list does not show the change for Jordan Little. Try again when ready.')).toBeTruthy();
    expect(screen.queryByText("Saved. The list didn't refresh.")).toBeNull();
  });

  test('a memberships reply without a list is a failed read, not "No memberships on record"', async () => {
    global.fetch = scriptedFetch({ list: [{ status: 200, body: {} }] });
    await renderPage();

    expect(screen.getByText("Couldn't load memberships.")).toBeTruthy();
    expect(screen.queryByText('No memberships on record')).toBeNull();
  });

  test('the loading lines end in an ellipsis, not three dots', async () => {
    const { held, release } = holding(scriptedFetch({}), (url) => url.includes('/admin/memberships') || url.includes('/admin/programs'));
    global.fetch = held;
    await renderPage();

    expect(screen.getByText('Loading memberships…')).toBeTruthy();
    expect(screen.getByText('Loading programs…')).toBeTruthy();
    await act(async () => {
      release();
    });
  });
});

test('a failed roster read says so in the support picker, and Check again reads it again', async () => {
  let rosterReads = 0;
  global.fetch = jest.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/athletes/list')) {
      rosterReads += 1;
      return rosterReads === 1
        ? ({ ok: false, status: 500, json: async () => ({}) } as Response)
        : ({ ok: true, json: async () => ({ items: [{ athlete_id: 'ath-2', full_name: 'Casey Stone' }] }) } as Response);
    }
    if (url.includes('/admin/memberships')) return { ok: true, json: async () => ({ items: [MEMBERSHIP] }) } as Response;
    return { ok: true, json: async () => ({ items: [] }) } as Response;
  }) as unknown as typeof fetch;

  await act(async () => {
    render(<MembershipsPage />);
  });

  expect(await screen.findByText("Couldn't load the athlete list. Or open Support on a membership row.")).toBeTruthy();
  const picker = screen.getByLabelText('Support for') as HTMLSelectElement;
  expect(Array.from(picker.options).map((option) => option.textContent)).toEqual(['Choose an athlete']);

  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
  });

  expect(rosterReads).toBe(2);
  expect(screen.queryByText(/Couldn't load the athlete list/)).toBeNull();
  expect(Array.from((screen.getByLabelText('Support for') as HTMLSelectElement).options).map((option) => option.textContent))
    .toEqual(['Choose an athlete', 'Casey Stone']);
});

test("with the roster unread, a row's Support button still names its athlete in the picker", async () => {
  global.fetch = jest.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/athletes/list')) return { ok: false, status: 500, json: async () => ({}) } as Response;
    if (url.includes('/admin/memberships')) return { ok: true, json: async () => ({ items: [MEMBERSHIP] }) } as Response;
    return { ok: true, json: async () => ({ items: [] }) } as Response;
  }) as unknown as typeof fetch;

  await act(async () => {
    render(<MembershipsPage />);
  });
  await screen.findByText(/Couldn't load the athlete list/);
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Support provided to Jordan Little' }));
  });

  const picker = screen.getByLabelText('Support for') as HTMLSelectElement;
  expect(picker.value).toBe('ath-1');
  expect(picker.options[picker.selectedIndex].textContent).toBe('Jordan Little');
});

test('the support picker says it is loading until the roster read comes back', async () => {
  let answerRoster: (() => void) | null = null;
  global.fetch = jest.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/athletes/list')) {
      await new Promise<void>((resolve) => { answerRoster = resolve; });
      return { ok: true, json: async () => ({ items: [{ athlete_id: 'ath-2', full_name: 'Casey Stone' }] }) } as Response;
    }
    if (url.includes('/admin/memberships')) return { ok: true, json: async () => ({ items: [MEMBERSHIP] }) } as Response;
    return { ok: true, json: async () => ({ items: [] }) } as Response;
  }) as unknown as typeof fetch;

  await act(async () => {
    render(<MembershipsPage />);
  });

  const picker = screen.getByLabelText('Support for') as HTMLSelectElement;
  expect(picker.disabled).toBe(true);
  expect(picker.options[0].textContent).toBe('Loading athletes…');
  expect(screen.queryByText(/Couldn't load the athlete list/)).toBeNull();

  await act(async () => {
    answerRoster?.();
  });
  expect((screen.getByLabelText('Support for') as HTMLSelectElement).disabled).toBe(false);
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

// L41 x PH-12b: one athlete list feeds both pickers (Overwatch ruling A).
test('both athlete pickers share one read: Check again on the Support picker fills the Enroll picker too', async () => {
  let rosterReads = 0;
  global.fetch = jest.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/athletes/list')) {
      rosterReads += 1;
      return rosterReads === 1
        ? ({ ok: false, status: 500, json: async () => ({}) } as Response)
        : ({ ok: true, json: async () => ({ items: [{ athlete_id: 'ath-2', full_name: 'Casey Stone' }] }) } as Response);
    }
    if (url.includes('/admin/memberships')) return { ok: true, json: async () => ({ items: [MEMBERSHIP] }) } as Response;
    return { ok: true, json: async () => ({ items: [] }) } as Response;
  }) as unknown as typeof fetch;

  await act(async () => {
    render(<MembershipsPage />);
  });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Enroll athlete' }));
  });
  expect(screen.getAllByText(/Couldn't load the athlete list/)).toHaveLength(2);

  const supportField = screen.getByLabelText('Support for').closest('.field') as HTMLElement;
  await act(async () => {
    fireEvent.click(within(supportField).getByRole('button', { name: 'Check again' }));
  });

  expect(rosterReads).toBe(2);
  expect(screen.queryByText(/Couldn't load the athlete list/)).toBeNull();
  const enrollField = screen.getByLabelText('Athlete').closest('.field') as HTMLElement;
  expect(within(enrollField).getByRole('option', { name: 'Casey Stone' })).toBeTruthy();
});

test('an empty roster reads the same on the Support picker as on the Enroll picker', async () => {
  global.fetch = jest.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/athletes/list')) return { ok: true, json: async () => ({ items: [] }) } as Response;
    if (url.includes('/admin/memberships')) return { ok: true, json: async () => ({ items: [] }) } as Response;
    return { ok: true, json: async () => ({ items: [] }) } as Response;
  }) as unknown as typeof fetch;

  await act(async () => {
    render(<MembershipsPage />);
  });

  const supportField = screen.getByLabelText('Support for').closest('.field') as HTMLElement;
  expect(within(supportField).getByText("No athletes on this gym's roster yet.")).toBeTruthy();
});
