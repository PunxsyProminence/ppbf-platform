import { randomUUID } from 'node:crypto';

import { type ActorIdentity, assertActorCanAccessAthlete } from './access';
import { getCoachDisplayName } from './achievements';
import { writePilotAuditEvent } from './audit';
import { query, queryOne, withTransaction } from './db';
import { ForbiddenError, NotFoundError, ValidationError } from './errors';

/**
 * Athlete capacity notes: module 013's one slice, "physical capacity note
 * field on athlete or session (coach write, read own/assigned)"
 * (OD-2026-10-08-002, C1 item 1). Overwatch's design call (2026-10-08): per
 * ATHLETE, dated, kept as history newest first, written by a coach who
 * reaches the athlete or the organization admin, read by staff who reach the
 * athlete.
 *
 * A NOTE IS THE COACH'S WORDS AND NOTHING ELSE. Plain text, length-capped.
 * This module never parses a number out of a note, never scores one, never
 * derives a metric, and never changes a safety gate from one: module 013's
 * boundaries (no automatic safety-gate changes, no invented sensor metrics,
 * no board individual rows) and OD-2026-09-21-001 (in-app AI never
 * diagnoses) both hold here by there being nothing to compute.
 *
 * HISTORY, NOT A FIELD. A note is never edited. Its author -- and only its
 * author -- may withdraw it, which sets deleted_at and leaves the row; reads
 * skip withdrawn notes. Each write (add, withdraw) records an audit event on
 * entity 'athlete_capacity_note' in the SAME transaction, shadow_mirror:
 * false, so the record never reaches the family-readable SHADOW feed
 * (/api/pilot/shadow/events admits athletes and guardians). The note text
 * stays out of the audit row; the table holds it.
 *
 * WHO. Staff only, both ways: coach, organization_admin, admin -- with an
 * ACTIVE membership in this organization in one of those roles -- and only
 * for an athlete assertActorCanAccessAthlete lets them reach (a coach's own
 * athletes plus live coverage; an org admin's whole gym; never a deleted
 * athlete). Athletes, guardians, volunteers, board and platform_owner get
 * nothing: whether the athlete or family reads these notes is not decided.
 */

export const CAPACITY_NOTE_ROLES = ['coach', 'organization_admin', 'admin'] as const;
export type CapacityNoteRole = (typeof CAPACITY_NOTE_ROLES)[number];

/** The column's own cap (pilot_athlete_capacity_notes_note_check), measured after trimming. */
export const CAPACITY_NOTE_MAX = 2000;
const LIST_LIMIT = 100;

export interface AthleteCapacityNoteRow {
  note_id: string;
  athlete_id: string;
  note: string;
  author_account_id: string;
  author_role: CapacityNoteRole;
  /** The author's display name (getCoachDisplayName); callers show this, never the account id. */
  author_name: string;
  created_at: string;
}

type StoredRow = Omit<AthleteCapacityNoteRow, 'author_name'>;

const FIELDS = 'note_id, athlete_id, note, author_account_id, author_role, created_at';

/** The note to store for this text, or the reason it is refused. Pure. */
export function capacityNoteShapeError(note: string): string | null {
  const trimmed = note.trim();
  if (trimmed.length === 0) return 'The note is empty.';
  if (trimmed.length > CAPACITY_NOTE_MAX) return `The note must be ${CAPACITY_NOTE_MAX} characters or fewer.`;
  return null;
}

/**
 * The actor's role HERE, read from its active membership row in this
 * organization -- not pilot.accounts.role, which is the account's HOME role
 * and can differ. Null when the account may not touch notes here.
 */
async function noteRoleInOrganization(actor: ActorIdentity): Promise<CapacityNoteRole | null> {
  const membership = await queryOne<{ role: CapacityNoteRole }>(
    `select om.role
       from pilot.organization_memberships om
      where om.account_id = $1 and om.organization_id = $2 and om.active_flag = true
        and om.role = any($3::text[])`,
    [actor.accountId, actor.organizationId, [...CAPACITY_NOTE_ROLES]],
  );
  return membership?.role ?? null;
}

/**
 * Throws ForbiddenError unless this actor is staff here AND reaches this
 * athlete. One message for every refusal, so the response cannot be used to
 * learn whether an athlete id exists or whose it is. The athlete check runs
 * with the MEMBERSHIP role. Only access.ts's own refusals ("Forbidden: ...")
 * become this refusal; an outage is rethrown, never reported as "not
 * permitted".
 */
async function assertNoteAccess(actor: ActorIdentity, athleteId: string): Promise<CapacityNoteRole> {
  const role = await noteRoleInOrganization(actor);
  if (role) {
    try {
      await assertActorCanAccessAthlete({ ...actor, role }, athleteId);
      return role;
    } catch (error) {
      if (!(error instanceof Error && error.message.startsWith('Forbidden'))) throw error;
    }
  }
  throw new ForbiddenError('This account may not read or write capacity notes for this athlete.', 'CAPACITY_NOTE_NOT_PERMITTED');
}

async function withAuthorNames(organizationId: string, rows: StoredRow[]): Promise<AthleteCapacityNoteRow[]> {
  const names = new Map<string, string>();
  for (const id of new Set(rows.map((row) => row.author_account_id))) {
    names.set(id, await getCoachDisplayName(organizationId, id));
  }
  return rows.map((row) => ({ ...row, author_name: names.get(row.author_account_id) ?? 'Your coach' }));
}

/**
 * This athlete's live notes, newest first (the last 100), and whether older
 * live notes exist past them -- so a reader is never left to take the newest
 * 100 for the whole history. One access check; one extra row read to tell.
 */
export async function readCapacityNotes(
  actor: ActorIdentity,
  athleteId: string,
): Promise<{ notes: AthleteCapacityNoteRow[]; olderNotes: boolean }> {
  await assertNoteAccess(actor, athleteId);
  const rows = await query<StoredRow>(
    `select ${FIELDS} from pilot.athlete_capacity_notes
      where organization_id = $1 and athlete_id = $2 and deleted_at is null
      order by note_seq desc
      limit ${LIST_LIMIT + 1}`,
    [actor.organizationId, athleteId],
  );
  return {
    notes: await withAuthorNames(actor.organizationId, rows.slice(0, LIST_LIMIT)),
    olderNotes: rows.length > LIST_LIMIT,
  };
}

/** This athlete's live notes, newest first (the last 100). One access check. */
export async function listCapacityNotes(actor: ActorIdentity, athleteId: string): Promise<AthleteCapacityNoteRow[]> {
  return (await readCapacityNotes(actor, athleteId)).notes;
}

/** Adds one note, in the coach's words, with its audit row on the same transaction. */
export async function addCapacityNote(input: {
  actor: ActorIdentity;
  athleteId: string;
  note: string;
}): Promise<AthleteCapacityNoteRow> {
  const note = input.note.trim();
  const shapeError = capacityNoteShapeError(note);
  if (shapeError) throw new ValidationError(shapeError, 'CAPACITY_NOTE_INVALID');

  const role = await assertNoteAccess(input.actor, input.athleteId);
  const noteId = randomUUID();

  const row = await withTransaction(async (client) => {
    const inserted = await client.query<StoredRow>(
      `insert into pilot.athlete_capacity_notes
         (organization_id, note_id, athlete_id, note, author_account_id, author_role)
       values ($1, $2, $3, $4, $5, $6)
       returning ${FIELDS}`,
      [input.actor.organizationId, noteId, input.athleteId, note, input.actor.accountId, role],
    );
    const stored = inserted.rows[0];
    if (!stored) throw new Error('Capacity note insert returned no row');

    await writePilotAuditEvent({
      event_type: 'create',
      actor_account_id: input.actor.accountId,
      actor_role: role,
      organization_id: input.actor.organizationId,
      entity_type: 'athlete_capacity_note',
      entity_id: noteId,
      details: { athlete_id: input.athleteId },
      shadow_mirror: false,
    }, client);
    return stored;
  });
  return (await withAuthorNames(input.actor.organizationId, [row]))[0];
}

/**
 * Withdraws one of the actor's OWN notes: sets deleted_at, leaves the row,
 * audits it on the same transaction. A note somebody else wrote is refused
 * even for an organization admin; a note already withdrawn, or not this
 * athlete's, is not found.
 */
export async function withdrawCapacityNote(input: {
  actor: ActorIdentity;
  athleteId: string;
  noteId: string;
}): Promise<void> {
  const role = await assertNoteAccess(input.actor, input.athleteId);

  await withTransaction(async (client) => {
    const live = await client.query<{ author_account_id: string }>(
      `select author_account_id from pilot.athlete_capacity_notes
        where organization_id = $1 and athlete_id = $2 and note_id = $3 and deleted_at is null
        for update`,
      [input.actor.organizationId, input.athleteId, input.noteId],
    );
    const found = live.rows[0];
    if (!found) throw new NotFoundError('No such note.', 'CAPACITY_NOTE_NOT_FOUND');
    if (found.author_account_id !== input.actor.accountId) {
      throw new ForbiddenError('Only the coach who wrote a note may withdraw it.', 'CAPACITY_NOTE_NOT_AUTHOR');
    }

    await client.query(
      `update pilot.athlete_capacity_notes set deleted_at = clock_timestamp()
        where organization_id = $1 and athlete_id = $2 and note_id = $3 and deleted_at is null`,
      [input.actor.organizationId, input.athleteId, input.noteId],
    );

    await writePilotAuditEvent({
      event_type: 'update',
      actor_account_id: input.actor.accountId,
      actor_role: role,
      organization_id: input.actor.organizationId,
      entity_type: 'athlete_capacity_note',
      entity_id: input.noteId,
      details: { athlete_id: input.athleteId, action: 'withdraw' },
      shadow_mirror: false,
    }, client);
  });
}
