// What SHADOW says when the Library does not answer a question, and the check
// that reads it back out of an answer (F-161 (d)).
//
// One module for both, so the words the prompts ask for and the words the
// route listens for cannot drift apart: the evidence bundle's instruction
// (shadowEvidence.ts) and the weight-cut section (shadowChat.ts) quote
// LIBRARY_HAS_NOTHING_YET, and indicatesInsufficientContext builds its match
// from it. Before this, the prompt asked for "the Library has nothing on that
// yet" and the check, then in the chat route, did not recognise it.
//
// No imports on purpose: the chat route's tests mock shadowEvidence and
// shadowChat, and a constant read through either would be undefined there.
// Listed in SHADOW_CONTEXT_CONTRACT_SOURCES, because the phrase is prompt text.

export const LIBRARY_HAS_NOTHING_YET = 'the Library has nothing on that yet';

function phrasePattern(phrase: string): RegExp {
  const words = phrase.toLowerCase().split(/\s+/).filter(Boolean)
    .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`\\b${words.join('\\s+')}\\b`);
}

const PROMPT_PHRASE = phrasePattern(LIBRARY_HAS_NOTHING_YET);

/**
 * Whether an answer says its context does not answer the question. The
 * prompt's own phrase, plus the topic-named form of it ("the Library has
 * nothing on resting heart rate yet"), plus the older phrasings.
 *
 * It reads words, not citations: an answer can use these words for one point
 * and cite the Library for the rest. The callers count it only when the answer
 * cites no Library evidence.
 */
export function indicatesInsufficientContext(response: string): boolean {
  const normalized = response.toLowerCase();
  return (
    PROMPT_PHRASE.test(normalized)
    || /\bthe\s+library\s+(?:has|holds)\s+nothing\s+on\s+(?:[\w'’-]+\s+){1,6}yet\b/.test(normalized)
    || /\bnot\s+enough\s+context\b/.test(normalized)
    || /\binsufficient\s+context\b/.test(normalized)
    || /\b(?:do\s+not|don't|cannot|can\s*not|can't)\s+have\s+enough\s+(?:context|information)\b/.test(normalized)
    || /\b(?:i\s+)?(?:do\s+not|don't|cannot|can\s*not|can't)\s+(?:determine|answer)\b.{0,40}\b(?:provided|available)\s+context\b/.test(normalized)
    || /\bneed\s+more\s+context\b/.test(normalized)
    || /\b(?:do\s+not|don't|cannot|can\s*not|can't)\s+have\s+enough\s+information\b/.test(normalized)
  );
}
