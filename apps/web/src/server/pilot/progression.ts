import { query } from './db';
import { randomUUID } from 'node:crypto';

export interface ProgressionGap {
  gap_id: string;
  athlete_id: string;
  gap_type: 'technique' | 'strength' | 'endurance' | 'skill' | 'mental' | 'tactical';
  gap_description: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  status: 'identified' | 'assigned' | 'in_progress' | 'completed' | 'deferred';
  created_at: string;
}

export interface DrillAssignment {
  assignment_id: string;
  gap_id: string;
  athlete_id: string;
  drill_name: string;
  drill_description: string;
  drill_difficulty: 'beginner' | 'intermediate' | 'advanced' | 'elite';
  rep_count: number | null;
  duration_minutes: number | null;
  frequency_per_week: number | null;
  due_date: string | null;
  status: 'assigned' | 'in_progress' | 'completed' | 'incomplete' | 'cancelled';
  completion_percentage: number;
  created_at: string;
}

export interface AssignmentCompletion {
  completion_id: string;
  assignment_id: string;
  completed_at: string;
  reps_completed: number | null;
  notes: string;
  verification_status: 'pending' | 'verified' | 'disputed';
}

export async function createProgressionGap(params: {
  organizationId: string;
  athleteId: string;
  coachAccountId: string;
  gapType: string;
  gapDescription: string;
  severity: string;
  detectedFrom: string;
  detectedFromId?: string;
  detectionData?: Record<string, unknown>;
}): Promise<ProgressionGap> {
  // Session ID generation - using crypto.randomUUID for secure randomness
  const gapId = `gap_${Date.now()}_${randomUUID().substring(0, 8)}`;

  const result = await query<ProgressionGap>(
    `insert into pilot.progression_gaps (
      gap_id, organization_id, athlete_id, coach_account_id, gap_type, gap_description,
      severity, detected_from, detected_from_id, detection_data, status
    ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'identified')
    returning gap_id, athlete_id, gap_type, gap_description, severity, status, created_at`,
    [
      gapId,
      params.organizationId,
      params.athleteId,
      params.coachAccountId,
      params.gapType,
      params.gapDescription,
      params.severity,
      params.detectedFrom,
      params.detectedFromId || null,
      JSON.stringify(params.detectionData || {}),
    ],
  );

  return result[0];
}

export async function assignDrill(params: {
  organizationId: string;
  gapId: string;
  athleteId: string;
  assignedByAccountId: string;
  drillName: string;
  drillDescription: string;
  drillDifficulty: string;
  repCount?: number;
  durationMinutes?: number;
  frequencyPerWeek?: number;
  dueDate?: string;
}): Promise<DrillAssignment> {
  // Using crypto.randomUUID for secure randomness
  const assignmentId = `assignment_${Date.now()}_${randomUUID().substring(0, 8)}`;

  const result = await query<DrillAssignment>(
    `insert into pilot.drill_assignments (
      assignment_id, organization_id, gap_id, athlete_id, assigned_by_account_id,
      drill_name, drill_description, drill_difficulty, rep_count, duration_minutes,
      frequency_per_week, due_date, status, completion_percentage
    ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'assigned', 0)
    returning assignment_id, gap_id, athlete_id, drill_name, drill_description, drill_difficulty,
             rep_count, duration_minutes, frequency_per_week, due_date, status, completion_percentage, created_at`,
    [
      assignmentId,
      params.organizationId,
      params.gapId,
      params.athleteId,
      params.assignedByAccountId,
      params.drillName,
      params.drillDescription,
      params.drillDifficulty,
      params.repCount || null,
      params.durationMinutes || null,
      params.frequencyPerWeek || null,
      params.dueDate || null,
    ],
  );

  // Update gap status to assigned
  await query(`update pilot.progression_gaps set status = 'assigned' where gap_id = $1`, [params.gapId]);

  return result[0];
}

export async function recordCompletion(params: {
  organizationId: string;
  assignmentId: string;
  athleteId: string;
  repsCompleted?: number;
  notes?: string;
}): Promise<AssignmentCompletion> {
  // Using crypto.randomUUID for secure randomness
  const completionId = `completion_${Date.now()}_${randomUUID().substring(0, 8)}`;
  const now = new Date().toISOString();

  const result = await query<AssignmentCompletion>(
    `insert into pilot.assignment_completions (
      completion_id, organization_id, assignment_id, athlete_id, completed_at, reps_completed, notes, verification_status
    ) values ($1, $2, $3, $4, $5, $6, $7, 'pending')
    returning completion_id, assignment_id, completed_at, reps_completed, notes, verification_status`,
    [
      completionId,
      params.organizationId,
      params.assignmentId,
      params.athleteId,
      now,
      params.repsCompleted || null,
      params.notes || '',
    ],
  );

  return result[0];
}

export async function verifyCompletion(
  completionId: string,
  verifiedByAccountId: string,
  verified: boolean,
): Promise<void> {
  const now = new Date().toISOString();
  const status = verified ? 'verified' : 'disputed';

  await query(
    `update pilot.assignment_completions set verification_status = $1, verified_by_account_id = $2, verified_at = $3 where completion_id = $4`,
    [status, verifiedByAccountId, now, completionId],
  );
}

export async function getAthleteGaps(
  organizationId: string,
  athleteId: string,
  status?: string,
): Promise<ProgressionGap[]> {
  let sql = `
    select gap_id, athlete_id, gap_type, gap_description, severity, status, created_at
    from pilot.progression_gaps
    where organization_id = $1 and athlete_id = $2
  `;
  const params: unknown[] = [organizationId, athleteId];

  if (status) {
    sql += ` and status = $${params.length + 1}`;
    params.push(status);
  }

  sql += ` order by severity desc, created_at desc`;

  return query<ProgressionGap>(sql, params);
}

export async function getAthleteAssignments(
  organizationId: string,
  athleteId: string,
  status?: string,
): Promise<DrillAssignment[]> {
  let sql = `
    select assignment_id, gap_id, athlete_id, drill_name, drill_description, drill_difficulty,
           rep_count, duration_minutes, frequency_per_week, due_date, status, completion_percentage, created_at
    from pilot.drill_assignments
    where organization_id = $1 and athlete_id = $2
  `;
  const params: unknown[] = [organizationId, athleteId];

  if (status) {
    sql += ` and status = $${params.length + 1}`;
    params.push(status);
  }

  sql += ` order by due_date asc nulls last, created_at desc`;

  return query<DrillAssignment>(sql, params);
}

export async function getAssignmentCompletions(
  organizationId: string,
  assignmentId: string,
): Promise<AssignmentCompletion[]> {
  return query<AssignmentCompletion>(
    `select completion_id, assignment_id, completed_at, reps_completed, notes, verification_status
     from pilot.assignment_completions
     where organization_id = $1 and assignment_id = $2
     order by completed_at desc`,
    [organizationId, assignmentId],
  );
}
