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
 * Nothing is sent from here (no email, no push) and nothing is written to the
 * audit trail or the SHADOW feed for a guardian's post, as for a guardian's
 * reply (familyMessageReplies.ts). No account id leaves this module.
 */
import { randomUUID } from 'node:crypto';

import { getStaffAuthorName } from './achievements';
import { query, queryOne } from './db';
import { ForbiddenError, NotFoundError, ValidationError } from './errors';
import { guardianLinkEnded, guardianLinkedPredicateSql, isGuardianLinkedToAthlete } from './guardianAccess';

export const FAMILY_THREAD_POST_MAX_LENGTH = 2000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_UTC = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;

// One sentence for a forged id, another gym's thread, another guardian's
// thread and a child no longer linked: which it was is not the caller's to learn.
const NOT_YOURS = 'Not found: that message is not on your page.';
const NOT_LINKED = 'Forbidden: parent not linked to athlete';

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

/** The database's guard refused a guardian whose link ended between our check and the write. */
function refusedByGuard(error: unknown, constraints: string[]): boolean {
  const constraint = (error as { constraint?: unknown }).constraint;
  return typeof constraint === 'string' && constraints.includes(constraint);
}

async function insertPost(values: {
  organizationId: string;
  postId: string;
  threadId: string;
  athleteId: string;
  accountId: string;
  text: string;
}): Promise<{ post_id: string; thread_id: string; created_at: string }> {
  const row = await queryOne<{ post_id: string; thread_id: string; created_at: string }>(
    `insert into pilot.family_thread_posts
       (organization_id, post_id, thread_id, athlete_id, author_account_id, author_role, post_text)
     values ($1, $2::uuid, $3::uuid, $4, $5, 'parent', $6)
     returning post_id::text as post_id, thread_id::text as thread_id,
               to_char(created_at at time zone 'UTC', ${ISO_UTC}) as created_at`,
    [values.organizationId, values.postId, values.threadId, values.athleteId, values.accountId, values.text],
  );
  if (!row) throw new Error('Unable to record the message.');
  return row;
}

/** A guardian opens a thread about a child linked to them on this request. */
export async function startFamilyThread(input: {
  organizationId: string;
  accountId: string;
  athleteId: string;
  text: unknown;
}): Promise<{ thread_id: string; post_id: string; created_at: string }> {
  const text = cleanText(input.text);
  if (!(await isGuardianLinkedToAthlete(input.organizationId, input.accountId, input.athleteId))) {
    throw new ForbiddenError(NOT_LINKED);
  }
  const id = randomUUID();
  try {
    const row = await insertPost({ ...input, postId: id, threadId: id, text });
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
  const opening = await queryOne<{ athlete_id: string }>(
    `select athlete_id from pilot.family_thread_posts
      where organization_id = $1 and post_id = $2::uuid and thread_id = $2::uuid and author_account_id = $3`,
    [input.organizationId, input.threadId, input.accountId],
  );
  if (!opening || !(await isGuardianLinkedToAthlete(input.organizationId, input.accountId, opening.athlete_id))) {
    throw new NotFoundError(NOT_YOURS);
  }
  try {
    const row = await insertPost({
      organizationId: input.organizationId,
      postId: randomUUID(),
      threadId: input.threadId,
      athleteId: opening.athlete_id,
      accountId: input.accountId,
      text,
    });
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
  for (const row of rows) {
    // An adult child's thread drops out, as guardianAthleteIds drops the child (OD-2026-10-07-008).
    if (guardianLinkEnded(row.athlete_dob)) continue;
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
  const post = await queryOne<{ athlete_id: string }>(
    `select p.athlete_id
       from pilot.family_thread_posts p
       join pilot.family_thread_posts o
         on o.organization_id = p.organization_id and o.post_id = p.thread_id
      where p.organization_id = $1 and p.post_id = $2::uuid
        and p.author_role <> 'parent' and o.author_account_id = $3`,
    [input.organizationId, input.postId, input.accountId],
  );
  if (!post || !(await isGuardianLinkedToAthlete(input.organizationId, input.accountId, post.athlete_id))) {
    throw new NotFoundError(NOT_YOURS);
  }
  try {
    await query(
      `insert into pilot.family_thread_reads (organization_id, post_id, reader_account_id, reader_role)
       values ($1, $2::uuid, $3, 'parent')
       on conflict (organization_id, post_id, reader_account_id) do nothing`,
      [input.organizationId, input.postId, input.accountId],
    );
  } catch (error) {
    if (refusedByGuard(error, ['pilot_family_thread_reads_guardian_of_child', 'pilot_family_thread_reads_guardian_own_thread'])) {
      throw new NotFoundError(NOT_YOURS);
    }
    throw error;
  }
  return { post_id: input.postId };
}
