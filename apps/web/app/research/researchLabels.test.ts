import {
  displayableEvidenceLabel,
  evidenceReviewLabel,
  requirementContextLabel,
  requirementRecordLine,
} from './researchLabels';

// The shared labels behind #345's Needs Evidence record line and the
// evidence-review state /research and /research/review both show. The id
// rules are pinned here as well as on the page: a Library claim stores the
// athlete it is about as its evidence label (shadowLibrary.ts), and a staff
// account id is a sign-in email.

const ATHLETE = 'athlete-41';

describe('evidenceReviewLabel', () => {
  test.each([
    [{ approval_state: 'pending_review', verification_state: 'unverified' }, 'Pending Review · Unverified'],
    [{ approval_state: 'approved', verification_state: 'verified' }, 'Approved · Verified'],
    [{ approval_state: 'rejected', verification_state: 'unverified' }, 'Rejected · Unverified'],
  ] as const)('%o reads %s', (source, label) => {
    expect(evidenceReviewLabel(source)).toBe(label);
  });

  test('a source not read, or read without both fields, has no label', () => {
    expect(evidenceReviewLabel(undefined)).toBeNull();
    expect(evidenceReviewLabel({ approval_state: 'approved' })).toBeNull();
    expect(evidenceReviewLabel({ verification_state: 'verified' })).toBeNull();
  });

  test('a value outside the ladder is not looked up on the object prototype', () => {
    expect(evidenceReviewLabel({ approval_state: 'constructor', verification_state: 'verified' } as never)).toBeNull();
  });
});

describe('requirementContextLabel', () => {
  test.each([
    ['shadow_library_claim', 'Library claim'],
    ['shadow_library_capability_map', 'Library capability check'],
    ['intake_case', 'Intake case'],
    ['shadow_question', 'Question asked in SHADOW'],
    ['shadow_asker_question', 'Question from an athlete or parent'],
    ['shadow_learning_event', 'SHADOW feedback'],
    ['formula_id', 'Formula'],
    ['manual_note', 'Manual note'],
    ['research_import_row', 'research import row'],
  ])('%s reads %s', (type, label) => {
    expect(requirementContextLabel({ source_entity_type: type })).toBe(label);
  });

  test('a row about an athlete says so, by any subject key, and never names them', () => {
    expect(requirementContextLabel({ source_entity_type: 'intake_case', subject_id: ATHLETE })).toBe('Intake case about an athlete');
    expect(requirementContextLabel({ source_entity_type: 'manual_note', metadata: { subject_id: ATHLETE } }))
      .toBe('Manual note about an athlete');
    expect(requirementContextLabel({ source_entity_type: 'intake_case', metadata: { athlete_id: ATHLETE } }))
      .toBe('Intake case about an athlete');
  });

  test('an unknown type that carries an id the row names is not shown', () => {
    expect(requirementContextLabel({ source_entity_type: ATHLETE, subject_id: ATHLETE })).toBeNull();
    expect(requirementContextLabel({ source_entity_type: 'coach@example.org' })).toBeNull();
  });

  test('a row with no type (the family view) has no context', () => {
    expect(requirementContextLabel({})).toBeNull();
    expect(requirementContextLabel({ source_entity_type: '  ' })).toBeNull();
  });
});

describe('displayableEvidenceLabel', () => {
  test('a Library claim never shows its label, which is the athlete it is about', () => {
    expect(displayableEvidenceLabel({ source_entity_type: 'shadow_library_claim', evidence_label: ATHLETE, subject_id: ATHLETE }))
      .toBeNull();
    // Even when the subject fields were not sent alongside it.
    expect(displayableEvidenceLabel({ source_entity_type: 'shadow_library_claim', evidence_label: ATHLETE })).toBeNull();
  });

  test('a label that is or holds an athlete or account id the row names is not shown', () => {
    expect(displayableEvidenceLabel({ evidence_label: ATHLETE, subject_id: ATHLETE })).toBeNull();
    expect(displayableEvidenceLabel({ evidence_label: `see ${ATHLETE}`, metadata: { athlete_id: ATHLETE } })).toBeNull();
    expect(displayableEvidenceLabel({ evidence_label: ATHLETE, metadata: { asker_athlete_id: ATHLETE } })).toBeNull();
    expect(displayableEvidenceLabel({ evidence_label: 'staff-17', created_by_account_id: 'staff-17' })).toBeNull();
    expect(displayableEvidenceLabel({ evidence_label: 'filed by coach@example.org' })).toBeNull();
  });

  test("the writers' own labels are shown", () => {
    expect(displayableEvidenceLabel({ source_entity_type: 'shadow_library_capability_map', evidence_label: 'boxing.footwork' }))
      .toBe('boxing.footwork');
    expect(displayableEvidenceLabel({ source_entity_type: 'formula_id', evidence_label: 'acwr_v1', subject_id: null })).toBe('acwr_v1');
    expect(displayableEvidenceLabel({ source_entity_type: 'shadow_learning_event', evidence_label: 'Learning loop escalation (negative)' }))
      .toBe('Learning loop escalation (negative)');
  });

  test('no label, or a blank one, is nothing', () => {
    expect(displayableEvidenceLabel({ evidence_label: null })).toBeNull();
    expect(displayableEvidenceLabel({ evidence_label: '   ' })).toBeNull();
  });
});

describe('requirementRecordLine', () => {
  test('the created date is the gym day, not the UTC day', () => {
    expect(requirementRecordLine({ created_at: '2026-08-11T02:30:00.000Z' })).toBe('Created: Aug 10, 2026');
  });

  test('every part, in order', () => {
    expect(requirementRecordLine({
      created_at: '2026-08-10T12:00:00.000Z',
      source_entity_type: 'shadow_library_capability_map',
      evidence_label: 'boxing.footwork',
    })).toBe('Created: Aug 10, 2026 | Context: Library capability check | Evidence label: boxing.footwork');
  });

  test('an unreadable date is left out, and a row with nothing to say has no line', () => {
    expect(requirementRecordLine({ created_at: 'not a date', source_entity_type: 'manual_note' })).toBe('Context: Manual note');
    expect(requirementRecordLine({})).toBeNull();
  });
});
