import { athleteVoiceSeverity } from './athleteVoice';
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
 * - The message names a coach or other gym staff: filed as 'athlete_voice',
 *   which every coach-scoped read excludes. The coach of record may be who the
 *   child is telling on, and even the existence of a disclosure tells them
 *   (escalationLadder.ts EscalationListFilters). Overwatch's hard-floor
 *   exception to section 3, 2026-10-15.
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
 */
const GYM_STAFF_PATTERN = new RegExp(
  '\\b(?:'
  + [
    'coach', 'coaches', 'coachs', 'coaching', 'coch', 'cooch', 'couch',
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
  ].join('|')
  + ')\\b',
);

export function namesGymStaff(message: string): boolean {
  return GYM_STAFF_PATTERN.test(normalizeForSafetyScan(message));
}

export interface ShadowDisclosure {
  /** Scan cue ids. In process only: never persisted, never returned. */
  readonly cues: readonly string[];
  readonly namesGymStaff: boolean;
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
  return { cues: scan.cues, namesGymStaff: namesGymStaff(message) };
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

/** Fixed on purpose: it renders wherever the escalation does, so it quotes nothing. */
export const SHADOW_DISCLOSURE_REASON =
  'An athlete said something in SHADOW chat that needs a person to read it. '
  + 'Admins read the message on the SHADOW reviews page.';

export function shadowDisclosureSourceType(disclosure: ShadowDisclosure): SafetyEscalationSourceType {
  return disclosure.namesGymStaff ? 'athlete_voice' : 'shadow_disclosure';
}

export interface FileShadowDisclosureParams {
  organizationId: string;
  /** The sender's own athlete record (principal.athleteId); null files nothing. */
  athleteId: string | null;
  conversationId: string | null;
  disclosure: ShadowDisclosure;
}

/**
 * Files the escalation, or returns null when the sender has no athlete record
 * (safety_escalations.athlete_id is NOT NULL). The admin SHADOW review row is
 * the route's, as for every high-risk message.
 */
export async function fileShadowDisclosureEscalation(
  params: FileShadowDisclosureParams,
): Promise<SafetyEscalationRow | null> {
  if (!params.athleteId) return null;
  const sourceType = shadowDisclosureSourceType(params.disclosure);
  return fileEscalation({
    organizationId: params.organizationId,
    sourceType,
    sourceId: null,
    athleteId: params.athleteId,
    severity: athleteVoiceSeverity(params.disclosure.cues),
    reason: SHADOW_DISCLOSURE_REASON,
    escalatedToRole: sourceType === 'athlete_voice' ? 'organization_admin' : 'coach',
    triggeredBy: 'system',
    // The pointer only: metadata is readable wherever the row is.
    metadata: { channel: 'shadow_chat', conversation_id: params.conversationId },
  });
}
