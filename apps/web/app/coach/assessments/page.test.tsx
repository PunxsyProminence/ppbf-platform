/**
 * @jest-environment jsdom
 */

/*
 * The coach screen for jump tests and skill ratings. What is pinned here:
 * the page shows ONE athlete's own history, adds nothing up (no total, no
 * average, no rank), sends only the families the coach actually rated, and
 * says so when a save fails instead of pretending it worked.
 */

import { act, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';

import CoachAssessmentsPage from './page';

jest.mock('@/components/RoleStandaloneView', () => ({
  __esModule: true,
  default: ({ children }: { readonly children: ReactNode }) => <div>{children}</div>,
}));

const PAYLOAD = {
  ok: true,
  jump_protocols: [
    { protocol_id: 'ppbf-jump-cmj-height', name: 'Countermovement jump height', summary: 'Jump up.', equipment: 'Jump app' },
    { protocol_id: 'ppbf-jump-broad-distance', name: 'Standing broad jump distance', summary: 'Jump forward.', equipment: 'Tape' },
  ],
  skill_families: [
    { skill_family_id: 'SKILL-01', name: 'Stance / Guard / Reset' },
    { skill_family_id: 'SKILL-02', name: 'Jab System' },
  ],
  rating_levels: [
    { level: 1, label: 'Learning', description: 'a' },
    { level: 2, label: 'Developing', description: 'b' },
    { level: 3, label: 'Solid', description: 'c' },
    { level: 4, label: 'Applies', description: 'd' },
    { level: 5, label: 'Sharp', description: 'e' },
  ],
  history: [
    { assessment_id: 'h1', protocol_id: 'ppbf-jump-cmj-height', kind: 'jump', administered_on: '2026-10-01', value: 41.5, skill_family_id: null, note: '' },
    { assessment_id: 'h2', protocol_id: 'ppbf-skill-rating-skill-01', kind: 'skill_rating', administered_on: '2026-10-02', value: 3, skill_family_id: 'SKILL-01', note: '' },
    { assessment_id: 'h3', protocol_id: 'ppbf-skill-rating-skill-02', kind: 'skill_rating', administered_on: '2026-10-02', value: 4, skill_family_id: 'SKILL-02', note: '' },
  ],
};

let postResponse: { status: number; body: unknown } = { status: 201, body: { ok: true } };
let fetchMock: jest.Mock;

beforeEach(() => {
  postResponse = { status: 201, body: { ok: true } };
  fetchMock = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const respond = (status: number, body: unknown) =>
      ({ ok: status < 400, status, json: async () => body }) as Response;
    if (url.endsWith('/api/pilot/coach/athletes')) {
      return respond(200, { items: [{ athlete_id: 'ath-1', full_name: 'Ana Boxer' }] });
    }
    if (url.includes('/api/pilot/coach/assessments') && init?.method === 'POST') {
      return respond(postResponse.status, postResponse.body);
    }
    if (url.includes('/api/pilot/coach/assessments?athlete_id=ath-1')) {
      return respond(200, PAYLOAD);
    }
    return respond(404, {});
  });
  global.fetch = fetchMock as unknown as typeof fetch;
});

async function chooseAthlete() {
  render(<CoachAssessmentsPage />);
  await act(async () => {});
  await act(async () => {
    fireEvent.change(screen.getByLabelText('Which athlete'), { target: { value: 'ath-1' } });
  });
}

test('shows the one athlete\'s dated history with no total, average or rank', async () => {
  await chooseAthlete();
  const history = screen.getByRole('heading', { name: 'History for Ana Boxer' }).closest('section')!;
  const text = history.textContent ?? '';
  expect(text).toContain('41.5 cm');
  expect(text).toContain('3 Solid');
  expect(text).toContain('4 Applies');
  expect(text).not.toMatch(/total|average|rank|score|percentile/i);
  // 3 + 4 would be 7; it must not appear as a combined figure.
  expect(text).not.toMatch(/\b7\b/);
});

test('sends only the families the coach rated', async () => {
  await chooseAthlete();
  await act(async () => {
    fireEvent.change(screen.getByLabelText('Jab System'), { target: { value: '2' } });
  });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Save ratings' }));
  });
  const post = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST');
  expect(JSON.parse(post![1].body)).toEqual({
    athlete_id: 'ath-1',
    kind: 'skill_ratings',
    ratings: [{ skill_family_id: 'SKILL-02', level: 2 }],
    note: '',
  });
  expect(screen.getByRole('status').textContent).toBe('1 rating saved.');
});

test('a refused save is shown as not saved', async () => {
  postResponse = { status: 400, body: { error: 'The test date cannot be in the future.' } };
  await chooseAthlete();
  await act(async () => {
    fireEvent.change(screen.getByLabelText('Best of 3 (cm)'), { target: { value: '40' } });
  });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Save jump' }));
  });
  const post = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST');
  expect(JSON.parse(post![1].body)).toMatchObject({ kind: 'jump', protocol_id: 'ppbf-jump-cmj-height', value_cm: 40 });
  expect(screen.getByRole('alert').textContent).toBe('The test date cannot be in the future.');
});
