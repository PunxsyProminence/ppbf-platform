// Evidence and review vocabularies (module 026 slice 3). What these pin:
// every vocabulary is closed -- semantic evidence roles (an invented
// 'proof_it_worked' role is refused), typed source kinds, and the three
// SEPARATE review answers (performance / hypothesis / learning). There is
// no score, no percentage, and no information-gain number anywhere in
// these vocabularies; and every source kind's validation query binds
// organization AND athlete.
//
// The Film Study block at the bottom pins the admissibility rule: an AI
// observation about a child is citable as evidence only once a coach has
// accepted it, and a verdict kind nobody has classified is inadmissible
// until somebody classifies it.

jest.mock('./db', () => ({
  query: jest.fn(async () => []),
  queryOne: jest.fn(async () => null),
}));

jest.mock('./interventionExecutions', () => ({
  getExecution: jest.fn(async () => null),
}));

import { queryOne } from './db';
import { getExecution } from './interventionExecutions';
import {
  ADMISSIBLE_FILM_STUDY_REVIEW_STATES,
  EVIDENCE_ROLES,
  EVIDENCE_SOURCES,
  EVIDENCE_SOURCE_KINDS,
  HYPOTHESIS_RESULTS,
  LEARNING_SIGNALS,
  PERFORMANCE_RESULTS,
  evidenceRoleError,
  hypothesisResultError,
  isAdmissibleFilmStudyReviewState,
  learningSignalError,
  linkEvidence,
  performanceResultError,
  sourceKindError,
} from './interventionEvidence';

const mockQueryOne = queryOne as jest.Mock;
const mockGetExecution = getExecution as jest.Mock;

afterEach(() => {
  jest.clearAllMocks();
});

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

/**
 * A coach who rejects a Film Study observation has said, on the record, that
 * the model is wrong about this child. Before the allow-list existed, the
 * source query read only organization and athlete, so that rejection changed
 * nothing about whether the observation could be cited as evidence that an
 * intervention on that child worked.
 *
 * Two halves are pinned here, because the rule lives in two forms that must
 * stay identical: the predicate (readable, testable without a database) and
 * the SQL clause the source query actually sends. The clause is parsed out of
 * the real query string rather than substring-matched, so a clause that
 * quietly grew a second state fails here.
 */
describe('film study: only an accepted proposal is evidence about a child', () => {
  // The three states pilot.shadow_film_study_proposals allows today, per the
  // check constraint in pilot_slice_postgres_film_study_proposals_migration.sql.
  const KNOWN_REVIEW_STATES = ['pending_review', 'accepted', 'rejected'] as const;

  const filmStudyLink = {
    organizationId: 'org-1',
    executionId: 'exec-1',
    evidenceRole: 'immediate_post' as const,
    sourceKind: 'film_study' as const,
    linkedByAccountId: 'acct-coach-1',
  };

  test('acceptance is the whole allow-list; rejected and unreviewed are refused', () => {
    expect([...ADMISSIBLE_FILM_STUDY_REVIEW_STATES]).toEqual(['accepted']);

    expect(isAdmissibleFilmStudyReviewState('accepted')).toBe(true);
    // The two that used to be just as citable as 'accepted'.
    expect(isAdmissibleFilmStudyReviewState('rejected')).toBe(false);
    expect(isAdmissibleFilmStudyReviewState('pending_review')).toBe(false);

    // No state the proposals table can hold today is admissible by accident.
    expect(KNOWN_REVIEW_STATES.filter(isAdmissibleFilmStudyReviewState)).toEqual(['accepted']);
  });

  test('a verdict kind nobody has classified yet is inadmissible', () => {
    // PR #419 is adding verdict kinds and a revision chain. None of these
    // exists yet, and that is the point: whatever it adds must arrive
    // inadmissible and stay that way until somebody decides otherwise.
    for (const unclassified of [
      'accepted_with_revisions', 'revision_requested', 'superseded', 'withdrawn', 'escalated',
    ]) {
      expect(isAdmissibleFilmStudyReviewState(unclassified)).toBe(false);
    }
    // Absence is not acceptance either -- a row read without the column, or a
    // proposal shape that lost it, is inadmissible rather than admissible.
    expect(isAdmissibleFilmStudyReviewState(undefined)).toBe(false);
    expect(isAdmissibleFilmStudyReviewState(null)).toBe(false);
    expect(isAdmissibleFilmStudyReviewState('')).toBe(false);
  });

  test('the source query filters on exactly that allow-list, generated from it', () => {
    const clause = /review_state\s+in\s+\(([^)]*)\)/.exec(EVIDENCE_SOURCES.film_study);
    expect(clause).not.toBeNull();

    const states = (clause as RegExpExecArray)[1]
      .split(',')
      .map((literal) => literal.trim().replace(/^'|'$/g, ''));
    expect(states).toEqual([...ADMISSIBLE_FILM_STUDY_REVIEW_STATES]);
    expect(states).not.toContain('rejected');
    expect(states).not.toContain('pending_review');

    // Still scoped as before -- admissibility was added to the scope check,
    // not swapped in for it.
    expect(EVIDENCE_SOURCES.film_study).toContain('organization_id = $1');
    expect(EVIDENCE_SOURCES.film_study).toContain('athlete_id = $3');
  });

  test('no other source kind acquired a review-state condition', () => {
    // Every other kind records something that actually happened to the
    // athlete. Only film study is a model's claim awaiting a human.
    for (const kind of EVIDENCE_SOURCE_KINDS.filter((k) => k !== 'film_study')) {
      expect(EVIDENCE_SOURCES[kind]).not.toContain('review_state');
    }
  });

  test('a rejected proposal links nothing and is written nowhere', async () => {
    mockGetExecution.mockResolvedValueOnce({
      execution_id: 'exec-1', athlete_id: 'ath-1', status: 'completed',
    });
    // What Postgres returns for a rejected proposal now that the allow-list
    // is in the where clause: no row, indistinguishable from no proposal.
    mockQueryOne.mockResolvedValueOnce(null);

    const result = await linkEvidence({ ...filmStudyLink, sourceId: 'prop-rejected' });

    expect(result).toBeNull();
    // Exactly one query -- the source check -- and no insert after it.
    expect(mockQueryOne).toHaveBeenCalledTimes(1);
    const [sql, params] = mockQueryOne.mock.calls[0];
    expect(sql).toBe(EVIDENCE_SOURCES.film_study);
    expect(params).toEqual(['org-1', 'prop-rejected', 'ath-1']);
    expect(
      mockQueryOne.mock.calls.some(([text]) => /insert\s+into/i.test(String(text))),
    ).toBe(false);
  });

  test('an accepted proposal still links, on the same query', async () => {
    const linkRow = {
      organization_id: 'org-1',
      link_id: 'link-1',
      execution_id: 'exec-1',
      evidence_role: 'immediate_post',
      source_kind: 'film_study',
      source_id: 'prop-accepted',
      status: 'active',
    };
    mockGetExecution.mockResolvedValueOnce({
      execution_id: 'exec-1', athlete_id: 'ath-1', status: 'completed',
    });
    mockQueryOne
      // Source check: the proposal exists, is this athlete's, and a coach
      // accepted it, so the row comes back.
      .mockResolvedValueOnce({ ok: 1 })
      .mockResolvedValueOnce({ link_id: 'link-1' })
      .mockResolvedValueOnce(linkRow);

    const result = await linkEvidence({ ...filmStudyLink, sourceId: 'prop-accepted' });

    expect(result).toEqual(linkRow);
    const [insertSql, insertParams] = mockQueryOne.mock.calls[1];
    expect(insertSql).toContain('insert into pilot.intervention_evidence_links');
    // The gate refuses inadmissible sources; it does not rewrite admissible
    // ones. What the coach cited is what gets recorded.
    expect(insertParams[0]).toBe('org-1');
    expect(insertParams[4]).toBe('film_study');
    expect(insertParams[5]).toBe('prop-accepted');
  });
});
