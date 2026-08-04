/**
 * IDENTITY — the part of a member's record that is theirs rather than about
 * them.
 *
 * Everything in this file is PURE. It takes rows and returns decisions, so the
 * rules that govern a child's ring name and a child's face can be unit-tested
 * without a database, the same split wallDisplay.ts takes for the same reason.
 * The reads live in profileDb.ts; the visibility gate lives in
 * profileVisibility.ts.
 *
 * ---------------------------------------------------------------------------
 * THIS FILE MUST NEVER LEARN ABOUT HEALTH, CLEARANCE, INJURY OR CONDUCT.
 *
 * A portrait, a ring name and a corner colour are decoration on a person's own
 * space. Readiness, medical clearance, near-miss reports, assessments and
 * discipline are claims about a person's body and behaviour. The moment the
 * two share a surface, a personal preference starts reading as a status and a
 * status starts reading as a preference -- which is the failure Law 2 exists
 * to prevent. profileIdentity.privacy.test.ts asserts this file and its
 * siblings never name those tables.
 * ---------------------------------------------------------------------------
 */

/** Red corner, blue corner, or not chosen. 'none' is a real state, not a null. */
export type CornerChoice = 'red' | 'blue' | 'none';

export const CORNER_CHOICES: readonly CornerChoice[] = ['red', 'blue', 'none'];

/**
 * The corner, in words. Law 3: the dye is never the only channel, so every
 * surface that shows a corner also prints this.
 */
export const CORNER_LABEL: Readonly<Record<CornerChoice, string>> = {
  red: 'Red corner',
  blue: 'Blue corner',
  none: 'No corner chosen',
};

export function normalizeCorner(raw: unknown): CornerChoice {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  return value === 'red' || value === 'blue' ? value : 'none';
}

/**
 * THE PROGRAMMES.
 *
 * This gym is not one thing. It runs a fitness-only membership, an adult
 * recreational class, a youth mentorship programme and a competitive squad,
 * and the platform had no field that said which -- `gym_status` is
 * active/training/inactive, a membership state, and reading it as a programme
 * would have printed "ACTIVE" on a card where the programme belongs.
 *
 * So the vocabulary is stated here and the column is new. The order is
 * deliberate and it is not a ladder: 'competitive' is last because it is the
 * smallest group, not because it is the top. Nothing in this file or on the
 * card ranks them.
 */
export type ProgramChoice =
  | 'fitness'
  | 'recreational'
  | 'youth_mentorship'
  | 'competitive'
  | 'unstated';

export const PROGRAM_CHOICES: readonly ProgramChoice[] = [
  'fitness',
  'recreational',
  'youth_mentorship',
  'competitive',
  'unstated',
];

/**
 * Every programme gets a full, finished sentence of a label. None of them is
 * phrased as a lesser version of another -- there is no "non-competitive", no
 * "general", no "other". A member who comes in three mornings a week to hit a
 * bag is on the FITNESS PROGRAMME, which is a thing you are on, not a thing
 * you failed to be.
 */
export const PROGRAM_LABEL: Readonly<Record<ProgramChoice, string>> = {
  fitness: 'Fitness Programme',
  recreational: 'Adult Recreational Programme',
  youth_mentorship: 'Youth Mentorship Programme',
  competitive: 'Competitive Programme',
  unstated: 'Programme not recorded',
};

export function normalizeProgram(raw: unknown): ProgramChoice {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  return (PROGRAM_CHOICES as readonly string[]).includes(value)
    ? (value as ProgramChoice)
    : 'unstated';
}

/* ---------------------------------------------------------------- NICKNAME --
 * THE RING NAME, AND HOW THIS PLATFORM MODERATES IT.
 *
 * A ring name is self-set free text on a platform that holds records for
 * children, and a coach -- possibly a roster -- will read it. That is a
 * moderation problem and it is answered here deliberately rather than left to
 * a wordlist.
 *
 * WHAT IS NOT DONE, AND WHY
 *   No profanity filter. A blocklist on a children's platform buys the wrong
 *   thing: it produces confident-looking green ticks while missing every
 *   creative spelling that actually gets used, and it flags real surnames and
 *   real Spanish and real nicknames along the way. Shipping one would let
 *   everyone downstream believe the field had been checked when it had not.
 *
 * WHAT IS DONE INSTEAD -- three mechanisms, none of which pretends to read
 * meaning:
 *
 *   1. SHAPE. Hard length cap and a character allow-list (below). A ring name
 *      cannot be a URL, an email address, a phone number, an emoji wall, a
 *      block of text, or anything with control characters or bidi overrides in
 *      it. Most abuse of a free-text field is delivery, and this closes the
 *      delivery.
 *
 *   2. SCOPE. A minor's ring name is scoped exactly as their photograph is
 *      (profileVisibility.ts): themselves, their assigned coaches, their linked
 *      guardians. It never reaches another family, a public page, or the wall.
 *      An unmoderated string that only three named parties can read is a much
 *      smaller problem than a moderated one that a room can read.
 *
 *   3. TAKEDOWN. Any of the athlete's assigned coaches, any organization admin,
 *      and any linked guardian can clear a ring name outright, immediately,
 *      with no appeal step -- and clearing locks the field so the same string
 *      cannot be typed straight back in. Every set and every clear writes an
 *      audit event, so "who put that there" is answerable.
 *
 * The honest summary: the platform bounds the shape, keeps the audience tiny,
 * and gives the adults who know the child an instant undo. It does not claim
 * to know whether a name is appropriate, because it cannot.
 * -------------------------------------------------------------------------- */

/** Long enough for "The Punxsutawney Kid" (20). Short enough to be a name. */
export const NICKNAME_MAX_LENGTH = 24;
export const NICKNAME_MIN_LENGTH = 2;

/**
 * How long a cleared ring name stays cleared. The point is not punishment, it
 * is that a takedown has to outlast the argument -- an athlete who can retype
 * the string thirty seconds later has not been moderated, and the coach is now
 * in a loop instead of a conversation.
 */
export const NICKNAME_LOCK_HOURS = 72;

export type NicknameRejection =
  | 'too_short'
  | 'too_long'
  | 'disallowed_characters'
  | 'no_letters'
  | 'looks_like_contact_detail'
  | 'locked_by_staff';

export interface NicknameValidation {
  readonly ok: boolean;
  readonly value?: string;
  readonly reason?: NicknameRejection;
}

/**
 * Letters (including accented ones), digits, spaces, and the three marks that
 * appear inside real names: apostrophe, hyphen, period. Nothing else. No
 * slashes, no @, no colons, no angle brackets, no emoji, no zero-width or
 * bidi controls -- the last of those matter because they render as nothing and
 * can reorder the text a coach reads.
 */
const NICKNAME_ALLOWED = /^[\p{L}\p{N} '.\-]+$/u;
const NICKNAME_HAS_LETTER = /\p{L}/u;

/**
 * Shapes that are a contact detail wearing a name's clothes. Caught by shape
 * rather than by meaning: a ring name is never a way to hand a stranger a
 * phone number, and these three patterns survive the character allow-list.
 */
const CONTACT_SHAPES: readonly RegExp[] = [
  /\d{7,}/,                       // a run of digits long enough to be a number
  /\b(?:\d[ .-]?){9,}/,           // a spaced or dotted phone number
  /\b(?:www|http|https)\b/iu,     // a URL that survived losing its punctuation
];

export function normalizeNickname(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw
    // Control characters, zero-width joiners and bidi overrides, first: they
    // are invisible, so anything measured before they are gone is measuring
    // the wrong string.
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function validateNickname(raw: unknown): NicknameValidation {
  const value = normalizeNickname(raw);

  if (value.length < NICKNAME_MIN_LENGTH) return { ok: false, reason: 'too_short' };
  // Counted in code points, not UTF-16 units, so an astral character costs one
  // and a 24-character cap is 24 characters rather than 12.
  if ([...value].length > NICKNAME_MAX_LENGTH) return { ok: false, reason: 'too_long' };
  if (!NICKNAME_ALLOWED.test(value)) return { ok: false, reason: 'disallowed_characters' };
  if (!NICKNAME_HAS_LETTER.test(value)) return { ok: false, reason: 'no_letters' };
  if (CONTACT_SHAPES.some((pattern) => pattern.test(value))) {
    return { ok: false, reason: 'looks_like_contact_detail' };
  }

  return { ok: true, value };
}

export const NICKNAME_REJECTION_MESSAGE: Readonly<Record<NicknameRejection, string>> = {
  too_short: `A ring name needs at least ${NICKNAME_MIN_LENGTH} characters.`,
  too_long: `A ring name can be at most ${NICKNAME_MAX_LENGTH} characters.`,
  disallowed_characters: 'A ring name can use letters, numbers, spaces, apostrophes, hyphens and periods.',
  no_letters: 'A ring name needs at least one letter in it.',
  looks_like_contact_detail: 'A ring name cannot contain a phone number or a web address.',
  locked_by_staff: 'Your ring name was cleared by the gym. Talk to your coach before setting a new one.',
};

/** Whether a clear is still holding the field shut. */
export function isNicknameLocked(
  clearedAt: string | Date | null | undefined,
  now: Date,
): boolean {
  if (!clearedAt) return false;
  const at = clearedAt instanceof Date ? clearedAt : new Date(clearedAt);
  if (Number.isNaN(at.getTime())) {
    // An unreadable timestamp means the field was cleared and the record of
    // when is broken. Treat it as still locked: the safe reading of "somebody
    // took this down" is not "so it is fine now".
    return true;
  }
  return now.getTime() - at.getTime() < NICKNAME_LOCK_HOURS * 60 * 60 * 1000;
}

/* -------------------------------------------------------------- INITIALS -- */

/**
 * The initials struck into the brass plate when there is no photograph -- and
 * there is no photograph most of the time, by design.
 *
 * At most two, because three letters on a 55px plate stop being legible on a
 * gym tablet. Falls back to the two-letter form of whatever it was given, and
 * finally to a single struck dash, so the plate is never blank: an empty plate
 * reads as a broken image, which is exactly what this component exists to
 * avoid.
 */
export function initialsFor(fullName: string | null | undefined): string {
  const cleaned = normalizeNickname(fullName ?? '');
  if (!cleaned) return '—';

  const words = cleaned.split(' ').filter((word) => NICKNAME_HAS_LETTER.test(word));
  if (words.length === 0) return '—';

  const first = [...words[0]][0] ?? '';
  const last = words.length > 1 ? [...words[words.length - 1]][0] ?? '' : '';
  const initials = `${first}${last}`.toUpperCase();
  return initials || '—';
}

/* ------------------------------------------------------- TIME AT THE GYM -- */

/**
 * How long they have been here, in the words a person would use. Deliberately
 * coarse: a card says "two years at the gym", not a joining date, because an
 * exact date on a child's card is a data point about a child that the card has
 * no use for.
 */
export function timeAtGym(since: string | Date | null | undefined, now: Date): string | null {
  if (!since) return null;
  const start = since instanceof Date ? since : new Date(since);
  if (Number.isNaN(start.getTime())) return null;

  const days = Math.floor((now.getTime() - start.getTime()) / 86_400_000);
  if (days < 0) return null;
  if (days < 30) return 'New this month';
  const months = Math.floor(days / 30.4375);
  if (months < 12) return months === 1 ? '1 month at the gym' : `${months} months at the gym`;
  const years = Math.floor(days / 365.25);
  return years === 1 ? '1 year at the gym' : `${years} years at the gym`;
}

/* ------------------------------------------------------------ FIGHT CARD -- */

/**
 * A member's card as it goes to the client.
 *
 * `photoUrl` is a route on this platform, never a storage URL and never a
 * signed one -- see profile/photo/[accountId]. Null means the viewer gets the
 * brass plate, and the card does not say why: a viewer being told "this child
 * has a photograph you may not see" is itself a disclosure about that child.
 */
export interface FightCard {
  readonly accountId: string;
  readonly displayName: string;
  readonly initials: string;
  readonly ringName: string | null;
  readonly corner: CornerChoice;
  readonly cornerLabel: string;
  readonly program: ProgramChoice;
  readonly programLabel: string;
  readonly coachName: string | null;
  readonly coachAccountId: string | null;
  readonly coachPhotoAvailable: boolean;
  readonly coachInitials: string | null;
  readonly timeAtGym: string | null;
  readonly photoAvailable: boolean;
}

export interface FightCardInput {
  readonly accountId: string;
  readonly fullName: string;
  readonly ringName: string | null;
  readonly corner: CornerChoice;
  readonly program: ProgramChoice;
  readonly coachName: string | null;
  readonly coachAccountId: string | null;
  readonly coachPhotoAvailable: boolean;
  readonly memberSince: string | Date | null;
  readonly photoAvailable: boolean;
}

export function buildFightCard(input: FightCardInput, now: Date): FightCard {
  return {
    accountId: input.accountId,
    displayName: input.fullName,
    initials: initialsFor(input.fullName),
    ringName: input.ringName,
    corner: input.corner,
    cornerLabel: CORNER_LABEL[input.corner],
    program: input.program,
    programLabel: PROGRAM_LABEL[input.program],
    coachName: input.coachName,
    coachAccountId: input.coachAccountId,
    coachPhotoAvailable: input.coachPhotoAvailable,
    coachInitials: input.coachName ? initialsFor(input.coachName) : null,
    timeAtGym: timeAtGym(input.memberSince, now),
    photoAvailable: input.photoAvailable,
  };
}
