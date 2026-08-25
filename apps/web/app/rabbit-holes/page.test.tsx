/**
 * @jest-environment jsdom
 */

// A rabbit hole used to be JSX: it reached one role, belonged to whoever could
// edit the component, and could not be taken down without a deploy. The
// authoring surface has to make the four things that replaced those real -- the
// anchor is picked from a vocabulary in readable words, the author can see what
// is already written there, publishing carries the stable key rather than the
// label, and a coach can retire what they wrote and nothing else.

import type { ReactNode } from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';

import RabbitHolesPage from './page';

jest.mock('@/components/RoleSessionGate', () => ({
  __esModule: true,
  default: ({ children }: { readonly children: ReactNode }) => children,
}));

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ children, href }: { readonly children: ReactNode; readonly href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

let sessionAccountId = 'coach-1';
let sessionRole = 'coach';

jest.mock('@/components/usePilotSession', () => ({
  ...jest.requireActual('@/components/usePilotSession'),
  usePilotSession: () => ({
    role: sessionRole,
    organizationId: 'org-1',
    authProvider: 'microsoft',
    accountId: sessionAccountId,
    mustChangePin: false,
    loading: false,
  }),
}));

interface TestLesson {
  rabbit_hole_id: string;
  anchor_type: string;
  anchor_key: string;
  audience: string;
  title: string;
  concept: string;
  homework: string | null;
  author_display_name: string;
  author_account_id: string | null;
  citation: null;
  status: 'published' | 'retired';
  created_at: string;
  updated_at: string;
}

function lesson(overrides: Partial<TestLesson> = {}): TestLesson {
  return {
    rabbit_hole_id: 'rh-1',
    anchor_type: 'gap_type',
    anchor_key: 'technique',
    audience: 'athlete',
    title: 'Biomechanics of Kinetic Force Transfer',
    concept: 'Power does not generate in the shoulders.',
    homework: 'Thirty slow crosses, three seconds at full extension.',
    author_display_name: 'Coach Jason',
    author_account_id: 'coach-1',
    citation: null,
    status: 'published',
    created_at: '2026-07-30T12:00:00.000Z',
    updated_at: '2026-07-30T12:00:00.000Z',
    ...overrides,
  };
}

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, json: async () => body } as Response;
}

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  sessionAccountId = 'coach-1';
  sessionRole = 'coach';
  jest.clearAllMocks();
});

// The surface makes two authoring reads: one scoped to the anchor being
// drafted, one for everything the gym has written.
function listFetch(lessons: TestLesson[], readOk = true): jest.Mock {
  return jest.fn(async (url: unknown, init?: RequestInit) => {
    if (String(url).includes('/api/pilot/rabbit-holes/get')) {
      if (!readOk) {
        return jsonResponse({}, false);
      }
      const body = JSON.parse(String(init?.body)) as { anchor_type?: string; anchor_key?: string };
      const scoped = body.anchor_type
        ? lessons.filter((item) => item.anchor_type === body.anchor_type && item.anchor_key === body.anchor_key)
        : lessons;
      return jsonResponse({ ok: true, rabbit_holes: scoped });
    }
    throw new Error(`Unexpected fetch: ${String(url)}`);
  });
}

async function renderPage(fetchMock: jest.Mock) {
  global.fetch = fetchMock as unknown as typeof fetch;
  await act(async () => {
    render(<RabbitHolesPage />);
  });
  return fetchMock;
}

test('the anchor is picked in readable words, never as the stored slug', async () => {
  await renderPage(listFetch([]));

  const term = screen.getByLabelText(/Term/) as HTMLSelectElement;
  const labels = [...term.options].map((option) => option.textContent);
  expect(labels).toContain('Technique');
  expect(labels).not.toContain('technique');

  const kind = screen.getByLabelText(/Kind of term/) as HTMLSelectElement;
  expect([...kind.options].map((option) => option.textContent)).toContain('Progression gap type');
});

test('choosing a different kind of term moves the term list with it', async () => {
  await renderPage(listFetch([]));

  await act(async () => {
    fireEvent.change(screen.getByLabelText(/Kind of term/), { target: { value: 'severity' } });
  });

  const term = screen.getByLabelText(/Term/) as HTMLSelectElement;
  expect([...term.options].map((option) => option.textContent)).toEqual(['Critical', 'High', 'Medium', 'Low']);
  // The key moves with the vocabulary; a severity lesson filed under a gap type
  // key is exactly the failure no database check can catch.
  expect(term.value).toBe('critical');
});

test('the author sees what is already written for the anchor they are drafting', async () => {
  await renderPage(listFetch([lesson()]));

  const already = screen.getByRole('heading', { name: /Already Written For Progression gap type: Technique/ })
    .parentElement as HTMLElement;
  expect(within(already).getByText('Biomechanics of Kinetic Force Transfer')).toBeTruthy();
  expect(within(already).getByText(/by Coach Jason, for Athletes/)).toBeTruthy();
});

test('an anchor nobody has written for says so, and says it about the gym', async () => {
  await renderPage(listFetch([lesson({ anchor_key: 'mental' })]));

  const already = screen.getByRole('heading', { name: /Already Written For Progression gap type: Technique/ })
    .parentElement as HTMLElement;
  expect(within(already).getByText('Nothing is published against this term yet.')).toBeTruthy();
});

test('publishing sends the stable key, not the label the author read', async () => {
  const fetchMock = jest.fn(async (url: unknown, init?: RequestInit) => {
    if (String(url).includes('/api/pilot/rabbit-holes/post')) {
      return jsonResponse({ ok: true, rabbit_hole: lesson() });
    }
    if (String(url).includes('/api/pilot/rabbit-holes/get')) {
      return jsonResponse({ ok: true, rabbit_holes: [] });
    }
    throw new Error(`Unexpected fetch: ${String(url)} ${String(init?.method)}`);
  });

  await renderPage(fetchMock);

  fireEvent.change(screen.getByLabelText(/Kind of term/), { target: { value: 'severity' } });
  fireEvent.change(screen.getByLabelText(/^Term$/), { target: { value: 'high' } });
  fireEvent.change(screen.getByPlaceholderText('Title of the lesson'), {
    target: { value: 'What a high-severity gap costs you' },
  });
  fireEvent.change(screen.getByPlaceholderText(/Concept - why this works/), {
    target: { value: 'A gap left open widens under fatigue.' },
  });
  fireEvent.change(screen.getByPlaceholderText(/Homework \(optional\)/), {
    target: { value: 'Name the round it shows up in.' },
  });
  fireEvent.change(screen.getByLabelText(/Who reads it/), { target: { value: 'athlete' } });
  fireEvent.change(screen.getByPlaceholderText('Your name, as readers will see it'), {
    target: { value: 'Coach M.' },
  });

  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Publish' }));
  });

  const postCall = fetchMock.mock.calls.find((call) => String(call[0]).includes('/rabbit-holes/post'));
  expect(postCall).toBeDefined();
  expect(JSON.parse(String((postCall?.[1] as RequestInit).body))).toEqual({
    anchor_type: 'severity',
    anchor_key: 'high',
    audience: 'athlete',
    title: 'What a high-severity gap costs you',
    concept: 'A gap left open widens under fatigue.',
    homework: 'Name the round it shows up in.',
    author_display_name: 'Coach M.',
  });
});

test('a lesson with no concept, title or author name cannot be published', async () => {
  const fetchMock = await renderPage(listFetch([]));

  expect((screen.getByRole('button', { name: 'Publish' }) as HTMLButtonElement).disabled).toBe(true);

  fireEvent.change(screen.getByPlaceholderText('Title of the lesson'), { target: { value: 'A title' } });
  expect((screen.getByRole('button', { name: 'Publish' }) as HTMLButtonElement).disabled).toBe(true);

  fireEvent.change(screen.getByPlaceholderText(/Concept - why this works/), { target: { value: 'A concept' } });
  expect((screen.getByRole('button', { name: 'Publish' }) as HTMLButtonElement).disabled).toBe(true);

  fireEvent.change(screen.getByPlaceholderText('Your name, as readers will see it'), {
    target: { value: 'Coach M.' },
  });
  expect((screen.getByRole('button', { name: 'Publish' }) as HTMLButtonElement).disabled).toBe(false);

  expect(fetchMock.mock.calls.filter((call) => String(call[0]).includes('/rabbit-holes/post'))).toHaveLength(0);
});

test('homework is optional and an unwritten one is sent as absent, not as empty text', async () => {
  const fetchMock = jest.fn(async (url: unknown, init?: RequestInit) => {
    if (String(url).includes('/api/pilot/rabbit-holes/post')) {
      return jsonResponse({ ok: true, rabbit_hole: lesson({ homework: null }) });
    }
    if (init?.method !== 'POST') {
      throw new Error(`Unexpected fetch: ${String(url)}`);
    }
    return jsonResponse({ ok: true, rabbit_holes: [] });
  });

  await renderPage(fetchMock);

  fireEvent.change(screen.getByPlaceholderText('Title of the lesson'), { target: { value: 'A title' } });
  fireEvent.change(screen.getByPlaceholderText(/Concept - why this works/), { target: { value: 'A concept' } });
  fireEvent.change(screen.getByPlaceholderText('Your name, as readers will see it'), {
    target: { value: 'Coach M.' },
  });

  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Publish' }));
  });

  const postCall = fetchMock.mock.calls.find((call) => String(call[0]).includes('/rabbit-holes/post'));
  expect(JSON.parse(String((postCall?.[1] as RequestInit).body)).homework).toBeNull();
});

test('a coach may retire what they wrote and is offered nothing on what they did not', async () => {
  await renderPage(
    listFetch([
      lesson({ rabbit_hole_id: 'rh-mine', title: 'Mine', author_account_id: 'coach-1' }),
      lesson({ rabbit_hole_id: 'rh-theirs', title: 'Theirs', author_account_id: 'coach-2' }),
    ]),
  );

  const posted = screen.getByRole('heading', { name: 'What This Gym Has Written Lately' })
    .parentElement as HTMLElement;
  const cards = within(posted).getAllByRole('article');
  const mine = cards.find((card) => within(card).queryByText('Mine')) as HTMLElement;
  const theirs = cards.find((card) => within(card).queryByText('Theirs')) as HTMLElement;

  expect(within(mine).getByRole('button', { name: 'Retire' })).toBeTruthy();
  // The server refuses this, so the button must never be drawn: a control that
  // only ever produces a 403 is a control that did not do what it looked like.
  expect(within(theirs).queryByRole('button', { name: 'Retire' })).toBeNull();
});

test('an administrator may take down anything the gym published', async () => {
  sessionRole = 'admin';
  sessionAccountId = 'admin-1';

  await renderPage(listFetch([lesson({ rabbit_hole_id: 'rh-theirs', author_account_id: 'coach-2' })]));

  expect(screen.getByRole('button', { name: 'Retire' })).toBeTruthy();
});

test('retiring marks the lesson retired in place rather than deleting it', async () => {
  const fetchMock = jest.fn(async (url: unknown) => {
    if (String(url).includes('/api/pilot/rabbit-holes/update')) {
      return jsonResponse({ ok: true, rabbit_hole: lesson({ status: 'retired' }) });
    }
    if (String(url).includes('/api/pilot/rabbit-holes/get')) {
      return jsonResponse({ ok: true, rabbit_holes: [lesson()] });
    }
    throw new Error(`Unexpected fetch: ${String(url)}`);
  });

  await renderPage(fetchMock);

  await act(async () => {
    fireEvent.click(screen.getAllByRole('button', { name: 'Retire' })[0]);
  });

  expect(screen.getByText(/no longer renders anywhere, and nothing was deleted/)).toBeTruthy();
  expect(screen.getAllByRole('button', { name: 'Restore' }).length).toBeGreaterThan(0);
  expect(screen.getAllByText('Retired').length).toBeGreaterThan(0);
  // The concept and homework stay on the record.
  expect(screen.getByText(/Thirty slow crosses/)).toBeTruthy();
});

test('a failed load is not presented as a gym that has written nothing', async () => {
  await renderPage(listFetch([], false));

  expect(screen.getAllByText(/Nothing below is the full list/).length).toBeGreaterThan(0);
  expect(screen.queryByText('No rabbit holes have been written for this gym yet.')).toBeNull();
  expect(screen.queryByText('Nothing is published against this term yet.')).toBeNull();
});

test('the surface tells the author what authority their writing carries', async () => {
  await renderPage(listFetch([]));

  expect(screen.getByText(/gym's own coaching, published under your name/)).toBeTruthy();
  expect(screen.getByText(/carries no SHADOW evidence tier/)).toBeTruthy();
  for (const tier of ['PROVEN', 'EMERGING', 'EXPERIMENTAL', 'RESEARCH_NEEDED']) {
    expect(screen.queryByText(tier)).toBeNull();
  }
});

// THE WHOLE-GYM LIST IS A CAPPED READ, AND IT USED TO CALL ITSELF COMPLETE.
//
// The heading over these cards read "Everything This Gym Has Written". The
// request asks for LESSON_READ_LIMIT lessons; rabbitHoles.ts orders the
// authoring read `updated_at desc` and clamps it at MAX_AUTHORING_LIMIT; and
// this surface has no pager. So past that many lessons the older ones are not
// reachable from here at all -- and the whole point of the panel above it is a
// coach checking whether a lesson has already been written, who would read an
// absence as "nobody has written it".
//
// WATCHED TO FAIL, 2026-08-25: restore the old heading and the first test goes
// red naming the word "everything"; delete the read-window line and it goes red
// on the missing sentence.
test('the whole-gym list never calls a capped read everything the gym has written', async () => {
  await renderPage(listFetch([lesson()]));

  // Located by the window line rather than by the heading, so restoring the
  // old heading fails on the WORD rather than on a missing element.
  const list = screen
    .getByText(/reads the 100 most recently updated rabbit holes/i)
    .closest('section') as HTMLElement;
  // Not vacuous: this really is the whole-gym list, with a lesson in it.
  expect(within(list).getByText('Biomechanics of Kinetic Force Transfer')).toBeTruthy();
  expect(within(list).queryByText(/everything/i)).toBeNull();
});

// The window line is a statement about rows, so it belongs to rows. A gym that
// has written nothing has none, and a "100 most recent" caveat over "no rabbit
// holes have been written" would be furniture explaining an absence.
test('a gym with nothing written states the absence without the read-window line', async () => {
  await renderPage(listFetch([]));

  expect(screen.getByText('No rabbit holes have been written for this gym yet.')).toBeTruthy();
  expect(screen.queryByText(/most recently updated rabbit holes/i)).toBeNull();
});

// LESSON_READ_LIMIT exists so the request and the sentence cannot drift apart.
// If one is edited without the other, this is the test that notices.
test('the read the page actually sends is the number the page states', async () => {
  const fetchMock = await renderPage(listFetch([lesson()]));

  // The whole-gym read is the one with no anchor on it; the other carries the
  // anchor being drafted.
  const wholeGymRead = fetchMock.mock.calls
    .map((call) => JSON.parse(String((call[1] as RequestInit).body)) as Record<string, unknown>)
    .find((body) => body.anchor_type === undefined);

  expect(wholeGymRead?.limit).toBe(100);
  expect(screen.getByText(/reads the 100 most recently updated rabbit holes/i)).toBeTruthy();
});
