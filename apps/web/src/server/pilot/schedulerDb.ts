import { type PilotAuditEvent, writePilotAuditEvent } from './audit';
import { query, queryOne, withTransaction } from './db';
import { athleteNotDeletedSql } from './deletedAthletes';
import { ConflictError } from './errors';
import { listMembershipFlagsForAthlete, type MembershipFlag } from './programMemberships';
import { findRegistrationBlockingHold } from './trainingHolds';

export type SchedulerRole = 'athlete' | 'parent' | 'coach' | 'organization_admin' | 'admin';

export interface SchedulerClass {
  class_id: string;
  title: string;
  start_at: string;
  end_at: string;
  location: string;
  capacity: number;
  scheduled_by_account_id: string;
  coach_account_id: string;
  covering_coach_account_id?: string;
  status: 'open' | 'full' | 'cancelled';
  created_at: string;
  updated_at: string;
}

export interface SchedulerRegistration {
  registration_id: string;
  class_id: string;
  athlete_id: string;
  requested_by_role: SchedulerRole;
  requested_by_account_id: string;
  parent_reviewed: boolean;
  parent_reviewed_at?: string;
  parent_reviewer_account_id?: string;
  status: 'registered' | 'waitlisted' | 'cancelled';
  created_at: string;
  updated_at: string;
}

export interface SchedulerCoachingRequest {
  request_id: string;
  athlete_id: string;
  requested_by_role: SchedulerRole;
  requested_by_account_id: string;
  preferred_at: string;
  goals: string;
  // 'withdrawn': the family closed it (parent walk 2026-10-19 item 9).
  status: 'pending' | 'approved' | 'declined' | 'withdrawn';
  assigned_coach_account_id?: string;
  created_at: string;
  updated_at: string;
}

export interface SchedulerAttendance {
  attendance_id: string;
  class_id: string;
  athlete_id: string;
  status: 'present' | 'absent' | 'excused';
  // 'walk_in': a coach or admin running the class marked present an athlete
  // of the gym who was not registered to it (OD-2026-10-07-008 question
  // card 1 item 4). Admitted by the attendance-walk-in-method migration; the
  // other four are the base schema's.
  method: 'self' | 'parent' | 'coach_override' | 'admin_override' | 'walk_in';
  checked_in_by_role: SchedulerRole;
  checked_in_by_account_id: string;
  note: string;
  checked_in_at: string;
  updated_at: string;
}

export interface SchedulerStore {
  classes: SchedulerClass[];
  registrations: SchedulerRegistration[];
  coaching_requests: SchedulerCoachingRequest[];
  attendance: SchedulerAttendance[];
}

export async function listSchedulerStore(organizationId: string): Promise<SchedulerStore> {
  const [classes, registrations, coachingRequests, attendance] = await Promise.all([
    query<SchedulerClass>(
      `select class_id, title, start_at::text, end_at::text, location, capacity,
              scheduled_by_account_id, coach_account_id, covering_coach_account_id,
              status, created_at::text, updated_at::text
       from pilot.scheduler_classes
       where organization_id = $1
       order by start_at asc, created_at desc`,
      [organizationId],
    ),
    // Scope B: a deleted athlete's registrations, coaching requests and
    // attendance are marked deleted with them, for every role this store
    // feeds -- including the admin, who is handed the whole store, and the
    // registered_count every role sees.
    query<SchedulerRegistration>(
      `select registration_id, class_id, athlete_id, requested_by_role, requested_by_account_id,
              parent_reviewed, parent_reviewed_at::text, parent_reviewer_account_id,
              status, created_at::text, updated_at::text
       from pilot.scheduler_registrations
       where organization_id = $1
         and ${athleteNotDeletedSql('pilot.scheduler_registrations')}
       order by created_at desc`,
      [organizationId],
    ),
    query<SchedulerCoachingRequest>(
      `select request_id, athlete_id, requested_by_role, requested_by_account_id,
              preferred_at::text, goals, status, assigned_coach_account_id,
              created_at::text, updated_at::text
       from pilot.scheduler_coaching_requests
       where organization_id = $1
         and ${athleteNotDeletedSql('pilot.scheduler_coaching_requests')}
       order by created_at desc`,
      [organizationId],
    ),
    query<SchedulerAttendance>(
      `select attendance_id, class_id, athlete_id, status, method,
              checked_in_by_role, checked_in_by_account_id, note,
              checked_in_at::text, updated_at::text
       from pilot.scheduler_attendance
       where organization_id = $1
         and ${athleteNotDeletedSql('pilot.scheduler_attendance')}
       order by checked_in_at desc`,
      [organizationId],
    ),
  ]);

  return {
    classes,
    registrations,
    coaching_requests: coachingRequests,
    attendance,
  };
}

export async function getSchedulerClassById(organizationId: string, classId: string): Promise<SchedulerClass | null> {
  return queryOne<SchedulerClass>(
    `select class_id, title, start_at::text, end_at::text, location, capacity,
            scheduled_by_account_id, coach_account_id, covering_coach_account_id,
            status, created_at::text, updated_at::text
     from pilot.scheduler_classes
     where organization_id = $1 and class_id = $2`,
    [organizationId, classId],
  );
}

/*
 * One class, or a repeat-weekly run of them (lane LW), in ONE transaction: all
 * of them or none. Each row is an ordinary class with its own id, so editing or
 * cancelling one never touches the others; nothing records that they were made
 * together.
 *
 * Retry-safe without a key table: the route derives each class_id from the
 * request key (same caller, same key, same week -> same id), so a repeated
 * submit inserts nothing ("on conflict do nothing") and is answered
 * 'already_created' -- when every class it names is already there exactly as
 * asked. A key that already made DIFFERENT classes (or only some of these) is
 * refused, and the transaction takes back anything this call inserted. Two
 * submits racing on one key: the second waits on the first's rows, then finds
 * them.
 */
export type CreateClassesOutcome = 'created' | 'already_created';

export const CLASS_REQUEST_KEY_REUSED =
  'Your earlier tap already scheduled classes under this request, so nothing was added this time. Check the schedule before scheduling again.';

export async function createSchedulerClasses(
  organizationId: string,
  items: readonly SchedulerClass[],
): Promise<CreateClassesOutcome> {
  const column = <K extends keyof SchedulerClass>(key: K) => items.map((item) => item[key] ?? null);
  const params = [
    organizationId,
    column('class_id'), column('title'), column('start_at'), column('end_at'), column('location'),
    column('capacity'), column('scheduled_by_account_id'), column('coach_account_id'),
    column('covering_coach_account_id'), column('status'), column('created_at'), column('updated_at'),
  ];
  return withTransaction(async (client) => {
    const inserted = await client.query<{ class_id: string }>(
      `insert into pilot.scheduler_classes (
         organization_id, class_id, title, start_at, end_at, location, capacity,
         scheduled_by_account_id, coach_account_id, covering_coach_account_id,
         status, created_at, updated_at
       )
       select $1::text, r.*
         from unnest($2::text[], $3::text[], $4::timestamptz[], $5::timestamptz[], $6::text[],
                     $7::integer[], $8::text[], $9::text[], $10::text[], $11::text[],
                     $12::timestamptz[], $13::timestamptz[])
           as r(class_id, title, start_at, end_at, location, capacity, scheduled_by_account_id,
                coach_account_id, covering_coach_account_id, status, created_at, updated_at)
       on conflict (organization_id, class_id) do nothing
       returning class_id`,
      params,
    );
    if (inserted.rows.length === items.length) return 'created';
    if (inserted.rows.length === 0) {
      // The same request again only if every class is there as asked; status and
      // cover are not compared (a class cancelled since is still the one made).
      const same = await client.query<{ count: string }>(
        `select count(*)::text as count
           from pilot.scheduler_classes c
           join unnest($2::text[], $3::text[], $4::timestamptz[], $5::timestamptz[], $6::text[],
                       $7::integer[], $8::text[])
             as r(class_id, title, start_at, end_at, location, capacity, coach_account_id)
             on c.class_id = r.class_id
          where c.organization_id = $1 and c.title = r.title and c.start_at = r.start_at
            and c.end_at = r.end_at and c.location = r.location and c.capacity = r.capacity
            and c.coach_account_id = r.coach_account_id`,
        [...params.slice(0, 7), column('coach_account_id')],
      );
      if (Number(same.rows[0]?.count ?? 0) === items.length) return 'already_created';
    }
    throw new ConflictError(CLASS_REQUEST_KEY_REUSED, 'CLASS_REQUEST_KEY_REUSED');
  });
}

/**
 * Names the class's cover coach, and writes its cover_class audit row in the
 * same transaction (#1595). The cancel rule reads that row for how long the
 * cover has been held, so a cover must not land without it: if the audit
 * insert fails, the cover is rolled back.
 */
export async function setSchedulerClassCover(
  organizationId: string,
  classId: string,
  coachAccountId: string,
  updatedAt: string,
  audit: PilotAuditEvent,
): Promise<void> {
  await withTransaction(async (client) => {
    await client.query(
      `update pilot.scheduler_classes
       set covering_coach_account_id = $3,
           updated_at = $4
       where organization_id = $1 and class_id = $2`,
      [organizationId, classId, coachAccountId, updatedAt],
    );
    await writePilotAuditEvent(audit, client);
  });
}

/**
 * Soft-cancels a class (#1536): the status reads 'cancelled' and nothing else
 * changes. Its registrations, attendance and history stay exactly as they
 * were. Returns false when the class was already cancelled, has started
 * (#1595: never after start, checked in the same statement on the database's
 * clock so a cancel racing the start cannot land), or is not this gym's.
 *
 * `onlyIfCoveredBy`: for a caller allowed only as the class's cover coach,
 * the update also requires that they still cover it, so a cover handed to
 * someone else between the check and the write cannot cancel (#1595).
 */
export async function cancelSchedulerClass(
  organizationId: string,
  classId: string,
  updatedAt: string,
  onlyIfCoveredBy?: string,
): Promise<boolean> {
  const rows = await query<{ class_id: string }>(
    `update pilot.scheduler_classes
     set status = 'cancelled',
         updated_at = $3
     where organization_id = $1 and class_id = $2 and status <> 'cancelled'
       and start_at > now()
       and ($4::text is null or covering_coach_account_id = $4::text)
     returning class_id`,
    [organizationId, classId, updatedAt, onlyIfCoveredBy ?? null],
  );
  return rows.length > 0;
}

/**
 * The newest cover_class audit row for each class (#1595): who it named as
 * cover and when. schedulerCancelRule reads it to tell how long the current
 * cover has been held. setSchedulerClassCover writes the row with the cover;
 * a cover from before that (audit then best-effort) may have none, and the
 * rule then falls back to the class's updated_at.
 */
export async function listLatestClassCoverAudits(
  organizationId: string,
  classIds: readonly string[],
): Promise<Map<string, { covering_coach_account_id: string | null; created_at: string }>> {
  const latest = new Map<string, { covering_coach_account_id: string | null; created_at: string }>();
  if (classIds.length === 0) return latest;
  const rows = await query<{ class_id: string; covering_coach_account_id: string | null; created_at: string }>(
    `select distinct on (entity_id)
            entity_id as class_id,
            details->>'covering_coach_account_id' as covering_coach_account_id,
            created_at::text as created_at
     from pilot.audit_events
     where organization_id = $1
       and entity_type = 'scheduler_class'
       and entity_id = any($2::text[])
       and details->>'action' = 'cover_class'
     order by entity_id, created_at desc, audit_id desc`,
    [organizationId, [...classIds]],
  );
  for (const row of rows) {
    latest.set(row.class_id, { covering_coach_account_id: row.covering_coach_account_id, created_at: row.created_at });
  }
  return latest;
}

export async function getSchedulerRegistrationById(
  organizationId: string,
  registrationId: string,
): Promise<SchedulerRegistration | null> {
  return queryOne<SchedulerRegistration>(
    `select registration_id, class_id, athlete_id, requested_by_role, requested_by_account_id,
            parent_reviewed, parent_reviewed_at::text, parent_reviewer_account_id,
            status, created_at::text, updated_at::text
     from pilot.scheduler_registrations
     where organization_id = $1 and registration_id = $2
       -- A deleted athlete's registration is not found, as it is in every
       -- list above: parent_review_registration loaded it by id with no mark,
       -- so an admin could still mark it reviewed (OD-2026-09-29-002 item 10).
       and ${athleteNotDeletedSql('pilot.scheduler_registrations')}`,
    [organizationId, registrationId],
  );
}

export type RegisterForClassOutcome =
  | { outcome: 'class_not_found' }
  | { outcome: 'class_cancelled' }
  | { outcome: 'already_registered' }
  | { outcome: 'training_hold'; holdId: string; athleteExplanation: string; liftConditionText: string }
  | { outcome: 'registered' | 'waitlisted'; registrationId: string; membershipFlags: MembershipFlag[] };

// Registration must not be a check-then-insert sequence: an unlocked
// lookup/count/insert races under concurrent requests, letting two
// simultaneous registrations for the same athlete/class both pass the "not
// already registered" check, and letting registrations near a capacity limit
// all read the same pre-insert count and all be marked 'registered' instead
// of waitlisting the ones over capacity. Locking the class row with `for
// update` first serializes every concurrent attempt against that class --
// regardless of which athlete -- so both races close. A partial unique index on
// (organization_id, class_id, athlete_id) where status <> 'cancelled' backs
// this up at the database level independent of this function.
export async function registerForClassTransactionally(
  organizationId: string,
  classId: string,
  athleteId: string,
  registration: Omit<SchedulerRegistration, 'status'>,
): Promise<RegisterForClassOutcome> {
  return withTransaction(async (client) => {
    const classResult = await client.query<{ capacity: number; status: string }>(
      `select capacity, status
       from pilot.scheduler_classes
       where organization_id = $1 and class_id = $2
       for update`,
      [organizationId, classId],
    );
    const classRow = classResult.rows[0];
    if (!classRow) {
      return { outcome: 'class_not_found' };
    }
    // Read under the same row lock cancelSchedulerClass takes, so a
    // registration racing a cancel either lands first or is refused (#1536).
    if (classRow.status === 'cancelled') {
      return { outcome: 'class_cancelled' };
    }

    // #82 STOP: an active 'all_training' hold refuses the registration
    // before the duplicate/capacity checks, so a held athlete hears the
    // hold's own explanation consistently rather than a mix of conflict
    // messages. Checked inside this transaction (same client), and a
    // missing table (pre-migration window) degrades to the pre-#82
    // behavior via the 42P01 guard in findRegistrationBlockingHold.
    const blockingHold = await findRegistrationBlockingHold(organizationId, athleteId, client);
    if (blockingHold) {
      return {
        outcome: 'training_hold',
        holdId: blockingHold.hold_id,
        athleteExplanation: blockingHold.athlete_explanation,
        liftConditionText: blockingHold.lift_condition_text,
      };
    }

    const existing = await client.query<{ registration_id: string }>(
      `select registration_id
       from pilot.scheduler_registrations
       where organization_id = $1 and class_id = $2 and athlete_id = $3 and status <> 'cancelled'
       limit 1`,
      [organizationId, classId, athleteId],
    );
    if (existing.rows.length > 0) {
      return { outcome: 'already_registered' };
    }

    const countResult = await client.query<{ count: string }>(
      `select count(*)::text as count
       from pilot.scheduler_registrations
       where organization_id = $1 and class_id = $2 and status = 'registered'
         -- A deleted athlete holds no seat: the count the page shows skips
         -- them, and this one has to agree with it (scope B).
         and ${athleteNotDeletedSql('pilot.scheduler_registrations')}`,
      [organizationId, classId],
    );
    const registeredCount = Number.parseInt(countResult.rows[0]?.count ?? '0', 10);
    const status: SchedulerRegistration['status'] = registeredCount >= classRow.capacity ? 'waitlisted' : 'registered';

    await client.query(
      `insert into pilot.scheduler_registrations (
         organization_id, registration_id, class_id, athlete_id,
         requested_by_role, requested_by_account_id,
         parent_reviewed, parent_reviewed_at, parent_reviewer_account_id,
         status, created_at, updated_at
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        organizationId,
        registration.registration_id,
        classId,
        athleteId,
        registration.requested_by_role,
        registration.requested_by_account_id,
        registration.parent_reviewed,
        registration.parent_reviewed_at ?? null,
        registration.parent_reviewer_account_id ?? null,
        status,
        registration.created_at,
        registration.updated_at,
      ],
    );

    if (status === 'registered' && registeredCount + 1 >= classRow.capacity && classRow.status !== 'full') {
      await client.query(
        `update pilot.scheduler_classes set status = 'full', updated_at = $3 where organization_id = $1 and class_id = $2`,
        [organizationId, classId, registration.updated_at],
      );
    }

    // Non-blocking membership flag (capability-network audit finding): a
    // lapsed/ended program membership never refuses the registration --
    // only a training hold does that (#82 STOP above). It rides along on a
    // successful registration so a coach/admin sees it and can follow up
    // with the family; the owner's product-policy call on whether it
    // should ever hard-block is deliberately still open.
    const membershipFlags = await listMembershipFlagsForAthlete(organizationId, athleteId, client);

    return { outcome: status, registrationId: registration.registration_id, membershipFlags };
  });
}

export async function markSchedulerRegistrationReviewed(
  organizationId: string,
  registrationId: string,
  reviewerAccountId: string,
  reviewedAt: string,
): Promise<void> {
  await query(
    `update pilot.scheduler_registrations
     set parent_reviewed = true,
         parent_reviewed_at = $3,
         parent_reviewer_account_id = $4,
         updated_at = $3
     where organization_id = $1 and registration_id = $2`,
    [organizationId, registrationId, reviewedAt, reviewerAccountId],
  );
}

export async function createSchedulerCoachingRequest(organizationId: string, item: SchedulerCoachingRequest): Promise<void> {
  await query(
    `insert into pilot.scheduler_coaching_requests (
       organization_id, request_id, athlete_id,
       requested_by_role, requested_by_account_id,
       preferred_at, goals, status, assigned_coach_account_id,
       created_at, updated_at
     ) values (
       $1,$2,$3,
       $4,$5,
       $6,$7,$8,$9,
       $10,$11
     )`,
    [
      organizationId,
      item.request_id,
      item.athlete_id,
      item.requested_by_role,
      item.requested_by_account_id,
      item.preferred_at,
      item.goals,
      item.status,
      item.assigned_coach_account_id ?? null,
      item.created_at,
      item.updated_at,
    ],
  );
}

export async function getSchedulerCoachingRequestById(
  organizationId: string,
  requestId: string,
): Promise<SchedulerCoachingRequest | null> {
  return queryOne<SchedulerCoachingRequest>(
    `select request_id, athlete_id, requested_by_role, requested_by_account_id,
            preferred_at::text, goals, status, assigned_coach_account_id,
            created_at::text, updated_at::text
     from pilot.scheduler_coaching_requests
     where organization_id = $1 and request_id = $2
       -- Same rule as getSchedulerRegistrationById: review_coaching_request
       -- loaded a deleted athlete's pending request by id, so an admin could
       -- still decline it (OD-2026-09-29-002 item 10).
       and ${athleteNotDeletedSql('pilot.scheduler_coaching_requests')}`,
    [organizationId, requestId],
  );
}

// The resolution half of the coaching-request workflow: pending -> approved
// (with the assigned coach recorded) or pending -> declined. The CAS on
// 'pending' means two admins racing the same request serialize -- the loser
// matches no row and applies nothing, instead of silently overwriting the
// committed decision or re-resolving a settled request. Returns false on
// that miss, and on a cross-organization request_id, which must look the
// same.
export async function resolveSchedulerCoachingRequest(params: {
  organizationId: string;
  requestId: string;
  status: 'approved' | 'declined';
  assignedCoachAccountId: string | null;
  resolvedAt: string;
}): Promise<boolean> {
  const rows = await query<{ request_id: string }>(
    `update pilot.scheduler_coaching_requests
     set status = $3,
         assigned_coach_account_id = $4,
         updated_at = $5
     where organization_id = $1 and request_id = $2 and status = 'pending'
     returning request_id`,
    [params.organizationId, params.requestId, params.status, params.assignedCoachAccountId, params.resolvedAt],
  );

  return rows.length > 0;
}

/* The family's half (Jason 2026-10-19, Q4 "A: Family can withdraw (Rec.)"):
   pending -> withdrawn, on the same CAS as the admin's resolution above, so a
   withdraw racing an approval cannot undo the committed decision. Who may
   call it is the route's job. Exported for the real-Postgres test. */
export const COACHING_REQUEST_WITHDRAW_SQL = `update pilot.scheduler_coaching_requests
     set status = 'withdrawn',
         updated_at = $3
     where organization_id = $1 and request_id = $2 and status = 'pending'
     returning request_id`;

export async function withdrawSchedulerCoachingRequest(params: {
  organizationId: string;
  requestId: string;
  withdrawnAt: string;
}): Promise<boolean> {
  const rows = await query<{ request_id: string }>(
    COACHING_REQUEST_WITHDRAW_SQL,
    [params.organizationId, params.requestId, params.withdrawnAt],
  );
  return rows.length > 0;
}

// One record is the one-element case of the batch: the same atomic
// ON CONFLICT upsert, so a double-tapped check-in button (two concurrent
// requests for the same class/athlete) resolves as last-writer-wins instead
// of the loser's 23505 unique-violation surfacing as an unexplained 500 --
// which is exactly what the previous select-then-write body here did, the
// same race the bulk function's own comment warned about.
export async function upsertSchedulerAttendance(
  organizationId: string,
  item: SchedulerAttendance,
  options: { keepExistingNote?: boolean } = {},
): Promise<void> {
  await bulkUpsertSchedulerAttendance(organizationId, [item], {
    keepExistingNoteFor: options.keepExistingNote ? [item.athlete_id] : [],
  });
}

/**
 * The newest class check-in activity for one athlete at or after a moment, as
 * a scalar subquery another statement embeds: session auto-close's signal 6
 * (sessionAutoClose.ts). The scheduler owns pilot.scheduler_attendance (CT-13),
 * so the read lives here rather than in that module. It is a timestamp, not a
 * participation figure: nothing is counted or summed, and no other attendance
 * source is touched, so pilot.attendance_reconciled (one row per athlete-day,
 * no time of day) cannot answer it.
 *
 * The three arguments are SQL expressions from the caller's own statement
 * (column references such as `s.athlete_id`), never request input.
 */
export function latestClassCheckInAtSql(organizationIdSql: string, athleteIdSql: string, sinceSql: string): string {
  return `(select max(greatest(a.checked_in_at, a.updated_at))
             from pilot.scheduler_attendance a
            where a.organization_id = ${organizationIdSql} and a.athlete_id = ${athleteIdSql}
              and greatest(a.checked_in_at, a.updated_at) >= ${sinceSql})`;
}

/** Athlete ids with a live ('registered') registration for one class. */
export async function listRegisteredAthleteIdsForClass(organizationId: string, classId: string): Promise<string[]> {
  const rows = await query<{ athlete_id: string }>(
    `select athlete_id
     from pilot.scheduler_registrations
     where organization_id = $1 and class_id = $2 and status = 'registered'
       -- A deleted athlete is on no class roster (scope B), so they cannot
       -- be marked present in one either.
       and ${athleteNotDeletedSql('pilot.scheduler_registrations')}`,
    [organizationId, classId],
  );
  return rows.map((row) => row.athlete_id);
}

// Marks a whole roster in one call -- a coach standing in front of a class
// should not have to make one round trip per athlete. A single set-based
// upsert rather than a select-then-write loop per athlete: the loop was both
// slow (2 round trips x roster size) and race-prone (a concurrent writer
// could insert between the existence check and the insert, tripping the
// table's own unique constraint). The database's ON CONFLICT handles the
// existence check atomically, so there is nothing left to race.
//
// attendance_id is deliberately absent from the SET clause: Postgres upsert
// semantics leave any column not listed there untouched on a conflict, so an
// existing row keeps its original id and only a genuinely new row gets the
// one this call generated.
// keepExistingNoteFor: athletes whose stored note this write must not
// replace. The coach running a class marks every athlete on it
// (OD-2026-10-07-008 ruling 4) but reads the note only for athletes they
// reach (Overwatch option B), so their mark cannot be allowed to overwrite --
// and erase, unseen -- a note the athlete's own coach wrote. A new row still
// gets the item's note, which the route sets to ''.
export const ATTENDANCE_UPSERT_SQL = `insert into pilot.scheduler_attendance (
       organization_id, attendance_id, class_id, athlete_id,
       status, method,
       checked_in_by_role, checked_in_by_account_id,
       note, checked_in_at, updated_at
     )
     select
       $1::text,
       unnest($2::text[]),
       unnest($3::text[]),
       unnest($4::text[]),
       unnest($5::text[]),
       unnest($6::text[]),
       unnest($7::text[]),
       unnest($8::text[]),
       unnest($9::text[]),
       unnest($10::timestamptz[]),
       unnest($11::timestamptz[])
     on conflict (organization_id, class_id, athlete_id) do update
     set status = excluded.status,
         method = excluded.method,
         checked_in_by_role = excluded.checked_in_by_role,
         checked_in_by_account_id = excluded.checked_in_by_account_id,
         note = case
           when excluded.athlete_id = any($12::text[]) then pilot.scheduler_attendance.note
           else excluded.note
         end,
         checked_in_at = excluded.checked_in_at,
         updated_at = excluded.updated_at`;

/*
 * A FAMILY CHECK-IN NEVER CHANGES A STAFF MARK (Jason 2026-10-12, issue #1524:
 * "A self check-in never replaces a coach or admin mark").
 *
 * ATTENDANCE_UPSERT_SQL above replaces whatever row is there. That is right
 * for the register, and it is how an athlete's "Present" on 2026-10-12 landed
 * on top of the coach's mark for a class on 2026-10-05 (audit F-046). An
 * athlete's or parent's write goes through this statement instead: it may
 * insert, and it may update a row that a family wrote ('self' or 'parent'),
 * but the update's WHERE leaves a coach's, an admin's or a walk-in mark
 * exactly as it was. The condition is inside the one statement, so a coach
 * marking the register at the same moment cannot be overwritten in a race.
 *
 * Returns whether a row was written: false means a staff mark already stood
 * and nothing changed.
 */
export const FAMILY_ATTENDANCE_UPSERT_SQL = `insert into pilot.scheduler_attendance (
       organization_id, attendance_id, class_id, athlete_id,
       status, method,
       checked_in_by_role, checked_in_by_account_id,
       note, checked_in_at, updated_at
     )
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::timestamptz, $11::timestamptz)
     on conflict (organization_id, class_id, athlete_id) do update
     set status = excluded.status,
         method = excluded.method,
         checked_in_by_role = excluded.checked_in_by_role,
         checked_in_by_account_id = excluded.checked_in_by_account_id,
         note = excluded.note,
         checked_in_at = excluded.checked_in_at,
         updated_at = excluded.updated_at
     where pilot.scheduler_attendance.method in ('self', 'parent')
        -- A parent's mark from before the parent-method migration is stored as
        -- 'coach_override' with checked_in_by_role 'parent'
        -- (pilot_slice_postgres_attendance_parent_method_migration.sql): it is
        -- the family's own mark, not a staff one. Staff writes always record a
        -- staff role, so this never opens a coach's or admin's mark.
        or pilot.scheduler_attendance.checked_in_by_role in ('athlete', 'parent')
     returning attendance_id`;

export async function upsertFamilySchedulerAttendance(
  organizationId: string,
  item: SchedulerAttendance,
): Promise<boolean> {
  const rows = await query<{ attendance_id: string }>(FAMILY_ATTENDANCE_UPSERT_SQL, [
    organizationId,
    item.attendance_id,
    item.class_id,
    item.athlete_id,
    item.status,
    item.method,
    item.checked_in_by_role,
    item.checked_in_by_account_id,
    item.note,
    item.checked_in_at,
    item.updated_at,
  ]);
  return rows.length > 0;
}

export function attendanceUpsertParams(
  organizationId: string,
  items: SchedulerAttendance[],
  keepExistingNoteFor: readonly string[] = [],
): unknown[] {
  return [
    organizationId,
    items.map((item) => item.attendance_id),
    items.map((item) => item.class_id),
    items.map((item) => item.athlete_id),
    items.map((item) => item.status),
    items.map((item) => item.method),
    items.map((item) => item.checked_in_by_role),
    items.map((item) => item.checked_in_by_account_id),
    items.map((item) => item.note),
    items.map((item) => item.checked_in_at),
    items.map((item) => item.updated_at),
    [...keepExistingNoteFor],
  ];
}

export async function bulkUpsertSchedulerAttendance(
  organizationId: string,
  items: SchedulerAttendance[],
  options: { keepExistingNoteFor?: readonly string[] } = {},
): Promise<void> {
  if (items.length === 0) return;

  await query(ATTENDANCE_UPSERT_SQL, attendanceUpsertParams(organizationId, items, options.keepExistingNoteFor));
}
