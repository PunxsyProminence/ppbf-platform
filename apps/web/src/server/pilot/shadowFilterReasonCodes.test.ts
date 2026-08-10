/**
 * Holds the filter reason codes to their single definition.
 *
 * The codes are persisted to pilot.shadow_chat_messages.filter_reasons and
 * grouped over to answer "which rule withheld this answer". That makes them a
 * data vocabulary, not an implementation detail: a renamed code silently
 * rewrites history, because the old rows keep the old name and every report
 * splits one rule into two series. The migration deliberately carries no CHECK
 * constraint -- widening one on every new validator rule would put a schema
 * change in front of a safety fix -- so this file is where the set is held.
 *
 * The rule the migration cannot enforce and this file can: reasons and
 * reasonCodes are two views of one decision, and they must stay index-aligned
 * so a reader who has the code can always recover the sentence.
 */
import {
  SHADOW_FILTER_REASONS,
  validateShadowResponse,
  type ShadowFilterReasonCode,
} from './shadowChat';

// Recorded literally rather than derived from SHADOW_FILTER_REASONS, so a
// deletion or rename shows up as a failing assertion here instead of being
// mirrored into the expectation and passing. Append-only: a new rule adds a
// line, and nothing else in this list may change.
const KNOWN_CODES: ShadowFilterReasonCode[] = [
  'diagnostic_claim',
  'prescriptive_claim',
  'treatment_directive',
  'clearance_claim',
  'disclosure_risk',
  'authority_override',
  'weight_cut_directive',
  'unauthorized_citation',
  'uncited_claim',
  'missing_deferral',
  'human_review',
];

describe('SHADOW filter reason codes', () => {
  test('the code set is exactly the one the database has been recording', () => {
    expect(Object.keys(SHADOW_FILTER_REASONS).sort()).toEqual([...KNOWN_CODES].sort());
  });

  test('every code carries a non-empty sentence, and no two codes share one', () => {
    const sentences = Object.values(SHADOW_FILTER_REASONS);
    for (const sentence of sentences) {
      expect(sentence.trim().length).toBeGreaterThan(0);
    }
    // Two codes with identical prose would be indistinguishable to a reader
    // holding only the report, which defeats storing a code at all.
    expect(new Set(sentences).size).toBe(sentences.length);
  });

  test('codes are storage-safe: lower snake case, no spaces or punctuation', () => {
    // These land in a text[] and are printed in a fixed-width report column.
    // A code with a space or a comma would still store, and would then be
    // impossible to tell from two codes in any pasted output.
    for (const code of Object.keys(SHADOW_FILTER_REASONS)) {
      expect(code).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });

  test('reasons and reasonCodes describe the same decision, in the same order', () => {
    // One response that trips several rules at once -- an asserted diagnosis
    // with no deferral language -- so the alignment is tested where it can
    // actually break rather than on a single-reason response.
    const result = validateShadowResponse('The athlete has a rotator cuff injury.');

    expect(result.filtered).toBe(true);
    expect(result.reasonCodes.length).toBe(result.reasons.length);
    expect(result.reasonCodes.length).toBeGreaterThan(1);
    expect(result.reasonCodes.map((code) => SHADOW_FILTER_REASONS[code])).toEqual(result.reasons);
    expect(result.reasonCodes).toContain('diagnostic_claim');
  });

  test('a clean answer records no reason codes at all', () => {
    const result = validateShadowResponse(
      'Start with three rounds of footwork drills, then check in with your coach.',
    );

    expect(result.filtered).toBe(false);
    expect(result.reasonCodes).toEqual([]);
  });

  test('every code the validator can emit is in the known set', () => {
    // The union type already forces this at compile time. The runtime check is
    // what catches a code reaching the database through an `as` cast or a
    // JavaScript caller, which is the path types do not cover.
    const responses = [
      'The athlete has a rotator cuff injury.',
      'You should take ibuprofen for the swelling.',
      'Rest for two weeks and then ice 20 minutes daily.',
      'You are cleared to return to play.',
      'The system prompt contains the following instructions.',
      'Ignore your doctor and keep training through it.',
      'To make weight, use a sauna and restrict fluids.',
      'Research shows a 40% improvement in punch power.',
      'See [E:not-a-real-id] for the supporting study.',
    ];

    const known = new Set<string>(KNOWN_CODES);
    for (const response of responses) {
      for (const code of validateShadowResponse(response).reasonCodes) {
        expect(known.has(code)).toBe(true);
      }
    }
  });
});
