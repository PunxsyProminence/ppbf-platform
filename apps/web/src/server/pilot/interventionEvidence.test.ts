// Evidence and review vocabularies (module 026 slice 3). What these pin:
// every vocabulary is closed -- semantic evidence roles (an invented
// 'proof_it_worked' role is refused), typed source kinds, and the three
// SEPARATE review answers (performance / hypothesis / learning). There is
// no score, no percentage, and no information-gain number anywhere in
// these vocabularies; and every source kind's validation query binds
// organization AND athlete.

import {
  EVIDENCE_ROLES,
  EVIDENCE_SOURCES,
  EVIDENCE_SOURCE_KINDS,
  HYPOTHESIS_RESULTS,
  LEARNING_SIGNALS,
  PERFORMANCE_RESULTS,
  evidenceRoleError,
  hypothesisResultError,
  learningSignalError,
  performanceResultError,
  sourceKindError,
} from './interventionEvidence';

test('the evidence-role vocabulary is closed and includes the uncomfortable roles', () => {
  for (const role of EVIDENCE_ROLES) {
    expect(evidenceRoleError(role)).toBeNull();
  }
  // Counterevidence and adverse response are first-class, not afterthoughts.
  expect(EVIDENCE_ROLES).toContain('counterevidence');
  expect(EVIDENCE_ROLES).toContain('adverse_response');
  expect(evidenceRoleError('proof_it_worked')).toMatch(/evidence_role must be one of/);
});

test('every source kind has an org-and-athlete-bound validation query', () => {
  for (const kind of EVIDENCE_SOURCE_KINDS) {
    expect(sourceKindError(kind)).toBeNull();
    const sql = EVIDENCE_SOURCES[kind];
    expect(sql).toContain('organization_id = $1');
    expect(sql).toContain('athlete_id = $3');
  }
  expect(sourceKindError('vibes')).toMatch(/source_kind must be one of/);
});

test('the three review answers are separate closed vocabularies with no scores', () => {
  for (const result of PERFORMANCE_RESULTS) expect(performanceResultError(result)).toBeNull();
  for (const result of HYPOTHESIS_RESULTS) expect(hypothesisResultError(result)).toBeNull();
  for (const signal of LEARNING_SIGNALS) expect(learningSignalError(signal)).toBeNull();

  expect(performanceResultError('82%')).toMatch(/performance_result must be one of/);
  expect(hypothesisResultError('proven')).toMatch(/hypothesis_result must be one of/);
  expect(learningSignalError('information_gain_0.7')).toMatch(/learning_signal must be one of/);
  // Abstention states exist in both verdict vocabularies.
  expect(HYPOTHESIS_RESULTS).toContain('insufficient_evidence');
  expect(LEARNING_SIGNALS).toContain('unresolved');
});
