/*
 * GUARDIAN REPLIES TO A PARENT MESSAGE (#1542, FC-03).
 *
 * A coach or admin posts a parent message (pilot.coach_observations,
 * note_type 'parent_message'). A guardian linked to that note's athlete may
 * answer it, under that message; the gym's staff read the answers under the
 * note they posted. Stored in pilot.family_message_replies (FC-02), which is
 * append-only: a reply is never edited or deleted, and a correction is a
 * second reply.
 *
 * Who reads what (Jason's ruling, and the FC-03 defaults on #1542):
 *   - A guardian reads only their OWN replies. With two guardians of one
 *     child, neither sees the other's. listOwnReplies keys on the author.
 *   - Staff of the athlete's gym read every reply on that athlete's parent
 *     messages, with the guardian's name from the parent record (Q-D A).
 *     The route gates the athlete (assertActorCanAccessAthlete).
 *   - The athlete reads none of it (Q-C A).
 *
 * A reply holds only what a guardian wrote; there is no staff-only field on
 * it to strip. Nothing is sent (no email, no push): a reply is there when a
 * coach opens the athlete's family notes.
 */
import { randomUUID } from 'node:crypto';

import { query, queryOne } from './db';
import { NotFoundError, ValidationError } from './errors';
import { isGuardianLinkedToAthlete } from './guardianAccess';

export const FAMILY_REPLY_MAX_LENGTH = 2000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// One sentence for a forged id, another gym's note, a note that is not a
// parent message, and a child this guardian is no longer linked to: which of
// those it was is not this caller's to learn.
const NOT_YOURS = 'Not found: that message is not on your page.';

const ISO_UTC = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;

export interface FamilyMessageReply {
  reply_id: string;
  note_id: string;
  reply_text: string;
  created_at: string;
}

export interface FamilyMessageReplyForStaff extends FamilyMessageReply {
  author_name: string;
}

export async function createFamilyMessageReply(input: {
  organizationId: string;
  accountId: string;
  noteId: string;
  replyText: string;
}): Promise<FamilyMessageReply> {
  const text = input.replyText.trim();
  if (!text) {
    throw new ValidationError('Write a reply before sending.');
  }
  if (text.length > FAMILY_REPLY_MAX_LENGTH) {
    throw new ValidationError(`A reply is at most ${FAMILY_REPLY_MAX_LENGTH} characters.`);
  }
  if (!UUID.test(input.noteId)) {
    throw new NotFoundError(NOT_YOURS);
  }

  const note = await queryOne<{ athlete_id: string }>(
    `select athlete_id
       from pilot.coach_observations
      where organization_id = $1 and note_id = $2::uuid and note_type = 'parent_message'`,
    [input.organizationId, input.noteId],
  );
  // Linked now, on this request: a guardian unlinked since their last read,
  // or whose child has turned 18, holds a stale note id and it stops here.
  if (!note || !(await isGuardianLinkedToAthlete(input.organizationId, input.accountId, note.athlete_id))) {
    throw new NotFoundError(NOT_YOURS);
  }

  const reply = await queryOne<FamilyMessageReply>(
    `insert into pilot.family_message_replies
       (organization_id, reply_id, note_id, athlete_id, author_account_id, author_role, reply_text)
     values ($1, $2::uuid, $3::uuid, $4, $5, 'parent', $6)
     returning reply_id::text as reply_id, note_id::text as note_id, reply_text,
               to_char(created_at at time zone 'UTC', ${ISO_UTC}) as created_at`,
    [input.organizationId, randomUUID(), input.noteId, note.athlete_id, input.accountId, text],
  );
  if (!reply) {
    throw new Error('Unable to record the reply.');
  }
  return reply;
}

/**
 * This guardian's own replies, on messages about the children in scope now
 * (guardianAthleteIds, resolved by the caller on this request). Oldest first.
 * An empty scope reads nothing.
 */
export async function listOwnReplies(
  organizationId: string,
  accountId: string,
  athleteIdsInScope: readonly string[],
): Promise<FamilyMessageReply[]> {
  if (athleteIdsInScope.length === 0) return [];
  return query<FamilyMessageReply>(
    `select reply_id::text as reply_id, note_id::text as note_id, reply_text,
            to_char(created_at at time zone 'UTC', ${ISO_UTC}) as created_at
       from pilot.family_message_replies
      where organization_id = $1
        and author_account_id = $2
        and athlete_id = any($3::text[])
      order by created_at asc, reply_id asc`,
    [organizationId, accountId, [...athleteIdsInScope]],
  );
}

/**
 * Every reply on one athlete's parent messages, for the gym's staff. Oldest
 * first. The name is the guardian's parent record in this gym; an account
 * since removed (author_account_id set null) reads "A guardian".
 */
export async function listRepliesForStaff(
  organizationId: string,
  athleteId: string,
): Promise<FamilyMessageReplyForStaff[]> {
  const rows = await query<FamilyMessageReply & { author_name: string | null }>(
    `select r.reply_id::text as reply_id, r.note_id::text as note_id, r.reply_text,
            to_char(r.created_at at time zone 'UTC', ${ISO_UTC}) as created_at,
            (select min(p.full_name)
               from pilot.parents p
              where p.organization_id = r.organization_id
                and p.account_id = r.author_account_id) as author_name
       from pilot.family_message_replies r
      where r.organization_id = $1
        and r.athlete_id = $2
      order by r.created_at asc, r.reply_id asc`,
    [organizationId, athleteId],
  );
  return rows.map((row) => ({ ...row, author_name: row.author_name?.trim() || 'A guardian' }));
}
