import { randomUUID } from 'node:crypto';

import { NextResponse, type NextRequest } from 'next/server';

import {
  assertActiveCoachAccount,
  assertActorCanAccessAthlete,
  assertCoachAssignedToAthlete,
  athleteIdsForCoach,
  isOrganizationAdminRole,
} from '@/src/server/pilot/access';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { sanitizedSqlState } from '@/src/server/pilot/db';
import { guardianAthleteIds } from '@/src/server/pilot/guardianAccess';
import { getSafetyGateDefinition, recordSafetyGateEvaluation } from '@/src/server/pilot/safetyGateMatrix';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';
import {
  bulkUpsertSchedulerAttendance,
  createSchedulerClass,
  createSchedulerCoachingRequest,
  getSchedulerClassById,
  getSchedulerCoachingRequestById,
  getSchedulerRegistrationById,
  listRegisteredAthleteIdsForClass,
  listSchedulerStore,
  markSchedulerRegistrationReviewed,
  registerForClassTransactionally,
  resolveSchedulerCoachingRequest,
  setSchedulerClassCover,
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
  | 'review_coaching_request'
  | 'attendance_checkin'
  | 'bulk_attendance_checkin';

// A lost audit row is a gap an operator can close by re-dispatching, not a
// reason to tell the admin their (already-committed) resolution failed --
// same doctrine as the compliance console's auditComplianceEvent and
// training-holds' auditHoldEvent.
async function auditSchedulerEvent(event: Parameters<typeof writePilotAuditEvent>[0]): Promise<void> {
  try {
    await writePilotAuditEvent(event);
  } catch (error) {
    const rawCode = error && typeof error === 'object' && 'code' in error ? (error as { code: unknown }).code : undefined;
    const code = sanitizedSqlState(rawCode);
    console.error({
      event: 'scheduler-audit-write-failed',
      action: event.details && typeof event.details === 'object' ? (event.details as { action?: unknown }).action : undefined,
      ...(code ? { code } : {}),
    });
  }
}

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

// The coach-reachable "my athletes" set (coach of record plus active coverage
// grants), fed into filterStateForActor the way getParentAthleteIds feeds the
// parent branch. Coaching requests are athlete-linked with no class_id, so
// class ownership cannot scope them -- athlete-reachability is the dimension
// that can.
async function getCoachAthleteIds(actor: SchedulerActor): Promise<string[]> {
  if (actor.role !== 'coach') {
    return [];
  }

  return athleteIdsForCoach(actor.organizationId, actor.accountId);
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

/**
 * SEATS TAKEN IN THE CLASS, not seats taken by people this reader can see.
 *
 * This used to be called as decorateClasses(filtered), counting the
 * registrations that survived filterStateForActor. Those are scoped to the
 * reader: a guardian keeps only their own children's rows, an athlete only
 * their own, a coach only the owned-class-and-reachable-athlete intersection.
 * So the number rendered as "Seats: 3/20" was the number of seats taken BY
 * THAT READER'S OWN HOUSEHOLD -- 0 or 1 for nearly every family, on a class
 * that might be full.
 *
 * The label is not ambiguous about what it promises. app/schedule/page.tsx
 * prints it beside the capacity, and a family reads it to decide whether
 * there is room. Answering "0/20" for a full class is not a narrower truth,
 * it is a wrong one, and it sends a parent into a registration the server
 * will then refuse.
 *
 * SO THE COUNT COMES FROM THE UNFILTERED STORE while the rows come from the
 * filtered one -- two arguments, deliberately, so the asymmetry is visible at
 * the call site instead of hiding inside one object that means two things.
 *
 * THIS DISCLOSES NOTHING NEW. It is an aggregate over a class every role
 * already receives in full (the catalogue is not row-filtered for anyone),
 * carrying no athlete id, no name and no per-person detail. What it stops
 * doing is reflecting the reader's own household back at them as if it were
 * the gym's.
 *
 * NOT A CAPACITY GATE, and it never was. Capacity is enforced server-side in
 * registerForClassTransactionally (schedulerDb.ts), which locks the class row
 * and counts against the database inside the same transaction. This number is
 * for the screen; a wrong one misled a reader, it did not admit anyone.
 */
function decorateClasses(
  classes: readonly SchedulerClass[],
  countFrom: SchedulerStore,
): Array<SchedulerClass & { registered_count: number }> {
  return classes.map((item) => ({
    ...item,
    registered_count: classRegistrationCount(countFrom, item.class_id),
  }));
}

/*
 * WHICH FIELDS OF A SCHEDULER ROW A FAMILY READER MAY SEE.
 *
 * filterStateForActor below answers which ROWS a reader gets, and answers it
 * well -- a parent's registrations, coaching requests and attendance are all
 * scoped to their own linked children. It has never answered which FIELDS,
 * and the rows it hands a family carry two things that were never theirs.
 *
 * ACCOUNT IDENTIFIERS, on every collection. classes carries
 * scheduled_by_account_id, coach_account_id and covering_coach_account_id --
 * and classes is the ONE collection deliberately not row-filtered, because a
 * family browses the whole catalogue to register against it. So every class
 * in the organization arrived at a family carrying three staff identifiers.
 * registrations adds requested_by_account_id and parent_reviewer_account_id;
 * coaching_requests adds requested_by_account_id and
 * assigned_coach_account_id; attendance adds checked_in_by_account_id.
 *
 * An account_id is not an opaque handle on this platform:
 * staffProvisioning.ts:316 resolves it as `existing?.account_id ||
 * accountIdHint || loginEmail`, and the admin invite route supplies the hint
 * only when an admin typed one. So an account_id IS a staff member's login
 * email unless somebody chose otherwise -- and app/schedule/page.tsx printed
 * it under "Coach:" on the class list, to whoever was signed in. The guardian
 * projection drops pilot.parents.account_id and the emergency-contact
 * projection drops `email` on exactly this ground.
 *
 * THE ATTENDANCE NOTE. pilot.scheduler_attendance.note is free text a coach
 * typed about a child; privacyTiers.ts registers it at tier `organization`
 * with that description in as many words, and names
 * attendanceReporting.ts#getClassAttendanceRoster as its enforcer -- a
 * function behind the coach/admin-only attendance-summary route. This route
 * is a second reader that entry does not name, and it shipped the column to
 * the family. Its sibling column on the other attendance table
 * (pilot.attendance.notes) has been staff-only on every one of ITS readers
 * since attendanceColumnsForReader landed.
 *
 * THE RULE, stated so it is reviewable in one sentence: no *_account_id and
 * no staff free-text note reaches a family reader. Everything else stays.
 *
 * WHAT DELIBERATELY STAYS, so each absence is a decision:
 *   checked_in_by_role, requested_by_role  A role names no person, and a
 *                       parent who checked their own child in needs to see
 *                       that it was a parent who did it.
 *   coaching_requests.goals  Free text, but the REQUESTER writes it, and a
 *                       parent can be the requester (requested_by_role
 *                       carries 'parent'). Withholding a family's own words
 *                       from them would be inventing a rule, not applying
 *                       one. The case where a coach wrote it is real and
 *                       unresolved; flagged rather than guessed at.
 *   the class catalogue itself  Not row-filtered, and not filtered here
 *                       either. A family browses it to register against it;
 *                       narrowing it is a product decision, not a privacy
 *                       one.
 */
function isFamilyReader(actor: SchedulerActor): boolean {
  return actor.role === 'parent' || actor.role === 'athlete';
}

type FamilyClass = Omit<
  SchedulerClass,
  'scheduled_by_account_id' | 'coach_account_id' | 'covering_coach_account_id'
> & { registered_count: number };

/* Built by naming what stays rather than by deleting what goes -- an
   allowlist, for the reason intake.ts's waiver projection gives: a column a
   later migration adds must not reach a family by default. Rest-destructuring
   would make every future field family-visible on the day it is added. */
function familyClass(item: SchedulerClass & { registered_count: number }): FamilyClass {
  return {
    class_id: item.class_id,
    title: item.title,
    start_at: item.start_at,
    end_at: item.end_at,
    location: item.location,
    capacity: item.capacity,
    status: item.status,
    created_at: item.created_at,
    updated_at: item.updated_at,
    registered_count: item.registered_count,
  };
}

type FamilyRegistration = Omit<
  SchedulerRegistration,
  'requested_by_account_id' | 'parent_reviewer_account_id'
>;

function familyRegistration(row: SchedulerRegistration): FamilyRegistration {
  return {
    registration_id: row.registration_id,
    class_id: row.class_id,
    athlete_id: row.athlete_id,
    requested_by_role: row.requested_by_role,
    parent_reviewed: row.parent_reviewed,
    parent_reviewed_at: row.parent_reviewed_at,
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

type FamilyCoachingRequest = Omit<
  SchedulerCoachingRequest,
  'requested_by_account_id' | 'assigned_coach_account_id'
>;

function familyCoachingRequest(row: SchedulerCoachingRequest): FamilyCoachingRequest {
  return {
    request_id: row.request_id,
    athlete_id: row.athlete_id,
    requested_by_role: row.requested_by_role,
    preferred_at: row.preferred_at,
    goals: row.goals,
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

type FamilyAttendance = Omit<SchedulerAttendance, 'checked_in_by_account_id' | 'note'>;

function familyAttendance(row: SchedulerAttendance): FamilyAttendance {
  return {
    attendance_id: row.attendance_id,
    class_id: row.class_id,
    athlete_id: row.athlete_id,
    status: row.status,
    method: row.method,
    checked_in_by_role: row.checked_in_by_role,
    checked_in_at: row.checked_in_at,
    updated_at: row.updated_at,
  };
}

function filterStateForActor(
  actor: SchedulerActor,
  store: SchedulerStore,
  parentAthleteIds: string[],
  coachAthleteIds: string[],
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

    const coachReachableAthleteIds = new Set(coachAthleteIds);

    return {
      classes,
      /* Class ownership AND athlete-reachability, not class ownership alone.
         These rows name individual athletes, so they need the same dimension
         coaching_requests below already uses.

         Ownership by itself was self-granting. cover_class checks only that the
         caller is a coach, then writes their own accountId as the covering
         coach -- no approval, no check that the class's coach is unavailable,
         no time bound, no audit row -- and covering_coach_account_id is one of
         the three things this filter counts as ownership. So one POST bought
         any coach every registration and attendance row, including free-text
         notes, for any class in the organization, covering athletes they hold
         no assignment and no coverage grant for.

         The write side was never the hole: assertCanActOnAthlete still gates
         per-athlete writes. This was a read leak, and the fix is the filter the
         next property down already had. */
      registrations: store.registrations.filter(
        (row) => coachOwnedClassIds.has(row.class_id) && coachReachableAthleteIds.has(row.athlete_id),
      ),
      // Coaching requests carry an athlete_id and no class_id, so they are
      // scoped by athlete-reachability -- the same dimension the parent and
      // athlete branches use -- not by class ownership. Returning
      // store.coaching_requests unfiltered leaked every athlete's 1:1 request
      // (athlete_id, free-text goals, preferred_at) org-wide to any coach.
      coaching_requests: store.coaching_requests.filter((row) => coachReachableAthleteIds.has(row.athlete_id)),
      // Same reasoning as registrations above. Attendance rows carry an
      // athlete_id and a free-text note, so class ownership alone is not a
      // sufficient scope for them either.
      attendance: store.attendance.filter(
        (row) => coachOwnedClassIds.has(row.class_id) && coachReachableAthleteIds.has(row.athlete_id),
      ),
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
    const [parentAthleteIds, coachAthleteIds] = await Promise.all([
      getParentAthleteIds(actor),
      getCoachAthleteIds(actor),
    ]);
    const filtered = filterStateForActor(actor, store, parentAthleteIds, coachAthleteIds);
    // Rows from the filtered store, seat counts from the unfiltered one --
    // see decorateClasses for why those are two different questions.
    const classes = decorateClasses(filtered.classes, store);

    // The field projection runs AFTER filterStateForActor, not inside it,
    // because the coach branch reads coach_account_id and
    // covering_coach_account_id to work out which classes it owns. Narrowing
    // earlier would have taken the coach's own ownership test away from it.
    const family = isFamilyReader(actor);

    return NextResponse.json({
      ok: true,
      role: actor.role,
      athlete_id: actor.athleteId,
      classes: family ? classes.map(familyClass) : classes,
      registrations: family ? filtered.registrations.map(familyRegistration) : filtered.registrations,
      coaching_requests: family
        ? filtered.coaching_requests.map(familyCoachingRequest)
        : filtered.coaching_requests,
      attendance: family ? filtered.attendance.map(familyAttendance) : filtered.attendance,
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
      request_id?: string;
      decision?: string;
      assigned_coach_account_id?: string;
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

      // #82 STOP: registration refused by an active all-training hold. 403
      // with the hold's own words -- the explanation was written FOR the
      // athlete, and the lift condition is the teaching moment. The blocked
      // attempt is recorded as a gate evaluation (append-only fact), so
      // "how often is this child trying to come back" is answerable later.
      //
      // Same FK constraint contactClearanceGate.ts already documents:
      // pilot.safety_gate_evaluations references (organization_id,
      // gate_key) in pilot.safety_gates, and that gate row's own migration
      // is a separate operator dispatch from the training-holds migration
      // -- an org can have holds placeable before it has the gate row.
      // Recording is therefore best-effort, gated on the row existing,
      // exactly like contactClearanceGate's pattern: the refusal itself,
      // and the explanation written for the athlete, must never depend on
      // whether the evaluations table can accept the write.
      if (result.outcome === 'training_hold') {
        // pilot.safety_gates ships in this same PR, so the whole table --
        // not just the training_hold row -- may not exist yet either;
        // guard the table-missing case the same way trainingHolds.ts does
        // elsewhere, so a fully pre-migration deploy still returns the 403.
        let gate = null;
        try {
          gate = await getSafetyGateDefinition(actor.organizationId, 'training_hold');
        } catch (error) {
          if ((error as { code?: unknown }).code !== '42P01') {
            throw error;
          }
        }
        if (gate) {
          await recordSafetyGateEvaluation({
            organizationId: actor.organizationId,
            gateKey: 'training_hold',
            athleteId,
            outcome: 'blocked',
            reason: 'Class registration refused: active all-training hold',
            evaluatedByAccountId: actor.accountId,
            evaluatedByRole: actorRole,
            contextId: classId,
            metadata: { hold_id: result.holdId },
            evaluatedAt: now,
          });
        }
        return NextResponse.json(
          {
            error: 'Training hold: registration is paused for this athlete',
            athlete_explanation: result.athleteExplanation,
            lift_condition: result.liftConditionText,
          },
          { status: 403 },
        );
      }

      // Non-blocking membership flag (capability-network audit finding):
      // registration itself is never refused for a lapsed/ended membership
      // -- only an all-training hold does that, above -- but the coach/admin
      // who just registered this athlete should see it. An athlete/parent
      // registering themself sees it too; that mirrors the training-hold
      // explanation, which is also written to be readable by the family, not
      // hidden from them.
      return NextResponse.json({
        ok: true,
        class_id: classId,
        athlete_id: athleteId,
        status: result.outcome,
        membership_flags: result.membershipFlags,
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

    if (action === 'review_coaching_request') {
      // Owner policy (2026-08-14): resolving a 1:1 coaching request is
      // org-admin-only. Coaches may not approve, decline, self-assign, or
      // claim -- so this deliberately does NOT reuse the wider
      // coach-inclusive management checks the class actions carry. A
      // request creates a private adult-to-minor coaching arrangement, and
      // that call sits with the organization, not the coach who would
      // benefit from it.
      if (!canManageAll(actor)) {
        throw new Error('Forbidden: only an organization admin can resolve coaching requests');
      }

      const requestId = typeof body.request_id === 'string' ? body.request_id.trim() : '';
      if (!requestId) {
        throw new Error('Missing request_id');
      }
      const decision = body.decision;
      if (decision !== 'approve' && decision !== 'decline') {
        throw new Error('Unsupported decision: expected "approve" or "decline"');
      }

      const coachingRequest = await getSchedulerCoachingRequestById(actor.organizationId, requestId);
      if (!coachingRequest) {
        throw new Error('Missing coaching request record');
      }
      if (coachingRequest.status !== 'pending') {
        throw new Error('Unsupported: coaching request was already resolved');
      }

      let assignedCoachAccountId: string | null = null;
      if (decision === 'approve') {
        const named = typeof body.assigned_coach_account_id === 'string' ? body.assigned_coach_account_id.trim() : '';
        if (!named) {
          throw new Error('Missing assigned_coach_account_id: an approval must name the coach to assign');
        }
        assignedCoachAccountId = named;
        await assertActiveCoachAccount(actor.organizationId, assignedCoachAccountId, 'assigned_coach_account_id');

        // The assignment must ride the existing coach<->athlete access
        // model: the athlete's coach of record, or an active bounded
        // coverage grant. This workflow validates rather than grants -- a
        // temporary coach gets access through the coach-coverage console
        // (expiring, revocable, audited), never through a parallel grant
        // created here, and the permanent coach_id is never changed by an
        // approval.
        try {
          await assertCoachAssignedToAthlete(assignedCoachAccountId, coachingRequest.athlete_id, actor.organizationId);
        } catch {
          throw new Error(
            'Forbidden: the selected coach has no active relationship with this athlete. '
            + 'Assign the coach of record, or grant temporary coverage from the coach coverage console first.',
          );
        }
      }

      const resolvedAt = new Date().toISOString();
      const applied = await resolveSchedulerCoachingRequest({
        organizationId: actor.organizationId,
        requestId,
        status: decision === 'approve' ? 'approved' : 'declined',
        assignedCoachAccountId,
        resolvedAt,
      });
      // The CAS re-checks 'pending', so two admins racing the same request
      // serialize -- the loser is told it was already resolved rather than
      // silently overwriting the committed decision.
      if (!applied) {
        throw new Error('Unsupported: coaching request was already resolved');
      }

      // Resolving who may coach a minor 1:1 is a safeguarding-relevant
      // decision; it carries the same attribution the coverage grants do.
      await auditSchedulerEvent({
        event_type: 'update',
        actor_account_id: actor.accountId,
        actor_role: actor.role,
        organization_id: actor.organizationId,
        entity_type: 'scheduler_coaching_request',
        entity_id: requestId,
        details: {
          action: decision === 'approve' ? 'coaching_request_approved' : 'coaching_request_declined',
          athlete_id: coachingRequest.athlete_id,
          ...(assignedCoachAccountId ? { assigned_coach_account_id: assignedCoachAccountId } : {}),
        },
        shadow_mirror: false,
      });

      return NextResponse.json({
        ok: true,
        request_id: requestId,
        status: decision === 'approve' ? 'approved' : 'declined',
        ...(assignedCoachAccountId ? { assigned_coach_account_id: assignedCoachAccountId } : {}),
      });
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
