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
// (scopeToReachableSubjects, mayReadRequirement); this shapes what is left.

import { isOrganizationAdminRole } from './access';
import type { PilotRole } from './contracts';
import { isResearchStaff, type ShadowResearchRequirementRow } from './shadowResearch';
import type { ResearchSubmissionRow } from './shadowResearchSubmissions';

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

export function isAskerFiledQuestion(
  row: Pick<ShadowResearchRequirementRow, 'source_event_name' | 'created_by_role'>,
): boolean {
  return row.source_event_name === ASKER_QUESTION_EVENT
    && !isResearchStaff(row.created_by_role as PilotRole);
}

/** The stored row as a COACH receives it when it is an asker's question. */
export function toCoachAskerQuestion(row: ShadowResearchRequirementRow): ShadowResearchRequirementRow {
  return {
    ...row,
    source_entity_id: String(row.research_requirement_id),
    research_requirement: ASKER_QUESTION_COACH_SENTENCE,
    knowledge_gap: ASKER_QUESTION_COACH_SENTENCE,
    evidence_label: null,
    created_by_account_id: '',
    metadata: { closing_note: (row.metadata ?? {}).closing_note ?? null },
  };
}

/** A stored row for a research-staff reader: whole, except a coach's view of
 *  an asker's question. */
export function wholeResearchRowFor(
  role: PilotRole | null | undefined,
  row: ShadowResearchRequirementRow,
): ShadowResearchRequirementRow {
  if (role && isOrganizationAdminRole(role)) return row;
  return isAskerFiledQuestion(row) ? toCoachAskerQuestion(row) : row;
}

export function researchRequirementsForReader(
  reader: ResearchReader,
  rows: ShadowResearchRequirementRow[],
): Array<ShadowResearchRequirementRow | FamilyResearchRequirement> {
  if (!readsWholeResearchRows(reader.role)) {
    return rows.map((row) => toFamilyResearchRequirement(reader, row));
  }
  // Staff get the stored rows themselves; only a coach's view of an asker's
  // question is rebuilt, so a list with none comes back as it was read.
  return rows.some(isAskerFiledQuestion) ? rows.map((row) => wholeResearchRowFor(reader.role, row)) : rows;
}

export function researchSubmissionsForReader(
  reader: Pick<ResearchReader, 'role'>,
  rows: ResearchSubmissionRow[],
  onPlatformShelf: boolean,
): Array<ResearchSubmissionRow | FamilyResearchSubmission> {
  return readsWholeResearchSubmissions(reader.role, onPlatformShelf) ? rows : rows.map(toFamilyResearchSubmission);
}
