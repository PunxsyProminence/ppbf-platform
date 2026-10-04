/**
 * @jest-environment jsdom
 */

/*
 * The coach's mental skills page. The picking, the stale-answer guard and the
 * failure states are covered in the guardian page's test (same panel); this
 * file covers what differs: the staff sources, the goals read through the
 * coach block routes, and that the page never writes.
 */

import { act, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';

import CoachMentalSkillsPage from './page';

jest.mock('@/components/RoleStandaloneView', () => ({
  __esModule: true,
  default: ({ children }: { readonly children: ReactNode }) => <div>{children}</div>,
}));

function installFetch(): jest.Mock {
  const fetchMock = jest.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as Response;
    if (url.includes('/api/pilot/coach/athletes')) {
      return json({ items: [{ athlete_id: 'ath-1', full_name: 'Casey' }] });
    }
    if (url.includes('/api/pilot/coach/mental-skills?athlete_id=ath-1')) {
      return json({
        current_cue: { entry_id: 'c', cue_text: 'hands home', cue_kind: 'instructional', logged_on: '2026-10-03' },
        imagery_sessions: [],
      });
    }
    if (url.includes('/api/pilot/coach/development-blocks?athlete_id=ath-1')) {
      return json({ blocks: [{ block_id: 'b-live', status: 'active' }, { block_id: 'b-old', status: 'completed' }] });
    }
    if (url.includes('/api/pilot/coach/development-block-objectives?block_id=b-live')) {
      return json({
        objectives: [
          { objective_id: 'o1', domain: 'mental', objective: 'Reset breathing between rounds.', status: 'active' },
          { objective_id: 'o2', domain: 'technical', objective: 'Jab off the back foot.', status: 'active' },
        ],
      });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

afterEach(() => jest.restoreAllMocks());

test('reads the chosen athlete through the staff routes, goals from active blocks only, and never writes', async () => {
  const fetchMock = installFetch();
  await act(async () => {
    render(<CoachMentalSkillsPage />);
  });
  expect(screen.getByText('What the athlete saved, in their words. Their guardian sees the same. Read-only.')).toBeTruthy();
  await act(async () => {
    fireEvent.change(screen.getByLabelText('Which athlete'), { target: { value: 'ath-1' } });
  });
  expect(screen.getByText('hands home')).toBeTruthy();
  expect(screen.getByText(/Technique \(instructional\)/)).toBeTruthy();
  expect(screen.getByText('Reset breathing between rounds.')).toBeTruthy();
  expect(screen.queryByText('Jab off the back foot.')).toBeNull();

  const urls = fetchMock.mock.calls.map(([input]) => String(input));
  expect(urls.some((u) => u.includes('block_id=b-old'))).toBe(false);
  expect(urls.some((u) => u.includes('/api/pilot/athlete/'))).toBe(false);
  for (const [, init] of fetchMock.mock.calls) {
    expect((init as RequestInit | undefined)?.method ?? 'GET').toBe('GET');
  }
  expect(screen.queryByRole('button')).toBeNull();
});
