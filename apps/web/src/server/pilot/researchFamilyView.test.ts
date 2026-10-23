import type { PilotRole } from './contracts';
import {
  ASKER_QUESTION_COACH_SENTENCE,
  ASKER_QUESTION_NOTE_SENTENCE,
  isAskerFiledQuestion,
  isMemberFiledLearningNote,
  LEARNING_NOTE_COACH_SENTENCE,
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
    expect(researchSubmissionsForReader({ role }, submissions, false, rows[0])).toBe(submissions);
  });

  test.each(['athlete', 'parent', 'volunteer', 'staff', 'board', 'platform_owner', 'head_coach', undefined] as const)(
    '%s receives the family view',
    (role) => {
      const reader = { accountId: 'acct-reader', role: role as PilotRole };
      expect(researchRequirementsForReader(reader, rows)).toEqual([toFamilyResearchRequirement(reader, rows[0])]);
      expect(researchSubmissionsForReader(reader, submissions, false, rows[0])).toEqual([toFamilyResearchSubmission(submissions[0])]);
    },
  );

  test('the platform owner receives platform-shelf submissions whole and gym-shelf ones in the family view', () => {
    expect(researchSubmissionsForReader({ role: 'platform_owner' }, submissions, true, rows[0])).toBe(submissions);
    expect(researchSubmissionsForReader({ role: 'platform_owner' }, submissions, false, rows[0])).toEqual([
      toFamilyResearchSubmission(submissions[0]),
    ]);
    expect(researchSubmissionsForReader({ role: 'parent' }, submissions, true, rows[0])).toEqual([
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

  // Lane L52 (Overwatch 2026-10-18): the closing note is free text a resolver
  // wrote about the question and can quote it, so a coach gets the sentence.
  // It replaces the test that pinned the note through to the coach.
  test('a closed asker row gives the coach the note sentence, not the closing note', () => {
    const closed = asked({
      status: 'resolved',
      metadata: { closing_note: 'Told her the coach was spoken to.', closing_submission_id: 'sub-1', auto_filed: true },
    });
    const row = wholeResearchRowFor('coach', closed);
    expect(row.metadata).toEqual({ closing_note: ASKER_QUESTION_NOTE_SENTENCE, closing_submission_id: 'sub-1' });
    expect(JSON.stringify(row)).not.toContain('spoken to');
    expect(Object.keys(row).sort()).not.toContain('created_by_role_kind');
  });

  test('a row closed by a submission alone carries no closing note for the coach', () => {
    for (const closing_note of [null, '', '   ', 42]) {
      const row = wholeResearchRowFor('coach', asked({ status: 'resolved', metadata: { closing_note, closing_submission_id: 'sub-1' } }));
      expect(row.metadata).toEqual({ closing_submission_id: 'sub-1' });
    }
  });

  test('the organization admin, admin and the asker keep the closing note', () => {
    const closed = asked({ status: 'resolved', metadata: { closing_note: 'Told her the coach was spoken to.' } });
    for (const role of ['organization_admin', 'admin'] as const) {
      expect(wholeResearchRowFor(role, closed)).toBe(closed);
    }
    const [own] = researchRequirementsForReader({ accountId: ASKER, role: 'athlete' }, [closed]);
    expect(own.metadata).toEqual({ closing_note: 'Told her the coach was spoken to.' });
  });

  test('an ordinary row keeps its closing note for the coach', () => {
    const ordinary = requirement();
    expect(wholeResearchRowFor('coach', ordinary)).toBe(ordinary);
  });

  describe('its submissions', () => {
    const noted = [
      submission({ submission_note: 'Source on what to do when a coach hits a kid.', review_note: 'Covers her question.' }),
      submission({ submission_id: 'sub-2', submission_note: '', review_note: '', provenance: {}, reviewed_at: null }),
    ];

    test('a coach receives the source and the verdict, the note sentence in place of each note, and no provenance', () => {
      const [first, second] = researchSubmissionsForReader({ role: 'coach' }, noted, false, asked()) as ResearchSubmissionRow[];
      expect(first).toEqual({
        ...noted[0],
        provenance: {},
        submission_note: ASKER_QUESTION_NOTE_SENTENCE,
        review_note: ASKER_QUESTION_NOTE_SENTENCE,
      });
      expect(second).toEqual({ ...noted[1], submission_note: '', review_note: '' });
      const text = JSON.stringify([first, second]);
      expect(text).not.toContain('hits a kid');
      expect(text).not.toContain('her question');
      expect(text).not.toContain('Penn State');
    });

    test('the organization admin and admin receive them whole', () => {
      for (const role of ['organization_admin', 'admin'] as const) {
        expect(researchSubmissionsForReader({ role }, noted, false, asked())).toBe(noted);
      }
    });

    test('the asker receives the family fields, as on any row', () => {
      expect(researchSubmissionsForReader({ role: 'athlete' }, noted, false, asked())).toEqual(noted.map(toFamilyResearchSubmission));
    });

    test("a coach receives an ordinary requirement's submissions and a coach-filed question's whole", () => {
      expect(researchSubmissionsForReader({ role: 'coach' }, noted, false, requirement())).toBe(noted);
      expect(researchSubmissionsForReader({ role: 'coach' }, noted, false, asked({ created_by_role: 'coach' }))).toBe(noted);
    });
  });
});

// F-183: OD-2026-10-13-018 (Jason 2026-10-13, "A: Office + asker
// (Recommended)") applied by Overwatch 2026-10-23 under "asked once, ruled
// once" to the learning loop's research rows. An athlete's or parent's note on
// a SHADOW answer is read by the organization admin and its author; a coach
// sees only that feedback was filed. A coach's or admin's own note is unchanged.
describe('a learning-loop note filed by an athlete or parent', () => {
  const NOTE = 'his coach yells at him and the advice made it worse';
  const AUTHOR = 'parent.one@gym.example.test';
  const MESSAGE_ID = '0b9f6f3e-5d0c-4f43-9a51-3c1e2a7d4b10';
  const noted = (overrides: Partial<ShadowResearchRequirementRow> = {}) => requirement({
    source_event_name: 'shadow_learning_negative_outcome',
    source_entity_type: 'shadow_learning_event',
    source_entity_id: MESSAGE_ID,
    research_requirement: "Strengthen SHADOW guidance for topic 'mindset' after outcome 'thumbs_down'.",
    knowledge_gap: NOTE,
    evidence_label: 'Learning loop escalation (thumbs_down)',
    source_status: 'weak',
    source_confidence_tier: 'LIMITED',
    source_verification_state: 'unverified',
    status: 'open',
    resolved_at: null,
    created_by_account_id: AUTHOR,
    created_by_role: 'parent',
    metadata: { sessionType: 'quick_round', outcome: 'thumbs_down', topic: 'mindset', note: NOTE },
    subject_id: null,
    ...overrides,
  });

  test('is recognized by its event and a filer outside research staff, as the F-054 row is, not by metadata', () => {
    expect(isMemberFiledLearningNote(noted())).toBe(true);
    expect(isMemberFiledLearningNote(noted({ created_by_role: 'athlete' }))).toBe(true);
    // A volunteer or staff seat may be a teen's (OD-2026-10-17-014), and a role
    // this code does not know, or none, keeps the words out the same way.
    for (const role of ['volunteer', 'staff', 'platform_owner', 'board', '', 'Athlete', 'PARENT', 'guardian']) {
      expect(isMemberFiledLearningNote(noted({ created_by_role: role }))).toBe(true);
    }
    for (const role of ['coach', 'organization_admin', 'admin']) {
      expect(isMemberFiledLearningNote(noted({ created_by_role: role }))).toBe(false);
    }
    expect(isMemberFiledLearningNote(noted({ source_event_name: 'SHADOW_INTAKE_CASE_APPROVED' }))).toBe(false);
    expect(isMemberFiledLearningNote(noted({ metadata: {} }))).toBe(true);
    // The F-054 test is untouched by this one.
    expect(isAskerFiledQuestion(noted())).toBe(false);
  });

  test.each(['athlete', 'parent'] as const)('filed by a %s, it reaches a coach with no words, key or author', (role) => {
    const stored = noted({ created_by_role: role });
    const [row] = researchRequirementsForReader({ accountId: COACH_ID, role: 'coach' }, [stored]) as ShadowResearchRequirementRow[];
    const text = JSON.stringify(row);
    expect(text).not.toContain('yells');
    expect(text).not.toContain(AUTHOR);
    expect(text).not.toContain(MESSAGE_ID);
    expect(row).toEqual({
      ...stored,
      source_entity_id: '7',
      research_requirement: LEARNING_NOTE_COACH_SENTENCE,
      knowledge_gap: LEARNING_NOTE_COACH_SENTENCE,
      evidence_label: null,
      created_by_account_id: '',
      created_by_role: '',
      metadata: {},
      subject_id: null,
    });
    expect(wholeResearchRowFor('coach', stored)).toEqual(row);
  });

  test.each(['organization_admin', 'admin'] as const)('a %s receives it whole', (role) => {
    const stored = [noted(), noted({ created_by_role: 'athlete' })];
    const read = researchRequirementsForReader({ accountId: ADMIN_ID, role }, stored);
    expect(read).toHaveLength(2);
    read.forEach((row, index) => expect(row).toBe(stored[index]));
    expect(wholeResearchRowFor(role, stored[0])).toBe(stored[0]);
  });

  test('its author reads their own words through the family view, with no account id', () => {
    const [row] = researchRequirementsForReader({ accountId: AUTHOR, role: 'parent' }, [noted()]);
    expect(row).toMatchObject({ knowledge_gap: NOTE, is_mine: true });
    expect(JSON.stringify(row)).not.toContain(AUTHOR);
  });

  test.each(['volunteer', 'staff', 'platform_owner'] as const)(
    "a %s seat's note reaches a coach as the sentence too, and the organization admin whole",
    (role) => {
      const stored = noted({ created_by_role: role });
      const coachView = wholeResearchRowFor('coach', stored);
      expect(coachView.knowledge_gap).toBe(LEARNING_NOTE_COACH_SENTENCE);
      expect(JSON.stringify(coachView)).not.toContain('yells');
      expect(wholeResearchRowFor('organization_admin', stored)).toBe(stored);
    },
  );

  test.each(['coach', 'organization_admin', 'admin'] as const)("a %s's own note stays whole for a coach", (role) => {
    const own = noted({ created_by_role: role, created_by_account_id: COACH_ID });
    expect(wholeResearchRowFor('coach', own)).toBe(own);
    const list = [own];
    expect(researchRequirementsForReader({ accountId: 'coach.two@gym.example.test', role: 'coach' }, list)).toBe(list);
  });

  test('a closed one gives the coach the note sentence in place of the closing note', () => {
    const row = wholeResearchRowFor('coach', noted({
      status: 'resolved',
      metadata: { note: NOTE, closing_note: 'Spoke to his dad about the yelling.', closing_submission_id: 'sub-1' },
    }));
    expect(row.metadata).toEqual({ closing_note: ASKER_QUESTION_NOTE_SENTENCE, closing_submission_id: 'sub-1' });
    expect(JSON.stringify(row)).not.toContain('yelling');
  });

  test('beside an F-054 question and an ordinary row, each reaches a coach as its own kind does', () => {
    const asker = requirement({
      research_requirement_id: 8,
      source_event_name: 'shadow_unanswered_question',
      source_entity_type: 'shadow_asker_question',
      research_requirement: 'is it ok to cut weight before a first bout',
      created_by_account_id: 'athlete.one@gym.example.test',
      created_by_role: 'athlete',
      subject_id: null,
      metadata: {},
    });
    const ordinary = requirement({ research_requirement_id: 9 });
    const [learning, question, plain] = researchRequirementsForReader(
      { accountId: COACH_ID, role: 'coach' },
      [noted(), asker, ordinary],
    ) as ShadowResearchRequirementRow[];
    expect(learning.knowledge_gap).toBe(LEARNING_NOTE_COACH_SENTENCE);
    expect(question.research_requirement).toBe(ASKER_QUESTION_COACH_SENTENCE);
    expect(question.knowledge_gap).toBe(ASKER_QUESTION_COACH_SENTENCE);
    expect(plain).toBe(ordinary);
  });

  describe('its submissions', () => {
    const notes = [submission({ submission_note: 'Source on a coach who yells at kids.', review_note: 'Answers the dad.' })];

    test('a coach receives the source and the verdict and the note sentence in place of each note', () => {
      const [row] = researchSubmissionsForReader({ role: 'coach' }, notes, false, noted()) as ResearchSubmissionRow[];
      expect(row).toEqual({
        ...notes[0],
        provenance: {},
        submission_note: ASKER_QUESTION_NOTE_SENTENCE,
        review_note: ASKER_QUESTION_NOTE_SENTENCE,
      });
      expect(JSON.stringify(row)).not.toContain('yells');
    });

    test('the organization admin and admin receive them whole, and a coach-filed note keeps them whole', () => {
      for (const role of ['organization_admin', 'admin'] as const) {
        expect(researchSubmissionsForReader({ role }, notes, false, noted())).toBe(notes);
      }
      expect(researchSubmissionsForReader({ role: 'coach' }, notes, false, noted({ created_by_role: 'coach' }))).toBe(notes);
    });
  });
});
