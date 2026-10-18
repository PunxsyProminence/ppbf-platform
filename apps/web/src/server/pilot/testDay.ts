import { createHash, randomUUID } from 'node:crypto';

import type { ActorIdentity } from './access';
import {
  JUMP_PROTOCOL_IDS,
  SHUTTLE_LEVEL_MAX,
  SHUTTLE_NUMBER_MAX,
  SHUTTLE_PROTOCOL_ID,
  ensurePpbfAssessmentProtocols,
} from './assessmentResults';
import { heightAccessibleAthleteIds, heightRoleInOrganization, parseHeightCm, parseRequestKey } from './athleteHeights';
import { writePilotAuditEvent } from './audit';
import { withTransaction } from './db';
import { ConflictError, ForbiddenError, ValidationError } from './errors';

/**
 * THE QUARTERLY TEST DAY: one coach records a group's standing height, jump
 * tests and 20-m shuttle on one date, in one save (OD-2026-10-17-026: "A: All
 * three (Rec.)" (b) height; "A: 20-m shuttle (Rec.)"; the jumps as ruled in
 * OD-2026-10-04-020 -- CMJ height and broad jump, best of 3, either or both).
 *
 * SAME STORES AS ONE-AT-A-TIME ENTRY. A height lands in pilot.athlete_heights
 * (coach-only, read by athleteHeights.ts) with its own athlete_height audit
 * row; a jump or shuttle lands in pilot.assessments under its PPBF protocol,
 * administration_kind 'scheduled_interval', and reads back in the athlete's
 * own history on /coach/assessments. A blank cell is "not tested": nothing is
 * written for it.
 *
 * WHO: the height module's rule for every row -- an active coach,
 * organization_admin or admin seat here, and an athlete that seat reaches.
 * One athlete on the form that the seat does not reach refuses the whole save
 * before anything is written.
 *
 * ALL OR NOTHING, AND ONCE. Every row is checked first; then every cell, the
 * per-height audit rows and the test-day audit row are written in one
 * transaction. Each cell has a key derived from the save's request key, the
 * athlete and the measure, so pressing Save again after a lost reply writes
 * nothing new and says so; the same key with different numbers is a conflict,
 * never a silent overwrite. A retry that leaves off a cell an earlier attempt
 * saved does not unsave it, and the answer names it.
 */

export const TEST_DAY_MAX_ROWS = 100;
const PROTOCOL_VERSION = 1;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const JUMP_FIELDS = { cmj_cm: 'ppbf-jump-cmj-height', broad_cm: 'ppbf-jump-broad-distance' } as const;
type Measure = 'height' | (typeof JUMP_PROTOCOL_IDS)[number] | typeof SHUTTLE_PROTOCOL_ID;

export interface TestDayRow {
  athleteId: string;
  heightCm: number | null;
  jumps: Array<{ protocolId: (typeof JUMP_PROTOCOL_IDS)[number]; valueCm: number }>;
  shuttle: { level: number; shuttle: number } | null;
}

export interface TestDayInput {
  administeredOn: string;
  requestKey: string;
  rows: TestDayRow[];
}

function present(value: unknown): boolean {
  return value !== undefined && value !== null && value !== '';
}

/** The test date: a real calendar day at the gym, not in the future, not before 2000. */
function parseTestDate(value: unknown, today: string): string {
  if (!present(value)) return today;
  const parsed = typeof value === 'string' && ISO_DATE.test(value) ? new Date(`${value}T00:00:00Z`) : null;
  if (!parsed || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value || value < '2000-01-01') {
    throw new ValidationError('The test date must be a date (YYYY-MM-DD).', 'TEST_DAY_DATE_INVALID');
  }
  if (value > today) throw new ValidationError('The test date cannot be in the future.', 'TEST_DAY_DATE_FUTURE');
  return value;
}

function parseJumpCm(value: unknown): number {
  const cm = typeof value === 'number' ? Math.round(value * 10) / 10 : Number.NaN;
  // The one-at-a-time jump form's bound (recordJumpResult): a typo, not a norm.
  if (!Number.isFinite(cm) || cm <= 0 || cm >= 500) {
    throw new ValidationError('Enter each jump in centimetres, more than 0 and under 500.', 'TEST_DAY_JUMP_INVALID');
  }
  return cm;
}

function parseWhole(value: unknown, max: number, what: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > max) {
    throw new ValidationError(`The shuttle ${what} must be a whole number from 1 to ${max}.`, 'TEST_DAY_SHUTTLE_INVALID');
  }
  return value;
}

/** The form body, refused whole on the first problem; nothing is written by parsing. */
export function parseTestDay(body: Record<string, unknown>, today: string): TestDayInput {
  const administeredOn = parseTestDate(body.administered_on, today);
  const requestKey = parseRequestKey(body.request_key);
  if (!Array.isArray(body.rows) || body.rows.length === 0 || body.rows.length > TEST_DAY_MAX_ROWS) {
    throw new ValidationError(`Enter at least one athlete, and at most ${TEST_DAY_MAX_ROWS}.`, 'TEST_DAY_ROWS_INVALID');
  }
  const seen = new Set<string>();
  const rows = body.rows.map((raw): TestDayRow => {
    const row = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const athleteId = typeof row.athlete_id === 'string' ? row.athlete_id.trim() : '';
    if (!athleteId) throw new ValidationError('Each row names an athlete.', 'TEST_DAY_ATHLETE_MISSING');
    if (seen.has(athleteId)) throw new ValidationError('Each athlete appears once on the form.', 'TEST_DAY_ATHLETE_DUPLICATE');
    seen.add(athleteId);

    const heightCm = present(row.height_cm) ? parseHeightCm(row.height_cm) : null;
    const jumps = (Object.keys(JUMP_FIELDS) as Array<keyof typeof JUMP_FIELDS>)
      .filter((field) => present(row[field]))
      .map((field) => ({ protocolId: JUMP_FIELDS[field], valueCm: parseJumpCm(row[field]) }));
    const hasLevel = present(row.shuttle_level);
    const hasShuttle = present(row.shuttle_number);
    if (hasLevel !== hasShuttle) {
      throw new ValidationError('Enter both the shuttle level and the shuttle, or neither.', 'TEST_DAY_SHUTTLE_INCOMPLETE');
    }
    const shuttle = hasLevel
      ? { level: parseWhole(row.shuttle_level, SHUTTLE_LEVEL_MAX, 'level'), shuttle: parseWhole(row.shuttle_number, SHUTTLE_NUMBER_MAX, 'number') }
      : null;
    if (heightCm === null && jumps.length === 0 && shuttle === null) {
      throw new ValidationError('A row with nothing recorded is left off the form.', 'TEST_DAY_ROW_EMPTY');
    }
    return { athleteId, heightCm, jumps, shuttle };
  });
  return { administeredOn, requestKey, rows };
}

function sha256(parts: readonly string[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

/** A version-4-shaped UUID from a hash: stable for the same inputs. */
function uuidFrom(hex: string): string {
  const variant = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** One cell of one save: an assessment id, or a height's request key (fixed length, under the 200-char check). */
function cellKey(organizationId: string, requestKey: string, athleteId: string, measure: Measure): string {
  return sha256(['test-day-cell', organizationId, requestKey, athleteId, measure]);
}

/** The save's own audit entity id: every attempt of one save shares it, so earlier attempts can be found. */
function saveEntityId(organizationId: string, requestKey: string): string {
  return uuidFrom(sha256(['test-day-save', organizationId, requestKey]));
}

/** jsonb hands keys back in its own order, so compare with the keys sorted. */
function sameResult(stored: unknown, sent: Record<string, unknown>): boolean {
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return false;
  const canonical = (value: Record<string, unknown>) =>
    JSON.stringify(Object.keys(value).sort().map((key) => [key, value[key]]));
  return canonical(stored as Record<string, unknown>) === canonical(sent);
}

function pgCode(error: unknown): { code?: string; constraint?: string } {
  return (error && typeof error === 'object' ? error : {}) as { code?: string; constraint?: string };
}

export interface TestDayResult {
  /** Cells this save wrote. */
  written: number;
  /** Cells an earlier attempt of this same save had already written. */
  already_saved: number;
  /** Cells an earlier attempt saved that this form no longer carries; they stay saved. */
  earlier_not_on_form: Array<{ athlete_id: string; measure: Measure }>;
}

const NOT_PERMITTED = () => new ForbiddenError(
  'This account may not record a test day for one or more of these athletes. Nothing from this attempt was saved.',
  'TEST_DAY_NOT_PERMITTED',
);

const KEY_REUSED = () => new ConflictError(
  'This save was already recorded with different numbers, and the first numbers are kept. '
  + 'To change one, correct that reading on the athlete\'s own page; do not enter the test day again.',
  'TEST_DAY_REQUEST_KEY_REUSED',
);

export async function recordTestDay(actor: ActorIdentity, input: TestDayInput): Promise<TestDayResult> {
  const role = await heightRoleInOrganization(actor);
  const reachable = role ? await heightAccessibleAthleteIds(actor, input.rows.map((row) => row.athleteId)) : new Set<string>();
  if (!role || input.rows.some((row) => !reachable.has(row.athleteId))) throw NOT_PERMITTED();
  // Catalog rows only (idempotent); a refused save below leaves no measurement.
  await ensurePpbfAssessmentProtocols(actor.organizationId);
  const saveId = saveEntityId(actor.organizationId, input.requestKey);

  try {
    return await withTransaction(async (client) => {
      let written = 0;
      let already = 0;
      const cells: string[] = [];

      for (const row of input.rows) {
        if (row.heightCm !== null) {
          const key = cellKey(actor.organizationId, input.requestKey, row.athleteId, 'height');
          cells.push(`${row.athleteId}|height`);
          const inserted = await client.query<{ height_id: string }>(
            `insert into pilot.athlete_heights
               (organization_id, height_id, athlete_id, measured_on, height_cm,
                recorded_by_account_id, recorded_by_role, request_key)
             values ($1, $2::uuid, $3, $4::date, $5, $6, $7, $8)
             on conflict (organization_id, request_key) do nothing
             returning height_id::text as height_id`,
            [actor.organizationId, randomUUID(), row.athleteId, input.administeredOn, row.heightCm, actor.accountId, role, key],
          );
          if (inserted.rows[0]) {
            written += 1;
            // The reading's own audit row, as one-at-a-time entry writes it.
            await writePilotAuditEvent({
              event_type: 'create',
              actor_account_id: actor.accountId,
              actor_role: role,
              organization_id: actor.organizationId,
              entity_type: 'athlete_height',
              entity_id: inserted.rows[0].height_id,
              details: { athlete_id: row.athleteId, supersedes_height_id: null, test_day: saveId },
              shadow_mirror: false,
            }, client);
          } else {
            const stored = await client.query<{ athlete_id: string; measured_on: string; height_cm: string }>(
              `select athlete_id, measured_on::text as measured_on, height_cm::text as height_cm
                 from pilot.athlete_heights where organization_id = $1 and request_key = $2`,
              [actor.organizationId, key],
            );
            const prior = stored.rows[0];
            if (!prior || prior.athlete_id !== row.athleteId || prior.measured_on !== input.administeredOn
              || Number(prior.height_cm) !== row.heightCm) throw KEY_REUSED();
            already += 1;
          }
        }

        const measures: Array<{ protocolId: Measure; result: Record<string, unknown> }> = [
          ...row.jumps.map((jump) => ({ protocolId: jump.protocolId as Measure, result: { value: jump.valueCm, unit: 'cm', best_of: 3 } })),
          ...(row.shuttle ? [{ protocolId: SHUTTLE_PROTOCOL_ID as Measure, result: { level: row.shuttle.level, shuttle: row.shuttle.shuttle } }] : []),
        ];
        for (const cell of measures) {
          const assessmentId = uuidFrom(cellKey(actor.organizationId, input.requestKey, row.athleteId, cell.protocolId));
          cells.push(`${row.athleteId}|${cell.protocolId}`);
          const inserted = await client.query(
            `insert into pilot.assessments
               (organization_id, assessment_id, athlete_id, assessor_account_id, assessment_type, result,
                protocol_id, protocol_version, administration_kind, administered_on, assessor_role, conditions_note)
             select $1, $2::uuid, $3, $4, 'physical_test', $5::jsonb, $6, $7, 'scheduled_interval', $8::date, $9, ''
               from pilot.athletes
              where organization_id = $1 and athlete_id = $3 and deleted_at is null
             on conflict (organization_id, assessment_id) do nothing
             returning assessment_id`,
            [actor.organizationId, assessmentId, row.athleteId, actor.accountId, JSON.stringify(cell.result),
              cell.protocolId, PROTOCOL_VERSION, input.administeredOn, role],
          );
          if (inserted.rowCount === 1) {
            written += 1;
            continue;
          }
          const stored = await client.query<{ athlete_id: string; protocol_id: string; administered_on: string; result: unknown }>(
            `select athlete_id, protocol_id, administered_on::text as administered_on, result
               from pilot.assessments where organization_id = $1 and assessment_id = $2::uuid`,
            [actor.organizationId, assessmentId],
          );
          const prior = stored.rows[0];
          // No row at all: the athlete was deleted after the access check.
          if (!prior) throw NOT_PERMITTED();
          if (prior.athlete_id !== row.athleteId || prior.protocol_id !== cell.protocolId
            || prior.administered_on !== input.administeredOn || !sameResult(prior.result, cell.result)) throw KEY_REUSED();
          already += 1;
        }
      }

      // What earlier attempts of this same save recorded that this form no
      // longer carries: still saved, and said so.
      const earlier = await client.query<{ cells: unknown }>(
        `select details->'cells' as cells from pilot.audit_events
          where entity_type = 'test_day' and entity_id = $1 and organization_id = $2`,
        [saveId, actor.organizationId],
      );
      const now = new Set(cells);
      const earlierCells = new Set<string>();
      for (const row of earlier.rows) {
        if (Array.isArray(row.cells)) for (const cell of row.cells) if (typeof cell === 'string') earlierCells.add(cell);
      }
      const earlierNotOnForm = [...earlierCells].filter((cell) => !now.has(cell)).sort().map((cell) => {
        const cut = cell.lastIndexOf('|');
        return { athlete_id: cell.slice(0, cut), measure: cell.slice(cut + 1) as Measure };
      });

      if (written > 0) {
        // No measurements in the audit row: which athletes and which cells.
        await writePilotAuditEvent({
          event_type: 'create',
          actor_account_id: actor.accountId,
          actor_role: role,
          organization_id: actor.organizationId,
          entity_type: 'test_day',
          entity_id: saveId,
          details: {
            administered_on: input.administeredOn,
            athlete_ids: input.rows.map((row) => row.athleteId),
            cells,
            cells_written: written,
          },
          shadow_mirror: false,
        }, client);
      }
      return { written, already_saved: already, earlier_not_on_form: earlierNotOnForm };
    });
  } catch (error) {
    const { code, constraint } = pgCode(error);
    // The seat ended between the access check and the insert (the heights guard).
    if (code === '23514' && constraint === 'pilot_athlete_heights_recorder_of_this_gym') throw NOT_PERMITTED();
    throw error;
  }
}
