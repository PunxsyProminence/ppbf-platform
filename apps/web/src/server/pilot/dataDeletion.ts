import { randomUUID } from 'node:crypto';

import type { PoolClient } from 'pg';

import { formatGymDate } from '../../lib/gymTime';

import type { PilotRole } from './contracts';
import { query, withTransaction } from './db';
import { ConflictError } from './errors';
import { lockGuardianLinksForPurge, MEDIA_CONSENT_WAIVER_TYPE } from './guardianConsent';

export interface ActorIdentity {
  accountId: string;
  role: PilotRole;
  organizationId: string;
}

export interface DeletionResult {
  deletedEntityType: 'athlete' | 'guardian';
  deletedEntityId: string;
  deletedRecordsCounts: {
    athletes?: number;
    accounts?: number;
    /* Scope B: rows tied to the athlete, marked deleted with them. Marked, not
       removed -- every row stays in the database until the purge; the mark is
       what takes it off every screen (see markAthleteTiedRecords). */
    athleteVideos?: number;
    athletePhotos?: number;
    coachNotes?: number;
    sessionNotes?: number;
    shadowConversations?: number;
  };
  deletedAt: string;
  auditEventId: number;
}

type TiedRecordCounts = Required<
  Pick<
    DeletionResult['deletedRecordsCounts'],
    'athleteVideos' | 'athletePhotos' | 'coachNotes' | 'sessionNotes' | 'shadowConversations'
  >
>;

/**
 * Scope B (Jason, 2026-09-29, "10 C"): "everything tied to the athlete is
 * marked deleted at the same moment". Runs inside the deletion transaction,
 * after the athlete rows carry their deleted_at.
 *
 * WHAT MARKS THE ROWS. The athlete row's own deleted_at, written by the
 * caller in this same transaction: every reader of a row tied to an athlete
 * checks it (deletedAthletes.ts), so the videos, portrait, coach notes,
 * session notes and every other tied row leave every screen at the moment
 * this transaction commits, and not a moment before. No tied table other than
 * shadow_chat_sessions has a deletion column of its own, and copying the mark
 * onto seventy tables would only add seventy chances to disagree with it.
 *
 * shadow_chat_sessions.deleted_at DOES exist -- it is what "delete this
 * conversation" and a completed SHADOW data-deletion request write -- so it is
 * stamped here, for the athlete's own conversations and for staff
 * conversations about the athlete, with the deletion's own timestamp. Never
 * over an earlier stamp: a conversation the owner already deleted keeps its
 * date.
 *
 * The counts are what the admin is told was marked: how many of each tied
 * record the mark now covers. Counted, not removed -- nothing here deletes a
 * row or a stored file.
 */
async function markAthleteTiedRecords(
  client: PoolClient,
  organizationId: string,
  athleteIds: string[],
  athleteAccountIds: string[],
  deletionTime: string,
): Promise<TiedRecordCounts> {
  if (athleteIds.length === 0) {
    return { athleteVideos: 0, athletePhotos: 0, coachNotes: 0, sessionNotes: 0, shadowConversations: 0 };
  }

  const conversations = await client.query(
    `update pilot.shadow_chat_sessions
        set deleted_at = $4::timestamptz, updated_at = now()
      where organization_id = $1
        and (athlete_id = any($2::text[]) or account_id = any($3::text[]))
        and deleted_at is null`,
    [organizationId, athleteIds, athleteAccountIds, deletionTime],
  );

  const counted = await client.query<{
    videos: string;
    photos: string;
    coach_notes: string;
    session_notes: string;
  }>(
    `select
       (select count(*) from pilot.video_sessions
         where organization_id = $1 and athlete_id = any($2::text[]))::text as videos,
       (select count(*) from pilot.account_profiles
         where organization_id = $1 and account_id = any($3::text[])
           and photo_blob_path is not null)::text as photos,
       (select count(*) from pilot.coach_observations
         where organization_id = $1 and athlete_id = any($2::text[]))::text as coach_notes,
       (select count(*) from pilot.sessions
         where organization_id = $1 and athlete_id = any($2::text[]))::text as session_notes`,
    [organizationId, athleteIds, athleteAccountIds],
  );
  const row = counted.rows[0];

  return {
    athleteVideos: parseInt(row.videos, 10),
    athletePhotos: parseInt(row.photos, 10),
    coachNotes: parseInt(row.coach_notes, 10),
    sessionNotes: parseInt(row.session_notes, 10),
    shadowConversations: conversations.rowCount ?? 0,
  };
}

/**
 * Owner decision, 2026-09-29 ("1A"): a person already marked deleted is
 * refused, and nothing is changed -- no second deleted_at, no second audit row.
 *
 * Before this, a repeat deletion wrote deleted_at = now() again, and the purge
 * measures its 2-year / 1-year window from deleted_at, so a second click
 * restarted the person's retention clock. The caller is told the date the
 * first deletion happened, in the gym's timezone.
 */
function refuseAlreadyDeleted(who: 'athlete' | 'guardian', deletedAt: string | null | undefined): void {
  if (!deletedAt) {
    return;
  }
  const day = formatGymDate(deletedAt) ?? deletedAt;
  throw new ConflictError(
    `This ${who} was already deleted on ${day}. Nothing was changed.`,
    'ALREADY_DELETED',
  );
}

/** The audit record's copy of the counts, in the audit vocabulary's snake_case. */
function tiedRecordsAudit(tied: TiedRecordCounts) {
  return {
    videos: tied.athleteVideos,
    photos: tied.athletePhotos,
    coach_notes: tied.coachNotes,
    session_notes: tied.sessionNotes,
    shadow_conversations: tied.shadowConversations,
  };
}

/**
 * Cancels every activation code still waiting to be redeemed for the given athlete accounts.
 *
 * Closing a login means more than active_flag = false and revoked sessions. redeemActivationCode
 * (activation.ts) sets active_flag = true on the account and its membership and never reads
 * deleted_at, so a code handed out before the deletion -- live for 14 days by default, up to 90
 * (activationPolicy.ts) -- would set a PIN and turn the account active again, with no admin
 * involved. Sign-in now refuses a deleted account whatever active_flag says
 * (deletedAccountSignIn.ts), so this is the second lock on that door, not the only one; it also
 * keeps the account from reading as active. Superseded rather than deleted: the row stays as the
 * record that a code existed, and cleanupActivationTokens removes it on its own schedule. Same
 * transaction as the deletion.
 */
async function supersedeOutstandingActivationCodes(
  client: PoolClient,
  accountIds: string[],
): Promise<void> {
  if (accountIds.length === 0) {
    return;
  }
  await client.query(
    `update pilot.account_activation_tokens
     set superseded_at = now()
     where account_id = any($1::text[]) and consumed_at is null and superseded_at is null`,
    [accountIds],
  );
}

/**
 * Soft-deletes a guardian/parent account; the database trigger then marks deleted each linked
 * athlete this guardian was the last guardian of, and everything tied to those athletes is marked
 * with them (scope B, markAthleteTiedRecords). Refuses (409) a guardian already deleted.
 * Organization-admin only. Writes the audit event in the same transaction, after the soft delete.
 */
export async function deleteGuardianAccount(
  actor: ActorIdentity,
  parentAccountId: string,
  reason?: string,
): Promise<DeletionResult> {
  if (actor.role !== 'organization_admin' && actor.role !== 'admin') {
    throw new Error('Forbidden: only organization admin can delete accounts');
  }

  return withTransaction(async (client) => {
    // Verify the parent account exists and belongs to this organization.
    // `for update` holds the row until this transaction ends, so a second
    // deletion racing this one waits, then reads the deleted_at this one wrote
    // and is refused below instead of writing a second one.
    const parentRow = await client.query<{ account_id: string; role: string; deleted_at: string | null }>(
      `select account_id, role, deleted_at::text as deleted_at from pilot.accounts
       where account_id = $1 and organization_id = $2 and role = 'parent'
       for update`,
      [parentAccountId, actor.organizationId],
    );

    if (parentRow.rows.length === 0) {
      throw new Error('Not found: parent account does not exist or is not a parent role');
    }

    refuseAlreadyDeleted('guardian', parentRow.rows[0].deleted_at);

    // Take the timestamp the DATABASE stamped, not one minted in JavaScript.
    // The cascade trigger copies new.deleted_at onto the linked athletes, so
    // this is the only value that can match them. The count previously compared
    // against a JS ISO string, which never equals now() from the same
    // statement, so it reported zero cascaded athletes every time -- including
    // when it had just soft-deleted several.
    // ::text, not the bare column. node-pg parses timestamptz into a JS Date,
    // which holds milliseconds while Postgres stores microseconds -- so a value
    // round-tripped through JS no longer equals the one on the row, and the
    // count below silently returns zero. Keeping it as text preserves the exact
    // value for the comparison.
    /* active_flag = false is not decoration, it is half of what makes this a
       deletion at all.

       Deleting a guardian used to write deleted_at and nothing else, and at
       the time NOTHING in the read path filtered on deleted_at: resolvePrincipal's
       query (auth.ts) joined accounts without it, and so does every guardian
       access check. So the flag the rest of the platform actually gates on --
       active_flag -- stayed true, and a "deleted" guardian kept reading their
       linked minor's records.

       Worse than a stale session: `parent` is a magic-link role, and both the
       issue and redeem paths gated on active_flag (magicLink.ts) and never
       looked at deleted_at. A deleted guardian could request a fresh link to
       their own inbox and sign in again, indefinitely, until the account row
       was purged a year later. Deletion did not close the door; it did not
       touch it. (Every sign-in path and resolvePrincipal now also refuse an
       account marked deleted -- deletedAccountSignIn.ts -- so this write is one
       of two locks, not the only one.)

       This is the platform's own stated contract, which only the cleanup script
       implemented: scripts/lib/account-cleanup-plan.mjs defines "retire" as
       "deleted_at set, active_flag cleared, sessions revoked". That script
       deliberately skips parents precisely because deleting one fires the
       cascade trigger across minors' records -- so guardians were only ever
       deleted through the path that did one of the three. */
    const deleted = await client.query<{ deleted_at: string }>(
      `update pilot.accounts
       set deleted_at = now(), active_flag = false, updated_at = now()
       where account_id = $1
       returning deleted_at::text as deleted_at`,
      [parentAccountId],
    );
    const deletionTime = deleted.rows[0].deleted_at;

    /* Membership carries authorization independently of the account row:
       resolvePrincipal INNER JOINs organization_memberships on
       active_flag = true, so leaving it set is what let a deleted guardian's
       existing cookie keep resolving. */
    await client.query(
      `update pilot.organization_memberships
       set active_flag = false, updated_at = now()
       where account_id = $1 and organization_id = $2`,
      [parentAccountId, actor.organizationId],
    );

    /* In the SAME transaction as the deletion, so there is no window in which
       the account is deleted but a live session still resolves. Every other
       account-state mutation already does this -- the PIN reset in
       activation.ts, and in auth.ts changeOwnPin, setAccountActiveStatus,
       upsertOrganizationMembership, transferOrganizationAdmin,
       promoteAccountToOrganizationAdmin. Deletion was the one that did not,
       which is the reverse of the priority it should have had. */
    await client.query(
      `update pilot.session_tokens
       set revoked_at = now()
       where account_id = $1 and revoked_at is null`,
      [parentAccountId],
    );

    const withdrawnAthletes = await client.query<{ athlete_id: string }>(
      `select athlete_id from pilot.athletes
       where deleted_at = $1::timestamptz and organization_id = $2`,
      [deletionTime, actor.organizationId],
    );
    const withdrawnAthleteIds = withdrawnAthletes.rows.map((row) => row.athlete_id);

    /* The children the trigger just withdrew had their own logins closed by
       it (deleted_at, active_flag, sessions), and they are the athlete
       accounts in this organization now carrying exactly this deletion's
       timestamp -- the trigger copies new.deleted_at onto them, the same
       match the count above relies on. Their outstanding activation codes are
       cancelled here, for the reason supersedeOutstandingActivationCodes
       records. */
    const withdrawnChildAccounts = await client.query<{ account_id: string }>(
      `select account_id from pilot.accounts
       where organization_id = $1 and role = 'athlete' and deleted_at = $2::timestamptz`,
      [actor.organizationId, deletionTime],
    );
    const withdrawnChildAccountIds = withdrawnChildAccounts.rows.map((row) => row.account_id);
    await supersedeOutstandingActivationCodes(client, withdrawnChildAccountIds);

    /* A child the cascade withdrew is an athlete deleted at this moment like
       any other, so scope B covers them too: the same mark, the same stamp on
       their conversations, in this transaction. */
    const tied = await markAthleteTiedRecords(
      client,
      actor.organizationId,
      withdrawnAthleteIds,
      withdrawnChildAccountIds,
      deletionTime,
    );

    // Log to audit trail
    const auditResult = await client.query<{ audit_id: number }>(
      `insert into pilot.audit_events (
         event_type, actor_account_id, actor_role, organization_id,
         entity_type, entity_id, details
       ) values (
         $1, $2, $3, $4, $5, $6, $7
       ) returning audit_id`,
      [
        'data_deletion_initiated',
        actor.accountId,
        actor.role,
        actor.organizationId,
        'parent_account',
        parentAccountId,
        JSON.stringify({
          reason: reason || 'Not specified',
          cascade_deleted_athletes: withdrawnAthleteIds.length,
          // What the withdrawn children's mark covers (scope B), counted.
          tied_records_marked: tiedRecordsAudit(tied),
          deleted_at: new Date(deletionTime).toISOString(),
        }),
      ],
    );

    return {
      deletedEntityType: 'guardian',
      deletedEntityId: parentAccountId,
      deletedRecordsCounts: {
        accounts: 1,
        athletes: withdrawnAthleteIds.length,
        ...tied,
      },
      deletedAt: new Date(deletionTime).toISOString(),
      auditEventId: auditResult.rows[0].audit_id,
    };
  });
}

/**
 * Soft-deletes an athlete record, closes the athlete's own login, and marks everything tied to
 * the athlete deleted at the same moment (scope B, markAthleteTiedRecords). Refuses (409) an
 * athlete already deleted. Organization-admin only. Writes the audit event in the same
 * transaction, after the soft delete.
 */
export async function deleteAthleteRecord(
  actor: ActorIdentity,
  athleteId: string,
  reason?: string,
): Promise<DeletionResult> {
  if (actor.role !== 'organization_admin' && actor.role !== 'admin') {
    throw new Error('Forbidden: only organization admin can delete athlete records');
  }

  return withTransaction(async (client) => {
    // Verify the athlete exists and belongs to this organization. `for update`
    // for the same reason as the guardian path above.
    const athleteRow = await client.query<{ athlete_id: string; deleted_at: string | null }>(
      `select athlete_id, deleted_at::text as deleted_at from pilot.athletes
       where athlete_id = $1 and organization_id = $2
       for update`,
      [athleteId, actor.organizationId],
    );

    if (athleteRow.rows.length === 0) {
      throw new Error('Not found: athlete does not exist in this organization');
    }

    // Also refuses an athlete the guardian cascade already withdrew: that
    // athlete's row carries the cascade's deleted_at.
    refuseAlreadyDeleted('athlete', athleteRow.rows[0].deleted_at);

    const deletedAthlete = await client.query<{ deleted_at: string }>(
      `update pilot.athletes
       set deleted_at = now(), updated_at = now()
       where athlete_id = $1 and organization_id = $2
       returning deleted_at::text as deleted_at`,
      [athleteId, actor.organizationId],
    );
    const deletionTime = deletedAthlete.rows[0].deleted_at;

    /* The athlete's ACCOUNT, which deleting the athlete used to leave running.

       deleteGuardianAccount does all three of these -- deleted_at, active_flag
       and session revocation -- because #690 found that writing deleted_at
       alone left a deleted guardian reading their minor's records. This
       function is the same function for the other party and it did exactly one
       of the three, so the same hole was open on the athlete side and nobody
       had looked.

       Concretely, before this: the athlete row was marked deleted while
       pilot.accounts.active_flag stayed true, so the athlete kept signing in
       with their PIN. The self-access branch of assertActorCanAccessAthlete
       compares actor.athleteId to the requested id and reads no row at all, so
       it could not have noticed either. A withdrawn athlete kept a working
       login to their own record for the entire two-year retention window.

       pilot.accounts.athlete_id is the link, and (organization_id, athlete_id)
       is unique on that table, so this addresses at most one account and cannot
       reach another gym's. Scoped on role as well: the column is nullable and
       only athlete accounts carry it, but an explicit role predicate means a
       future account type that borrows the column cannot be caught by this. */
    const deactivatedAccount = await client.query<{ account_id: string }>(
      `update pilot.accounts
       set deleted_at = now(), active_flag = false, updated_at = now()
       where organization_id = $1 and athlete_id = $2 and role = 'athlete'
       returning account_id`,
      [actor.organizationId, athleteId],
    );

    /* In the SAME transaction as the deletion, so there is no window in which
       the athlete is deleted but a live session still resolves -- the identical
       reasoning deleteGuardianAccount records above. A PIN that no longer works
       is not enough on its own: an athlete already signed in holds a session
       token that resolvePrincipal accepts without re-reading active_flag. */
    let sessionsRevoked = 0;
    if (deactivatedAccount.rows.length > 0) {
      /* rowCount, not `returning` anything. The only columns this table has
         to return are the token hash and the account id, and there is no
         reason to pull session-token material into application memory to
         count rows the driver has already counted. */
      const revoked = await client.query(
        `update pilot.session_tokens
         set revoked_at = now()
         where account_id = $1 and revoked_at is null`,
        [deactivatedAccount.rows[0].account_id],
      );
      sessionsRevoked = revoked.rowCount ?? 0;

      await supersedeOutstandingActivationCodes(client, [deactivatedAccount.rows[0].account_id]);
    }

    /* Scope B: everything tied to the athlete, marked at this same moment.
       Counts of rows MARKED, never of rows removed: a soft delete leaves every
       row in place, the FK cascade does not fire, and nothing is erased. The
       audit record once called its observation count
       'cascade_deleted_observations', claiming a deletion that had not
       happened -- in the record whose whole purpose is being accurate about
       what was deleted. */
    const tied = await markAthleteTiedRecords(
      client,
      actor.organizationId,
      [athleteId],
      deactivatedAccount.rows.map((row) => row.account_id),
      deletionTime,
    );

    // Log to audit trail
    const auditResult = await client.query<{ audit_id: number }>(
      `insert into pilot.audit_events (
         event_type, actor_account_id, actor_role, organization_id,
         entity_type, entity_id, details
       ) values (
         $1, $2, $3, $4, $5, $6, $7
       ) returning audit_id`,
      [
        'data_deletion_initiated',
        actor.accountId,
        actor.role,
        actor.organizationId,
        'athlete',
        athleteId,
        JSON.stringify({
          reason: reason || 'Not specified',
          tied_records_marked: tiedRecordsAudit(tied),
          // Counts, not claims. An athlete record with no account deactivates
          // nothing and revokes nothing, and the audit row should say so
          // rather than imply an access closure that did not happen.
          account_deactivated: deactivatedAccount.rows.length > 0,
          sessions_revoked: sessionsRevoked,
          deleted_at: new Date(deletionTime).toISOString(),
        }),
      ],
    );

    return {
      deletedEntityType: 'athlete',
      deletedEntityId: athleteId,
      deletedRecordsCounts: {
        athletes: 1,
        accounts: deactivatedAccount.rows.length,
        ...tied,
      },
      deletedAt: new Date(deletionTime).toISOString(),
      auditEventId: auditResult.rows[0].audit_id,
    };
  });
}

/* THE PURGED PERSON'S SHADOW ROWS. Owner ruling, Jason 2026-10-06: "delete
   any thing that personally Identifys the person but we keep data that
   [makes] the Ai and ML better". The statements, and the reasoning for each
   table, are scripts/pilot-cleanup-deleted-data.mjs SHADOW_OPERATIONAL_TABLES;
   this is the same code in the function path. In short: profiles, jobs, rate
   buckets and unlock snapshots are deleted; shadow_chat_audit is kept with
   every key that names the person replaced by one random token per person,
   their own typed words emptied (Q1, "Delete theirs, keep AI replies") and
   their known names scrubbed from every other text on the row (Jason
   2026-10-07, "Scrub the child's name, keep"); a purged guardian's names
   also leave the turns about each child they were linked to; a person with
   no usable name on record has their rows deleted instead. */
const SHADOW_OPERATIONAL_TABLES = [
  'shadow_user_profiles',
  'shadow_jobs',
  'shadow_rate_limit_buckets',
  'shadow_feature_unlock_snapshots',
] as const;

type ShadowOperationalTable = (typeof SHADOW_OPERATIONAL_TABLES)[number];

export interface ShadowPurgeSubject {
  token: string;
  accountIds: string[];
  /** Athlete records whose turns the names must leave; token null = scrub only (the person is not purged). */
  subjects: Array<{ organizationId: string; athleteId: string; token: string | null }>;
  names: Array<string | null | undefined>;
}

function anonymousToken(): string {
  return `anon_${randomUUID()}`;
}

/**
 * A Postgres ARE pattern matching any of the names, whole and by part, on
 * word boundaries; null when nothing usable is known. Parts split on spaces,
 * commas, hyphens, apostrophes, periods, brackets and @ ("Mary-Kate" gives
 * "Mary" and "Kate"); an email contributes its local part; every candidate
 * loses its leading and trailing punctuation so a word boundary can match
 * it ("Jr." is "Jr"). Single letters are not names ("J." would scrub every
 * j), so a part must be two characters or more. Short common words that are
 * also name parts ("Will", "de") are scrubbed too: the method prefers losing
 * a word of kept text to keeping a name. Same function as the script's.
 */
export function namePattern(names: Array<string | null | undefined>): string | null {
  const parts = new Set<string>();
  for (const name of names) {
    const whole = (name ?? '').trim();
    if (!whole) continue;
    const candidates = [whole, ...whole.split(/[\s,.'’()@\-]+/)];
    if (whole.includes('@')) candidates.push(whole.slice(0, whole.indexOf('@')));
    for (const candidate of candidates) {
      const part = candidate.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
      if (part.length >= 2) parts.add(part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    }
  }
  if (parts.size === 0) return null;
  // Longest first, so "Ann Lee" is replaced before "Ann" splits it.
  return `\\m(${[...parts].sort((a, b) => b.length - a.length).join('|')})\\M`;
}

async function deleteShadowOperationalRows(
  client: PoolClient,
  accountIds: string[],
): Promise<Record<ShadowOperationalTable, number>> {
  const counts = { shadow_user_profiles: 0, shadow_jobs: 0, shadow_rate_limit_buckets: 0, shadow_feature_unlock_snapshots: 0 };
  if (accountIds.length === 0) return counts;
  for (const table of SHADOW_OPERATIONAL_TABLES) {
    const deleted = await client.query(`delete from pilot.${table} where account_id = any($1::text[])`, [accountIds]);
    counts[table] += deleted.rowCount ?? 0;
  }
  return counts;
}

/** A purged athlete's id leaves every other profile's athletes_discussed (the script's clearShadowProfileMentions). */
async function clearShadowProfileMentions(
  client: PoolClient,
  subjects: Array<{ organizationId: string; athleteId: string }>,
): Promise<number> {
  if (subjects.length === 0) return 0;
  const cleared = await client.query(
    `update pilot.shadow_user_profiles p
        set athlete_ids_discussed = array(
              select x from unnest(p.athlete_ids_discussed) as x
               where (p.organization_id, x) not in (select * from unnest($1::text[], $2::text[]))),
            updated_at = now()
      where exists (select 1 from unnest($1::text[], $2::text[]) as e(organization_id, athlete_id)
                     where e.organization_id = p.organization_id and e.athlete_id = any(p.athlete_ids_discussed))`,
    [subjects.map((row) => row.organizationId), subjects.map((row) => row.athleteId)],
  );
  return cleared.rowCount ?? 0;
}

/** The script's deidentifyShadowChatAudit: same merging, same statements. */
async function deidentifyShadowChatAudit(
  client: PoolClient,
  people: ShadowPurgeSubject[],
): Promise<{ deidentified: number; deleted: number }> {
  if (people.length === 0) return { deidentified: 0, deleted: 0 };
  const logins = new Map<string, { accountId: string; token: string; names: ShadowPurgeSubject['names'] }>();
  const subjects = new Map<string, { organizationId: string; athleteId: string; token: string | null; names: ShadowPurgeSubject['names'] }>();
  for (const person of people) {
    for (const accountId of person.accountIds) {
      const entry = logins.get(accountId) ?? { accountId, token: person.token, names: [] };
      entry.names.push(...person.names);
      logins.set(accountId, entry);
    }
    for (const subject of person.subjects) {
      const key = `${subject.organizationId}\u0000${subject.athleteId}`;
      const entry = subjects.get(key) ?? { ...subject, token: null, names: [] };
      entry.token = entry.token ?? subject.token;
      entry.names.push(...person.names);
      subjects.set(key, entry);
    }
  }
  const loginRows = [...logins.values()].map((row) => ({ ...row, pattern: namePattern(row.names) }));
  const subjectRows = [...subjects.values()]
    .map((row) => ({ ...row, pattern: namePattern(row.names) }))
    // An untokened record with no name has nothing to scrub and must not match.
    .filter((row) => row.token !== null || row.pattern !== null);
  const params = [
    loginRows.map((row) => row.accountId),
    loginRows.map((row) => row.token),
    loginRows.map((row) => row.pattern),
    subjectRows.map((row) => row.organizationId),
    subjectRows.map((row) => row.athleteId),
    subjectRows.map((row) => row.token),
    subjectRows.map((row) => row.pattern),
  ];
  const matched = `
    from pilot.shadow_chat_audit a2
    left join unnest($1::text[], $2::text[], $3::text[]) as l(account_id, token, pattern) on l.account_id = a2.user_id
    left join unnest($4::text[], $5::text[], $6::text[], $7::text[]) as s(organization_id, athlete_id, token, pattern)
      on s.organization_id = a2.organization_id and s.athlete_id = a2.athlete_id
    where l.account_id is not null
       or (s.athlete_id is not null
           and (s.token is not null or a2.user_message ~* s.pattern or a2.shadow_response ~* s.pattern))`;
  // A turn is matched by the purged person's login or record; an untokened
  // record (a purged guardian's child) only where the text holds a name, so
  // the count is rows changed, not rows looked at.
  // Turns of or about a purged person with no name on record: deleted, never half-scrubbed.
  const deleted = await client.query(
    `delete from pilot.shadow_chat_audit a
      using (select a2.chat_audit_id, l.token as login_token, l.pattern as login_pattern,
                    s.token as subject_token, s.pattern as subject_pattern ${matched}) m
      where a.chat_audit_id = m.chat_audit_id
        and ((m.login_token is not null and m.login_pattern is null)
          or (m.subject_token is not null and m.subject_pattern is null))`,
    params,
  );
  const scrub = (column: string) =>
    `regexp_replace(regexp_replace(${column}, coalesce(m.login_pattern, m.subject_pattern), '[name]', 'gi'),
                    coalesce(m.subject_pattern, m.login_pattern), '[name]', 'gi')`;
  const updated = await client.query(
    `update pilot.shadow_chat_audit a
        set user_id = coalesce(m.login_token, a.user_id),
            athlete_id = coalesce(m.subject_token, a.athlete_id),
            user_message = case when m.login_token is not null then '' else ${scrub('a.user_message')} end,
            shadow_response = ${scrub('a.shadow_response')}
       from (select a2.chat_audit_id, l.token as login_token, l.pattern as login_pattern,
                    s.token as subject_token, s.pattern as subject_pattern ${matched}) m
      where a.chat_audit_id = m.chat_audit_id`,
    params,
  );
  return { deidentified: updated.rowCount ?? 0, deleted: deleted.rowCount ?? 0 };
}

/**
 * Hard-deletes data that has been soft-deleted and reached its retention window.
 * Returns count of rows deleted.
 *
 * NOT THE JOB THAT RUNS. retention-cleanup.yml dispatches
 * scripts/pilot-cleanup-deleted-data.mjs, which issues the same statements
 * behind the target, dry-run and blast-radius guards; this function has no
 * caller in the application. The two are kept in step deliberately -- one
 * destructive policy written twice is how the two stop agreeing -- but the
 * script is the one with the per-account isolation, so a guardian it cannot
 * purge does not stop the others. Here a blocked account still aborts the
 * transaction. Consolidating them is a separate change.
 */
export async function purgeExpiredDeletedData(): Promise<{ rowsDeleted: number }> {
  // One transaction. These are the only irreversible deletes in the platform,
  // and the audit row is the sole record that they happened. Run apart, a
  // failure at the audit insert leaves rows permanently gone and nothing
  // saying so -- which is precisely the evidence a retention policy exists to
  // produce.
  return withTransaction(async (client) => {
    let totalDeleted = 0;

    // Delete athletes soft-deleted more than 2 years ago
    /* Which athletes, and which login names each, are decided and LOCKED
       before anything is deleted -- athlete rows first, then accounts, the
       order deleteAthleteRecord takes them in. The reason is in
       scripts/pilot-cleanup-deleted-data.mjs: asking which account has
       (organization_id, athlete_id) after the delete can answer with a login
       that was moved into the gym in between. */
    const expired = await client.query<{ organization_id: string; athlete_id: string }>(
      `select organization_id, athlete_id
         from pilot.athletes
        where deleted_at is not null
          and deleted_at < (now() - interval '2 years')
          for update`,
    );
    const expiredOrgs = expired.rows.map((row) => row.organization_id);
    const expiredIds = expired.rows.map((row) => row.athlete_id);
    const linked = expired.rows.length === 0
      ? { rows: [] as Array<{ account_id: string; organization_id: string; athlete_id: string; role: string; live: boolean; login_email: string | null }> }
      : await client.query<{ account_id: string; organization_id: string; athlete_id: string; role: string; live: boolean; login_email: string | null }>(
        `select acct.account_id, acct.organization_id, acct.athlete_id, acct.role, acct.deleted_at is null as live, acct.login_email
           from pilot.accounts acct
           join unnest($1::text[], $2::text[]) as expired(organization_id, athlete_id)
             on acct.organization_id = expired.organization_id
            and acct.athlete_id = expired.athlete_id
            for update of acct`,
        [expiredOrgs, expiredIds],
      );

    /* The guardian links every delete below will cascade through, locked now
       in the shared order (guardianConsent.ts lockGuardianLinksForPurge):
       those of the athletes locked above and those of every guardian record
       the parent purge below removes. Without it each cascade locked its links
       as it went, in no stated order, and against a consent reader holding
       several athletes' links that is a deadlock. Locks only; the deletes
       below are unchanged. */
    // The guardian records the parent purge below deletes: same predicate.
    const expiredGuardianRecords = await client.query<{ organization_id: string; parent_id: string }>(
      `select organization_id, parent_id from pilot.parents
        where account_id in (
          select account_id from pilot.accounts
           where deleted_at is not null
             and deleted_at < (now() - interval '1 year')
             and role = 'parent'
        )`,
    );
    await lockGuardianLinksForPurge(client, expired.rows, expiredGuardianRecords.rows);

    /* The names to scrub from SHADOW's chat log (SHADOW_OPERATIONAL_TABLES),
       read while the rows that hold them still exist: the athlete's name,
       the names of the guardians still linked to them, and the ring name of
       each athlete login. Keyed by athlete, used only for those deleted. */
    const knownNames = new Map<string, string[]>();
    if (expired.rows.length > 0) {
      const names = await client.query<{ organization_id: string; athlete_id: string; name: string }>(
        `with expired(organization_id, athlete_id) as (select * from unnest($1::text[], $2::text[]))
         select a.organization_id, a.athlete_id, a.full_name as name
           from pilot.athletes a join expired e on e.organization_id = a.organization_id and e.athlete_id = a.athlete_id
         union all
         select gl.organization_id, gl.athlete_id, p.full_name
           from pilot.guardian_links gl
           join expired e on e.organization_id = gl.organization_id and e.athlete_id = gl.athlete_id
           join pilot.parents p on p.organization_id = gl.organization_id and p.parent_id = gl.parent_id
         union all
         select acct.organization_id, acct.athlete_id, ap.display_nickname
           from pilot.accounts acct
           join expired e on e.organization_id = acct.organization_id and e.athlete_id = acct.athlete_id
           join pilot.account_profiles ap on ap.organization_id = acct.organization_id and ap.account_id = acct.account_id
          where acct.role = 'athlete' and ap.display_nickname is not null`,
        [expiredOrgs, expiredIds],
      );
      for (const row of names.rows) {
        const key = JSON.stringify([row.organization_id, row.athlete_id]);
        knownNames.set(key, [...(knownNames.get(key) ?? []), row.name]);
      }
    }

    // Delete athletes soft-deleted more than 2 years ago: exactly the rows locked above.
    const athleteDelete = expired.rows.length === 0
      ? { rows: [] as Array<{ organization_id: string; athlete_id: string }> }
      : await client.query<{ organization_id: string; athlete_id: string }>(
        `delete from pilot.athletes ath
          using unnest($1::text[], $2::text[]) as expired(organization_id, athlete_id)
          where ath.organization_id = expired.organization_id
            and ath.athlete_id = expired.athlete_id
         returning ath.organization_id, ath.athlete_id`,
        [expiredOrgs, expiredIds],
      );
    totalDeleted += athleteDelete.rows.length;

    /* The login stops naming the athlete in the same transaction -- the same
       statement, for the same reason, as scripts/pilot-cleanup-deleted-data.mjs:
       an athlete's login outlives the purge, athlete_id has no foreign key, and
       the roster can give a purged athlete_id to a different child. Only the
       athletes this statement actually deleted, each in its own gym. An
       athlete login still live is marked deleted as well, so intake cannot
       bind it to a different child; a login that is no longer an athlete's is
       only unlinked. */
    const purgedKeys = new Set(athleteDelete.rows.map((row) => JSON.stringify([row.organization_id, row.athlete_id])));
    // Only the logins captured above, and only those whose athlete this
    // statement actually deleted: by account_id, never by re-reading the link.
    const toUnlink = linked.rows.filter((row) => purgedKeys.has(JSON.stringify([row.organization_id, row.athlete_id])));
    const athleteLogins = toUnlink.filter((row) => row.role === 'athlete').map((row) => row.account_id);
    const loginsUnlinked = toUnlink.length;
    const loginsRetired = toUnlink.filter((row) => row.role === 'athlete' && row.live).length;
    if (toUnlink.length > 0) {
      await client.query(
        `update pilot.accounts acct
            set athlete_id = null,
                deleted_at = case when acct.role = 'athlete' then coalesce(acct.deleted_at, now()) else acct.deleted_at end,
                active_flag = case when acct.role = 'athlete' then false else acct.active_flag end,
                updated_at = now()
          where acct.account_id = any($1::text[])`,
        [toUnlink.map((row) => row.account_id)],
      );
    }
    /* A login the purge retires is signed out, exactly as deleteAthleteRecord
       signs one out: a session token already issued resolves without
       re-reading active_flag, and an outstanding activation code would set a
       PIN and turn the login active again. */
    if (athleteLogins.length > 0) {
      await client.query(
        `update pilot.session_tokens
         set revoked_at = now()
         where account_id = any($1::text[]) and revoked_at is null`,
        [athleteLogins],
      );
      await supersedeOutstandingActivationCodes(client, athleteLogins);
    }

    /* The SHADOW memory corrections a purged athlete typed go with them. The
       login outlives the purge (retired above, not deleted), so the account
       foreign key's cascade never fires for it, and corrected_value is the
       child's own words. Nothing reads them for audit: they are read only
       on that account's own behalf, which a retired login no longer has.
       Same statement as scripts/pilot-cleanup-deleted-data.mjs. */
    const athleteCorrections = athleteLogins.length === 0
      ? { rowCount: 0 }
      : await client.query(
        'delete from pilot.shadow_chat_memory_corrections where account_id = any($1::text[])',
        [athleteLogins],
      );

    /* The same athlete-role logins, and each athlete's own record: one token
       per person (SHADOW_OPERATIONAL_TABLES). Same statements as the script. */
    const athleteShadow = await deleteShadowOperationalRows(client, athleteLogins);
    const purgedSubjects = athleteDelete.rows.map((row) => ({ organizationId: row.organization_id, athleteId: row.athlete_id }));
    const athleteMentions = await clearShadowProfileMentions(client, purgedSubjects);
    // One call per person, as the script makes one per savepoint, so the two
    // paths count a turn naming two purged people the same way (once each).
    const athleteAudit = { deidentified: 0, deleted: 0 };
    for (const subject of purgedSubjects) {
      const key = JSON.stringify([subject.organizationId, subject.athleteId]);
      const logins = toUnlink.filter((login) => login.role === 'athlete' && JSON.stringify([login.organization_id, login.athlete_id]) === key);
      const token = anonymousToken();
      const audit = await deidentifyShadowChatAudit(client, [{
        token,
        accountIds: logins.map((login) => login.account_id),
        subjects: [{ ...subject, token }],
        names: [...(knownNames.get(key) ?? []), ...logins.map((login) => login.login_email)],
      }]);
      athleteAudit.deidentified += audit.deidentified;
      athleteAudit.deleted += audit.deleted;
    }

    /* The guardian's own record goes first, and the account cannot be deleted
       without it. Owner decision, 2026-08-28 (D-8): "delete the parents row
       too". pilot.parents holds their name, phone and email -- the personal
       data this policy promises to remove -- and pilot.parents.account_id is a
       RESTRICTING foreign key onto pilot.accounts, so the delete below raised
       23503 for every guardian who had ever been recorded as a parent, which
       is all of them.

       guardian_links is ON DELETE CASCADE from pilot.parents, so the
       child-to-guardian links go too. pilot.waivers.parent_id is ON DELETE SET
       NULL, so the waivers SURVIVE -- purging a withdrawn family must never
       destroy the documents that authorised a minor's participation. */
    /* Cleared by hand before the delete: pilot.waivers' foreign key onto
       pilot.parents is COMPOSITE (organization_id, parent_id) and ON DELETE
       SET NULL, and Postgres nulls every column in the key -- including
       organization_id, which is NOT NULL. Deleting the guardian record without
       this fails with 23502. Same reasoning, and the same two statements, as
       scripts/pilot-cleanup-deleted-data.mjs. */
    /* The guardian's media choice is kept first, against each child: owner
       ruling, Jason 2026-10-05 ("Keep the 'no' (Recommended)"). Same statement
       and reasoning as scripts/pilot-cleanup-deleted-data.mjs; read by
       guardianConsent.ts. */
    // Read before the guardian record and its links go (SHADOW_OPERATIONAL_TABLES):
    // each guardian's names, and the children whose turns those names must leave.
    const guardians = await client.query<{ account_id: string; name: string | null; login_email: string | null }>(
      `select acct.account_id, p.full_name as name, acct.login_email
         from pilot.accounts acct
         left join pilot.parents p on p.account_id = acct.account_id
        where acct.deleted_at is not null
          and acct.deleted_at < (now() - interval '1 year')
          and acct.role = 'parent'`,
    );
    const guardianChildren = await client.query<{ account_id: string; organization_id: string; athlete_id: string }>(
      `select p.account_id, gl.organization_id, gl.athlete_id
         from pilot.guardian_links gl
         join pilot.parents p on p.organization_id = gl.organization_id and p.parent_id = gl.parent_id
        where p.account_id in (
          select account_id from pilot.accounts
           where deleted_at is not null
             and deleted_at < (now() - interval '1 year')
             and role = 'parent'
        )`,
    );
    await client.query(
      `insert into pilot.retained_media_consent_restrictions
         (organization_id, athlete_id, former_parent_key, waiver_id, retained_at)
       select distinct on (w.organization_id, w.athlete_id, w.parent_id)
              w.organization_id, w.athlete_id,
              encode(sha256(convert_to(w.parent_id, 'UTF8')), 'hex'),
              w.waiver_id, clock_timestamp()
         from pilot.waivers w
         join pilot.parents p
           on p.organization_id = w.organization_id
          and p.parent_id = w.parent_id
         join pilot.guardian_links gl
           on gl.organization_id = w.organization_id
          and gl.parent_id = w.parent_id
          and gl.athlete_id = w.athlete_id
        where p.account_id in (
                select account_id from pilot.accounts
                 where deleted_at is not null
                   and deleted_at < (now() - interval '1 year')
                   and role = 'parent'
              )
          and w.waiver_type = $1
        order by w.organization_id, w.athlete_id, w.parent_id, w.created_at desc
       on conflict (organization_id, athlete_id, former_parent_key)
       do update set waiver_id = excluded.waiver_id, retained_at = excluded.retained_at`,
      [MEDIA_CONSENT_WAIVER_TYPE],
    );
    await client.query(
      `update pilot.waivers w
          set parent_id = null
         from pilot.parents p
        where p.account_id in (
                select account_id from pilot.accounts
                 where deleted_at is not null
                   and deleted_at < (now() - interval '1 year')
                   and role = 'parent'
              )
          and w.organization_id = p.organization_id
          and w.parent_id = p.parent_id`,
    );

    await client.query(
      `delete from pilot.parents
        where account_id in (
          select account_id from pilot.accounts
           where deleted_at is not null
             and deleted_at < (now() - interval '1 year')
             and role = 'parent'
        )`,
    );

    /* The guardian's SHADOW memory corrections, deleted here rather than left
       to the account foreign key's cascade, so the audit row can count them. */
    const guardianCorrections = await client.query(
      `delete from pilot.shadow_chat_memory_corrections
        where account_id in (
          select account_id from pilot.accounts
           where deleted_at is not null
             and deleted_at < (now() - interval '1 year')
             and role = 'parent'
        )`,
    );

    /* The guardians' SHADOW rows (SHADOW_OPERATIONAL_TABLES): their own turns
       only; a turn about their child is tokened by the child's purge. Before
       the account delete, so the audit row can count them. */
    const guardianIds = [...new Set(guardians.rows.map((row) => row.account_id))];
    const guardianShadow = await deleteShadowOperationalRows(client, guardianIds);
    const guardianAudit = { deidentified: 0, deleted: 0 };
    for (const accountId of guardianIds) {
      const audit = await deidentifyShadowChatAudit(client, [{
        token: anonymousToken(),
        accountIds: [accountId],
        subjects: guardianChildren.rows
          .filter((row) => row.account_id === accountId)
          .map((row) => ({ organizationId: row.organization_id, athleteId: row.athlete_id, token: null })),
        names: guardians.rows.filter((row) => row.account_id === accountId).flatMap((row) => [row.name, row.login_email]),
      }]);
      guardianAudit.deidentified += audit.deidentified;
      guardianAudit.deleted += audit.deleted;
    }

    // Delete accounts (parents) soft-deleted more than 1 year ago
    const accountDelete = await client.query(
      `delete from pilot.accounts
       where deleted_at is not null
         and deleted_at < (now() - interval '1 year')
         and role = 'parent'
       returning account_id`,
    );
    totalDeleted += accountDelete.rows.length;

    if (totalDeleted > 0) {
      await client.query(
      `insert into pilot.audit_events (
         event_type, organization_id, entity_type, entity_id, details
       ) values (
         $1, $2, $3, $4, $5
       )`,
        [
          'data_purged',
          null,
          'retention_cleanup',
          'system',
          JSON.stringify({
            athletes_deleted: athleteDelete.rows.length,
            accounts_deleted: accountDelete.rows.length,
            athlete_logins_unlinked: loginsUnlinked,
            live_athlete_logins_retired: loginsRetired,
            shadow_memory_corrections_deleted: (athleteCorrections.rowCount ?? 0) + (guardianCorrections.rowCount ?? 0),
            shadow_profiles_deleted: athleteShadow.shadow_user_profiles + guardianShadow.shadow_user_profiles,
            shadow_jobs_deleted: athleteShadow.shadow_jobs + guardianShadow.shadow_jobs,
            shadow_rate_limit_buckets_deleted: athleteShadow.shadow_rate_limit_buckets + guardianShadow.shadow_rate_limit_buckets,
            shadow_unlock_snapshots_deleted:
              athleteShadow.shadow_feature_unlock_snapshots + guardianShadow.shadow_feature_unlock_snapshots,
            shadow_profile_mentions_cleared: athleteMentions,
            shadow_chat_audit_deidentified: athleteAudit.deidentified + guardianAudit.deidentified,
            shadow_chat_audit_deleted: athleteAudit.deleted + guardianAudit.deleted,
            total_rows_deleted: totalDeleted,
          }),
        ],
      );
    }

    return { rowsDeleted: totalDeleted };
  });
}

/**
 * Reports on deletion status for audit/compliance purposes.
 */
export async function getDeletionStatus(organizationId: string) {
  const softDeletedRecords = await query<{
    entity_type: string;
    count: string;
    oldest_deleted_at: string;
  }>(
    `select
       'athletes' as entity_type,
       count(*)::text as count,
       min(deleted_at)::text as oldest_deleted_at
     from pilot.athletes
     where deleted_at is not null and organization_id = $1
     union all
     select
       'parent_accounts' as entity_type,
       count(*)::text as count,
       min(deleted_at)::text as oldest_deleted_at
     from pilot.accounts
     where deleted_at is not null and role = 'parent' and organization_id = $1`,
    [organizationId],
  );

  const recentDeletions = await query<{
    event_id: number;
    deleted_entity: string;
    actor_name: string;
    created_at: string;
    reason: string;
  }>(
    `select
       audit_id::text as event_id,
       entity_id as deleted_entity,
       actor_account_id as actor_name,
       created_at::text as created_at,
       (details->>'reason')::text as reason
     from pilot.audit_events
     where event_type = 'data_deletion_initiated'
       and organization_id = $1
       and created_at > now() - interval '1 year'
     order by created_at desc
     limit 20`,
    [organizationId],
  );

  return {
    softDeletedRecords,
    recentDeletions,
  };
}
