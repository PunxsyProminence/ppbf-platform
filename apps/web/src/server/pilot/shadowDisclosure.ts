import { athleteVoiceSeverity } from './athleteVoice';
import { queryOne } from './db';
import {
  fileEscalation,
  type SafetyEscalationRow,
  type SafetyEscalationSourceType,
} from './escalationLadder';
import { normalizeForSafetyScan, scanForSafetyLanguage } from './feedbackSafetyScan';
import type { ShadowValidationResult } from './shadowChat';

/**
 * F-076: a child's disclosure typed into SHADOW chat reached no person.
 *
 * The same sentence in the athlete "Tell us" box is caught by
 * scanForSafetyLanguage and escalated (athleteVoice.ts). SHADOW chat never ran
 * that scan. This module runs it for an athlete's SHADOW message and files the
 * in-app safety escalation Jason ruled for an athlete-scoped high-risk SHADOW
 * message (OD-2026-10-01-008 section 3, applied to F-076 by OD-2026-10-15-002):
 * the athlete's coach of record, any coach actively covering them, and admins.
 * No email, text or push -- the escalation list is the only channel.
 *
 * SHADOW STILL ANSWERS (OD-2026-10-10-007). The mark this module adds to the
 * request carries no topic and no fallback classification, so the answer, its
 * banner and its review flag are what they were. What the mark does change:
 * the admin SHADOW review row becomes owed, and the words are kept out of the
 * research "Library gap" feed (shadowResearchFiling.ts requestHighRisk).
 *
 * WHO IS TOLD. Two routes, decided per message:
 * - The message names a coach or other gym staff, carries a grooming, secrecy
 *   or touch cue, or comes in a conversation that already filed admin-only:
 *   filed as 'athlete_voice', which every coach-scoped read excludes. The
 *   coach of record may be who the child is telling on, and even the
 *   existence of a disclosure tells them (escalationLadder.ts
 *   EscalationListFilters). Overwatch's hard-floor exception to section 3,
 *   2026-10-15, widened by the L18 adversarial reviews.
 * - Otherwise: filed as 'shadow_disclosure', which coach-scoped reads keep,
 *   so the coach of record and the covering coach see it with the admins.
 *
 * NON-DISCLOSING, like athleteVoice: a fixed reason and the conversation
 * pointer only. Never the message, never the matched cues.
 */

/**
 * Cues that alone are a medical question, not a disclosure. "My legs are sore
 * after roadwork" trips pain_or_injury, and SHADOW already handles it as a
 * personal health question. A message whose only cues are these files nothing
 * (Overwatch, 2026-10-15, item D) -- unless it names a person at the gym
 * ("coach hurt my arm on purpose", "coach broke my nose"), which files
 * admin-only (Overwatch, 2026-10-15, decision 2).
 */
export const SHADOW_DISCLOSURE_MEDICAL_ONLY_CUES: readonly string[] = ['pain_or_injury', 'broken_bone'];

const MEDICAL_ONLY = new Set(SHADOW_DISCLOSURE_MEDICAL_ONLY_CUES);

/**
 * Words that name a coach or other gym staff, matched against the safety
 * scan's normalized form (lowercase, no apostrophes, punctuation as spaces).
 * Errs broad: a false match only narrows the alert to admins, who see every
 * disclosure anyway; a miss warns the person the child may be telling on.
 * Titles count ("Mr Dave", "sir", "Miss Sarah"): a child names an adult at
 * the gym by title and first name far more often than by role.
 */
function wordList(words: readonly string[]): RegExp {
  return new RegExp(`\\b(?:${words.join('|')})\\b`);
}

/**
 * A person at the gym, said plainly enough to act on: decides item D's
 * carve-out and the staff-harm marker below, where a false match would file
 * an alert.
 */
const GYM_PERSON_WORDS: readonly string[] = [
  'coach', 'coaches', 'coachs', 'coaching', 'coch', 'cooch', 'coatch', 'caoch', 'coahc', 'coack', 'choach', 'coachh',
  'head coach', 'assistant coach',
  'mr', 'mrs', 'mister', 'sir',
  'trainer', 'trainers', 'instructor', 'instructors',
  'staff', 'staffer', 'volunteer', 'volunteers', 'sensei', 'cornerman', 'corner man',
  'adult at the gym', 'adults at the gym', 'grown up at the gym', 'man at the gym',
  'guy at the gym', 'lady at the gym', 'woman at the gym', 'someone at the gym',
  'runs the gym', 'owns the gym', 'holds the pads', 'holds pads', 'holds the mitts',
  'entrenador', 'entrenadora', 'profe',
];

/**
 * Everything that may point at gym staff, for routing only: a false match
 * here just narrows an alert that is already being filed to admins.
 */
const GYM_STAFF_ROUTING_WORDS: readonly string[] = [
  ...GYM_PERSON_WORDS,
  'couch', 'ms', 'miss', 'maam', 'madam',
  'helper', 'helpers', 'teacher', 'teachers', 'mentor',
  'cutman', 'cut man', 'referee', 'ref', 'judge',
  'manager', 'owner', 'boss', 'director', 'admin', 'supervisor', 'chaperone',
  'at the gym', 'in the gym', 'at boxing', 'at practice', 'at the club',
  'in the locker room', 'locker room', 'in the office',
];

const GYM_PERSON_PATTERN = wordList(GYM_PERSON_WORDS);
const GYM_STAFF_PATTERN = wordList(GYM_STAFF_ROUTING_WORDS);

/**
 * Digits typed for letters ("c0ach") and a word spelled out letter by letter
 * ("c o a c h") are folded back before matching.
 */
function foldForStaffMatch(normalized: string): string {
  return normalized
    .replace(/[0-9]/g, (digit) => ({ 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't' } as Record<string, string>)[digit] ?? digit)
    .replace(/\b(?:[a-z] ){2,}[a-z]\b/g, (run) => run.replace(/ /g, ''));
}

function matchesStaffForm(message: string, pattern: RegExp): boolean {
  // Both elongation readings, as the safety scan itself does: "coachhh"
  // collapses to "coachh" at two letters and to "coach" fully.
  const normalized = foldForStaffMatch(normalizeForSafetyScan(message));
  const fullyCollapsed = normalized.replace(/(.)\1+/g, '$1');
  return pattern.test(normalized) || pattern.test(fullyCollapsed);
}

export function namesGymStaff(message: string): boolean {
  return matchesStaffForm(message, GYM_STAFF_PATTERN);
}

export function namesGymPerson(message: string): boolean {
  return matchesStaffForm(message, GYM_PERSON_PATTERN);
}

/**
 * Boxing-technique context (Overwatch, 2026-10-15, decision 1, option A). The
 * Tell us cues read ordinary sparring talk as harm: "how do I keep my guard
 * up when he punches me?" is someone_is_hurting_me. With any of these words
 * present a message files nothing, unless it also carries an override marker
 * (SHADOW_DISCLOSURE_OVERRIDE_CUES, staff harm, SPARRING_INTENT_WORDS, or
 * OUTSIDE_GYM_WORDS).
 * OD-2026-10-10-007: an ordinary sparring question must reach nobody's list.
 */
//
// Every word here is boxing-only. Words with an everyday sense are left out on
// purpose: "partner" (a mom's partner), "guard" (a security guard), "fight"
// (a fight at home), "bag", "match", "cross", "block", "counter".
export const BOXING_CONTEXT_WORDS: readonly string[] = [
  'spar', 'spars', 'sparring', 'sparred', 'sparing', 'sparring partner', 'spar partner', 'drill partner',
  'jab', 'jabs', 'hook', 'hooks', 'uppercut', 'uppercuts', 'combo', 'combos', 'combination', 'combinations',
  'my guard', 'guard up', 'hands up', 'slip', 'slipping', 'blocking punches', 'block punches', 'parry', 'footwork', 'stance',
  'pads', 'pad work', 'mitts', 'mitt work', 'heavy bag', 'speed bag', 'bag work',
  'rounds', 'gloves', 'glove', 'headgear', 'mouthguard', 'drill', 'drills',
  'fight night', 'first fight', 'next fight', 'my bout', 'bout', 'bouts', 'tournament', 'opponent',
  'getting hit', 'get hit', 'got hit', 'take a punch', 'taking punches',
];

/**
 * A person outside the gym, or a place outside it. Boxing words never
 * suppress a message that names one: "my dad hits me when we spar" files.
 */
export const OUTSIDE_GYM_WORDS: readonly string[] = [
  'dad', 'daddy', 'father', 'mom', 'mommy', 'mum', 'mother', 'stepdad', 'stepmom', 'stepfather', 'stepmother',
  'brother', 'sister', 'uncle', 'aunt', 'grandpa', 'grandma', 'grandfather', 'grandmother', 'cousin',
  'boyfriend', 'girlfriend', 'babysitter', 'foster', 'parents', 'parent',
  'at home', 'at school', 'my house', 'his house', 'her house',
];

/**
 * Words that say the harm was meant, which a sparring question does not.
 * "makes me" is deliberately absent: "sparring makes me nervous" is ordinary.
 */
export const SPARRING_INTENT_WORDS: readonly string[] = [
  'on purpose', 'purpose', 'wont stop', 'wouldnt stop', 'didnt stop', 'doesnt stop', 'keeps going after',
  'after practice', 'after class', 'after training',
  'i said stop', 'i told him to stop', 'i told her to stop', 'told them to stop', 'when i say stop', 'even when i tap',
  'after i tapped', 'after the bell', 'after time',
];

/** Cues that file even in boxing context. */
export const SHADOW_DISCLOSURE_OVERRIDE_CUES: readonly string[] = [
  'crisis', 'crisis_indirect', 'grooming_or_isolation', 'secrecy', 'does_not_feel_safe',
];

/** Cues that, with a person at the gym named, are staff harm and file in boxing context. */
const STAFF_HARM_CUES: ReadonlySet<string> = new Set([
  'someone_is_hurting_me', 'contact_with_body_part', 'pain_or_injury', 'broken_bone',
  'someone_is_frightening_me', 'harm_to_someone_else',
]);

const BOXING_CONTEXT_PATTERN = wordList(BOXING_CONTEXT_WORDS);
const OUTSIDE_GYM_PATTERN = wordList(OUTSIDE_GYM_WORDS);
const SPARRING_INTENT_PATTERN = wordList(SPARRING_INTENT_WORDS);
const OVERRIDE_CUES: ReadonlySet<string> = new Set(SHADOW_DISCLOSURE_OVERRIDE_CUES);

/**
 * Cues that go admin-only whoever is named. Grooming and secrecy are how an
 * adult at the gym is described without being named ("Dave touches me when
 * everyone leaves", "he says its our secret"), so a missing staff word proves
 * nothing about who it is.
 */
export const SHADOW_DISCLOSURE_ADMIN_ONLY_CUES: readonly string[] = ['grooming_or_isolation', 'secrecy'];

const ADMIN_ONLY_CUES = new Set(SHADOW_DISCLOSURE_ADMIN_ONLY_CUES);

/** Being touched, said any way the scan's normal form can hold it. */
const TOUCH_PATTERN = /\b(?:touch|touches|touched|touching|toucher)\b/;

export interface ShadowDisclosure {
  /** Scan cue ids. In process only: never persisted, never returned. */
  readonly cues: readonly string[];
  readonly namesGymStaff: boolean;
  /** Filed admin-only: names gym staff, or carries a grooming, secrecy or touch cue. */
  readonly adminOnly: boolean;
}

/**
 * The disclosure in an athlete's SHADOW message, or null. Athletes only: the
 * lane brief scopes F-076 to an athlete's own message, whose athlete scope is
 * the sender's own record.
 */
export function detectShadowDisclosure(message: string, role: string): ShadowDisclosure | null {
  if (role !== 'athlete') return null;
  const scan = scanForSafetyLanguage(message);
  if (!scan.safeguarding) return null;
  const normalized = normalizeForSafetyScan(message);
  const person = namesGymPerson(message);
  if (!person && scan.cues.every((cue) => MEDICAL_ONLY.has(cue))) return null;
  if (BOXING_CONTEXT_PATTERN.test(normalized)) {
    const overridden = scan.cues.some((cue) => OVERRIDE_CUES.has(cue))
      || (person && scan.cues.some((cue) => STAFF_HARM_CUES.has(cue)))
      || SPARRING_INTENT_PATTERN.test(normalized)
      || OUTSIDE_GYM_PATTERN.test(normalized);
    if (!overridden) return null;
  }
  const staff = namesGymStaff(message);
  const adminOnly = staff
    || scan.cues.some((cue) => ADMIN_ONLY_CUES.has(cue))
    || TOUCH_PATTERN.test(normalized);
  return { cues: scan.cues, namesGymStaff: staff, adminOnly };
}

/** A disclosure the Tell us box would file 'critical'. Its review row takes the critical allowance. */
export function isCriticalShadowDisclosure(disclosure: ShadowDisclosure | null): boolean {
  return disclosure !== null && athleteVoiceSeverity(disclosure.cues) === 'critical';
}

/** Not a FALLBACK_RESPONSES key, so the answer is unchanged. */
export const SHADOW_DISCLOSURE_CLASSIFICATION = 'safeguarding_disclosure';

/**
 * main's emergency returns (validateShadowRequest's urgent_personal_symptom
 * return and its emergency topic rows), the same set the chat route reviews
 * as critical. A disclosure never displaces them.
 */
const EMERGENCY_CLASSIFICATIONS: ReadonlySet<string> = new Set([
  'urgent_personal_symptom', 'chest_pain', 'fainting', 'loss_of_consciousness',
]);

function isEmergencyReturn(validation: ShadowValidationResult): boolean {
  return EMERGENCY_CLASSIFICATIONS.has(validation.classification ?? '')
    || (validation.error ?? '').startsWith('Potential emergency');
}

/**
 * Marks a disclosure high-risk when the validator did not.
 *
 * F-093: a disclosure that also trips one of the validator's non-emergency
 * medical withholds ("my coach hits me and it hurts" read as a personal pain
 * question; a diagnosis, clearance or medication question) is answered on the
 * disclosure path, exactly as the same disclosure without the pain word:
 * SHADOW still answers (OD-2026-10-10-007). The emergency return stays
 * ahead of a disclosure (OD-2026-10-10-006; Overwatch, F-093 Q1), and a
 * result that is already high-risk and allowed is main's. The escalation
 * files in every case; this decides only the answer.
 */
export function markShadowDisclosure(
  validation: ShadowValidationResult,
  disclosure: ShadowDisclosure | null,
): ShadowValidationResult {
  if (!disclosure) return validation;
  if (validation.highRisk !== true) {
    return { ...validation, highRisk: true, classification: SHADOW_DISCLOSURE_CLASSIFICATION };
  }
  if (validation.valid || isEmergencyReturn(validation)) return validation;
  return { valid: true, highRisk: true, topic: validation.topic, classification: SHADOW_DISCLOSURE_CLASSIFICATION };
}

/**
 * Fixed on purpose: it renders wherever the escalation does, so it quotes
 * nothing. It does not promise the words are on the reviews page: that row is
 * bounded at three an hour per account (OD-2026-10-01-006 s2) and names a
 * stored message only when one was stored.
 */
export const SHADOW_DISCLOSURE_REASON =
  'An athlete said something in SHADOW chat that needs a person to follow up. '
  + 'Admins may find the message on the SHADOW reviews page; if it is not there, speak with the athlete.';

export function shadowDisclosureSourceType(disclosure: Pick<ShadowDisclosure, 'adminOnly'>): SafetyEscalationSourceType {
  return disclosure.adminOnly ? 'athlete_voice' : 'shadow_disclosure';
}

export interface FileShadowDisclosureParams {
  organizationId: string;
  /** The sender's own athlete record (principal.athleteId); null files nothing. */
  athleteId: string | null;
  conversationId: string | null;
  disclosure: ShadowDisclosure;
}

/**
 * A conversation in which the athlete has already named gym staff stays
 * admin-only: "my coach yells at me" followed by "he touched me" must not
 * reach the coach on the second message.
 */
async function conversationAlreadyNamedStaff(params: FileShadowDisclosureParams): Promise<boolean> {
  if (!params.conversationId) return false;
  const row = await queryOne<{ found: boolean }>(
    `select true as found from pilot.safety_escalations
     where organization_id = $1 and athlete_id = $2 and source_type = 'athlete_voice'
       and metadata->>'channel' = 'shadow_chat' and metadata->>'conversation_id' = $3
     limit 1`,
    [params.organizationId, params.athleteId, params.conversationId],
  );
  return Boolean(row?.found);
}

function escalationInput(params: FileShadowDisclosureParams & { athleteId: string }, sourceType: SafetyEscalationSourceType) {
  return {
    organizationId: params.organizationId,
    sourceType,
    sourceId: null,
    athleteId: params.athleteId,
    severity: athleteVoiceSeverity(params.disclosure.cues),
    reason: SHADOW_DISCLOSURE_REASON,
    escalatedToRole: sourceType === 'athlete_voice' ? ('organization_admin' as const) : ('coach' as const),
    triggeredBy: 'system' as const,
    // The pointer only: metadata is readable wherever the row is.
    metadata: { channel: 'shadow_chat', conversation_id: params.conversationId },
  };
}

/**
 * Files the escalation, or returns null when the sender has no athlete record
 * (safety_escalations.athlete_id is NOT NULL). The admin SHADOW review row is
 * the route's, as for every high-risk message.
 *
 * A database whose source_type CHECK predates 'shadow_disclosure' (code
 * deployed before pilot:apply-safety-escalations) rejects the row with 23514.
 * The disclosure is then filed admin-only as 'athlete_voice', which every
 * revision of the CHECK admits: narrower than ruled, never lost.
 */
export async function fileShadowDisclosureEscalation(
  params: FileShadowDisclosureParams,
): Promise<SafetyEscalationRow | null> {
  if (!params.athleteId) return null;
  const withAthlete = { ...params, athleteId: params.athleteId };
  const adminOnly = params.disclosure.adminOnly || await conversationAlreadyNamedStaff(withAthlete);
  const sourceType = shadowDisclosureSourceType({ adminOnly });
  try {
    return await fileEscalation(escalationInput(withAthlete, sourceType));
  } catch (error) {
    if (sourceType !== 'shadow_disclosure' || (error as { code?: unknown }).code !== '23514') throw error;
    return fileEscalation(escalationInput(withAthlete, 'athlete_voice'));
  }
}
