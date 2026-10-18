/**
 * What a person reads when the server says no (UXB-09).
 *
 * Coaches on the floor were reading "The server refused: ROUND_TIMER_PAUSED",
 * "HTTP 409" and "Record failed (500)": a stored code or a status number is
 * not something a coach between rounds can act on. Every refusal on a floor
 * screen goes through here, so a code becomes words and a number never shows.
 *
 * - A known code gets its sentence.
 * - A sentence the server wrote for people is kept: many routes answer
 *   "That athlete is not on your roster", and those words are the point.
 * - A field name a screen already labels is replaced by that label's words,
 *   so the server's reason survives ("max_hard_open_... must be ..."); a
 *   sentence naming any other field is builder text (F-125).
 * - Anything that reads as a code (no spaces, or a trailing "(SOME_CODE)"),
 *   and any reply with no usable words, falls back to plain words.
 *
 * All wording here is PROPOSED (lane U3, UXB-L4).
 */

/** The fallback for a request the server refused before writing (a 4xx). PROPOSED. */
export const NOTHING_CHANGED = 'That did not go through. Nothing was changed. Try again.';

/** The fallback when the server failed or its answer is unknown (5xx, no status,
 *  an unreadable reply): the write may or may not have landed, so this states
 *  nothing about it. PROPOSED. */
export const NOT_SURE = 'That did not go through. Check what the screen shows before trying again.';

const SIGN_IN_EXPIRED = 'Your sign-in has expired. Sign in again, then try again.';
const NOT_ALLOWED = 'Your account cannot do this here.';

/** Session and round-timer codes a coach meets on the live screen. PROPOSED. */
export const SESSION_REFUSAL_WORDS: Readonly<Record<string, string>> = {
  SESSION_RUN_NOT_LIVE: 'This session has already ended, so nothing was changed.',
  SESSION_RUN_NOT_FOUND: 'This session could not be found for your account, so nothing was changed.',
  SESSION_RUN_ALREADY_LIVE: 'You already have a session running. Finish it before starting another.',
  SESSION_RUN_ATHLETE_NOT_PERMITTED: 'Your account cannot record that athlete here. Nothing was changed.',
  SESSION_RUN_BLOCK_NOT_IN_SCRIPT: 'That block is not part of this session\'s plan, so the session stayed where it was.',
  SESSION_RUN_HAS_NO_SCRIPT: 'This session has no plan, so there are no blocks to move between.',
  SESSION_RUN_NOT_ON_TV: 'Switch "Show on TV" on for your session first, then send it.',
  ROUND_TIMER_RUNNING: 'The rounds are already running.',
  ROUND_TIMER_PAUSED: 'The rounds are paused. Press Resume to carry on.',
  ROUND_TIMER_ENDED: 'Those rounds have ended. Set up the rounds again to start a new set.',
  ROUND_TIMER_NOT_SET: 'Set up the rounds first, then start them.',
};

/** Field names a coach-screen refusal carries in a sentence, in the words of
 *  the label above that field (ContactCapPanel). PROPOSED. */
const FIELD_WORDS: Readonly<Record<string, string>> = {
  max_hard_open_sessions_per_7_days: 'Most hard or open sparring sessions in any 7 days',
};

const FIELD_NAME = /\b[a-z][a-z0-9]*_[a-z0-9_]+\b/;

/** The text with each field name a screen labels replaced by that label's
 *  words, capitalised only where it starts the sentence. A bare field name is
 *  left a code: it carries no reason. */
function withFieldWords(text: string): string {
  if (!/\s/.test(text.trim())) return text;
  return text.replace(new RegExp(FIELD_NAME.source, 'g'), (name: string, at: number) => {
    if (!Object.prototype.hasOwnProperty.call(FIELD_WORDS, name)) return name;
    const words = FIELD_WORDS[name];
    return text.slice(0, at).trim() === '' ? words : `${words.charAt(0).toLowerCase()}${words.slice(1)}`;
  });
}

/** True when the text reads as a stored code rather than words for a person. */
export function looksLikeCode(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed === '') return true;
  // SOME_CODE, some_code, someCode, HTTP 409, 409: nothing a person can act on.
  if (!/\s/.test(trimmed)) return true;
  // A field name inside a sentence ("Missing athlete_id"); refusalWords puts
  // the ones a screen labels into words before asking.
  if (FIELD_NAME.test(trimmed)) return true;
  if (/^HTTP\s*\d{3}$/i.test(trimmed)) return true;
  return false;
}

/** Server text that is never words for a person: a code prefix ("UNEXPECTED_FIELD: x",
 *  "action:expected ..."), a raw server error, or a database/parse message. A
 *  sentence that merely starts "Unsupported: ..." is kept. */
const CODE_PREFIX = /^(?:[A-Z][A-Z0-9_]{2,}:|[A-Za-z_]+:\S)/;
const BUILDER_TEXT = /^internal server error|\bpilot\.|\bsql\b|\bECONN|unexpected token|\bJSON\b/i;

function sentenceCase(text: string): string {
  const trimmed = text.trim().replace(/\.$/, '');
  return trimmed === '' ? trimmed : `${trimmed.charAt(0).toUpperCase()}${trimmed.slice(1)}.`;
}

/** Drops a trailing "(SOME_CODE)" or "(409)" a server sentence carries for its logs. */
function withoutTrailingCode(text: string): string {
  return text.replace(/\s*\((?:[A-Z][A-Z0-9_]{2,}|\d{3})\)\s*\.?\s*$/, '').trim();
}

export interface RefusalInput {
  /** The reply's `error` (or `code`) field, whatever its type. */
  readonly error?: unknown;
  /** The HTTP status, used only to pick words, never shown. */
  readonly status?: number;
}

/**
 * Words for a refused request. `known` maps this screen's codes to sentences;
 * `fallback` replaces the shared NOTHING_CHANGED where a screen has a better
 * sentence of its own.
 */
export function refusalWords(
  input: RefusalInput,
  known: Readonly<Record<string, string>> = SESSION_REFUSAL_WORDS,
  fallback: string = NOTHING_CHANGED,
): string {
  const raw = typeof input.error === 'string' ? input.error.trim() : '';
  if (raw !== '' && Object.prototype.hasOwnProperty.call(known, raw)) return known[raw];
  if (raw !== '' && Object.prototype.hasOwnProperty.call(SESSION_REFUSAL_WORDS, raw)) return SESSION_REFUSAL_WORDS[raw];
  // The shared access layer answers "Unauthorized..." and "Forbidden: coach not
  // assigned to athlete": builder words, whatever the status says.
  if (input.status === 401 || /^unauthori[sz]ed\b/i.test(raw)) return SIGN_IN_EXPIRED;
  if (/^forbidden\b/i.test(raw)) {
    // "Forbidden: only an organization admin can lift a hold an admin placed"
    // carries the reason a coach needs; keep it when it reads as words.
    const reason = raw.replace(/^forbidden\s*:?\s*/i, '');
    if (reason !== '' && !looksLikeCode(reason) && !CODE_PREFIX.test(reason) && !BUILDER_TEXT.test(reason)) {
      return `${NOT_ALLOWED} ${sentenceCase(withoutTrailingCode(reason))}`;
    }
    return NOT_ALLOWED;
  }
  // Builder text is judged on what the server sent, before any field is put into words.
  const worded = CODE_PREFIX.test(raw) || BUILDER_TEXT.test(raw) ? '' : withFieldWords(raw);
  if (worded !== '' && !looksLikeCode(worded) && !CODE_PREFIX.test(worded) && !BUILDER_TEXT.test(worded)) {
    const sentence = withoutTrailingCode(worded);
    if (sentence !== '' && !looksLikeCode(sentence)) return sentence;
  }
  if (input.status === 403) return NOT_ALLOWED;
  if (fallback !== NOTHING_CHANGED) return fallback;
  // Only a refusal (4xx) is known to have changed nothing.
  return typeof input.status === 'number' && input.status >= 400 && input.status < 500 ? NOTHING_CHANGED : NOT_SURE;
}
