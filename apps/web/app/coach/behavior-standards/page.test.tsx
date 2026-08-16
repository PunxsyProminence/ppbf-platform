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
