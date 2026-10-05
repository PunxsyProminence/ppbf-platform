import { withTransaction } from './db';
import { ConflictError } from './errors';
import { checkGuardianMediaConsent, type QueryExecutor } from './guardianConsent';
// The same trim-and-lowercase the consent readers use. Imported rather than
// kept as a local copy: this gate and guardianConsent.ts read the SAME
// column, and a private duplicate is how two readings of one value start
// again -- which is the defect the shared helper was extracted to end.
import { normalizeWaiverStatusText } from './waiverCompliance';

// Moved unchanged from app/api/pilot/video/[videoId]/route.ts so that the
// clip-tag routes can ask the same question the playback route asks, rather
// than a copy that drifts (videoClipTags.ts, owner decisions 2026-10-03).
// "This route" in the notes below is GET /api/pilot/video/[videoId].

/**
 * GUARDIAN CONSENT ON THE WAY *IN*, NOT ONLY ON THE WAY OUT.
 *
 * assertGuardianMediaConsent already guards every path that sends a minor's
 * media OUT -- publications/publish, admin/video-compliance,
 * shadow/video-analysis, videoScanSweep. Nothing consulted consent on the way
 * in, and this route is the read surface where that gap has teeth: it mints a
 * 60-minute SAS, which the note further down correctly calls a bearer
 * credential -- a string that fetches a minor's footage after it has left the
 * platform's authorization boundary entirely.
 *
 * WHAT THIS REFUSES, AND WHY IT IS ONLY THIS
 *
 * Two conditions, and both are a decision a guardian actually made:
 *
 *   1. status='signed' AND covers_video=false -- a guardian who used the
 *      parent console and deliberately unticked video. parent/consent's grant
 *      path reads `body.covers_video !== false`, so photo-only is an
 *      affirmative act, never a default. The column itself defaults to true
 *      and every intake-written row takes that default, so this can only ever
 *      fire on a choice somebody actually made.
 *   2. status='withdrawn' -- a guardian who granted media consent and then
 *      took it back. Owner decision 2026-08-28: withdrawal stops internal
 *      playback, not only publication. Before that decision this route served
 *      a withdrawn athlete's footage normally, and route.test.ts carried a
 *      test saying so in as many words, with the note that it was the one to
 *      change if the decision was ever taken. It was taken; that test now
 *      asserts the refusal.
 *
 * Those two are the WHOLE gate-visible status population, not a subset of it.
 * currentConsentByGuardian filters `parent_id is not null`, and the only two
 * writers of a row with parent_id set are grantMediaConsent ('signed') and
 * withdrawMediaConsent ('withdrawn') in guardianConsent.ts. 'declined' is a
 * status the schema and waiverCompliance.ts both admit, but no writer can put
 * it on a row this gate can see, so it is not handled here rather than being
 * handled speculatively.
 *
 * THE REVISIT THIS COMMENT ASKED FOR HAS HAPPENED, and the answer is that
 * nothing changes. POST /api/pilot/admin/athlete-consent is now a second
 * caller of both writers -- staff recording a signature collected on paper --
 * so those two functions are no longer reached only from the guardian's own
 * console. But it calls the SAME two functions, which emit the same two
 * literals, and it grew no status parameter precisely so that stays true. The
 * gate-visible population is unchanged. This would stop holding only if
 * intake/domain-upsert, which takes its status from the caller (held to the
 * four-value vocabulary since the waiver-status-check change), were later
 * allowed to pass parentId -- checked 2026-08-28 and re-checked when the
 * staff writer landed, across every upsertWaiver caller in apps/web.
 *
 * WHO THE REFUSAL APPLIES TO: everyone, the athlete and the guardian
 * included. That is not new reach invented for withdrawal -- the photo-only
 * refusal above has always applied to all three (route.test.ts has carried
 * 'the athlete themself is subject to the same scope refusal' and 'the linked
 * guardian is subject to the same scope refusal' since it shipped), and a
 * withdrawal that stopped coaches but not the athlete's own console would
 * leave the footage one login away from the person whose guardian just said
 * no. The escape hatch is the same one the photo-only case has: a new signed
 * consent, written by the guardian's own console, supersedes it immediately.
 *
 * WHAT WITHDRAWAL STILL CANNOT REACH, stated whole rather than in the
 * comfortable half of it (review finding, PR #820):
 *
 *   A SAS URL ALREADY MINTED. This route hands out a 60-minute bearer
 *   credential, so an already-open tab keeps playing for up to an hour after
 *   the withdrawal commits. Closing that means short-lived SAS plus re-mint,
 *   or server-side proxying.
 *
 * A REQUEST ARRIVING IN THE SAME INSTANT IS NO LONGER A SECOND GAP. The
 * consent read used to be an ordinary pooled SELECT, so a withdrawal
 * committing between that read and the mint still yielded a fresh
 * credential. The route now checks and mints inside mintUnderPlaybackConsent
 * (below): one transaction whose consent reads hold every subject athlete's
 * guardian links FOR SHARE, the row withdrawMediaConsent takes FOR UPDATE
 * before it writes (writeMediaConsentUnderLock, guardianConsent.ts). A
 * withdrawal in flight is waited for and read as withdrawn; one that starts
 * after the check waits until the mint's transaction has ended. Film Study's
 * worker does the same before persisting a proposal (#1226).
 * playbackConsentRace.pg.test.ts proves both orders on real PostgreSQL.
 *
 * WHAT THIS DELIBERATELY DOES NOT REFUSE: A MISSING CONSENT ROW.
 *
 * That is the whole reason this is shaped as a scope check rather than as a
 * call to assertGuardianMediaConsent. Missing consent is not a rare edge on
 * this platform, it is THE DEFAULT STATE OF THE ROSTER. Two writers now put a
 * row this gate can see: POST /api/pilot/parent/consent (requireRole
 * ['parent']), the guardian's own console, and POST
 * /api/pilot/admin/athlete-consent (admin, organization_admin, coach), which
 * records a signature collected on paper. Both pass parentId to upsertWaiver;
 * currentConsentByGuardian filters `parent_id is not null`.
 *
 * WHAT IS STILL INVISIBLE HERE, and it is the majority of waiver rows.
 * The laptop seeder (scripts/seed-data.ts, retired 2026-10-03, OD-2026-10-03-002 section 10), which bulk-imported
 * athletes and guardian_links, wrote no waiver row at all; both intake writers (intake/domain-upsert,
 * intake/review-action) call upsertWaiver without parentId, so an admin
 * recording "photo and media -- signed" through app/admin/consent still lands
 * a row with parent_id NULL that this gate cannot see.
 *
 * So a roster-imported athlete still reads as "consent missing" by default.
 * What changed is that it is no longer UNFIXABLE without the guardian
 * personally signing in: staff can now record the paper on their behalf. The
 * decision below is unchanged by that -- absence still plays -- because
 * absence remains the ordinary state of a roster nobody has worked through
 * yet.
 *
 * Refusing on absence would have taken every coach's footage away on the day
 * it shipped -- and taken it from the athlete's own view and their guardian's
 * too, which inverts what consent is for. It protects the subject from
 * third-party use; it is not a lock the subject applies to themself.
 *
 * public_use_allowed is not consulted here for the opposite reason -- not
 * because it is unenforceable, but because this surface is precisely the use
 * it permits. The migration defines it as "true: may be used publicly (site,
 * social, print). false: internal/gym-only", so `false` ALLOWS an assigned
 * coach opening footage inside the platform. That flag's unenforced half lives
 * on the publication path, not on this one.
 *
 * FAILURE DIRECTION ON A FAULT: this deliberately does not catch. A database
 * error propagates to jsonError and becomes a 500, exactly as
 * waiverCompliance.ts argues for its own consent lookup -- degrading it would
 * mean "we could not find out whether a guardian consented, so proceed", which
 * is the one direction a consent read must never fail in. It is for that same
 * reason NOT one of the 42P01 degrade-to-safe cases in access.ts and
 * trainingHolds.ts: those degrade toward LESS access (no coverage, no hold);
 * degrading this one would grant more.
 *
 * The refusal is a specific 409 rather than this route's usual
 * hiddenNotFound(), and that does not break the 403-vs-404 discipline above:
 * it runs only AFTER assertActorCanAccessAthlete, so it reaches only someone
 * already entitled to know the video exists -- the ordering rule
 * videoScanReview.ts states for its own state refusals. 409 matches
 * GuardianConsentMissingError's existing mapping in http.ts: a precondition on
 * a different resource than the one addressed.
 */
/**
 * pilot.waivers.status was freeform text -- no CHECK constraint, and
 * /api/pilot/intake/domain-upsert stored `asString(body.payload.status,
 * 'signed')`, which accepted any string a caller sent. pilot_waivers_status_check
 * and requireWaiverStatus refuse those on write now, but rows written before
 * them, or on a database the migration has not reached, remain. waiverCompliance.ts
 * records a waiver stored as ' Signed ' as something that ACTUALLY HAPPENED,
 * not a hypothetical, and wallDisplay.ts normalises this same column with
 * exactly this expression before testing it.
 *
 * Without this, the two comparisons below are positive matches on a raw
 * string: ' Withdrawn ' or 'WITHDRAWN' matches neither filter, both come back
 * empty, and the route mints the SAS. A safeguarding gate that fails OPEN on
 * a leading space, sitting beside checkGuardianMediaConsent's own
 * `status !== 'signed'`, which fails closed on the same data.
 */
const CONSENT_STATUSES_THIS_GATE_UNDERSTANDS = new Set(['signed', 'withdrawn']);

export async function assertConsentCoversVideo(
  organizationId: string,
  athleteId: string,
  // Inside a transaction, the read holds the guardian links FOR SHARE until
  // it ends; see checkGuardianMediaConsent.
  client?: QueryExecutor,
): Promise<void> {
  const consent = await checkGuardianMediaConsent(organizationId, athleteId, ...(client ? [client] : []));

  // Withdrawal is checked first, and the two refusals stay separate rather
  // than being folded into one "not signed for video" test, because they are
  // different facts about a guardian and the reader has to act on them
  // differently: a photo-only guardian consented and drew a line, a withdrawn
  // guardian revoked. Merging them would hand an admin one message covering
  // two situations, one of which ("ask them to consent to video") is the wrong
  // thing to say to a parent who has already said no -- the same distinction
  // competitionSafetyGates.ts's travelWaiverRefusal draws for the same reason.
  //
  // A withdrawn row also carries covers_video=false (withdrawMediaConsent
  // writes it that way), so the ordering is not cosmetic in the one-guardian
  // case; the status==='signed' test below keeps the two populations disjoint
  // regardless, and the ordering decides which message a MIXED set of
  // guardians produces. Withdrawal wins because it is the stronger statement.
  const withdrawn = consent.perGuardian.filter(
    (guardian) => normalizeWaiverStatusText(guardian.status) === 'withdrawn',
  );

  if (withdrawn.length > 0) {
    throw new ConflictError(
      `Blocked: ${withdrawn.length} of this athlete's guardians has withdrawn media consent. `
      + 'Video of this athlete cannot be played back while a withdrawal stands. That is a decision '
      + 'on file, not missing paperwork -- only a newly signed consent from that guardian restores '
      + 'playback.',
      'GUARDIAN_CONSENT_WITHDRAWN',
    );
  }

  const videoExcluded = consent.perGuardian.filter(
    (guardian) => normalizeWaiverStatusText(guardian.status) === 'signed' && guardian.coversVideo === false,
  );

  if (videoExcluded.length > 0) {
    throw new ConflictError(
      `Blocked: ${videoExcluded.length} of this athlete's guardians signed a photo-only media consent `
      + 'that does not cover video. Video of this athlete cannot be played back until that guardian '
      + 'consents to video.',
      'GUARDIAN_CONSENT_EXCLUDES_VIDEO',
    );
  }

  /*
   * A ROW THAT EXISTS AND SAYS SOMETHING THIS GATE CANNOT READ.
   *
   * Absence still plays -- that is the blast-radius decision argued at length
   * above and it is unchanged. This is the different case: a guardian HAS a
   * current photo_media row and its status is a word this gate has no
   * reading of. wallDisplay.ts draws the same line on the same column, as an
   * allow-list and not a deny-list, "an unrecognised status is a refusal",
   * and for the same reason: you cannot conclude a guardian consented to
   * video from a word you do not understand, and guessing is the one
   * direction a consent read must never fail in.
   *
   * A NO-OP AGAINST EVERY CURRENT WRITER, and that is checkable rather than
   * hopeful: currentConsentByGuardian filters `parent_id is not null`, and
   * the only writers that set parent_id are grantMediaConsent ('signed') and
   * withdrawMediaConsent ('withdrawn'), both literals. The two intake writers
   * accept arbitrary strings but pass no parentId, so their rows are
   * invisible here.
   *
   * THE ADMIN-SIDE WRITER THIS ANTICIPATED HAS SINCE LANDED, and it did not
   * make this branch live: POST /api/pilot/admin/athlete-consent calls those
   * same two functions rather than writing a row itself, and deliberately took
   * no status parameter. The branch stays a no-op. It becomes load-bearing
   * only if a writer that passes BOTH parentId and a free-form status is ever
   * added -- which is why it is written now rather than after.
   */
  const unreadable = consent.perGuardian.filter(
    (guardian) =>
      guardian.status !== null && !CONSENT_STATUSES_THIS_GATE_UNDERSTANDS.has(normalizeWaiverStatusText(guardian.status)),
  );

  if (unreadable.length > 0) {
    throw new ConflictError(
      `Blocked: ${unreadable.length} of this athlete's guardians has a media consent recorded with a `
      + 'status this platform cannot read, so whether they consented to video cannot be determined. '
      + 'Video of this athlete cannot be played back until that record is corrected.',
      'GUARDIAN_CONSENT_UNREADABLE',
    );
  }
}

/*
 * CHECK AND MINT AS ONE TRANSACTION. Every athlete the footage shows is
 * checked with assertConsentCoversVideo on one client, so each read holds
 * that athlete's guardian links FOR SHARE until the transaction ends, and
 * `mint` runs before it ends. withdrawMediaConsent takes FOR UPDATE on the
 * same rows before it records a withdrawal, so a withdrawal already in flight
 * is waited for and then read as withdrawn (mint never runs), and one that
 * starts after the check waits until the credential exists. A credential is
 * never minted after a withdrawal the check missed.
 *
 * ATHLETES ARE LOCKED IN ASCENDING athlete_id ORDER. A tagged clip holds
 * several athletes' guardian links at once, and two transactions taking two
 * athletes in opposite orders can deadlock (overwatch, 2026-10-05, after the
 * retention purge's guardian cascade was found to span athletes). The sort
 * is by UTF-16 code unit, which is Postgres's COLLATE "C" order, not the
 * column's default collation. Within one athlete the guardian links come in
 * whatever order checkGuardianMediaConsent reads them (#1226: no ORDER BY);
 * the shared helper from the lock-order lane replaces both when it lands.
 *
 * No athletes (unattributed team footage) means no guardian to ask and no
 * row to lock, so the mint runs without opening a transaction.
 */
export async function mintUnderPlaybackConsent<T>(
  organizationId: string,
  athleteIds: readonly string[],
  mint: () => T | Promise<T>,
): Promise<T> {
  const subjects = [...new Set(athleteIds)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (subjects.length === 0) {
    return mint();
  }
  return withTransaction(async (client) => {
    for (const athleteId of subjects) {
      await assertConsentCoversVideo(organizationId, athleteId, client);
    }
    return mint();
  });
}
