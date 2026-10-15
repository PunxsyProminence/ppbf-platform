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
 * (Overwatch, 2026-10-15, item D). With any other cue present it files.
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
const GYM_STAFF_PATTERN = new RegExp(
  '\\b(?:'
  + [
    'coach', 'coaches', 'coachs', 'coaching', 'coch', 'cooch', 'couch', 'coatch', 'caoch', 'coahc', 'coack', 'choach', 'coachh',
    'mr', 'mrs', 'ms', 'miss', 'mister', 'sir', 'maam', 'madam',
    'head coach', 'assistant coach',
    'trainer', 'trainers', 'instructor', 'instructors',
    'staff', 'staffer', 'volunteer', 'volunteers', 'helper', 'helpers',
    'sensei', 'teacher', 'teachers', 'mentor',
    'cornerman', 'corner man', 'cutman', 'cut man', 'referee', 'ref', 'judge',
    'manager', 'owner', 'boss', 'director', 'admin', 'supervisor', 'chaperone',
    'adult at the gym', 'adults at the gym', 'grown up at the gym', 'man at the gym',
    'guy at the gym', 'lady at the gym', 'woman at the gym', 'someone at the gym',
    'at the gym', 'in the gym', 'at boxing', 'at practice', 'at the club',
    'in the locker room', 'locker room', 'in the office',
    'runs the gym', 'owns the gym', 'holds the pads', 'holds pads', 'holds the mitts',
    'entrenador', 'entrenadora', 'profe',
  ].join('|')
  + ')\\b',
);

/**
 * Digits typed for letters ("c0ach") and a word spelled out letter by letter
 * ("c o a c h") are folded back before matching.
 */
function foldForStaffMatch(normalized: string): string {
  return normalized
    .replace(/[0-9]/g, (digit) => ({ 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't' } as Record<string, string>)[digit] ?? digit)
    .replace(/\b(?:[a-z] ){2,}[a-z]\b/g, (run) => run.replace(/ /g, ''));
}

export function namesGymStaff(message: string): boolean {
  // Both elongation readings, as the safety scan itself does: "coachhh"
  // collapses to "coachh" at two letters and to "coach" fully.
  const normalized = foldForStaffMatch(normalizeForSafetyScan(message));
  const fullyCollapsed = normalized.replace(/(.)\1+/g, '$1');
  return GYM_STAFF_PATTERN.test(normalized) || GYM_STAFF_PATTERN.test(fullyCollapsed);
}

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
  if (scan.cues.every((cue) => MEDICAL_ONLY.has(cue))) return null;
  const staff = namesGymStaff(message);
  const adminOnly = staff
    || scan.cues.some((cue) => ADMIN_ONLY_CUES.has(cue))
    || TOUCH_PATTERN.test(normalizeForSafetyScan(message));
  return { cues: scan.cues, namesGymStaff: staff, adminOnly };
}

/** Not a FALLBACK_RESPONSES key and not in the route's critical list, so the answer is unchanged. */
export const SHADOW_DISCLOSURE_CLASSIFICATION = 'safeguarding_disclosure';

/**
 * Marks a disclosure high-risk when the validator did not. A result that is
 * already high-risk, or withheld, is returned as it is: its answer is main's.
 */
export function markShadowDisclosure(
  validation: ShadowValidationResult,
  disclosure: ShadowDisclosure | null,
): ShadowValidationResult {
  if (!disclosure || validation.highRisk === true) return validation;
  return { ...validation, highRisk: true, classification: SHADOW_DISCLOSURE_CLASSIFICATION };
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
