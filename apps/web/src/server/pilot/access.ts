import type { PilotRole } from './contracts';
import { queryOne } from './db';

export interface ActorIdentity {
  accountId: string;
  role: PilotRole;
  athleteId: string | null;
}

export function requireRole(actor: ActorIdentity, allowed: PilotRole[]): void {
  if (!allowed.includes(actor.role)) {
    throw new Error('Forbidden: role not allowed');
  }
}

export async function assertCoachAssignedToAthlete(coachId: string, athleteId: string): Promise<void> {
  const row = await queryOne<{ athlete_id: string }>(
    'select athlete_id from pilot.athletes where athlete_id = $1 and coach_id = $2',
    [athleteId, coachId],
  );

  if (!row) {
    throw new Error('Forbidden: coach not assigned to athlete');
  }
}

export async function assertActorCanAccessAthlete(actor: ActorIdentity, athleteId: string): Promise<void> {
  if (actor.role === 'admin') {
    return;
  }

  if (actor.role === 'coach') {
    await assertCoachAssignedToAthlete(actor.accountId, athleteId);
    return;
  }

  if (actor.role === 'athlete') {
    if (!actor.athleteId || actor.athleteId !== athleteId) {
      throw new Error('Forbidden: athlete cannot access another athlete record');
    }
    return;
  }

  throw new Error('Forbidden: role not allowed');
}

export function assertAthleteUpdateAllowed(
  actor: ActorIdentity,
  before: { coach_id: string; active_flag: boolean; gym_status: string },
  after: { coach_id: string; active_flag: boolean; gym_status: string },
): void {
  if (actor.role !== 'athlete') {
    return;
  }

  if (before.coach_id !== after.coach_id) {
    throw new Error('Forbidden: athlete cannot change coach assignment');
  }

  if (before.active_flag !== after.active_flag) {
    throw new Error('Forbidden: athlete cannot change status flags');
  }

  if (before.gym_status !== after.gym_status) {
    throw new Error('Forbidden: athlete cannot change gym_status');
  }
}
