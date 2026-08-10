/**
 * The write boundary for filter_reasons.
 *
 * Two paths persist an assistant message -- the synchronous chat route and the
 * background job processor -- and they must record a withheld answer
 * identically, or the report's split by tier shows the async tier filtering for
 * no recorded reason while the sync tier attributes every one. Normalising at
 * the boundary rather than at each caller is what makes that true by
 * construction; these tests hold the boundary to its rules.
 */
import { storedFilterReasons } from './shadowConversations';

describe('storedFilterReasons', () => {
  test('records the codes on a withheld answer', () => {
    expect(storedFilterReasons('filtered', ['diagnostic_claim', 'missing_deferral']))
      .toEqual(['diagnostic_claim', 'missing_deferral']);
  });

  test('records nothing on an answer that was shown, even when reasons exist', () => {
    // `human_review` fires without withholding anything. Storing it here would
    // count an answer the user actually received among the withheld ones, which
    // inflates every rule's share of exactly the population being measured. It
    // already has a durable artifact in pilot.shadow_human_review_queue.
    expect(storedFilterReasons('ok', ['human_review'])).toBeNull();
  });

  test('empty and absent both store null, not an empty array', () => {
    // The check script has to tell a row written before the migration from a
    // row written after it by a path that filtered without recording why. An
    // empty array would make those two indistinguishable.
    expect(storedFilterReasons('filtered', [])).toBeNull();
    expect(storedFilterReasons('filtered', undefined)).toBeNull();
  });

  test('duplicates collapse, so one rule counts once per message', () => {
    // The report counts messages per reason. A code appearing twice on one
    // message would count that message twice and overstate the rule.
    expect(storedFilterReasons('filtered', ['diagnostic_claim', 'diagnostic_claim']))
      .toEqual(['diagnostic_claim']);
  });

  test('blank entries are dropped rather than stored as empty strings', () => {
    expect(storedFilterReasons('filtered', ['  ', 'clearance_claim', '']))
      .toEqual(['clearance_claim']);
    expect(storedFilterReasons('filtered', ['   '])).toBeNull();
  });

  test('surrounding whitespace is trimmed, so one code cannot become two', () => {
    expect(storedFilterReasons('filtered', [' diagnostic_claim ', 'diagnostic_claim']))
      .toEqual(['diagnostic_claim']);
  });

  test('an implausibly long list is bounded', () => {
    // Nothing in the validator can produce this today. The bound is here so a
    // future rule loop cannot write an unbounded array into a row that is read
    // on every conversation restore.
    const many = Array.from({ length: 50 }, (_, index) => `code_${index}`);
    expect(storedFilterReasons('filtered', many)).toHaveLength(20);
  });
});
