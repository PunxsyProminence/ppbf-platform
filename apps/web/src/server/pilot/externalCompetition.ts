import { randomUUID } from 'node:crypto';

import {
  BOARD_MINIMUM_COHORT_SIZE,
  boardCountMetric,
  safeCount,
  type BoardCountMetric,
} from './boardSummary';
import { query, queryOne } from './db';

// External competition minimal skeleton (owner decision 2026-08-15: build
// both competition skeletons deliberately skeletal). A competition someone
// else runs, and entries linking athletes to it. Nothing else: no federation
// integration, result sync, brackets, travel, or compliance checklists until
// real competitions define them.
//
// Safeguarding boundary inherited from the migration: entry rows hold the
// athlete LINK only. Reads that need a name join through pilot.athletes
// inside the same organization; nothing about a child is copied here.

// Staff read; admin write. platform_owner is deliberately absent from the
// read set: the entries read joins athlete names, and access.ts refuses
// Omega every athlete-scoped record, so the whole surface keeps one
// consistent audience rather than a per-route exception.
export const COMPETITION_READ_ROLES = ['coach', 'organization_admin', 'admin'] as const;
export const COMPETITION_WRITE_ROLES = ['organization_admin', 'admin'] as const;

export type CompetitionStatus = 'planned' | 'completed' | 'cancelled';
export type CompetitionEntryStatus = 'entered' | 'withdrawn';
export type CompetitionEntryResult = 'won' | 'lost' | 'draw' | 'no_contest';

export const COMPETITION_STATUSES: readonly CompetitionStatus[] = ['planned', 'completed', 'cancelled'];

// Per-entry results (owner decision 2026-08-16). A loss REQUIRES a lesson
// note -- the database refuses an unexamined loss, and so does this module.
export const COMPETITION_ENTRY_RESULTS: readonly CompetitionEntryResult[] = ['won', 'lost', 'draw', 'no_contest'];

// Forward progress plus reopening: a competition settled too early can
// come back to planned.
const COMPETITION_TRANSITIONS: Record<CompetitionStatus, readonly CompetitionStatus[]> = {
  planned: ['completed', 'cancelled'],
  completed: ['planned'],
  cancelled: ['planned'],
};

export interface CompetitionRow {
  organization_id: string;
  competition_id: string;
  competition_name: string;
  competition_date: string;
  location: string;
  sanctioning_body: string;
  status: CompetitionStatus;
  notes: string;
  created_by_account_id: string;
  created_at: string;
  updated_at: string;
}

export interface CompetitionEntryRow {
  organization_id: string;
  entry_id: string;
  competition_id: string;
  athlete_id: string;
  status: CompetitionEntryStatus;
  result: CompetitionEntryResult | null;
  lesson_note: string;
  athlete_name: string;
  created_at: string;
}

const COMPETITION_FIELDS = `organization_id, competition_id, competition_name,
  competition_date::text as competition_date, location, sanctioning_body, status, notes,
  created_by_account_id, created_at, updated_at`;

export function isCompetitionStatus(value: unknown): value is CompetitionStatus {
  return typeof value === 'string' && (COMPETITION_STATUSES as readonly string[]).includes(value);
}

export function isCompetitionEntryResult(value: unknown): value is CompetitionEntryResult {
  return typeof value === 'string' && (COMPETITION_ENTRY_RESULTS as readonly string[]).includes(value);
}

export async function createCompetition(input: {
  organizationId: string;
  competitionName: string;
  competitionDate: string;
  location?: string;
  sanctioningBody?: string;
  notes?: string;
  createdByAccountId: string;
}): Promise<CompetitionRow> {
  const row = await queryOne<CompetitionRow>(
    `insert into pilot.external_competitions
       (organization_id, competition_id, competition_name, competition_date, location, sanctioning_body, notes, created_by_account_id)
     values ($1, $2, $3, $4::date, $5, $6, $7, $8)
     returning ${COMPETITION_FIELDS}`,
    [
      input.organizationId,
      randomUUID(),
      input.competitionName,
      input.competitionDate,
      input.location ?? '',
      input.sanctioningBody ?? '',
      input.notes ?? '',
      input.createdByAccountId,
    ],
  );
  if (!row) throw new Error('Unable to create the competition.');
  return row;
}

/** Upcoming work first: settled rows sink, then soonest date leads. */
export async function listCompetitions(organizationId: string): Promise<CompetitionRow[]> {
  return query<CompetitionRow>(
    `select ${COMPETITION_FIELDS}
     from pilot.external_competitions
     where organization_id = $1
     order by (status <> 'planned') asc, competition_date asc, created_at asc`,
    [organizationId],
  );
}

export async function setCompetitionStatus(input: {
  organizationId: string;
  competitionId: string;
  status: CompetitionStatus;
}): Promise<CompetitionRow | null> {
  const current = await queryOne<CompetitionRow>(
    `select ${COMPETITION_FIELDS} from pilot.external_competitions
     where organization_id = $1 and competition_id = $2`,
    [input.organizationId, input.competitionId],
  );
  if (!current) return null;

  if (current.status !== input.status && !COMPETITION_TRANSITIONS[current.status].includes(input.status)) {
    throw new Error(`Invalid status transition: ${current.status} -> ${input.status}`);
  }

  const row = await queryOne<CompetitionRow>(
    `update pilot.external_competitions
     set status = $3, updated_at = now()
     where organization_id = $1 and competition_id = $2
     returning ${COMPETITION_FIELDS}`,
    [input.organizationId, input.competitionId, input.status],
  );
  return row;
}

export async function addCompetitionEntry(input: {
  organizationId: string;
  competitionId: string;
  athleteId: string;
  createdByAccountId: string;
}): Promise<CompetitionEntryRow | null> {
  // The competition lookup doubles as the tenancy check: an id from another
  // organization reads as "no such competition" here, so the caller answers
  // with a hidden not-found rather than leaking that the id exists.
  const competition = await queryOne<{ competition_id: string }>(
    `select competition_id from pilot.external_competitions
     where organization_id = $1 and competition_id = $2`,
    [input.organizationId, input.competitionId],
  );
  if (!competition) return null;

  const athlete = await queryOne<{ athlete_id: string }>(
    `select athlete_id from pilot.athletes
     where organization_id = $1 and athlete_id = $2`,
    [input.organizationId, input.athleteId],
  );
  if (!athlete) return null;

  try {
    const row = await queryOne<{ entry_id: string }>(
      `insert into pilot.external_competition_entries
         (organization_id, entry_id, competition_id, athlete_id, created_by_account_id)
       values ($1, $2, $3, $4, $5)
       returning entry_id`,
      [input.organizationId, randomUUID(), input.competitionId, input.athleteId, input.createdByAccountId],
    );
    if (!row) throw new Error('Unable to add the entry.');
  } catch (error) {
    if (error instanceof Error && /pilot_external_competition_entries_unique/.test(error.message)) {
      throw new Error('COMPETITION_DUPLICATE_ENTRY: athlete already entered in this competition');
    }
    throw error;
  }

  const listed = await listCompetitionEntries(input.organizationId, input.competitionId);
  return listed.find((entry) => entry.athlete_id === input.athleteId) ?? null;
}

/** Records an entry's result. The loss-requires-lesson rule is enforced
 * here for a readable refusal AND by the database constraint beneath --
 * an unexamined loss has no write path. Only entered (not withdrawn)
 * athletes can carry a result; a withdrawn entry reads as not-found. */
export async function recordEntryResult(input: {
  organizationId: string;
  entryId: string;
  result: CompetitionEntryResult;
  lessonNote?: string;
}): Promise<CompetitionEntryRow | null> {
  const lessonNote = input.lessonNote?.trim() ?? '';
  if (input.result === 'lost' && !lessonNote) {
    throw new Error('COMPETITION_LOSS_NEEDS_LESSON: a loss cannot be recorded without its lesson');
  }

  const row = await queryOne<{ entry_id: string; competition_id: string }>(
    `update pilot.external_competition_entries
     set result = $3, lesson_note = $4, updated_at = now()
     where organization_id = $1 and entry_id = $2 and status = 'entered'
     returning entry_id, competition_id`,
    [input.organizationId, input.entryId, input.result, lessonNote],
  );
  if (!row) return null;

  const listed = await listCompetitionEntries(input.organizationId, row.competition_id);
  return listed.find((entry) => entry.entry_id === input.entryId) ?? null;
}

/** Withdraws an entered athlete from a competition. Only an entered entry
 * can withdraw -- an already-withdrawn entry reads as not-found, same as a
 * result write refuses a withdrawn entry. There is no path back from
 * withdrawn here; re-entering is a fresh entry via addCompetitionEntry. */
export async function withdrawCompetitionEntry(input: {
  organizationId: string;
  entryId: string;
}): Promise<CompetitionEntryRow | null> {
  const row = await queryOne<{ entry_id: string; competition_id: string }>(
    `update pilot.external_competition_entries
     set status = 'withdrawn', updated_at = now()
     where organization_id = $1 and entry_id = $2 and status = 'entered'
     returning entry_id, competition_id`,
    [input.organizationId, input.entryId],
  );
  if (!row) return null;

  const listed = await listCompetitionEntries(input.organizationId, row.competition_id);
  return listed.find((entry) => entry.entry_id === input.entryId) ?? null;
}

/** Entries with the athlete's name joined from the org-scoped athlete record
 * -- the name is read through its governed home, never copied. */
export async function listCompetitionEntries(organizationId: string, competitionId: string): Promise<CompetitionEntryRow[]> {
  return query<CompetitionEntryRow>(
    `select e.organization_id, e.entry_id, e.competition_id, e.athlete_id, e.status,
            e.result, e.lesson_note, a.full_name as athlete_name, e.created_at
     from pilot.external_competition_entries e
     join pilot.athletes a
       on a.organization_id = e.organization_id and a.athlete_id = e.athlete_id
     where e.organization_id = $1 and e.competition_id = $2
     order by a.full_name asc`,
    [organizationId, competitionId],
  );
}

// ---------------------------------------------------------------------------
// Board aggregate (capability-network audit, 2026-08-17): the board role has
// no read access anywhere above -- COMPETITION_READ_ROLES is coach/
// organization_admin/admin only, deliberately unchanged by this section. A
// board member cannot list a competition or an entry, and never will
// through this function. This is the board's ONE window into external
// competition activity: organization-wide counts, following
// boardSummary.ts's aggregate pattern exactly (see
// ORGANIZATION_ROLE_MODEL.md's Board section).
// ---------------------------------------------------------------------------

export interface BoardExternalCompetitionSummary {
  scope: 'organization_aggregate';
  minimumCohortSize: number;
  generatedAt: string;
  // Competition status counts are an organizational scheduling fact -- not
  // tied to any one athlete -- so they carry no cohort floor, unlike
  // entriesByResult below.
  competitionsByStatus: {
    planned: number;
    completed: number;
    cancelled: number;
  };
  // Win/loss aggregate across all entries. Each result bucket is gated on
  // the athletes who appear in THAT bucket, not on the entry total --
  // mirroring compliance.ts's violationMetric reasoning: a single recorded
  // loss is an identification even when the ledger as a whole is large.
  entriesByResult: {
    won: BoardCountMetric;
    lost: BoardCountMetric;
    draw: BoardCountMetric;
    no_contest: BoardCountMetric;
  };
}

interface BoardExternalCompetitionSummaryRow {
  competitions_planned: number;
  competitions_completed: number;
  competitions_cancelled: number;
  result_won: number;
  result_won_athletes: number;
  result_lost: number;
  result_lost_athletes: number;
  result_draw: number;
  result_draw_athletes: number;
  result_no_contest: number;
  result_no_contest_athletes: number;
}

/**
 * Board's only window into external competition activity. Never reads a
 * competition or entry ROW -- only these organization-wide counts. Mirrors
 * escalationLadder.ts's getBoardEscalationSummary and
 * compliance.ts's getOrganizationViolationSummary(audience: 'board') exactly:
 * every athlete-linked figure passes through boardCountMetric.
 */
export async function getBoardExternalCompetitionSummary(
  organizationId: string,
): Promise<BoardExternalCompetitionSummary> {
  const row = await queryOne<BoardExternalCompetitionSummaryRow>(
    `select
       (select count(*) from pilot.external_competitions
          where organization_id = $1 and status = 'planned')::int as competitions_planned,
       (select count(*) from pilot.external_competitions
          where organization_id = $1 and status = 'completed')::int as competitions_completed,
       (select count(*) from pilot.external_competitions
          where organization_id = $1 and status = 'cancelled')::int as competitions_cancelled,
       (select count(*) from pilot.external_competition_entries
          where organization_id = $1 and result = 'won')::int as result_won,
       (select count(distinct athlete_id) from pilot.external_competition_entries
          where organization_id = $1 and result = 'won')::int as result_won_athletes,
       (select count(*) from pilot.external_competition_entries
          where organization_id = $1 and result = 'lost')::int as result_lost,
       (select count(distinct athlete_id) from pilot.external_competition_entries
          where organization_id = $1 and result = 'lost')::int as result_lost_athletes,
       (select count(*) from pilot.external_competition_entries
          where organization_id = $1 and result = 'draw')::int as result_draw,
       (select count(distinct athlete_id) from pilot.external_competition_entries
          where organization_id = $1 and result = 'draw')::int as result_draw_athletes,
       (select count(*) from pilot.external_competition_entries
          where organization_id = $1 and result = 'no_contest')::int as result_no_contest,
       (select count(distinct athlete_id) from pilot.external_competition_entries
          where organization_id = $1 and result = 'no_contest')::int as result_no_contest_athletes`,
    [organizationId],
  );

  const safe = row ?? {
    competitions_planned: 0,
    competitions_completed: 0,
    competitions_cancelled: 0,
    result_won: 0,
    result_won_athletes: 0,
    result_lost: 0,
    result_lost_athletes: 0,
    result_draw: 0,
    result_draw_athletes: 0,
    result_no_contest: 0,
    result_no_contest_athletes: 0,
  };

  return {
    scope: 'organization_aggregate',
    minimumCohortSize: BOARD_MINIMUM_COHORT_SIZE,
    generatedAt: new Date().toISOString(),
    competitionsByStatus: {
      planned: safeCount(safe.competitions_planned),
      completed: safeCount(safe.competitions_completed),
      cancelled: safeCount(safe.competitions_cancelled),
    },
    entriesByResult: {
      won: boardCountMetric(safe.result_won, safe.result_won_athletes),
      lost: boardCountMetric(safe.result_lost, safe.result_lost_athletes),
      draw: boardCountMetric(safe.result_draw, safe.result_draw_athletes),
      no_contest: boardCountMetric(safe.result_no_contest, safe.result_no_contest_athletes),
    },
  };
}
