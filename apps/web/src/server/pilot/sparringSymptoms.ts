import { randomUUID } from 'node:crypto';

import type { PoolClient } from 'pg';

import {
  SPARRING_SYMPTOM_ESCALATION_SEVERITY,
  canonicalSymptoms,
  sparringSymptomLabel,
  type SparringSymptom,
  type SparringSymptomContext,
} from '@/src/shared/sparringSymptoms';

import { gymDayIso, type GymTimeInput } from '../../lib/gymTime';

import { writePilotAuditEvent } from './audit';
import { queryOne, withTransaction } from './db';
import { fileEscalation } from './escalationLadder';

// The sparring symptom FLAG (Jason 2026-10-18): what an athlete ticked after
// sparring or the next day, and the flag it sends their coach. Stored in
// pilot.sparring_symptom_reports (self-report measures migration); the list
// and the fixed words live in src/shared/sparringSymptoms.ts.
//
// A FLAG, NOT A SCORE. The ticks are kept as ticked; nothing here counts them,
// weighs them or says what they mean. The escalation carries one fixed
// severity (SPARRING_SYMPTOM_ESCALATION_SEVERITY), never one derived from the
// ticks.
//
// WHO IS TOLD. Jason ruled the flag goes to "Their coach": the escalation is
// filed to role 'coach', which the escalation list shows to the athlete's
// coach of record and any covering coach (their roster scope), and which the
// organization admin sees on the full list. Not parents, not the gym TV, not
// SHADOW: no reader here or on those surfaces names the table.
//
// ONE REPORT PER ATHLETE, PER GYM DAY, PER CONTEXT. A second submission the
// same day ADDS its new ticks to the report (the table's guard refuses taking
// one back off), and files a new flag only for ticks the report did not
// already have, so a double tap or a resend of the same answer tells the coach
// once. The report row is locked for the read-merge-file step, so two
// submissions at once cannot both file for the same ticks.

export interface SparringSymptomReportRow {
  report_id: string;
  reported_on: string;
  context: SparringSymptomContext;
  symptoms: SparringSymptom[];
  created_at: string;
}

export interface RecordedSymptomReport {
  report: SparringSymptomReportRow;
  /** Ticks this submission added (empty for a resend or "None of these"). */
  addedSymptoms: SparringSymptom[];
  /** True when this submission sent the coach a flag. */
  flagged: boolean;
}

const REPORT_COLUMNS = `report_id, reported_on::text as reported_on, context, symptoms, created_at::text as created_at`;

function requireGymDay(value: GymTimeInput = new Date()): string {
  const day = gymDayIso(value);
  if (!day) throw new Error('SPARRING_SYMPTOM_GYM_DAY_UNRESOLVED');
  return day;
}

/** "Reported after sparring: Headache, Dizzy or off balance." -- the ticked
 * items in words, the only thing the coach's list needs to show. */
export function sparringSymptomEscalationReason(
  context: SparringSymptomContext,
  symptoms: readonly SparringSymptom[],
): string {
  const when = context === 'after_sparring' ? 'after sparring' : 'the day after sparring';
  return `Reported ${when}: ${canonicalSymptoms(symptoms).map(sparringSymptomLabel).join(', ')}.`;
}

async function lockedReport(
  client: PoolClient,
  organizationId: string,
  athleteId: string,
  day: string,
  context: SparringSymptomContext,
): Promise<SparringSymptomReportRow | null> {
  const result = await client.query<SparringSymptomReportRow>(
    `select ${REPORT_COLUMNS} from pilot.sparring_symptom_reports
     where organization_id = $1 and athlete_id = $2 and reported_on = $3::date and context = $4
     for update`,
    [organizationId, athleteId, day, context],
  );
  return result.rows[0] ?? null;
}

/**
 * Stores what the athlete ticked and, when it adds ticks the report did not
 * have, files one flag to their coach in the same transaction: a report with
 * new ticks never commits without its flag. Returns null when the athlete
 * record is not live (the route answers that as not found).
 */
export async function recordSparringSymptomReport(input: {
  organizationId: string;
  athleteId: string;
  accountId: string;
  context: SparringSymptomContext;
  symptoms: readonly SparringSymptom[];
  /** The instant the gym day is read off; a test seam, as in athleteCheckIns.ts. */
  now?: GymTimeInput;
}): Promise<RecordedSymptomReport | null> {
  const day = requireGymDay(input.now);
  const ticked = canonicalSymptoms(input.symptoms);

  return withTransaction(async (client) => {
    const athlete = await client.query(
      `select 1 from pilot.athletes where organization_id = $1 and athlete_id = $2 and deleted_at is null`,
      [input.organizationId, input.athleteId],
    );
    if (athlete.rowCount === 0) return null;

    await client.query(
      `insert into pilot.sparring_symptom_reports (organization_id, report_id, athlete_id, reported_on, context, symptoms)
       values ($1, $2, $3, $4::date, $5, '{}')
       on conflict (organization_id, athlete_id, reported_on, context) do nothing`,
      [input.organizationId, randomUUID(), input.athleteId, day, input.context],
    );
    const existing = await lockedReport(client, input.organizationId, input.athleteId, day, input.context);
    if (!existing) throw new Error('SPARRING_SYMPTOM_REPORT_MISSING_AFTER_INSERT');

    const added = ticked.filter((symptom) => !existing.symptoms.includes(symptom));
    if (added.length === 0) return { report: existing, addedSymptoms: [], flagged: false };

    const merged = canonicalSymptoms([...existing.symptoms, ...added]);
    const updated = await client.query<SparringSymptomReportRow>(
      `update pilot.sparring_symptom_reports set symptoms = $3::text[]
       where organization_id = $1 and report_id = $2
       returning ${REPORT_COLUMNS}`,
      [input.organizationId, existing.report_id, merged],
    );

    await fileEscalation({
      organizationId: input.organizationId,
      sourceType: 'sparring_symptom',
      sourceId: existing.report_id,
      athleteId: input.athleteId,
      severity: SPARRING_SYMPTOM_ESCALATION_SEVERITY,
      reason: sparringSymptomEscalationReason(input.context, added),
      escalatedToRole: 'coach',
      triggeredBy: 'human',
      triggeredByAccountId: input.accountId,
      triggeredByRole: 'athlete',
      metadata: { report_id: existing.report_id, context: input.context, reported_on: day },
    }, client);

    // On the same transaction. Not mirrored to the SHADOW event feed, and the
    // type is not on the coach audit allow-list: a child's head symptoms reach
    // staff through the escalation, nowhere else.
    await writePilotAuditEvent({
      event_type: 'update',
      actor_account_id: input.accountId,
      actor_role: 'athlete',
      organization_id: input.organizationId,
      entity_type: 'sparring_symptom_report',
      entity_id: existing.report_id,
      details: { athlete_id: input.athleteId, context: input.context, flagged: true },
      shadow_mirror: false,
    }, client);

    return { report: updated.rows[0], addedSymptoms: added, flagged: true };
  });
}

/**
 * What the athlete's screens need today: their own two reports for the gym's
 * today, and whether the next-day question is due -- they sparred on the
 * previous gym day, by their own session tag or by a coach's sparring log.
 * Their own record only; nothing here reads another athlete.
 */
export async function getSparringSymptomToday(
  organizationId: string,
  athleteId: string,
  now?: GymTimeInput,
): Promise<{ afterSparring: SparringSymptomReportRow | null; nextDay: SparringSymptomReportRow | null; nextDayDue: boolean }> {
  const day = requireGymDay(now);
  const row = await queryOne<{
    after_sparring: SparringSymptomReportRow | null;
    next_day: SparringSymptomReportRow | null;
    sparred_yesterday: boolean;
  }>(
    `select
       (select row_to_json(r) from (
          select ${REPORT_COLUMNS} from pilot.sparring_symptom_reports
          where organization_id = $1 and athlete_id = $2 and reported_on = $3::date and context = 'after_sparring') r) as after_sparring,
       (select row_to_json(r) from (
          select ${REPORT_COLUMNS} from pilot.sparring_symptom_reports
          where organization_id = $1 and athlete_id = $2 and reported_on = $3::date and context = 'next_day') r) as next_day,
       (exists (
          select 1 from pilot.sessions s
          where s.organization_id = $1 and s.athlete_id = $2
            and s.date = $3::date - 1 and s.session_type = 'sparring')
        or exists (
          select 1 from pilot.sparring_exposure e
          left join pilot.activity_log a on a.organization_id = e.organization_id and a.activity_id = e.activity_id
          where e.organization_id = $1 and e.athlete_id = $2
            and coalesce(e.session_date, a.occurred_on) = $3::date - 1)) as sparred_yesterday`,
    [organizationId, athleteId, day],
  );
  return {
    afterSparring: row?.after_sparring ?? null,
    nextDay: row?.next_day ?? null,
    nextDayDue: row?.sparred_yesterday === true,
  };
}

/** The gym's own protocol words, '' when it has none (Jason: "Not yet, leave blank"). */
export async function getSymptomFlagProtocolText(organizationId: string): Promise<string> {
  const row = await queryOne<{ protocol_text: string }>(
    `select protocol_text from pilot.organization_symptom_flag_settings where organization_id = $1`,
    [organizationId],
  );
  return row?.protocol_text ?? '';
}
