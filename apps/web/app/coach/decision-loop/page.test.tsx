/**
 * @jest-environment jsdom
 */

import type { ReactNode } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import DecisionLoopReviewPage from './page';

jest.mock('@/components/RoleStandaloneView', () => ({
  __esModule: true,
  default: ({ children }: { readonly children: ReactNode }) => <div>{children}</div>,
}));

function jsonResponse(body: unknown, ok = true) {
  return { ok, json: async () => body } as Response;
}

function installFetch(overrides: Record<string, unknown> = {}) {
  const fetchMock = jest.fn(async (url: string, init?: RequestInit) => {
    const key = String(url);
    if (key.includes('/api/pilot/athletes/list')) {
      return jsonResponse({ items: [{ athlete_id: 'ath-1', full_name: 'Jordan T.' }] });
    }
    if (key.includes('/api/pilot/shadow/medical-status')) {
      return jsonResponse({ status: null });
    }
    if (key.includes('/api/pilot/shadow/recommendations')) {
      return jsonResponse({ recommendations: [] });
    }
    if (key.includes('/api/pilot/shadow/decisions')) {
      return jsonResponse({ decisions: [] });
    }
    if (key.includes('/api/pilot/shadow/near-misses')) {
      return jsonResponse({ nearMisses: [] });
    }
    if (key.includes('/api/pilot/intake/domain-upsert')) {
      const handler = overrides.domainUpsert as ((init?: RequestInit) => Response) | undefined;
      return handler ? handler(init) : jsonResponse({ ok: true, entity_type: 'coach_note', entity_id: 'obs-1', athlete_id: 'ath-1' });
    }
    throw new Error(`Unexpected fetch: ${key}`);
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

async function selectAthlete() {
  render(<DecisionLoopReviewPage />);
  const input = await screen.findByPlaceholderText('athlete-id');
  fireEvent.change(input, { target: { value: 'ath-1' } });
  await screen.findByText('Behavior & Habit Note');
}

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  jest.clearAllMocks();
});

test('logging a behavior note posts entity_type coach_note with a generic note_type, no invented taxonomy', async () => {
  const fetchMock = installFetch();
  await selectAthlete();

  fireEvent.change(screen.getByLabelText('Note'), { target: { value: 'Showed real effort helping a younger athlete warm up.' } });
  fireEvent.click(screen.getByRole('button', { name: 'Log Note' }));

  await waitFor(() => {
    const call = fetchMock.mock.calls.find((c) => String(c[0]).includes('/api/pilot/intake/domain-upsert'));
    expect(call).toBeDefined();
  });

  const call = fetchMock.mock.calls.find((c) => String(c[0]).includes('/api/pilot/intake/domain-upsert'));
  const body = JSON.parse(String((call?.[1] as RequestInit).body));
  expect(body).toEqual({
    entity_type: 'coach_note',
    athlete_id: 'ath-1',
    payload: { note_type: 'behavior_standard', note_text: 'Showed real effort helping a younger athlete warm up.' },
  });

  await screen.findByText('Note logged.');
});

test('the textarea clears after a successful log', async () => {
  installFetch();
  await selectAthlete();

  const textarea = screen.getByLabelText('Note') as HTMLTextAreaElement;
  fireEvent.change(textarea, { target: { value: 'A note.' } });
  fireEvent.click(screen.getByRole('button', { name: 'Log Note' }));

  await waitFor(() => expect(textarea.value).toBe(''));
});

test('an empty note does not submit', async () => {
  const fetchMock = installFetch();
  await selectAthlete();

  fireEvent.click(screen.getByRole('button', { name: 'Log Note' }));

  expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('/api/pilot/intake/domain-upsert'))).toBe(false);
});

test('a failed log shows the error, not a false success message', async () => {
  installFetch({ domainUpsert: () => jsonResponse({ error: 'Forbidden' }, false) });
  await selectAthlete();

  fireEvent.change(screen.getByLabelText('Note'), { target: { value: 'A note.' } });
  fireEvent.click(screen.getByRole('button', { name: 'Log Note' }));

  await screen.findByText('Forbidden');
  expect(screen.queryByText('Note logged.')).toBeNull();
});
