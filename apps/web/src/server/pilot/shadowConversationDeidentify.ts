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
 *   NOT FLAGGED (no safeguarding review entry points at it): cleared now.
 *     What the member typed is deleted. SHADOW's replies are kept under a
 *     one-off anon_<uuid> token, stored nowhere else, with every name on
 *     record for the member, and for the athlete the chat is about, replaced
 *     by [name] (shadowNamePattern). Every id that joins a kept reply back
 *     to the member's own rows is cut: the feedback that rated it, the
 *     learning-loop event and effectiveness rows that copied its id, the
 *     learning loop's research row keyed by it, and the evidence claims and
 *     citations, whose keys carry the login and cannot follow a token. A
 *     background job for the chat is cancelled and its payloads emptied (the
 *     input is the member's question, the output SHADOW's answer under their
 *     account). With no usable name on record nothing can be scrubbed, and
 *     the whole chat is deleted (the purge's rule for the same case).
 *
 *   FLAGGED: kept intact and identified (Q2, Q14). Hidden from the member
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
 * hash of each question, no text); the nightly database backups. Those go at
 * the person's own purge.
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
 * The names on record for a member in one gym, and for the athlete a chat is
 * about: the login when it is an email (a guardian's login is), the login
 * email, the ring name and staff name on their profile, their athlete
 * record's full name for an athlete login, their guardian record's full name
 * for a guardian; and the subject athlete's full name and the ring names of
 * that athlete's logins. Read in the chat's gym only.
 */
export async function namesOnRecord(
  client: Queryable,
  input: { organizationId: string; accountId: string; athleteId: string | null },
): Promise<string[]> {
  const rows = await client.query<{ name: string | null }>(
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
     select t.full_name from pilot.accounts a
       join pilot.athletes t on t.organization_id = $1 and t.athlete_id = a.athlete_id
      where a.account_id = $2
     union all
     select g.full_name from pilot.parents g
      where g.organization_id = $1 and g.account_id = $2
     union all
     select t.full_name from pilot.athletes t
      where $3::text is not null and t.organization_id = $1 and t.athlete_id = $3
     union all
     select p.display_nickname from pilot.accounts a
       join pilot.account_profiles p on p.organization_id = $1 and p.account_id = a.account_id
      where $3::text is not null and a.athlete_id = $3 and a.organization_id = $1`,
    [input.organizationId, input.accountId, input.athleteId],
  );
  return rows.rows.map((row) => row.name).filter((name): name is string => Boolean(name?.trim()));
}

/**
 * Clears one conversation that is not held for safeguarding: the member's
 * messages deleted, the replies kept under a new token with `pattern`
 * scrubbed out, every join from the member's rows to a reply cut. With no
 * pattern, the conversation is deleted whole. The caller has checked it is
 * the member's, in this gym, and not flagged, and holds its row lock.
 */
export async function clearConversation(
  client: Queryable,
  input: { organizationId: string; accountId: string; conversationId: string; pattern: string | null },
): Promise<'deidentified' | 'deleted'> {
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
  // A queued question for this chat is cancelled; any job for it, whatever
  // its state, loses its payloads. A running job finds the chat gone when it
  // tries to append, and fails.
  await client.query(
    `update pilot.shadow_jobs
        set input_payload = '{}'::jsonb,
            output_payload = null,
            safety_status = case when status = 'pending' then 'not_applicable' else safety_status end,
            lease_token = case when status = 'pending' then null else lease_token end,
            lease_expires_at = case when status = 'pending' then null else lease_expires_at end,
            completed_at = case when status = 'pending' then now() else completed_at end,
            status = case when status = 'pending' then 'cancelled' else status end,
            updated_at = now()
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
    await client.query(
      `delete from pilot.shadow_chat_sessions where conversation_id = $1 and organization_id = $2`,
      [conversationId, organizationId],
    );
    return 'deleted';
  }

  const token = `anon_${randomUUID()}`;
  await client.query(
    `update pilot.shadow_chat_messages
        set account_id = $3, content = regexp_replace(content, $4, '[name]', 'gi')
      where conversation_id = $1 and organization_id = $2`,
    [conversationId, organizationId, token, pattern],
  );
  // Token and stamp in one statement: the table's check ties them together.
  await client.query(
    `update pilot.shadow_chat_sessions
        set account_id = $3,
            athlete_id = case when athlete_id is null then null else $3 end,
            title = $4,
            deidentified_at = now(),
            deleted_at = coalesce(deleted_at, now()),
            updated_at = now()
      where conversation_id = $1 and organization_id = $2`,
    [conversationId, organizationId, token, CLEARED_CONVERSATION_TITLE],
  );
  return 'deidentified';
}

export interface ClearedConversations {
  /** Cleared now: de-identified, or deleted whole when nothing could be scrubbed. */
  cleared: number;
  /** Flagged into a safeguarding review: hidden from the member, kept as it is. */
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
  const rows = (await client.query<{ conversation_id: string; athlete_id: string | null }>(
    `select s.conversation_id, s.athlete_id
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

  // Read after the lock, so a review entry written meanwhile is seen.
  const flagged = new Set((await client.query<{ conversation_id: string }>(
    `select distinct q.conversation_id::text as conversation_id
       from pilot.shadow_human_review_queue q
      where q.conversation_id = any($1::uuid[])`,
    [rows.map((row) => row.conversation_id)],
  )).rows.map((row) => row.conversation_id));

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
