import { randomUUID } from 'node:crypto';

import { type ActorIdentity, assertActorCanAccessAthlete } from './access';
import { getStaffAuthorName, STAFF_AUTHOR_NAME_FLOOR } from './achievements';
import { writePilotAuditEvent } from './audit';
import { query, queryOne, withTransaction } from './db';
import { accountDeletedSql } from './deletedAccountSignIn';
import { ForbiddenError, NotFoundError, ValidationError } from './errors';
import { roleEquals } from './roleAlias';

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
 * HISTORY, NOT A FIELD. A note is never edited. Its author may withdraw it,
 * which sets deleted_at and leaves the row; reads skip withdrawn notes. Once
 * the author has LEFT the gym, and only then, an organization admin may
 * withdraw it in their place (OD-2026-10-10-003 ruling 4); nobody else ever
 * may, and nobody changes a note's text. Each write (add, withdraw) records
 * an audit event on
 * entity 'athlete_capacity_note' in the SAME transaction, shadow_mirror:
 * false, so no mirrored row reaches the SHADOW feed
 * (/api/pilot/shadow/events). Today the family allow-list
 * (FAMILY_ALLOWED_AUDIT_ENTITY_TYPES, auditReadAllowlist.ts) is empty, so
 * athletes and guardians read no SHADOW_AUDIT_* row there anyway; this keeps
 * the record off the feed if that list is ever filled. The note text stays
 * out of the audit row; the table holds it.
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
  /** The author's display name (getStaffAuthorName, by author_role); callers show this, never the account id. */
  author_name: string;
  created_at: string;
  /**
   * Whether THIS reader may withdraw the note: its author, or an organization
   * admin once the author has left. The withdrawal decides again for itself.
   */
  can_withdraw: boolean;
}

type StoredRow = Omit<AthleteCapacityNoteRow, 'author_name' | 'can_withdraw'>;

const FIELDS = 'note_id, athlete_id, note, author_account_id, author_role, created_at';

/**
 * "The author of note `n` has left this gym" (Overwatch ruling A, 2026-10-11):
 * the account is switched off (#1368, setAccountActiveStatus), carries the
 * deletion mark, or holds no active membership row in the note's
 * organization. A coach still active here has not left, whatever their role.
 */
const AUTHOR_DEPARTED_SQL = `not exists (
  select 1
    from pilot.accounts a
    join pilot.organization_memberships om
      on om.account_id = a.account_id
     and om.organization_id = n.organization_id
     and om.active_flag = true
   where a.account_id = n.author_account_id
     and a.active_flag = true
     and not ${accountDeletedSql('a')}
)`;

/**
 * Organization admin by BOTH the membership row here and the session: a
 * platform_owner session never withdraws another person's note, whatever
 * membership its account holds. roleEquals carries the legacy 'admin'
 * spelling (roleAlias.ts).
 */
function isOrganizationAdminHere(actor: ActorIdentity, role: CapacityNoteRole): boolean {
  return roleEquals(role, 'organization_admin') && roleEquals(actor.role, 'organization_admin');
}

/** Author, or an organization admin once the author has left. Used by the read and by the withdrawal. */
function mayWithdraw(actor: ActorIdentity, role: CapacityNoteRole, authorAccountId: string, authorDeparted: boolean): boolean {
  if (authorAccountId === actor.accountId) return true;
  return authorDeparted && isOrganizationAdminHere(actor, role);
}

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

async function withAuthorNames<Row extends { author_account_id: string; author_role: string }>(
  organizationId: string,
  rows: Row[],
): Promise<(Row & { author_name: string })[]> {
  // Keyed by role too: an admin's note is not signed "Coach" (F-058). A role
  // has no colon, so the key is unambiguous.
  const keyOf = (row: Row) => `${row.author_role}:${row.author_account_id}`;
  const names = new Map<string, string>();
  for (const row of rows) {
    if (!names.has(keyOf(row))) {
      names.set(keyOf(row), await getStaffAuthorName(organizationId, row.author_account_id, row.author_role));
    }
  }
  return rows.map((row) => ({ ...row, author_name: names.get(keyOf(row)) ?? STAFF_AUTHOR_NAME_FLOOR }));
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
  const role = await assertNoteAccess(actor, athleteId);
  const rows = await query<StoredRow & { author_departed: boolean }>(
    `select ${FIELDS}, ${AUTHOR_DEPARTED_SQL} as author_departed
       from pilot.athlete_capacity_notes n
      where n.organization_id = $1 and n.athlete_id = $2 and n.deleted_at is null
      order by n.note_seq desc
      limit ${LIST_LIMIT + 1}`,
    [actor.organizationId, athleteId],
  );
  const shown = rows.slice(0, LIST_LIMIT).map(({ author_departed, ...row }) => ({
    ...row,
    can_withdraw: mayWithdraw(actor, role, row.author_account_id, author_departed),
  }));
  return {
    notes: await withAuthorNames(actor.organizationId, shown),
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
  // The author's own note, just written: theirs to withdraw.
  return (await withAuthorNames(input.actor.organizationId, [{ ...row, can_withdraw: true }]))[0];
}

/**
 * Withdraws a note: sets deleted_at, leaves the row, audits it on the same
 * transaction. The actor's OWN note, always. A note somebody else wrote: only
 * an organization admin, and only once its author has left the gym
 * (OD-2026-10-10-003 ruling 4) -- while the author is still here it is theirs
 * to withdraw and the admin is refused; a coach who is not the author is
 * refused either way. A note already withdrawn, or not this athlete's, is not
 * found. Whether the author has left is read by the statement that locks the
 * note, in the transaction that withdraws it. The author's account and
 * membership rows are not locked: a reactivation landing at that instant is
 * not excluded.
 *
 * The admin's withdrawal is audited as its own action and names the departed
 * author by account id; the audit row is not mirrored (see above) and
 * 'athlete_capacity_note' is not on the coach audit allow-list
 * (auditReadAllowlist.ts), so that id stays with the organization admin.
 */
export async function withdrawCapacityNote(input: {
  actor: ActorIdentity;
  athleteId: string;
  noteId: string;
}): Promise<void> {
  const role = await assertNoteAccess(input.actor, input.athleteId);

  await withTransaction(async (client) => {
    const live = await client.query<{ author_account_id: string; author_departed: boolean }>(
      `select n.author_account_id, ${AUTHOR_DEPARTED_SQL} as author_departed
         from pilot.athlete_capacity_notes n
        where n.organization_id = $1 and n.athlete_id = $2 and n.note_id = $3 and n.deleted_at is null
        for update of n`,
      [input.actor.organizationId, input.athleteId, input.noteId],
    );
    const found = live.rows[0];
    if (!found) throw new NotFoundError('No such note.', 'CAPACITY_NOTE_NOT_FOUND');
    if (!mayWithdraw(input.actor, role, found.author_account_id, found.author_departed)) {
      // One code for every refusal. Only the organization admin, who is
      // already told on the read which authors have left, gets the sentence
      // that says so; a coach learns nothing about another coach's standing.
      throw new ForbiddenError(
        isOrganizationAdminHere(input.actor, role)
          ? 'The coach who wrote this note is still at the gym; only they may withdraw it.'
          : 'Only the coach who wrote a note may withdraw it.',
        'CAPACITY_NOTE_NOT_AUTHOR',
      );
    }
    const own = found.author_account_id === input.actor.accountId;

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
      details: own
        ? { athlete_id: input.athleteId, action: 'withdraw' }
        : { athlete_id: input.athleteId, action: 'withdraw_departed_author', author_account_id: found.author_account_id },
      shadow_mirror: false,
    }, client);
  });
}
