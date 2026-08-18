import { randomUUID } from 'node:crypto';

import {
  countCompletedSessions,
  getCoachDisplayName,
  listMilestoneAwards,
} from './achievements';
import { earnedMilestoneKeys, isMilestoneKey } from '@/src/shared/achievementPaths';
import { query, queryOne } from './db';
import { ConflictError, ValidationError } from './errors';

// The 1% Club (register module 127). Owner design, verbatim: "1,2,3 with the
// majority of coach and admin on the list vote to confirm".
//
// Three real nomination paths (NominationSource), one confirmation
// mechanism: a strict majority of the organization's currently-active
// coaches and admins have to vote yes. Nothing here computes a worthiness
// number. There is no leaderboard read anywhere in this module -- every
// query here takes one nomination or one athlete, never orders athletes
// against each other.
//
// Owner decisions (2026-08-16), all expressed as the same 30-day window
// rather than as two separate invented constants:
//   * An open nomination that never reaches majority auto-expires after
//     NOMINATION_WINDOW_DAYS. The row stays (status = 'expired'); nothing is
//     deleted.
//   * The same athlete can be nominated again NOMINATION_WINDOW_DAYS after a
//     withdrawn or expired nomination of theirs closed.
//   * Confirmed membership is permanent. Nothing in this module ever moves a
//     nomination's status away from 'confirmed'.

export const NOMINATION_WINDOW_DAYS = 30;

export const ELIGIBLE_VOTER_ROLES = ['coach', 'organization_admin', 'admin'] as const;
export type EligibleVoterRole = (typeof ELIGIBLE_VOTER_ROLES)[number];

export function isEligibleVoterRole(role: unknown): role is EligibleVoterRole {
  return typeof role === 'string' && (ELIGIBLE_VOTER_ROLES as readonly string[]).includes(role);
}

export const NOMINATION_SOURCES = ['coach_nomination', 'milestone_surfaced', 'self_peer_nomination'] as const;
export type NominationSource = (typeof NOMINATION_SOURCES)[number];

export const NOMINATION_STATUSES = ['open', 'confirmed', 'withdrawn', 'expired'] as const;
export type NominationStatus = (typeof NOMINATION_STATUSES)[number];

export interface NominationRow {
  organization_id: string;
  nomination_id: string;
  athlete_id: string;
  athlete_name?: string;
  source: NominationSource;
  nominated_by_account_id: string;
  nominated_by_role: string;
  nominated_by_display_name: string;
  nominator_note: string;
  milestone_key: string | null;
  status: NominationStatus;
  withdrawal_reason: string | null;
  expires_at: string;
  decided_at: string | null;
  created_at: string;
}

export interface VoteRow {
  organization_id: string;
  nomination_id: string;
  voter_account_id: string;
  voter_role: string;
  voter_display_name: string;
  vote: 'yes' | 'no';
  voted_at: string;
}

export interface VoteTally {
  eligible_count: number;
  yes_count: number;
  no_count: number;
  majority_reached: boolean;
}

const NOMINATION_FIELDS = `n.organization_id, n.nomination_id, n.athlete_id, a.full_name as athlete_name,
  n.source, n.nominated_by_account_id, n.nominated_by_role, n.nominated_by_display_name,
  n.nominator_note, n.milestone_key, n.status, n.withdrawal_reason,
  n.expires_at::text, n.decided_at::text, n.created_at::text`;

const NOMINATION_FROM = `pilot.one_percent_nominations n
   join pilot.athletes a on a.organization_id = n.organization_id and a.athlete_id = n.athlete_id`;

/**
 * Every account that counts toward a majority right now: active coaches and
 * admins in this organization. Computed live rather than cached, so a coach
 * who leaves stops counting immediately and a new hire counts the moment
 * their account is active -- there is no roster to keep in sync separately.
 */
export async function countEligibleVoters(organizationId: string): Promise<number> {
  const row = await queryOne<{ eligible: string }>(
    `select count(*)::text as eligible
     from pilot.accounts
     where organization_id = $1 and active_flag = true
       and role in ('coach', 'organization_admin', 'admin')`,
    [organizationId],
  );
  return Number(row?.eligible ?? 0);
}

/**
 * A human-readable name for whoever acted (nominated or voted), resolved
 * server-side from who is actually signed in -- never accepted from the
 * client. Coaches reuse the platform's existing coach-name derivation;
 * an athlete acting on their own or a peer's behalf is named from their own
 * athlete record, which is the identity that already exists for them.
 */
export async function resolveActorDisplayName(input: {
  organizationId: string;
  accountId: string;
  role: string;
  selfAthleteId?: string | null;
}): Promise<string> {
  if (input.role === 'coach') {
    return getCoachDisplayName(input.organizationId, input.accountId);
  }

  if (input.role === 'athlete' && input.selfAthleteId) {
    const athlete = await queryOne<{ full_name: string }>(
      `select full_name from pilot.athletes where organization_id = $1 and athlete_id = $2`,
      [input.organizationId, input.selfAthleteId],
    );
    return athlete?.full_name?.trim() || 'An athlete';
  }

  const account = await queryOne<{ login_email: string | null }>(
    `select login_email from pilot.accounts where organization_id = $1 and account_id = $2`,
    [input.organizationId, input.accountId],
  );
  const local = account?.login_email?.split('@')[0];
  if (!local) return 'An administrator';
  const spoken = local
    .replace(/[._-]+/g, ' ')
    .replace(/\d+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
  return spoken ? `Admin ${spoken}` : 'An administrator';
}

/**
 * Closes any nomination whose 30-day window ran out without reaching
 * majority. Lazy rather than a scheduled job: called at the top of every
 * read/write in this module, so an 'open' row is never stale by the time
 * anything checks it. Expired rows are kept, per the "nothing is deleted"
 * rule -- only their status changes.
 */
async function expireStaleOpenNominations(organizationId: string): Promise<void> {
  await query(
    `update pilot.one_percent_nominations
     set status = 'expired', decided_at = now(), updated_at = now()
     where organization_id = $1 and status = 'open' and expires_at < now()`,
    [organizationId],
  );
}

/**
 * Verifies a claimed milestone against the athlete's actual, already-earned
 * awards -- never trusts the caller's say-so. Returns the key only if it is
 * real, so a 'milestone_surfaced' nomination is always backed by something
 * that genuinely happened.
 */
async function verifyEarnedMilestone(
  organizationId: string,
  athleteId: string,
  milestoneKey: string,
): Promise<string | null> {
  if (!isMilestoneKey(milestoneKey)) return null;
  const [awards, completedSessions] = await Promise.all([
    listMilestoneAwards(organizationId, athleteId),
    countCompletedSessions(organizationId, athleteId),
  ]);
  const earned = earnedMilestoneKeys({
    completedSessions,
    awardedKeys: awards.map((award) => award.milestone_key),
  });
  return earned.includes(milestoneKey) ? milestoneKey : null;
}

export async function listNominations(
  organizationId: string,
  includeClosed = true,
): Promise<NominationRow[]> {
  await expireStaleOpenNominations(organizationId);
  return query<NominationRow>(
    `select ${NOMINATION_FIELDS} from ${NOMINATION_FROM}
     where n.organization_id = $1 and ($2 or n.status = 'open')
     order by n.status = 'open' desc, n.created_at desc`,
    [organizationId, includeClosed],
  );
}

export async function getNomination(organizationId: string, nominationId: string): Promise<NominationRow | null> {
  await expireStaleOpenNominations(organizationId);
  return queryOne<NominationRow>(
    `select ${NOMINATION_FIELDS} from ${NOMINATION_FROM}
     where n.organization_id = $1 and n.nomination_id = $2`,
    [organizationId, nominationId],
  );
}

/**
 * Creates a real nomination from any of the three paths. `source` is never
 * taken from the caller: a milestone claim is verified against the
 * athlete's actual record before it is trusted, and otherwise the source
 * follows from the nominator's own role.
 */
export async function createNomination(input: {
  organizationId: string;
  athleteId: string;
  nominatorAccountId: string;
  nominatorRole: string;
  nominatorAthleteId?: string | null;
  note?: string;
  claimedMilestoneKey?: string | null;
}): Promise<NominationRow | null> {
  const athlete = await queryOne<{ athlete_id: string }>(
    `select athlete_id from pilot.athletes where organization_id = $1 and athlete_id = $2`,
    [input.organizationId, input.athleteId],
  );
  if (!athlete) return null;

  await expireStaleOpenNominations(input.organizationId);

  const history = await query<{ status: NominationStatus; decided_at: string | null }>(
    `select status, decided_at::text from pilot.one_percent_nominations
     where organization_id = $1 and athlete_id = $2
     order by created_at desc`,
    [input.organizationId, input.athleteId],
  );

  if (history.some((row) => row.status === 'confirmed')) {
    throw new ConflictError('This athlete is already a 1% Club member.');
  }
  if (history.some((row) => row.status === 'open')) {
    throw new ConflictError('This athlete already has an open 1% Club nomination.');
  }

  const mostRecentClosed = history.find((row) => row.status === 'withdrawn' || row.status === 'expired');
  if (mostRecentClosed?.decided_at) {
    const closedAt = new Date(mostRecentClosed.decided_at).getTime();
    const cooldownEndsAt = closedAt + NOMINATION_WINDOW_DAYS * 24 * 60 * 60 * 1000;
    if (Date.now() < cooldownEndsAt) {
      const daysLeft = Math.ceil((cooldownEndsAt - Date.now()) / (24 * 60 * 60 * 1000));
      throw new ConflictError(
        `This athlete's last nomination closed recently. Re-nomination opens in ${daysLeft} day${daysLeft === 1 ? '' : 's'}.`,
      );
    }
  }

  let source: NominationSource = input.nominatorRole === 'athlete' ? 'self_peer_nomination' : 'coach_nomination';
  let milestoneKey: string | null = null;
  if (input.claimedMilestoneKey) {
    milestoneKey = await verifyEarnedMilestone(input.organizationId, input.athleteId, input.claimedMilestoneKey);
    if (milestoneKey) source = 'milestone_surfaced';
  }

  const displayName = await resolveActorDisplayName({
    organizationId: input.organizationId,
    accountId: input.nominatorAccountId,
    role: input.nominatorRole,
    selfAthleteId: input.nominatorAthleteId,
  });

  const nominationId = randomUUID();
  await queryOne(
    `insert into pilot.one_percent_nominations (
       organization_id, nomination_id, athlete_id, source,
       nominated_by_account_id, nominated_by_role, nominated_by_display_name,
       nominator_note, milestone_key, expires_at
     ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, now() + ($10 || ' days')::interval)
     returning nomination_id`,
    [
      input.organizationId,
      nominationId,
      input.athleteId,
      source,
      input.nominatorAccountId,
      input.nominatorRole,
      displayName,
      input.note ?? '',
      milestoneKey,
      NOMINATION_WINDOW_DAYS,
    ],
  );

  return getNomination(input.organizationId, nominationId);
}

/**
 * Casts one vote and recomputes the tally against the CURRENT eligible-voter
 * count. Confirms the nomination the moment yes-votes form a strict
 * majority of everyone eligible right now -- not a majority of votes cast,
 * per the owner's design ("majority of coach and admin ON THE LIST").
 *
 * A second vote from the same account is a no-op if it repeats their first
 * choice, and refused if it tries to change it: the ledger is immutable
 * once cast, which is what "auditable" means here.
 */
export async function castVote(input: {
  organizationId: string;
  nominationId: string;
  voterAccountId: string;
  voterRole: string;
  vote: 'yes' | 'no';
}): Promise<{ nomination: NominationRow; tally: VoteTally } | null> {
  await expireStaleOpenNominations(input.organizationId);

  const nomination = await getNomination(input.organizationId, input.nominationId);
  if (!nomination) return null;

  if (nomination.status !== 'open') {
    throw new ConflictError('This nomination is not open for voting.');
  }

  const existingVote = await queryOne<{ vote: 'yes' | 'no' }>(
    `select vote from pilot.one_percent_votes
     where organization_id = $1 and nomination_id = $2 and voter_account_id = $3`,
    [input.organizationId, input.nominationId, input.voterAccountId],
  );

  if (existingVote && existingVote.vote !== input.vote) {
    throw new ConflictError('You already voted on this nomination, and a vote cannot be changed.');
  }

  if (!existingVote) {
    const displayName = await resolveActorDisplayName({
      organizationId: input.organizationId,
      accountId: input.voterAccountId,
      role: input.voterRole,
    });
    await queryOne(
      `insert into pilot.one_percent_votes
         (organization_id, nomination_id, voter_account_id, voter_role, voter_display_name, vote)
       values ($1, $2, $3, $4, $5, $6)
       on conflict (organization_id, nomination_id, voter_account_id) do nothing
       returning voter_account_id`,
      [input.organizationId, input.nominationId, input.voterAccountId, input.voterRole, displayName, input.vote],
    );
  }

  const tally = await getTally(input.organizationId, input.nominationId);

  if (tally.majority_reached) {
    await queryOne(
      `update pilot.one_percent_nominations
       set status = 'confirmed', decided_at = now(), updated_at = now()
       where organization_id = $1 and nomination_id = $2 and status = 'open'
       returning nomination_id`,
      [input.organizationId, input.nominationId],
    );
  }

  const refreshed = await getNomination(input.organizationId, input.nominationId);
  if (!refreshed) return null;
  return { nomination: refreshed, tally };
}

export async function getTally(organizationId: string, nominationId: string): Promise<VoteTally> {
  const [eligibleCount, counts] = await Promise.all([
    countEligibleVoters(organizationId),
    query<{ vote: 'yes' | 'no'; count: string }>(
      `select vote, count(*)::text as count from pilot.one_percent_votes
       where organization_id = $1 and nomination_id = $2
       group by vote`,
      [organizationId, nominationId],
    ),
  ]);

  const yesCount = Number(counts.find((row) => row.vote === 'yes')?.count ?? 0);
  const noCount = Number(counts.find((row) => row.vote === 'no')?.count ?? 0);

  return {
    eligible_count: eligibleCount,
    yes_count: yesCount,
    no_count: noCount,
    majority_reached: eligibleCount > 0 && yesCount * 2 > eligibleCount,
  };
}

export async function listVotes(organizationId: string, nominationId: string): Promise<VoteRow[]> {
  return query<VoteRow>(
    `select organization_id, nomination_id, voter_account_id, voter_role, voter_display_name,
            vote, voted_at::text
     from pilot.one_percent_votes
     where organization_id = $1 and nomination_id = $2
     order by voted_at asc`,
    [organizationId, nominationId],
  );
}

/**
 * Withdraws an OPEN nomination with a stated reason. Cannot touch a
 * confirmed one -- membership is permanent by owner decision, so there is no
 * code path anywhere that moves a row out of 'confirmed'.
 */
export async function withdrawNomination(input: {
  organizationId: string;
  nominationId: string;
  reason: string;
}): Promise<NominationRow | null> {
  const reason = input.reason.trim();
  if (!reason) {
    throw new ValidationError('A withdrawal needs a reason -- the nomination stays on record with it.');
  }

  await expireStaleOpenNominations(input.organizationId);

  const row = await queryOne<{ nomination_id: string }>(
    `update pilot.one_percent_nominations
     set status = 'withdrawn', withdrawal_reason = $3, decided_at = now(), updated_at = now()
     where organization_id = $1 and nomination_id = $2 and status = 'open'
     returning nomination_id`,
    [input.organizationId, input.nominationId, reason],
  );
  if (!row) return null;
  return getNomination(input.organizationId, input.nominationId);
}

/** Confirmed members only -- the roster this module actually exists to produce. */
export async function listMembers(organizationId: string): Promise<NominationRow[]> {
  await expireStaleOpenNominations(organizationId);
  return query<NominationRow>(
    `select ${NOMINATION_FIELDS} from ${NOMINATION_FROM}
     where n.organization_id = $1 and n.status = 'confirmed'
     order by n.decided_at asc`,
    [organizationId],
  );
}
