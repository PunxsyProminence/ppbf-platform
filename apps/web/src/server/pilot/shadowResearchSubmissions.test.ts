// The answer-state ladder is the workspace's central claim, and its central
// rule is what it CANNOT say: 'resolved' is never derivable from submissions
// -- it comes only from the requirement's own status, which only the existing
// human act changes. "PDF uploaded" is not "question answered" (issue #345).

import { deriveAnswerState } from './shadowResearchSubmissions';

const sub = (state: string) => ({ applicability_state: state as never });

describe('deriveAnswerState', () => {
  test('no submissions: needs evidence', () => {
    expect(deriveAnswerState('open', [])).toBe('needs_evidence');
  });

  test('submissions exist but none reviewed: sources submitted, NOT answered', () => {
    expect(deriveAnswerState('open', [sub('unreviewed'), sub('unreviewed')])).toBe('sources_submitted');
  });

  test('a responsive review moves it only to partially answered — never resolved', () => {
    expect(deriveAnswerState('open', [sub('responsive')])).toBe('partially_answered');
    expect(deriveAnswerState('open', [sub('partially_responsive'), sub('unreviewed')])).toBe('partially_answered');
  });

  test('reviews that all reject, with more in the queue: evidence under review', () => {
    expect(deriveAnswerState('open', [sub('not_responsive'), sub('unreviewed')])).toBe('evidence_under_review');
  });

  test('everything reviewed and nothing responsive: back to needs evidence', () => {
    expect(deriveAnswerState('open', [sub('not_responsive'), sub('duplicate')])).toBe('needs_evidence');
  });

  test('resolved comes only from the requirement itself, whatever the submissions say', () => {
    expect(deriveAnswerState('resolved', [])).toBe('resolved');
    expect(deriveAnswerState('resolved', [sub('not_responsive')])).toBe('resolved');
  });

  test('no pile of submissions, reviewed or not, ever derives resolved from an open requirement', () => {
    const everyState = ['unreviewed', 'responsive', 'partially_responsive', 'not_responsive', 'duplicate'];
    const pile = everyState.flatMap((state) => [sub(state), sub(state), sub(state)]);
    expect(deriveAnswerState('open', pile)).not.toBe('resolved');
  });
});
