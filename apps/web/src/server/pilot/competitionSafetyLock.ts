/*
 * THE COMPETITION-SAFETY LOCK: one lock per (organization, athlete) that
 * orders a competition entry against the two things its gates read.
 *
 * Entering a child in an external competition or a wrestling league season
 * runs two refusing gates (competitionSafetyGates.ts): an active training hold
 * covering contact, and the guardian's travel waiver. The gates used to read
 * through the pool and the entry inserted afterwards in a separate call, so a
 * hold placed, or a travel consent withdrawn, that committed between the read
 * and the insert still entered the child (Codex CX-1). Moving the reads and
 * the insert into one transaction is not enough on its own: under READ
 * COMMITTED nothing stops the writer committing in between. Every party has to
 * take one lock:
 *
 *   - the entry, before its gates read, held until the entry row commits
 *     (competitionSafetyGates.ts runCompetitionEntryUnderSafetyLock);
 *   - placeTrainingHold, before it checks for an existing hold
 *     (trainingHolds.ts);
 *   - every travel-waiver write, before its insert (intake.ts upsertWaiver /
 *     upsertWaiverWithClient, and intake review-action, which takes it at the
 *     top of its promotion transaction so the order below holds there too).
 *
 * So a hold or withdrawal already in flight makes the entry wait and then
 * refuse, and an entry already in flight makes the writer wait until the entry
 * has committed. Lifting a hold does not take it: a lift only loosens the gate,
 * and an entry that read the hold before the lift committed is refused, which
 * is the safe side.
 *
 * Exclusive for everyone. The holders are writes, and there is no reader
 * population to share it: a shared mode would let two entries interleave with
 * nothing gained.
 *
 * A transaction-scoped advisory lock rather than the pilot.athletes row, for
 * the reason consentSetLock.ts gives: a row lock would block every athlete
 * edit for the length of the entry, and deleteAthleteRecord and the retention
 * purge lock that row in their own orders.
 *
 * LOCK ORDER: this lock is taken FIRST in any transaction that takes it --
 * before the athlete-login lock, the consent-set lock (consentSetLock.ts) and
 * any row lock. consentSetLock.ts and guardianConsent.ts carry the same chain.
 *
 * Released at commit or rollback; there is no unlock. It needs a transaction:
 * outside one it would be released as soon as the statement ended and order
 * nothing.
 */
export interface CompetitionSafetyLockExecutor {
  query(text: string, params?: unknown[]): Promise<unknown>;
}

/*
 * The two-int form, (class, key), with the organization id length-prefixed --
 * the same key shape consentSetLock.ts uses, with its own class, so neither
 * lock can collide with the other or with the one-bigint hashtext locks.
 */
const KEY_CLASS = 'ppbf.athlete-competition-safety';

export async function lockCompetitionSafety(
  client: CompetitionSafetyLockExecutor,
  organizationId: string,
  athleteId: string,
): Promise<void> {
  await client.query(
    `select pg_advisory_xact_lock(hashtext($1::text), hashtext(length($2::text) || ':' || $2::text || $3::text))`,
    [KEY_CLASS, organizationId, athleteId],
  );
}

/** The waiver type the competition gate reads (competitionSafetyGates.ts TRAVEL_WAIVER). */
export function isCompetitionGatedWaiverType(waiverType: string): boolean {
  return waiverType === 'travel';
}
