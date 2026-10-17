/**
 * @jest-environment jsdom
 */

// The staff Parent Resources panel (PH-11b): the list in every state, add,
// edit, publish and archive against /api/pilot/coach/parent-resources, each
// change carrying the version it was made from; a refusal in the server's
// words, or "not saved" when it gives none; an unclear answer that may have
// saved; a failed read that is never "none"; one write and one edit form at a
// time; busy buttons named for what they are doing; blank fields refused.

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

// The notice is announced by moving focus to it, so it is not also an alert.
const notice = () => document.getElementById('parent-resources-notice');

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
  expect(published.textContent).toContain('Policy · Published · Juniors · First published October 1, 2026 · Last changed by Coach Ben');
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

test('a writer the server could not name reads as the gym office, not "Your coach"', async () => {
  const unnamed = { ...LISTED, items: [{ ...DRAFT, written_by: 'Your coach' }, { ...PUBLISHED, edited_by: 'Your coach' }] };
  global.fetch = jest.fn(async () => jsonResponse(unnamed)) as unknown as typeof fetch;
  await act(async () => {
    render(<ParentResourcesStaff />);
  });
  expect(row('Hydration guide').textContent).toContain('Last changed by Gym office');
  expect(row('Sparring policy').textContent).toContain('Last changed by Gym office');
  expect(screen.queryByText(/Your coach/)).toBeNull();
});

test('blank fields are refused without a request', async () => {
  const fetchMock = await renderWith();
  const form = fillAdd({ title: 'Only a title', summary: '   ' });
  await act(async () => {
    fireEvent.submit(form);
  });
  expect(sentBodies(fetchMock)).toEqual([]);
  expect(notice()).toHaveTextContent('Fill in the title, the summary and the link.');
  expect(notice()).toHaveFocus();
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

test('a microsecond version is sent exactly as read, and a second edit sends the version the server returned', async () => {
  const READ_AT = '2026-10-05T15:00:00.123456Z';
  const SAVED_AT = '2026-10-05T15:04:07.654321Z';
  const listed = { ...LISTED, items: [{ ...DRAFT, updated_at: READ_AT }] };
  const writes: Handler[] = [
    () => jsonResponse({ ok: true, item: { ...DRAFT, title: 'Hydration, part one', updated_at: SAVED_AT } }),
    () => jsonResponse({ ok: true, item: { ...DRAFT, title: 'Hydration, part two', updated_at: '2026-10-05T15:09:00.000001Z' } }),
  ];
  const fetchMock = jest.fn(async (_url: string, init?: RequestInit) => (init?.method ? writes.shift()!(init) : jsonResponse(listed)));
  global.fetch = fetchMock as unknown as typeof fetch;
  await act(async () => {
    render(<ParentResourcesStaff />);
  });
  const editTo = async (from: string, to: string) => {
    fireEvent.click(screen.getByRole('button', { name: `Edit ${from}` }));
    const form = screen.getByRole('form', { name: `Edit ${from}` });
    fireEvent.change(within(form).getByLabelText('Title'), { target: { value: to } });
    await act(async () => {
      fireEvent.submit(form);
    });
  };
  await editTo('Hydration guide', 'Hydration, part one');
  await editTo('Hydration, part one', 'Hydration, part two');
  expect(sentBodies(fetchMock).map((b) => [b.title, b.updated_at])).toEqual([
    ['Hydration, part one', READ_AT],
    ['Hydration, part two', SAVED_AT],
  ]);
});

test('while one edit form is open, no other resource offers Edit', async () => {
  await renderWith();
  fireEvent.click(screen.getByRole('button', { name: 'Edit Hydration guide' }));
  expect(screen.getByRole('form', { name: 'Edit Hydration guide' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Edit Sparring policy' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Cancel editing Hydration guide' }));
  expect(screen.getByRole('button', { name: 'Edit Sparring policy' })).toBeInTheDocument();
});

test('publishes and archives with the item’s own version', async () => {
  const fetchMock = await renderWith(
    () => jsonResponse({ ok: true, item: { ...DRAFT, state: 'published', published_at: '2026-10-05T15:00:00Z', updated_at: 'v5' } }),
    () => jsonResponse({ ok: true, item: { ...PUBLISHED, state: 'archived', updated_at: 'v6' } }),
  );
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Publish Hydration guide' }));
  });
  expect(row('Hydration guide').textContent).toContain('Published · Every family · First published October 5, 2026');
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
  // Focus announces it; a live region as well would read it twice.
  expect(screen.queryByRole('alert')).toBeNull();
  expect(row('Hydration guide').textContent).toContain('Draft');
  expect(screen.queryByRole('button', { name: 'Reload the list' })).toBeNull();
});

test('a 409 shows the server’s words and offers to read the list again', async () => {
  const fetchMock = await renderWith(() => jsonResponse({ error: 'Someone else changed this resource. Reload to see their version.' }, 409));
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Archive Sparring policy' }));
  });
  expect(notice()).toHaveTextContent('Someone else changed this resource. Reload to see their version.');
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Reload the list' }));
  });
  expect(fetchMock.mock.calls.filter((c) => !(c[1] as RequestInit | undefined)?.method)).toHaveLength(2);
  expect(notice()).toBeNull();
});

test.each([
  ['a 400', 400, false],
  ['a 409', 409, true],
])('%s with no words of its own says it was not saved, not that it may have been', async (_label, status, reload) => {
  await renderWith(() => jsonResponse({}, status));
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Archive Sparring policy' }));
  });
  expect(notice()).toHaveTextContent(/^That was not saved\.$/);
  expect(notice()).toHaveFocus();
  expect(screen.queryByRole('button', { name: 'Reload the list' }) !== null).toBe(reload);
});

test.each([
  ['a 5xx', () => jsonResponse({ error: 'Internal: boom' }, 500)],
  ['no answer', () => Promise.reject(new Error('offline'))],
])('%s says it may not have been saved, and never shows the server’s 5xx text', async (_label, handler) => {
  await renderWith(handler as Handler);
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Archive Sparring policy' }));
  });
  expect(notice()).toHaveTextContent('may not have been saved. Reload the page to check.');
  expect(screen.queryByText(/boom/)).toBeNull();
  expect(screen.getByRole('button', { name: 'Reload the list' })).toBeInTheDocument();
});

test('a second tap while a write is in flight sends nothing; once it lands, the next tap sends', async () => {
  let release: (r: Response) => void = () => {};
  const fetchMock = await renderWith(
    () => new Promise<Response>((resolve) => { release = resolve; }),
    () => jsonResponse({ ok: true, item: { ...PUBLISHED, state: 'archived', updated_at: 'v8' } }),
  );
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
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Archive Sparring policy' }));
  });
  expect(sentBodies(fetchMock)).toEqual([
    { resource_id: 'r1', updated_at: 'v1', action: 'publish' },
    { resource_id: 'r2', updated_at: 'v2', action: 'archive' },
  ]);
});

const never = () => new Promise<Response>(() => {});

test.each([
  ['Publish Hydration guide', 'Publishing… Hydration guide'],
  ['Archive Sparring policy', 'Archiving… Sparring policy'],
])('while busy, "%s" is named "%s"', async (idle, working) => {
  await renderWith(never);
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: idle }));
  });
  expect(screen.getByRole('button', { name: working })).toBeDisabled();
  expect(screen.queryByRole('button', { name: idle })).toBeNull();
});

test('while saving, the save button is named "Saving… <title>"', async () => {
  await renderWith(never);
  fireEvent.click(screen.getByRole('button', { name: 'Edit Hydration guide' }));
  await act(async () => {
    fireEvent.submit(screen.getByRole('form', { name: 'Edit Hydration guide' }));
  });
  expect(screen.getByRole('button', { name: 'Saving… Hydration guide' })).toBeDisabled();
});
