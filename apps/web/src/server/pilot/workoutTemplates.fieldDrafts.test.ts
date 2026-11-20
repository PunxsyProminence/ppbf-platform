// The template's AI-draft read for coaches and admins (lane ED-UI PR3, Q5 = A;
// OW25-57, OD-2026-11-19-012: coaches and admins only). The same rule as a
// drill's (drillLibraryV3.ts labelIsDraft): true a draft, false labelled and
// not one, null NOT CHECKED. Who receives it is the route's test
// (app/api/pilot/workout-templates/route.test.ts).

jest.mock('./db', () => ({ query: jest.fn(), queryOne: jest.fn() }));

import { queryOne } from './db';
import { readWorkoutTemplateFieldDrafts, templateFieldDrafts } from './workoutTemplates';

const mockQueryOne = queryOne as jest.Mock;

const AI_DRAFT = { status: 'INFERRED', sources: ['Claude research draft'], draft: 'AI draft' };
const IN_APP_EDIT = { status: 'REPORTED', sources: ['In-app edit'], edited: { by_account_id: 'acct-9', by_role: 'coach', at: '2026-11-19T00:00:00Z' } };
const TEMPLATE = { template_id: 'wtp-1', lineage_id: 'lin-wtp-1', version: 2 };

afterEach(() => jest.clearAllMocks());

test('each shown field by its label key: a draft, an edit, or not checked', () => {
  expect(templateFieldDrafts({ session_type: AI_DRAFT, intent: IN_APP_EDIT, items: { ...IN_APP_EDIT, 1: AI_DRAFT } }, true)).toEqual({
    name: null,
    session_type: true,
    difficulty: null,
    age_band: null,
    duration_minutes: null,
    intent: false,
    requires_coach_authorization: null,
    coach_notes: null,
    items: true,
    labelled: true,
  });
});

test('reads the labels of this version (kind workout_template, its lineage and version)', async () => {
  mockQueryOne.mockResolvedValue({ field_labels: { duration_minutes: AI_DRAFT } });
  const drafts = await readWorkoutTemplateFieldDrafts('org-1', TEMPLATE);
  expect(drafts).toMatchObject({ duration_minutes: true, name: null, labelled: true });
  const [text, params] = mockQueryOne.mock.calls[0] as [string, unknown[]];
  expect(text).toContain("target_kind = 'workout_template'");
  expect(params).toEqual(['org-1', 'lin-wtp-1', 2]);
});

test('no label row: every field not checked, and the version says it has none', async () => {
  mockQueryOne.mockResolvedValue(null);
  const drafts = await readWorkoutTemplateFieldDrafts('org-1', TEMPLATE);
  expect(drafts.labelled).toBe(false);
  expect(Object.values(drafts).filter((value) => value !== false)).toEqual(Array(9).fill(null));
});

test('before the labels table exists (42P01): no row, and nothing is logged', async () => {
  mockQueryOne.mockRejectedValue(Object.assign(new Error('relation does not exist'), { code: '42P01' }));
  const log = jest.spyOn(console, 'error').mockImplementation(() => {});
  expect((await readWorkoutTemplateFieldDrafts('org-1', TEMPLATE)).labelled).toBe(false);
  expect(log).not.toHaveBeenCalled();
  log.mockRestore();
});

test('a failed read: not known (labelled null), logged without its text, never "not a draft"', async () => {
  mockQueryOne.mockRejectedValue(Object.assign(new Error('connection reset'), { code: '08006' }));
  const log = jest.spyOn(console, 'error').mockImplementation(() => {});
  const drafts = await readWorkoutTemplateFieldDrafts('org-1', TEMPLATE);
  expect(drafts.labelled).toBeNull();
  expect(drafts.session_type).toBeNull();
  expect(log).toHaveBeenCalledWith({ event: 'template-field-drafts-read-failed', template_id: 'wtp-1', code: '08006' });
  log.mockRestore();
});
