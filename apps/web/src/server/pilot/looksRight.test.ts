// "LOOKS RIGHT" ON THE SERVER (OD-2026-11-19-007, OW25-55; lane ED-UI PR4, Q1 = A,
// Q2 = A, Q3 = A). A coach confirms one AI-drafted field as it stands: the request
// names it alone; it must be a field the edit form can change and still a draft on
// the current version; the next version keeps the text, the label keeps its
// sources, loses `draft` and records the coach; an import then holds the item.
//
// The database is a stand-in that answers by statement, so the real parse, draft
// check, label writer and audit call run here. Against a real database:
// drillLibraryEdit.pg.test.ts and workoutTemplateEdit.pg.test.ts (CI's pg job).

jest.mock('./db', () => ({ withTransaction: jest.fn(), query: jest.fn(), queryOne: jest.fn() }));
jest.mock('./audit', () => ({ writePilotAuditEvent: jest.fn(async () => undefined) }));

import { writePilotAuditEvent } from './audit';
import { confirmLooksRight } from './contentImport/datasets/contentLabels';
import { findInAppEditLabels, isInAppEditLabel } from './contentImport/inAppEdits';
import { withTransaction } from './db';
import { editLibraryDrill, parseDrillLibraryEdit } from './drillLibraryEdit';
import { editWorkoutTemplate, parseWorkoutTemplateEdit } from './workoutTemplateEdit';

const DRAFT = { status: 'INFERRED', sources: ['DOC-1'], draft: 'AI draft' };
const SOURCED = { status: 'INFERRED', sources: ['DOC-1'] };
const RECORD = { by_account_id: 'acct-coach', by_role: 'coach', at: '2026-11-20T12:00:00.000Z' };
const EDITOR = { accountId: 'acct-coach', role: 'coach', at: '2026-11-20T12:00:00.000Z' };

describe('the request: looks_right alone, naming one field the edit form can change', () => {
  test('drills: a field, a scale level, the stop-rule list', () => {
    expect(parseDrillLibraryEdit({ drill_id: 'd1', looks_right: 'purpose' }).looksRight).toEqual({ field: 'purpose' });
    expect(parseDrillLibraryEdit({ drill_id: 'd1', looks_right: 'scale_levels.B' }).looksRight).toEqual({ field: 'scale_levels', part: 'B' });
    expect(parseDrillLibraryEdit({ drill_id: 'd1', looks_right: 'stop_rules' }).looksRight).toEqual({ field: 'stop_rules' });
  });

  test.each([
    ['with a change', { looks_right: 'purpose', purpose: 'New.' }, 'LOOKS_RIGHT_WITH_CHANGES'],
    ['a field the form cannot change (Q3 = A)', { looks_right: 'discipline' }, 'FIELD_NOT_EDITABLE'],
    ['the scale levels as a whole (Q2 = A: one level at a time)', { looks_right: 'scale_levels' }, 'UNKNOWN_FIELD'],
    ['a level that is not A, B or C', { looks_right: 'scale_levels.D' }, 'UNKNOWN_FIELD'],
    ['a rule by itself (Q2 = A: the list as one)', { looks_right: 'stop_rules.1' }, 'UNKNOWN_FIELD'],
    ['an unknown field', { looks_right: 'nonsense' }, 'UNKNOWN_FIELD'],
  ])('drills refuse looks_right %s (400)', (_case, body, code) => {
    expect(() => parseDrillLibraryEdit({ drill_id: 'd1', ...body })).toThrow(expect.objectContaining({ status: 400, code }));
  });

  test('drills refuse a looks_right that is not text', () => {
    expect(() => parseDrillLibraryEdit({ drill_id: 'd1', looks_right: '' })).toThrow(expect.objectContaining({ status: 400 }));
    expect(() => parseDrillLibraryEdit({ drill_id: 'd1', looks_right: ['purpose'] })).toThrow(expect.objectContaining({ status: 400 }));
  });

  test('templates: any field the form can change, the item list as one; never with a change or a field it cannot change', () => {
    expect(parseWorkoutTemplateEdit({ template_id: 't1', looks_right: 'intent' }).looksRight).toBe('intent');
    expect(parseWorkoutTemplateEdit({ template_id: 't1', looks_right: 'items' }).looksRight).toBe('items');
    expect(() => parseWorkoutTemplateEdit({ template_id: 't1', looks_right: 'intent', intent: 'New.' }))
      .toThrow(expect.objectContaining({ status: 400, code: 'LOOKS_RIGHT_WITH_CHANGES' }));
    expect(() => parseWorkoutTemplateEdit({ template_id: 't1', looks_right: 'details' }))
      .toThrow(expect.objectContaining({ status: 400, code: 'FIELD_NOT_EDITABLE' }));
    expect(() => parseWorkoutTemplateEdit({ template_id: 't1', looks_right: 'nonsense' }))
      .toThrow(expect.objectContaining({ status: 400, code: 'UNKNOWN_FIELD' }));
  });
});

describe('the label a press writes (Q1 = A)', () => {
  test('a field keeps its sources, loses draft and records the coach; nothing else changes', () => {
    const labels = { purpose: DRAFT, execution: DRAFT };
    const out = confirmLooksRight(labels, { field: 'purpose' }, EDITOR);
    expect(out.purpose).toEqual({ ...SOURCED, looks_right: RECORD });
    expect(out.execution).toEqual(DRAFT);
    // The input is not changed.
    expect(labels.purpose).toEqual(DRAFT);
  });

  test('a whole field confirms its parts too; the stop-rule list confirms its kinds (Q2 = A)', () => {
    const out = confirmLooksRight(
      { stop_rules: { ...DRAFT, 1: DRAFT, 2: SOURCED }, 'stop_rules.rule_kind': { ...SOURCED, 1: DRAFT } },
      { field: 'stop_rules' }, EDITOR, ['stop_rules.rule_kind'],
    );
    expect(out.stop_rules).toEqual({ ...SOURCED, 1: SOURCED, 2: SOURCED, looks_right: RECORD });
    expect(out['stop_rules.rule_kind']).toEqual({ ...SOURCED, 1: SOURCED, looks_right: RECORD });
  });

  test('a scale level is confirmed on its own label; the group still speaks for the others', () => {
    const out = confirmLooksRight({ scale_levels: { ...DRAFT, A: SOURCED, B: SOURCED } }, { field: 'scale_levels', part: 'B' }, EDITOR);
    expect(out.scale_levels).toEqual({ ...DRAFT, A: SOURCED, B: { ...SOURCED, looks_right: RECORD } });
    // A level with no label of its own gets one holding the record.
    const bare = confirmLooksRight({ scale_levels: DRAFT }, { field: 'scale_levels', part: 'C' }, EDITOR);
    expect((bare.scale_levels as Record<string, unknown>).C).toEqual({ looks_right: RECORD });
  });
});

describe('an import afterwards holds the item (Q1 = A)', () => {
  test('a confirmed label counts as the coach\'s, at any depth; a drafted one does not', () => {
    expect(isInAppEditLabel({ ...SOURCED, looks_right: RECORD })).toBe(true);
    expect(isInAppEditLabel({ ...DRAFT, looks_right: RECORD })).toBe(false);
    expect(isInAppEditLabel(SOURCED)).toBe(false);
    const found = findInAppEditLabels({ purpose: DRAFT, scale_levels: { ...DRAFT, B: { ...SOURCED, looks_right: RECORD } } });
    expect(found.map((label) => label.path)).toEqual(['scale_levels.B']);
  });

  test('the record itself is not read as a label', () => {
    expect(findInAppEditLabels({ purpose: { ...SOURCED, looks_right: { ...RECORD, draft: undefined } } }).map((label) => label.path)).toEqual(['purpose']);
  });
});

// editLibraryDrill against a stand-in database that answers each statement by its text.
describe('editLibraryDrill with looks_right', () => {
  const HEAD = { drill_id: 'd1', lineage_id: 'lin-1', version: 1, superseded_at: null, name: 'Jab', category: 'footwork', purpose: 'Old.' };
  let fieldLabels: Record<string, unknown> | null;
  let scaleRows: { scale_level: string; drill_id: string }[];
  let statements: { text: string; values: unknown[] }[];

  beforeEach(() => {
    fieldLabels = { purpose: DRAFT, cues: SOURCED, scale_levels: { ...DRAFT, A: SOURCED } };
    scaleRows = [{ scale_level: 'A', drill_id: 'd1' }];
    statements = [];
    (withTransaction as jest.Mock).mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn({
      query: async (text: string, values: unknown[] = []) => {
        statements.push({ text, values });
        if (/from pilot\.drill_library d\s+where/.test(text) && text.includes('for update')) return { rows: [{ row: HEAD }] };
        if (text.includes('pilot.drill_scale_levels t')) return { rows: scaleRows.map((row) => ({ row })) };
        if (text.includes("to_regclass('pilot.content_record_labels')")) return { rows: [{ ready: true }] };
        if (text.includes('select field_labels, evidence, backbone_version')) {
          return { rows: fieldLabels ? [{ field_labels: fieldLabels, evidence: { e: 1 }, backbone_version: 'bb-1' }] : [] };
        }
        return { rows: [] };
      },
    }));
  });

  afterEach(() => jest.clearAllMocks());

  const press = (looks_right: string) => editLibraryDrill({
    organizationId: 'org-1', request: parseDrillLibraryEdit({ drill_id: 'd1', looks_right }), actorAccountId: 'acct-coach', actorRole: 'coach',
  });
  const labelInsert = () => statements.find((s) => s.text.includes('insert into pilot.content_record_labels'));
  const versionInsert = () => statements.find((s) => s.text.includes('insert into pilot.drill_library'));

  test('a drafted field: the next version with no content change, its labels confirmed, an audit row naming it', async () => {
    const result = await press('purpose');
    expect(result).toMatchObject({ changed: true, version: 2, edited: [], looks_right: 'purpose' });
    // The new row is the head copied with identity only: no content key in the patch.
    const patch = JSON.parse(versionInsert()?.values[2] as string);
    expect(Object.keys(patch).sort()).toEqual(['created_by_account_id', 'created_by_role', 'drill_id', 'supersedes_drill_id', 'version']);
    const values = labelInsert()?.values ?? [];
    expect(values.slice(0, 4)).toEqual(['org-1', 'drill', 'lin-1', 2]);
    const written = JSON.parse(values[4] as string);
    expect(written.purpose).toEqual({ ...SOURCED, looks_right: { by_account_id: 'acct-coach', by_role: 'coach', at: expect.any(String) } });
    expect(written.scale_levels).toEqual({ ...DRAFT, A: SOURCED });
    expect(JSON.parse(values[5] as string)).toEqual({ e: 1 });
    expect(values[6]).toBe('bb-1');
    expect(values[7]).toMatch(/^looks-right:/);
    expect(writePilotAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ details: expect.objectContaining({ action: 'in_app_edit', looks_right: 'purpose', edited: [] }) }),
      expect.anything(),
    );
  });

  test('a scale level the drill has, drafted through its group, is confirmed on its own label', async () => {
    await press('scale_levels.A');
    const written = JSON.parse(labelInsert()?.values[4] as string);
    expect(written.scale_levels).toEqual({ ...DRAFT, A: { ...SOURCED, looks_right: expect.objectContaining({ by_role: 'coach' }) } });
  });

  // Q-PR4-1 = A, the edit writer's rule: a confirmed level counts as an edited level counts.
  test.each([
    ['confirmed by a coach', { ...SOURCED, looks_right: RECORD }, false],
    ['neither edited nor confirmed', SOURCED, true],
  ])('an edit of level A while level B is %s: the group keeps its draft only if B is still unreviewed', async (_case, levelB, groupStaysDraft) => {
    scaleRows = [{ scale_level: 'A', drill_id: 'd1' }, { scale_level: 'B', drill_id: 'd1' }];
    fieldLabels = { scale_levels: { ...DRAFT, A: SOURCED, B: levelB } };
    await editLibraryDrill({
      organizationId: 'org-1', actorAccountId: 'acct-coach', actorRole: 'coach',
      request: parseDrillLibraryEdit({ drill_id: 'd1', scale_levels: { A: { demand_description: 'Coach A.' } } }),
    });
    const written = JSON.parse(labelInsert()?.values[4] as string);
    expect('draft' in written.scale_levels).toBe(groupStaysDraft);
    expect(written.scale_levels.A).toMatchObject({ status: 'REPORTED', sources: ['In-app edit'] });
    expect(written.scale_levels.B).toEqual(levelB);
  });

  test('the stop-rule list is one press: its rules and their kinds are confirmed together (Q2 = A)', async () => {
    fieldLabels = { stop_rules: { ...DRAFT, 1: SOURCED }, 'stop_rules.rule_kind': { ...SOURCED, 1: DRAFT } };
    await press('stop_rules');
    const written = JSON.parse(labelInsert()?.values[4] as string);
    expect(written.stop_rules).toEqual({ ...SOURCED, 1: SOURCED, looks_right: expect.objectContaining({ by_role: 'coach' }) });
    expect(written['stop_rules.rule_kind']).toEqual({ ...SOURCED, 1: SOURCED, looks_right: expect.objectContaining({ by_role: 'coach' }) });
  });

  test("reads this gym's labels of this version: organization, kind, lineage and version", async () => {
    await press('purpose');
    const read = statements.find((s) => s.text.includes('select field_labels, evidence, backbone_version'));
    expect(read?.text.replace(/\s+/g, ' ')).toContain(
      'where organization_id = $1 and target_kind = $2 and target_lineage_id = $3 and target_version = $4',
    );
    expect(read?.values).toEqual(['org-1', 'drill', 'lin-1', 1]);
  });

  test('a level whose own label is drafted again after a confirmation can be confirmed again', async () => {
    fieldLabels = { scale_levels: { ...SOURCED, A: { ...DRAFT, looks_right: RECORD } } };
    await press('scale_levels.A');
    const written = JSON.parse(labelInsert()?.values[4] as string);
    expect(written.scale_levels.A).toEqual({ ...SOURCED, looks_right: expect.objectContaining({ by_role: 'coach' }) });
  });

  test('a level drafted on its own label is confirmed there: its own draft goes', async () => {
    fieldLabels = { scale_levels: { ...SOURCED, A: DRAFT } };
    await press('scale_levels.A');
    const written = JSON.parse(labelInsert()?.values[4] as string);
    expect(written.scale_levels).toEqual({ ...SOURCED, A: { ...SOURCED, looks_right: expect.objectContaining({ by_role: 'coach' }) } });
  });

  test.each([
    ['its own in-app edit', { by_account_id: 'acct-x', by_role: 'coach', at: '2026-11-19T00:00:00Z' }, 'edited'],
    ['its own earlier "Looks right"', RECORD, 'looks_right'],
  ])('a level with %s under a drafted group is refused (409), and nothing is written', async (_case, record, key) => {
    fieldLabels = { scale_levels: { ...DRAFT, A: { ...SOURCED, [key]: record } } };
    await expect(press('scale_levels.A')).rejects.toMatchObject({ status: 409, code: 'FIELD_NOT_DRAFT' });
    expect(versionInsert()).toBeUndefined();
  });

  test.each([
    ['labelled and not a draft', 'cues'],
    ['with no label of its own', 'transfer'],
  ])('a field %s is refused (409 FIELD_NOT_DRAFT) before anything is written', async (_case, field) => {
    await expect(press(field)).rejects.toMatchObject({ status: 409, code: 'FIELD_NOT_DRAFT' });
    expect(versionInsert()).toBeUndefined();
    expect(labelInsert()).toBeUndefined();
  });

  test('a version with no label row: nothing is labelled a draft, so nothing can be confirmed', async () => {
    fieldLabels = null;
    await expect(press('purpose')).rejects.toMatchObject({ status: 409, code: 'FIELD_NOT_DRAFT' });
    expect(versionInsert()).toBeUndefined();
  });

  test('a scale level the drill does not have is refused (400)', async () => {
    await expect(press('scale_levels.B')).rejects.toMatchObject({ status: 400 });
    expect(versionInsert()).toBeUndefined();
  });
});

// editWorkoutTemplate against the same kind of stand-in: the labels read are the CURRENT version's.
describe('editWorkoutTemplate with looks_right', () => {
  const HEAD = { template_id: 't2', lineage_id: 'lin-t', version: 2, superseded_at: null, active: true, name: 'Monday', intent: 'Old.' };
  let fieldLabels: Record<string, unknown>;
  let statements: { text: string; values: unknown[] }[];

  beforeEach(() => {
    fieldLabels = { intent: DRAFT, name: SOURCED };
    statements = [];
    (withTransaction as jest.Mock).mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn({
      query: async (text: string, values: unknown[] = []) => {
        statements.push({ text, values });
        if (text.includes('from pilot.workout_templates t') && text.includes('for update')) return { rows: [{ row: HEAD }] };
        if (text.includes('max(version)')) return { rows: [{ max_version: 2 }] };
        if (text.includes("to_regclass('pilot.content_record_labels')")) return { rows: [{ ready: true }] };
        if (text.includes('select field_labels, evidence, backbone_version')) return { rows: [{ field_labels: fieldLabels, evidence: null, backbone_version: null }] };
        return { rows: [] };
      },
    }));
  });

  afterEach(() => jest.clearAllMocks());

  const press = (looks_right: string) => editWorkoutTemplate({
    organizationId: 'org-1', request: parseWorkoutTemplateEdit({ template_id: 't2', looks_right }), actorAccountId: 'acct-coach', actorRole: 'coach',
  });

  test('a press on version 2 reads version 2\'s labels and writes version 3, its label confirmed', async () => {
    const result = await press('intent');
    expect(result).toMatchObject({ changed: true, version: 3, edited: [], looks_right: 'intent' });
    const read = statements.find((s) => s.text.includes('select field_labels, evidence, backbone_version'));
    expect(read?.values).toEqual(['org-1', 'workout_template', 'lin-t', 2]);
    const insert = statements.find((s) => s.text.includes('insert into pilot.content_record_labels'));
    expect(insert?.values.slice(0, 4)).toEqual(['org-1', 'workout_template', 'lin-t', 3]);
    expect(JSON.parse(insert?.values[4] as string).intent).toEqual({ ...SOURCED, looks_right: expect.objectContaining({ by_role: 'coach' }) });
  });

  test('a field that is not a draft is refused (409) before anything is written', async () => {
    await expect(press('name')).rejects.toMatchObject({ status: 409, code: 'FIELD_NOT_DRAFT' });
    expect(statements.some((s) => s.text.includes('insert into pilot.workout_templates'))).toBe(false);
  });
});
