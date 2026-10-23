// What a reader who is not research staff receives from the two SHADOW
// research reads (#1475 Part F, audit finding F-036).
//
// Both reads returned the stored row. An athlete or parent who could read a
// requirement about their athlete so received the account ids of the staff who
// filed, closed, submitted and reviewed it (a staff account id is a sign-in
// email), the reviewer's free-text notes, and the row's whole metadata object,
// which on an intake-review row holds the staff reviewer's note on the case.
//
// Each answer here is BUILT FROM NAMED FIELDS. Nothing is spread from the row
// and nothing is deleted from it, so a column or metadata key a later writer
// adds stays out until someone names it below.
//
// Rulings (docs/current/OWNER_DECISIONS.md):
// - OD-2026-10-06-025 "Show coach name, hide ID": no account id in a family
//   answer. No name is added: no family screen shows an author on these rows.
// - OD-2026-10-06-003 (CL-A3) "Staff only": that ruling's staff, coaches and
//   organization admins (isResearchStaff), are who receive the stored rows.
// - OD-2026-10-06-010 "Family reads, staff closes": on a question about their
//   child the family keeps the text a coach wrote: the requirement, the gap
//   and the closing note, all of which /research shows them.
// - OD-2026-10-11-008 "strip them" names workout-template and session-script
//   fields, not these. Its principle (staff text no family screen shows or
//   uses is not sent) is applied here on Overwatch's reading, 2026-10-13, to
//   the intake reviewer's notes, submission_note, review_note, provenance and
//   evidence_label: working notes about a case or a source, not the question.
//
// WHO SEES WHICH ROW is not decided here. The routes scope first
// (scopeToReachableSubjects, readableRequirement); this shapes what is left.

import { isOrganizationAdminRole } from './access';
import type { PilotRole } from './contracts';
import { isResearchStaff, type ShadowResearchRequirementRow } from './shadowResearch';
import type { ResearchSubmissionRow } from './shadowResearchSubmissions';
import { SHADOW_PROJECTION_READ_ROLES } from './shadowRoleSets';

export interface ResearchReader {
  accountId: string;
  role: PilotRole;
}

/** A requirement as a reader outside research staff receives it. */
export interface FamilyResearchRequirement {
  research_requirement_id: ShadowResearchRequirementRow['research_requirement_id'];
  source_event_name: string;
  research_requirement: string;
  knowledge_gap: string;
  source_status: string;
  source_confidence_tier: string;
  source_verification_state: string;
  status: ShadowResearchRequirementRow['status'];
  created_at: string;
  resolved_at: string | null;
  /** In place of created_by_account_id: did this reader file the row? */
  is_mine: boolean;
  /** One named key, in the shape /research already reads. */
  metadata: { closing_note: string | null };
}

/** A submission as a reader outside research staff receives it. */
export interface FamilyResearchSubmission {
  submission_id: string;
  research_requirement_id: ResearchSubmissionRow['research_requirement_id'];
  applicability_state: ResearchSubmissionRow['applicability_state'];
  created_at: string;
  reviewed_at: string | null;
}

/**
 * Whole rows go to coaches and organization admins only. Any other role,
 * including one this code does not know and a missing one, gets the family
 * view.
 */
export function readsWholeResearchRows(role: PilotRole | null | undefined): boolean {
  return typeof role === 'string' && isResearchStaff(role);
}

/**
 * The platform shelf's submissions go whole to the platform owner, who
 * works that shelf and reviews on it (OD-2026-10-02-013 answer 1B;
 * OD-2026-10-02-015 D2). The role is asked again here rather than taken from
 * the shelf check upstream.
 */
export function readsWholeResearchSubmissions(
  role: PilotRole | null | undefined,
  onPlatformShelf: boolean,
): boolean {
  return readsWholeResearchRows(role) || (onPlatformShelf && role === 'platform_owner');
}

export function toFamilyResearchRequirement(
  reader: Pick<ResearchReader, 'accountId'>,
  row: ShadowResearchRequirementRow,
): FamilyResearchRequirement {
  // The closing note is the record of a close. An open row carries none,
  // whatever its metadata was created with.
  const closingNote = row.status === 'resolved' ? (row.metadata ?? {}).closing_note : null;

  return {
    research_requirement_id: row.research_requirement_id,
    source_event_name: row.source_event_name,
    research_requirement: row.research_requirement,
    knowledge_gap: row.knowledge_gap,
    source_status: row.source_status,
    source_confidence_tier: row.source_confidence_tier,
    source_verification_state: row.source_verification_state,
    status: row.status,
    created_at: row.created_at,
    resolved_at: row.resolved_at,
    is_mine: row.created_by_account_id === reader.accountId,
    metadata: { closing_note: typeof closingNote === 'string' ? closingNote : null },
  };
}

export function toFamilyResearchSubmission(row: ResearchSubmissionRow): FamilyResearchSubmission {
  return {
    submission_id: row.submission_id,
    research_requirement_id: row.research_requirement_id,
    applicability_state: row.applicability_state,
    created_at: row.created_at,
    reviewed_at: row.reviewed_at,
  };
}

/* AN ATHLETE'S OR PARENT'S UNANSWERED QUESTION (F-054, Jason 2026-10-13
 * "A: Office + asker (Recommended)", on OD-2026-10-07-009 ruling 4's principle:
 * a child's words are not for the whole coaching staff).
 *
 * SHADOW files an unanswered question as a research row the asker's own
 * words fill. For THAT row the organization admin reads the words, the asker
 * reads their own (the family view above), and a COACH sees only that a
 * question went unanswered. The row is told apart by the event it was filed
 * under and by who filed it: a row a coach or admin filed themselves is theirs
 * and stays whole. Not by caller-supplied metadata, which a writer chooses.
 *
 * A coach is sent a row with the words, the asker's account id and the key
 * removed. The key is `acct:<account id>:<the question, normalized>`, so
 * replacing only the two text fields would still hand the words and the
 * asker over in source_entity_id. */
export const ASKER_QUESTION_EVENT = 'shadow_unanswered_question';
// PROPOSED copy.
export const ASKER_QUESTION_COACH_SENTENCE =
  'A question from an athlete or parent that SHADOW could not answer. The gym administrator can read it.';
/* The free text staff write ON such a row (the closing note, a submission's
 * note and its review note) can quote or answer the question, so a coach gets
 * this in place of any of them, and nothing where there was none (lane L52,
 * Overwatch 2026-10-18 on the ruling above). PROPOSED copy. */
export const ASKER_QUESTION_NOTE_SENTENCE = 'The gym administrator can read this note.';

function coachNote(note: unknown): string {
  return typeof note === 'string' && note.trim() !== '' ? ASKER_QUESTION_NOTE_SENTENCE : '';
}

export function isAskerFiledQuestion(
  row: Pick<ShadowResearchRequirementRow, 'source_event_name' | 'created_by_role'>,
): boolean {
  return row.source_event_name === ASKER_QUESTION_EVENT
    && !isResearchStaff(row.created_by_role as PilotRole);
}

/* AN ATHLETE'S OR PARENT'S NOTE ON A SHADOW ANSWER (F-183). The learning loop
 * files a negative rating as a research row whose knowledge_gap and
 * metadata.note are the rater's own note, under their account and role
 * (shadowLearningLoop.ts, createResearchRequirementFromNegativeSignal). The
 * same ruling reaches it (OD-2026-10-13-018, applied by Overwatch 2026-10-23
 * under "asked once, ruled once": the words are a kid's or parent's own, typed
 * into SHADOW), so it takes the same split, told apart by who filed it.
 *
 * WHO FILED decides, and the ruling names the people: an athlete's or
 * parent's note reaches a coach as this sentence. Unlike the F-054 row, adult
 * seats outside research staff can rate SHADOW too (feedback POST admits
 * volunteer, staff and platform_owner), and their notes are not the ruling's,
 * so they stay as they are, like a coach's or admin's own. A role this code
 * does not know, or none, is treated as an athlete's: the words stay out.
 * PROPOSED copy. */
export const LEARNING_NOTE_EVENT = 'shadow_learning_negative_outcome';
export const LEARNING_NOTE_COACH_SENTENCE =
  'Feedback on a SHADOW answer, filed for research. The gym administrator can read it.';

export function isMemberFiledLearningNote(
  row: Pick<ShadowResearchRequirementRow, 'source_event_name' | 'created_by_role'>,
): boolean {
  if (row.source_event_name !== LEARNING_NOTE_EVENT) return false;
  const filer = row.created_by_role;
  return filer === 'athlete' || filer === 'parent'
    || !(SHADOW_PROJECTION_READ_ROLES as readonly string[]).includes(filer);
}

/** A row a coach receives without the words in it (F-054, F-183). */
export function carriesMemberWords(
  row: Pick<ShadowResearchRequirementRow, 'source_event_name' | 'created_by_role'>,
): boolean {
  return isAskerFiledQuestion(row) || isMemberFiledLearningNote(row);
}

/** The stored row as a COACH receives it when it carries a member's words.
 *  Built from NAMED fields, like the family view: a column a later writer adds
 *  stays out until someone names it here. The kind of asker (created_by_role),
 *  the key, the account id, the label and the metadata are not named; a
 *  closing note is replaced, not copied. */
export function toCoachAskerQuestion(row: ShadowResearchRequirementRow): ShadowResearchRequirementRow {
  const sentence = row.source_event_name === LEARNING_NOTE_EVENT
    ? LEARNING_NOTE_COACH_SENTENCE
    : ASKER_QUESTION_COACH_SENTENCE;
  const meta = row.metadata ?? {};
  const closing: Record<string, unknown> = {};
  if (coachNote(meta.closing_note)) closing.closing_note = ASKER_QUESTION_NOTE_SENTENCE;
  if (typeof meta.closing_submission_id === 'string') closing.closing_submission_id = meta.closing_submission_id;
  return {
    research_requirement_id: row.research_requirement_id,
    organization_id: row.organization_id,
    source_event_name: row.source_event_name,
    source_entity_type: row.source_entity_type,
    source_entity_id: String(row.research_requirement_id),
    research_requirement: sentence,
    knowledge_gap: sentence,
    evidence_label: null,
    source_status: row.source_status,
    source_confidence_tier: row.source_confidence_tier,
    source_verification_state: row.source_verification_state,
    status: row.status,
    created_by_account_id: '',
    created_by_role: '',
    metadata: closing,
    created_at: row.created_at,
    resolved_at: row.resolved_at,
    subject_id: null,
  };
}

/** A stored row for a research-staff reader: whole, except a coach's view of
 *  a row that carries a member's words. */
export function wholeResearchRowFor(
  role: PilotRole | null | undefined,
  row: ShadowResearchRequirementRow,
): ShadowResearchRequirementRow {
  if (role && isOrganizationAdminRole(role)) return row;
  return carriesMemberWords(row) ? toCoachAskerQuestion(row) : row;
}

export function researchRequirementsForReader(
  reader: ResearchReader,
  rows: ShadowResearchRequirementRow[],
): Array<ShadowResearchRequirementRow | FamilyResearchRequirement> {
  if (!readsWholeResearchRows(reader.role)) {
    return rows.map((row) => toFamilyResearchRequirement(reader, row));
  }
  // Staff get the stored rows themselves; only a coach's view of a row that
  // carries a member's words is rebuilt, so a list with none comes back as it
  // was read.
  return rows.some(carriesMemberWords) ? rows.map((row) => wholeResearchRowFor(reader.role, row)) : rows;
}

/** A submission on an asker's question as a COACH receives it: the source,
 *  the verdict and when, not what anyone wrote about the case. Named fields;
 *  the submitter and reviewer are staff, never the asker. */
export function toCoachAskerSubmission(row: ResearchSubmissionRow): ResearchSubmissionRow {
  return {
    organization_id: row.organization_id,
    submission_id: row.submission_id,
    research_requirement_id: row.research_requirement_id,
    source_id: row.source_id,
    document_id: row.document_id,
    provenance: {},
    submission_note: coachNote(row.submission_note),
    applicability_state: row.applicability_state,
    reviewed_by_account_id: row.reviewed_by_account_id,
    reviewed_at: row.reviewed_at,
    review_note: coachNote(row.review_note),
    submitted_by_account_id: row.submitted_by_account_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/** `requirement` is the stored row the submissions hang off, as the route
 *  read it to scope the request: whether it carries a member's words is a
 *  fact about that row, not about the submissions. */
export function researchSubmissionsForReader(
  reader: Pick<ResearchReader, 'role'>,
  rows: ResearchSubmissionRow[],
  onPlatformShelf: boolean,
  requirement: Pick<ShadowResearchRequirementRow, 'source_event_name' | 'created_by_role'>,
): Array<ResearchSubmissionRow | FamilyResearchSubmission> {
  if (!readsWholeResearchSubmissions(reader.role, onPlatformShelf)) return rows.map(toFamilyResearchSubmission);
  if (reader.role && isOrganizationAdminRole(reader.role)) return rows;
  return carriesMemberWords(requirement) ? rows.map(toCoachAskerSubmission) : rows;
}
