import { query, queryOne } from './db';

export const PASSBOOK_ATTENDANCE_STATUSES = ['present', 'late', 'absent'] as const;
export const PASSBOOK_GYM_STATUSES = ['active', 'training', 'inactive'] as const;

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

export async function getAthletePassbook(
  organizationId: string,
  athleteId: string,
): Promise<AthletePassbook | null> {
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
      `select organization_id, note_id::text, coach_account_id, note_type, note_text, created_at
       from pilot.coach_observations
       where organization_id = $1 and athlete_id = $2
       order by created_at desc`,
      [organizationId, athleteId],
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
