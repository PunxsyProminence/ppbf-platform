import { randomUUID } from 'node:crypto';

import { NextResponse, type NextRequest } from 'next/server';

import { assertActorCanAccessAthlete, isOrganizationAdminRole } from '@/src/server/pilot/access';
import { query } from '@/src/server/pilot/db';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';
import {
  countRegisteredForClass,
  createSchedulerClass,
  createSchedulerCoachingRequest,
  createSchedulerRegistration,
  getActiveSchedulerRegistration,
  getSchedulerClassById,
  getSchedulerRegistrationById,
  listSchedulerStore,
  markSchedulerRegistrationReviewed,
  setSchedulerClassCover,
  setSchedulerClassStatus,
  type SchedulerAttendance,
  type SchedulerClass,
  type SchedulerCoachingRequest,
  type SchedulerRegistration,
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
  | 'attendance_checkin';

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

async function getParentAthleteIds(actor: SchedulerActor): Promise<string[]> {
  if (actor.role !== 'parent') {
    return [];
  }

  const rows = await query<{ athlete_id: string }>(
    `select distinct gl.athlete_id
     from pilot.guardian_links gl
     join pilot.parents p on p.parent_id = gl.parent_id and p.organization_id = gl.organization_id
     where gl.organization_id = $1 and p.account_id = $2`,
    [actor.organizationId, actor.accountId],
  );

  return rows.map((row) => row.athlete_id);
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
    const actor: SchedulerActor = {
      accountId: principal.accountId,
      role: principal.role,
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
    const actor: SchedulerActor = {
      accountId: principal.accountId,
      role: principal.role,
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
      const registration: SchedulerRegistration = {
        registration_id: randomUUID(),
        class_id: classId,
        athlete_id: athleteId,
        requested_by_role: actorRole,
        requested_by_account_id: actor.accountId,
        parent_reviewed: actor.role !== 'parent',
        parent_reviewed_at: actor.role === 'parent' ? now : undefined,
        parent_reviewer_account_id: actor.role === 'parent' ? actor.accountId : undefined,
        status: 'registered',
        created_at: now,
        updated_at: now,
      };

      const classItem = await getSchedulerClassById(actor.organizationId, classId);
      if (!classItem) {
        throw new Error('Missing class record');
      }

      const already = await getActiveSchedulerRegistration(actor.organizationId, classId, athleteId);
      if (already) {
        throw new Error('Athlete already registered for this class');
      }

      const registeredCount = await countRegisteredForClass(actor.organizationId, classId);
      const nextStatus = registeredCount >= classItem.capacity ? 'waitlisted' : 'registered';

      await createSchedulerRegistration(actor.organizationId, {
        ...registration,
        status: nextStatus,
      });

      if (registeredCount + 1 >= classItem.capacity && classItem.status !== 'full') {
        await setSchedulerClassStatus(actor.organizationId, classId, 'full', now);
      }

      return NextResponse.json({ ok: true, class_id: classId, athlete_id: athleteId });
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
      const method: SchedulerAttendance['method'] = isSelf
        ? 'self'
        : canManageAll(actor)
          ? 'admin_override'
          : 'coach_override';

      const classItem = await getSchedulerClassById(actor.organizationId, classId);
      if (!classItem) {
        throw new Error('Missing class record');
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

    throw new Error(`Unsupported action: ${action}`);
  } catch (error) {
    return jsonError(error);
  }
}
