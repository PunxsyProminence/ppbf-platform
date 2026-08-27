import { randomUUID } from 'node:crypto';

import { query, queryOne } from './db';

// Floor groups and circuit stations (register modules 121 + 123). The gym
// splits the room by who actually showed up, so a plan is made for a DAY,
// not held as a permanent roster. Groups may or may not have stations:
// stations present means a circuit, absent means small groups. Both are
// real days here, neither is the default.
//
// Group membership is a fact about one session. It carries no level, no
// rank, and no judgment, and it never carries forward -- tomorrow's floor
// is made from tomorrow's room.

export interface FloorPlanRow {
  organization_id: string;
  plan_id: string;
  plan_on: string;
  class_id: string | null;
  title: string;
  rotation_minutes: number | null;
  notes: string;
  created_at: string;
}

export interface FloorGroupRow {
  organization_id: string;
  group_id: string;
  plan_id: string;
  group_name: string;
  station_name: string | null;
  focus: string;
  rotation_order: number | null;
  coach_account_id: string | null;
  members: Array<{ athlete_id: string; athlete_name: string }>;
}

const PLAN_FIELDS = `organization_id, plan_id, plan_on::text as plan_on, class_id, title,
  rotation_minutes, notes, created_at`;

export async function createPlan(input: {
  organizationId: string;
  planOn: string;
  classId?: string | null;
  title?: string;
  rotationMinutes?: number | null;
  notes?: string;
  createdByAccountId: string;
}): Promise<FloorPlanRow | null> {
  const planId = randomUUID();
  await queryOne(
    `insert into pilot.floor_plans_daily
       (organization_id, plan_id, plan_on, class_id, title, rotation_minutes, notes, created_by_account_id)
     values ($1, $2, $3::date, $4, $5, $6, $7, $8)
     returning plan_id`,
    [
      input.organizationId,
      planId,
      input.planOn,
      input.classId ?? null,
      input.title ?? '',
      input.rotationMinutes ?? null,
      input.notes ?? '',
      input.createdByAccountId,
    ],
  );
  return getPlan(input.organizationId, planId);
}

export async function getPlan(organizationId: string, planId: string): Promise<FloorPlanRow | null> {
  return queryOne<FloorPlanRow>(
    `select ${PLAN_FIELDS} from pilot.floor_plans_daily
     where organization_id = $1 and plan_id = $2`,
    [organizationId, planId],
  );
}

/** Recent plans, newest day first. */
export async function listPlans(organizationId: string, limit = 20): Promise<FloorPlanRow[]> {
  return query<FloorPlanRow>(
    `select ${PLAN_FIELDS} from pilot.floor_plans_daily
     where organization_id = $1
     order by plan_on desc, created_at desc
     limit $2`,
    [organizationId, limit],
  );
}

export async function addGroup(input: {
  organizationId: string;
  planId: string;
  groupName: string;
  stationName?: string | null;
  focus?: string;
  rotationOrder?: number | null;
  coachAccountId?: string | null;
}): Promise<FloorGroupRow | null> {
  const plan = await getPlan(input.organizationId, input.planId);
  if (!plan) return null;

  const groupId = randomUUID();
  await queryOne(
    `insert into pilot.floor_plan_groups
       (organization_id, group_id, plan_id, group_name, station_name, focus, rotation_order, coach_account_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8)
     returning group_id`,
    [
      input.organizationId,
      groupId,
      input.planId,
      input.groupName,
      input.stationName?.trim() || null,
      input.focus ?? '',
      input.rotationOrder ?? null,
      input.coachAccountId ?? null,
    ],
  );

  const groups = await listGroups(input.organizationId, input.planId);
  return groups.find((group) => group.group_id === groupId) ?? null;
}

/** Groups for a plan with their members, rotation order first (groups
 * without an order sort last -- an unordered group is a small group, not
 * a broken circuit). */
export async function listGroups(organizationId: string, planId: string): Promise<FloorGroupRow[]> {
  const groups = await query<Omit<FloorGroupRow, 'members'>>(
    `select organization_id, group_id, plan_id, group_name, station_name, focus,
            rotation_order, coach_account_id
     from pilot.floor_plan_groups
     where organization_id = $1 and plan_id = $2
     order by rotation_order nulls last, group_name asc`,
    [organizationId, planId],
  );
  if (groups.length === 0) return [];

  const members = await query<{ group_id: string; athlete_id: string; athlete_name: string }>(
    `select m.group_id, m.athlete_id, a.full_name as athlete_name
     from pilot.floor_plan_members m
     join pilot.athletes a
       on a.organization_id = m.organization_id and a.athlete_id = m.athlete_id
      and a.deleted_at is null
     where m.organization_id = $1 and m.plan_id = $2
     order by a.full_name asc`,
    [organizationId, planId],
  );

  return groups.map((group) => ({
    ...group,
    members: members
      .filter((member) => member.group_id === group.group_id)
      .map(({ athlete_id, athlete_name }) => ({ athlete_id, athlete_name })),
  }));
}

/** Places an athlete in a group for this plan, MOVING them if they were
 * already placed elsewhere today -- one person cannot stand in two groups
 * at once, and re-placing is the ordinary act when the room changes. */
export async function placeAthlete(input: {
  organizationId: string;
  planId: string;
  groupId: string;
  athleteId: string;
}): Promise<FloorGroupRow[] | null> {
  const group = await queryOne<{ group_id: string }>(
    `select group_id from pilot.floor_plan_groups
     where organization_id = $1 and plan_id = $2 and group_id = $3`,
    [input.organizationId, input.planId, input.groupId],
  );
  if (!group) return null;

  const athlete = await queryOne<{ athlete_id: string }>(
    `select athlete_id from pilot.athletes
     where organization_id = $1 and athlete_id = $2`,
    [input.organizationId, input.athleteId],
  );
  if (!athlete) return null;

  await queryOne(
    `insert into pilot.floor_plan_members (organization_id, plan_id, group_id, athlete_id)
     values ($1, $2, $3, $4)
     on conflict (organization_id, plan_id, athlete_id)
       do update set group_id = excluded.group_id
     returning athlete_id`,
    [input.organizationId, input.planId, input.groupId, input.athleteId],
  );

  return listGroups(input.organizationId, input.planId);
}

export async function removeAthlete(input: {
  organizationId: string;
  planId: string;
  athleteId: string;
}): Promise<FloorGroupRow[]> {
  await queryOne(
    `delete from pilot.floor_plan_members
     where organization_id = $1 and plan_id = $2 and athlete_id = $3
     returning athlete_id`,
    [input.organizationId, input.planId, input.athleteId],
  );
  return listGroups(input.organizationId, input.planId);
}

/** True when the plan is a circuit: at least one group names a station.
 * Exported so the UI labels the day honestly instead of assuming. */
export function isCircuit(groups: Array<{ station_name: string | null }>): boolean {
  return groups.some((group) => (group.station_name ?? '').trim() !== '');
}
