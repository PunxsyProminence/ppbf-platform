import type { PilotRole } from './contracts';
import {
  ASKER_QUESTION_COACH_SENTENCE,
  isAskerFiledQuestion,
  readsWholeResearchRows,
  readsWholeResearchSubmissions,
  researchRequirementsForReader,
  researchSubmissionsForReader,
  toFamilyResearchRequirement,
  toFamilyResearchSubmission,
  wholeResearchRowFor,
} from './researchFamilyView';
import type { ShadowResearchRequirementRow } from './shadowResearch';
import type { ResearchSubmissionRow } from './shadowResearchSubmissions';

const COACH_ID = 'coach.one@gym.example.test';
const ADMIN_ID = 'admin.one@gym.example.test';

function requirement(overrides: Partial<ShadowResearchRequirementRow> = {}): ShadowResearchRequirementRow {
  return {
    research_requirement_id: 7,
    organization_id: 'org-1',
    source_event_name: 'SHADOW_INTAKE_CASE_APPROVED',
    source_entity_type: 'intake_case',
    source_entity_id: 'case-1',
    research_requirement: 'Review approved intake case',
    knowledge_gap: 'Confirm against Library evidence',
    evidence_label: 'ath-1',
    source_status: 'observed',
    source_confidence_tier: 'SUFFICIENT_FOR_REVIEW',
    source_verification_state: 'unknown',
    status: 'resolved',
    created_by_account_id: COACH_ID,
    created_by_role: 'coach',
    metadata: {
      action: 'approve',
      notes: 'Reviewer note about the family.',
      athlete_id: 'ath-1',
      closing_note: 'Closed after the coach meeting.',
      closing_submission_id: 'sub-1',
      resolved_by_account_id: ADMIN_ID,
      resolved_by_role: 'organization_admin',
    },
    created_at: '2026-10-01T00:00:00.000Z',
    resolved_at: '2026-10-02T00:00:00.000Z',
    subject_id: 'ath-1',
    ...overrides,
  };
}

function submission(overrides: Partial<ResearchSubmissionRow> = {}): ResearchSubmissionRow {
  return {
    organization_id: 'org-1',
    submission_id: 'sub-1',
    research_requirement_id: 7,
    source_id: 'src-1',
    document_id: 'doc-1',
    provenance: { provider: 'Penn State library' },
    submission_note: 'Curator note.',
    applicability_state: 'responsive',
    reviewed_by_account_id: ADMIN_ID,
    reviewed_at: '2026-10-02T00:00:00.000Z',
    review_note: 'Reviewer note.',
    submitted_by_account_id: ADMIN_ID,
    created_at: '2026-10-01T00:00:00.000Z',
    updated_at: '2026-10-02T00:00:00.000Z',
    ...overrides,
  };
}

describe('who reads research rows whole', () => {
  test.each(['coach', 'organization_admin', 'admin'] as const)('%s does', (role) => {
    expect(readsWholeResearchRows(role)).toBe(true);
  });

  test.each(['athlete', 'parent', 'volunteer', 'staff', 'board', 'platform_owner'] as const)('%s does not', (role) => {
    expect(readsWholeResearchRows(role)).toBe(false);
  });

  test('a role this code does not know, an empty one and a missing one do not', () => {
    expect(readsWholeResearchRows('head_coach' as PilotRole)).toBe(false);
    expect(readsWholeResearchRows('COACH' as PilotRole)).toBe(false);
    expect(readsWholeResearchRows('' as PilotRole)).toBe(false);
    expect(readsWholeResearchRows(undefined)).toBe(false);
    expect(readsWholeResearchRows(null)).toBe(false);
  });

  test('the platform shelf opens submissions to the platform owner and to nobody else', () => {
    expect(readsWholeResearchSubmissions('platform_owner', true)).toBe(true);
    expect(readsWholeResearchSubmissions('platform_owner', false)).toBe(false);
    for (const role of ['athlete', 'parent', 'volunteer', 'staff', 'board'] as const) {
      expect(readsWholeResearchSubmissions(role, true)).toBe(false);
    }
    expect(readsWholeResearchSubmissions(undefined, true)).toBe(false);
    expect(readsWholeResearchSubmissions('coach', false)).toBe(true);
  });
});

describe('the family view of a requirement', () => {
  test('is exactly the named fields', () => {
    expect(toFamilyResearchRequirement({ accountId: 'acct-guardian-a' }, requirement())).toEqual({
      research_requirement_id: 7,
      source_event_name: 'SHADOW_INTAKE_CASE_APPROVED',
      research_requirement: 'Review approved intake case',
      knowledge_gap: 'Confirm against Library evidence',
      source_status: 'observed',
      source_confidence_tier: 'SUFFICIENT_FOR_REVIEW',
      source_verification_state: 'unknown',
      status: 'resolved',
      created_at: '2026-10-01T00:00:00.000Z',
      resolved_at: '2026-10-02T00:00:00.000Z',
      is_mine: false,
      metadata: { closing_note: 'Closed after the coach meeting.' },
    });
  });

  test('carries no account id, however the row holds one', () => {
    const view = toFamilyResearchRequirement({ accountId: 'acct-guardian-a' }, requirement());
    const text = JSON.stringify(view);
    expect(text).not.toContain(COACH_ID);
    expect(text).not.toContain(ADMIN_ID);
    expect(text).not.toContain('Reviewer note about the family.');
  });

  test('a metadata key a later writer adds does not ride along', () => {
    const view = toFamilyResearchRequirement(
      { accountId: 'acct-guardian-a' },
      requirement({ metadata: { closing_note: 'ok', assigned_to_account_id: COACH_ID } }),
    );
    expect(view.metadata).toEqual({ closing_note: 'ok' });
  });

  test('is_mine is true only for the account that filed the row', () => {
    expect(toFamilyResearchRequirement({ accountId: 'acct-athlete' }, requirement({ created_by_account_id: 'acct-athlete' })).is_mine).toBe(true);
    expect(toFamilyResearchRequirement({ accountId: 'acct-athlete' }, requirement({ created_by_account_id: 'ACCT-ATHLETE' })).is_mine).toBe(false);
  });

  test('an open row carries no closing note, whatever its metadata holds', () => {
    const view = toFamilyResearchRequirement(
      { accountId: 'acct-guardian-a' },
      requirement({ status: 'open', resolved_at: null, metadata: { closing_note: 'planted at create' } }),
    );
    expect(view.metadata).toEqual({ closing_note: null });
  });

  test('a closing note that is not text is sent as null', () => {
    for (const closingNote of [null, 5, { text: COACH_ID }, [COACH_ID]]) {
      const view = toFamilyResearchRequirement(
        { accountId: 'acct-guardian-a' },
        requirement({ metadata: { closing_note: closingNote } }),
      );
      expect(view.metadata).toEqual({ closing_note: null });
    }
    expect(
      toFamilyResearchRequirement(
        { accountId: 'acct-guardian-a' },
        requirement({ metadata: null as unknown as Record<string, unknown> }),
      ).metadata,
    ).toEqual({ closing_note: null });
  });
});

describe('the family view of a submission', () => {
  test('is exactly the named fields', () => {
    expect(toFamilyResearchSubmission(submission())).toEqual({
      submission_id: 'sub-1',
      research_requirement_id: 7,
      applicability_state: 'responsive',
      created_at: '2026-10-01T00:00:00.000Z',
      reviewed_at: '2026-10-02T00:00:00.000Z',
    });
  });
});

describe('by reader', () => {
  const rows = [requirement()];
  const submissions = [submission()];

  test.each(['coach', 'organization_admin', 'admin'] as const)('%s receives the stored rows themselves', (role) => {
    expect(researchRequirementsForReader({ accountId: COACH_ID, role }, rows)).toBe(rows);
    expect(researchSubmissionsForReader({ role }, submissions, false)).toBe(submissions);
  });

  test.each(['athlete', 'parent', 'volunteer', 'staff', 'board', 'platform_owner', 'head_coach', undefined] as const)(
    '%s receives the family view',
    (role) => {
      const reader = { accountId: 'acct-reader', role: role as PilotRole };
      expect(researchRequirementsForReader(reader, rows)).toEqual([toFamilyResearchRequirement(reader, rows[0])]);
      expect(researchSubmissionsForReader(reader, submissions, false)).toEqual([toFamilyResearchSubmission(submissions[0])]);
    },
  );

  test('the platform owner receives platform-shelf submissions whole and gym-shelf ones in the family view', () => {
    expect(researchSubmissionsForReader({ role: 'platform_owner' }, submissions, true)).toBe(submissions);
    expect(researchSubmissionsForReader({ role: 'platform_owner' }, submissions, false)).toEqual([
      toFamilyResearchSubmission(submissions[0]),
    ]);
    expect(researchSubmissionsForReader({ role: 'parent' }, submissions, true)).toEqual([
      toFamilyResearchSubmission(submissions[0]),
    ]);
  });
});

// F-054, Jason 2026-10-13 "A: Office + asker (Recommended)": an athlete's or
// parent's unanswered question is read by the organization admin and the
// asker; a coach sees only that a question went unanswered.
describe('an asker-filed unanswered question', () => {
  const WORDS = 'my coach hits me and i am scared to go';
  const ASKER = 'athlete.one@gym.example.test';
  const asked = (overrides: Partial<ShadowResearchRequirementRow> = {}) => requirement({
    source_event_name: 'shadow_unanswered_question',
    source_entity_type: 'shadow_question',
    source_entity_id: `acct:${ASKER}:0123abcd`,
    research_requirement: 'My coach hits me and I am scared to go to the gym',
    knowledge_gap: 'No verified Library evidence matched this question in SHADOW.',
    evidence_label: null,
    status: 'open',
    created_by_account_id: ASKER,
    created_by_role: 'athlete',
    metadata: { asked_in: 'shadow', auto_filed: true },
    ...overrides,
  });

  test('is recognized by its event and a non-staff filer, not by metadata', () => {
    expect(isAskerFiledQuestion(asked())).toBe(true);
    expect(isAskerFiledQuestion(asked({ created_by_role: 'parent' }))).toBe(true);
    expect(isAskerFiledQuestion(asked({ created_by_role: 'coach' }))).toBe(false);
    expect(isAskerFiledQuestion(asked({ created_by_role: 'organization_admin' }))).toBe(false);
    expect(isAskerFiledQuestion(asked({ source_event_name: 'SHADOW_INTAKE_CASE_APPROVED' }))).toBe(false);
    expect(isAskerFiledQuestion(asked({ metadata: {} }))).toBe(true);
  });

  test('a coach receives the row without the words, the key or the asker', () => {
    const [row] = researchRequirementsForReader({ accountId: COACH_ID, role: 'coach' }, [asked()]);
    const text = JSON.stringify(row);
    expect(text).not.toContain('scared');
    expect(text).not.toContain(ASKER);
    expect(text).not.toContain('acct:');
    expect(row).toMatchObject({
      research_requirement_id: 7,
      status: 'open',
      research_requirement: ASKER_QUESTION_COACH_SENTENCE,
      knowledge_gap: ASKER_QUESTION_COACH_SENTENCE,
    });
  });

  test('the organization admin and admin receive it whole', () => {
    for (const role of ['organization_admin', 'admin'] as const) {
      const [row] = researchRequirementsForReader({ accountId: ADMIN_ID, role }, [asked()]);
      expect(row).toMatchObject({ research_requirement: 'My coach hits me and I am scared to go to the gym', created_by_account_id: ASKER });
    }
  });

  test('the asker reads their own words through the family view, with no account id', () => {
    const [row] = researchRequirementsForReader({ accountId: ASKER, role: 'athlete' }, [asked()]);
    expect(row).toMatchObject({ research_requirement: 'My coach hits me and I am scared to go to the gym', is_mine: true });
    expect(JSON.stringify(row)).not.toContain(ASKER);
  });

  test('a coach own filing stays whole for another coach', () => {
    const own = asked({ created_by_role: 'coach', created_by_account_id: COACH_ID });
    expect(wholeResearchRowFor('coach', own)).toBe(own);
  });

  test('a closed asker row keeps its closing note for the coach', () => {
    const closed = asked({ status: 'resolved', metadata: { closing_note: 'Answered in the Library.', auto_filed: true } });
    const row = wholeResearchRowFor('coach', closed);
    expect(row.metadata).toEqual({ closing_note: 'Answered in the Library.' });
    expect(Object.keys(row).sort()).not.toContain('created_by_role_kind');
  });
});
