/*
 * A MESSAGE A GUARDIAN STARTS TO THE COACH (W4 item 4, scrub FAM-09; Jason,
 * OW27-24: "A: A message box on the Parent Hub (Recommended)").
 *
 * The store over pilot.family_thread_posts and pilot.family_thread_reads
 * (migration family-threads). A guardian opens a thread about a child linked
 * to them; the gym's staff answer under it; the guardian who opened it may
 * write again in it (Overwatch Q2 A on #2161).
 *
 * WHO, ON EVERY CALL (the guardian half, PM-1b):
 *   - A guardian reaches only children linked to them NOW, through
 *     guardianAccess.ts: the link, its end at 18 (OD-2026-10-07-008, an unknown
 *     date of birth reads as a minor, OD-2026-10-04-010) and a deleted child.
 *     The database's own guard is a second line, not this one.
 *   - A guardian reads only the threads THEY opened, and the staff replies in
 *     them. With two guardians, neither sees the other's thread or what staff
 *     wrote in it (OD-2026-10-12-024).
 *   - The athlete reads none of it.
 *
 * WHO (the staff half, PM-1c; Overwatch Q3 A): coach, organization admin and
 * admin, the people who "Post to Family", on an athlete they reach
 * (assertActorCanAccessAthlete: the whole gym, OD-2026-10-11-007). They read
 * every thread on that athlete, with the guardian's name (Q4 A), and answer.
 *
 * Nothing is sent from here (no email, no push). A guardian's post writes no
 * audit row, as a guardian's reply (familyMessageReplies.ts). A staff reply
 * writes one in its own transaction: entity family_thread_reply, shadow_mirror
 * false (the migration header, Overwatch condition 4), so no SHADOW event and
 * no telemetry. No account id leaves this module.
 */
import { randomUUID } from 'node:crypto';

import type { QueryResultRow } from 'pg';

import { assertActorCanAccessAthlete, isOrganizationAdminRole, requireRole } from './access';
import { getStaffAuthorName } from './achievements';
import { writePilotAuditEvent } from './audit';
import type { PilotRole } from './contracts';
import { query, queryOne, withTransaction } from './db';
import { accountDeletedSql } from './deletedAccountSignIn';
import { ForbiddenError, NotFoundError, ValidationError } from './errors';
import { guardianLinkEnded, guardianLinkedPredicateSql } from './guardianAccess';

export const FAMILY_THREAD_POST_MAX_LENGTH = 2000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_UTC = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;

// One sentence for a forged id, another gym's thread, another guardian's
// thread and a child no longer linked: which it was is not the caller's to learn.
const NOT_YOURS = 'Not found: that message is not on your page.';
const NOT_LINKED = 'Forbidden: parent not linked to athlete';
// The staff side's one sentence, as familyReplyReads.ts's.
const NOT_HERE = 'Not found: that message is not in your gym.';
const NO_SEAT = 'Forbidden: no active staff seat in this gym.';

/** Who reads and answers family threads: the people who "Post to Family" (Q3 A). */
export const FAMILY_THREAD_STAFF_ROLES: PilotRole[] = ['coach', 'organization_admin', 'admin'];

/** A staff member, from the session. */
export interface FamilyThreadStaff {
  organizationId: string;
  accountId: string;
  role: PilotRole;
}

/** One post in a thread, as the guardian who opened it sees it. */
export interface GuardianThreadPost {
  post_id: string;
  /** 'you' for the guardian's own words, 'staff' for the gym's reply. */
  from: 'you' | 'staff';
  /** The staff member's name; null for the guardian's own post, or a staff account since removed. */
  staff_name: string | null;
  text: string;
  created_at: string;
  /** A staff post this guardian has not yet been recorded as seeing. Always false for their own. */
  new_to_me: boolean;
}

export interface GuardianThread {
  thread_id: string;
  athlete_id: string;
  created_at: string;
  posts: GuardianThreadPost[];
}

/** One post in a thread, as the gym's staff see it. */
export interface StaffThreadPost {
  post_id: string;
  /** 'guardian' for the guardian who opened the thread, 'staff' for the gym. */
  from: 'guardian' | 'staff';
  /** The staff member's name; null for the guardian's post (see guardian_name), or a staff account since removed. */
  staff_name: string | null;
  text: string;
  created_at: string;
  /** A guardian post this staff member has not yet been recorded as seeing. Always false for a staff post. */
  new_to_me: boolean;
}

export interface StaffThread {
  thread_id: string;
  athlete_id: string;
  created_at: string;
  /** The opener's name from their parent record (Q4 A); "A guardian" once it cannot be found. */
  guardian_name: string;
  posts: StaffThreadPost[];
}

function cleanText(raw: unknown): string {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!text) throw new ValidationError('Write a message before sending.');
  // PostgreSQL text cannot hold a NUL character; refuse it here rather than fail the write.
  if (text.includes('\u0000')) throw new ValidationError('A message cannot contain a NUL character.');
  if (text.length > FAMILY_THREAD_POST_MAX_LENGTH) {
    throw new ValidationError(`A message is at most ${FAMILY_THREAD_POST_MAX_LENGTH} characters.`);
  }
  return text;
}

/** The database's guard refused the write by one of these names: a link or seat ended as it was made. */
function refusedByGuard(error: unknown, constraints: string[]): boolean {
  const constraint = (error as { constraint?: unknown }).constraint;
  return typeof constraint === 'string' && constraints.includes(constraint);
}

/**
 * A guardian's write and the check that allows it, as ONE statement (Codex P2 on #2179, after
 * the read in listOwnFamilyThreads). `sql` writes only from a row that holds the guardian's whole
 * standing (guardianLinkedPredicateSql) and the child's live record in the statement's own
 * snapshot, and returns that child's date of birth from the same snapshot. The age is
 * guardianAccess's one rule (guardianLinkEnded) on that date of birth; an adult child throws, and
 * the transaction takes the write back. There is no earlier check to go stale: a change committed
 * before the statement starts is seen by it; one committed after its snapshot (or still
 * uncommitted then) does not block it, and the write counts as made before that change.
 */
async function writeWhileLinked<T extends QueryResultRow & { athlete_dob: string | null }>(
  sql: string,
  params: unknown[],
  refusal: () => Error,
): Promise<T> {
  return withTransaction(async (client) => {
    const { rows } = await client.query<T>(sql, params);
    const row = rows[0];
    // No row: not linked now, another gym, a deleted or unknown child, or not this guardian's thread.
    if (!row || guardianLinkEnded(row.athlete_dob, new Date())) throw refusal();
    return row;
  });
}

type WrittenPost = { post_id: string; thread_id: string; created_at: string; athlete_dob: string | null };

// The guardian's post, written only from the one row of `eligible`: $1 gym, $2 post id, $3 thread
// id, $4 the guardian's account, $5 the text.
const WRITE_POST_FROM_ELIGIBLE = `written as (
       insert into pilot.family_thread_posts
         (organization_id, post_id, thread_id, athlete_id, author_account_id, author_role, post_text)
       select $1, $2::uuid, $3::uuid, e.athlete_id, $4, 'parent', $5 from eligible e
       returning post_id::text as post_id, thread_id::text as thread_id,
                 to_char(created_at at time zone 'UTC', ${ISO_UTC}) as created_at
     )
     select w.post_id, w.thread_id, w.created_at, e.athlete_dob from written w cross join eligible e`;

/** A guardian opens a thread about a child linked to them on this request. */
export async function startFamilyThread(input: {
  organizationId: string;
  accountId: string;
  athleteId: string;
  text: unknown;
}): Promise<{ thread_id: string; post_id: string; created_at: string }> {
  const text = cleanText(input.text);
  const id = randomUUID();
  try {
    const row = await writeWhileLinked<WrittenPost>(
      `with eligible as (
         select a.athlete_id, to_char(a.dob, 'YYYY-MM-DD') as athlete_dob
           from pilot.athletes a
          where a.organization_id = $1 and a.athlete_id = $6 and a.deleted_at is null
            and ${guardianLinkedPredicateSql('a.organization_id', 'a.athlete_id', '$4')}
       ), ${WRITE_POST_FROM_ELIGIBLE}`,
      [input.organizationId, id, id, input.accountId, text, input.athleteId],
      () => new ForbiddenError(NOT_LINKED),
    );
    return { thread_id: row.thread_id, post_id: row.post_id, created_at: row.created_at };
  } catch (error) {
    if (refusedByGuard(error, ['pilot_family_thread_posts_guardian_of_child'])) throw new ForbiddenError(NOT_LINKED);
    throw error;
  }
}

/**
 * The guardian who opened a thread writes again in it (Q2 A), while the child
 * is still linked to them. Anyone else's thread, or an ended link, is NOT_YOURS.
 */
export async function writeAgainInFamilyThread(input: {
  organizationId: string;
  accountId: string;
  threadId: string;
  text: unknown;
}): Promise<{ thread_id: string; post_id: string; created_at: string }> {
  const text = cleanText(input.text);
  if (!UUID.test(input.threadId)) throw new NotFoundError(NOT_YOURS);
  try {
    const row = await writeWhileLinked<WrittenPost>(
      `with eligible as (
         select o.athlete_id, to_char(a.dob, 'YYYY-MM-DD') as athlete_dob
           from pilot.family_thread_posts o
           join pilot.athletes a
             on a.organization_id = o.organization_id and a.athlete_id = o.athlete_id and a.deleted_at is null
          where o.organization_id = $1 and o.post_id = $3::uuid and o.thread_id = $3::uuid
            and o.author_account_id = $4
            and ${guardianLinkedPredicateSql('o.organization_id', 'o.athlete_id', '$4')}
       ), ${WRITE_POST_FROM_ELIGIBLE}`,
      [input.organizationId, randomUUID(), input.threadId, input.accountId, text],
      () => new NotFoundError(NOT_YOURS),
    );
    return { thread_id: row.thread_id, post_id: row.post_id, created_at: row.created_at };
  } catch (error) {
    if (refusedByGuard(error, ['pilot_family_thread_posts_guardian_of_child', 'pilot_family_thread_posts_own_thread'])) {
      throw new NotFoundError(NOT_YOURS);
    }
    throw error;
  }
}

/**
 * The threads this guardian opened, about children linked to them now, each
 * with every post in it oldest first. Newest thread first.
 *
 * ONE STATEMENT (Codex P2 and Overwatch on #2179): the link, the child's
 * existence and the child's date of birth are read in the same statement as
 * the posts, so a link that ends, a child deleted or a date of birth corrected
 * to an adult's between two reads cannot leave a stale scope that still
 * returns the thread. The age itself is guardianAccess's one rule
 * (guardianLinkEnded), applied to the date of birth read with the rows.
 */
export async function listOwnFamilyThreads(organizationId: string, accountId: string): Promise<GuardianThread[]> {
  const rows = await query<{
    thread_id: string;
    athlete_id: string;
    athlete_dob: string | null;
    thread_created_at: string;
    post_id: string;
    author_role: string;
    author_account_id: string | null;
    post_text: string;
    created_at: string;
    seen: boolean;
  }>(
    `select o.post_id::text as thread_id, o.athlete_id,
            to_char(a.dob, 'YYYY-MM-DD') as athlete_dob,
            to_char(o.created_at at time zone 'UTC', ${ISO_UTC}) as thread_created_at,
            p.post_id::text as post_id, p.author_role,
            case when p.author_role = 'parent' then null else p.author_account_id end as author_account_id,
            p.post_text,
            to_char(p.created_at at time zone 'UTC', ${ISO_UTC}) as created_at,
            exists (select 1 from pilot.family_thread_reads r
                     where r.organization_id = p.organization_id and r.post_id = p.post_id
                       and r.reader_account_id = $2) as seen
       from pilot.family_thread_posts o
       join pilot.athletes a
         on a.organization_id = o.organization_id and a.athlete_id = o.athlete_id and a.deleted_at is null
       join pilot.family_thread_posts p
         on p.organization_id = o.organization_id and p.thread_id = o.post_id
      where o.organization_id = $1
        and o.post_id = o.thread_id
        and o.author_account_id = $2
        and ${guardianLinkedPredicateSql('o.organization_id', 'o.athlete_id', '$2')}
      order by o.created_at desc, o.post_id, p.created_at asc, p.post_id asc`,
    [organizationId, accountId],
  );

  const staffNames = new Map<string, string>();
  const threads = new Map<string, GuardianThread>();
  // One clock for the whole list: a thread is never cut short at midnight on an 18th birthday.
  const now = new Date();
  for (const row of rows) {
    // An adult child's thread drops out, as guardianAthleteIds drops the child (OD-2026-10-07-008).
    if (guardianLinkEnded(row.athlete_dob, now)) continue;
    let thread = threads.get(row.thread_id);
    if (!thread) {
      thread = { thread_id: row.thread_id, athlete_id: row.athlete_id, created_at: row.thread_created_at, posts: [] };
      threads.set(row.thread_id, thread);
    }
    const fromStaff = row.author_role !== 'parent';
    let staffName: string | null = null;
    if (fromStaff && row.author_account_id) {
      const key = `${row.author_role}:${row.author_account_id}`;
      if (!staffNames.has(key)) {
        staffNames.set(key, await getStaffAuthorName(organizationId, row.author_account_id, row.author_role));
      }
      staffName = staffNames.get(key) ?? null;
    }
    thread.posts.push({
      post_id: row.post_id,
      from: fromStaff ? 'staff' : 'you',
      staff_name: staffName,
      text: row.post_text,
      created_at: row.created_at,
      new_to_me: fromStaff && !row.seen,
    });
  }
  return [...threads.values()];
}

/**
 * Record that the guardian who opened a thread has seen a staff post in it.
 * A second look is the same row, and the first time stays.
 */
export async function recordFamilyThreadReadByGuardian(input: {
  organizationId: string;
  accountId: string;
  postId: string;
}): Promise<{ post_id: string }> {
  if (!UUID.test(input.postId)) throw new NotFoundError(NOT_YOURS);
  try {
    // The read is recorded in the same statement that checks it (writeWhileLinked); a second look
    // finds the row already there, and the first time stays.
    await writeWhileLinked<{ athlete_dob: string | null }>(
      `with eligible as (
         select p.post_id, to_char(a.dob, 'YYYY-MM-DD') as athlete_dob
           from pilot.family_thread_posts p
           join pilot.family_thread_posts o
             on o.organization_id = p.organization_id and o.post_id = p.thread_id
           join pilot.athletes a
             on a.organization_id = p.organization_id and a.athlete_id = p.athlete_id and a.deleted_at is null
          where p.organization_id = $1 and p.post_id = $2::uuid
            and p.author_role <> 'parent' and o.author_account_id = $3
            and ${guardianLinkedPredicateSql('p.organization_id', 'p.athlete_id', '$3')}
       ), recorded as (
         insert into pilot.family_thread_reads (organization_id, post_id, reader_account_id, reader_role)
         select $1, e.post_id, $3, 'parent' from eligible e
         on conflict (organization_id, post_id, reader_account_id) do nothing
       )
       select e.athlete_dob from eligible e`,
      [input.organizationId, input.postId, input.accountId],
      () => new NotFoundError(NOT_YOURS),
    );
  } catch (error) {
    if (refusedByGuard(error, ['pilot_family_thread_reads_guardian_of_child', 'pilot_family_thread_reads_guardian_own_thread'])) {
      throw new NotFoundError(NOT_YOURS);
    }
    throw error;
  }
  return { post_id: input.postId };
}

/**
 * A staff member's seat, as a predicate inside the statement that reads or writes (Overwatch on
 * #2179: every check-then-write path checks in the write itself). It is what the session gate
 * (auth.ts resolvePrincipal + requireRole) read before the route called the store: an active
 * membership in this gym with this role, the account active and not deleted (accountDeletedSql,
 * the session's own rule), and the gym active (a platform owner's session is not refused for the
 * gym's status, as at the gate). The athlete half of the reach (a live athlete in this gym, the
 * rule assertActorCanAccessAthlete applies to a coach or an admin) is the caller's join, after
 * the named gate itself (reachOrNotHere). The arguments are written in code, never input: an
 * alias.column reference (no alias of s followed only by letters, the shape of the predicate's own
 * sm, sc, sy) and $n placeholders; anything else throws.
 */
const SEAT_COLUMN = /^(?!s[a-z]*\.)[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$/;
function staffSeatSql(organizationColumn: string, accountParam: string, roleParam: string): string {
  if (!SEAT_COLUMN.test(organizationColumn) || !/^\$\d+$/.test(accountParam) || !/^\$\d+$/.test(roleParam)) {
    throw new Error('staffSeatSql takes an alias.column reference and $n placeholders');
  }
  return `exists (select 1
                    from pilot.organization_memberships sm
                    join pilot.accounts sc
                      on sc.account_id = sm.account_id and sc.active_flag and not ${accountDeletedSql('sc')}
                    join pilot.organizations sy
                      on sy.organization_id = sm.organization_id and (sy.status = 'active' or sc.is_platform_owner)
                   where sm.organization_id = ${organizationColumn} and sm.account_id = ${accountParam}
                     and sm.role = ${roleParam} and sm.active_flag)`;
}

/**
 * The athlete gate the plan names for the staff routes (Q3 A on #2161: requireRole plus
 * assertActorCanAccessAthlete, as "Post to Family"), on the athlete of the thread or post the
 * caller named, with a refusal turned into the staff side's one 404. The statement that writes
 * then checks the athlete's live record in this gym and the seat again itself, so neither can end
 * between this gate and the write (Overwatch on #2179). The lookup is not the check.
 */
async function reachOrNotHere(staff: FamilyThreadStaff, athleteId: string | undefined): Promise<void> {
  if (!athleteId) throw new NotFoundError(NOT_HERE);
  try {
    await assertActorCanAccessAthlete({ ...staff, athleteId: null }, athleteId);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Forbidden')) throw new NotFoundError(NOT_HERE);
    throw error;
  }
}

// The opener's name for staff (Q4 A), as listRepliesForStaff finds it: their parent record linked to
// this child in this gym, else any record of theirs in this gym. Subject-scoped (by the thread's child
// and author), never by the reader; a literal of its own, apart from the reader's own reads below,
// because guardianAccess.test.ts's sweep reads one SQL literal at a time.
const OPENER_NAME_SQL = `coalesce(
              (select min(pa.full_name)
                 from pilot.parents pa
                 join pilot.guardian_links gl
                   on gl.organization_id = pa.organization_id and gl.parent_id = pa.parent_id
                  and gl.athlete_id = o.athlete_id
                where pa.organization_id = o.organization_id and pa.account_id = o.author_account_id),
              (select min(pa.full_name)
                 from pilot.parents pa
                where pa.organization_id = o.organization_id and pa.account_id = o.author_account_id)
            )`;

/**
 * Every thread on one athlete, for the gym's staff: newest first, each with
 * the opener's name and every post oldest first. Gated here too, not only in
 * the route: a staff role, and an athlete this staff member reaches (a refusal
 * keeps the gate's error). The statement that returns the posts checks the
 * athlete's live record and the staff seat again itself, so neither can end
 * between the gate and the read (Overwatch on #2179).
 */
export async function listFamilyThreadsForStaff(staff: FamilyThreadStaff, athleteId: string): Promise<StaffThread[]> {
  requireRole({ ...staff, athleteId: null }, FAMILY_THREAD_STAFF_ROLES);
  await assertActorCanAccessAthlete({ ...staff, athleteId: null }, athleteId);
  const rows = await query<{
    thread_id: string;
    athlete_id: string;
    thread_created_at: string;
    guardian_name: string | null;
    post_id: string;
    author_role: string;
    author_account_id: string | null;
    post_text: string;
    created_at: string;
    seen: boolean;
  }>(
    `select o.post_id::text as thread_id, o.athlete_id,
            to_char(o.created_at at time zone 'UTC', ${ISO_UTC}) as thread_created_at,
            ${OPENER_NAME_SQL} as guardian_name,
            p.post_id::text as post_id, p.author_role,
            case when p.author_role = 'parent' then null else p.author_account_id end as author_account_id,
            p.post_text,
            to_char(p.created_at at time zone 'UTC', ${ISO_UTC}) as created_at,
            exists (select 1 from pilot.family_thread_reads r
                     where r.organization_id = p.organization_id and r.post_id = p.post_id
                       and r.reader_account_id = $3) as seen
       from pilot.family_thread_posts o
       join pilot.athletes a
         on a.organization_id = o.organization_id and a.athlete_id = o.athlete_id and a.deleted_at is null
       join pilot.family_thread_posts p
         on p.organization_id = o.organization_id and p.thread_id = o.post_id
      where o.organization_id = $1
        and o.athlete_id = $2
        and o.post_id = o.thread_id
        and ${staffSeatSql('o.organization_id', '$3', '$4')}
      order by o.created_at desc, o.post_id, p.created_at asc, p.post_id asc`,
    [staff.organizationId, athleteId, staff.accountId, staff.role],
  );

  const staffNames = new Map<string, string>();
  const threads = new Map<string, StaffThread>();
  for (const row of rows) {
    let thread = threads.get(row.thread_id);
    if (!thread) {
      thread = {
        thread_id: row.thread_id,
        athlete_id: row.athlete_id,
        created_at: row.thread_created_at,
        guardian_name: row.guardian_name?.trim() || 'A guardian',
        posts: [],
      };
      threads.set(row.thread_id, thread);
    }
    const fromStaff = row.author_role !== 'parent';
    let staffName: string | null = null;
    if (fromStaff && row.author_account_id) {
      const key = `${row.author_role}:${row.author_account_id}`;
      if (!staffNames.has(key)) {
        staffNames.set(key, await getStaffAuthorName(staff.organizationId, row.author_account_id, row.author_role));
      }
      staffName = staffNames.get(key) ?? null;
    }
    thread.posts.push({
      post_id: row.post_id,
      from: fromStaff ? 'staff' : 'guardian',
      staff_name: staffName,
      text: row.post_text,
      created_at: row.created_at,
      new_to_me: !fromStaff && !row.seen,
    });
  }
  return [...threads.values()];
}

/**
 * A staff member answers under a thread on an athlete they reach, with its
 * audit row in the same transaction (the migration header's choice: entity
 * family_thread_reply, shadow_mirror false). A forged id, another gym's
 * thread or an athlete they cannot reach is NOT_HERE.
 */
export async function replyInFamilyThread(
  staff: FamilyThreadStaff,
  input: { threadId: string; text: unknown },
): Promise<{ thread_id: string; post_id: string; created_at: string }> {
  requireRole({ ...staff, athleteId: null }, FAMILY_THREAD_STAFF_ROLES);
  const text = cleanText(input.text);
  if (!UUID.test(input.threadId)) throw new NotFoundError(NOT_HERE);
  const opening = await queryOne<{ athlete_id: string }>(
    `select t.athlete_id from pilot.family_thread_posts t
      where t.organization_id = $1 and t.post_id = $2::uuid and t.thread_id = $2::uuid`,
    [staff.organizationId, input.threadId],
  );
  await reachOrNotHere(staff, opening?.athlete_id);

  try {
    return await withTransaction(async (client) => {
      // ONE statement checks again and writes (Overwatch on #2179): the thread in this gym, its
      // athlete live, and this staff member's seat. The reply is written only from that row; the row comes
      // back either way, so no thread is the one 404 and no seat is the seat's 403.
      const { rows } = await client.query<{
        athlete_id: string;
        seated: boolean;
        post_id: string | null;
        thread_id: string | null;
        created_at: string | null;
      }>(
        `with eligible as (
           select o.athlete_id, ${staffSeatSql('o.organization_id', '$4', '$5')} as seated
             from pilot.family_thread_posts o
             join pilot.athletes a
               on a.organization_id = o.organization_id and a.athlete_id = o.athlete_id and a.deleted_at is null
            where o.organization_id = $1 and o.post_id = $3::uuid and o.thread_id = $3::uuid
         ), written as (
           insert into pilot.family_thread_posts
             (organization_id, post_id, thread_id, athlete_id, author_account_id, author_role, post_text)
           select $1, $2::uuid, $3::uuid, e.athlete_id, $4, $5, $6 from eligible e where e.seated
           returning post_id::text as post_id, thread_id::text as thread_id,
                     to_char(created_at at time zone 'UTC', ${ISO_UTC}) as created_at
         )
         select e.athlete_id, e.seated, w.post_id, w.thread_id, w.created_at
           from eligible e left join written w on true`,
        [staff.organizationId, randomUUID(), input.threadId, staff.accountId, staff.role, text],
      );
      const row = rows[0];
      if (!row) throw new NotFoundError(NOT_HERE);
      if (!row.seated || !row.post_id || !row.thread_id || !row.created_at) throw new ForbiddenError(NO_SEAT);
      // Who and when, never the words (the post holds them).
      await writePilotAuditEvent({
        event_type: 'create',
        actor_account_id: staff.accountId,
        actor_role: staff.role,
        organization_id: staff.organizationId,
        entity_type: 'family_thread_reply',
        entity_id: row.post_id,
        details: { athlete_id: row.athlete_id, thread_id: row.thread_id },
        shadow_mirror: false,
      }, client);
      return { thread_id: row.thread_id, post_id: row.post_id, created_at: row.created_at };
    });
  } catch (error) {
    if (refusedByGuard(error, ['pilot_family_thread_posts_staff_of_this_gym'])) throw new ForbiddenError(NO_SEAT);
    // Only in a race: the thread went (its athlete deleted) between the gate above and this write.
    if (refusedByGuard(error, ['pilot_family_thread_posts_thread_fk'])) throw new NotFoundError(NOT_HERE);
    throw error;
  }
}

/**
 * Record that this staff member has seen a guardian's post on an athlete they
 * reach. A second look is the same row, and the first time stays. A staff
 * post, a forged id, another gym's post or an unreachable athlete is NOT_HERE.
 */
export async function recordFamilyThreadReadByStaff(staff: FamilyThreadStaff, postId: string): Promise<{ post_id: string }> {
  requireRole({ ...staff, athleteId: null }, FAMILY_THREAD_STAFF_ROLES);
  if (!UUID.test(postId)) throw new NotFoundError(NOT_HERE);
  const post = await queryOne<{ athlete_id: string }>(
    `select t.athlete_id from pilot.family_thread_posts t
      where t.organization_id = $1 and t.post_id = $2::uuid and t.author_role = 'parent'`,
    [staff.organizationId, postId],
  );
  await reachOrNotHere(staff, post?.athlete_id);

  try {
    // ONE statement checks again and records (Overwatch on #2179): a guardian's post in this gym, its
    // athlete live, and this staff member's seat; a second look finds the row already there.
    const row = await queryOne<{ seated: boolean }>(
      `with eligible as (
         select p.post_id, ${staffSeatSql('p.organization_id', '$3', '$4')} as seated
           from pilot.family_thread_posts p
           join pilot.athletes a
             on a.organization_id = p.organization_id and a.athlete_id = p.athlete_id and a.deleted_at is null
          where p.organization_id = $1 and p.post_id = $2::uuid and p.author_role = 'parent'
       ), recorded as (
         insert into pilot.family_thread_reads (organization_id, post_id, reader_account_id, reader_role)
         select $1, e.post_id, $3, $4 from eligible e where e.seated
         on conflict (organization_id, post_id, reader_account_id) do nothing
       )
       select e.seated from eligible e`,
      [staff.organizationId, postId, staff.accountId, staff.role],
    );
    if (!row) throw new NotFoundError(NOT_HERE);
    if (!row.seated) throw new ForbiddenError(NO_SEAT);
  } catch (error) {
    if (refusedByGuard(error, ['pilot_family_thread_reads_reader_of_this_gym'])) throw new ForbiddenError(NO_SEAT);
    // Not reached unless the lookup above is wrong, or the post went between the gate and this write.
    if (refusedByGuard(error, ['pilot_family_thread_reads_post_fk', 'pilot_family_thread_reads_staff_reads_guardian'])) {
      throw new NotFoundError(NOT_HERE);
    }
    throw error;
  }
  return { post_id: postId };
}

/**
 * How many guardian posts this staff member has not seen, per athlete (Q4.5 A:
 * the count goes up for the child's coach and active covering coaches, and for
 * organization admins and admins across the gym, as the escalation route
 * scopes; other coaches can still read). Live athletes of this gym only;
 * athletes with none are left out. The statement that counts checks the staff
 * seat itself (staffSeatSql; Overwatch on #2179), so a seat that ends after the
 * gate counts nothing. Whom the count nudges (OW27-27; not who may read, since a
 * coach reaches the whole gym, OD-2026-10-11-007, Q3 A on #2161) is decided in
 * the same statement too (COACH_NUDGE_SQL), so a child moved to another coach or
 * a cover that ends just before the count is seen by it (reviewer A on PM-2).
 */
/**
 * The coach's own athletes for the count: the child's coach, or an active covering coach. The same
 * rule as access.athleteIdsForCoach (every coach-facing aggregate's scope), written as a predicate so
 * it is read in the counting statement itself; familyThreadsStaff.pg.test.ts pins the two to the
 * same athletes. `a` is the live athlete row, $2 the staff member's account.
 */
const COACH_NUDGE_SQL = `(a.coach_id = $2
            or exists (select 1 from pilot.coach_coverage cc
                        where cc.organization_id = a.organization_id and cc.athlete_id = a.athlete_id
                          and cc.covering_coach_id = $2
                          and cc.starts_at <= now() and cc.expires_at > now()))`;

export async function countUnseenFamilyThreadPostsForStaff(
  staff: FamilyThreadStaff,
): Promise<Array<{ athlete_id: string; unseen: number }>> {
  requireRole({ ...staff, athleteId: null }, FAMILY_THREAD_STAFF_ROLES);
  return query<{ athlete_id: string; unseen: number }>(
    `select p.athlete_id, count(*)::int as unseen
       from pilot.family_thread_posts p
       join pilot.athletes a
         on a.organization_id = p.organization_id and a.athlete_id = p.athlete_id and a.deleted_at is null
      where p.organization_id = $1
        and p.author_role = 'parent'
        and ($3::boolean or ${COACH_NUDGE_SQL})
        and ${staffSeatSql('p.organization_id', '$2', '$4')}
        and not exists (select 1 from pilot.family_thread_reads r
                         where r.organization_id = p.organization_id and r.post_id = p.post_id
                           and r.reader_account_id = $2)
      group by p.athlete_id
      order by p.athlete_id`,
    [staff.organizationId, staff.accountId, isOrganizationAdminRole(staff.role), staff.role],
  );
}
