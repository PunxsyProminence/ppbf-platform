import { isOrganizationAdminRole } from './access';
import type { PilotRole } from './contracts';
import { query, queryOne } from './db';

export const PASSBOOK_ATTENDANCE_STATUSES = ['present', 'late', 'absent'] as const;
export const PASSBOOK_GYM_STATUSES = ['active', 'training', 'inactive'] as const;

/* ---------------------------------------------------------------------------
 * WHO MAY READ WHICH pilot.coach_observations ROW OUT OF THIS BOOK
 *
 * pilot.coach_observations is a SHARED free-text table. `note_type` is plain
 * `text not null` (infra/azure/pilot_slice_postgres.sql:443) with no check
 * constraint, no default and no enum, so it is a label the writer chooses,
 * not a type the database enforces. Several different writers file into it,
 * and one of them is not a coach at all:
 *
 *   home_barrier            app/api/pilot/parent/barrier-report/route.ts --
 *   transportation_barrier    written by a GUARDIAN (role 'parent'), about the
 *                             household. That route's own header describes the
 *                             content as "no ride, an unsafe walk, a barrier at
 *                             home". coach_account_id holds the REPORTING
 *                             GUARDIAN's account id, not a coach's.
 *   parent_message          app/coach/decision-loop's Message Home panel via
 *                             intake/domain-upsert -- a coach/admin message
 *                             ADDRESSED TO THE GUARDIAN, delivered on
 *                             /api/pilot/parent/messages.
 *   behavior_standard       app/coach/decision-loop's Behavior Note panel via
 *                             intake/domain-upsert -- a staff conduct record
 *                             about a minor, capture-only by design.
 *   coach_observation       intake/domain-upsert's default note_type for
 *                             entity_type 'coach_note' -- the coaching note
 *                             about this athlete's own training.
 *   intake_observation      app/api/pilot/intake/review-action's default when
 *                             an intake case is promoted.
 *   onboarding_observation  the label scripts/pilot-shadow-intake-gate.mjs
 *                             sends through that same promotion path.
 *
 * This book is reachable by the ATHLETE THEMSELVES and by EVERY LINKED
 * GUARDIAN -- assertActorCanAccessAthlete (access.ts) admits both -- so
 * reading the table unfiltered handed a child their guardian's account of
 * their own home. That is the defect these lists close.
 *
 * The precedent is already in this repository, one module over: intake.ts's
 * listParentMessages filters to `note_type = 'parent_message'` and its
 * BARRIER_NOTE_TYPES is a closed set, both for the stated reason that such a
 * surface "must never surface a behavior note or a parent message filed under
 * the same table". Same table, same hazard, same answer.
 *
 * ALLOW-LIST, NOT DENY-LIST, and that is load-bearing rather than stylistic:
 * intake/domain-upsert stores `asString(body.payload.note_type,
 * 'coach_observation')` -- ANY free-text label an organization_admin or coach
 * sends -- and review-action stores any label carried in the promotion
 * payload. The set of values that can exist is therefore OPEN. A deny-list
 * cannot enumerate an open set; it admits the next label somebody invents,
 * which is how a guardian's barrier note reached a child to begin with.
 *
 * COST, STATED HERE RATHER THAN DISCOVERED LATER: a note filed under a label
 * that is on none of the lists below appears in NO passbook, including the
 * authoring coach's. The row is not deleted and the staff surfaces that read
 * this table directly are unaffected -- it is this book that stays silent.
 * Adding a note_type is therefore a two-part act: write it, and decide here
 * who may read it.
 *
 * Matching is exact and case-sensitive, matching the intake.ts precedent. A
 * case variant such as 'Home_Barrier' falls off every list, which fails
 * closed rather than open. An empty-string note_type is storable (`not null`
 * does not forbid '') and is likewise on no list: an unlabelled note has no
 * decided audience.
 *
 * NULLABILITY: checked, and it does not apply. `note_type text not null` is
 * that column's ONLY definition anywhere under infra/azure -- no later
 * migration adds, drops or relaxes it. There is no legacy NULL population for
 * an allow-list to strand.
 * ------------------------------------------------------------------------- */

/**
 * What the ATHLETE may read in their own book.
 *
 * INCLUDED -- coach_observation: the coach's note about this athlete's own
 * training, from this athlete's own coach. Author, subject and intended
 * reader all sit inside the coaching relationship. This is what a passbook
 * corner is for.
 *
 * EXCLUDED -- home_barrier, transportation_barrier: guardian-authored, about
 * the household, filed TO the coach. A child must not read their guardian's
 * account of their home. This is the defect being fixed.
 *
 * EXCLUDED -- parent_message: written to the guardian, not to the athlete. A
 * coach writing "can we talk about how he's doing" has not written to the
 * child. Mirror image of listParentMessages' own filter.
 *
 * EXCLUDED -- behavior_standard: a conduct record about a minor, held by
 * staff. The decision-loop writer files every conduct note under this ONE
 * generic label on purpose, because naming categories is the gym's own
 * coaching-philosophy decision -- which means there is no way to show a child
 * the encouraging ones without also showing them the rest, unmediated and
 * with no coach in the room. Publishing conduct notes to the athlete is a
 * product decision for the owner, not a filter default.
 *
 * EXCLUDED -- intake_observation, onboarding_observation: free text promoted
 * out of an intake packet, alongside that packet's medical, waiver and
 * emergency-contact blocks. Nothing constrains it to training content.
 */
export const PASSBOOK_ATHLETE_NOTE_TYPES: readonly string[] = ['coach_observation'];

/**
 * What a LINKED GUARDIAN may read.
 *
 * INCLUDED -- coach_observation: the coaching record about their child.
 *
 * INCLUDED -- parent_message: they are the addressee. It already reaches them
 * on /api/pilot/parent/messages, so keeping it discloses nothing they are not
 * already entitled to, and dropping it would be an unrelated product change
 * riding along on a security fix.
 *
 * EXCLUDED -- home_barrier, transportation_barrier. This is the deliberate
 * call on "should a guardian see their own barrier report back", and the
 * answer is no THROUGH THIS SURFACE, for a structural reason rather than a
 * privacy one: this book is keyed on the ATHLETE, so "the guardian" here is
 * EVERY guardian linked to that athlete, not the one who wrote the report.
 * Admitting these types would show guardian B what guardian A filed -- and
 * the family most likely to file "a barrier at home" is exactly the family
 * where that is not safe. A real read-back ("we received your report") needs
 * an author-scoped reader, `coach_account_id = actor.accountId`, which is a
 * NEW capability rather than a narrowing of this one. ParentHub's "Sent to
 * your child's coach" promise is legitimate and still unbuilt; the safe
 * default until it is built is not to widen.
 *
 * EXCLUDED -- behavior_standard: same single-generic-label problem as for the
 * athlete. A coach who knows every conduct note is published to the family
 * writes fewer of them, and that costs the safeguarding record more than the
 * disclosure gains. Turning this on is an owner decision.
 *
 * EXCLUDED -- intake_observation, onboarding_observation: staff notes taken
 * during case review, not correspondence with the family.
 */
export const PASSBOOK_GUARDIAN_NOTE_TYPES: readonly string[] = [
  'coach_observation',
  'parent_message',
];

/**
 * What STAFF -- coach, organization_admin, and its legacy 'admin' alias --
 * may read: every note_type a writer in this codebase actually produces.
 *
 * None of this is new disclosure. Each type is already reachable by exactly
 * this audience through a purpose-built surface gated the same way: the
 * barrier types via /api/pilot/coach/barrier-reports (DECISION_LOOP_ROLES =
 * coach + organization_admin + admin, then assertActorCanAccessAthlete per
 * athlete -- the same per-athlete gate the passbook route runs);
 * parent_message and behavior_standard are what these accounts wrote; the
 * intake types come out of the review they performed. Excluding them would
 * hide a coach's own record from the coach without protecting anybody.
 *
 * floor_observation is deliberately absent: it appears only as a fixture
 * payload in app/api/pilot/intake/domain-upsert/route.test.ts, no product
 * path writes it, and promoting a test fixture into a product allow-list
 * would be inventing surface.
 */
export const PASSBOOK_STAFF_NOTE_TYPES: readonly string[] = [
  'coach_observation',
  'intake_observation',
  'onboarding_observation',
  'behavior_standard',
  'parent_message',
  'home_barrier',
  'transportation_barrier',
];

/**
 * The note_types one reader may see, by role. Anything else -- board,
 * platform_owner, volunteer, staff, or a role added later -- resolves to the
 * empty list and therefore to no observations at all. The route's requireRole
 * refuses most of those today; resolving them to nothing here keeps a later
 * widening of that gate from silently widening this disclosure with it.
 */
export function passbookObservationNoteTypes(viewerRole: PilotRole): readonly string[] {
  if (viewerRole === 'athlete') return PASSBOOK_ATHLETE_NOTE_TYPES;
  if (viewerRole === 'parent') return PASSBOOK_GUARDIAN_NOTE_TYPES;
  if (viewerRole === 'coach' || isOrganizationAdminRole(viewerRole)) return PASSBOOK_STAFF_NOTE_TYPES;
  return [];
}

export type PassbookAttendanceStatus = (typeof PASSBOOK_ATTENDANCE_STATUSES)[number];
export type PassbookAttendanceStampCode = 'PRESENT' | 'LATE' | 'ABSENT';
export type PassbookGymStatus = (typeof PASSBOOK_GYM_STATUSES)[number];

interface AthleteRow {
  organization_id: string;
  athlete_id: string;
  full_name: string;
  dob: string;
  weight_class: string;
  gym_status: string;
  active_flag: boolean;
  coach_id: string;
  created_at: string;
}

interface SessionRow {
  organization_id: string;
  session_id: string;
  date: string;
  rpe: number;
  notes: string;
  completed_flag: boolean;
}

interface AttendanceRow {
  organization_id: string;
  attendance_id: string;
  attendance_date: string;
  status: string;
  notes: string;
}

interface ReadinessRow {
  organization_id: string;
  readiness_id: string;
  score: number;
  category: string;
  measured_at: string;
}

interface GoalRow {
  organization_id: string;
  goal_id: string;
  title: string;
  target_date: string;
  metric: string;
  status: string;
}

interface CoachObservationRow {
  organization_id: string;
  note_id: string;
  coach_account_id: string;
  note_type: string;
  note_text: string;
  created_at: string;
}

interface GuardianRow {
  organization_id: string;
  parent_id: string;
  full_name: string;
  relationship_to_athlete: string;
}

interface ProgressionGapRow {
  organization_id: string;
  gap_id: string;
  gap_type: string;
  gap_description: string;
  severity: string;
  detected_from: string;
  status: string;
  created_at: string;
}

export interface PassbookAttendanceEntry extends Omit<AttendanceRow, 'organization_id'> {
  canonical_status: PassbookAttendanceStatus | null;
  stamp_code: PassbookAttendanceStampCode | null;
  domain_status: 'canonical' | 'unsupported';
}

export interface AthletePassbook {
  athlete: Omit<AthleteRow, 'organization_id'> & {
    canonical_gym_status: PassbookGymStatus | null;
    gym_status_domain: 'canonical' | 'unsupported';
  };
  pages: {
    attendance: PassbookAttendanceEntry[];
    sessions: Array<Omit<SessionRow, 'organization_id'>>;
    readiness: Array<Omit<ReadinessRow, 'organization_id'>>;
    goals: Array<Omit<GoalRow, 'organization_id'>>;
    corner: {
      coach: { account_id: string };
      guardians: Array<Omit<GuardianRow, 'organization_id'>>;
      observations: Array<Omit<CoachObservationRow, 'organization_id'>>;
    };
    progression_gaps: Array<Omit<ProgressionGapRow, 'organization_id'>>;
  };
  status_domains: {
    attendance: {
      canonical_values: readonly PassbookAttendanceStatus[];
      unsupported_values: string[];
    };
    gym_status: {
      canonical_values: readonly PassbookGymStatus[];
      unsupported_value: string | null;
      note: string;
    };
  };
}

interface CoachPassbookGapQueueRow extends ProgressionGapRow {
  athlete_id: string;
  athlete_name: string;
  coach_id: string;
  last_attended_on: string | null;
  recorded_absences_since_last_visit: number;
}

export type CoachPassbookGapQueueItem = Omit<CoachPassbookGapQueueRow, 'organization_id'>;

function normalizeAttendanceStatus(rawStatus: string): PassbookAttendanceStatus | null {
  const normalized = rawStatus.trim().toLowerCase();
  return PASSBOOK_ATTENDANCE_STATUSES.includes(normalized as PassbookAttendanceStatus)
    ? normalized as PassbookAttendanceStatus
    : null;
}

function attendanceStampCode(status: PassbookAttendanceStatus | null): PassbookAttendanceStampCode | null {
  return status ? status.toUpperCase() as PassbookAttendanceStampCode : null;
}

function mapAttendance(row: AttendanceRow): PassbookAttendanceEntry {
  const canonicalStatus = normalizeAttendanceStatus(row.status);
  return {
    attendance_id: row.attendance_id,
    attendance_date: row.attendance_date,
    status: row.status,
    notes: row.notes,
    canonical_status: canonicalStatus,
    stamp_code: attendanceStampCode(canonicalStatus),
    domain_status: canonicalStatus ? 'canonical' : 'unsupported',
  };
}

function belongsToOrganization(row: { organization_id: string }, organizationId: string): boolean {
  return row.organization_id === organizationId;
}

/**
 * `viewerRole` is required, not optional with a default: the observations
 * page of this book is audience-scoped (see the note_type lists above), and a
 * caller that forgot to say who is reading must fail to compile rather than
 * fall back to the widest audience.
 */
export async function getAthletePassbook(
  organizationId: string,
  athleteId: string,
  viewerRole: PilotRole,
): Promise<AthletePassbook | null> {
  const allowedNoteTypes = passbookObservationNoteTypes(viewerRole);
  const allowedNoteTypeSet = new Set(allowedNoteTypes);

  const athlete = await queryOne<AthleteRow>(
    `select organization_id, athlete_id, full_name, dob, weight_class, gym_status, active_flag, coach_id, created_at
     from pilot.athletes
     where organization_id = $1 and athlete_id = $2`,
    [organizationId, athleteId],
  );

  if (!athlete || !belongsToOrganization(athlete, organizationId)) {
    return null;
  }

  const [sessionRows, attendanceRows, readinessRows, goalRows, observationRows, guardianRows, progressionGapRows] = await Promise.all([
    query<SessionRow>(
      `select organization_id, session_id, date, rpe::float8 as rpe, notes, completed_flag
       from pilot.sessions
       where organization_id = $1 and athlete_id = $2
       order by date desc, created_at desc`,
      [organizationId, athleteId],
    ),
    query<AttendanceRow>(
      `select organization_id, attendance_id::text, attendance_date, status, notes
       from pilot.attendance
       where organization_id = $1 and athlete_id = $2
       order by attendance_date desc, created_at desc`,
      [organizationId, athleteId],
    ),
    query<ReadinessRow>(
      `select organization_id, readiness_id::text, score::float8 as score, category, measured_at
       from pilot.readiness
       where organization_id = $1 and athlete_id = $2
       order by measured_at desc`,
      [organizationId, athleteId],
    ),
    query<GoalRow>(
      `select organization_id, goal_id, title, target_date, metric, status
       from pilot.goals
       where organization_id = $1 and athlete_id = $2
       order by target_date asc, created_at desc`,
      [organizationId, athleteId],
    ),
    query<CoachObservationRow>(
      // note_type is scoped to this reader's audience, exactly as
      // intake.ts's listParentMessages/listBarrierReports scope theirs. An
      // empty allow-list produces `= any('{}')`, which matches no row -- an
      // unrecognized role reads no observation rather than every one.
      `select organization_id, note_id::text, coach_account_id, note_type, note_text, created_at
       from pilot.coach_observations
       where organization_id = $1 and athlete_id = $2
         and note_type = any($3::text[])
       order by created_at desc`,
      [organizationId, athleteId, [...allowedNoteTypes]],
    ),
    query<GuardianRow>(
      `select g.organization_id, p.parent_id, p.full_name, g.relationship_to_athlete
       from pilot.guardian_links g
       join pilot.parents p
         on p.organization_id = g.organization_id
        and p.parent_id = g.parent_id
       where g.organization_id = $1 and g.athlete_id = $2
       order by p.full_name asc, p.parent_id asc`,
      [organizationId, athleteId],
    ),
    query<ProgressionGapRow>(
      `select organization_id, gap_id, gap_type, gap_description, severity, detected_from, status, created_at
       from pilot.progression_gaps
       where organization_id = $1 and athlete_id = $2
       order by created_at desc`,
      [organizationId, athleteId],
    ),
  ]);

  const sessions = sessionRows
    .filter((row) => belongsToOrganization(row, organizationId))
    .map((row) => ({
      session_id: row.session_id,
      date: row.date,
      rpe: row.rpe,
      notes: row.notes,
      completed_flag: row.completed_flag,
    }));
  const attendance = attendanceRows
    .filter((row) => belongsToOrganization(row, organizationId))
    .map(mapAttendance);
  const readiness = readinessRows
    .filter((row) => belongsToOrganization(row, organizationId))
    .map((row) => ({
      readiness_id: row.readiness_id,
      score: row.score,
      category: row.category,
      measured_at: row.measured_at,
    }));
  const goals = goalRows
    .filter((row) => belongsToOrganization(row, organizationId))
    .map((row) => ({
      goal_id: row.goal_id,
      title: row.title,
      target_date: row.target_date,
      metric: row.metric,
      status: row.status,
    }));
  const observations = observationRows
    .filter((row) => belongsToOrganization(row, organizationId))
    // Second gate on the same rule the SQL above already applies, for the
    // same reason belongsToOrganization re-checks organization_id that the
    // WHERE clause already scoped: whatever a row's provenance, nothing
    // leaves this function whose note_type this reader was not cleared for.
    // The SQL filter is what keeps the rows off the wire; this is what makes
    // the guarantee independent of the query text staying correct.
    .filter((row) => allowedNoteTypeSet.has(row.note_type))
    .map((row) => ({
      note_id: row.note_id,
      coach_account_id: row.coach_account_id,
      note_type: row.note_type,
      note_text: row.note_text,
      created_at: row.created_at,
    }));
  const guardians = guardianRows
    .filter((row) => belongsToOrganization(row, organizationId))
    .map((row) => ({
      parent_id: row.parent_id,
      full_name: row.full_name,
      relationship_to_athlete: row.relationship_to_athlete,
    }));
  const progressionGaps = progressionGapRows
    .filter((row) => belongsToOrganization(row, organizationId))
    .map((row) => ({
      gap_id: row.gap_id,
      gap_type: row.gap_type,
      gap_description: row.gap_description,
      severity: row.severity,
      detected_from: row.detected_from,
      status: row.status,
      created_at: row.created_at,
    }));
  const unsupportedAttendance = Array.from(new Set(
    attendance
      .filter((entry) => entry.domain_status === 'unsupported')
      .map((entry) => entry.status),
  )).sort();
  const normalizedGymStatus = athlete.gym_status.trim().toLowerCase();
  const canonicalGymStatus = PASSBOOK_GYM_STATUSES.includes(normalizedGymStatus as PassbookGymStatus)
    ? normalizedGymStatus as PassbookGymStatus
    : null;

  return {
    athlete: {
      athlete_id: athlete.athlete_id,
      full_name: athlete.full_name,
      dob: athlete.dob,
      weight_class: athlete.weight_class,
      gym_status: athlete.gym_status,
      active_flag: athlete.active_flag,
      coach_id: athlete.coach_id,
      created_at: athlete.created_at,
      canonical_gym_status: canonicalGymStatus,
      gym_status_domain: canonicalGymStatus ? 'canonical' : 'unsupported',
    },
    pages: {
      attendance,
      sessions,
      readiness,
      goals,
      corner: {
        coach: { account_id: athlete.coach_id },
        guardians,
        observations,
      },
      progression_gaps: progressionGaps,
    },
    status_domains: {
      attendance: {
        canonical_values: PASSBOOK_ATTENDANCE_STATUSES,
        unsupported_values: unsupportedAttendance,
      },
      gym_status: {
        canonical_values: PASSBOOK_GYM_STATUSES,
        unsupported_value: canonicalGymStatus ? null : athlete.gym_status,
        note: 'gym_status is a roster membership state, not a stamp code',
      },
    },
  };
}

export async function getCoachPassbookGapQueue(
  organizationId: string,
  coachAccountId: string | null,
): Promise<CoachPassbookGapQueueItem[]> {
  const rows = await query<CoachPassbookGapQueueRow>(
    `select
       g.organization_id,
       g.gap_id,
       g.gap_type,
       g.gap_description,
       g.severity,
       g.detected_from,
       g.status,
       g.created_at,
       a.athlete_id,
       a.full_name as athlete_name,
       a.coach_id,
       last_visit.attendance_date as last_attended_on,
       coalesce(absences.recorded_absences, 0)::int as recorded_absences_since_last_visit
     from pilot.progression_gaps g
     join pilot.athletes a
       on a.organization_id = g.organization_id
      and a.athlete_id = g.athlete_id
     left join lateral (
       select attendance_date
       from pilot.attendance
       where organization_id = g.organization_id
         and athlete_id = g.athlete_id
         and lower(trim(status)) in ('present', 'late')
       order by attendance_date desc, created_at desc
       limit 1
     ) last_visit on true
     left join lateral (
       -- count(distinct attendance_date), not count(*): pilot.attendance has no
       -- unique constraint on (organization_id, athlete_id, attendance_date), so
       -- the same athlete-day can appear more than once and count(*) inflates
       -- this number. A coach reading "3 absences since their last visit" needs
       -- three days, not three rows.
       select count(distinct attendance_date)::int as recorded_absences
       from pilot.attendance
       where organization_id = g.organization_id
         and athlete_id = g.athlete_id
         and lower(trim(status)) = 'absent'
         and (last_visit.attendance_date is null or attendance_date > last_visit.attendance_date)
     ) absences on true
     where g.organization_id = $1
       and g.status not in ('completed', 'deferred')
       and ($2::text is null or a.coach_id = $2)
     order by recorded_absences_since_last_visit desc, last_attended_on asc nulls first,
       case g.severity when 'critical' then 1 when 'high' then 2 when 'medium' then 3 else 4 end,
       g.created_at desc`,
    [organizationId, coachAccountId],
  );

  return rows
    .filter((row) => belongsToOrganization(row, organizationId))
    .filter((row) => coachAccountId === null || row.coach_id === coachAccountId)
    .map((row) => ({
      gap_id: row.gap_id,
      gap_type: row.gap_type,
      gap_description: row.gap_description,
      severity: row.severity,
      detected_from: row.detected_from,
      status: row.status,
      created_at: row.created_at,
      athlete_id: row.athlete_id,
      athlete_name: row.athlete_name,
      coach_id: row.coach_id,
      last_attended_on: row.last_attended_on,
      recorded_absences_since_last_visit: row.recorded_absences_since_last_visit,
    }));
}
