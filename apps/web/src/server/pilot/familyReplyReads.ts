/*
 * WHICH GUARDIAN REPLIES A STAFF MEMBER HAS SEEN (#1542's track, FC-09b).
 *
 * The coach panel under "On the family's page" shows each note with the
 * guardian replies under it (FC-03). A reply counts as seen by THIS staff
 * member when at least half of it is on screen in that panel (the FC-05 Q-1 A
 * rule, applied to replies); loading the panel is not a read. The first time
 * is written to pilot.family_reply_reads (FC-09): one row per reply per staff
 * account, the first time kept.
 *
 * Per staff account: "new to me" is each coach's own, so one coach seeing a
 * reply does not make it seen for another. A staff member reads only their own
 * reads. Nothing here is served to a family.
 *
 * Who: coach, organization admin and admin of the reply's gym, and the reply's
 * athlete reachable by them (assertActorCanAccessAthlete, the replies route's
 * gate: the whole gym, OD-2026-10-11-007). The database guard also requires
 * the reader to hold that role through an active seat in the gym.
 */
import { assertActorCanAccessAthlete, requireRole } from './access';
import type { PilotRole } from './contracts';
import { query, queryOne } from './db';
import { ForbiddenError, NotFoundError } from './errors';

export const REPLY_READER_ROLES: PilotRole[] = ['coach', 'organization_admin', 'admin'];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// One sentence for a forged id, another gym's reply and a reply whose athlete
// this staff member cannot reach: which of those it was is not theirs to learn.
const NOT_HERE = 'Not found: that reply is not in your gym.';

export interface ReplyReader {
  organizationId: string;
  accountId: string;
  role: PilotRole;
}

/**
 * Record that this staff member has seen this reply. A second look is the
 * same row, and the first time stays.
 */
export async function recordFamilyReplyRead(reader: ReplyReader, replyId: string): Promise<{ reply_id: string }> {
  requireRole({ ...reader, athleteId: null }, REPLY_READER_ROLES);
  if (!UUID.test(replyId)) {
    throw new NotFoundError(NOT_HERE);
  }
  const reply = await queryOne<{ athlete_id: string }>(
    `select athlete_id from pilot.family_message_replies
      where organization_id = $1 and reply_id = $2::uuid`,
    [reader.organizationId, replyId],
  );
  if (!reply) {
    throw new NotFoundError(NOT_HERE);
  }
  try {
    await assertActorCanAccessAthlete({ ...reader, athleteId: null }, reply.athlete_id);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Forbidden')) throw new NotFoundError(NOT_HERE);
    throw error;
  }

  try {
    await query(
      `insert into pilot.family_reply_reads (organization_id, reply_id, reader_account_id, reader_role)
       values ($1, $2::uuid, $3, $4)
       on conflict (organization_id, reply_id, reader_account_id) do nothing`,
      [reader.organizationId, replyId, reader.accountId, reader.role],
    );
  } catch (error) {
    // The guard's refusal of a reader without a live seat in this gym.
    if ((error as { constraint?: unknown }).constraint === 'pilot_family_reply_reads_reader_of_this_gym') {
      throw new ForbiddenError('Forbidden: no active staff seat in this gym.');
    }
    throw error;
  }
  return { reply_id: replyId };
}

/**
 * The replies on one athlete's parent messages that this staff member has
 * already seen. Only their own reads, never another staff member's.
 */
export async function listOwnReplyReads(
  organizationId: string,
  accountId: string,
  athleteId: string,
): Promise<Array<{ reply_id: string }>> {
  return query<{ reply_id: string }>(
    `select rr.reply_id::text as reply_id
       from pilot.family_reply_reads rr
       join pilot.family_message_replies r
         on r.organization_id = rr.organization_id and r.reply_id = rr.reply_id
      where rr.organization_id = $1
        and rr.reader_account_id = $2
        and r.athlete_id = $3
      order by rr.reply_id`,
    [organizationId, accountId, athleteId],
  );
}
