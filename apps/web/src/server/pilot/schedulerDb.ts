import { query, queryOne, withTransaction } from './db';

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
  status: 'pending' | 'approved' | 'declined';
  assigned_coach_account_id?: string;
  created_at: string;
  updated_at: string;
}

export interface SchedulerAttendance {
  attendance_id: string;
  class_id: string;
  athlete_id: string;
  status: 'present' | 'absent' | 'excused';
  method: 'self' | 'parent' | 'coach_override' | 'admin_override';
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
    query<SchedulerRegistration>(
      `select registration_id, class_id, athlete_id, requested_by_role, requested_by_account_id,
              parent_reviewed, parent_reviewed_at::text, parent_reviewer_account_id,
              status, created_at::text, updated_at::text
       from pilot.scheduler_registrations
       where organization_id = $1
       order by created_at desc`,
      [organizationId],
    ),
    query<SchedulerCoachingRequest>(
      `select request_id, athlete_id, requested_by_role, requested_by_account_id,
              preferred_at::text, goals, status, assigned_coach_account_id,
              created_at::text, updated_at::text
       from pilot.scheduler_coaching_requests
       where organization_id = $1
       order by created_at desc`,
      [organizationId],
    ),
    query<SchedulerAttendance>(
      `select attendance_id, class_id, athlete_id, status, method,
              checked_in_by_role, checked_in_by_account_id, note,
              checked_in_at::text, updated_at::text
       from pilot.scheduler_attendance
       where organization_id = $1
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

export async function createSchedulerClass(organizationId: string, item: SchedulerClass): Promise<void> {
  await query(
    `insert into pilot.scheduler_classes (
       organization_id, class_id, title, start_at, end_at, location, capacity,
       scheduled_by_account_id, coach_account_id, covering_coach_account_id,
       status, created_at, updated_at
     ) values (
       $1,$2,$3,$4,$5,$6,$7,
       $8,$9,$10,
       $11,$12,$13
     )`,
    [
      organizationId,
      item.class_id,
      item.title,
      item.start_at,
      item.end_at,
      item.location,
      item.capacity,
      item.scheduled_by_account_id,
      item.coach_account_id,
      item.covering_coach_account_id ?? null,
      item.status,
      item.created_at,
      item.updated_at,
    ],
  );
}

export async function setSchedulerClassCover(organizationId: string, classId: string, coachAccountId: string, updatedAt: string): Promise<void> {
  await query(
    `update pilot.scheduler_classes
     set covering_coach_account_id = $3,
         updated_at = $4
     where organization_id = $1 and class_id = $2`,
    [organizationId, classId, coachAccountId, updatedAt],
  );
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
     where organization_id = $1 and registration_id = $2`,
    [organizationId, registrationId],
  );
}

export type RegisterForClassOutcome =
  | { outcome: 'class_not_found' }
  | { outcome: 'already_registered' }
  | { outcome: 'registered' | 'waitlisted'; registrationId: string };

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
       where organization_id = $1 and class_id = $2 and status = 'registered'`,
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

    return { outcome: status, registrationId: registration.registration_id };
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

export async function upsertSchedulerAttendance(organizationId: string, item: SchedulerAttendance): Promise<void> {
  const existing = await queryOne<{ attendance_id: string }>(
    `select attendance_id
     from pilot.scheduler_attendance
     where organization_id = $1 and class_id = $2 and athlete_id = $3
     limit 1`,
    [organizationId, item.class_id, item.athlete_id],
  );

  if (existing) {
    await query(
      `update pilot.scheduler_attendance
       set status = $4,
           method = $5,
           checked_in_by_role = $6,
           checked_in_by_account_id = $7,
           note = $8,
           checked_in_at = $9,
           updated_at = $10
       where organization_id = $1 and class_id = $2 and athlete_id = $3`,
      [
        organizationId,
        item.class_id,
        item.athlete_id,
        item.status,
        item.method,
        item.checked_in_by_role,
        item.checked_in_by_account_id,
        item.note,
        item.checked_in_at,
        item.updated_at,
      ],
    );
    return;
  }

  await query(
    `insert into pilot.scheduler_attendance (
       organization_id, attendance_id, class_id, athlete_id,
       status, method,
       checked_in_by_role, checked_in_by_account_id,
       note, checked_in_at, updated_at
     ) values (
       $1,$2,$3,$4,
       $5,$6,
       $7,$8,
       $9,$10,$11
     )`,
    [
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
    ],
  );
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
export async function bulkUpsertSchedulerAttendance(organizationId: string, items: SchedulerAttendance[]): Promise<void> {
  if (items.length === 0) return;

  await query(
    `insert into pilot.scheduler_attendance (
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
         note = excluded.note,
         checked_in_at = excluded.checked_in_at,
         updated_at = excluded.updated_at`,
    [
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
    ],
  );
}
