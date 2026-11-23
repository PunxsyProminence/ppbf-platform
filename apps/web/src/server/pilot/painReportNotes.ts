import type { PoolClient } from 'pg';

import { athleteVoiceSeverity } from './athleteVoice';
import { queryOne, withTransaction } from './db';
import { NotFoundError } from './errors';
import { fileEscalation, type SafetyEscalationSourceType } from './escalationLadder';
import { detectShadowDisclosure, type ShadowDisclosure } from './shadowDisclosure';
import { writeShadowAuditEntry } from './shadowAuditEntries';

/**
 * DR-25 (Jason 2026-11-23, DR-25 A, to be recorded: "A: Add both"): the athlete's optional note on
 * a pain report, and the coach's "Mark reviewed". Overwatch's GO on PR #2133 (Q1-Q6 A) rules who
 * reads them: exactly the coach pain list's readers (coach, organization_admin, admin, per
 * athlete). Parents and athletes read neither. The columns are on pilot.shadow_near_misses
 * (pilot_slice_postgres_pain_report_review_migration.sql); only the files pinned in
 * painReportReviewReaders.test.ts may name them.
 */

/** The longest note, in characters; the database check holds the same limit. */
export { PAIN_NOTE_MAX } from '@/src/shared/painNote';
import { PAIN_NOTE_MAX } from '@/src/shared/painNote';

/** Characters btrim strips in the database check: space, tab, carriage return, line feed. */
const EDGE_WHITESPACE = /^[ \t\r\n]+|[ \t\r\n]+$/g;

/** Invisible format characters (zero-width space and joiners, BOM, direction marks). */
const FORMAT_CHARACTERS = /\p{Cf}/gu;

/**
 * The note as it will be stored: trimmed, and null when nothing visible is left (whitespace and
 * invisible format characters only). 'invalid' for anything that is not a string, a note holding
 * a NUL (Postgres text cannot store one, and the failed write would take the whole pain report
 * with it), or a note over the limit. Counted in characters (code points), as Postgres's
 * char_length counts them, so an accented note is not cut short.
 */
export function normalizePainNote(value: unknown): string | null | 'invalid' {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.includes('\u0000')) return 'invalid';
  const trimmed = value.trim().replace(EDGE_WHITESPACE, '');
  if (trimmed.replace(FORMAT_CHARACTERS, '').trim().length === 0) return null;
  return [...trimmed].length > PAIN_NOTE_MAX ? 'invalid' : trimmed;
}

export interface PainNoteVerdict {
  /** True when only admins may read the note: it names gym staff, or a grooming, secrecy or touch cue. */
  readonly adminOnly: boolean;
  /** The disclosure, in process only: never persisted, never returned. Null when the scan found none. */
  readonly disclosure: ShadowDisclosure | null;
}

/**
 * The note's safety-scan verdict, by the SHADOW chat rules (shadowDisclosure.ts): the same scan
 * and carve-outs, and the same admin-only routing. OD-2026-10-01-008 section 3 as applied by
 * OD-2026-10-15-002, with Overwatch's 2026-10-15 hard-floor admin-only exception, applied to this
 * new free-text channel from a minor by Overwatch's GO on PR #2133 (Q3 A).
 *
 * Plain pain and injury words alone are not a disclosure, so most notes pass. But a note that
 * also names gym staff ("coach wrapped it, my wrist hurts") is admin-only under that ruling, as
 * the same sentence is in SHADOW chat: coaches are not shown it and an admin is told. The cost was
 * put to Overwatch on PR #2138.
 */
export function painNoteVerdict(note: string): PainNoteVerdict {
  const disclosure = detectShadowDisclosure(note, 'athlete');
  return { adminOnly: disclosure?.adminOnly ?? false, disclosure };
}

/**
 * The verdict, and STILL ADMIN-ONLY ONCE STAFF WERE NAMED: the pain-note form of SHADOW chat's
 * conversationAlreadyNamedStaff (shadowDisclosure.ts). "My coach hits me" is admin-only; the
 * same child's next note, "he hit me again", names nobody and would otherwise go to the coach of
 * record, who may be "he". So a disclosing note is admin-only too when the athlete has:
 *   - any earlier pain-note escalation filed admin-only ('athlete_voice'), whatever its status;
 *   - any earlier note stored admin-only, even if its escalation failed to file; or
 *   - any 'athlete_voice' escalation from ANY channel (SHADOW chat, the Tell us box) that is not
 *     yet resolved: Overwatch Q10 B on #2138, under Jason's Q7 ruling "A: Keep strict" -- a child
 *     who already named staff elsewhere is where keeping it from coaches matters most. "Open" is
 *     read as not resolved, so an acknowledged one still counts.
 * A note that discloses nothing is unaffected.
 */
export async function painNoteVerdictFor(
  note: string,
  context: { organizationId: string; athleteId: string },
): Promise<PainNoteVerdict> {
  const verdict = painNoteVerdict(note);
  if (verdict.disclosure === null || verdict.adminOnly) return verdict;
  // Either record counts: the escalation, or the stored verdict, which commits
  // with its pain report even when the escalation could not be filed (PR 2
  // reviewers A and B). A failed lookup FAILS CLOSED: the note is held for
  // admins, and the pain report is still stored, with the same answer to the
  // athlete as any other note (PR 2 reviewer B).
  let earlier: { found: boolean } | null;
  try {
    earlier = await queryOne<{ found: boolean }>(
      `select (
         exists (select 1 from pilot.safety_escalations
                  where organization_id = $1 and athlete_id = $2 and source_type = 'athlete_voice'
                    and (metadata->>'channel' = 'pain_report_note' or status <> 'resolved'))
         or exists (select 1 from pilot.shadow_near_misses
                     where organization_id = $1 and athlete_id = $2 and athlete_note_admin_only)
       ) as found`,
      [context.organizationId, context.athleteId],
    );
  } catch (error) {
    console.error('[pain-report-note] earlier-note lookup failed; holding the note for admins', {
      error: error instanceof Error ? error.message.split('\n')[0] : String(error),
    });
    return { ...verdict, adminOnly: true };
  }
  return earlier?.found ? { ...verdict, adminOnly: true } : verdict;
}

/** Fixed on purpose: the reason renders on the escalation surface, so it never quotes the note. */
export const PAIN_NOTE_ESCALATION_REASON =
  'An athlete wrote a note on a pain report that needs a person to read it. '
  + 'Read it on the pain report list; if it is not there, speak with the athlete.';

/**
 * Stores the note and its verdict on the near miss, inside flagNearMiss's transaction (its
 * withinTransaction hook), so a pain report and its note commit together. The verdict is written
 * with the note every time: the database refuses a note without one.
 */
export async function storePainNote(
  client: PoolClient,
  near: { organizationId: string; nearMissId: string },
  note: string,
  verdict: PainNoteVerdict,
): Promise<void> {
  await client.query(
    `update pilot.shadow_near_misses
        set athlete_note = $3, athlete_note_admin_only = $4
      where organization_id = $1 and near_miss_id = $2::uuid`,
    [near.organizationId, near.nearMissId, note, verdict.adminOnly],
  );
}

function escalationFor(
  input: { organizationId: string; athleteId: string; nearMissId: string },
  disclosure: ShadowDisclosure,
  sourceType: SafetyEscalationSourceType,
) {
  return {
    organizationId: input.organizationId,
    sourceType,
    sourceId: null,
    athleteId: input.athleteId,
    severity: athleteVoiceSeverity(disclosure.cues),
    reason: PAIN_NOTE_ESCALATION_REASON,
    escalatedToRole: sourceType === 'athlete_voice' ? ('organization_admin' as const) : ('coach' as const),
    triggeredBy: 'system' as const,
    // The pointer only: metadata is readable wherever the row is. Never the note, never the cues.
    metadata: { channel: 'pain_report_note', near_miss_id: input.nearMissId },
  };
}

/**
 * Files the escalation a disclosing note owes, AFTER the pain report has committed. An admin-only
 * note files 'athlete_voice', which every coach-scoped read excludes; any other disclosure files
 * 'shadow_disclosure', which the coach of record and admins see (shadowDisclosure.ts).
 *
 * NEVER THROWS. Whether this files, fails or does nothing must not change what the athlete's
 * screen says: any difference only on a disclosing note is a classifier oracle for whoever is
 * sitting next to the child (athleteVoice.ts property 3). A failure is logged without the note.
 * The note itself is already stored with its verdict, so a failure here never shows an
 * admin-only note to a coach. A database whose source_type check predates 'shadow_disclosure'
 * files it as 'athlete_voice' instead: narrower than ruled, never lost.
 */
export async function filePainNoteEscalation(
  input: { organizationId: string; athleteId: string; nearMissId: string },
  verdict: PainNoteVerdict,
): Promise<void> {
  const { disclosure } = verdict;
  if (!disclosure) return;
  const sourceType: SafetyEscalationSourceType = verdict.adminOnly ? 'athlete_voice' : 'shadow_disclosure';
  try {
    try {
      await fileEscalation(escalationFor(input, disclosure, sourceType));
    } catch (error) {
      if (sourceType !== 'shadow_disclosure' || (error as { code?: unknown }).code !== '23514') throw error;
      await fileEscalation(escalationFor(input, disclosure, 'athlete_voice'));
    }
  } catch (error) {
    console.error('[pain-report-note] escalation filing failed', {
      nearMissId: input.nearMissId,
      error: error instanceof Error ? error.message.split('\n')[0] : String(error),
    });
  }
}

/**
 * The metadata marker every pain-report near miss is written with (painReportAlert.ts reads and
 * writes through this one constant). A stored value: changing it orphans every report on file.
 */
export const PAIN_REPORT_NEAR_MISS_TRIGGER = 'athlete_pain_report';
const PAIN_REPORT_TRIGGER = PAIN_REPORT_NEAR_MISS_TRIGGER;

export interface PainReportReviewResult {
  readonly athleteId: string;
  readonly reviewedAt: string;
  readonly reviewedByAccountId: string | null;
}

/**
 * The athlete a pain report is about, or null when the organization has no pain report by that id
 * (a malformed id, another gym's report and a near miss that is not a pain report all answer null).
 */
export async function painReportAthlete(
  client: PoolClient,
  organizationId: string,
  nearMissId: string,
): Promise<string | null> {
  const result = await client.query<{ athlete_id: string }>(
    `select athlete_id from pilot.shadow_near_misses
      where organization_id = $1 and near_miss_id::text = lower($2) and metadata->>'trigger' = $3`,
    [organizationId, nearMissId, PAIN_REPORT_TRIGGER],
  );
  return result.rows[0]?.athlete_id ?? null;
}

/**
 * Marks one pain report reviewed, FIRST REVIEW WINS: a second press returns the first reviewer and
 * time unchanged. The caller has already gated the role and the athlete (the coach pain list's
 * gate); `authorize` runs inside the transaction with the row's athlete, after the row is found
 * and before anything is written, and throws to refuse. A missing report is a 404.
 */
export async function markPainReportReviewed(input: {
  organizationId: string;
  nearMissId: string;
  actorAccountId: string;
  actorRole: string;
  authorize: (athleteId: string) => Promise<void>;
}): Promise<PainReportReviewResult> {
  return withTransaction(async (client) => {
    const athleteId = await painReportAthlete(client, input.organizationId, input.nearMissId);
    if (athleteId === null) {
      throw new NotFoundError('Pain report not found.', 'PAIN_REPORT_NOT_FOUND');
    }
    await input.authorize(athleteId);

    const updated = await client.query<{ near_miss_id: string; reviewed_at: Date }>(
      `update pilot.shadow_near_misses
          set reviewed_by_account_id = $3, reviewed_at = now()
        where organization_id = $1 and near_miss_id::text = lower($2) and reviewed_at is null
        returning near_miss_id::text, reviewed_at`,
      [input.organizationId, input.nearMissId, input.actorAccountId],
    );
    if (updated.rows[0]) {
      await writeShadowAuditEntry(client, {
        organizationId: input.organizationId,
        entityType: 'near_miss',
        entityId: updated.rows[0].near_miss_id,
        action: 'reviewed',
        actorAccountId: input.actorAccountId,
        actorRole: input.actorRole,
        afterState: { reviewed: true },
      });
      return {
        athleteId,
        reviewedAt: new Date(updated.rows[0].reviewed_at).toISOString(),
        reviewedByAccountId: input.actorAccountId,
      };
    }

    const existing = await client.query<{ reviewed_by_account_id: string | null; reviewed_at: Date }>(
      `select reviewed_by_account_id, reviewed_at from pilot.shadow_near_misses
        where organization_id = $1 and near_miss_id::text = lower($2)`,
      [input.organizationId, input.nearMissId],
    );
    const row = existing.rows[0];
    if (!row) {
      throw new NotFoundError('Pain report not found.', 'PAIN_REPORT_NOT_FOUND');
    }
    return {
      athleteId,
      reviewedAt: new Date(row.reviewed_at).toISOString(),
      reviewedByAccountId: row.reviewed_by_account_id,
    };
  });
}
