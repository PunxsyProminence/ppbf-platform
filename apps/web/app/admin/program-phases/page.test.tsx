/**
 * @jest-environment jsdom
 */

// Program phases page. What these pin: the current phase and closed
// history render distinctly (past phases keep their dates rather than
// disappearing), starting a phase posts the declared facts, and an
// incomplete declaration never leaves the page.

import { act, fireEvent, render, screen } from '@testing-library/react';

import ProgramPhasesPage from './page';

jest.mock('@/components/RoleSessionGate', () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

const PHASES = [
  {
    phase_id: 'ph-2', program_name: 'Youth Boxing', phase_name: 'Competition prep',
    focus: 'live rounds', started_on: '2026-03-01', ended_on: null, notes: '',
  },
  {
    phase_id: 'ph-1', program_name: 'Youth Boxing', phase_name: 'Foundation',
    focus: '', started_on: '2026-01-01', ended_on: '2026-02-28', notes: '',
  },
];

function mockFetch(capture: { posts: unknown[] }) {
  return jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'POST' || init?.method === 'PATCH') {
      capture.posts.push(JSON.parse(String(init.body)));
      return { ok: true, json: async () => ({ item: {} }) } as Response;
    }
    return { ok: true, json: async () => ({ items: PHASES }) } as Response;
  }) as unknown as typeof fetch;
}

afterEach(() => {
  jest.restoreAllMocks();
});

test('the current phase and closed history both render, history keeping its dates', async () => {
  global.fetch = mockFetch({ posts: [] });

  await act(async () => {
    render(<ProgramPhasesPage />);
  });

  expect(await screen.findByText('current')).toBeTruthy();
  expect(screen.getByText('closed')).toBeTruthy();
  expect(screen.getByText(/Youth Boxing — Competition prep/)).toBeTruthy();
  expect(screen.getByText(/2026-01-01 → 2026-02-28/)).toBeTruthy();
  expect(screen.getByText(/2026-03-01 → open/)).toBeTruthy();
});

test('starting a phase posts the declared facts; an incomplete declaration never leaves the page', async () => {
  const capture = { posts: [] as unknown[] };
  global.fetch = mockFetch(capture);

  await act(async () => {
    render(<ProgramPhasesPage />);
  });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Start phase' }));
  });
  expect(capture.posts).toHaveLength(0);
  expect(screen.getByText(/needs a program, a name, and a start date/)).toBeTruthy();

  await act(async () => {
    fireEvent.change(screen.getByLabelText('Program'), { target: { value: 'Youth Boxing' } });
    fireEvent.change(screen.getByLabelText('Phase name'), { target: { value: 'Off season' } });
    fireEvent.change(screen.getByLabelText('Starts on'), { target: { value: '2026-06-01' } });
  });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Start phase' }));
  });

  expect(capture.posts).toHaveLength(1);
  expect(capture.posts[0]).toMatchObject({
    program_name: 'Youth Boxing', phase_name: 'Off season', started_on: '2026-06-01',
  });
});
