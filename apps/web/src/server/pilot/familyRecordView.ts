import { getCoachDisplayName } from './achievements';
import type { PilotAthlete, PilotCoachReview, PilotRole } from './contracts';

/*
 * WHAT A FAMILY RECEIVES ABOUT AN ATHLETE RECORD AND A COACH REVIEW.
 *
 * An athlete and a linked guardian read the same routes a coach does
 * (athletes/list, athletes/get, coach-reviews/list), and until this file each
 * route handed them the storage row -- `select *` -- which carries coach_id,
 * the coach's internal account id. Owner ruling OD-2026-10-06-025 ruling 2:
 * families see a coach's display name, never the internal account id.
 *
 * Named fields, never a spread: a spread would carry every column a later
 * change adds to the row to a family without anyone deciding it should (same
 * contract as toFamilyAssignments in progression.ts and videoFamilyView.ts).
 * Staff callers of the same routes keep the row they had.
 *
 * The name reader is getCoachDisplayName: tenancy-scoped, and a deleted
 * account falls to its floor phrase ("Your coach") rather than being named.
 * One lookup per distinct coach, not per row.
 */

export function isFamilyRecordCaller(role: PilotRole): boolean {
  return role === 'athlete' || role === 'parent';
}

export interface FamilyAthlete {
  athlete_id: string;
  full_name: string;
  dob: string;
  weight_class: string;
  gym_status: string;
  emergency_contact: string;
  active_flag: boolean;
  coach_name: string;
  created_at: string;
  updated_at: string;
}

export interface FamilyCoachReview {
  review_id: string;
  session_id: string;
  coach_name: string;
  decision: string;
  notes: string;
  approved_flag: boolean;
  created_at: string;
  updated_at: string;
}

type NameReader = (organizationId: string, accountId: string) => Promise<string>;

async function namesFor(
  organizationId: string,
  accountIds: string[],
  nameFor: NameReader,
): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  await Promise.all(
    Array.from(new Set(accountIds)).map(async (accountId) => {
      names.set(accountId, await nameFor(organizationId, accountId));
    }),
  );
  return names;
}

export async function toFamilyAthletes(
  organizationId: string,
  rows: PilotAthlete[],
  nameFor: NameReader = getCoachDisplayName,
): Promise<FamilyAthlete[]> {
  const names = await namesFor(organizationId, rows.map((row) => row.coach_id), nameFor);
  return rows.map((row): FamilyAthlete => ({
    athlete_id: row.athlete_id,
    full_name: row.full_name,
    dob: row.dob,
    weight_class: row.weight_class,
    gym_status: row.gym_status,
    emergency_contact: row.emergency_contact,
    active_flag: row.active_flag,
    // The map holds every coach_id in rows, so the fallback is for the type
    // checker; getCoachDisplayName itself never returns an id.
    coach_name: names.get(row.coach_id) ?? 'Your coach',
    created_at: row.created_at,
    updated_at: row.updated_at,
  }));
}

export async function toFamilyAthlete(
  organizationId: string,
  row: PilotAthlete,
  nameFor: NameReader = getCoachDisplayName,
): Promise<FamilyAthlete> {
  const [item] = await toFamilyAthletes(organizationId, [row], nameFor);
  return item;
}

export async function toFamilyCoachReviews(
  organizationId: string,
  rows: PilotCoachReview[],
  nameFor: NameReader = getCoachDisplayName,
): Promise<FamilyCoachReview[]> {
  const names = await namesFor(organizationId, rows.map((row) => row.coach_id), nameFor);
  return rows.map((row): FamilyCoachReview => ({
    review_id: row.review_id,
    session_id: row.session_id,
    coach_name: names.get(row.coach_id) ?? 'Your coach',
    decision: row.decision,
    notes: row.notes,
    approved_flag: row.approved_flag,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }));
}
