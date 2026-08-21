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
