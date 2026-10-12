/**
 * @jest-environment jsdom
 */

// Standards page. What these pin is the module's whole point: the two paths
// are visibly different, and the page tells a coach where a concern goes
// rather than leaving them to assume it lands in a file on the child.

import { act, fireEvent, render, screen } from '@testing-library/react';

import BehaviorStandardsPage from './page';

jest.mock('@/components/RoleSessionGate', () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

// The client role. Null (no session) unless a test sets it; 'admin' is how
// the client carries an organization admin.
let mockRole: string | null = null;
jest.mock('@/components/roleSession', () => ({
  getRoleSessionSnapshot: () => (mockRole ? { role: mockRole, expiresAt: Date.now() + 60_000 } : null),
}));

const STANDARDS = [
  { standard_id: 's1', standard_name: 'Reset after frustration', description: 'walk it off, come back',
    recognition_kind: 'took_the_correction', active: true },
  { standard_id: 's2', standard_name: 'Look after someone new', description: '',
    recognition_kind: 'looked_after_someone_new', active: true },
];

function mockFetch(capture?: { posts: unknown[] }) {
  return jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === 'POST') {
      capture?.posts.push(JSON.parse(String(init.body)));
      return { ok: true, json: async () => ({ item: { escalation_id: 'esc-1' } }) } as Response;
    }
    if (url.includes('/behavior-standards')) {
      return { ok: true, json: async () => ({ items: STANDARDS }) } as Response;
    }
    if (url.includes('/athletes/list')) {
      return { ok: true, json: async () => ({ items: [{ athlete_id: 'a1', full_name: 'Jordan P.' }] }) } as Response;
    }
    return { ok: true, json: async () => ({ items: [] }) } as Response;
  }) as unknown as typeof fetch;
}

afterEach(() => {
  jest.restoreAllMocks();
  mockRole = null;
});

test('the page says out loud where a concern goes, and that no behaviour log exists', async () => {
  global.fetch = mockFetch();

  await act(async () => {
    render(<BehaviorStandardsPage />);
  });

  expect(await screen.findByText(/safeguarding queue, not into a file on the athlete/i)).toBeTruthy();
  expect(screen.getByText(/there is no behaviour log here/i)).toBeTruthy();
});

test('posted standards show the recognition that evidences them', async () => {
  global.fetch = mockFetch();

  await act(async () => {
    render(<BehaviorStandardsPage />);
  });

  // Appears both in the posted list and in the recognise picker.
  expect((await screen.findAllByText('Reset after frustration')).length).toBeGreaterThan(0);
  // The underscored vocabulary is shown in human words.
  expect(screen.getByText('took the correction')).toBeTruthy();
  expect(screen.getByText('looked after someone new')).toBeTruthy();
});

test('a concern posts to the safeguarding path with the severity the coach stated', async () => {
  const capture = { posts: [] as unknown[] };
  global.fetch = mockFetch(capture);

  await act(async () => {
    render(<BehaviorStandardsPage />);
  });
  await act(async () => {
    fireEvent.change(await screen.findByLabelText('Athlete', { selector: '#con-athlete' }), { target: { value: 'a1' } });
  });
  await act(async () => {
    fireEvent.change(screen.getByLabelText('How serious (your judgement)'), { target: { value: 'high' } });
  });
  await act(async () => {
    fireEvent.change(screen.getByLabelText('What happened'), { target: { value: 'ignored a stop instruction' } });
  });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Send to safeguarding' }));
  });

  expect(capture.posts).toHaveLength(1);
  expect(capture.posts[0]).toMatchObject({
    action: 'raise_concern', athlete_id: 'a1', severity: 'high', reason: 'ignored a stop instruction',
  });
});

test('a concern with no reason is refused before it reaches the server', async () => {
  const capture = { posts: [] as unknown[] };
  global.fetch = mockFetch(capture);

  await act(async () => {
    render(<BehaviorStandardsPage />);
  });
  await act(async () => {
    fireEvent.change(await screen.findByLabelText('Athlete', { selector: '#con-athlete' }), { target: { value: 'a1' } });
  });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Send to safeguarding' }));
  });

  expect(capture.posts).toHaveLength(0);
  expect(screen.getByText(/needs an athlete and a reason in your own words/i)).toBeTruthy();
});

test('a failed standards read says so and never claims no standards are posted', async () => {
  global.fetch = jest.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/behavior-standards')) {
      return { ok: false, status: 500, json: async () => ({}) } as Response;
    }
    return { ok: true, json: async () => ({ items: [] }) } as Response;
  }) as unknown as typeof fetch;

  await act(async () => {
    render(<BehaviorStandardsPage />);
  });

  expect(await screen.findByTestId('standards-unreadable')).toBeTruthy();
  expect(screen.queryByText(/No standards posted yet/i)).toBeNull();
});

test('an athlete list that fails does not mark standards that loaded as unreadable', async () => {
  const base = mockFetch();
  global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes('/athletes/list')) throw new TypeError('Failed to fetch');
    return base(input, init);
  }) as unknown as typeof fetch;

  await act(async () => {
    render(<BehaviorStandardsPage />);
  });

  expect((await screen.findAllByText('Reset after frustration')).length).toBeGreaterThan(0);
  expect(screen.queryByTestId('standards-unreadable')).toBeNull();
});

// Issue #1445 (OD-2026-10-07-010): the organization admin posts the gym's
// standards through the existing post_standard write. A coach sees no form.

test('an organization admin posts a standard once, however fast the button is pressed, and the list is re-read', async () => {
  mockRole = 'admin';
  const posts: unknown[] = [];
  let reads = 0;
  let finishPost: (() => void) | null = null;
  global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === 'POST') {
      posts.push(JSON.parse(String(init.body)));
      await new Promise<void>((resolve) => { finishPost = resolve; });
      return { ok: true, json: async () => ({ item: { standard_id: 's3' } }) } as Response;
    }
    if (url.includes('/behavior-standards')) {
      reads += 1;
      return { ok: true, json: async () => ({ items: STANDARDS }) } as Response;
    }
    return { ok: true, json: async () => ({ items: [] }) } as Response;
  }) as unknown as typeof fetch;

  await act(async () => {
    render(<BehaviorStandardsPage />);
  });
  fireEvent.change(await screen.findByLabelText('Standard name'), { target: { value: '  Shake hands after sparring ' } });
  fireEvent.change(screen.getByLabelText('Recognition that evidences it'), { target: { value: 'good_partner' } });
  fireEvent.change(screen.getByLabelText('Description (optional)'), { target: { value: 'every round' } });

  const button = screen.getByRole('button', { name: 'Post standard' });
  await act(async () => {
    fireEvent.click(button);
    fireEvent.click(button);
  });
  expect(posts).toEqual([{
    action: 'post_standard',
    standard_name: 'Shake hands after sparring',
    recognition_kind: 'good_partner',
    description: 'every round',
  }]);
  const readsBefore = reads;
  await act(async () => {
    finishPost?.();
  });

  expect(await screen.findByText('Standard posted.')).toBeTruthy();
  expect(reads).toBe(readsBefore + 1);
  expect((screen.getByLabelText('Standard name') as HTMLInputElement).value).toBe('');
});

test('a coach sees no posting form and no retire control', async () => {
  mockRole = 'coach';
  global.fetch = mockFetch();

  await act(async () => {
    render(<BehaviorStandardsPage />);
  });

  expect((await screen.findAllByText('Reset after frustration')).length).toBeGreaterThan(0);
  expect(screen.queryByText('Post a standard')).toBeNull();
  expect(screen.queryByRole('button', { name: /^Retire/ })).toBeNull();
  // The coach's own two paths are unchanged.
  expect(screen.getByRole('button', { name: 'Record recognition' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Send to safeguarding' })).toBeTruthy();
});

test('with no standards posted yet, the organization admin still gets the form', async () => {
  mockRole = 'admin';
  global.fetch = jest.fn(async () => ({ ok: true, json: async () => ({ items: [] }) }) as Response) as unknown as typeof fetch;

  await act(async () => {
    render(<BehaviorStandardsPage />);
  });

  expect(await screen.findByText(/No standards posted yet/i)).toBeTruthy();
  expect(screen.getByText('Post a standard')).toBeTruthy();
});

test('a post without a name or a recognition sends nothing and says what is missing', async () => {
  mockRole = 'admin';
  const capture = { posts: [] as unknown[] };
  global.fetch = mockFetch(capture);

  await act(async () => {
    render(<BehaviorStandardsPage />);
  });
  fireEvent.change(await screen.findByLabelText('Standard name'), { target: { value: 'Shake hands' } });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Post standard' }));
  });

  expect(capture.posts).toHaveLength(0);
  expect(screen.getByText(/needs a name and the recognition that evidences it/i)).toBeTruthy();
});

test('a post the server refuses shows the server reason and keeps what was typed', async () => {
  mockRole = 'admin';
  global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'POST') {
      return { ok: false, status: 403, json: async () => ({ error: 'Forbidden: role not allowed' }) } as Response;
    }
    if (String(input).includes('/behavior-standards')) {
      return { ok: true, json: async () => ({ items: STANDARDS }) } as Response;
    }
    return { ok: true, json: async () => ({ items: [] }) } as Response;
  }) as unknown as typeof fetch;

  await act(async () => {
    render(<BehaviorStandardsPage />);
  });
  fireEvent.change(await screen.findByLabelText('Standard name'), { target: { value: 'Shake hands' } });
  fireEvent.change(screen.getByLabelText('Recognition that evidences it'), { target: { value: 'good_partner' } });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Post standard' }));
  });

  expect(screen.getByText('Forbidden: role not allowed')).toBeTruthy();
  expect(screen.queryByText('Standard posted.')).toBeNull();
  expect((screen.getByLabelText('Standard name') as HTMLInputElement).value).toBe('Shake hands');
});

test('the organization admin retires a standard through retire_standard', async () => {
  mockRole = 'admin';
  const capture = { posts: [] as unknown[] };
  global.fetch = mockFetch(capture);

  await act(async () => {
    render(<BehaviorStandardsPage />);
  });
  fireEvent.change(await screen.findByLabelText('Standard', { selector: '#rec-standard' }), { target: { value: 's1' } });
  await act(async () => {
    fireEvent.click(await screen.findByRole('button', { name: 'Retire Reset after frustration' }));
  });

  expect((screen.getByLabelText('Standard', { selector: '#rec-standard' }) as HTMLSelectElement).value).toBe('');
  expect(capture.posts).toEqual([{ action: 'retire_standard', standard_id: 's1' }]);
  expect(await screen.findByText(/Standard retired/)).toBeTruthy();
});
