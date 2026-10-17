/**
 * @jest-environment jsdom
 */

// The staff Parent Resources panel (PH-11b): the list in every state, add,
// edit, publish and archive against /api/pilot/coach/parent-resources, each
// change carrying the version it was made from; a refusal in the server's
// words; an unclear answer that may have saved; a failed read that is never
// "none"; one write at a time; blank fields refused.

import '@testing-library/jest-dom';
import { act, fireEvent, render, screen, within } from '@testing-library/react';

import ParentResourcesStaff, { type StaffResourceItem } from './ParentResourcesStaff';

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

const DRAFT: StaffResourceItem = {
  resource_id: 'r1', title: 'Hydration guide', summary: 'What to drink.', resource_type: 'guide', destination: '/help',
  program_id: null, program_name: null, state: 'draft', published_at: null, updated_at: 'v1',
  written_by: 'Coach Ana', edited_by: null, parents_cannot_open: false, program_archived: false,
};
const PUBLISHED: StaffResourceItem = {
  ...DRAFT, resource_id: 'r2', title: 'Sparring policy', resource_type: 'policy', destination: '/coach/drills',
  program_id: 'p1', program_name: 'Juniors', state: 'published', published_at: '2026-10-02T03:30:00Z', updated_at: 'v2',
  edited_by: 'Coach Ben', parents_cannot_open: true, program_archived: true,
};
const LISTED = { ok: true, items: [DRAFT, PUBLISHED], programs: [{ program_id: 'p1', program_name: 'Juniors' }] };

type Handler = (init?: RequestInit) => Promise<Response> | Response;

async function renderWith(...writes: Handler[]) {
  const fetchMock = jest.fn(async (_url: string, init?: RequestInit) => {
    if (!init?.method) return jsonResponse(LISTED);
    const next = writes.shift();
    if (!next) throw new Error('unexpected write');
    return next(init);
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  await act(async () => {
    render(<ParentResourcesStaff />);
  });
  return fetchMock;
}

const sentBodies = (fetchMock: jest.Mock) =>
  fetchMock.mock.calls.filter((c) => (c[1] as RequestInit | undefined)?.method).map((c) => JSON.parse(String((c[1] as RequestInit).body)));

function row(title: string) {
  return screen.getByRole('heading', { name: title }).closest('li') as HTMLElement;
}

function fillAdd(fields: { title?: string; summary?: string; link?: string }) {
  const form = screen.getByRole('form', { name: 'Add a resource' });
  if (fields.title !== undefined) fireEvent.change(within(form).getByLabelText('Title'), { target: { value: fields.title } });
  if (fields.summary !== undefined) fireEvent.change(within(form).getByLabelText('Summary'), { target: { value: fields.summary } });
  if (fields.link !== undefined) fireEvent.change(within(form).getByLabelText(/^Link/), { target: { value: fields.link } });
  return form;
}

afterEach(() => jest.restoreAllMocks());

test('lists every resource with type, state, audience, gym-time date, who changed it, and the marks', async () => {
  await renderWith();
  const draft = row('Hydration guide');
  expect(draft.textContent).toContain('Guide · Draft · Every family · Last changed by Coach Ana');
  expect(draft.textContent).not.toContain('Parents cannot open');
  const published = row('Sparring policy');
  // 03:30 UTC on the 2nd is still the 1st in the gym's time zone.
  expect(published.textContent).toContain('Policy · Published · Juniors · Published October 1, 2026 · Last changed by Coach Ben');
  expect(published.textContent).toContain('Parents cannot open this link.');
  expect(published.textContent).toContain('Its program is archived.');
  expect(within(draft).getByRole('button', { name: 'Publish Hydration guide' })).toBeInTheDocument();
  expect(within(published).queryByRole('button', { name: /^Publish/ })).toBeNull();
  expect(within(published).getByRole('button', { name: 'Archive Sparring policy' })).toBeInTheDocument();
});

test('a failed read says so and never shows an empty list', async () => {
  global.fetch = jest.fn(async () => jsonResponse({ error: 'down' }, 500)) as unknown as typeof fetch;
  await act(async () => {
    render(<ParentResourcesStaff />);
  });
  expect(screen.getByRole('alert')).toHaveTextContent('Resources could not be loaded.');
  expect(screen.queryByText(/No resources have been added/)).toBeNull();
  expect(screen.queryByRole('form', { name: 'Add a resource' })).toBeNull();
});

test('adds a resource for one program, published now, and focus moves to it', async () => {
  const added = { ...DRAFT, resource_id: 'r3', title: 'Fight night checklist', state: 'published', updated_at: 'v3' };
  const fetchMock = await renderWith(() => jsonResponse({ ok: true, item: added }));
  const form = fillAdd({ title: 'Fight night checklist', summary: 'Bring these.', link: 'https://example.org/list' });
  fireEvent.change(within(form).getByLabelText('Type'), { target: { value: 'checklist' } });
  fireEvent.change(within(form).getByLabelText('Who sees it'), { target: { value: 'p1' } });
  fireEvent.click(within(form).getByLabelText('Publish now'));
  await act(async () => {
    fireEvent.submit(form);
  });
  expect(sentBodies(fetchMock)).toEqual([{
    title: 'Fight night checklist', summary: 'Bring these.', resource_type: 'checklist', destination: 'https://example.org/list',
    program_id: 'p1', publish: true,
  }]);
  expect(fetchMock.mock.calls[1]![1]).toMatchObject({ method: 'POST' });
  expect(screen.getByRole('heading', { name: 'Fight night checklist' })).toHaveFocus();
  expect(within(form).getByLabelText('Title')).toHaveValue('');
});

test('every family is sent as null, and a draft is the default', async () => {
  const fetchMock = await renderWith(() => jsonResponse({ ok: true, item: { ...DRAFT, resource_id: 'r4', title: 'New' } }));
  const form = fillAdd({ title: 'New', summary: 'S', link: '/help' });
  await act(async () => {
    fireEvent.submit(form);
  });
  expect(sentBodies(fetchMock)[0]).toMatchObject({ program_id: null, publish: false });
});

test('blank fields are refused without a request, including on Enter', async () => {
  const fetchMock = await renderWith();
  const form = fillAdd({ title: 'Only a title', summary: '   ' });
  await act(async () => {
    fireEvent.keyDown(within(form).getByLabelText('Title'), { key: 'Enter' });
    fireEvent.submit(form);
  });
  expect(sentBodies(fetchMock)).toEqual([]);
  expect(screen.getByRole('alert')).toHaveTextContent('Fill in the title, the summary and the link.');
});

test('edits a resource, sending the version it was read at, and focus returns to it', async () => {
  const fetchMock = await renderWith(() => jsonResponse({ ok: true, item: { ...DRAFT, title: 'Hydration for juniors', updated_at: 'v9' } }));
  fireEvent.click(screen.getByRole('button', { name: 'Edit Hydration guide' }));
  const form = screen.getByRole('form', { name: 'Edit Hydration guide' });
  expect(within(form).getByLabelText('Title')).toHaveFocus();
  fireEvent.change(within(form).getByLabelText('Title'), { target: { value: 'Hydration for juniors' } });
  await act(async () => {
    fireEvent.click(within(form).getByRole('button', { name: 'Save changes to Hydration guide' }));
  });
  expect(sentBodies(fetchMock)).toEqual([{
    resource_id: 'r1', updated_at: 'v1', action: 'edit', title: 'Hydration for juniors', summary: 'What to drink.',
    resource_type: 'guide', destination: '/help', program_id: null,
  }]);
  expect(fetchMock.mock.calls[1]![1]).toMatchObject({ method: 'PATCH' });
  expect(screen.getByRole('heading', { name: 'Hydration for juniors' })).toHaveFocus();
  expect(screen.queryByRole('form', { name: /^Edit/ })).toBeNull();
});

test('publishes and archives with the item’s own version', async () => {
  const fetchMock = await renderWith(
    () => jsonResponse({ ok: true, item: { ...DRAFT, state: 'published', published_at: '2026-10-05T15:00:00Z', updated_at: 'v5' } }),
    () => jsonResponse({ ok: true, item: { ...PUBLISHED, state: 'archived', updated_at: 'v6' } }),
  );
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Publish Hydration guide' }));
  });
  expect(row('Hydration guide').textContent).toContain('Published · Every family · Published October 5, 2026');
  expect(screen.getByRole('heading', { name: 'Hydration guide' })).toHaveFocus();
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Archive Sparring policy' }));
  });
  expect(sentBodies(fetchMock)).toEqual([
    { resource_id: 'r1', updated_at: 'v1', action: 'publish' },
    { resource_id: 'r2', updated_at: 'v2', action: 'archive' },
  ]);
  expect(row('Sparring policy').textContent).toContain('Archived');
  expect(within(row('Sparring policy')).queryByRole('button', { name: /^Archive/ })).toBeNull();
  expect(screen.queryByRole('button', { name: /^Delete/ })).toBeNull();
});

test('a refusal shows the server’s own words and focuses them', async () => {
  await renderWith(() => jsonResponse({ error: 'Parents cannot open that page in the app. Change the link before publishing.' }, 400));
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Publish Hydration guide' }));
  });
  expect(screen.getByText('Parents cannot open that page in the app. Change the link before publishing.')).toHaveFocus();
  expect(row('Hydration guide').textContent).toContain('Draft');
  expect(screen.queryByRole('button', { name: 'Reload the list' })).toBeNull();
});

test('a 409 shows the server’s words and offers to read the list again', async () => {
  const fetchMock = await renderWith(() => jsonResponse({ error: 'Someone else changed this resource. Reload to see their version.' }, 409));
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Archive Sparring policy' }));
  });
  expect(screen.getByRole('alert')).toHaveTextContent('Someone else changed this resource. Reload to see their version.');
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Reload the list' }));
  });
  expect(fetchMock.mock.calls.filter((c) => !(c[1] as RequestInit | undefined)?.method)).toHaveLength(2);
  expect(screen.queryByRole('alert')).toBeNull();
});

test.each([
  ['a 5xx', () => jsonResponse({ error: 'Internal: boom' }, 500)],
  ['no answer', () => Promise.reject(new Error('offline'))],
])('%s says it may not have been saved, and never shows the server’s 5xx text', async (_label, handler) => {
  await renderWith(handler as Handler);
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Archive Sparring policy' }));
  });
  expect(screen.getByRole('alert')).toHaveTextContent('may not have been saved. Reload the page to check.');
  expect(screen.queryByText(/boom/)).toBeNull();
  expect(screen.getByRole('button', { name: 'Reload the list' })).toBeInTheDocument();
});

test('a second tap while a write is in flight sends nothing', async () => {
  let release: (r: Response) => void = () => {};
  const fetchMock = await renderWith(() => new Promise<Response>((resolve) => { release = resolve; }));
  const publish = screen.getByRole('button', { name: 'Publish Hydration guide' });
  await act(async () => {
    fireEvent.click(publish);
    fireEvent.click(publish);
    fireEvent.click(screen.getByRole('button', { name: 'Archive Sparring policy' }));
  });
  expect(sentBodies(fetchMock)).toHaveLength(1);
  await act(async () => {
    release(jsonResponse({ ok: true, item: { ...DRAFT, state: 'published', updated_at: 'v7' } }));
  });
  expect(sentBodies(fetchMock)).toHaveLength(1);
});
