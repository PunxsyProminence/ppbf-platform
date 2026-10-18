import { getCoachDisplayName } from './achievements';
import type { PilotAthlete, PilotCoachReview, PilotRole, PilotSession, SessionCloseMethod, SessionCloseRecord, SessionRpeMethod } from './contracts';

/*
 * WHAT A FAMILY RECEIVES ABOUT AN ATHLETE RECORD AND A COACH REVIEW.
 *
 * An athlete reads the same three routes a coach does (athletes/list,
 * athletes/get, coach-reviews/list) and a linked guardian reads athletes/list;
 * until this file each route handed them the storage row -- `select *` --
 * which carries coach_id, the coach's internal account id. Owner ruling
 * OD-2026-10-06-025 ruling 2: families see a coach's display name, never the
 * internal account id. isFamilyRecordCaller admits both roles everywhere so
 * a route that later admits guardians projects for them without a new
 * decision here.
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

/* WHO READS emergency_contact (#1558 item three). It is free text that
   normally holds a contact's name and phone, and the other parent is the
   ordinary emergency contact. Jason 2026-10-13, Q-C (OD-2026-10-13-006): "A:
   Relationship only (Recommended)" -- a parent is not sent a contact's name.
   This field has no relationship to show, so a parent gets nothing from it.
   The athlete keeps it (it is their own record); staff keep the row. */
export type FamilyAthleteReader = 'athlete' | 'parent';

export interface FamilyAthlete {
  athlete_id: string;
  full_name: string;
  dob: string;
  weight_class: string;
  gym_status: string;
  /** The athlete's own reading only; absent for a parent. */
  emergency_contact?: string;
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
  reader: FamilyAthleteReader,
  nameFor: NameReader = getCoachDisplayName,
): Promise<FamilyAthlete[]> {
  const names = await namesFor(organizationId, rows.map((row) => row.coach_id), nameFor);
  return rows.map((row): FamilyAthlete => ({
    athlete_id: row.athlete_id,
    full_name: row.full_name,
    dob: row.dob,
    weight_class: row.weight_class,
    gym_status: row.gym_status,
    ...(reader === 'athlete' ? { emergency_contact: row.emergency_contact } : {}),
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
  reader: FamilyAthleteReader,
  nameFor: NameReader = getCoachDisplayName,
): Promise<FamilyAthlete> {
  const [item] = await toFamilyAthletes(organizationId, [row], reader, nameFor);
  return item;
}

/* A SESSION AS AN ATHLETE RECEIVES IT (#1558 item three). sessions/list and
   sessions/get handed the athlete the storage row, `select *`. Nothing on it
   is staff-only today; the projection is so that a column added to
   pilot.sessions later reaches the athlete only when somebody decides it
   should. Every field the athlete screens read is here; organization_id is
   not. guardianContactProjection.pg.test.ts holds the list against the live
   table, so a new column fails there until it is placed. */
export const FAMILY_SESSION_FIELDS = [
  'session_id',
  'athlete_id',
  'date',
  'rpe',
  'rpe_method',
  'duration_minutes',
  'notes',
  'completed_flag',
  'created_at',
  'updated_at',
  'checked_out_at',
  'close_method',
  'last_activity_at',
  'inactivity_minutes',
] as const;

/** Columns of pilot.sessions an athlete is not sent. session_type (the
 *  athlete's own check-out tag, self-report measures migration) waits here
 *  until the code that writes it decides who reads it back (lane L58 PR-2). */
/* enjoyment (the athlete's own 1-5 answer at check-out, athlete-metrics
 *  migration, OD-2026-10-17-026 (a)) waits here the same way, until the code
 *  that writes it (lane L60 PR B2) decides who reads it back. */
export const SESSION_WITHHELD_FROM_FAMILY_FIELDS = ['organization_id', 'session_type', 'enjoyment'] as const;

export interface FamilySession {
  session_id: string;
  athlete_id: string;
  date: string;
  rpe: number | null;
  rpe_method: SessionRpeMethod;
  duration_minutes: number | null;
  notes: string;
  completed_flag: boolean;
  created_at: string;
  updated_at: string;
  checked_out_at: string | null;
  close_method: SessionCloseMethod | null;
  last_activity_at: string | null;
  inactivity_minutes: number | null;
}

/** The row as either session read returns it: the list read is typed without
 *  the close record, which the database returns all the same. */
type StoredSession = PilotSession & Partial<SessionCloseRecord>;

export function toFamilySession(row: StoredSession): FamilySession {
  return {
    session_id: row.session_id,
    athlete_id: row.athlete_id,
    date: row.date,
    rpe: row.rpe,
    rpe_method: row.rpe_method,
    duration_minutes: row.duration_minutes ?? null,
    notes: row.notes,
    completed_flag: row.completed_flag,
    created_at: row.created_at,
    updated_at: row.updated_at,
    checked_out_at: row.checked_out_at ?? null,
    close_method: row.close_method ?? null,
    last_activity_at: row.last_activity_at ?? null,
    inactivity_minutes: row.inactivity_minutes ?? null,
  };
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
