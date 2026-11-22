// The per-field AI-draft read for coaches and admins (lane U2-6e; OW25-57,
// OD-2026-11-19-012: "Coaches and admins only (OW25-54)" -- athletes and
// parents see no AI-draft line). Overwatch's 6e answer Q1 = A, 2026-11-19:
// getDrillWithDetail carries `field_drafts` for the four fields a session plan
// falls back to; null means "draft status not checked", never "no mark"; and
// the athlete projection and the athlete and parent responses carry no
// `field_drafts` key.
//
// The database is a stand-in that answers by table, so the real read
// functions and the real GET /api/pilot/drill-library handler run. The handler
// is imported from here, not tested beside it, so this lane changes no
// app/api file.

jest.mock('./db', () => ({ query: jest.fn(), queryOne: jest.fn() }));

jest.mock('./http', () => {
  const actual = jest.requireActual('./http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('./drillFloorValidations', () => ({ listFloorValidations: jest.fn(async () => ({})) }));
jest.mock('./drillGroundingEvidence', () => ({ resolveDrillGroundingEvidence: jest.fn(async () => []) }));

import { NextRequest } from 'next/server';

import { GET } from '@/app/api/pilot/drill-library/route';
import type { PilotPrincipal } from './auth';
import type { PilotRole } from './contracts';
import { query, queryOne } from './db';
import {
  DRILL_MARKED_FIELDS,
  drillFieldDrafts,
  getAthleteDrillDetail,
  getAthleteDrillDetailForOpenWork,
  getDrillWithDetail,
} from './drillLibraryV3';
import { requirePrincipal } from './http';
import { resolveAssignmentDrillInstruction } from './assignmentDrillInstruction';

const mockQuery = query as jest.Mock;
const mockQueryOne = queryOne as jest.Mock;
const mockRequirePrincipal = requirePrincipal as jest.Mock;

const AI_DRAFT = { status: 'INFERRED', sources: ['Claude research draft'], draft: 'AI draft' };
const IN_APP_EDIT = { status: 'REPORTED', sources: ['In-app edit'], edited: { by_account_id: 'acct-9', by_role: 'coach', at: '2026-11-19T00:00:00Z' } };
// Every field the drill screen marks, unknown: what nothing recorded must read as (lane ED-UI PR3).
const ALL_NOT_CHECKED = Object.fromEntries(DRILL_MARKED_FIELDS.map((field) => [field, null]));

const DRILL_ROW = {
  organization_id: 'org-1',
  drill_id: 'ref-1',
  lineage_id: 'lin-1',
  version: 3,
  supersedes_drill_id: null,
  superseded_at: null,
  name: 'Catch and return',
  discipline: 'boxing',
  category: 'defense',
  difficulty: 'beginner',
  skill_id: null,
  target_behavior: '',
  purpose: 'Catch the jab.',
  standard_setup: 'Pairs.',
  execution: 'Catch, return.',
  what_good_looks_like: 'Glove meets the punch.',
  what_bad_looks_like: 'Reaching.',
  common_errors: '',
  corrections: 'Catch earlier.',
  transfer: '',
  exit_condition: '',
  correction_path: '',
  contact_level: 'light',
  equipment_needed: 'gloves',
  requires_coach_authorization: false,
  content_class: 'reference',
  source_ref: null,
  grounding_claim_ids: [],
  field_provenance: 'INFERRED',
  active: true,
  created_by_account_id: 'acct-staff-1',
  created_by_role: 'coach',
  created_at: '2026-11-01T00:00:00Z',
  updated_at: '2026-11-01T00:00:00Z',
};

let labelsRow: { field_labels: unknown } | null;
let scaleRows: Array<{ scale_level: string }> = [];
let labelsError: (Error & { code?: string }) | null;
const sqlSeen: string[] = [];

function answer(text: string): unknown[] {
  sqlSeen.push(text);
  if (text.includes('pilot.content_record_labels')) {
    if (labelsError) throw labelsError;
    return labelsRow ? [labelsRow] : [];
  }
  if (text.includes('from pilot.drill_scale_levels')) return scaleRows;
  if (text.includes('from pilot.drill_library')) return [DRILL_ROW];
  if (/from pilot\.drills\s/.test(text)) {
    return [{ organization_id: 'org-1', drill_id: 'op-1', reference_drill_id: 'ref-1', active: true }];
  }
  return [];
}

beforeEach(() => {
  labelsRow = {
    field_labels: {
      cues: AI_DRAFT,
      what_good_looks_like: AI_DRAFT,
      what_bad_looks_like: IN_APP_EDIT,
      // corrections: no label at all
    },
  };
  labelsError = null;
  scaleRows = [];
  sqlSeen.length = 0;
  mockQuery.mockImplementation(async (text: string) => answer(text));
  mockQueryOne.mockImplementation(async (text: string) => answer(text)[0] ?? null);
});

afterEach(() => {
  jest.clearAllMocks();
});

describe('drillFieldDrafts: which of the four fields still carry an AI-draft label', () => {
  test('a label with a draft key is a draft; an in-app edit is not; a field with no label is not checked', () => {
    expect(drillFieldDrafts({ cues: AI_DRAFT, what_good_looks_like: IN_APP_EDIT })).toMatchObject({
      cues: true,
      what_good_looks_like: false,
      what_bad_looks_like: null,
      corrections: null,
    });
  });

  test('a part label carrying draft makes its field a draft, even when the group label is not one', () => {
    expect(drillFieldDrafts({ corrections: { ...IN_APP_EDIT, 2: AI_DRAFT } }).corrections).toBe(true);
    expect(drillFieldDrafts({ corrections: { ...IN_APP_EDIT, 2: IN_APP_EDIT } }).corrections).toBe(false);
  });

  // "A version written without labels has no row here" (content_labels migration): most seeded
  // drills, drafts among them, have no row. Nothing recorded is unknown, never "not a draft".
  test('no labels recorded for the version: every field is "not checked" (null), never false', () => {
    expect(drillFieldDrafts(null)).toMatchObject({ ...{ cues: null, what_good_looks_like: null, what_bad_looks_like: null, corrections: null }, labelled: false });
    expect(drillFieldDrafts(undefined)).toMatchObject({ ...{ cues: null, what_good_looks_like: null, what_bad_looks_like: null, corrections: null }, labelled: false });
  });

  test('a shape the reader does not know answers "not checked" (null), never false', () => {
    expect(drillFieldDrafts('cues')).toMatchObject({ cues: null, what_good_looks_like: null, what_bad_looks_like: null, corrections: null });
    expect(drillFieldDrafts({ cues: 'draft' }).cues).toBeNull();
    expect(drillFieldDrafts({ cues: ['draft'] }).cues).toBeNull();
  });
});

// Lane ED-UI PR3 (plan item 4; Q2 = A, Q4 = A): every field the drill screen shows, and each scale level.
describe('drillFieldDrafts: every shown field and each scale level (lane ED-UI PR3)', () => {
  test('reads every field the drill screen shows, by its label key, with the 6e rule', () => {
    const drafts = drillFieldDrafts({ name: AI_DRAFT, difficulty: IN_APP_EDIT, purpose: AI_DRAFT, transfer: IN_APP_EDIT });
    expect(drafts).toMatchObject({ name: true, difficulty: false, purpose: true, transfer: false, category: null, labelled: true });
  });

  test('the drill\'s own stop-rule list is one unit: a drafted kind makes the list a draft', () => {
    expect(drillFieldDrafts({ stop_rules: IN_APP_EDIT }).stop_rules).toBe(false);
    expect(drillFieldDrafts({ stop_rules: IN_APP_EDIT, 'stop_rules.rule_kind': AI_DRAFT }).stop_rules).toBe(true);
    expect(drillFieldDrafts({ 'stop_rules.rule_kind': AI_DRAFT }).stop_rules).toBe(true);
  });

  // writeEditedVersionLabels: "a version with no labels gets one holding only the edited parts".
  // The edit speaks for its part only; the field's other parts are unknown, never "not a draft".
  test('a field holding only part labels (an edit of an unlabelled version) is not checked, unless a part is a draft', () => {
    expect(drillFieldDrafts({ stop_rules: { 2: IN_APP_EDIT } }).stop_rules).toBeNull();
    expect(drillFieldDrafts({ corrections: { 1: IN_APP_EDIT } }).corrections).toBeNull();
    expect(drillFieldDrafts({ stop_rules: { 1: IN_APP_EDIT, 2: AI_DRAFT } }).stop_rules).toBe(true);
    // The writer's own "every part edited" case gives the group the edit's label: then it is not a draft.
    expect(drillFieldDrafts({ stop_rules: { ...IN_APP_EDIT, 1: IN_APP_EDIT, 2: IN_APP_EDIT } }).stop_rules).toBe(false);
  });

  test('a label of its own means a status, or an in-app edit record: an edit field that is not a record is unknown', () => {
    expect(drillFieldDrafts({ purpose: { edited: 'yes' } }).purpose).toBeNull();
    expect(drillFieldDrafts({ purpose: { sources: ['DOC-1'] } }).purpose).toBeNull();
    expect(drillFieldDrafts({ purpose: { edited: IN_APP_EDIT.edited } }).purpose).toBe(false);
    expect(drillFieldDrafts({ purpose: { status: 'INFERRED' } }).purpose).toBe(false);
  });

  // Q-PR4-1 = A (Overwatch on #2027, 2026-11-20): "`looks_right` counts as `edited` counts in all three rules."
  test('a coach\'s "Looks right" counts as an edit counts: on a level, and as a field\'s own label', () => {
    const SOURCED = { status: 'INFERRED', sources: ['DOC-027'] };
    const LOOKS_RIGHT = { by_account_id: 'acct-9', by_role: 'coach', at: '2026-11-20T00:00:00Z' };
    // A confirmed level under a drafted group is not a draft; the level nobody confirmed still is.
    expect(drillFieldDrafts({ scale_levels: { ...AI_DRAFT, A: { ...SOURCED, looks_right: LOOKS_RIGHT }, B: SOURCED } }, ['A', 'B']).scale_levels)
      .toEqual({ A: false, B: true });
    // Drafted again on its own label, it is a draft again; a record that is not a record does not count.
    expect(drillFieldDrafts({ scale_levels: { ...AI_DRAFT, A: { ...AI_DRAFT, looks_right: LOOKS_RIGHT } } }, ['A']).scale_levels).toEqual({ A: true });
    expect(drillFieldDrafts({ scale_levels: { ...AI_DRAFT, A: { ...SOURCED, looks_right: 'yes' } } }, ['A']).scale_levels).toEqual({ A: true });
    // A field whose own label is the confirmation alone is labelled and not a draft, never "not checked".
    expect(drillFieldDrafts({ purpose: { looks_right: LOOKS_RIGHT } }).purpose).toBe(false);
    expect(drillFieldDrafts({ purpose: { looks_right: 'yes' } }).purpose).toBeNull();
    // A group holding only a confirmed level, with no label of its own: the other levels are not checked.
    expect(drillFieldDrafts({ scale_levels: { A: { looks_right: LOOKS_RIGHT } } }, ['A', 'B']).scale_levels).toEqual({ A: false, B: null });
  });

  test('a scale level whose own label is not a label (a string, a list) is not checked, whatever its group says', () => {
    const labels = { scale_levels: { ...AI_DRAFT, A: 'edited', B: ['draft'] } };
    expect(drillFieldDrafts(labels, ['A', 'B']).scale_levels).toEqual({ A: null, B: null });
  });

  test('a scale level: its own draft or edit wins; a sourcing-only label speaks with its drafted group', () => {
    const SOURCED = { status: 'INFERRED', sources: ['DOC-027'] };
    const labels = { scale_levels: { ...AI_DRAFT, A: SOURCED, B: IN_APP_EDIT, C: { ...SOURCED, draft: 'AI draft' } } };
    expect(drillFieldDrafts(labels, ['A', 'B', 'C', 'D']).scale_levels).toEqual({ A: true, B: false, C: true, D: true });
    // A group with only an edited part and no group label: the untouched levels are not checked.
    expect(drillFieldDrafts({ scale_levels: { A: IN_APP_EDIT } }, ['A', 'B']).scale_levels).toEqual({ A: false, B: null });
    // A group labelled and not a draft: an untouched level is not one either.
    expect(drillFieldDrafts({ scale_levels: { ...IN_APP_EDIT, A: SOURCED } }, ['A']).scale_levels).toEqual({ A: false });
    expect(drillFieldDrafts(null, ['A']).scale_levels).toEqual({ A: null });
  });
});

describe('getDrillWithDetail carries field_drafts for the version it read', () => {
  test('reads the labels of this version (kind drill, its lineage and version) and answers per field', async () => {
    const detail = await getDrillWithDetail('org-1', 'ref-1');
    expect(detail?.field_drafts).toMatchObject({
      cues: true,
      what_good_looks_like: true,
      what_bad_looks_like: false,
      corrections: null,
      labelled: true,
    });
    const labelsCall = mockQueryOne.mock.calls.find(([text]) => String(text).includes('pilot.content_record_labels'));
    expect(String(labelsCall?.[0]).replace(/\s+/g, ' ')).toContain(
      "where organization_id = $1 and target_kind = 'drill' and target_lineage_id = $2 and target_version = $3",
    );
    expect(labelsCall?.[1]).toEqual(['org-1', 'lin-1', 3]);
  });

  test('each of this version\'s own scale levels gets its own state (lane ED-UI PR3)', async () => {
    scaleRows = [{ scale_level: 'A' }, { scale_level: 'B' }];
    labelsRow = { field_labels: { scale_levels: { ...AI_DRAFT, A: IN_APP_EDIT } } };
    const detail = await getDrillWithDetail('org-1', 'ref-1');
    expect(detail?.field_drafts?.scale_levels).toEqual({ A: false, B: true });
  });

  test('a version with no label row: every field "not checked", not "not a draft"', async () => {
    labelsRow = null;
    scaleRows = [{ scale_level: 'A' }];
    const detail = await getDrillWithDetail('org-1', 'ref-1');
    expect(detail?.field_drafts).toEqual({ ...ALL_NOT_CHECKED, scale_levels: { A: null }, labelled: false });
  });

  test('before the labels table exists (42P01): every field is "not checked", and nothing is logged', async () => {
    labelsError = Object.assign(new Error('relation "pilot.content_record_labels" does not exist'), { code: '42P01' });
    const log = jest.spyOn(console, 'error').mockImplementation(() => {});
    const detail = await getDrillWithDetail('org-1', 'ref-1');
    // No table: no version has a row (Q4 = A: one "not checked" line under the header).
    expect(detail?.field_drafts).toEqual({ ...ALL_NOT_CHECKED, scale_levels: {}, labelled: false });
    expect(detail?.name).toBe('Catch and return');
    expect(log).not.toHaveBeenCalled();
    log.mockRestore();
  });

  test('a failed labels read: "not checked" for every field, logged without its text, and the drill still answers', async () => {
    labelsError = Object.assign(new Error('connection reset'), { code: '08006' });
    const log = jest.spyOn(console, 'error').mockImplementation(() => {});
    const detail = await getDrillWithDetail('org-1', 'ref-1');
    expect(detail?.field_drafts).toEqual({ ...ALL_NOT_CHECKED, scale_levels: {}, labelled: null });
    expect(detail?.what_good_looks_like).toBe('Glove meets the punch.');
    expect(log).toHaveBeenCalledWith({ event: 'drill-field-drafts-read-failed', drill_id: 'ref-1', code: '08006' });
    log.mockRestore();
  });
});

describe('athletes and parents never receive field_drafts', () => {
  test('the athlete projections carry no field_drafts key and never read the labels table', async () => {
    const learn = await getAthleteDrillDetail('org-1', 'ref-1');
    const openWork = await getAthleteDrillDetailForOpenWork('org-1', 'ref-1');
    expect(learn).not.toBeNull();
    expect(openWork).not.toBeNull();
    expect(learn).not.toHaveProperty('field_drafts');
    expect(openWork).not.toHaveProperty('field_drafts');
    expect(sqlSeen.some((text) => text.includes('pilot.content_record_labels'))).toBe(false);
  });

  function principal(role: PilotRole): PilotPrincipal {
    return {
      accountId: 'acct-1',
      role,
      organizationId: 'org-1',
      athleteId: null,
      sessionToken: 'token',
      authProvider: 'microsoft',
    } as PilotPrincipal;
  }

  async function readDetail(role: PilotRole): Promise<{ status: number; text: string; body: { drill?: Record<string, unknown> } }> {
    mockRequirePrincipal.mockResolvedValue(principal(role));
    const response = await GET(new NextRequest('http://localhost/api/pilot/drill-library?drill_id=ref-1'));
    const text = await response.text();
    return { status: response.status, text, body: JSON.parse(text) };
  }

  test('positive control: a coach and an organization admin DO receive field_drafts from the same route and rows', async () => {
    for (const role of ['coach', 'organization_admin'] as const) {
      const { status, body } = await readDetail(role);
      expect(status).toBe(200);
      expect(body.drill?.field_drafts).toMatchObject({
        cues: true,
        what_good_looks_like: true,
        what_bad_looks_like: false,
        corrections: null,
        labelled: true,
      });
    }
  });

  // Lane ED-UI PR3: every other reader the route admits, not only athletes and parents.
  test.each(['athlete', 'parent', 'volunteer', 'staff', 'platform_owner'] as const)('a %s reading the same drill gets no field_drafts anywhere in the response', async (role) => {
    const { status, text, body } = await readDetail(role);
    expect(status).toBe(200);
    expect(body.drill).toBeDefined();
    expect(body.drill).not.toHaveProperty('field_drafts');
    expect(text).not.toContain('field_drafts');
  });

  test('the assignment instruction an athlete or parent opens (athlete audience) carries no field_drafts', async () => {
    const instruction = await resolveAssignmentDrillInstruction('org-1', { drill_id: 'op-1', status: 'assigned' }, 'athlete');
    expect(instruction.state).toBe('available');
    expect(JSON.stringify(instruction)).not.toContain('field_drafts');
    // Positive control: the staff audience of the same assignment does carry it.
    const staff = await resolveAssignmentDrillInstruction('org-1', { drill_id: 'op-1', status: 'assigned' }, 'coach');
    expect(JSON.stringify(staff)).toContain('field_drafts');
  });
});
