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

// Shaped like DataCollectionRequestRow (src/server/pilot/assessmentProtocols.ts),
// trimmed to the fields the page reads, in the server's order.
const QUEUE = [
  { request_id: 'r1', athlete_id: 'ath-1', request_kind: 'physical_test', prompt_text: 'Retest broad jump', capture_hint: 'Tape at the line', due_on: '2026-10-20', priority: 'high' },
  { request_id: 'r2', athlete_id: 'ath-1', request_kind: 'video', prompt_text: 'Film the jab', capture_hint: '', due_on: '2026-10-01', priority: 'high' },
  { request_id: 'r3', athlete_id: 'ath-1', request_kind: 'skill_rubric', prompt_text: 'Rate guard again', capture_hint: '', due_on: null, priority: 'normal' },
  { request_id: 'r4', athlete_id: 'ath-1', request_kind: 'physical_test', prompt_text: 'Retest CMJ', capture_hint: '', due_on: '2026-10-05', priority: 'low' },
];
let queueResponse: { status: number; body: unknown } = { status: 200, body: { requests: QUEUE } };
let holdQueueAna: Promise<void> | null = null;

let postResponse: { status: number; body: unknown } = { status: 201, body: { ok: true } };
let fetchMock: jest.Mock;
let holdAna: Promise<void> | null = null;
let holdPost: Promise<void> | null = null;

beforeEach(() => {
  holdAna = null;
  holdPost = null;
  postResponse = { status: 201, body: { ok: true } };
  queueResponse = { status: 200, body: { requests: QUEUE } };
  holdQueueAna = null;
  fetchMock = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const respond = (status: number, body: unknown) =>
      ({ ok: status < 400, status, json: async () => body }) as Response;
    if (url.endsWith('/api/pilot/coach/athletes')) {
      return respond(200, { items: [
        { athlete_id: 'ath-1', full_name: 'Ana Boxer' },
        { athlete_id: 'ath-2', full_name: 'Ben Boxer' },
      ] });
    }
    if (url.includes('/api/pilot/data-collection-requests?athlete_id=ath-1')) {
      if (holdQueueAna) await holdQueueAna;
      return respond(queueResponse.status, queueResponse.body);
    }
    if (url.includes('/api/pilot/data-collection-requests?athlete_id=ath-2')) {
      return respond(200, { requests: [] });
    }
    if (url.includes('/api/pilot/coach/assessments') && init?.method === 'POST') {
      if (holdPost) await holdPost;
      return respond(postResponse.status, postResponse.body);
    }
    if (url.includes('/api/pilot/coach/assessments?athlete_id=ath-1')) {
      if (holdAna) await holdAna;
      return respond(200, PAYLOAD);
    }
    if (url.includes('/api/pilot/coach/assessments?athlete_id=ath-2')) {
      return respond(200, { ...PAYLOAD, history: [] });
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

test('a draft typed for one athlete is cleared when the coach switches athlete', async () => {
  await chooseAthlete();
  await act(async () => {
    fireEvent.change(screen.getByLabelText('Best of 3 (cm)'), { target: { value: '62' } });
    fireEvent.change(screen.getByLabelText('Jab System'), { target: { value: '5' } });
  });
  await act(async () => {
    fireEvent.change(screen.getByLabelText('Which athlete'), { target: { value: 'ath-2' } });
  });
  expect((screen.getByLabelText('Best of 3 (cm)') as HTMLInputElement).value).toBe('');
  expect((screen.getByLabelText('Jab System') as HTMLSelectElement).value).toBe('');
});

test('a slow load for the previous athlete never renders under the new one', async () => {
  let release!: () => void;
  holdAna = new Promise<void>((resolve) => { release = resolve; });
  render(<CoachAssessmentsPage />);
  await act(async () => {});
  await act(async () => {
    fireEvent.change(screen.getByLabelText('Which athlete'), { target: { value: 'ath-1' } });
  });
  await act(async () => {
    fireEvent.change(screen.getByLabelText('Which athlete'), { target: { value: 'ath-2' } });
  });
  await act(async () => { release(); });
  const history = screen.getByRole('heading', { name: 'History for Ben Boxer' }).closest('section')!;
  expect(history.textContent).toContain('Nothing recorded yet.');
  expect(document.body.textContent).not.toContain('41.5 cm');
});

test('a save that finishes after switching athlete leaves the new athlete untouched', async () => {
  let release!: () => void;
  holdPost = new Promise<void>((resolve) => { release = resolve; });
  await chooseAthlete();
  await act(async () => {
    fireEvent.change(screen.getByLabelText('Best of 3 (cm)'), { target: { value: '40' } });
  });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Save jump' }));
  });
  await act(async () => {
    fireEvent.change(screen.getByLabelText('Which athlete'), { target: { value: 'ath-2' } });
  });
  await act(async () => {
    fireEvent.change(screen.getByLabelText('Best of 3 (cm)'), { target: { value: '55' } });
  });
  await act(async () => { release(); });
  expect((screen.getByLabelText('Best of 3 (cm)') as HTMLInputElement).value).toBe('55');
  expect(screen.queryByRole('status')).toBeNull();
  const post = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST');
  expect(JSON.parse(post![1].body).athlete_id).toBe('ath-1');
});

test('a truncated history says so', async () => {
  const original = fetchMock.getMockImplementation()!;
  fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes('assessments?athlete_id=ath-1')) {
      return { ok: true, status: 200, json: async () => ({ ...PAYLOAD, history_truncated: true }) } as Response;
    }
    return original(input, init);
  });
  await chooseAthlete();
  expect(document.body.textContent).toContain('Older entries exist and are not shown here.');
});

function queueSection(name: string) {
  return screen.getByRole('heading', { name: `Open test and rating requests for ${name}` }).closest('section')!;
}

test('the retest queue asks for the chosen athlete only and keeps tests and ratings in the server\'s order', async () => {
  await chooseAthlete();
  const queueCalls = fetchMock.mock.calls.filter(([url]) => String(url).includes('/api/pilot/data-collection-requests'));
  expect(queueCalls.map(([url]) => String(url))).toEqual([
    expect.stringMatching(/\/api\/pilot\/data-collection-requests\?athlete_id=ath-1$/),
  ]);
  const items = Array.from(queueSection('Ana Boxer').querySelectorAll('li')).map((li) => li.textContent ?? '');
  expect(items).toHaveLength(3);
  expect(items[0]).toContain('Retest broad jump');
  expect(items[0]).toContain('Due October 20, 2026');
  expect(items[0]).toContain('priority high');
  expect(items[0]).toContain('Tape at the line');
  expect(items[1]).toContain('Rate guard again');
  expect(items[1]).toContain('No due date');
  expect(items[2]).toContain('Retest CMJ');
  // A video request is not a test or a rating; nothing is called overdue.
  expect(queueSection('Ana Boxer').textContent).not.toContain('Film the jab');
  expect(queueSection('Ana Boxer').textContent).not.toMatch(/overdue|late/i);
});

test('no request is fetched before an athlete is chosen', async () => {
  render(<CoachAssessmentsPage />);
  await act(async () => {});
  expect(fetchMock.mock.calls.some(([url]) => String(url).includes('data-collection-requests'))).toBe(false);
  expect(screen.queryByRole('heading', { name: /Open test and rating requests/ })).toBeNull();
});

test('a request about another athlete is never listed under this one', async () => {
  queueResponse = { status: 200, body: { requests: [{ ...QUEUE[0], request_id: 'rx', athlete_id: 'ath-9', prompt_text: 'Someone else' }] } };
  await chooseAthlete();
  expect(queueSection('Ana Boxer').textContent).not.toContain('Someone else');
  expect(queueSection('Ana Boxer').textContent).toContain('No open test or rating requests for this athlete.');
});

test('an empty queue says so', async () => {
  queueResponse = { status: 200, body: { requests: [] } };
  await chooseAthlete();
  expect(queueSection('Ana Boxer').textContent).toContain('No open test or rating requests for this athlete.');
});

test('a queue that fails to load is not shown as empty, and a refusal shows nothing from it', async () => {
  for (const status of [403, 500]) {
    queueResponse = { status, body: { requests: QUEUE } };
    const view = render(<CoachAssessmentsPage />);
    await act(async () => {});
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Which athlete'), { target: { value: 'ath-1' } });
    });
    const section = queueSection('Ana Boxer');
    expect(section.textContent).toContain('The open requests could not be loaded.');
    expect(section.textContent).not.toContain('No open test or rating requests');
    expect(section.textContent).not.toContain('Retest broad jump');
    view.unmount();
  }
});

test('a slow queue for the previous athlete never renders under the new one', async () => {
  let release!: () => void;
  holdQueueAna = new Promise<void>((resolve) => { release = resolve; });
  render(<CoachAssessmentsPage />);
  await act(async () => {});
  await act(async () => {
    fireEvent.change(screen.getByLabelText('Which athlete'), { target: { value: 'ath-1' } });
  });
  await act(async () => {
    fireEvent.change(screen.getByLabelText('Which athlete'), { target: { value: 'ath-2' } });
  });
  await act(async () => { release(); });
  expect(queueSection('Ben Boxer').textContent).toContain('No open test or rating requests for this athlete.');
  expect(document.body.textContent).not.toContain('Retest broad jump');
});

test('a late failure from an earlier pick never hides the newer queue for the same athlete', async () => {
  let release!: () => void;
  holdQueueAna = new Promise<void>((resolve) => { release = resolve; });
  queueResponse = { status: 500, body: {} };
  render(<CoachAssessmentsPage />);
  await act(async () => {});
  await act(async () => {
    fireEvent.change(screen.getByLabelText('Which athlete'), { target: { value: 'ath-1' } });
  });
  await act(async () => {
    fireEvent.change(screen.getByLabelText('Which athlete'), { target: { value: 'ath-2' } });
  });
  holdQueueAna = null;
  queueResponse = { status: 200, body: { requests: QUEUE } };
  await act(async () => {
    fireEvent.change(screen.getByLabelText('Which athlete'), { target: { value: 'ath-1' } });
  });
  await act(async () => { release(); });
  expect(queueSection('Ana Boxer').textContent).toContain('Retest broad jump');
  expect(queueSection('Ana Boxer').textContent).not.toContain('could not be loaded');
});
