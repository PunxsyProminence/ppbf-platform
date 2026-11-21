import { randomUUID } from 'node:crypto';

import type { PoolClient } from 'pg';

/* ---------------------------------------------------------------------------
 * WHAT DELETING A SHADOW CONVERSATION DOES (lane HF7).
 *
 * The rulings, Jason's words in docs/current/OWNER_DECISIONS.md:
 *   OD-2026-10-06-012  "delete any thing that personally Identifys the person
 *                      but we keep data that male the Ai and ML bette3r"
 *   OD-2026-10-06-023  Q1 "Delete theirs, keep AI replies (Recommended)";
 *                      Q2 "Keep until retention ends (Recommended)"
 *   OD-2026-10-06-027  Q14 "2 years after deletion (Recommended)"
 * They are worded for the final purge of a person; their plain principle
 * reaches a member deleting their own chat and the office clearing it on the
 * member's request (OD-2026-10-13-013; Overwatch's GO on PR #2062):
 *
 *   NOT FLAGGED: cleared now. What the member typed is deleted. SHADOW's
 *     replies are kept under a one-off anon_<uuid> token, stored nowhere
 *     else, with [name] in place of the member's own names on record, the
 *     record and ring names of the athletes that are theirs (their own
 *     record, the children their guardian record is linked to, the athlete
 *     the chat is about) and those athletes' guardians' record names
 *     (namesOnRecord says which; shadowNamePattern). Kept
 *     times are the day, not the moment. WHAT IS KEPT TAKES NEW IDS: a new
 *     conversation id and new message ids, so nothing that copied the old
 *     ones joins it -- a background reply's id is a hash of its job's id
 *     (messageIdForKey), and an escalation or an audit row may hold the
 *     conversation's. The joins from the member's own rows are cut as well:
 *     the feedback that rated a reply, the learning-loop event and
 *     effectiveness rows that copied its id, the learning loop's research
 *     row keyed by it, and the evidence claims and citations, whose keys
 *     carry the login. The chat's background jobs are deleted (a payload is
 *     the member's question or SHADOW's answer under their account; a job
 *     still running can then complete nothing). With no usable name on
 *     record nothing can be scrubbed, and the whole chat is deleted (the
 *     purge's rule for the same case).
 *
 *   FLAGGED -- a review entry (any shadow_human_review_queue row, a
 *     safeguarding one or the operational one the Library-empty notice
 *     writes; the table cannot tell them apart) points at it, or a safety
 *     escalation does (a disclosure's escalation is filed with the
 *     conversation's id even when its review entry was capped or failed,
 *     shadowDisclosure.ts): kept intact and identified (Q2, Q14). Hidden from the member
 *     like any deleted chat; the office's one-exchange read
 *     (loadHumanReviewExchange, OD-2026-10-07-009 ruling 4) keeps working.
 *     Two years after its deletion the retention script clears it the same
 *     way, on a manual APPLY only (pilot-cleanup-deleted-data.mjs,
 *     clearMemberDeletedChats; OD-2026-10-07-010: "people's records stay
 *     manual").
 *
 * THE SCRIPT HOLDS A COPY. The retention script is plain Node and cannot
 * import this file, so the same statements are written there too.
 * shadowConversationDeletion.pg.test.ts (T7) runs both on the same chat and
 * compares what they leave; shadowNamePattern.test.ts compares the two name
 * patterns. Change one, change both.
 *
 * WHAT THIS DOES NOT REACH, and so what the screens do not claim: the
 * research row a member's unanswered question was filed as (keyed by account
 * and text, not by chat); their own feedback comments and memory
 * corrections; SHADOW's remembered facts about them; evidence bundles (a
 * hash of each question, no text); the nightly database backups; the day a
 * kept reply was written. Those go at the person's own purge.
 *
 * RACES IT CANNOT CLOSE from here. The rows that flag a chat are written
 * after the exchange they are about, in their own statements: the chat
 * route writes its review rows and a disclosure's safety escalation at the
 * end of the request, after the exchange is stored (chat/route.ts); the job
 * processor stores a background answer, completes its job, then writes that
 * answer's response-safety review row (shadowJobProcessor.ts). A clear in
 * that gap -- the member deleting from another tab or device, or from the
 * same page while a background job it queued runs (the page disables Delete
 * only while its own request is in flight), or the office completing a
 * request -- clears the chat as not flagged: the words are gone before the
 * row that would have held them arrives. A review row that arrives later is
 * still kept, without the chat (queueHumanReview retries without the
 * conversation on that foreign key); an escalation is filed naming an id
 * that no longer exists; a job whose row was deleted before it completed
 * has nothing to complete, so its response-safety row is not written.
 * Closing the gap means writing those rows with the exchange, in
 * chat/route.ts and the job processor, which this lane does not change.
 * ------------------------------------------------------------------------- */

/** The title a cleared chat keeps (the old one is the first words the member typed). */
export const CLEARED_CONVERSATION_TITLE = 'Deleted conversation; de-identified.';

/**
 * A Postgres ARE pattern matching any of the names, whole and by part, on
 * word boundaries; null when nothing usable is known.
 *
 * A COPY of namePattern in scripts/pilot-cleanup-deleted-data.mjs, which
 * documents the method and its limits (a nickname never recorded, a
 * misspelling or a description is not caught; a common word that is also a
 * name part is blanked). shadowNamePattern.test.ts holds the two equal.
 */
export function shadowNamePattern(names: ReadonlyArray<string | null | undefined>, gymWide = false): string | null {
  const particles = new Set([
    'de', 'da', 'del', 'la', 'le', 'van', 'von', 'der', 'den', 'of', 'the', 'jr', 'sr', 'ii', 'iii', 'mc', 'mac',
  ]);
  const parts = new Set<string>();
  for (const name of names) {
    const whole = (name ?? '').trim();
    if (!whole) continue;
    const at = whole.indexOf('@');
    const named = at >= 0 ? whole.slice(0, at) : whole;
    const candidates = [whole, named, ...named.split(/[\s,.'’()@\-]+/)];
    for (const candidate of candidates) {
      const part = candidate.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
      if (part.length < 2) continue;
      const phrase = /[^\p{L}\p{N}]/u.test(part);
      if (gymWide && !phrase && (part.length < 3 || particles.has(part.toLowerCase()))) continue;
      parts.add(part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    }
  }
  if (parts.size === 0) return null;
  // Longest first, so "Ann Lee" is replaced before "Ann" splits it.
  return `\\m(${[...parts].sort((a, b) => b.length - a.length).join('|')})\\M`;
}

type Queryable = Pick<PoolClient, 'query'>;

/**
 * The names on record for a member in one gym, and for the people a chat of
 * theirs is likely to name: the login when it is an email (a guardian's login
 * is), the login email, the ring name and staff name on their profile, their
 * guardian record's full name, the full name on their volunteer record (a
 * volunteer's may be their only one), the name they chose for the labelling
 * station, the byline they typed on a lesson they wrote, the name they signed
 * gym notices with (the notice row has no account, so it is read from the
 * post's audit row, which records the poster); and, for every athlete that is theirs -- their
 * own athlete record for an athlete login, the children their guardian record
 * is linked to, and the athlete the chat is about -- that athlete's full
 * name, the ring names of that athlete's logins, and the full names of every
 * guardian linked to that athlete. Read in the chat's gym only. A name in
 * kept text identifies the member as surely as their own: a parent's reply
 * that names their child names them.
 */
export async function namesOnRecord(
  client: Queryable,
  input: { organizationId: string; accountId: string; athleteId: string | null },
): Promise<string[]> {
  /* THREE READS, NOT ONE JOIN. This is not an access decision -- it collects
     names to scrub, and it wants every linked child, a dormant link
     included, so it does not go through guardianAccess. The guardian links
     are read by athlete and guardian-record id, never in the same statement
     as an account (guardianAccess.test.ts keeps account-scoped guardian
     joins in one place). */
  // The labelling-station name and a lesson's byline are names the member
  // chose for themselves. Each table comes with its own migration, so each
  // is read where that has run.
  const optional = (await client.query<{ labeller: boolean; lessons: boolean }>(
    `select to_regclass('pilot.labeller_credentials') is not null as labeller,
            to_regclass('pilot.rabbit_holes') is not null as lessons`,
  )).rows[0];
  const labeller = optional?.labeller === true;
  const lessons = optional?.lessons === true;
  const own = await client.query<{ name: string | null }>(
    `select case when a.account_id like '%@%' then a.account_id end as name
       from pilot.accounts a where a.account_id = $2
     union all
     select a.login_email from pilot.accounts a where a.account_id = $2
     union all
     select p.display_nickname from pilot.account_profiles p
      where p.organization_id = $1 and p.account_id = $2
     union all
     select p.staff_display_name from pilot.account_profiles p
      where p.organization_id = $1 and p.account_id = $2
     union all
     select g.full_name from pilot.parents g
      where g.organization_id = $1 and g.account_id = $2
     union all
     select v.full_name from pilot.volunteers v
      where v.organization_id = $1 and v.account_id = $2
     union all
     select e.details->>'author_name' from pilot.audit_events e
      where e.organization_id = $1 and e.entity_type = 'announcement' and e.event_type = 'create'
        and e.actor_account_id = $2${labeller ? `
     union all
     select c.display_name from pilot.labeller_credentials c
      where c.organization_id = $1 and c.account_id = $2` : ''}${lessons ? `
     union all
     select r.author_display_name from pilot.rabbit_holes r
      where r.organization_id = $1 and r.author_account_id = $2` : ''}`,
    [input.organizationId, input.accountId],
  );
  const keys = (await client.query<{ athlete_id: string | null; parent_ids: string[] }>(
    `select (select a.athlete_id from pilot.accounts a where a.account_id = $2) as athlete_id,
            coalesce((select array_agg(g.parent_id) from pilot.parents g
                       where g.organization_id = $1 and g.account_id = $2), '{}'::text[]) as parent_ids`,
    [input.organizationId, input.accountId],
  )).rows[0];
  const athleteIds = [keys?.athlete_id, input.athleteId].filter((id): id is string => Boolean(id));
  const theirs = await client.query<{ name: string | null }>(
    `with athletes_of_theirs as (
       select unnest($2::text[]) as athlete_id
       union
       select l.athlete_id from pilot.guardian_links l
        where l.organization_id = $1 and l.parent_id = any($3::text[])
     )
     select t.full_name as name from pilot.athletes t
      where t.organization_id = $1 and t.athlete_id in (select athlete_id from athletes_of_theirs)
     union all
     select p.display_nickname from pilot.accounts a
       join pilot.account_profiles p on p.organization_id = $1 and p.account_id = a.account_id
      where a.organization_id = $1 and a.athlete_id in (select athlete_id from athletes_of_theirs)
     union all
     select g.full_name from pilot.guardian_links l
       join pilot.parents g on g.organization_id = l.organization_id and g.parent_id = l.parent_id
      where l.organization_id = $1 and l.athlete_id in (select athlete_id from athletes_of_theirs)`,
    [input.organizationId, athleteIds, keys?.parent_ids ?? []],
  );
  return [...own.rows, ...theirs.rows]
    .map((row) => row.name)
    .filter((name): name is string => Boolean(name?.trim()));
}

/**
 * Clears one conversation that is not flagged: the member's
 * messages deleted, the replies kept under a new token and new ids with
 * `pattern` scrubbed out, every join from the member's rows to a reply cut,
 * its jobs deleted. With no pattern, the conversation is deleted whole. The
 * caller has checked it is the member's, in this gym, and not flagged, and
 * holds its row lock. Returns the kept conversation's new id, or null.
 */
export async function clearConversation(
  client: Queryable,
  input: { organizationId: string; accountId: string; conversationId: string; pattern: string | null },
): Promise<string | null> {
  const { organizationId, accountId, conversationId, pattern } = input;
  const replies = (await client.query<{ message_id: string }>(
    `select message_id::text as message_id from pilot.shadow_chat_messages
      where conversation_id = $1 and organization_id = $2 and role = 'assistant'`,
    [conversationId, organizationId],
  )).rows.map((row) => row.message_id);

  if (replies.length > 0) {
    // A feedback row is the member's own and stays; only its link to the
    // reply goes. A pending review of it leaves the queue, undecided: approve
    // and reject find it through the reply by account, which no longer
    // matches (the purge does the same, F-089).
    await client.query(
      `update pilot.shadow_feedback
          set correlation_id = case when correlation_type = 'shadow_message' and correlation_id = any($2::text[])
                                    then null else correlation_id end,
              recommendation_ref = case when recommendation_ref = any($2::text[]) then null else recommendation_ref end,
              human_review_required = case when correlation_type = 'shadow_message' and correlation_id = any($2::text[])
                                           then false else human_review_required end
        where organization_id = $1
          and ((correlation_type = 'shadow_message' and correlation_id = any($2::text[]))
               or recommendation_ref = any($2::text[]))`,
      [organizationId, replies],
    );
    // Not null: emptied, as the purge empties it.
    await client.query(
      `update pilot.shadow_learning_events set message_id = ''
        where organization_id = $1 and message_id = any($2::text[])`,
      [organizationId, replies],
    );
    await client.query(
      `update pilot.shadow_recommendation_effectiveness set recommendation_id = null
        where organization_id = $1 and recommendation_id = any($2::text[])`,
      [organizationId, replies],
    );
    // The learning loop files a research row keyed by the reply's id
    // (shadowLearningLoop.ts); the row stays, unique as before.
    await client.query(
      `update pilot.shadow_research_requirements
          set source_entity_id = 'cleared-' || research_requirement_id
        where organization_id = $1
          and source_event_name = 'shadow_learning_negative_outcome'
          and source_entity_id = any($2::text[])`,
      [organizationId, replies],
    );
    await client.query(
      `delete from pilot.shadow_message_citations
        where organization_id = $1 and assistant_message_id = any($2::uuid[])`,
      [organizationId, replies],
    );
  }
  await client.query(
    `delete from pilot.shadow_evidence_claims
      where organization_id = $1 and (conversation_id = $2 or assistant_message_id = any($3::uuid[]))`,
    [organizationId, conversationId, replies],
  );
  // The chat's jobs go, whatever their state: the row's id derives a
  // background reply's old id, and its account and subject name the member.
  // A job still running finds nothing to complete or fail, so the worker's
  // answer is never stored.
  await client.query(
    `delete from pilot.shadow_jobs
      where organization_id = $1 and account_id = $2
        and (input_payload->>'conversationId' = $3 or output_payload->>'conversationId' = $3)`,
    [organizationId, accountId, conversationId],
  );
  await client.query(
    `delete from pilot.shadow_chat_messages
      where conversation_id = $1 and organization_id = $2 and role = 'user'`,
    [conversationId, organizationId],
  );

  if (pattern === null) {
    // A review entry pointing at it (the retention script's flagged case)
    // stays, under a new id, without its conversation.
    await client.query(
      `update pilot.shadow_human_review_queue
          set review_id = gen_random_uuid(),
              created_at = date_trunc('day', created_at), reviewed_at = date_trunc('day', reviewed_at)
        where conversation_id = $1 and organization_id = $2`,
      [conversationId, organizationId],
    );
    await client.query(
      `delete from pilot.shadow_chat_sessions where conversation_id = $1 and organization_id = $2`,
      [conversationId, organizationId],
    );
    return null;
  }

  // What is kept moves to a new conversation id, its messages to new ids.
  // The session is re-created rather than updated (its id is referenced),
  // naming every column; shadowConversationDeletion.pg.test.ts fails when
  // the table gains one, so a new column is decided here, not dropped.
  // Token and stamp in one statement: the table's check ties them together.
  // KEPT TIMES ARE THE DAY, NOT THE MOMENT: an exact time lines the kept rows
  // up with the member's own (their evidence bundles, the chat log, an
  // escalation). Messages keep their order by a millisecond step per message
  // within the day.
  const token = `anon_${randomUUID()}`;
  const keptId = randomUUID();
  await client.query(
    `insert into pilot.shadow_chat_sessions
       (conversation_id, organization_id, account_id, athlete_id, title, session_type,
        deleted_at, created_at, updated_at, deidentified_at, subject_deleted_at)
     select $3::uuid, organization_id, $4, case when athlete_id is null then null else $4 end, $5, session_type,
            date_trunc('day', coalesce(deleted_at, now())), date_trunc('day', created_at),
            date_trunc('day', now()), date_trunc('day', now()), null
       from pilot.shadow_chat_sessions
      where conversation_id = $1 and organization_id = $2`,
    [conversationId, organizationId, keptId, token, CLEARED_CONVERSATION_TITLE],
  );
  await client.query(
    `with ordered as (
       select message_id, row_number() over (order by created_at, message_id) as n
         from pilot.shadow_chat_messages
        where conversation_id = $1 and organization_id = $2
     )
     update pilot.shadow_chat_messages m
        set conversation_id = $3::uuid,
            message_id = gen_random_uuid(),
            account_id = $4,
            content = regexp_replace(m.content, $5, '[name]', 'gi'),
            created_at = date_trunc('day', m.created_at) + o.n * interval '1 millisecond'
       from ordered o
      where m.message_id = o.message_id and m.conversation_id = $1 and m.organization_id = $2`,
    [conversationId, organizationId, keptId, token, pattern],
  );
  // A review entry pointing at it follows it under a new id (the retention
  // script's flagged case; the caller has tokened it): the office's earlier
  // reads of it, recorded by id, join nothing that is kept.
  await client.query(
    `update pilot.shadow_human_review_queue
        set conversation_id = $3::uuid, review_id = gen_random_uuid(),
            created_at = date_trunc('day', created_at), reviewed_at = date_trunc('day', reviewed_at)
      where conversation_id = $1 and organization_id = $2`,
    [conversationId, organizationId, keptId],
  );
  await client.query(
    `delete from pilot.shadow_chat_sessions where conversation_id = $1 and organization_id = $2`,
    [conversationId, organizationId],
  );
  return keptId;
}

export interface ClearedConversations {
  /** Cleared now: de-identified, or deleted whole when nothing could be scrubbed. */
  cleared: number;
  /** Flagged (a review entry or a safety escalation points at it): hidden, kept as it is. */
  held: number;
}

/**
 * Clears a member's conversations in one gym: every one that is not held is
 * cleared now, every held one is hidden from the member and kept. Only the
 * ids given that are this member's, in this gym, and not yet de-identified
 * are touched; each is locked before anything is read from it. Runs inside
 * the caller's transaction.
 */
export async function clearMemberConversations(
  client: Queryable,
  input: { organizationId: string; accountId: string; conversationIds: readonly string[] },
): Promise<ClearedConversations> {
  if (input.conversationIds.length === 0) return { cleared: 0, held: 0 };
  const rows = (await client.query<{ conversation_id: string; athlete_id: string | null; purge_held: boolean }>(
    `select s.conversation_id, s.athlete_id, s.subject_deleted_at is not null as purge_held
       from pilot.shadow_chat_sessions s
      where s.conversation_id = any($1::uuid[])
        and s.organization_id = $2
        and s.account_id = $3
        and s.deidentified_at is null
      order by s.conversation_id
        for update`,
    [input.conversationIds, input.organizationId, input.accountId],
  )).rows;
  if (rows.length === 0) return { cleared: 0, held: 0 };

  // Read after the lock, so a review entry written meanwhile is seen. An
  // escalation's id is matched whatever its case (on a path that stores no
  // exchange the route files it as the client sent it). A session with
  // subject_deleted_at set (the column the purge's hold reads; nothing writes
  // it today) is held too.
  const flagged = new Set((await client.query<{ conversation_id: string }>(
    `select q.conversation_id::text as conversation_id
       from pilot.shadow_human_review_queue q
      where q.conversation_id = any($1::uuid[])
     union
     select lower(e.metadata->>'conversation_id')
       from pilot.safety_escalations e
      where e.organization_id = $2
        and lower(e.metadata->>'conversation_id') = any($1::text[])`,
    [rows.map((row) => row.conversation_id), input.organizationId],
  )).rows.map((row) => row.conversation_id));
  for (const row of rows) if (row.purge_held) flagged.add(row.conversation_id);

  const held = rows.filter((row) => flagged.has(row.conversation_id)).map((row) => row.conversation_id);
  if (held.length > 0) {
    await client.query(
      `update pilot.shadow_chat_sessions
          set deleted_at = coalesce(deleted_at, now()), updated_at = now()
        where conversation_id = any($1::uuid[]) and organization_id = $2 and account_id = $3`,
      [held, input.organizationId, input.accountId],
    );
  }

  const patterns = new Map<string, string | null>();
  let cleared = 0;
  for (const row of rows) {
    if (flagged.has(row.conversation_id)) continue;
    const key = row.athlete_id ?? '';
    if (!patterns.has(key)) {
      patterns.set(key, shadowNamePattern(await namesOnRecord(client, {
        organizationId: input.organizationId,
        accountId: input.accountId,
        athleteId: row.athlete_id,
      })));
    }
    await clearConversation(client, {
      organizationId: input.organizationId,
      accountId: input.accountId,
      conversationId: row.conversation_id,
      pattern: patterns.get(key) ?? null,
    });
    cleared += 1;
  }
  return { cleared, held: held.length };
}
