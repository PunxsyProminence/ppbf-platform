/*
 * THE CONSENT-SET LOCK: one lock per (organization, athlete) on WHICH
 * guardians count, as opposed to what each of them decided.
 *
 * Every consent reader locks the athlete's existing pilot.guardian_links rows
 * (guardianConsent.ts lockGuardianLinksForAthlete). A row lock cannot cover a
 * row that does not exist yet, so a guardian link inserted by a concurrent
 * transaction was a phantom: the publish claim read the old set, passed, and
 * committed beside a photo-only or withdrawn guardian it never evaluated
 * (ChatGPT post-merge review of #1261). Repeating FOR SHARE on the links does
 * not close that; something every party takes, whether or not a link row
 * exists yet, does.
 *
 * SHARED for everyone who reads or writes consent (taken inside guardianConsent.ts's
 * link-lock helpers, so their callers need no change): readers do not block
 * each other. EXCLUSIVE for every pilot.guardian_links INSERT, taken just
 * before it: a link insert waits for every in-flight reader to finish, and
 * every reader that arrives after it waits for it to commit and then reads
 * the new guardian. guardianLinkLockOrderSource.test.ts fails on an insert
 * into pilot.guardian_links whose function does not take it.
 *
 * A transaction-scoped advisory lock, not a lock on the pilot.athletes row:
 * readers holding the athlete row would block every athlete edit for the
 * length of a publish, and deleteAthleteRecord and the retention purge, which
 * lock that row and the links in their own orders, would have to be
 * re-ordered around it. The advisory key touches no table.
 *
 * LOCK ORDER (guardianConsent.ts's header carries the full chain):
 *   competition-safety per-athlete lock (ppbf.athlete-competition-safety)
 *   -> this consent-set lock, athletes ascending by athlete_id in byte order
 *   -> pilot.guardian_links rows.
 * Several athletes are taken one statement at a time in a JavaScript sort,
 * which compares UTF-16 code units -- byte order for the ASCII ids in use,
 * the same order COLLATE "C" gives the link rows.
 *
 * Released at commit or rollback; there is no unlock. It needs a
 * transaction: outside one it would be released as soon as the statement
 * ended and order nothing.
 */
export interface ConsentSetLockExecutor {
  query(text: string, params?: unknown[]): Promise<unknown>;
}

export type ConsentSetLockMode = 'shared' | 'exclusive';

/*
 * The two-int form, (class, key): Postgres keeps it apart from the one-bigint
 * form the other hashtext advisory locks here use (athlete-login, content
 * import, mental skills), so a hash collision with one of those cannot make
 * two unrelated locks one. The organization id is length-prefixed so no pair
 * of ids can spell the same key.
 */
const KEY_CLASS = 'ppbf.guardian-consent-set';

export async function lockConsentSets(
  client: ConsentSetLockExecutor,
  organizationId: string,
  athleteIds: readonly string[],
  mode: ConsentSetLockMode,
): Promise<void> {
  const fn = mode === 'exclusive' ? 'pg_advisory_xact_lock' : 'pg_advisory_xact_lock_shared';
  for (const athleteId of [...new Set(athleteIds)].sort()) {
    await client.query(
      `select ${fn}(hashtext($1::text), hashtext(length($2::text) || ':' || $2::text || $3::text))`,
      [KEY_CLASS, organizationId, athleteId],
    );
  }
}

export async function lockConsentSet(
  client: ConsentSetLockExecutor,
  organizationId: string,
  athleteId: string,
  mode: ConsentSetLockMode,
): Promise<void> {
  await lockConsentSets(client, organizationId, [athleteId], mode);
}
