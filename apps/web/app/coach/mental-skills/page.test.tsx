/**
 * @jest-environment jsdom
 */

/*
 * The coach's mental skills page. The stale-answer guard and the failure
 * states are covered in the guardian page's test (same panel); this file
 * covers what differs: the staff sources, the goals read through the coach
 * block routes, that the page never writes, and the coach's own picking --
 * a select that opens on nobody and tells two same-named athletes apart. The
 * guardian page moved to the family picker (lane AS-9, AS9-2), so that
 * picking is proved here now.
 */

import { act, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';

import CoachMentalSkillsPage from './page';

const mockShellProps: Array<{ allowedRoles?: string[] }> = [];
jest.mock('@/components/RoleStandaloneView', () => ({
  __esModule: true,
  default: ({ children, allowedRoles }: { readonly children: ReactNode; readonly allowedRoles?: string[] }) => {
    mockShellProps.push({ allowedRoles });
    return <div>{children}</div>;
  },
}));

const ONE_ATHLETE = [{ athlete_id: 'ath-1', full_name: 'Casey' }];

function installFetch(roster: Array<{ athlete_id: string; full_name?: string }> = ONE_ATHLETE): jest.Mock {
  const fetchMock = jest.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as Response;
    if (url.includes('/api/pilot/coach/athletes')) {
      return json({ items: roster });
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

afterEach(() => {
  jest.restoreAllMocks();
  window.sessionStorage.clear();
  window.localStorage.clear();
});

test('reads the chosen athlete through the staff routes, goals from active blocks only, and never writes', async () => {
  const fetchMock = installFetch();
  await act(async () => {
    render(<CoachMentalSkillsPage />);
  });
  // 'admin' is how the shell admits organization_admin (buildingMap.ts role collapse).
  expect(mockShellProps.at(-1)?.allowedRoles).toEqual(['coach', 'admin']);
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

describe('the coach keeps the select (the family picker is the guardian page\'s only)', () => {
  test('two athletes with the same name are told apart, and one with no name is still listed', async () => {
    installFetch([
      { athlete_id: 'ath-twin-1111', full_name: 'Sam' },
      { athlete_id: 'ath-twin-2222', full_name: 'Sam' },
      { athlete_id: 'ath-3333' },
    ]);
    await act(async () => {
      render(<CoachMentalSkillsPage />);
    });
    const select = screen.getByLabelText('Which athlete') as HTMLSelectElement;
    expect(select.tagName).toBe('SELECT');
    expect(Array.from(select.options).map((option) => option.textContent)).toEqual([
      'Choose',
      'Sam (1111)',
      'Sam (2222)',
      'ath-3333',
    ]);
    expect(screen.queryByRole('group', { name: 'Which athlete' })).toBeNull();
  });

  test('nobody is picked at open, even with one athlete and a family page\'s remembered child', async () => {
    // The guardian pages' remembered child (src/lib/chosenChild.ts) is not the
    // coach's: a coach on a shared tablet must not open on it.
    window.sessionStorage.setItem('ppbf.parent.chosenChild', 'ath-1');
    const fetchMock = installFetch();
    await act(async () => {
      render(<CoachMentalSkillsPage />);
    });
    await act(async () => {});
    expect((screen.getByLabelText('Which athlete') as HTMLSelectElement).value).toBe('');
    expect(fetchMock.mock.calls.map(([input]) => String(input)).filter((u) => u.includes('athlete_id='))).toEqual([]);
    expect(screen.queryByText('hands home')).toBeNull();
  });
});
