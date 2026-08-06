import { randomUUID } from 'node:crypto';

import { NextResponse, type NextRequest } from 'next/server';

import { assertActorCanAccessAthlete, isOrganizationAdminRole } from '@/src/server/pilot/access';
import { guardianAthleteIds } from '@/src/server/pilot/guardianAccess';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';
import {
  bulkUpsertSchedulerAttendance,
  createSchedulerClass,
  createSchedulerCoachingRequest,
  getSchedulerClassById,
  getSchedulerRegistrationById,
  listRegisteredAthleteIdsForClass,
  listSchedulerStore,
  markSchedulerRegistrationReviewed,
  registerForClassTransactionally,
  setSchedulerClassCover,
  type SchedulerAttendance,
  type SchedulerClass,
  type SchedulerCoachingRequest,
  type SchedulerRole,
  type SchedulerStore,
  upsertSchedulerAttendance,
} from '@/src/server/pilot/schedulerDb';

export const runtime = 'nodejs';

type SchedulerAction =
  | 'create_class'
  | 'cover_class'
  | 'register_class'
  | 'parent_review_registration'
  | 'request_coaching'
  | 'attendance_checkin'
  | 'bulk_attendance_checkin';

type SchedulerActorRole = SchedulerRole | 'platform_owner' | 'volunteer' | 'staff';

interface SchedulerActor {
  accountId: string;
  role: SchedulerActorRole;
  organizationId: string;
  athleteId: string | null;
}

function toIso(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${field} must be a non-empty string`);
  }

  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`${field} must be a valid date string`);
  }

  return d.toISOString();
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function requiredInt(value: unknown, field: string): number {
  if (typeof value !== 'number' || Number.isNaN(value) || !Number.isInteger(value)) {
    throw new Error(`${field} must be an integer`);
  }
  return value;
}

function normalizeRole(role: SchedulerActorRole): SchedulerRole {
  if (role === 'admin') return 'admin';
  if (role === 'organization_admin') return 'organization_admin';
  if (role === 'athlete' || role === 'coach' || role === 'parent') return role;
  throw new Error('Forbidden: role not allowed for scheduler');
}

function canManageAll(actor: SchedulerActor): boolean {
  return actor.role === 'admin' || isOrganizationAdminRole(actor.role as SchedulerActorRole);
}

// A parent has been able to check in their own linked child since
// attendance_checkin shipped (assertCanActOnAthlete permits it), but this
// resolution only ever considered "is this the athlete themself" or "can
// this actor manage the whole org" -- a parent fell into the `else` branch
// and was recorded as `coach_override`, misattributing who actually made the
// call. `checked_in_by_role` was always correct ('parent'); only `method`
// lied. See infra/azure/pilot_slice_postgres_attendance_parent_method_migration.sql
// for why a migration was needed to store this honestly.
function resolveAttendanceMethod(actor: SchedulerActor, isSelf: boolean): SchedulerAttendance['method'] {
  if (isSelf) return 'self';
  if (actor.role === 'parent') return 'parent';
  return canManageAll(actor) ? 'admin_override' : 'coach_override';
}

// A coach writes attendance only into a class they own (teach, scheduled, or
// cover) -- the same ownership test the attendance-summary READ route already
// enforces. Without this, a coach could overwrite another coach's attendance
// attestations in a class they cannot even view: write access without read
// access, on a safeguarding record about minors. Athlete/parent paths are
// governed by assertCanActOnAthlete instead, and admin manages all.
function assertCoachOwnsClass(actor: SchedulerActor, classItem: SchedulerClass): void {
  if (actor.role !== 'coach') return;
  if (
    classItem.coach_account_id === actor.accountId
    || classItem.scheduled_by_account_id === actor.accountId
    || classItem.covering_coach_account_id === actor.accountId
  ) {
    return;
  }
  throw new Error('Forbidden: coach does not own this class');
}

async function getParentAthleteIds(actor: SchedulerActor): Promise<string[]> {
  if (actor.role !== 'parent') {
    return [];
  }

  return guardianAthleteIds(actor.organizationId, actor.accountId);
}

async function assertCanActOnAthlete(actor: SchedulerActor, athleteId: string): Promise<void> {
  if (actor.role === 'athlete') {
    if (!actor.athleteId || actor.athleteId !== athleteId) {
      throw new Error('Forbidden: athlete cannot act on other athlete records');
    }
    return;
  }

  if (actor.role === 'parent') {
    await assertActorCanAccessAthlete(actor as never, athleteId);
    return;
  }

  if (actor.role === 'coach') {
    await assertActorCanAccessAthlete(actor as never, athleteId);
    return;
  }

  if (canManageAll(actor)) {
    return;
  }

  throw new Error('Forbidden: role not allowed');
}

function classRegistrationCount(store: SchedulerStore, classId: string): number {
  return store.registrations.filter((entry) => entry.class_id === classId && entry.status === 'registered').length;
}

function decorateClasses(store: SchedulerStore): Array<SchedulerClass & { registered_count: number }> {
  return store.classes.map((item) => ({
    ...item,
    registered_count: classRegistrationCount(store, item.class_id),
  }));
}

function filterStateForActor(
  actor: SchedulerActor,
  store: SchedulerStore,
  parentAthleteIds: string[],
): SchedulerStore {
  const classes = store.classes;

  if (canManageAll(actor)) {
    return { ...store, classes };
  }

  if (actor.role === 'coach') {
    const coachOwnedClassIds = new Set(
      store.classes
        .filter(
          (item) =>
            item.coach_account_id === actor.accountId ||
            item.scheduled_by_account_id === actor.accountId ||
            item.covering_coach_account_id === actor.accountId,
        )
        .map((item) => item.class_id),
    );

    return {
      classes,
      registrations: store.registrations.filter((row) => coachOwnedClassIds.has(row.class_id)),
      coaching_requests: store.coaching_requests,
      attendance: store.attendance.filter((row) => coachOwnedClassIds.has(row.class_id)),
    };
  }

  if (actor.role === 'parent') {
    const allowed = new Set(parentAthleteIds);
    return {
      classes,
      registrations: store.registrations.filter((row) => allowed.has(row.athlete_id)),
      coaching_requests: store.coaching_requests.filter((row) => allowed.has(row.athlete_id)),
      attendance: store.attendance.filter((row) => allowed.has(row.athlete_id)),
    };
  }

  if (actor.role === 'athlete') {
    if (!actor.athleteId) {
      return { classes, registrations: [], coaching_requests: [], attendance: [] };
    }
    return {
      classes,
      registrations: store.registrations.filter((row) => row.athlete_id === actor.athleteId),
      coaching_requests: store.coaching_requests.filter((row) => row.athlete_id === actor.athleteId),
      attendance: store.attendance.filter((row) => row.athlete_id === actor.athleteId),
    };
  }

  return { classes, registrations: [], coaching_requests: [], attendance: [] };
}

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    const role = principal.role;
    if (role === 'board') {
      throw new Error('Forbidden: Board role is aggregate-only');
    }
    const actor: SchedulerActor = {
      accountId: principal.accountId,
      role,
      organizationId: principal.organizationId,
      athleteId: principal.athleteId,
    };

    normalizeRole(actor.role);

    const store = await listSchedulerStore(actor.organizationId);
    const parentAthleteIds = await getParentAthleteIds(actor);
    const filtered = filterStateForActor(actor, store, parentAthleteIds);

    return NextResponse.json({
      ok: true,
      role: actor.role,
      athlete_id: actor.athleteId,
      classes: decorateClasses(filtered),
      registrations: filtered.registrations,
      coaching_requests: filtered.coaching_requests,
      attendance: filtered.attendance,
    });
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    const role = principal.role;
    if (role === 'board') {
      throw new Error('Forbidden: Board role is aggregate-only');
    }
    const actor: SchedulerActor = {
      accountId: principal.accountId,
      role,
      organizationId: principal.organizationId,
      athleteId: principal.athleteId,
    };
    const actorRole = normalizeRole(actor.role);

    const body = (await request.json()) as {
      action?: SchedulerAction;
      class_id?: string;
      athlete_id?: string;
      title?: string;
      start_at?: string;
      end_at?: string;
      location?: string;
      capacity?: number;
      preferred_at?: string;
      goals?: string;
      registration_id?: string;
      status?: 'present' | 'absent' | 'excused';
      note?: string;
      entries?: Array<{
        athlete_id?: string;
        status?: 'present' | 'absent' | 'excused';
        note?: string;
      }>;
    };

    const action = body.action;
    if (!action) throw new Error('Missing action');

    if (action === 'create_class') {
      if (!(actor.role === 'coach' || canManageAll(actor))) {
        throw new Error('Forbidden: only coach/admin can schedule classes');
      }

      const title = requiredString(body.title, 'title');
      const startAt = toIso(body.start_at, 'start_at');
      const endAt = toIso(body.end_at, 'end_at');
      const location = requiredString(body.location, 'location');
      const capacity = requiredInt(body.capacity, 'capacity');
      if (capacity < 1 || capacity > 200) {
        throw new Error('capacity must be between 1 and 200');
      }

      const now = new Date().toISOString();
      const classRecord: SchedulerClass = {
        class_id: randomUUID(),
        title,
        start_at: startAt,
        end_at: endAt,
        location,
        capacity,
        scheduled_by_account_id: actor.accountId,
        coach_account_id: actor.accountId,
        status: 'open',
        created_at: now,
        updated_at: now,
      };

      await createSchedulerClass(actor.organizationId, classRecord);

      return NextResponse.json({ ok: true, class_id: classRecord.class_id });
    }

    if (action === 'cover_class') {
      if (!(actor.role === 'coach' || canManageAll(actor))) {
        throw new Error('Forbidden: only coach/admin can cover classes');
      }
      const classId = requiredString(body.class_id, 'class_id');
      const existingClass = await getSchedulerClassById(actor.organizationId, classId);
      if (!existingClass) {
        throw new Error('Missing class record');
      }
      await setSchedulerClassCover(actor.organizationId, classId, actor.accountId, new Date().toISOString());

      return NextResponse.json({ ok: true, class_id: classId });
    }

    if (action === 'register_class') {
      const classId = requiredString(body.class_id, 'class_id');

      let athleteId = body.athlete_id?.trim() || '';
      if (actor.role === 'athlete') {
        athleteId = actor.athleteId ?? '';
      }
      if (!athleteId) throw new Error('Missing athlete_id');

      await assertCanActOnAthlete(actor, athleteId);

      const now = new Date().toISOString();

      // registerForClassTransactionally locks the class row and does the
      // already-registered/capacity check and the insert inside one
      // transaction, closing a race where two concurrent requests could
      // previously both pass the checks before either committed (duplicate
      // registrations, or overbooking past capacity).
      const result = await registerForClassTransactionally(actor.organizationId, classId, athleteId, {
        registration_id: randomUUID(),
        class_id: classId,
        athlete_id: athleteId,
        requested_by_role: actorRole,
        requested_by_account_id: actor.accountId,
        // true means "a parent has reviewed this registration" (see
        // markSchedulerRegistrationReviewed). Only a parent registering their
        // own child satisfies that at insert time; an athlete self-registering
        // is exactly the case the review step exists for.
        parent_reviewed: actor.role === 'parent',
        parent_reviewed_at: actor.role === 'parent' ? now : undefined,
        parent_reviewer_account_id: actor.role === 'parent' ? actor.accountId : undefined,
        created_at: now,
        updated_at: now,
      });

      if (result.outcome === 'class_not_found') {
        throw new Error('Missing class record');
      }
      // A duplicate registration is a caller-visible conflict, not a server
      // fault: thrown here it would carry no jsonError prefix and be masked
      // as a 500, leaving the parent no way to tell they are already signed up.
      if (result.outcome === 'already_registered') {
        return NextResponse.json(
          { error: 'Athlete already registered for this class' },
          { status: 409 },
        );
      }

      return NextResponse.json({
        ok: true,
        class_id: classId,
        athlete_id: athleteId,
        status: result.outcome,
      });
    }

    if (action === 'parent_review_registration') {
      if (!(actor.role === 'parent' || canManageAll(actor))) {
        throw new Error('Forbidden: only parent/admin can review registrations');
      }

      const registrationId = requiredString(body.registration_id, 'registration_id');

      const registration = await getSchedulerRegistrationById(actor.organizationId, registrationId);
      if (!registration) {
        throw new Error('Missing registration record');
      }

      if (actor.role === 'parent') {
        await assertActorCanAccessAthlete(actor as never, registration.athlete_id);
      }

      await markSchedulerRegistrationReviewed(
        actor.organizationId,
        registrationId,
        actor.accountId,
        new Date().toISOString(),
      );

      return NextResponse.json({ ok: true, registration_id: registrationId });
    }

    if (action === 'request_coaching') {
      let athleteId = body.athlete_id?.trim() || '';
      if (actor.role === 'athlete') {
        athleteId = actor.athleteId ?? '';
      }
      if (!athleteId) throw new Error('Missing athlete_id');

      await assertCanActOnAthlete(actor, athleteId);

      const preferredAt = toIso(body.preferred_at, 'preferred_at');
      const goals = requiredString(body.goals, 'goals');
      const now = new Date().toISOString();

      const coachingRequest: SchedulerCoachingRequest = {
        request_id: randomUUID(),
        athlete_id: athleteId,
        requested_by_role: actorRole,
        requested_by_account_id: actor.accountId,
        preferred_at: preferredAt,
        goals,
        status: 'pending',
        created_at: now,
        updated_at: now,
      };

      await createSchedulerCoachingRequest(actor.organizationId, coachingRequest);

      return NextResponse.json({ ok: true, request_id: coachingRequest.request_id });
    }

    if (action === 'attendance_checkin') {
      const classId = requiredString(body.class_id, 'class_id');
      const status = body.status;
      if (status !== 'present' && status !== 'absent' && status !== 'excused') {
        throw new Error('status must be present, absent, or excused');
      }

      let athleteId = body.athlete_id?.trim() || '';
      if (actor.role === 'athlete') {
        athleteId = actor.athleteId ?? '';
      }
      if (!athleteId) {
        throw new Error('Missing athlete_id');
      }

      await assertCanActOnAthlete(actor, athleteId);

      const isSelf = actor.role === 'athlete';
      if (isSelf && status !== 'present') {
        throw new Error('Forbidden: athlete self check-in can only mark present');
      }

      const now = new Date().toISOString();
      const method = resolveAttendanceMethod(actor, isSelf);

      const classItem = await getSchedulerClassById(actor.organizationId, classId);
      if (!classItem) {
        throw new Error('Missing class record');
      }
      assertCoachOwnsClass(actor, classItem);

      // Attendance is only recordable for a registered athlete. An
      // unregistered mark would count in the org summary while appearing on
      // no class roster -- a number no drill-down could explain or correct --
      // and it is also what let an athlete self-mark 'present' in every
      // class in the gym.
      const registeredIds = await listRegisteredAthleteIdsForClass(actor.organizationId, classId);
      if (!registeredIds.includes(athleteId)) {
        throw new Error('Missing registration: athlete is not registered for this class');
      }

      const attendanceRecord: SchedulerAttendance = {
        attendance_id: randomUUID(),
        class_id: classId,
        athlete_id: athleteId,
        status,
        method,
        checked_in_by_role: actorRole,
        checked_in_by_account_id: actor.accountId,
        note: typeof body.note === 'string' ? body.note.trim() : '',
        checked_in_at: now,
        updated_at: now,
      };

      await upsertSchedulerAttendance(actor.organizationId, attendanceRecord);

      return NextResponse.json({ ok: true, class_id: classId, athlete_id: athleteId });
    }

    if (action === 'bulk_attendance_checkin') {
      // A coach marking a whole class at once, rather than one athlete per
      // request. Only coach/admin may use this action -- an athlete or
      // parent's self/child-scoped check-in stays on attendance_checkin,
      // where assertCanActOnAthlete already enforces they can only ever
      // touch their own record.
      if (!(actor.role === 'coach' || canManageAll(actor))) {
        throw new Error('Forbidden: only coach/admin can bulk-mark attendance');
      }

      const classId = requiredString(body.class_id, 'class_id');
      const classItem = await getSchedulerClassById(actor.organizationId, classId);
      if (!classItem) {
        throw new Error('Missing class record');
      }
      assertCoachOwnsClass(actor, classItem);

      const entries = body.entries;
      if (!Array.isArray(entries) || entries.length === 0) {
        throw new Error('Missing entries: must be a non-empty array');
      }
      if (entries.length > 200) {
        throw new Error('Unsupported entries: must not exceed 200 per request');
      }

      // Same registration requirement as the single check-in path, for the
      // same reason -- fetched once for the whole batch.
      const registeredIds = new Set(await listRegisteredAthleteIdsForClass(actor.organizationId, classId));

      const now = new Date().toISOString();
      const seenAthleteIds = new Set<string>();
      const records: SchedulerAttendance[] = [];

      for (const entry of entries) {
        const entryAthleteId = requiredString(entry?.athlete_id, 'entries[].athlete_id');
        const entryStatus = entry?.status;
        if (entryStatus !== 'present' && entryStatus !== 'absent' && entryStatus !== 'excused') {
          throw new Error('Unsupported entries[].status: must be present, absent, or excused');
        }
        if (seenAthleteIds.has(entryAthleteId)) {
          throw new Error(`Unsupported entries: duplicate athlete_id ${entryAthleteId}`);
        }
        seenAthleteIds.add(entryAthleteId);
        if (!registeredIds.has(entryAthleteId)) {
          throw new Error(`Missing registration: athlete ${entryAthleteId} is not registered for this class`);
        }

        // Every athlete in the batch, not just the actor's own athleteId,
        // must pass the same ownership check a single check-in would --
        // a coach can only mark athletes they are actually assigned to
        // (assertCanActOnAthlete -> assertCoachAssignedToAthlete), even
        // inside a bulk call.
        await assertCanActOnAthlete(actor, entryAthleteId);

        records.push({
          attendance_id: randomUUID(),
          class_id: classId,
          athlete_id: entryAthleteId,
          status: entryStatus,
          method: resolveAttendanceMethod(actor, false),
          checked_in_by_role: actorRole,
          checked_in_by_account_id: actor.accountId,
          note: typeof entry?.note === 'string' ? entry.note.trim() : '',
          checked_in_at: now,
          updated_at: now,
        });
      }

      await bulkUpsertSchedulerAttendance(actor.organizationId, records);

      return NextResponse.json({
        ok: true,
        class_id: classId,
        marked_count: records.length,
        athlete_ids: records.map((record) => record.athlete_id),
      });
    }

    throw new Error(`Unsupported action: ${action}`);
  } catch (error) {
    return jsonError(error);
  }
}
