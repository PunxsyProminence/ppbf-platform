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

  test('a row change never wipes what an unsettled enrollment still has to say', async () => {
    global.fetch = scriptedFetch({
      post: { status: 502 },
      list: [{ status: 200, body: { items: [MEMBERSHIP] } }, { status: 500 }, { status: 200, body: { items: [MEMBERSHIP] } }],
    });
    await renderPage();
    await fillAndSave();
    expect(screen.getByText('Not sure it was saved, and the list could not be read. Check before saving again.')).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Mark lapsed' }));
    });

    expect(screen.getByText('Not sure it was saved, and the list could not be read. Check before saving again.')).toBeTruthy();
  });

  test('Save waits while a Check again is reading the list', async () => {
    const base = scriptedFetch({
      post: { status: 502 },
      list: [{ status: 200, body: { items: [MEMBERSHIP] } }, { status: 500 }, { status: 200, body: { items: [MEMBERSHIP] } }],
    });
    let reads = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // The third list read (the Check again) is held open.
    global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes('/admin/memberships') && !init?.method?.match(/POST|PATCH/) && ++reads === 3) await gate;
      return base(input, init);
    }) as unknown as typeof fetch;
    await renderPage();
    await fillAndSave();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    });

    expect((screen.getByRole('button', { name: 'Save membership' }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => {
      release();
    });
    expect((screen.getByRole('button', { name: 'Save membership' }) as HTMLButtonElement).disabled).toBe(false);
  });
});
