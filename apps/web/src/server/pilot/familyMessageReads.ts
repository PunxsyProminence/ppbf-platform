/*
 * WHETHER THE FAMILY OPENED A PARENT MESSAGE (#1542, FC-05).
 *
 * A guardian's first open of a coach's parent message is written to
 * pilot.family_message_reads (FC-04): one row per message per guardian, the
 * first time kept. "Opened" is the parent hub's to decide (FC-05 Q-1 default
 * A: at least half of that message on screen on the Messages tab); fetching
 * the inbox is not a read.
 *
 * Staff see, per note, whether the family opened it and when it was first
 * opened -- never which guardian, and not how many (FC-04 Q-C, FC-05 Q-2).
 */
import { query, queryOne } from './db';
import { NotFoundError } from './errors';
import { isGuardianLinkedToAthlete } from './guardianAccess';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The same sentence the replies route uses for a note that is not this
// guardian's to touch: which of the reasons it was is not theirs to learn.
const NOT_YOURS = 'Not found: that message is not on your page.';

const ISO_UTC = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;

/**
 * Record that this guardian opened this message. The note must be a parent
 * message in this gym about a child linked to them on this request. A second
 * open is the same row, and the first time stays; the answer is that time.
 */
export async function recordFamilyMessageRead(input: {
  organizationId: string;
  accountId: string;
  noteId: string;
}): Promise<{ note_id: string; first_read_at: string }> {
  if (!UUID.test(input.noteId)) {
    throw new NotFoundError(NOT_YOURS);
  }
  const note = await queryOne<{ athlete_id: string }>(
    `select athlete_id
       from pilot.coach_observations
      where organization_id = $1 and note_id = $2::uuid and note_type = 'parent_message'`,
    [input.organizationId, input.noteId],
  );
  if (!note || !(await isGuardianLinkedToAthlete(input.organizationId, input.accountId, note.athlete_id))) {
    throw new NotFoundError(NOT_YOURS);
  }

  const row = await queryOne<{ first_read_at: string }>(
    `with written as (
       insert into pilot.family_message_reads (organization_id, note_id, athlete_id, reader_account_id, reader_role)
       values ($1, $2::uuid, $3, $4, 'parent')
       on conflict (organization_id, note_id, reader_account_id) do nothing
       returning first_read_at
     )
     select to_char(first_read_at at time zone 'UTC', ${ISO_UTC}) as first_read_at from written
     union all
     select to_char(r.first_read_at at time zone 'UTC', ${ISO_UTC})
       from pilot.family_message_reads r
      where r.organization_id = $1 and r.note_id = $2::uuid and r.reader_account_id = $4
        and not exists (select 1 from written)`,
    [input.organizationId, input.noteId, note.athlete_id, input.accountId],
  );
  if (!row) {
    throw new Error('Unable to record the read.');
  }
  return { note_id: input.noteId, first_read_at: row.first_read_at };
}

export interface FamilyReadStateForStaff {
  note_id: string;
  first_read_at: string;
}

/**
 * For one athlete's parent messages, the ones the family has opened and the
 * first time any guardian did. A note absent from the list has not been
 * opened. No reader, account or count.
 */
export async function listFamilyReadStateForStaff(
  organizationId: string,
  athleteId: string,
): Promise<FamilyReadStateForStaff[]> {
  return query<FamilyReadStateForStaff>(
    `select r.note_id::text as note_id,
            to_char(min(r.first_read_at) at time zone 'UTC', ${ISO_UTC}) as first_read_at
       from pilot.family_message_reads r
      where r.organization_id = $1
        and r.athlete_id = $2
      group by r.note_id
      order by r.note_id`,
    [organizationId, athleteId],
  );
}
