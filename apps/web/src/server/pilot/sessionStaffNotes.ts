import { randomUUID } from 'node:crypto';

import { type ActorIdentity, assertActorCanAccessAthlete } from './access';
import { getCoachDisplayName } from './achievements';
import { writePilotAuditEvent } from './audit';
import { query, queryOne, withTransaction } from './db';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from './errors';

/**
 * Session staff notes: a note a coach or organization admin adds, IN THEIR OWN
 * NAME, to one athlete's training session (OD-2026-10-06-025 ruling 4, Jason:
 * "Only the writer; coach adds own note (Recommended)"; overwatch ruling B,
 * 2026-10-07).
 *
 * The athlete's own note stays on pilot.sessions.notes, and only the athlete
 * may change it (#1320, isSessionNoteWriter). Staff never rewrite that text;
 * they add a row here. Unlike that column, every row here has an AUTHOR, so a
 * reader can name the coach who wrote it (by display name, never account id)
 * and the author -- and only the author -- can change or remove it.
 *
 * MANY NOTES PER AUTHOR PER SESSION: each is its own row; a coach may add one
 * before a session and another after it.
 *
 * AUTHOR-ONLY EDIT AND REMOVAL, enforced inside the UPDATE's own WHERE on
 * author_account_id, so the statement cannot touch anyone else's note even if
 * a caller gets past the checks above it. Removal is a soft delete
 * (deleted_at); the row stays for the audit trail and never comes back in a
 * list.
 *
 * WHO. Staff only, both ways: coach, organization_admin, admin -- with an
 * ACTIVE membership in this organization in one of those roles -- and only
 * for an athlete assertActorCanAccessAthlete lets them reach (any athlete of
 * their own gym, for a coach and an org admin alike, OD-2026-10-11-007; never
 * a deleted athlete), run with the MEMBERSHIP role. Athletes, guardians, volunteers,
 * board and platform_owner get nothing from this module: staff notes are
 * STAFF ONLY, with no athlete or parent view (OD-2026-10-10-003 ruling 3).
 *
 * THE SESSION MUST BE THAT ATHLETE'S. The table's foreign keys pin the session
 * and the athlete to this organization separately; that the session belongs
 * to the named athlete is checked here, inside the write transaction, before
 * the insert (overwatch 2026-10-08: pilot.sessions itself is not altered).
 *
 * A NOTE ON A RUN (audit finding F-067). The athlete's own session row does
 * not exist until the athlete logs the day, so a coach running a session had
 * nothing to hang today's note on. A note may instead be on an athlete IN A
 * SESSION RUN (run_id; exactly one of session_id and run_id is set, a check the
 * session-run-athletes migration holds). Everything above is unchanged for it:
 * the author's own name, author-only edit and removal, staff only. Two things
 * are particular to it:
 *   - THE ATHLETE MUST BE MARKED PRESENT IN THAT RUN. The table's foreign key
 *     proves a mark row exists; that the mark still STANDS (was not taken back)
 *     is checked here, with the mark row locked, so a mark cannot be taken back
 *     in the same instant the note is written.
 *   - A NOTE STAYS IF THE MARK IS LATER TAKEN BACK. Only its writer changes or
 *     removes a note (OD-2026-10-06-025 ruling 4), and nothing is deleted.
 * Any coach or organization admin who reaches the athlete may write one, while
 * the run is live or after it has finished, as with a session note ("a coach
 * may add a note before a session and another after it"). Nothing is written
 * to the athlete's own session or check-in.
 *
 * Each write records an audit event on entity 'session_staff_note' in the
 * SAME transaction. The note text stays out of the audit row; the table
 * holds it. shadow_mirror: false, because the mirrored shadow_events row
 * would be readable by the athlete and their guardians through
 * /api/pilot/shadow/events (tied by details.athlete_id), and staff notes are
 * staff only (OD-2026-10-10-003 ruling 3).
 */

export const STAFF_NOTE_ROLES = ['coach', 'organization_admin', 'admin'] as const;
export type StaffNoteRole = (typeof STAFF_NOTE_ROLES)[number];

export const STAFF_NOTE_MAX = 2000;
const LIST_LIMIT = 100;

export interface SessionStaffNoteRow {
  note_id: string;
  /** Set on a note on the athlete's own session; null on a note on a run. */
  session_id: string | null;
  /** Set on a note on the athlete in a session run; null on a session note. */
  run_id: string | null;
  athlete_id: string;
  author_account_id: string;
  author_role: StaffNoteRole;
  note: string;
  created_at: string;
  updated_at: string;
}

/**
 * A note as a reader sees it: no account id (an id can be an email address);
 * written_by_me says whether the reader may change it, and author_name is the
 * author's display name (getCoachDisplayName), resolved here because the
 * account id never leaves this module.
 */
export type ListedSessionStaffNote = Omit<SessionStaffNoteRow, 'author_account_id'> & {
  written_by_me: boolean;
  author_name: string;
};

const FIELDS = 'note_id, session_id, run_id, athlete_id, author_account_id, author_role, note, created_at, updated_at';

/** The text to store, or the reason it is refused. Pure. */
export function staffNoteShapeError(note: unknown): string | null {
  if (typeof note !== 'string') return 'The note must be text.';
  const text = note.trim();
  if (text.length === 0) return 'The note cannot be blank.';
  if (text.length > STAFF_NOTE_MAX) return `The note must be ${STAFF_NOTE_MAX} characters or fewer.`;
  return null;
}

/**
 * The actor's role HERE, read from its active membership row in this
 * organization -- not pilot.accounts.role, which is the account's HOME role
 * and can differ. Null when the account may not touch staff notes here.
 */
export async function staffNoteRoleInOrganization(actor: ActorIdentity): Promise<StaffNoteRole | null> {
  if (!(STAFF_NOTE_ROLES as readonly string[]).includes(actor.role)) return null;
  const membership = await queryOne<{ role: StaffNoteRole }>(
    `select om.role
       from pilot.organization_memberships om
      where om.account_id = $1 and om.organization_id = $2 and om.active_flag = true
        and om.role = any($3::text[])`,
    [actor.accountId, actor.organizationId, [...STAFF_NOTE_ROLES]],
  );
  return membership?.role ?? null;
}

/**
 * The actor's staff role HERE if this actor is staff in this organization AND
 * reaches this athlete; otherwise null. Only access.ts's own refusals
 * ("Forbidden: ...") become null; an outage is rethrown.
 *
 * Exported for sessionRunAthletes.ts, which asks the same question of a coach
 * marking an athlete present in a run: one copy of the staff-and-reach rule,
 * so the two cannot drift.
 */
export async function staffRoleReachingAthlete(actor: ActorIdentity, athleteId: string): Promise<StaffNoteRole | null> {
  const role = await staffNoteRoleInOrganization(actor);
  if (!role) return null;
  try {
    await assertActorCanAccessAthlete({ ...actor, role }, athleteId);
    return role;
  } catch (error) {
    if (!(error instanceof Error && error.message.startsWith('Forbidden'))) throw error;
    return null;
  }
}

/**
 * Throws ForbiddenError unless this actor is staff here AND reaches this
 * athlete. One message for every refusal, so the response cannot be used to
 * learn whether an athlete id exists or whose it is.
 */
async function assertStaffNoteAccess(actor: ActorIdentity, athleteId: string): Promise<StaffNoteRole> {
  const role = await staffRoleReachingAthlete(actor, athleteId);
  if (role) return role;
  throw new ForbiddenError('This account may not read or write staff notes for this athlete.', 'SESSION_STAFF_NOTE_NOT_PERMITTED');
}

/** One wording for "no such session here" and "that session is another athlete's": the caller learns neither. */
function noSuchSession(): NotFoundError {
  return new NotFoundError('No such session for this athlete.', 'SESSION_STAFF_NOTE_SESSION_NOT_FOUND');
}

/**
 * The live staff notes on one session ABOUT one athlete -- the newest
 * LIST_LIMIT, shown oldest first -- for a staff member who reaches that
 * athlete. The athlete is the one the caller names; a session that is not
 * theirs reads as no session. Notes are filtered on athlete_id too, because a
 * session can be moved to another athlete and its earlier notes stay about the
 * first one.
 */
export async function listSessionStaffNotes(
  actor: ActorIdentity,
  sessionId: string,
  athleteId: string,
): Promise<ListedSessionStaffNote[]> {
  await assertStaffNoteAccess(actor, athleteId);
  const session = await queryOne<{ session_id: string }>(
    `select session_id from pilot.sessions
      where organization_id = $1 and session_id = $2 and athlete_id = $3`,
    [actor.organizationId, sessionId, athleteId],
  );
  if (!session) throw noSuchSession();
  const newest = await query<SessionStaffNoteRow>(
    `select ${FIELDS} from pilot.session_staff_notes
      where organization_id = $1 and session_id = $2 and athlete_id = $3 and deleted_at is null
      order by created_at desc, note_id desc
      limit ${LIST_LIMIT}`,
    [actor.organizationId, sessionId, athleteId],
  );
  return asListed(actor, newest);
}

/** Rows newest first, as a reader sees them: oldest first, the author by display name, no account id. */
async function asListed(actor: ActorIdentity, newest: SessionStaffNoteRow[]): Promise<ListedSessionStaffNote[]> {
  const names = new Map<string, string>();
  for (const id of new Set(newest.map((row) => row.author_account_id))) {
    names.set(id, await getCoachDisplayName(actor.organizationId, id));
  }
  return [...newest].reverse().map(({ author_account_id, ...shown }) => ({
    ...shown,
    author_name: names.get(author_account_id) ?? 'Your coach',
    written_by_me: author_account_id === actor.accountId,
  }));
}

/**
 * The live staff notes on one athlete in one session RUN -- the newest
 * LIST_LIMIT, shown oldest first -- for a staff member who reaches that
 * athlete. A run of another organization, or one the athlete was never marked
 * in, simply has no notes: the organization and the athlete are both in the
 * WHERE, and the caller was already checked against the athlete.
 */
export async function listRunStaffNotes(
  actor: ActorIdentity,
  runId: string,
  athleteId: string,
): Promise<ListedSessionStaffNote[]> {
  await assertStaffNoteAccess(actor, athleteId);
  const newest = await query<SessionStaffNoteRow>(
    `select ${FIELDS} from pilot.session_staff_notes
      where organization_id = $1 and run_id = $2 and athlete_id = $3 and deleted_at is null
      order by created_at desc, note_id desc
      limit ${LIST_LIMIT}`,
    [actor.organizationId, runId, athleteId],
  );
  return asListed(actor, newest);
}

/**
 * Adds a note of the actor's own on one athlete in one session run. The
 * athlete's mark in that run is read inside the transaction, LOCKED, and must
 * still stand; otherwise nothing is written.
 */
export async function createRunStaffNote(input: {
  actor: ActorIdentity;
  runId: string;
  athleteId: string;
  note: string;
}): Promise<SessionStaffNoteRow> {
  const shapeError = staffNoteShapeError(input.note);
  if (shapeError) throw new ValidationError(shapeError, 'SESSION_STAFF_NOTE_INVALID');
  const text = input.note.trim();

  const role = await assertStaffNoteAccess(input.actor, input.athleteId);
  const noteId = randomUUID();

  return withTransaction(async (client) => {
    // FOR UPDATE on the mark row: taking a mark back updates that row, so it
    // queues behind this lock and this note is written against a mark that
    // stands. The table's own foreign key would not stop it (it proves the row
    // exists, and its lock does not conflict with that update).
    const mark = await client.query<{ removed_at: string | null }>(
      `select removed_at from pilot.session_run_athletes
        where organization_id = $1 and run_id = $2 and athlete_id = $3
          for update`,
      [input.actor.organizationId, input.runId, input.athleteId],
    );
    // One wording for "no such run here", "never marked in it" and "mark taken back".
    if (!mark.rows[0] || mark.rows[0].removed_at !== null) {
      throw new ConflictError(
        'This athlete is not marked present in this session, so a note cannot be added for them here.',
        'SESSION_STAFF_NOTE_ATHLETE_NOT_PRESENT',
      );
    }

    const inserted = await client.query<SessionStaffNoteRow>(
      `insert into pilot.session_staff_notes
         (organization_id, note_id, run_id, athlete_id, author_account_id, author_role, note)
       values ($1, $2, $3, $4, $5, $6, $7)
       returning ${FIELDS}`,
      [input.actor.organizationId, noteId, input.runId, input.athleteId, input.actor.accountId, role, text],
    );
    const row = inserted.rows[0];
    if (!row) throw new Error('Session staff note insert returned no row');

    await writePilotAuditEvent({
      event_type: 'create',
      actor_account_id: input.actor.accountId,
      actor_role: role,
      organization_id: input.actor.organizationId,
      entity_type: 'session_staff_note',
      entity_id: noteId,
      details: { run_id: input.runId, athlete_id: input.athleteId },
      shadow_mirror: false,
    }, client);

    return row;
  });
}

/**
 * Adds a note of the actor's own to one athlete's session. The session is
 * read inside the transaction and must belong to that athlete in this
 * organization; otherwise nothing is written.
 */
export async function createSessionStaffNote(input: {
  actor: ActorIdentity;
  sessionId: string;
  athleteId: string;
  note: string;
}): Promise<SessionStaffNoteRow> {
  const shapeError = staffNoteShapeError(input.note);
  if (shapeError) throw new ValidationError(shapeError, 'SESSION_STAFF_NOTE_INVALID');
  const text = input.note.trim();

  const role = await assertStaffNoteAccess(input.actor, input.athleteId);
  const noteId = randomUUID();

  return withTransaction(async (client) => {
    const session = await client.query<{ session_id: string }>(
      `select session_id from pilot.sessions
        where organization_id = $1 and session_id = $2 and athlete_id = $3`,
      [input.actor.organizationId, input.sessionId, input.athleteId],
    );
    if (session.rows.length === 0) throw noSuchSession();

    const inserted = await client.query<SessionStaffNoteRow>(
      `insert into pilot.session_staff_notes
         (organization_id, note_id, session_id, athlete_id, author_account_id, author_role, note)
       values ($1, $2, $3, $4, $5, $6, $7)
       returning ${FIELDS}`,
      [input.actor.organizationId, noteId, input.sessionId, input.athleteId, input.actor.accountId, role, text],
    );
    const row = inserted.rows[0];
    if (!row) throw new Error('Session staff note insert returned no row');

    await writePilotAuditEvent({
      event_type: 'create',
      actor_account_id: input.actor.accountId,
      actor_role: role,
      organization_id: input.actor.organizationId,
      entity_type: 'session_staff_note',
      entity_id: noteId,
      details: { session_id: input.sessionId, athlete_id: input.athleteId },
      shadow_mirror: false,
    }, client);

    return row;
  });
}

/**
 * The live note to change or remove, or the refusal. The actor must still
 * reach the athlete (a coach who no longer does cannot edit old notes). The
 * AUTHOR check is not here: the UPDATE's own WHERE is the only thing that
 * decides it, and authorRefusal names the refusal after that UPDATE matched
 * nothing.
 */
async function ownLiveNote(actor: ActorIdentity, noteId: string): Promise<{ row: SessionStaffNoteRow; role: StaffNoteRole }> {
  const row = await queryOne<SessionStaffNoteRow>(
    `select ${FIELDS} from pilot.session_staff_notes
      where organization_id = $1 and note_id = $2 and deleted_at is null`,
    [actor.organizationId, noteId],
  );
  if (!row) throw new NotFoundError('No such staff note.', 'SESSION_STAFF_NOTE_NOT_FOUND');
  const role = await assertStaffNoteAccess(actor, row.athlete_id);
  return { row, role };
}

/**
 * Why an author-scoped UPDATE matched nothing: another staff member's note is
 * refused by name (its existence is already known to anyone who can list the
 * session); otherwise it was removed in between.
 */
function authorRefusal(actor: ActorIdentity, before: SessionStaffNoteRow): Error {
  if (before.author_account_id !== actor.accountId) {
    return new ForbiddenError('Only the coach who wrote this note may change it.', 'SESSION_STAFF_NOTE_AUTHOR_ONLY');
  }
  return new NotFoundError('No such staff note.', 'SESSION_STAFF_NOTE_NOT_FOUND');
}

/** What a note is on, for its audit row: its session or its run, whichever it has. */
function subjectOf(note: SessionStaffNoteRow): { session_id: string } | { run_id: string } {
  return note.run_id !== null ? { run_id: note.run_id } : { session_id: note.session_id ?? '' };
}

/** Changes the text of the actor's OWN note. The UPDATE itself requires the author to match. */
export async function updateOwnSessionStaffNote(input: {
  actor: ActorIdentity;
  noteId: string;
  note: string;
}): Promise<SessionStaffNoteRow> {
  const shapeError = staffNoteShapeError(input.note);
  if (shapeError) throw new ValidationError(shapeError, 'SESSION_STAFF_NOTE_INVALID');
  const text = input.note.trim();
  const { row: before, role } = await ownLiveNote(input.actor, input.noteId);

  return withTransaction(async (client) => {
    const updated = await client.query<SessionStaffNoteRow>(
      `update pilot.session_staff_notes
          set note = $4, updated_at = clock_timestamp()
        where organization_id = $1 and note_id = $2 and author_account_id = $3 and deleted_at is null
        returning ${FIELDS}`,
      [input.actor.organizationId, input.noteId, input.actor.accountId, text],
    );
    const row = updated.rows[0];
    if (!row) throw authorRefusal(input.actor, before);

    await writePilotAuditEvent({
      event_type: 'update',
      actor_account_id: input.actor.accountId,
      actor_role: role,
      organization_id: input.actor.organizationId,
      entity_type: 'session_staff_note',
      entity_id: input.noteId,
      details: { ...subjectOf(before), athlete_id: before.athlete_id },
      shadow_mirror: false,
    }, client);

    return row;
  });
}

/** Removes the actor's OWN note (soft delete). The UPDATE itself requires the author to match. */
export async function removeOwnSessionStaffNote(input: {
  actor: ActorIdentity;
  noteId: string;
}): Promise<void> {
  const { row: before, role } = await ownLiveNote(input.actor, input.noteId);

  await withTransaction(async (client) => {
    const removed = await client.query(
      `update pilot.session_staff_notes
          set deleted_at = clock_timestamp(), updated_at = clock_timestamp()
        where organization_id = $1 and note_id = $2 and author_account_id = $3 and deleted_at is null`,
      [input.actor.organizationId, input.noteId, input.actor.accountId],
    );
    if (removed.rowCount !== 1) throw authorRefusal(input.actor, before);

    await writePilotAuditEvent({
      event_type: 'update',
      actor_account_id: input.actor.accountId,
      actor_role: role,
      organization_id: input.actor.organizationId,
      entity_type: 'session_staff_note',
      entity_id: input.noteId,
      details: { ...subjectOf(before), athlete_id: before.athlete_id, removed: true },
      shadow_mirror: false,
    }, client);
  });
}
