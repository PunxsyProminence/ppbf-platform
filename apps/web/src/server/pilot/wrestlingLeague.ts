import { randomUUID } from 'node:crypto';

import { query, queryOne, withTransaction } from './db';

// Wrestling league minimal skeleton (owner decision 2026-08-15: build both
// competition skeletons deliberately skeletal -- requirements are guessed
// until a real league exists). Season, event, roster entry. Nothing else:
// no match cards, brackets, weigh-ins, scoring, or scheduling until a real
// league defines them.
//
// Safeguarding boundary inherited from the migration: roster rows hold the
// athlete LINK only. Reads that need a name join through pilot.athletes
// inside the same organization; nothing about a child is copied here.

// Staff read; admin write. platform_owner is deliberately absent from the
// read set: the roster read joins athlete names, and access.ts refuses Omega
// every athlete-scoped record, so the whole surface keeps one consistent
// audience rather than a per-route exception.
export const LEAGUE_READ_ROLES = ['coach', 'organization_admin', 'admin'] as const;
export const LEAGUE_WRITE_ROLES = ['organization_admin', 'admin'] as const;

export type LeagueSeasonStatus = 'planned' | 'active' | 'completed';
export type LeagueEventStatus = 'planned' | 'completed' | 'cancelled';
export type LeagueRosterStatus = 'active' | 'inactive';

export const LEAGUE_SEASON_STATUSES: readonly LeagueSeasonStatus[] = ['planned', 'active', 'completed'];
export const LEAGUE_EVENT_STATUSES: readonly LeagueEventStatus[] = ['planned', 'completed', 'cancelled'];

// Forward progress plus reopening: a season closed too early can come back.
const SEASON_TRANSITIONS: Record<LeagueSeasonStatus, readonly LeagueSeasonStatus[]> = {
  planned: ['active', 'completed'],
  active: ['planned', 'completed'],
  completed: ['active'],
};

export interface LeagueSeasonRow {
  organization_id: string;
  season_id: string;
  season_name: string;
  starts_on: string;
  ends_on: string | null;
  status: LeagueSeasonStatus;
  notes: string;
  created_by_account_id: string;
  created_at: string;
  updated_at: string;
}

export interface LeagueEventRow {
  organization_id: string;
  event_id: string;
  season_id: string;
  event_name: string;
  event_date: string;
  location: string;
  status: LeagueEventStatus;
  notes: string;
  created_by_account_id: string;
  created_at: string;
  updated_at: string;
}

export interface LeagueRosterRow {
  organization_id: string;
  entry_id: string;
  season_id: string;
  athlete_id: string;
  status: LeagueRosterStatus;
  athlete_name: string;
  created_at: string;
}

const SEASON_FIELDS = `organization_id, season_id, season_name,
  starts_on::text as starts_on, ends_on::text as ends_on, status, notes,
  created_by_account_id, created_at, updated_at`;

const EVENT_FIELDS = `organization_id, event_id, season_id, event_name,
  event_date::text as event_date, location, status, notes,
  created_by_account_id, created_at, updated_at`;

export function isLeagueSeasonStatus(value: unknown): value is LeagueSeasonStatus {
  return typeof value === 'string' && (LEAGUE_SEASON_STATUSES as readonly string[]).includes(value);
}

export function isLeagueEventStatus(value: unknown): value is LeagueEventStatus {
  return typeof value === 'string' && (LEAGUE_EVENT_STATUSES as readonly string[]).includes(value);
}

export async function createLeagueSeason(input: {
  organizationId: string;
  seasonName: string;
  startsOn: string;
  endsOn?: string | null;
  notes?: string;
  createdByAccountId: string;
}): Promise<LeagueSeasonRow> {
  const row = await queryOne<LeagueSeasonRow>(
    `insert into pilot.wrestling_league_seasons
       (organization_id, season_id, season_name, starts_on, ends_on, notes, created_by_account_id)
     values ($1, $2, $3, $4::date, $5::date, $6, $7)
     returning ${SEASON_FIELDS}`,
    [
      input.organizationId,
      randomUUID(),
      input.seasonName,
      input.startsOn,
      input.endsOn ?? null,
      input.notes ?? '',
      input.createdByAccountId,
    ],
  );
  if (!row) throw new Error('Unable to create the league season.');
  return row;
}

/** Active and planned seasons first, then newest start date. */
export async function listLeagueSeasons(organizationId: string): Promise<LeagueSeasonRow[]> {
  return query<LeagueSeasonRow>(
    `select ${SEASON_FIELDS}
     from pilot.wrestling_league_seasons
     where organization_id = $1
     order by (status = 'completed') asc, starts_on desc, created_at desc`,
    [organizationId],
  );
}

export async function setLeagueSeasonStatus(input: {
  organizationId: string;
  seasonId: string;
  status: LeagueSeasonStatus;
}): Promise<LeagueSeasonRow | null> {
  const current = await queryOne<LeagueSeasonRow>(
    `select ${SEASON_FIELDS} from pilot.wrestling_league_seasons
     where organization_id = $1 and season_id = $2`,
    [input.organizationId, input.seasonId],
  );
  if (!current) return null;

  if (current.status !== input.status && !SEASON_TRANSITIONS[current.status].includes(input.status)) {
    throw new Error(`Invalid status transition: ${current.status} -> ${input.status}`);
  }

  const row = await queryOne<LeagueSeasonRow>(
    `update pilot.wrestling_league_seasons
     set status = $3, updated_at = now()
     where organization_id = $1 and season_id = $2
     returning ${SEASON_FIELDS}`,
    [input.organizationId, input.seasonId, input.status],
  );
  return row;
}

export async function createLeagueEvent(input: {
  organizationId: string;
  seasonId: string;
  eventName: string;
  eventDate: string;
  location?: string;
  notes?: string;
  createdByAccountId: string;
}): Promise<LeagueEventRow | null> {
  // The season lookup doubles as the tenancy check: a season id from another
  // organization reads as "no such season" here, so the caller can answer
  // with a hidden not-found rather than leaking that the id exists.
  const season = await queryOne<{ season_id: string }>(
    `select season_id from pilot.wrestling_league_seasons
     where organization_id = $1 and season_id = $2`,
    [input.organizationId, input.seasonId],
  );
  if (!season) return null;

  const row = await queryOne<LeagueEventRow>(
    `insert into pilot.wrestling_league_events
       (organization_id, event_id, season_id, event_name, event_date, location, notes, created_by_account_id)
     values ($1, $2, $3, $4, $5::date, $6, $7, $8)
     returning ${EVENT_FIELDS}`,
    [
      input.organizationId,
      randomUUID(),
      input.seasonId,
      input.eventName,
      input.eventDate,
      input.location ?? '',
      input.notes ?? '',
      input.createdByAccountId,
    ],
  );
  if (!row) throw new Error('Unable to create the league event.');
  return row;
}

export async function listLeagueEvents(organizationId: string, seasonId: string): Promise<LeagueEventRow[]> {
  return query<LeagueEventRow>(
    `select ${EVENT_FIELDS}
     from pilot.wrestling_league_events
     where organization_id = $1 and season_id = $2
     order by event_date asc, created_at asc`,
    [organizationId, seasonId],
  );
}

export async function addLeagueRosterEntry(input: {
  organizationId: string;
  seasonId: string;
  athleteId: string;
  createdByAccountId: string;
}): Promise<LeagueRosterRow | null> {
  const season = await queryOne<{ season_id: string }>(
    `select season_id from pilot.wrestling_league_seasons
     where organization_id = $1 and season_id = $2`,
    [input.organizationId, input.seasonId],
  );
  if (!season) return null;

  const athlete = await queryOne<{ athlete_id: string }>(
    `select athlete_id from pilot.athletes
     where organization_id = $1 and athlete_id = $2`,
    [input.organizationId, input.athleteId],
  );
  if (!athlete) return null;

  try {
    const row = await queryOne<{ entry_id: string }>(
      `insert into pilot.wrestling_league_roster_entries
         (organization_id, entry_id, season_id, athlete_id, created_by_account_id)
       values ($1, $2, $3, $4, $5)
       returning entry_id`,
      [input.organizationId, randomUUID(), input.seasonId, input.athleteId, input.createdByAccountId],
    );
    if (!row) throw new Error('Unable to add the roster entry.');
  } catch (error) {
    if (error instanceof Error && /pilot_wrestling_league_roster_unique/.test(error.message)) {
      throw new Error('LEAGUE_ROSTER_DUPLICATE_ENTRY: athlete already on this season roster');
    }
    throw error;
  }

  const listed = await listLeagueRoster(input.organizationId, input.seasonId);
  return listed.find((entry) => entry.athlete_id === input.athleteId) ?? null;
}

/** Withdraw a roster entry: compare-and-set out of 'active' only,
 * org-scoped, one transaction -- same shape as compliance.ts's
 * transitionComplianceViolation. Returns false (writes nothing) when no row
 * matched: a foreign or missing entry_id and an already-inactive entry
 * arrive identically, so a stale click can never re-withdraw or race
 * another operator's withdrawal. The roster vocabulary has no dedicated
 * 'withdrawn' value -- 'inactive' is the only non-active state a roster row
 * can hold, so it is the withdrawal target. */
export async function withdrawLeagueRosterEntry(input: {
  organizationId: string;
  entryId: string;
}): Promise<boolean> {
  return withTransaction(async (client) => {
    const updated = await client.query<{ entry_id: string }>(
      `update pilot.wrestling_league_roster_entries
       set status = 'inactive', updated_at = now()
       where organization_id = $1 and entry_id = $2 and status = 'active'
       returning entry_id`,
      [input.organizationId, input.entryId],
    );
    return updated.rows.length > 0;
  });
}

/** Roster with the athlete's name joined from the org-scoped athlete record
 * -- the name is read through its governed home, never copied. */
export async function listLeagueRoster(organizationId: string, seasonId: string): Promise<LeagueRosterRow[]> {
  return query<LeagueRosterRow>(
    `select r.organization_id, r.entry_id, r.season_id, r.athlete_id, r.status,
            a.full_name as athlete_name, r.created_at
     from pilot.wrestling_league_roster_entries r
     join pilot.athletes a
       on a.organization_id = r.organization_id and a.athlete_id = r.athlete_id
     where r.organization_id = $1 and r.season_id = $2
     order by a.full_name asc`,
    [organizationId, seasonId],
  );
}
