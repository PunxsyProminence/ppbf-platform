import { randomUUID } from 'node:crypto';

import type { PoolClient, QueryResultRow } from 'pg';

import { gymDayIso, type GymTimeInput } from '../../lib/gymTime';

import { assertActorCanAccessAthlete, type ActorIdentity } from './access';
import { writePilotAuditEvent } from './audit';
import { query, queryOne, withTransaction } from './db';
import { ForbiddenError, ValidationError } from './errors';

// Athlete mental skills (map item 21): the athlete's own self-talk cue and a
// log of the short imagery sessions they did.
//
// WHO (owner answers 2026-10-04). The athlete writes, in their own words; minors
// included. Reads go through assertActorCanAccessAthlete, the platform's one
// per-athlete gate: the athlete themselves, a linked guardian, the coach of
// record or a covering coach, and the org admin. platform_owner and board are
// refused there. Unlike the wellness check-in read (org-wide for any coach by
// owner decision 2026-09-22), nothing here widens that gate.
//
// WHAT THIS MODULE REFUSES TO COMPUTE. No score, no adherence percentage, no
// weekly total against a target, no judgement of the cue. Reads return what
// the athlete entered, as an enumerated projection with no account ids.

export const SELF_TALK_CUE_KINDS = ['instructional', 'motivational'] as const;
export type SelfTalkCueKind = (typeof SELF_TALK_CUE_KINDS)[number];

export const CUE_TEXT_MAX = 60;
export const IMAGERY_MINUTES_MIN = 1;
export const IMAGERY_MINUTES_MAX = 60;
const RECENT_SESSIONS_LIMIT = 30;

/** The approved imagery content an entry may name. One today: the seed drill
 * "Imagery Rehearsal" (SK-REV-02), the source Jason chose 2026-10-04. A closed
 * list rather than a pattern, so the key cannot carry a second free-text
 * message past the cue's limit. */
export const IMAGERY_CONTENT_KEYS = ['imagery-rehearsal'] as const;

/** Entries of both kinds per athlete per gym day. Far above real use; it only
 * stops a script on one session from filling the table. */
export const DAILY_ENTRY_LIMIT = 20;

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

export interface SelfTalkCue {
  entry_id: string;
  cue_text: string;
  cue_kind: SelfTalkCueKind;
  logged_on: string;
}

export interface ImagerySessionEntry {
  entry_id: string;
  minutes: number;
  content_key: string | null;
  logged_on: string;
}

export interface MentalSkillsView {
  current_cue: SelfTalkCue | null;
  imagery_sessions: ImagerySessionEntry[];
}

/** Same rule as athleteCheckIns.ts: the gym's wall-clock day, never the
 * database server's UTC day, and no silent fallback when it cannot resolve. */
function requireGymDay(value: GymTimeInput = new Date()): string {
  const day = gymDayIso(value);
  if (!day) throw new Error('MENTAL_SKILLS_GYM_DAY_UNRESOLVED');
  return day;
}

/** Writes are the athlete's own and nobody else's. A guardian or coach
 * entering a child's self-talk would put words in the child's mouth. */
async function requireSelfAthlete(actor: ActorIdentity): Promise<string> {
  if (actor.role !== 'athlete') {
    throw new ForbiddenError('Only the athlete records their own mental skills entries.', 'MENTAL_SKILLS_SELF_ONLY');
  }
  if (!actor.athleteId) {
    throw new ValidationError('This account is not linked to an athlete record.', 'ATHLETE_RECORD_NOT_LINKED');
  }
  await assertActorCanAccessAthlete(actor, actor.athleteId);
  return actor.athleteId;
}

export function cueError(cueText: unknown, cueKind: unknown): string | null {
  if (typeof cueText !== 'string' || cueText.trim().length === 0) return 'cue_text is required.';
  if (CONTROL_CHARACTERS.test(cueText.trim())) return 'cue_text must be one line of plain text.';
  // Counted in code points, as Postgres length() counts them, so an emoji is one.
  if ([...cueText.trim()].length > CUE_TEXT_MAX) return `cue_text must be ${CUE_TEXT_MAX} characters or fewer.`;
  if (typeof cueKind !== 'string' || !(SELF_TALK_CUE_KINDS as readonly string[]).includes(cueKind)) {
    return `cue_kind must be one of: ${SELF_TALK_CUE_KINDS.join(', ')}.`;
  }
  return null;
}

export function imageryError(minutes: unknown, contentKey: unknown): string | null {
  if (
    typeof minutes !== 'number'
    || !Number.isInteger(minutes)
    || minutes < IMAGERY_MINUTES_MIN
    || minutes > IMAGERY_MINUTES_MAX
  ) {
    return `minutes must be a whole number from ${IMAGERY_MINUTES_MIN} to ${IMAGERY_MINUTES_MAX}.`;
  }
  if (contentKey !== undefined && contentKey !== null) {
    if (typeof contentKey !== 'string' || !(IMAGERY_CONTENT_KEYS as readonly string[]).includes(contentKey)) {
      return `content_key must be one of: ${IMAGERY_CONTENT_KEYS.join(', ')}, or omitted.`;
    }
  }
  return null;
}

/**
 * The write path, for both kinds, as ONE transaction: a per-athlete-per-day
 * advisory lock, the daily count, the insert, and the audit record. Without
 * the lock, concurrent requests near the limit each count below it and all
 * insert; without the shared transaction, a failed audit write after a
 * committed insert returns 500 and a retry stores the entry twice. The audit
 * details carry the athlete, kind and day, never the athlete's words.
 */
async function insertEntry<T extends QueryResultRow>(
  actor: ActorIdentity,
  athleteId: string,
  day: string,
  kind: 'self_talk_cue' | 'imagery_session',
  insert: (client: PoolClient, entryId: string) => Promise<T | undefined>,
): Promise<T> {
  return withTransaction(async (client) => {
    await client.query(
      `select pg_advisory_xact_lock(hashtext('ppbf.mental-skills:' || $1::text || ':' || $2::text || ':' || $3::text))`,
      [actor.organizationId, athleteId, day],
    );
    const counted = await client.query<{ n: number }>(
      `select count(*)::int as n
       from pilot.athlete_mental_skill_entries
       where organization_id = $1 and athlete_id = $2 and logged_on = $3::date`,
      [actor.organizationId, athleteId, day],
    );
    if ((counted.rows[0]?.n ?? 0) >= DAILY_ENTRY_LIMIT) {
      throw new ValidationError(
        `No more than ${DAILY_ENTRY_LIMIT} mental skills entries a day.`,
        'MENTAL_SKILLS_DAILY_LIMIT',
      );
    }

    const entryId = randomUUID();
    const row = await insert(client, entryId);
    if (!row) throw new Error('MENTAL_SKILLS_INSERT_RETURNED_NOTHING');

    await writePilotAuditEvent(
      {
        event_type: 'create',
        actor_account_id: actor.accountId,
        actor_role: actor.role,
        organization_id: actor.organizationId,
        entity_type: 'athlete_mental_skill_entry',
        entity_id: entryId,
        details: { athlete_id: athleteId, kind, logged_on: day },
      },
      client,
    );
    return row;
  });
}

export async function setSelfTalkCue(
  actor: ActorIdentity,
  input: { cueText: unknown; cueKind: unknown; now?: GymTimeInput },
): Promise<SelfTalkCue> {
  const athleteId = await requireSelfAthlete(actor);
  const problem = cueError(input.cueText, input.cueKind);
  if (problem) throw new ValidationError(problem);
  const day = requireGymDay(input.now);

  return insertEntry(actor, athleteId, day, 'self_talk_cue', async (client, entryId) => (
    await client.query<SelfTalkCue>(
      `insert into pilot.athlete_mental_skill_entries
         (organization_id, entry_id, athlete_id, kind, cue_text, cue_kind, logged_on)
       values ($1, $2, $3, 'self_talk_cue', $4, $5, $6::date)
       returning entry_id::text as entry_id, cue_text, cue_kind, logged_on::text as logged_on`,
      [actor.organizationId, entryId, athleteId, (input.cueText as string).trim(), input.cueKind, day],
    )
  ).rows[0]);
}

export async function logImagerySession(
  actor: ActorIdentity,
  input: { minutes: unknown; contentKey?: unknown; now?: GymTimeInput },
): Promise<ImagerySessionEntry> {
  const athleteId = await requireSelfAthlete(actor);
  const problem = imageryError(input.minutes, input.contentKey);
  if (problem) throw new ValidationError(problem);
  const day = requireGymDay(input.now);

  return insertEntry(actor, athleteId, day, 'imagery_session', async (client, entryId) => (
    await client.query<ImagerySessionEntry>(
      `insert into pilot.athlete_mental_skill_entries
         (organization_id, entry_id, athlete_id, kind, minutes, content_key, logged_on)
       values ($1, $2, $3, 'imagery_session', $4, $5, $6::date)
       returning entry_id::text as entry_id, minutes, content_key, logged_on::text as logged_on`,
      [
        actor.organizationId,
        entryId,
        athleteId,
        input.minutes,
        (input.contentKey as string | null | undefined) ?? null,
        day,
      ],
    )
  ).rows[0]);
}

/** One athlete's current cue and recent imagery sessions, for anyone the
 * per-athlete gate admits. The gate runs before any row is read. */
export async function readMentalSkills(actor: ActorIdentity, athleteId: string): Promise<MentalSkillsView> {
  await assertActorCanAccessAthlete(actor, athleteId);

  const [currentCue, sessions] = await Promise.all([
    queryOne<SelfTalkCue>(
      `select entry_id::text as entry_id, cue_text, cue_kind, logged_on::text as logged_on
       from pilot.athlete_mental_skill_entries
       where organization_id = $1 and athlete_id = $2 and kind = 'self_talk_cue'
       order by created_at desc, entry_id desc
       limit 1`,
      [actor.organizationId, athleteId],
    ),
    query<ImagerySessionEntry>(
      `select entry_id::text as entry_id, minutes, content_key, logged_on::text as logged_on
       from pilot.athlete_mental_skill_entries
       where organization_id = $1 and athlete_id = $2 and kind = 'imagery_session'
       order by created_at desc, entry_id desc
       limit $3`,
      [actor.organizationId, athleteId, RECENT_SESSIONS_LIMIT],
    ),
  ]);

  return { current_cue: currentCue, imagery_sessions: sessions };
}
