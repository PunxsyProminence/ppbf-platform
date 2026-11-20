/**
 * @jest-environment jsdom
 */

import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import TemplateEditForm, { TEMPLATE_EDIT_FORM_KEYS, type TemplateEditOutcome } from './TemplateEditForm';
import { MAX_LONG_TEXT, MAX_NOTE_TEXT, MAX_SHORT_TEXT, parseWorkoutTemplateEdit } from '@/src/server/pilot/workoutTemplateEdit';
import type { WorkoutTemplateItemWithDrillHead, WorkoutTemplateRow } from '@/src/server/pilot/workoutTemplates';

jest.mock('@/lib/apiBase', () => ({ apiBase: () => '' }));
// The route's own parser is run below; its database and audit imports are not wanted in jsdom.
jest.mock('@/src/server/pilot/db', () => ({}));
jest.mock('@/src/server/pilot/audit', () => ({}));

const template = {
  organization_id: 'org-1', template_id: 'wt-1', lineage_id: 'lin-1', version: 1, supersedes_template_id: null, superseded_at: null,
  name: 'Boxing Fundamentals 60', session_type: 'group_class', difficulty: 'beginner', age_band: '11-14', duration_minutes: 60,
  intent: 'Stance, guard, and the first two punches.', coach_notes: 'Keep the room moving.', requires_coach_authorization: false,
  active: true, created_by_account_id: null, created_by_role: null, created_at: '2026-08-01T00:00:00.000Z', updated_at: '2026-08-01T00:00:00.000Z',
} as WorkoutTemplateRow;

const item = (overrides: Record<string, unknown>) => ({
  organization_id: 'org-1', item_id: 'wti-1', template_id: 'wt-1', ordinal: 1, block: 'warmup', drill_id: null, free_text_drill: 'Rope intervals',
  scale_level: 'B', duration_minutes: 10, rep_count: null, contact_level: 'none', coach_note: 'Feet quiet.', details: {},
  created_at: '2026-08-01T00:00:00.000Z', head_drill_id: null, head_drill_name: null, drill_name: null, uses_older_drill_version: false,
  ...overrides,
}) as unknown as WorkoutTemplateItemWithDrillHead;

const items = [
  item({}),
  item({ item_id: 'wti-2', ordinal: 2, block: 'technical', drill_id: 'drl-1', head_drill_id: 'drl-1', head_drill_name: 'Jab return', free_text_drill: null, scale_level: null, duration_minutes: 8, coach_note: null, contact_level: 'light_technical' }),
];
const names = ['1. Rope intervals', '2. Jab return'];

function jsonResponse(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

function renderForm(options: { answer?: () => Promise<Response>; busy?: boolean } = {}) {
  const fetchMock = jest.fn(options.answer ?? (async () => jsonResponse({ ok: true, changed: true, template_id: 'wt-1-v2', version: 2 })));
  global.fetch = fetchMock as unknown as typeof fetch;
  const onSaved = jest.fn<void, [TemplateEditOutcome]>();
  const onCancel = jest.fn();
  const onSaving = jest.fn();
  const onFailed = jest.fn<void, [number | null]>();
  render(
    <TemplateEditForm template={template} items={items} itemNames={names} onSaved={onSaved} onCancel={onCancel} onSaving={onSaving} onFailed={onFailed} busy={options.busy ?? false} />,
  );
  return { fetchMock, onSaved, onCancel, onSaving, onFailed };
}

function sentBody(fetchMock: jest.Mock) {
  const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  expect(url).toBe('/api/pilot/workout-templates');
  expect(init.method).toBe('PATCH');
  return JSON.parse(String(init.body)) as Record<string, unknown>;
}

const change = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
const save = () => fireEvent.click(screen.getByRole('button', { name: 'Save' }));

it('sends only keys the route\'s own parser accepts, every item field included', () => {
  const body: Record<string, unknown> = {
    template_id: 'wt-1', name: 'n', session_type: 's', age_band: 'a', difficulty: 'beginner', duration_minutes: 30, intent: 'i',
    coach_notes: null, requires_coach_authorization: true,
    items: [{ item_id: 'wti-1', block: 'b', free_text_drill: null, scale_level: null, duration_minutes: null, rep_count: 5, contact_level: 'none', coach_note: null }],
  };
  expect(Object.keys(body).filter((key) => key !== 'template_id').sort()).toEqual([...TEMPLATE_EDIT_FORM_KEYS].sort());
  expect(() => parseWorkoutTemplateEdit(body)).not.toThrow();
});

it('opens on the template as it is, under "Edit <name>", with each item named by its place and name', () => {
  renderForm();
  expect(screen.getByRole('heading', { name: 'Edit Boxing Fundamentals 60' })).toHaveFocus();
  expect(screen.getByLabelText('Session type')).toHaveValue('group_class');
  expect(screen.getByLabelText('Age group')).toHaveValue('11-14');
  expect(screen.getByLabelText('Intent')).toHaveValue('Stance, guard, and the first two punches.');
  expect(screen.getByLabelText('1. Rope intervals Words')).toHaveValue('Rope intervals');
  expect(screen.getByLabelText('2. Jab return Minutes')).toHaveValue(8);
  expect(screen.getByLabelText('2. Jab return Scale')).toHaveValue('');
  // Items are edited in place (Q6 = A): no add, remove, reorder or drill swap.
  expect(screen.queryByRole('button', { name: /add|remove|delete|move|up|down/i })).not.toBeInTheDocument();
  expect(screen.queryByLabelText(/drill/i)).not.toBeInTheDocument();
});

it('sends only what changed; a changed item goes in the whole ordered list, the others by id alone', async () => {
  const { fetchMock, onSaved, onSaving } = renderForm();
  change('Intent', 'Stance and guard.');
  change('2. Jab return Note', 'Hands home.');
  change('2. Jab return Minutes', '');
  save();
  await waitFor(() => expect(onSaved).toHaveBeenCalledWith({ changed: true, templateId: 'wt-1-v2', version: 2 }));
  expect(sentBody(fetchMock)).toEqual({
    template_id: 'wt-1',
    intent: 'Stance and guard.',
    items: [{ item_id: 'wti-1' }, { item_id: 'wti-2', coach_note: 'Hands home.', duration_minutes: null }],
  });
  expect(onSaving).toHaveBeenCalledTimes(1);
});

// The template's own Minutes, apart from each item's (named "<n>. <name> Minutes").
const templateMinutes = () => screen.getByLabelText('Minutes', { selector: '#edit-template-wt-1-duration' });

it('leaves the item list out when no item changed', async () => {
  const { fetchMock } = renderForm();
  fireEvent.change(templateMinutes(), { target: { value: '45' } });
  save();
  await waitFor(() => expect(fetchMock).toHaveBeenCalled());
  expect(sentBody(fetchMock)).toEqual({ template_id: 'wt-1', duration_minutes: 45 });
});

it('sends cleared coach notes and a cleared scale as none', async () => {
  const { fetchMock } = renderForm();
  change('Coach notes', '');
  change('1. Rope intervals Scale', '');
  save();
  await waitFor(() => expect(fetchMock).toHaveBeenCalled());
  expect(sentBody(fetchMock)).toEqual({
    template_id: 'wt-1',
    coach_notes: null,
    items: [{ item_id: 'wti-1', scale_level: null }, { item_id: 'wti-2' }],
  });
});

it('writes nothing when nothing changed', () => {
  const { fetchMock, onSaved } = renderForm();
  save();
  expect(fetchMock).not.toHaveBeenCalled();
  expect(onSaved).toHaveBeenCalledWith({ changed: false });
});

it('cannot be typed past the route\'s bounds', () => {
  renderForm();
  expect(screen.getByLabelText('Name')).toHaveAttribute('maxLength', String(MAX_SHORT_TEXT));
  expect(screen.getByLabelText('Intent')).toHaveAttribute('maxLength', String(MAX_LONG_TEXT));
  expect(screen.getByLabelText('1. Rope intervals Note')).toHaveAttribute('maxLength', String(MAX_NOTE_TEXT));
});

describe('a refusal in the form\'s words (Overwatch Q-PR1-1)', () => {
  const refuse = (error: string, status = 400) => async () => jsonResponse({ error }, status);
  it.each([
    ['Missing intent: it cannot be blank', 'Missing Intent: it cannot be blank'],
    ['Unsupported items[1].duration_minutes: a whole number from 1 to 90', 'Unsupported 2. Jab return Minutes: a whole number from 1 to 90'],
    ['Unsupported items: an item above light technical contact carries no minutes or reps', 'Unsupported The blocks: an item above light technical contact carries no minutes or reps'],
  ])('%s -> %s', async (server, shown) => {
    const { onFailed } = renderForm({ answer: refuse(server) });
    change('Intent', 'x');
    save();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(shown);
    expect(alert).toHaveTextContent('Nothing was changed. This template is as it was.');
    expect(alert.textContent).not.toMatch(/items\[|duration_minutes/);
    expect(onFailed).toHaveBeenCalledWith(400);
  });

  it('says only that the outcome is not known after a fault or a lost answer', async () => {
    const { onFailed } = renderForm({ answer: async () => { throw new TypeError('Failed to fetch'); } });
    change('Intent', 'x');
    save();
    expect(await screen.findByRole('alert')).toHaveTextContent(/^▲ It is not known whether this change was saved\.$/);
    expect(onFailed).toHaveBeenCalledWith(null);
  });
});

it('starts nothing and offers no way out while the page is still busy with the last save', () => {
  const { fetchMock } = renderForm({ busy: true });
  expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
  expect(screen.getByLabelText('Intent')).toBeDisabled();
  expect(fetchMock).not.toHaveBeenCalled();
});
