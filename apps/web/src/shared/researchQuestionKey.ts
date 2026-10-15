/* THE KEY A RESEARCH ROW FOR AN UNANSWERED SHADOW QUESTION IS FILED UNDER.
 *
 * One function, imported by the server (src/server/pilot/shadowResearchFiling.ts)
 * and by the SHADOW page's "File as research" button (app/shadow/page.tsx), so
 * the two can never disagree: a coach's button and an auto-filing of the same
 * question reach the same row, and two different questions never share one.
 *
 * It used to cut the question at its first 500 characters, so two long
 * questions that began alike were one row and the second was silently lost
 * (Codex, #1575). The row's key sits under a unique btree index, which cannot
 * hold a 12,000-character key, so a long question is its first 400 normalized
 * characters plus a hash of the WHOLE normalized text. A short question is its
 * normalized text, exactly as before, so every row already filed under a short
 * key is still found.
 *
 * The hash is not a secret and not for security: it only has to tell two
 * different questions apart. cyrb53 (53 bits, synchronous so the page can call
 * it while rendering); two 53-bit values for the same 400-character prefix
 * collide with probability ~1e-16.
 */

/** The longest question SHADOW chat accepts and stores (shadowConversations.ts). */
export const RESEARCH_QUESTION_MAX = 12_000;

const KEY_TEXT_PREFIX = 400;

export function normalizeResearchQuestion(question: string): string {
  return question.trim().toLowerCase().replace(/\s+/g, ' ').slice(0, RESEARCH_QUESTION_MAX);
}

function cyrb53(text: string, seed = 0): string {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0');
}

/** '' when the question is empty. */
export function researchQuestionKey(question: string, athleteId?: string | null): string {
  const normalized = normalizeResearchQuestion(question);
  if (!normalized) return '';
  const text = normalized.length <= KEY_TEXT_PREFIX
    ? normalized
    : `${normalized.slice(0, KEY_TEXT_PREFIX)}#${cyrb53(normalized)}`;
  return athleteId ? `athlete:${athleteId}:${text}` : text;
}
