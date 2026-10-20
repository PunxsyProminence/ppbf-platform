#!/usr/bin/env node

/**
 * Hard-deletes soft-deleted records that have passed their retention window.
 *
 * This is the only permanently destructive job in the platform. Everything else
 * that "deletes" sets deleted_at and is recoverable; this removes rows. It is
 * also intended to run unattended on a schedule, with nobody reading the output
 * until something has already gone wrong. The guards below exist for that
 * combination.
 *
 *   TARGET GUARD    Refuses to run unless PPBF_EXPECTED_POSTGRES_HOSTNAME and
 *                   PPBF_EXPECTED_POSTGRES_DATABASE match the connection
 *                   string, the same contract every migration runner uses. An
 *                   agent shell holding a production connection string is not
 *                   hypothetical here -- see scripts/lib/postgres-write-target.mjs
 *                   for the 361 rows that got into production that way.
 *
 *   DRY RUN         Default. The job reports what it WOULD delete and exits
 *                   without deleting. Set PPBF_RETENTION_APPLY=true to make it
 *                   act. A destructive default would mean a mistyped command,
 *                   or a copy-pasted CI step, is unrecoverable.
 *
 *   ENQUIRIES ONLY  PPBF_RETENTION_APPLY_INQUIRIES=true is the second, narrower
 *                   switch, and the one the nightly schedule sets. It deletes
 *                   ONLY expired public interest-form inquiries (12 months,
 *                   oldest first, under the cap) and writes the audit row;
 *                   people's records are counted and reported exactly as a dry
 *                   run reports them, and attemptPurge is never entered. Jason,
 *                   2026-10-07 (OD-2026-10-07-010, Q2): "Nightly deletes
 *                   enquiries itself" -- the nightly run deletes public
 *                   enquiries older than 12 months on its own, with a cap per
 *                   run; people's records stay manual. When PPBF_RETENTION_APPLY
 *                   is also true the full apply already covers inquiries and
 *                   this switch changes nothing.
 *
 *   BLAST RADIUS    Refuses to proceed if the purge would remove more than
 *                   PPBF_RETENTION_MAX_ROWS rows (default 50). The windows are
 *                   two years and one year, so a correct run in a pilot this
 *                   size removes a handful of rows. Interest-form inquiries
 *                   (12 months) never trigger the refusal: they take whatever
 *                   room the families leave under the cap, oldest first, and
 *                   the rest wait for the next run (see INQUIRY_RETENTION). A run that suddenly wants
 *                   hundreds means something upstream is wrong -- a bad
 *                   deleted_at backfill, a clock problem, a cascade that fired
 *                   too widely -- and the right response is to stop and let a
 *                   human look, not to enact it.
 *
 *   ONE TRANSACTION Deletes and the audit row commit together or not at all.
 *                   The audit row is the only record that the deletion
 *                   happened; rows gone with no record of their going is the
 *                   one outcome a retention policy must never produce.
 *
 * Usage:
 *   npm run pilot:cleanup-deleted-data                     # dry run, reports counts
 *   PPBF_RETENTION_APPLY_INQUIRIES=true npm run pilot:cleanup-deleted-data   # the nightly mode
 *   PPBF_RETENTION_APPLY=true npm run pilot:cleanup-deleted-data
 */

import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';

import { assertDeclaredWriteTargetFromEnv } from './lib/postgres-write-target.mjs';

const ATHLETE_RETENTION = "interval '2 years'";
const ACCOUNT_RETENTION = "interval '1 year'";
/* Safeguarding-flagged SHADOW chats: 2 years after the person's deletion
   (Jason 2026-10-07, Q7). Holds a guardian past ACCOUNT_RETENTION; see the
   selection in main(). */
const SAFEGUARDING_CHAT_RETENTION = "interval '2 years'";
/* PUBLIC INTEREST-FORM INQUIRIES. /privacy promises everyone who sends the
   interest form: "We keep it for 12 months, then delete it, unless you join."
   Jason, 2026-10-06: "Delete all after 12 mo" -- every inquiry older than 12
   months, whatever its review state and whether or not the person joined
   (nothing links an inquiry to a member, and a member's records are not the
   inquiry). Measured from created_at, the moment it was sent; there is no
   soft-delete step, because nobody withdraws an inquiry.

   THE CAP IS SHARED, BUT INQUIRIES CANNOT TRIP IT. The form is public and
   unauthenticated, so a backlog of due inquiries can be far larger than the
   families a run removes. Counting them toward the refusal would let that
   backlog stop every family's purge, and past the 200 ceiling stop inquiry
   retention too, for good. So families are measured against the cap exactly
   as before, and inquiries are deleted oldest first into whatever room is
   left; any still due are reported as `inquiries_deferred` and go on the next
   run. Every applied run makes progress; none is refused because of them. */
const INQUIRY_RETENTION = "interval '12 months'";

const connectionString = process.env.AZURE_POSTGRES_CONNECTION_STRING;
if (!connectionString) {
  console.error(JSON.stringify({ event: 'retention.cleanup.failed', reason: 'MISSING_CONNECTION_STRING' }));
  process.exit(1);
}

// Refuses POSTGRES_TARGET_MISMATCH (and friends) before a connection is opened.
// Caught rather than thrown: this runs unattended and its output is read from a
// CI log, so every exit -- including a refusal -- has to be one structured line
// rather than a stack trace someone has to interpret.
try {
  assertDeclaredWriteTargetFromEnv(connectionString);
} catch (error) {
  console.error(JSON.stringify({
    event: 'retention.cleanup.refused',
    reason: error instanceof Error ? error.message : 'UNKNOWN_TARGET_ERROR',
  }));
  process.exit(1);
}

const apply = process.env.PPBF_RETENTION_APPLY === 'true';
// Three modes, and the two switches cannot combine into a fourth: a full apply
// already deletes inquiries, so the narrower switch adds nothing to it.
//   apply            everything due is deleted (a person typed APPLY)
//   inquiries_only   expired public inquiries are deleted; people's records
//                    are reported, never touched (the nightly schedule)
//   dry_run          nothing is deleted
const applyInquiries = !apply && process.env.PPBF_RETENTION_APPLY_INQUIRIES === 'true';
const mode = apply ? 'apply' : applyInquiries ? 'inquiries_only' : 'dry_run';
// THE BLAST-RADIUS GUARD MUST NOT BE DEFEATABLE BY THE PERSON TRIGGERING THE
// DELETION. This file's own header sells the cap as the thing that stops a
// runaway sweep -- "the right response is to stop and let a human look" -- but
// the threshold arrived as a free-text workflow input with no upper bound, from
// the same dispatch box that types APPLY. `max_rows=999999` switched the guard
// off entirely while still reading as a deliberate, guarded run in the log.
//
// A ceiling here rather than only in the workflow, because this script is also
// runnable by hand. The input can now only ever NARROW the blast radius; it can
// never widen it past what a human agreed to in review.
const MAX_ROWS_CEILING = 200;
const requestedMaxRows = Number.parseInt(process.env.PPBF_RETENTION_MAX_ROWS ?? '50', 10);
if (!Number.isFinite(requestedMaxRows) || requestedMaxRows < 0) {
  console.error(JSON.stringify({ event: 'retention.cleanup.failed', reason: 'INVALID_MAX_ROWS' }));
  process.exit(1);
}
const maxRows = Math.min(requestedMaxRows, MAX_ROWS_CEILING);
if (requestedMaxRows > MAX_ROWS_CEILING) {
  console.error(
    JSON.stringify({
      event: 'retention.cleanup.max_rows_clamped',
      requested: requestedMaxRows,
      ceiling: MAX_ROWS_CEILING,
      note: 'The dispatcher asked to widen the blast radius past the ceiling. Clamped, not honoured.',
    }),
  );
}

/* STORED FILES GO WITH THEIR ROWS. A purged athlete's video rows and portrait
   point at files in blob storage; deleting the rows alone would leave the
   footage of a child in storage with nothing left that names it. So each file
   is deleted inside the athlete's savepoint, BEFORE the transaction commits
   (Overwatch ruling, 2026-10-05, option B): if the commit then fails, what is
   left is a row pointing at a missing file, which the next run deletes
   (deleteIfExists is idempotent) -- never a file nothing points at, which no
   run would ever find again.

   NO STORAGE ACCESS, NO PURGE OF THAT ATHLETE. When files are due and the job
   has no storage account, or storage refuses it, the athlete's savepoint is
   rolled back and the refusal is recorded by name (STORAGE_CREDENTIAL_MISSING,
   STORAGE_<code>) -- in a dry run too, so the schedule warns before anyone
   applies. The rows stay, so a later run with access can still find the files.

   The account is reached with DefaultAzureCredential (the workflow's OIDC
   login), never a key. PPBF_RETENTION_BLOB_STUB_DIR swaps in a directory on
   disk for the tests, and is refused for any database that is not local. */
const VIDEO_CONTAINER = process.env.PPBF_PILOT_VIDEO_CONTAINER?.trim() || 'ppbf-pilot-video';
const PROFILE_CONTAINER = process.env.PPBF_PILOT_PROFILE_CONTAINER?.trim() || 'ppbf-pilot-profile';

class StorageRefusal extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function storageRefusalFrom(error) {
  if (error instanceof StorageRefusal) return error;
  // Every way DefaultAzureCredential says it has no identity to offer: one
  // credential unavailable, the whole chain unavailable, or a sign-in needed.
  if (error && typeof error === 'object'
    && ['CredentialUnavailableError', 'AggregateAuthenticationError', 'AuthenticationRequiredError'].includes(error.name)) {
    return new StorageRefusal('STORAGE_CREDENTIAL_MISSING');
  }
  const raw = error && typeof error === 'object' ? (error.code ?? error.statusCode ?? error.name) : undefined;
  // An identifier only: the message and details of a storage error can carry
  // the blob's path, which names an organization and a video.
  return new StorageRefusal(`STORAGE_${String(raw ?? 'ERROR').replace(/[^A-Za-z0-9_]/g, '_')}`);
}

const blobStubDir = process.env.PPBF_RETENTION_BLOB_STUB_DIR?.trim();
if (blobStubDir) {
  const target = new URL(connectionString);
  const host = target.hostname.toLowerCase();
  // pg lets ?host= override the URL's host, so a string naming localhost could
  // still connect elsewhere; any host parameter is refused outright.
  if (!['localhost', '127.0.0.1', '[::1]', '::1'].includes(host) || target.searchParams.has('host')) {
    console.error(JSON.stringify({ event: 'retention.cleanup.refused', reason: 'BLOB_STUB_NOT_LOCAL' }));
    process.exit(1);
  }
}

async function createBlobStore() {
  if (blobStubDir) {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const fileFor = (container, blobPath) => path.join(blobStubDir, container, ...blobPath.split('/'));
    return {
      async exists(container, blobPath) {
        return fs.access(fileFor(container, blobPath)).then(() => true, () => false);
      },
      async deleteIfExists(container, blobPath) {
        return fs.rm(fileFor(container, blobPath)).then(() => true, () => false);
      },
    };
  }
  const accountUrl = process.env.PPBF_RETENTION_STORAGE_ACCOUNT_URL?.trim();
  if (!accountUrl) return null;
  // An Azure blob endpoint and nothing else: the identity's storage token is
  // sent to whatever host this names.
  if (!/^https:\/\/[a-z0-9]{3,24}\.blob\.core\.(windows\.net|usgovcloudapi\.net|chinacloudapi\.cn)\/?$/.test(accountUrl)) {
    throw new StorageRefusal('STORAGE_ACCOUNT_URL_INVALID');
  }
  const { BlobServiceClient } = await import('@azure/storage-blob');
  const { DefaultAzureCredential } = await import('@azure/identity');
  const service = new BlobServiceClient(accountUrl, new DefaultAzureCredential());
  /* A MISSING CONTAINER IS A REFUSAL, NOT A MISSING FILE. A file that is not
     there counts as already gone, so a run pointed at the wrong account or
     container would otherwise report every file "missing", delete the rows
     and exit green, orphaning the real files for good. Checked once per
     container per run. */
  const confirmed = new Set();
  const containerFor = async (container) => {
    const client = service.getContainerClient(container);
    if (!confirmed.has(container)) {
      if (!(await client.exists())) throw new StorageRefusal('STORAGE_ContainerNotFound');
      confirmed.add(container);
    }
    return client;
  };
  return {
    async exists(container, blobPath) {
      return (await containerFor(container)).getBlobClient(blobPath).exists();
    },
    async deleteIfExists(container, blobPath) {
      // Snapshots too: a blob with snapshots otherwise refuses the delete, and
      // a snapshot of the footage is still the footage.
      const blob = (await containerFor(container)).getBlobClient(blobPath);
      return (await blob.deleteIfExists({ deleteSnapshots: 'include' })).succeeded;
    },
  };
}

const pool = new Pool({ connectionString });

/**
 * The constraint that refused a delete, or the SQLSTATE if Postgres named none.
 *
 * A constraint name is a schema identifier, not personal data, so it is safe in
 * a log this job writes unattended about a database of minors' records. Nothing
 * else from the error is emitted -- `detail` carries the offending key value.
 */
function blockedBy(error) {
  if (error && typeof error === 'object') {
    if (typeof error.constraint === 'string' && error.constraint) return error.constraint;
    if (typeof error.code === 'string' && error.code) return error.code;
  }
  return 'UNKNOWN';
}

/* THE PURGED PERSON'S SHADOW ROWS. Owner ruling, Jason 2026-10-06: "delete
   any thing that personally Identifys the person but we keep data that
   [makes] the Ai and ML better". An athlete's login outlives the purge
   (retired below, not deleted), so no account cascade ever fires for it, and
   three of these tables have no account foreign key at all, so a purged
   GUARDIAN's rows survived too.

   DELETED, because they are about the person and nothing aggregate reads
   them: shadow_user_profiles (SHADOW's memory of the person: remembered
   facts, notes, open questions, the athletes they discussed), shadow_jobs
   (their queued work and its payloads), shadow_rate_limit_buckets,
   shadow_feature_unlock_snapshots (write-only).

   DE-IDENTIFIED, not deleted: shadow_chat_audit, the per-turn log SHADOW's
   metrics and the archival job aggregate. One random token per purged person
   (`anon_<uuid>`, minted here and stored nowhere else)
   replaces every key that names them: user_id on their own turns, and
   athlete_id on anyone's turn about them, the same token for both, so the
   turns about one child still read as one person's. The person's own typed
   words go (Jason 2026-10-06, Q1: "Delete theirs, keep AI replies"):
   user_message is emptied on their turns. Every other text on a matched row
   -- SHADOW's reply to them, and a coach's turn about them with its reply --
   is kept with the person's name scrubbed (Jason 2026-10-07: "Scrub the
   child's name, keep"): each known name, whole and part by part, replaced by
   [name], case-insensitively, on word boundaries (namePattern). The names
   are what the records hold at the purge: the athlete's full_name, their
   ring name (account_profiles.display_nickname), their login email, and the
   full names of the guardians still linked to them; for a guardian, their
   own full_name and login email, scrubbed from their own turns and from the
   turns about each child they were linked to (a guardian is purged a year
   before the child, so the child's purge can no longer learn their name).
   The names then leave every other turn in the gym too (Jason 2026-10-07:
   "Gym-wide (Recommended)"). THE METHOD'S LIMITS: a nickname never
   recorded, a misspelling, a plural ("the Pikes") or a description ("the
   red-headed kid") is not caught; a common word that is also a name part
   ("Will", "Kid") is blanked in every turn of that gym; people purged
   before this code existed are not revisited. A person with no usable name on record cannot be
   scrubbed, so the turns of or about them are deleted instead (same ruling:
   "if a note can't be reliably scrubbed ... delete it"). */
const SHADOW_OPERATIONAL_TABLES = [
  ['shadow_user_profiles', 'shadowProfiles'],
  ['shadow_jobs', 'shadowJobs'],
  ['shadow_rate_limit_buckets', 'shadowBuckets'],
  ['shadow_feature_unlock_snapshots', 'shadowSnapshots'],
];

function anonymousToken() {
  return `anon_${randomUUID()}`;
}

/** Every SHADOW count the purge keeps, zeroed (attemptPurge adds them up per person). */
function emptyShadowCounts() {
  return {
    shadowProfiles: 0, shadowJobs: 0, shadowBuckets: 0, shadowSnapshots: 0, shadowProfileMentions: 0,
    shadowChatAudit: 0, shadowChatAuditDeleted: 0, shadowChatAuditScrubbed: 0,
    shadowFeedback: 0, shadowFeedbackClosed: 0, shadowReviewFlagNotes: 0, shadowLearningRows: 0,
    shadowLearningEvents: 0, shadowEffectiveness: 0, shadowChatMessages: 0, shadowChatSessions: 0,
    shadowEvidenceBundles: 0, shadowReviewQueue: 0, shadowDeletionRequests: 0,
    shadowFlaggedConversations: 0, shadowFlaggedMessagesDeleted: 0,
    shadowGymMessagesScrubbed: 0, shadowGymTitlesScrubbed: 0, shadowGymFeedbackScrubbed: 0,
    shadowGymFlagNotesScrubbed: 0, shadowGymResearchScrubbed: 0, shadowGymReviewSummariesScrubbed: 0,
    shadowEventsDeleted: 0, behaviourObservations: 0, shadowGymBehaviourNotesScrubbed: 0,
    shadowGymBehaviourLabelsScrubbed: 0, shadowTelemetryDeleted: 0,
  };
}

/**
 * A Postgres ARE pattern matching any of the names, whole and by part, on
 * word boundaries; null when nothing usable is known. Parts split on spaces,
 * commas, hyphens, apostrophes, periods, brackets and @ ("Mary-Kate" gives
 * "Mary" and "Kate"); an email contributes itself whole, its local part and
 * that part's pieces, never its domain ("gmail", "com" and the gym's own
 * domain are not names, and would blank every link in kept text); every candidate
 * loses its leading and trailing punctuation so a word boundary can match
 * it ("Jr." is "Jr"). Single letters are not names ("J." would scrub every
 * j), so a part must be two characters or more. Short common words that are
 * also name parts ("Will", "de") are scrubbed too: the method prefers losing
 * a word of kept text to keeping a name.
 *
 * GYM-WIDE (`gymWide`, for every OTHER note in the gym, not the person's own
 * or the ones about them): a single part shorter than three letters, or a
 * particle on its own (de, la, van, of, jr, mc ...), is not a name there --
 * blanking "of" in every note of the gym would damage the gym's own text
 * (Overwatch 2026-10-16). A full multi-part name still matches as a phrase:
 * "Maria de la Cruz" goes, "a lot of drills" keeps "of". The cost: a
 * two-letter first name ("Al", "Jo") alone is left in other people's notes.
 */
function namePattern(names, gymWide = false) {
  const particles = new Set([
    'de', 'da', 'del', 'la', 'le', 'van', 'von', 'der', 'den', 'of', 'the', 'jr', 'sr', 'ii', 'iii', 'mc', 'mac',
  ]);
  const parts = new Set();
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

async function deleteShadowOperationalRows(client, tables, accountIds) {
  const counts = { shadowProfiles: 0, shadowJobs: 0, shadowBuckets: 0, shadowSnapshots: 0 };
  if (accountIds.length === 0) return counts;
  for (const [table, key] of SHADOW_OPERATIONAL_TABLES) {
    if (!tables[key]) continue;
    const deleted = await client.query(`delete from pilot.${table} where account_id = any($1::text[])`, [accountIds]);
    counts[key] += deleted.rowCount ?? 0;
  }
  return counts;
}

/**
 * A purged athlete's id leaves every OTHER profile's list of athletes
 * discussed (a coach's memory of who they asked about): the roster can
 * reissue the id, and the new child would then read as "discussed".
 */
async function clearShadowProfileMentions(client, tables, subjects) {
  if (!tables.shadowProfiles || subjects.length === 0) return 0;
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

/**
 * `people`: one entry per purged person -- their gym, their token, the login(s) whose
 * turns are theirs, the athlete records (organization_id, athlete_id) whose
 * turns the person's names must leave, and the names. A purged athlete lists
 * their own record, tokened; a purged guardian lists the children they were
 * linked to, untokened (the child is not purged; only the guardian's name
 * leaves the turns about them). A turn is matched by its user_id or by its
 * athlete_id. Where the two name different people (a guardian's turn about
 * their child, both purged together; a sibling's), both patterns run. When
 * two people name the same login or record, their names are merged first,
 * so each turn matches once. Every SET reads the row as it was before the
 * statement.
 */
/* A PERSON'S OWN FEEDBACK NOTES ARE DE-IDENTIFIED, THE SIGNAL KEPT (gap B,
   #1600). Jason 2026-10-06: "delete any thing that personally Identifys the
   person but we keep data that [makes] the Ai and ML better"; Overwatch
   2026-10-15: de-identify rather than delete. A thumbs-down on a SHADOW answer
   is stored three times, each naming the login that gave it and holding the
   note they typed (app/api/pilot/shadow/feedback/route.ts, then
   processLearningSignal in shadowLearningLoop.ts):
   - pilot.shadow_feedback: account_id (no foreign key) and comment. The login
     becomes the person's token, the note goes; helpful, rating, outcome and
     the review fields stay.
   - pilot.shadow_library_review_flags: one row per gym and topic, naming the
     LATEST flagger and their note. When that is this person, both are
     cleared; the topic, counts and review state stay. (A guardian's account
     delete would null account_id by its foreign key, but not the note.) The
     library-change proposal re-points a flag at a later account without
     clearing the note (shadowLearningLoop.ts queueLibraryEntryChangeForHumanReview),
     so a flag whose note is one of this person's own feedback comments loses
     the note too, whoever it now names -- but ONLY a row that proposal last
     wrote (proposed_action set): the two negative-flag writers set
     proposed_action null as they write the note, and the proposal path never
     writes one, so on such a row the note is provably an earlier flagger's.
     A row the current flagger wrote keeps their note even when its words
     match this person's (Codex P2 on #1624). First, while the comments exist.
   - pilot.shadow_research_requirements filed by the learning loop
     (shadow_learning_negative_outcome): created_by_account_id becomes the
     token; knowledge_gap, which holds the note when one was typed, becomes the
     loop's own sentence for no note; metadata.note goes. The topic is the
     server's label, not typed text, and stays.
   ITS OWN TOKEN, NEVER THE CHAT AUDIT'S (Overwatch 2026-10-15, option A): one
   per person per run, so their feedback rows still read as one person's. The
   rows that join a feedback row onward (learning events and effectiveness by
   feedback_id, chat messages by correlation_id) are handled by
   deidentifyLoginShadowRows, which keeps the learning side on this same
   token and deletes the chat side, so nothing joins it to the chat audit's.

   The message id the row copied goes too (recommendation_ref; and on the
   learning loop's research row, a message id in source_entity_id, made
   unique per row): a
   flagged conversation's replies outlive the purge under another token
   (deidentifyFlaggedConversations), and the id would join the two.

   A PENDING REVIEW IS CLOSED, NOT DECIDED (F-089). Approve and reject find a
   feedback row through its own chat message by account (shadowFeedback.ts
   resolveShadowFeedbackReview), which the token no longer matches, so a row
   still awaiting review would sit in the queue for good. It leaves the
   queue (human_review_required false) with verification_state, reviewer and
   reviewed_at untouched: no staff decision is recorded, and it never reads
   as rejected or approved. Its legacy event pointer goes too (F-091): the
   event names the login as its actor, and a legacy row also carries the
   event id as its correlation_id (correlation_type 'shadow_event',
   shadowFeedback.ts). A message correlation stays: the satisfaction metric
   counts by it, and the message itself is deleted below.

   ONE GYM ON THE ATHLETE PATH (Overwatch 2026-10-15): an athlete's login can
   be active in another gym, whose feedback is not this purge's, so
   organizationId scopes all three statements there. A purged guardian's
   account itself is deleted, so that path passes null: everything it wrote. */
async function deidentifyFeedbackNotes(client, tables, accountIds, token, organizationId) {
  const counts = { shadowFeedback: 0, shadowFeedbackClosed: 0, shadowReviewFlagNotes: 0, shadowLearningRows: 0 };
  if (accountIds.length === 0) return counts;
  if (tables.reviewFlags) {
    const flags = await client.query(
      `update pilot.shadow_library_review_flags f
          set account_id = case when f.account_id = any($1::text[]) then null else f.account_id end,
              user_note = null
        where ($2::text is null or f.organization_id = $2)
          and (f.account_id = any($1::text[])
           or (f.user_note is not null and f.proposed_action is not null and ${tables.shadowFeedback
    ? `exists (select 1 from pilot.shadow_feedback fb
                       where fb.organization_id = f.organization_id
                         and fb.account_id = any($1::text[])
                         and fb.comment = f.user_note)`
    : 'false'}))`,
      [accountIds, organizationId],
    );
    counts.shadowReviewFlagNotes = flags.rowCount ?? 0;
  }
  if (tables.shadowFeedback) {
    const closed = await client.query(
      `update pilot.shadow_feedback set human_review_required = false
        where account_id = any($1::text[]) and human_review_required and ($2::text is null or organization_id = $2)`,
      [accountIds, organizationId],
    );
    counts.shadowFeedbackClosed = closed.rowCount ?? 0;
    const feedback = await client.query(
      `update pilot.shadow_feedback
          set account_id = $2, comment = null, shadow_event_id = null, recommendation_ref = null,
              correlation_id = case when correlation_type = 'shadow_event' then null else correlation_id end
        where account_id = any($1::text[]) and ($3::text is null or organization_id = $3)`,
      [accountIds, token, organizationId],
    );
    counts.shadowFeedback = feedback.rowCount ?? 0;
  }
  if (tables.researchRequirements) {
    const learning = await client.query(
      `update pilot.shadow_research_requirements
          set created_by_account_id = $2,
              source_entity_id = case
                when source_entity_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                then 'purged-' || research_requirement_id else source_entity_id end,
              knowledge_gap = 'Recent response on ''' || coalesce(nullif(metadata->>'topic', ''), 'general')
                || ''' was judged insufficient and requires evidence reinforcement.',
              metadata = metadata - 'note'
        where source_event_name = 'shadow_learning_negative_outcome'
          and created_by_account_id = any($1::text[])
          and ($3::text is null or organization_id = $3)`,
      [accountIds, token, organizationId],
    );
    counts.shadowLearningRows = learning.rowCount ?? 0;
  }
  return counts;
}

/* THE REST OF A LOGIN'S SHADOW ROWS (F-088, the deidentify-keys migration's
   "PR C"). An athlete's login is retired, not deleted, so the
   pilot.accounts trigger that follows a deleted login
   (shadow_rows_follow_account) never fires for it, and these rows kept
   naming the login after the purge. Same ruling (Jason 2026-10-06: "delete
   any thing that personally Identifys the person but we keep data that
   [makes] the Ai and ML better"), and the same holds as the trigger:
   - KEPT, re-keyed to the person's FEEDBACK token: shadow_learning_events
     and shadow_recommendation_effectiveness, the learning signal. They hang
     off a feedback row by feedback_id, so they carry that row's token;
     shadow_event_id goes (F-091, the event names the login), and so does
     the message or event id they copied (learning message_id, emptied: it
     is not null, and the unlock counter only asks that it is not null;
     effectiveness recommendation_id, nulled), so neither joins a held
     message or an event back to the login.
   - DELETED, as the trigger deletes them for a deleted login: the login's
     own chat sessions and messages (their typed words) and evidence
     bundles -- a flagged one was de-identified first
     (deidentifyFlaggedConversations) and no longer names them -- sparing a
     session still held for safeguarding
     (subject_deleted_at within two years, Q7) with its messages and the
     evidence they cite. Unlike the trigger, the hold has an end here: the
     person's purge is the last run that selects them, so a hold already
     over is not left identified for good. A message is what
     joins feedback (correlation_id) and learning events (message_id) to the
     chat side; tokening it instead would join the feedback token to the
     chat, against the rule above. SHADOW's replies stay, de-identified, in
     shadow_chat_audit (Q1, "Delete theirs, keep AI replies"), which has no
     message id. Messages first, so their claims and citations go by
     cascade before the bundles they point at.
   - DE-IDENTIFIED under the RECEIPT token (their flagged conversations
     carry it too, so an entry keeps its conversation): the person's safeguarding
     review entries, once the two-year hold is over (Jason 2026-10-07, "2
     years after deletion (Recommended)": identified until then, then
     de-identified). Token and stamp in one update, as the table's check
     requires; category, severity, status and reviewer stay; the summary
     becomes a fixed sentence and metadata goes (both may hold the person's
     words). And their deletion requests, kept as an anonymous receipt (Q4).
   The athlete path scopes everything to the purged gym; a guardian's
   account is deleted, so that path passes null: everything of theirs. Runs
   only where the migration is applied (its review-queue stamp exists):
   without it the account keys still cascade and refuse a token. */
const REVIEW_SUMMARY_AFTER_PURGE = 'Safeguarding review entry; the person was deleted and the details removed at the retention purge.';

async function deidentifyLoginShadowRows(client, tables, accountIds, feedbackToken, receiptToken, organizationId) {
  const counts = {
    shadowLearningEvents: 0, shadowEffectiveness: 0, shadowChatMessages: 0, shadowChatSessions: 0,
    shadowEvidenceBundles: 0, shadowReviewQueue: 0, shadowDeletionRequests: 0,
  };
  if (accountIds.length === 0 || !tables.deidentifyKeys) return counts;
  const run = async (sql, params) => (await client.query(sql, params)).rowCount ?? 0;
  const mine = (alias) => `${alias}.account_id = any($1::text[]) and ($2::text is null or ${alias}.organization_id = $2)`;
  const keys = [accountIds, organizationId];
  counts.shadowLearningEvents = await run(
    `update pilot.shadow_learning_events e
        set account_id = $3, shadow_event_id = null, message_id = ''
      where ${mine('e')}`,
    [...keys, feedbackToken],
  );
  counts.shadowEffectiveness = await run(
    `update pilot.shadow_recommendation_effectiveness r set account_id = $3, recommendation_id = null where ${mine('r')}`,
    [...keys, feedbackToken],
  );
  counts.shadowChatMessages = await run(
    `delete from pilot.shadow_chat_messages m
      where ${mine('m')}
        and not exists (select 1 from pilot.shadow_chat_sessions s
                         where s.conversation_id = m.conversation_id and s.subject_deleted_at >= (now() - ${SAFEGUARDING_CHAT_RETENTION}))`,
    keys,
  );
  counts.shadowChatSessions = await run(
    `delete from pilot.shadow_chat_sessions s
      where ${mine('s')} and (s.subject_deleted_at is null or s.subject_deleted_at < (now() - ${SAFEGUARDING_CHAT_RETENTION}))`,
    keys,
  );
  counts.shadowEvidenceBundles = await run(
    `delete from pilot.shadow_evidence_bundles b
      where ${mine('b')}
        and not exists (select 1 from pilot.shadow_evidence_claims c
                          join pilot.shadow_chat_sessions s on s.conversation_id = c.conversation_id
                         where c.bundle_id = b.bundle_id and c.account_id = b.account_id
                           and s.subject_deleted_at >= (now() - ${SAFEGUARDING_CHAT_RETENTION}))
        and not exists (select 1 from pilot.shadow_message_citations c
                          join pilot.shadow_chat_messages m on m.message_id = c.assistant_message_id
                          join pilot.shadow_chat_sessions s on s.conversation_id = m.conversation_id
                         where c.bundle_id = b.bundle_id and c.account_id = b.account_id
                           and s.subject_deleted_at >= (now() - ${SAFEGUARDING_CHAT_RETENTION}))`,
    keys,
  );
  counts.shadowReviewQueue = await run(
    `update pilot.shadow_human_review_queue q
        set account_id = $3, deidentified_at = now(), summary = $4, metadata = '{}'::jsonb
      where ${mine('q')}
        and (q.subject_deleted_at is null or q.subject_deleted_at < (now() - ${SAFEGUARDING_CHAT_RETENTION}))`,
    [...keys, receiptToken, REVIEW_SUMMARY_AFTER_PURGE],
  );
  counts.shadowDeletionRequests = await run(
    `update pilot.shadow_data_deletion_requests d set account_id = $3 where ${mine('d')}`,
    [...keys, receiptToken],
  );
  return counts;
}

/* A FLAGGED CONVERSATION OF THE PERSON'S IS DE-IDENTIFIED, NOT DELETED (Jason
   2026-10-07, Q14: safeguarding-flagged AI chats are "kept identified for 2
   years after deletion, then de-identified"; Overwatch 2026-10-16, option A).
   Flagged means a safeguarding review entry points at it. By the person's
   purge the hold is over (a session still held, subject_deleted_at within two
   years, is left alone). Their own messages go (Q1, "Delete theirs, keep AI
   replies"); SHADOW's replies stay with the person's known names scrubbed
   (namePattern); the session and the replies take the RECEIPT token, the one
   their review entries get in deidentifyLoginShadowRows, so an entry keeps
   its conversation; title becomes a fixed sentence (it is the first words
   they typed). The evidence the replies cited goes (its keys carry the login
   and cannot follow a token), and a feedback row that rated one of the
   replies loses its message correlation, so the feedback token does not join
   the receipt token. With no usable name on record nothing can be scrubbed,
   and the conversation is deleted with the rest. Runs before the person's
   athlete or account row goes: the triggers delete any conversation still
   naming them. */
const FLAGGED_TITLE_AFTER_PURGE = 'Safeguarding-flagged conversation; de-identified at the retention purge.';

async function deidentifyFlaggedConversations(client, tables, accountIds, organizationId, receiptToken, names) {
  const counts = { shadowFlaggedConversations: 0, shadowFlaggedMessagesDeleted: 0 };
  const pattern = namePattern(names);
  if (accountIds.length === 0 || !tables.deidentifyKeys || pattern === null) return counts;
  const flagged = (await client.query(
    `select s.conversation_id from pilot.shadow_chat_sessions s
      where s.account_id = any($1::text[]) and ($2::text is null or s.organization_id = $2)
        and (s.subject_deleted_at is null or s.subject_deleted_at < (now() - ${SAFEGUARDING_CHAT_RETENTION}))
        and exists (select 1 from pilot.shadow_human_review_queue q where q.conversation_id = s.conversation_id)
      order by s.conversation_id
        for update`,
    [accountIds, organizationId],
  )).rows.map((row) => row.conversation_id);
  if (flagged.length === 0) return counts;
  const replies = `select message_id from pilot.shadow_chat_messages where conversation_id = any($1::uuid[])`;
  await client.query(
    `update pilot.shadow_feedback set correlation_id = null
      where correlation_type = 'shadow_message' and correlation_id in (select message_id::text from (${replies}) r)`,
    [flagged],
  );
  await client.query(
    `delete from pilot.shadow_evidence_claims
      where conversation_id = any($1::uuid[]) or assistant_message_id in (${replies})`,
    [flagged],
  );
  await client.query(
    `delete from pilot.shadow_message_citations where assistant_message_id in (${replies})`,
    [flagged],
  );
  counts.shadowFlaggedMessagesDeleted = (await client.query(
    `delete from pilot.shadow_chat_messages where conversation_id = any($1::uuid[]) and role = 'user'`,
    [flagged],
  )).rowCount ?? 0;
  await client.query(
    `update pilot.shadow_chat_messages
        set account_id = $2, content = regexp_replace(content, $3, '[name]', 'gi')
      where conversation_id = any($1::uuid[])`,
    [flagged, receiptToken, pattern],
  );
  counts.shadowFlaggedConversations = (await client.query(
    `update pilot.shadow_chat_sessions
        set account_id = $2, athlete_id = case when athlete_id is null then null else $2 end,
            title = $3, deidentified_at = now(), updated_at = now()
      where conversation_id = any($1::uuid[])`,
    [flagged, receiptToken, FLAGGED_TITLE_AFTER_PURGE],
  )).rowCount ?? 0;
  return counts;
}

/* THE PERSON'S NAMES LEAVE EVERY OTHER KEPT AI CHAT NOTE IN THEIR GYM
   (F-090). Jason 2026-10-07, OD-2026-10-06-027 ruling 1 ("Gym-wide
   (Recommended)"): "their name is removed from every kept AI chat note in the
   gym, not only the notes filed under them"; Overwatch 2026-10-16 confirmed it
   reaches (a) other people's SHADOW chats (message text, conversation
   titles), (b) notes typed against a SHADOW answer (feedback comments, the
   Library review-flag note that copies one, and the research rows the
   learning loop, the question filer and the Library write: the requirement
   text, the knowledge gap, metadata note, question and closing note, and a
   staff question's key, which is its text), and (c) safeguarding review
   summaries. The
   same pattern and the same limits as the chat log's gym-wide scrub
   (namePattern; SHADOW_OPERATIONAL_TABLES): each name whole and by part,
   case-insensitively, on word boundaries, replaced by [name]; a common word
   that is also a name part is blanked too. Review metadata is not touched: no
   writer puts typed text there (chat/route.ts, shadowJobProcessor.ts). Only
   rows whose text matches are written, so each count is rows changed. */
/* THE PERSON'S ENTRIES IN SHADOW'S EVENT LOG GO (Overwatch 2026-10-16, option
   A; Jason 2026-10-06: "delete any thing that personally Identifys the person
   but we keep data that [makes] the Ai and ML better"). pilot.shadow_events is
   SHADOW's activity feed: what a person did (actor_account_id) and what a row
   is about (entity_id: their login for an 'account' row, their athlete id,
   "<athlete>:<milestone>", "<org>:<login>" for a gym membership, their
   guardian record "par-<account>" or "<parent>:<athlete>", the child's
   videos and the intake cases filed about them, by id or an upload's
   payload.intake_case_id), with payloads that hold their athlete id and typed
   text (titles, reasons, a Library question, file names). Nothing reads it for
   the AI or for metrics (shadowMetrics, unlocks); the review projection
   derives an intake case's status from its latest row, so a case whose latest
   row was the purged person's shows its earlier status. The legal record is
   pilot.audit_events, which this does not touch. De-identifying instead would
   widen who sees a row: the read model (shadowReadModels.ts) shows a row it
   cannot tie to any athlete to every role that sees unscoped rows, and a
   tokened row ties to no one. So a row that names the person -- as actor, as
   entity, or anywhere in its payload by their athlete id or login -- is
   deleted, in the purged gym (a guardian: everywhere, their account goes).
   A row tied to a conversation or review entry still held for safeguarding
   (subject_deleted_at within two years, Q7) stays: by id as its entity or
   anywhere in its payload; nothing selects the person again, so such a row
   keeps naming them after the hold (nothing writes subject_deleted_at yet).
   A row that names the child among others (several athletes in one event) is
   deleted whole: the feed is not the legal record. The two references into it (shadow_feedback,
   shadow_learning_events .shadow_event_id) are already cleared for this
   person and set null on delete. */
async function deleteShadowEvents(client, tables, { organizationId, accountIds, athleteId, parentIds, recordIds }) {
  if (!tables.shadowEvents) return 0;
  const ids = [...accountIds, ...(athleteId ? [athleteId] : [])].filter(Boolean);
  if (ids.length === 0 && parentIds.length === 0 && recordIds.length === 0) return 0;
  const held = tables.deidentifyKeys
    ? `and not exists (
         select 1 from pilot.shadow_chat_sessions s
          where s.organization_id = e.organization_id
            and s.subject_deleted_at >= (now() - ${SAFEGUARDING_CHAT_RETENTION})
            and (e.entity_id = s.conversation_id::text
              or jsonb_path_exists(e.payload, '$.** ? (@ == $id)', jsonb_build_object('id', s.conversation_id::text))))
       and not exists (
         select 1 from pilot.shadow_human_review_queue q
          where q.organization_id = e.organization_id
            and q.subject_deleted_at >= (now() - ${SAFEGUARDING_CHAT_RETENTION})
            and (e.entity_id = q.review_id::text
              or jsonb_path_exists(e.payload, '$.** ? (@ == $id)', jsonb_build_object('id', q.review_id::text))))`
    : '';
  // A guardian record id is unique only within its gym: each is matched in its own.
  const deleted = await client.query(
    `delete from pilot.shadow_events e
      where ($1::text is null or e.organization_id = $1)
        and (e.actor_account_id = any($2::text[])
          or e.entity_id = any($2::text[])
          or ($3::text is not null
            and (left(e.entity_id, length($3) + 1) = $3 || ':' or right(e.entity_id, length($3) + 1) = ':' || $3))
          or exists (select 1 from unnest($4::text[], $6::text[]) as p(organization_id, id)
                      where p.organization_id = e.organization_id
                        and (e.entity_id = p.id or left(e.entity_id, length(p.id) + 1) = p.id || ':'))
          or exists (select 1 from unnest($2::text[]) as a(id) where right(e.entity_id, length(a.id) + 1) = ':' || a.id)
          or e.entity_id = any($5::text[])
          or e.payload->>'intake_case_id' = any($5::text[])
          or jsonb_path_exists(e.payload, '$.** ? (@ == $ids[*])', jsonb_build_object('ids', to_jsonb($2::text[]))))
        ${held}
      returning e.organization_id,
                case when e.entity_type = 'intake_case' then e.entity_id else e.payload->>'intake_case_id' end as case_id`,
    [organizationId, ids, athleteId, parentIds.map((row) => row.organizationId), recordIds, parentIds.map((row) => row.parentId)],
  );
  /* AN INTAKE CASE LOSES ALL ITS ROWS OR NONE. The review queue
     (shadowReadModels.ts getShadowReviewProjection) shows a case's status
     from its latest row here, and its own status column only when it has
     none. Deleting the row that named the person (say the promotion, which
     carries the athlete id) while an earlier row stays (the upload, which
     names no one) would show a promoted case as pending. So the rest of the
     case's rows go too, and the queue reads the case's own status. */
  const cases = deleted.rows.filter((row) => row.case_id);
  const rest = cases.length === 0 ? { rowCount: 0 } : await client.query(
    `delete from pilot.shadow_events e
      using unnest($1::text[], $2::text[]) as c(organization_id, case_id)
      where e.organization_id = c.organization_id
        and ((e.entity_type = 'intake_case' and e.entity_id = c.case_id) or e.payload->>'intake_case_id' = c.case_id)
        ${held}`,
    [cases.map((row) => row.organization_id), cases.map((row) => row.case_id)],
  );
  return (deleted.rowCount ?? 0) + (rest.rowCount ?? 0);
}

/* THE PERSON'S SHADOW METRIC ROWS GO TOO (F-106). pilot.shadow_telemetry_events
   is SHADOW's metric log: who did it (actor_account_id) and what it was about
   (dimensions; today's writers put an athlete_id (intake) or a
   video_session_id (video upload) there, and the reader also filters on
   entity_id, owner_entity_id and intake_case_id, so those shapes are covered
   too). Its one reader, listShadowTelemetry
   (shadowReadModels.ts), shows a row tied to no athlete to every role that
   sees unscoped rows, the same as the event log, so the event log's ruling
   applies (Overwatch 2026-10-16, option A, under Jason 2026-10-06: "delete
   any thing that personally Identifys the person"): a row that names the
   person -- as actor, or anywhere in its dimensions by their login or athlete
   id, or by an entity id built from them, their guardian record, or a record
   of the child's (their videos, the intake cases filed about them) -- is
   deleted, in the purged gym (a guardian: everywhere). A row tied to a
   conversation or review entry still held for safeguarding stays, as in the
   event log. Nothing derives state from these rows, so no row is kept for
   another's sake. */
async function deleteShadowTelemetry(client, tables, { organizationId, accountIds, athleteId, parentIds, recordIds }) {
  if (!tables.shadowTelemetry) return 0;
  const ids = [...accountIds, ...(athleteId ? [athleteId] : [])].filter(Boolean);
  if (ids.length === 0 && parentIds.length === 0 && recordIds.length === 0) return 0;
  const held = tables.deidentifyKeys
    ? `and not exists (
         select 1 from pilot.shadow_chat_sessions s
          where s.organization_id = t.organization_id
            and s.subject_deleted_at >= (now() - ${SAFEGUARDING_CHAT_RETENTION})
            and jsonb_path_exists(t.dimensions, '$.** ? (@ == $id)', jsonb_build_object('id', s.conversation_id::text)))
       and not exists (
         select 1 from pilot.shadow_human_review_queue q
          where q.organization_id = t.organization_id
            and q.subject_deleted_at >= (now() - ${SAFEGUARDING_CHAT_RETENTION})
            and jsonb_path_exists(t.dimensions, '$.** ? (@ == $id)', jsonb_build_object('id', q.review_id::text)))`
    : '';
  // A guardian record id is unique only within its gym: each is matched in its own.
  const deleted = await client.query(
    `delete from pilot.shadow_telemetry_events t
      where ($1::text is null or t.organization_id = $1)
        and (t.actor_account_id = any($2::text[])
          or jsonb_path_exists(t.dimensions, '$.** ? (@ == $ids[*])', jsonb_build_object('ids', to_jsonb($2::text[])))
          or ($3::text is not null
            and (left(t.dimensions->>'entity_id', length($3) + 1) = $3 || ':'
              or right(t.dimensions->>'entity_id', length($3) + 1) = ':' || $3))
          or exists (select 1 from unnest($4::text[], $6::text[]) as p(organization_id, id)
                      where p.organization_id = t.organization_id
                        and (t.dimensions->>'entity_id' = p.id or left(t.dimensions->>'entity_id', length(p.id) + 1) = p.id || ':'))
          or exists (select 1 from unnest($2::text[]) as a(id) where right(t.dimensions->>'entity_id', length(a.id) + 1) = ':' || a.id)
          or jsonb_path_exists(t.dimensions, '$.** ? (@ == $ids[*])', jsonb_build_object('ids', to_jsonb($5::text[]))))
        ${held}`,
    [organizationId, ids, athleteId, parentIds.map((row) => row.organizationId), recordIds, parentIds.map((row) => row.parentId)],
  );
  return deleted.rowCount ?? 0;
}

async function scrubGymNotes(client, tables, organizationId, names) {
  const counts = {
    shadowGymMessagesScrubbed: 0, shadowGymTitlesScrubbed: 0, shadowGymFeedbackScrubbed: 0,
    shadowGymFlagNotesScrubbed: 0, shadowGymResearchScrubbed: 0, shadowGymReviewSummariesScrubbed: 0,
    shadowGymBehaviourNotesScrubbed: 0, shadowGymBehaviourLabelsScrubbed: 0,
  };
  const pattern = namePattern(names, true);
  if (!organizationId || pattern === null) return counts;
  const scrub = async (present, table, column) => (present
    ? (await client.query(
      `update pilot.${table} set ${column} = regexp_replace(${column}, $2, '[name]', 'gi')
        where organization_id = $1 and ${column} ~* $2`,
      [organizationId, pattern],
    )).rowCount ?? 0
    : 0);
  counts.shadowGymMessagesScrubbed = await scrub(tables.chatMessages, 'shadow_chat_messages', 'content');
  counts.shadowGymTitlesScrubbed = await scrub(tables.chatSessions, 'shadow_chat_sessions', 'title');
  counts.shadowGymFeedbackScrubbed = await scrub(tables.shadowFeedback, 'shadow_feedback', 'comment');
  counts.shadowGymFlagNotesScrubbed = await scrub(tables.reviewFlags, 'shadow_library_review_flags', 'user_note');
  counts.shadowGymReviewSummariesScrubbed = await scrub(tables.reviewQueue, 'shadow_human_review_queue', 'summary');
  if (tables.behaviourObservations) {
    // A coach's report on another child that names this person (a partner
    // in the drill, say). Capped at the column's 2000, as above.
    counts.shadowGymBehaviourNotesScrubbed = (await withNameScrubPattern(client, pattern, () => client.query(
      `update pilot.behaviour_observations set note = left(regexp_replace(note, $2, '[name]', 'gi'), 2000)
        where organization_id = $1 and note ~* $2`,
      [organizationId, pattern],
    ))).rowCount ?? 0;
    // A behaviour name a coach typed with a child's name in it ("Rosa drops
    // her hands"): the name goes, the behaviour stays. Capped at the
    // label's 120.
    counts.shadowGymBehaviourLabelsScrubbed = (await withNameScrubPattern(client, pattern, () => client.query(
      `update pilot.behaviour_keys set label = left(regexp_replace(label, $2, '[name]', 'gi'), 120)
        where organization_id = $1 and label ~* $2`,
      [organizationId, pattern],
    ))).rowCount ?? 0;
  }
  if (tables.researchRequirements) {
    // The typed text a research row carries: the requirement (a filed
    // question, verbatim), the knowledge gap, and in metadata the learning
    // loop's note, a Library question (shadowLibrary.ts) and staff's closing
    // note. A staff question's key IS its lower-cased text
    // (researchQuestionKey), so a key naming the person becomes a key of its
    // own row, unique as the index needs; a coach re-filing that question
    // from an old chat files a second row.
    const metadataScrub = ['note', 'question', 'closing_note'].reduce(
      (expression, field) => `case when ${expression}->>'${field}' ~* $2
        then jsonb_set(${expression}, '{${field}}', to_jsonb(regexp_replace(${expression}->>'${field}', $2, '[name]', 'gi')))
        else ${expression} end`,
      'metadata',
    );
    counts.shadowGymResearchScrubbed = (await client.query(
      `update pilot.shadow_research_requirements
          set research_requirement = regexp_replace(research_requirement, $2, '[name]', 'gi'),
              knowledge_gap = regexp_replace(knowledge_gap, $2, '[name]', 'gi'),
              metadata = ${metadataScrub},
              source_entity_id = case when source_entity_type = 'shadow_question' and source_entity_id ~* $2
                then 'purged-' || research_requirement_id else source_entity_id end
        where organization_id = $1
          and (research_requirement ~* $2 or knowledge_gap ~* $2
            or metadata->>'note' ~* $2 or metadata->>'question' ~* $2 or metadata->>'closing_note' ~* $2
            or (source_entity_type = 'shadow_question' and source_entity_id ~* $2))`,
      [organizationId, pattern],
    )).rowCount ?? 0;
  }
  return counts;
}

async function deidentifyShadowChatAudit(client, tables, people) {
  const counts = { shadowChatAudit: 0, shadowChatAuditDeleted: 0, shadowChatAuditScrubbed: 0 };
  if (!tables.shadowChatAudit || people.length === 0) return counts;
  const logins = new Map();
  const subjects = new Map();
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
  counts.shadowChatAuditDeleted = deleted.rowCount ?? 0;
  const scrub = (column) =>
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
  counts.shadowChatAudit = updated.rowCount ?? 0;
  // Gym-wide (Jason 2026-10-07, "Gym-wide (Recommended)"): the person's
  // names leave every other turn in their gym too -- a coach's note about
  // them filed under another athlete, or under nobody. Keyed turns were
  // scrubbed above and no longer match. One pattern per gym per call.
  const gyms = new Map();
  for (const person of people) {
    const entry = gyms.get(person.organizationId) ?? { organizationId: person.organizationId, names: [] };
    entry.names.push(...person.names);
    gyms.set(person.organizationId, entry);
  }
  const gymRows = [...gyms.values()]
    .map((row) => ({ ...row, pattern: namePattern(row.names, true) }))
    .filter((row) => row.pattern !== null);
  const scrubbed = await client.query(
    `update pilot.shadow_chat_audit a
        set user_message = regexp_replace(a.user_message, g.pattern, '[name]', 'gi'),
            shadow_response = regexp_replace(a.shadow_response, g.pattern, '[name]', 'gi')
       from unnest($1::text[], $2::text[]) as g(organization_id, pattern)
      where a.organization_id = g.organization_id
        and (a.user_message ~* g.pattern or a.shadow_response ~* g.pattern)`,
    [gymRows.map((row) => row.organizationId), gymRows.map((row) => row.pattern)],
  );
  counts.shadowChatAuditScrubbed = scrubbed.rowCount ?? 0;
  return counts;
}

/* A COACH'S BEHAVIOUR REPORTS ABOUT THE CHILD (pilot.behaviour_observations, lane
   L49) are coaching records the learning loop keeps de-identified (Jason
   2026-10-06; Q5 "Keep coaching, delete medical"): the athlete key becomes
   the person's token -- the same one the chat log gets -- and the coach's
   note is kept with the child's names scrubbed, as a coach's chat turn about
   them is (Jason 2026-10-07, "Scrub the child's name, keep"), or emptied when
   no usable name is on record. The behaviour, context and timing stay. Runs
   before the athlete row goes, whose follow trigger deletes any report still
   naming the child, so a purge that rolls back leaves every report as it was.
   Other children's notes naming this one are scrubbed with the gym-wide notes
   (scrubGymNotes). Capped at the column's 2000: [name] can be longer than the
   name it replaces. */
async function deidentifyBehaviourObservations(client, tables, athlete, token, names) {
  if (!tables.behaviourObservations) return 0;
  const pattern = namePattern(names);
  // The table's guard admits the scrubbed note only as exactly what this
  // pattern makes of it, so the pattern is named to it for the statement.
  const result = await withNameScrubPattern(client, pattern, () => client.query(
    `update pilot.behaviour_observations
        set athlete_id = $3,
            note = case when $4::text is null then '' else left(regexp_replace(note, $4, '[name]', 'gi'), 2000) end,
            deidentified_at = now()
      where organization_id = $1 and athlete_id = $2`,
    [athlete.organization_id, athlete.athlete_id, token, pattern],
  ));
  return result.rowCount ?? 0;
}

/* The learning-loop tables admit a name scrub only as exactly what the purge's
   pattern makes of the text (their guards read pilot.name_scrub_pattern), so
   the pattern is set for the transaction around the scrub and cleared after:
   nothing later in the purge can rewrite a note under it. On a failure there is
   nothing to clear here -- the caller rolls back to its savepoint, which undoes
   the setting with everything else -- and a query on the failed transaction
   would only replace the error the purge reports. */
async function withNameScrubPattern(client, pattern, run) {
  await client.query(`select set_config('pilot.name_scrub_pattern', $1, true)`, [pattern ?? '']);
  const result = await run();
  await client.query(`select set_config('pilot.name_scrub_pattern', '', true)`);
  return result;
}

/**
 * Does the deleting, and is run in BOTH modes -- the dry run rolls it back.
 *
 * WHY THE DRY RUN DELETES. It did not, and that is how the defect below went
 * unseen: the nightly run issued `select count(*)` and reported a healthy
 * number every night, while the delete those rows were counted for could not
 * execute at all. A count is not a rehearsal. This attempts the real
 * statements and rolls them back, so the number the job reports is a number it
 * has actually earned.
 *
 * EACH ACCOUNT IS ITS OWN SAVEPOINT. Before this, one account Postgres refused
 * aborted the whole transaction -- taking the athlete purge and the audit row
 * with it -- so a single blocked guardian meant the sweep deleted NOTHING and
 * said only `{"event":"retention.cleanup.failed","code":"23503"}`. Retention is
 * per-family; one family the platform cannot yet purge must not stop the
 * others, and the constraint that blocked it has to reach the log by name or
 * nobody can act on it.
 */
async function attemptPurge(client, athletes, accountIds, { tables, blobStore }) {
  const blocked = {};
  const record = (error) => {
    const name = blockedBy(error);
    blocked[name] = (blocked[name] ?? 0) + 1;
  };

  /* THE GUARDIAN LINKS THIS PURGE CAN CASCADE THROUGH, LOCKED FIRST, IN THE
     SHARED ORDER. Deleting an athlete cascades to that athlete's
     guardian_links and deleting a pilot.parents row cascades to one
     guardian's links across several athletes, and this whole run is one
     transaction, so before this every cascade locked its links as it went, in
     list order, and held them to the end. A consent reader holding several
     athletes' links FOR SHARE in the other order (playback of a clip that
     shows two children) and this job could each wait on the other: Postgres
     aborts one, and playback fails closed. Taking them all now, ordered by
     (organization_id, athlete_id, parent_id) like every other guardian_links
     locker, leaves the deletes below touching only rows already held.

     The SAME STATEMENT as guardianConsent.ts lockGuardianLinksForPurge, which
     this script cannot import; guardianLinkLockOrderSource.test.ts fails if
     the two drift. Locks only: it deletes nothing, and rows held for a
     candidate skipped below are released with the transaction.

     ITS OWN SAVEPOINT, so it can never cost the run. It sits before the
     per-candidate savepoints; an error here unguarded (a deadlock while it
     waits) would abort the whole transaction and delete nothing. On failure
     it is rolled back and the purge carries on exactly as it did before this
     lock existed, cascade by cascade, and the output says so
     (guardian_link_lock).

     WHAT IT DOES NOT ORDER, stated: intake's guardian write (upsertGuardian
     then linkGuardianAthlete, in one transaction) takes the pilot.parents row
     before the link, the reverse of this job (links here, the parents row at
     its delete below). A run that meets an admin re-linking a guardian whose
     account was deleted more than a year ago can deadlock with it; if this
     side is chosen, that one guardian is recorded under blocked_by 40P01 and
     is purged on the next run. Taking the parents row first instead would
     reopen the cycle with the consent writer (writeMediaConsentUnderLock locks
     the link, then its waiver insert takes a key-share lock on the parents
     row), which the old cascade-order purge had. */
  let guardianLinkLock = 'none';
  if (athletes.length > 0 || accountIds.length > 0) {
    await client.query('savepoint lock_guardian_links');
    try {
      const guardianRecords = await client.query(
        'select organization_id, parent_id from pilot.parents where account_id = any($1::text[])',
        [accountIds],
      );
      await client.query(
        `select 1 from pilot.guardian_links gl
      where (gl.organization_id, gl.athlete_id) in (
              select * from unnest($1::text[], $2::text[]))
         or (gl.organization_id, gl.parent_id) in (
              select * from unnest($3::text[], $4::text[]))
      order by gl.organization_id collate "C", gl.athlete_id collate "C", gl.parent_id collate "C"
      for update of gl`,
        [
          athletes.map((a) => a.organization_id),
          athletes.map((a) => a.athlete_id),
          guardianRecords.rows.map((p) => p.organization_id),
          guardianRecords.rows.map((p) => p.parent_id),
        ],
      );
      await client.query('release savepoint lock_guardian_links');
      guardianLinkLock = 'held';
    } catch (error) {
      await client.query('rollback to savepoint lock_guardian_links');
      guardianLinkLock = `skipped:${blockedBy(error)}`;
    }
  }

  /* ONE ATHLETE AT A TIME, for the same reason as the accounts below. As a
     single statement, one athlete Postgres refused would take every OTHER
     athlete's purge down with it. That happened: pilot.one_percent_nominations
     restricted until its foreign key was made ON DELETE CASCADE
     (OD-2026-08-29-007, one_percent_nomination_athlete_cascade_migration.sql).
     The savepoint stays for the next foreign key that ships without a delete
     action. */
  /* THE LOGIN STOPS NAMING THE ATHLETE IN THE SAME SAVEPOINT. An athlete's
     login is not purged with them (only parent logins are, below), and
     pilot.accounts.athlete_id has no foreign key, so until this statement
     existed the deleted login went on carrying the athlete_id of a row that
     was gone. The roster can then give that athlete_id to a different child
     -- the purge is the one moment it comes free, the deleted row holding the
     primary key until then -- and everything that reads "the athlete this
     login names" would have read the NEW child: the feedback queue showed the
     purged child's closed submissions again, under the new child's name.
     Clearing the link here records, with no clock involved, that this login's
     athlete was purged (deletedAthletes.ts submissionWriterNotDeletedSql reads
     it). Scoped to the one athlete just deleted, and only when a row really
     was deleted; if the delete is refused, the savepoint rollback leaves the
     login exactly as it was.

     AN ATHLETE LOGIN STILL LIVE AT THIS POINT IS MARKED DELETED TOO. Deleting
     an athlete deletes their login in the same transaction (dataDeletion.ts),
     so a live one here is a leftover from before that rule. Left live and
     naming nobody, it would be an athlete login intake could bind to a
     DIFFERENT child (createOrUpdateAthleteAccount accepts athlete_id null on
     a login that is not deleted), who would inherit everything the purged
     child did through it. A login already deleted keeps its own date. A login
     that has since become a coach's or a guardian's is unlinked and otherwise
     left alone: it is that adult's login now.

     WHICH LOGIN IS DECIDED BEFORE THE DELETE, NEVER AFTER. The athlete row is
     locked, then the login that names it is read and locked, then the athlete
     is deleted, and only that captured account_id is written. Asking "which
     account has (organization_id, athlete_id)" AFTER the delete would be
     asking about a moment that is over: upsertOrganizationMembership
     (auth.ts) moves a login into another gym with its athlete_id untouched, so
     a different, present child's login from a gym that issued the same
     athlete_id could arrive in between and be unlinked and retired in the
     purged child's place. A login that arrives after the capture is not
     touched. Athlete first, then account: the order deleteAthleteRecord takes
     them in, so the two cannot deadlock each other.

     A LOGIN THE PURGE RETIRES IS SIGNED OUT, as deleteAthleteRecord does it
     and for its reason: a session token already issued resolves without
     re-reading active_flag, and an activation code already handed out would
     set a PIN and turn the login active again. Both are closed here, in the
     savepoint, for every athlete login the purge unlinks. */
  let athletesDeleted = 0;
  let loginsUnlinked = 0;
  let loginsRetired = 0;
  let videosDeleted = 0;
  let filesDeleted = 0;
  let filesMissing = 0;
  let correctionsDeleted = 0;
  let askerQuestionsDeleted = 0;
  let subjectRequirementsDeleted = 0;
  let subjectSubmissionsDeleted = 0;
  const library = { documentsDeleted: 0, chunksDeleted: 0, documentsHeld: 0, chunksHeld: 0, documentsWithFilePath: 0 };
  const shadow = emptyShadowCounts();
  const addShadow = (counts) => {
    for (const [key, n] of Object.entries(counts)) shadow[key] += n;
  };
  for (const athlete of athletes) {
    await client.query('savepoint purge_athlete');
    try {
      const key = [athlete.organization_id, athlete.athlete_id];
      // The lock repeats the test the athlete was listed by. The list was read
      // without locks: by now the row may be gone, or -- the id reissued by
      // the roster -- be a different, live child's. Either way it is not this
      // run's to delete, and nothing below runs for it.
      const held = await client.query(
        `select 1 from pilot.athletes
          where organization_id = $1 and athlete_id = $2
            and deleted_at is not null and deleted_at < (now() - ${ATHLETE_RETENTION})
            for update`,
        key,
      );
      if (held.rows.length === 0) {
        await client.query('release savepoint purge_athlete');
        continue;
      }
      const linked = await client.query(
        `select account_id, role, deleted_at is null as live, login_email
           from pilot.accounts
          where organization_id = $1 and athlete_id = $2
            for update`,
        key,
      );
      /* The names to scrub from SHADOW's chat log (SHADOW_OPERATIONAL_TABLES),
         read while the rows that hold them still exist: the delete below
         cascades the guardian links and, through the login, the profile. */
      const athleteLogins = linked.rows.filter((row) => row.role === 'athlete').map((row) => row.account_id);
      let knownNames = tables.shadowChatAudit || tables.deidentifyKeys || tables.behaviourObservations
        ? (await client.query(
          `select full_name as name, false as guardian from pilot.athletes where organization_id = $1 and athlete_id = $2
           union all
           select p.full_name, true from pilot.parents p
             join pilot.guardian_links gl on gl.organization_id = p.organization_id and gl.parent_id = p.parent_id
            where gl.organization_id = $1 and gl.athlete_id = $2
           ${tables.profiles ? `union all
           select display_nickname, false from pilot.account_profiles
            where organization_id = $1 and account_id = any($3::text[]) and display_nickname is not null` : ''}`,
          tables.profiles ? [...key, athleteLogins] : key,
        )).rows
        : [];
      const athleteEmails = linked.rows.filter((row) => row.role === 'athlete').map((row) => row.login_email);
      // The child's own names, for the gym-wide notes (scrubGymNotes): a linked
      // guardian is a living person, and the ruling removes the deleted
      // person's name, not theirs.
      const ownNames = [...knownNames.filter((row) => !row.guardian).map((row) => row.name), ...athleteEmails];
      knownNames = [...knownNames.map((row) => row.name), ...athleteEmails];
      /* THE ATHLETE'S VIDEO ROWS GO IN THE SAME SAVEPOINT. video_sessions.
         athlete_id has no foreign key, so nothing cascades: left behind, the
         rows would name an athlete_id the roster may give to a new child, who
         would inherit the purged child's footage (audit CL-B3). Their
         dependants (publications, clip tags, capture participants, calibration
         clips) cascade from the video. compliance_violations.video_session_id
         has no delete action, and a violation recorded against ANOTHER child on
         this video must survive, so its pointer is cleared first -- the
         waivers.parent_id pattern below. The purged child's own violations
         cascade from the athlete row.

         Only videos whose athlete_id is this child. Footage where the child is
         only a tagged or capture participant is someone else's video and is
         not deleted here. */
      let videoPaths = [];
      let purgedVideoIds = [];
      if (tables.videos) {
        const videos = await client.query(
          `select video_session_id from pilot.video_sessions
            where organization_id = $1 and athlete_id = $2
              for update`,
          key,
        );
        const videoIds = videos.rows.map((row) => row.video_session_id);
        purgedVideoIds = videoIds;
        if (videoIds.length > 0) {
          if (tables.violations) {
            await client.query(
              'update pilot.compliance_violations set video_session_id = null where video_session_id = any($1::text[])',
              [videoIds],
            );
          }
          const deletedVideos = await client.query(
            'delete from pilot.video_sessions where video_session_id = any($1::text[]) returning blob_path',
            [videoIds],
          );
          videoPaths = deletedVideos.rows.map((row) => row.blob_path);
        }
      }
      // Before the athlete row goes (its trigger deletes any conversation
      // still naming the child); the row is locked above, so the delete below
      // removes it.
      const feedbackToken = anonymousToken();
      const receiptToken = anonymousToken();
      const flaggedHere = await deidentifyFlaggedConversations(
        client, tables, athleteLogins, athlete.organization_id, receiptToken, knownNames,
      );
      // One token for the person (SHADOW_OPERATIONAL_TABLES), minted before
      // the athlete row goes so their behaviour reports can carry it too.
      const token = anonymousToken();
      const behaviourHere = await deidentifyBehaviourObservations(client, tables, athlete, token, knownNames);
      const removed = await client.query(
        'delete from pilot.athletes where organization_id = $1 and athlete_id = $2 returning athlete_id',
        key,
      );
      if (removed.rows.length === 0) {
        // Not reachable while the lock above holds; if it were, nothing done
        // for this athlete (the flagged conversations above) may stand.
        await client.query('rollback to savepoint purge_athlete');
        await client.query('release savepoint purge_athlete');
        continue;
      }
      // Counted from what the delete removed, not from having tried, and only
      // once the savepoint is released: the audit row is the only record of a
      // purge and must not claim a deletion, or an unlinking, that was rolled
      // back or never happened.
      let unlinkedHere = 0;
      let retiredHere = 0;
      let correctionsHere = 0;
      const shadowHere = emptyShadowCounts();
      shadowHere.behaviourObservations = behaviourHere;
      if (removed.rows.length > 0) {
        for (const login of linked.rows) {
          /* A retired athlete login keeps only what refusing its sign-in needs:
             the row, its role, its gym and deleted_at (deletedAccountSignIn.ts,
             deletedAthletes.ts). Its email, PIN and any password or Microsoft
             binding go with the child (F-102, OD-2026-10-08-009 D15: "Build the
             removals"); each pair is cleared together, as its check requires.
             A login that is not the athlete's role is still in use and keeps
             them. */
          await client.query(
            `update pilot.accounts
                set athlete_id = null,
                    deleted_at = case when role = 'athlete' then coalesce(deleted_at, now()) else deleted_at end,
                    active_flag = case when role = 'athlete' then false else active_flag end,
                    login_email = case when role = 'athlete' then null else login_email end,
                    pin_hash = case when role = 'athlete' then null else pin_hash end,
                    password_hash = case when role = 'athlete' then null else password_hash end,
                    password_set_at = case when role = 'athlete' then null else password_set_at end,
                    microsoft_oid = case when role = 'athlete' then null else microsoft_oid end,
                    microsoft_tid = case when role = 'athlete' then null else microsoft_tid end,
                    updated_at = now()
              where account_id = $1`,
            [login.account_id],
          );
          unlinkedHere += 1;
          if (login.role === 'athlete') {
            await client.query(
              'update pilot.session_tokens set revoked_at = now() where account_id = $1 and revoked_at is null',
              [login.account_id],
            );
            await client.query(
              `update pilot.account_activation_tokens set superseded_at = now()
                where account_id = $1 and consumed_at is null and superseded_at is null`,
              [login.account_id],
            );
            if (login.live) retiredHere += 1;
            /* THE SHADOW MEMORY CORRECTIONS THIS ATHLETE TYPED GO TOO. The
               login outlives the purge, so the account foreign key's cascade
               never fires for it, and corrected_value is the child's own
               words. They are read only on that account's own behalf, which
               a retired login no longer has; nothing needs them for
               audit. */
            if (tables.corrections) {
              const corrections = await client.query(
                'delete from pilot.shadow_chat_memory_corrections where account_id = $1',
                [login.account_id],
              );
              correctionsHere += corrections.rowCount ?? 0;
            }
          }
        }
        /* The same athlete-role logins as the corrections above, and the
           athlete's own record: the person's one token, minted above. */
        const subject = { organizationId: athlete.organization_id, athleteId: athlete.athlete_id };
        Object.assign(shadowHere, await deleteShadowOperationalRows(client, tables, athleteLogins));
        shadowHere.shadowProfileMentions = await clearShadowProfileMentions(client, tables, [subject]);
        Object.assign(shadowHere, await deidentifyShadowChatAudit(client, tables, [{
          organizationId: athlete.organization_id,
          token, accountIds: athleteLogins, subjects: [{ ...subject, token }], names: knownNames,
        }]));
        Object.assign(shadowHere, flaggedHere);
        Object.assign(shadowHere, await deidentifyFeedbackNotes(
          client, tables, athleteLogins, feedbackToken, athlete.organization_id,
        ));
        Object.assign(shadowHere, await deidentifyLoginShadowRows(
          client, tables, athleteLogins, feedbackToken, receiptToken, athlete.organization_id,
        ));
      }
      /* THE QUESTIONS THIS ATHLETE ASKED SHADOW GO TOO (F-054). An athlete's or
         parent's unanswered SHADOW question is filed as a research row holding
         their words verbatim and naming their account. The row carries no
         foreign key (a research requirement may outlive the athlete it was
         about), so nothing cascades: left behind it would keep a minor's own
         words readable by the organization admin after the purge. Only rows
         filed under the asker entity type, by this athlete's login or asked
         about this athlete (metadata.asker_athlete_id); a coach's or admin's
         own filing is research work, not the child's words, and stays. */
      let askerQuestionsHere = 0;
      if (removed.rows.length > 0 && tables.researchRequirements) {
        const askerRows = await client.query(
          `delete from pilot.shadow_research_requirements
            where organization_id = $1
              and source_event_name = 'shadow_unanswered_question'
              and source_entity_type = 'shadow_asker_question'
              and (metadata->>'asker_athlete_id' = $2 or created_by_account_id = any($3::text[]))`,
          [athlete.organization_id, athlete.athlete_id, athleteLogins],
        );
        askerQuestionsHere = askerRows.rowCount ?? 0;
      }
      /* THE RESEARCH ROWS ABOUT THIS ATHLETE GO TOO (F-079). A research
         requirement names the child it is about in subject_id, or, from the
         writers that predate that column, metadata.subject_id or
         metadata.athlete_id: the three fields every reader resolves a row's
         subject from (shadowResearch.ts namedAthleteIdsOf), space-trimmed as
         the SQL readers trim them (namesNoAthleteSql). Every writer stores the
         id trimmed; the trim is for rows that predate that. And an intake
         review's row (approve or reject) is written while the case names no
         athlete yet, and never rewritten, so its only tie to the child is its
         intake case: source_entity_id is the case id, and the case's
         primary_athlete_id (no foreign key, so still set here) is the child. ANY of the three, not only the first: a row filed against the
         child under any of them is about the child. No foreign key reaches
         these (a requirement may outlive the athlete it was about), so the
         mark only hides them; left behind, the question, the knowledge gap
         and an intake reviewer's notes about a purged child stay readable.
         A coach's or admin's filing about the child goes with the child; a
         row that names no athlete is the gym's research and stays. This
         organization only: another gym's athlete with the same id is another
         child. The submissions attached to a row go first, by their own
         statement, so their count is earned (the foreign key would cascade
         them uncounted); matched by requirement id alone, as the cascade
         matches them, so none is removed uncounted. */
      let subjectRequirementsHere = 0;
      let subjectSubmissionsHere = 0;
      if (removed.rows.length > 0 && tables.researchRequirements) {
        const about = await client.query(
          `select research_requirement_id from pilot.shadow_research_requirements
            where organization_id = $1
              and (btrim(subject_id) = $2
                or btrim(metadata->>'subject_id') = $2
                or btrim(metadata->>'athlete_id') = $2
                or (source_entity_type = 'intake_case'
                  and source_entity_id in (
                    select intake_case_id::text from pilot.intake_cases
                     where organization_id = $1 and primary_athlete_id = $2)))
              for update`,
          key,
        );
        const requirementIds = about.rows.map((row) => row.research_requirement_id);
        if (requirementIds.length > 0) {
          if (tables.researchSubmissions) {
            const submissions = await client.query(
              'delete from pilot.shadow_research_submissions where research_requirement_id = any($1::bigint[])',
              [requirementIds],
            );
            subjectSubmissionsHere = submissions.rowCount ?? 0;
          }
          const requirements = await client.query(
            `delete from pilot.shadow_research_requirements
              where organization_id = $1 and research_requirement_id = any($2::bigint[])`,
            [athlete.organization_id, requirementIds],
          );
          subjectRequirementsHere = requirements.rowCount ?? 0;
        }
      }
      /* THE LIBRARY DOCUMENTS FILED AGAINST THIS ATHLETE GO TOO (F-079,
         #1600). A document's subject_id names the child it is evidence about
         and carries no foreign key, so the mark only hides it (the curator
         queue); left behind, its text (the chunks) stays, under an athlete_id
         the roster may give to a new child. The chunks copied the subject
         when written (shadowLibrary.ts), and go first, counted (the foreign
         key would cascade them uncounted).

         A DOCUMENT STILL CITED IS HELD. A citation (shadow_evidence_items)
         has no delete action onto the document or the chunk, so deleting a
         cited one is refused and would roll this whole athlete back. A
         citation made by the app of a chunk about this child is in a bundle
         about this child, and those went with the athlete row above (the
         bundle's athlete key, or after shadow-deidentify-keys its trigger) --
         except a bundle a held chat cites (subject_deleted_at, the
         safeguarding hold: Jason 2026-10-07, "2 years after deletion
         (Recommended)"), or a citation of imported rows the app's own rules
         would not have made. A held document stays with its chunks, counted
         as held, and the child's purge goes on. NOTHING REVISITS IT: once the
         athlete row is gone no later run selects it (see DATA_RETENTION.md).
         So it is MARKED (metadata.subject_purged_at, on the document and every
         chunk of it, or on the held stray chunk) and every reader that could
         serve it filters the mark out (F-086): the readers hide a document
         about a deleted child by the deletion mark on the athlete row, which
         goes here, and a roster that reissues the id would otherwise put the
         purged child's text in front of the new one. A row already marked
         keeps its first date (the existing key wins the merge).

         The row only: a document's blob_path is a label its registrant
         supplied, and no code stores or reads a file through it. How many
         of the deleted documents carried one is counted, never the path. */
      const libraryHere = { documentsDeleted: 0, chunksDeleted: 0, documentsHeld: 0, chunksHeld: 0, documentsWithFilePath: 0 };
      if (removed.rows.length > 0 && tables.libraryDocuments) {
        const documents = await client.query(
          `select document_id from pilot.shadow_library_documents
            where organization_id = $1 and btrim(subject_id) = $2
            order by document_id
              for update`,
          key,
        );
        const documentIds = documents.rows.map((row) => row.document_id);
        const aboutChild = new Set(documentIds);
        // The chunks: every chunk of those documents, and any chunk that itself
        // names the child under a document that does not (the research importer
        // writes a chunk's subject on its own, import-shadow-research.mjs).
        const chunkRows = tables.libraryChunks
          ? (await client.query(
            `select chunk_id, document_id from pilot.shadow_library_chunks
              where document_id = any($3::text[])
                 or (organization_id = $1 and btrim(subject_id) = $2)
              order by chunk_id
                for update`,
            [...key, documentIds],
          )).rows
          : [];
        // Cited by document or by chunk: a citation keeps the document id its
        // chunk had when it was cited, and a chunk can since have moved
        // (pilot-rescope-library-baseline.mjs), so either key can refuse.
        const citations = tables.evidenceItems && (documentIds.length > 0 || chunkRows.length > 0)
          ? (await client.query(
            `select document_id, chunk_id from pilot.shadow_evidence_items
              where document_id = any($1::text[]) or chunk_id = any($2::text[])`,
            [documentIds, chunkRows.map((row) => row.chunk_id)],
          )).rows
          : [];
        const citedChunks = new Set(citations.map((row) => row.chunk_id));
        const held = new Set(citations.map((row) => row.document_id).filter((documentId) => aboutChild.has(documentId)));
        for (const row of chunkRows) {
          if (aboutChild.has(row.document_id) && citedChunks.has(row.chunk_id)) held.add(row.document_id);
        }
        const deletable = documentIds.filter((documentId) => !held.has(documentId));
        // A held document keeps all its chunks; a stray chunk goes unless cited.
        const chunkIds = chunkRows
          .filter((row) => (aboutChild.has(row.document_id) ? !held.has(row.document_id) : !citedChunks.has(row.chunk_id)))
          .map((row) => row.chunk_id);
        libraryHere.documentsHeld = held.size;
        libraryHere.chunksHeld = chunkRows
          .filter((row) => !aboutChild.has(row.document_id) && citedChunks.has(row.chunk_id)).length;
        const heldChunkIds = chunkRows
          .filter((row) => (aboutChild.has(row.document_id) ? held.has(row.document_id) : citedChunks.has(row.chunk_id)))
          .map((row) => row.chunk_id);
        if (held.size > 0) {
          await client.query(
            `update pilot.shadow_library_documents
                set metadata = jsonb_build_object('subject_purged_at', now()) || metadata, updated_at = now()
              where document_id = any($1::text[])`,
            [[...held]],
          );
        }
        if (heldChunkIds.length > 0) {
          await client.query(
            `update pilot.shadow_library_chunks
                set metadata = jsonb_build_object('subject_purged_at', now()) || metadata, updated_at = now()
              where chunk_id = any($1::text[])`,
            [heldChunkIds],
          );
        }
        if (chunkIds.length > 0) {
          const chunks = await client.query(
            'delete from pilot.shadow_library_chunks where chunk_id = any($1::text[])',
            [chunkIds],
          );
          libraryHere.chunksDeleted = chunks.rowCount ?? 0;
        }
        if (deletable.length > 0) {
          const deleted = await client.query(
            `delete from pilot.shadow_library_documents
              where organization_id = $1 and document_id = any($2::text[])
              returning blob_path is not null and btrim(blob_path) <> '' as has_file_path`,
            [athlete.organization_id, deletable],
          );
          libraryHere.documentsDeleted = deleted.rowCount ?? 0;
          libraryHere.documentsWithFilePath = deleted.rows.filter((row) => row.has_file_path).length;
        }
      }
      // Last of the SHADOW work, after the rows above that go anyway, so the
      // count is notes that stay.
      Object.assign(shadowHere, await scrubGymNotes(client, tables, athlete.organization_id, ownNames));
      const athleteRefs = {
        organizationId: athlete.organization_id, accountIds: athleteLogins, athleteId: athlete.athlete_id, parentIds: [],
        // Rows keyed only on a record of the child's: their videos (archive,
        // restore, scan), and the intake cases filed about them (an upload's
        // row names its case, not the child).
        recordIds: [
          ...purgedVideoIds,
          ...(tables.intakeCases ? (await client.query(
            `select intake_case_id::text as id from pilot.intake_cases where organization_id = $1 and primary_athlete_id = $2`,
            key,
          )).rows.map((row) => row.id) : []),
        ],
      };
      shadowHere.shadowEventsDeleted = await deleteShadowEvents(client, tables, athleteRefs);
      shadowHere.shadowTelemetryDeleted = await deleteShadowTelemetry(client, tables, athleteRefs);
      /* THE PORTRAIT GOES TOO: the athlete login's own photo in this gym,
         cleared the way a reviewer's removal clears it (profileDb.ts). So does
         the ring name (F-102): the scrub above already treats it as one of the
         child's names, and it is read there, before this clears it. */
      const portraitPaths = [];
      if (removed.rows.length > 0 && tables.profiles) {
        for (const login of linked.rows.filter((row) => row.role === 'athlete')) {
          await client.query(
            `update pilot.account_profiles
                set display_nickname = null, updated_at = now()
              where organization_id = $1 and account_id = $2 and display_nickname is not null`,
            [athlete.organization_id, login.account_id],
          );
          const portrait = await client.query(
            `select photo_blob_path from pilot.account_profiles
              where organization_id = $1 and account_id = $2 and photo_blob_path is not null
                for update`,
            [athlete.organization_id, login.account_id],
          );
          if (portrait.rows.length === 0) continue;
          await client.query(
            `update pilot.account_profiles
                set photo_blob_path = null, photo_content_type = null, photo_bytes = null,
                    photo_width = null, photo_height = null, photo_sha256 = null,
                    photo_review_state = 'removed', photo_reviewed_at = now(),
                    photo_reviewed_by_account_id = null, updated_at = now()
              where organization_id = $1 and account_id = $2`,
            [athlete.organization_id, login.account_id],
          );
          portraitPaths.push(portrait.rows[0].photo_blob_path);
        }
      }
      // The files last, still inside the savepoint: a refusal here rolls the
      // athlete's rows back with it (see createBlobStore).
      const files = [
        ...videoPaths.map((blobPath) => [VIDEO_CONTAINER, blobPath]),
        ...portraitPaths.map((blobPath) => [PROFILE_CONTAINER, blobPath]),
      ];
      let filesHere = 0;
      let missingHere = 0;
      if (files.length > 0) {
        if (!blobStore) throw new StorageRefusal('STORAGE_CREDENTIAL_MISSING');
        try {
          for (const [container, blobPath] of files) {
            const done = apply
              ? await blobStore.deleteIfExists(container, blobPath)
              : await blobStore.exists(container, blobPath);
            if (done) filesHere += 1;
            else missingHere += 1;
          }
        } catch (error) {
          throw storageRefusalFrom(error);
        }
      }
      await client.query('release savepoint purge_athlete');
      if (removed.rows.length > 0) athletesDeleted += 1;
      loginsUnlinked += unlinkedHere;
      loginsRetired += retiredHere;
      correctionsDeleted += correctionsHere;
      askerQuestionsDeleted += askerQuestionsHere;
      subjectRequirementsDeleted += subjectRequirementsHere;
      subjectSubmissionsDeleted += subjectSubmissionsHere;
      for (const [name, n] of Object.entries(libraryHere)) library[name] += n;
      addShadow(shadowHere);
      videosDeleted += videoPaths.length;
      filesDeleted += filesHere;
      filesMissing += missingHere;
    } catch (error) {
      await client.query('rollback to savepoint purge_athlete');
      record(error);
    }
  }

  let accountsDeleted = 0;
  for (const accountId of accountIds) {
    await client.query('savepoint purge_account');
    try {
      // Read before the guardian record and its links go (SHADOW_OPERATIONAL_TABLES):
      // the guardian's names, and the children whose turns those names must leave.
      const guardianNames = tables.shadowChatAudit || tables.deidentifyKeys || tables.behaviourObservations
        ? (await client.query(
          `select full_name as name from pilot.parents where account_id = $1
           union all
           select login_email from pilot.accounts where account_id = $1 and login_email is not null
           ${tables.profiles ? `union all
           select display_nickname from pilot.account_profiles
            where account_id = $1 and display_nickname is not null` : ''}`,
          [accountId],
        )).rows.map((row) => row.name)
        : [];
      const guardianGym = (await client.query('select organization_id from pilot.accounts where account_id = $1', [accountId]))
        .rows[0]?.organization_id ?? null;
      // Their guardian record ids, while the record exists (deleteShadowEvents).
      // `par-<account>` is how a guardian record id is minted, but a record
      // moved to a new login keeps its id (guardianLoginMove.ts): then it is
      // the live guardian's, not this one's.
      const guardianParentIds = (await client.query(
        `select organization_id as "organizationId", parent_id as "parentId" from pilot.parents where account_id = $1
         union
         select a.organization_id, 'par-' || $1::text from pilot.accounts a
          where a.account_id = $1
            and not exists (select 1 from pilot.parents p
                             where p.organization_id = a.organization_id and p.parent_id = 'par-' || $1::text
                               and p.account_id is distinct from $1)`,
        [accountId],
      )).rows;
      const guardianChildren = tables.shadowChatAudit
        ? (await client.query(
          `select gl.organization_id as "organizationId", gl.athlete_id as "athleteId"
             from pilot.guardian_links gl
             join pilot.parents p on p.organization_id = gl.organization_id and p.parent_id = gl.parent_id
            where p.account_id = $1`,
          [accountId],
        )).rows
        : [];
      /* THE GUARDIAN'S OWN RECORD GOES WITH THE ACCOUNT. Owner decision,
         2026-08-28 (D-8): "delete the parents row too". pilot.parents holds
         their name, phone and email -- the personal data this policy promises
         to remove -- and its foreign key onto pilot.accounts restricts, so
         until this statement existed no guardian who had ever been recorded as
         a parent could be purged at all.

         What follows it is deliberate and load-bearing: guardian_links is ON
         DELETE CASCADE from pilot.parents, so the child-to-guardian links go
         too; pilot.waivers.parent_id is ON DELETE SET NULL, so the waivers
         themselves SURVIVE with their signed_by_name, type, status and dates
         intact. Purging a withdrawn family must never destroy the documents
         that authorised a minor's participation. */
      /* THE POINTER IS CLEARED BY HAND, and it has to be. pilot.waivers has a
         COMPOSITE foreign key onto pilot.parents -- (organization_id,
         parent_id) -- declared ON DELETE SET NULL. Postgres applies SET NULL to
         EVERY column in the key, so deleting the guardian record tries to null
         waivers.organization_id too, and that column is NOT NULL: the delete
         fails with 23502 and no constraint name. Nulling only parent_id first
         means no waiver row still matches the key, so the referential action
         never fires.

         Found by running it, not by reading the schema: it surfaced as a bare
         `{"23502": 1}` in this job's own blocked_by report. The foreign key's
         shape is the real defect and is left alone here -- it is a schema
         change to a different migration, and retention is the only path that
         deletes a pilot.parents row today. */
      /* THE GUARDIAN'S MEDIA CHOICE IS KEPT, BEFORE THE POINTER IS CLEARED.
         Owner ruling, Jason 2026-10-05 ("Keep the 'no' (Recommended)"): a
         withdrawal or photo-only choice outlives the guardian's deletion, and
         the child's media stays restricted until a remaining guardian grants
         it. Clearing parent_id and cascading the links drops this guardian out
         of every consent read, so each child's current photo_media waiver from
         them is recorded first, against the child (guardianConsent.ts reads it
         as it reads a linked guardian's). Only children they are still linked
         to: a choice an unlink already dropped from the gate stays dropped.
         Whatever the status: the gate applies its own rules to it, so no
         second reading of the status lives here. The key is a hash of the
         parent_id (an invited guardian's is their login email); a re-invited
         guardian purged again replaces their own row. retained_at is the
         clock at this statement, not the run's start, so a grant recorded
         while this long transaction runs does not count as post-purge.
         'photo_media' is guardianConsent.ts MEDIA_CONSENT_WAIVER_TYPE, which
         this script cannot import. */
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
          where p.account_id = $1
            and w.waiver_type = 'photo_media'
          order by w.organization_id, w.athlete_id, w.parent_id, w.created_at desc
         on conflict (organization_id, athlete_id, former_parent_key)
         do update set waiver_id = excluded.waiver_id, retained_at = excluded.retained_at`,
        [accountId],
      );
      await client.query(
        `update pilot.waivers w
            set parent_id = null
           from pilot.parents p
          where p.account_id = $1
            and w.organization_id = p.organization_id
            and w.parent_id = p.parent_id`,
        [accountId],
      );
      await client.query('delete from pilot.parents where account_id = $1', [accountId]);
      // The guardian's SHADOW memory corrections: deleted here rather than left
      // to the account foreign key's cascade, so the audit row can count them.
      const corrections = tables.corrections
        ? await client.query('delete from pilot.shadow_chat_memory_corrections where account_id = $1', [accountId])
        : { rowCount: 0 };
      // The guardian's SHADOW rows (SHADOW_OPERATIONAL_TABLES): their own turns
      // only; a turn about their child is tokened by the child's purge.
      const shadowHere = await deleteShadowOperationalRows(client, tables, [accountId]);
      Object.assign(shadowHere, await deidentifyShadowChatAudit(client, tables, [{
        organizationId: guardianGym,
        token: anonymousToken(),
        accountIds: [accountId],
        subjects: guardianChildren.map((child) => ({ ...child, token: null })),
        names: guardianNames,
      }]));
      // Their feedback notes, before the account row (and its set-null key) goes,
      // and the rest of their SHADOW rows before the account trigger would
      // delete the learning signal with them.
      const feedbackToken = anonymousToken();
      const receiptToken = anonymousToken();
      Object.assign(shadowHere, await deidentifyFlaggedConversations(
        client, tables, [accountId], null, receiptToken, guardianNames,
      ));
      Object.assign(shadowHere, await deidentifyFeedbackNotes(client, tables, [accountId], feedbackToken, null));
      Object.assign(shadowHere, await deidentifyLoginShadowRows(
        client, tables, [accountId], feedbackToken, receiptToken, null,
      ));
      // The guardian's own unanswered SHADOW questions (F-054), by the account
      // that filed them: a parent's words about their child are the parent's
      // record and go with the account.
      const askerRows = tables.researchRequirements
        ? await client.query(
          `delete from pilot.shadow_research_requirements
            where source_event_name = 'shadow_unanswered_question'
              and source_entity_type = 'shadow_asker_question'
              and created_by_account_id = $1`,
          [accountId],
        )
        : { rowCount: 0 };
      Object.assign(shadowHere, await scrubGymNotes(client, tables, guardianGym, guardianNames));
      const guardianRefs = {
        organizationId: null, accountIds: [accountId], athleteId: null, parentIds: guardianParentIds, recordIds: [],
      };
      shadowHere.shadowEventsDeleted = await deleteShadowEvents(client, tables, guardianRefs);
      shadowHere.shadowTelemetryDeleted = await deleteShadowTelemetry(client, tables, guardianRefs);
      await client.query('delete from pilot.accounts where account_id = $1', [accountId]);
      await client.query('release savepoint purge_account');
      accountsDeleted += 1;
      correctionsDeleted += corrections.rowCount ?? 0;
      askerQuestionsDeleted += askerRows.rowCount ?? 0;
      addShadow(shadowHere);
    } catch (error) {
      await client.query('rollback to savepoint purge_account');
      record(error);
    }
  }

  return {
    athletesDeleted, accountsDeleted, loginsUnlinked, loginsRetired, videosDeleted, filesDeleted, filesMissing,
    correctionsDeleted, askerQuestionsDeleted, subjectRequirementsDeleted, subjectSubmissionsDeleted, library,
    shadow, blocked, guardianLinkLock,
  };
}

/** The Library-document counts as the audit row and the completion log name them. */
function libraryCounts(library) {
  return {
    subject_library_documents_deleted: library.documentsDeleted,
    subject_library_chunks_deleted: library.chunksDeleted,
    subject_library_documents_held: library.documentsHeld,
    subject_library_chunks_held: library.chunksHeld,
    subject_library_documents_with_file_path: library.documentsWithFilePath,
  };
}

/** The SHADOW counts as the log and the audit row name them (`<prefix>shadow_profiles_deleted`, ...). */
function shadowCountsFor(shadow, prefix, suffix) {
  return {
    [`${prefix}shadow_profiles${suffix}`]: shadow.shadowProfiles,
    [`${prefix}shadow_jobs${suffix}`]: shadow.shadowJobs,
    [`${prefix}shadow_rate_limit_buckets${suffix}`]: shadow.shadowBuckets,
    [`${prefix}shadow_unlock_snapshots${suffix}`]: shadow.shadowSnapshots,
    [`${prefix.replace('delete_', 'clear_')}shadow_profile_mentions${suffix.replace('_deleted', '_cleared')}`]: shadow.shadowProfileMentions,
    [`${prefix.replace('delete_', 'deidentify_')}shadow_chat_audit${suffix.replace('_deleted', '_deidentified')}`]: shadow.shadowChatAudit,
    [`${prefix}shadow_chat_audit${suffix}`]: shadow.shadowChatAuditDeleted,
    [`${prefix.replace('delete_', 'scrub_')}shadow_chat_audit_names${suffix.replace('_deleted', '_scrubbed')}`]: shadow.shadowChatAuditScrubbed,
    [`${prefix.replace('delete_', 'deidentify_')}shadow_feedback${suffix.replace('_deleted', '_deidentified')}`]: shadow.shadowFeedback,
    [`${prefix.replace('delete_', 'clear_')}shadow_review_flag_notes${suffix.replace('_deleted', '_cleared')}`]: shadow.shadowReviewFlagNotes,
    [`${prefix.replace('delete_', 'deidentify_')}shadow_learning_research_rows${suffix.replace('_deleted', '_deidentified')}`]: shadow.shadowLearningRows,
    [`${prefix.replace('delete_', 'close_')}shadow_feedback_reviews${suffix.replace('_deleted', '_closed')}`]: shadow.shadowFeedbackClosed,
    [`${prefix.replace('delete_', 'deidentify_')}shadow_learning_events${suffix.replace('_deleted', '_deidentified')}`]: shadow.shadowLearningEvents,
    [`${prefix.replace('delete_', 'deidentify_')}shadow_recommendation_effectiveness${suffix.replace('_deleted', '_deidentified')}`]: shadow.shadowEffectiveness,
    [`${prefix}shadow_chat_messages${suffix}`]: shadow.shadowChatMessages,
    [`${prefix}shadow_chat_sessions${suffix}`]: shadow.shadowChatSessions,
    [`${prefix}shadow_evidence_bundles${suffix}`]: shadow.shadowEvidenceBundles,
    [`${prefix.replace('delete_', 'deidentify_')}shadow_review_queue${suffix.replace('_deleted', '_deidentified')}`]: shadow.shadowReviewQueue,
    [`${prefix.replace('delete_', 'deidentify_')}shadow_deletion_requests${suffix.replace('_deleted', '_deidentified')}`]: shadow.shadowDeletionRequests,
    [`${prefix.replace('delete_', 'deidentify_')}shadow_flagged_conversations${suffix.replace('_deleted', '_deidentified')}`]: shadow.shadowFlaggedConversations,
    [`${prefix}shadow_flagged_conversation_own_messages${suffix}`]: shadow.shadowFlaggedMessagesDeleted,
    ...Object.fromEntries([
      ['shadow_chat_messages', shadow.shadowGymMessagesScrubbed],
      ['shadow_chat_titles', shadow.shadowGymTitlesScrubbed],
      ['shadow_feedback_comments', shadow.shadowGymFeedbackScrubbed],
      ['shadow_review_flag_notes', shadow.shadowGymFlagNotesScrubbed],
      ['shadow_research_rows', shadow.shadowGymResearchScrubbed],
      ['shadow_review_summaries', shadow.shadowGymReviewSummariesScrubbed],
      ['behaviour_observation_notes', shadow.shadowGymBehaviourNotesScrubbed],
      ['behaviour_key_labels', shadow.shadowGymBehaviourLabelsScrubbed],
    ].map(([name, n]) => [`${prefix.replace('delete_', 'scrub_')}${name}_names${suffix.replace('_deleted', '_scrubbed')}`, n])),
    [`${prefix}shadow_events${suffix}`]: shadow.shadowEventsDeleted,
    [`${prefix}shadow_telemetry_events${suffix}`]: shadow.shadowTelemetryDeleted,
    [`${prefix.replace('delete_', 'deidentify_')}behaviour_observations${suffix.replace('_deleted', '_deidentified')}`]: shadow.behaviourObservations,
  };
}

async function main() {
  const client = await pool.connect();

  try {
    // TWO COUNTS, AND THEY ARE NOT THE SAME NUMBER. The first, taken here in
    // the transaction that will do the deleting, is the CANDIDATES: what the
    // retention windows say is due. It is what the blast-radius guard measures
    // and what a dry run reports as `athletes` / `accounts`. It is read without
    // locks, so it is not a promise about what will be removed.
    //
    // The second is what attemptPurge ACTUALLY deleted: counted from each
    // guarded DELETE's own result, after its savepoint is released. A
    // candidate can be refused by the database, or be gone (or no longer
    // expired) by the time its row is locked, and then it is not counted. Only
    // this second count goes into `would_delete_*`, the applied run's output
    // and the audit row.
    await client.query('begin');

    /* A GUARDIAN WITH A FLAGGED SHADOW CHAT IS HELD TO TWO YEARS. Jason
       2026-10-07 (Q7): "2 years after deletion (Recommended)" -- a
       safeguarding-flagged chat may be the record that a child was at risk,
       so it outlives the person's deletion by two years. A guardian's
       pilot.shadow_human_review_queue rows go when their account row goes
       (the account key's cascade, or after shadow-deidentify-keys the
       shadow_rows_follow_account trigger, which spares only a row with
       subject_deleted_at set, and nothing sets it). So the account itself
       waits: any review-queue row naming the guardian, whatever its status,
       holds the account -- the review entries, the guardian's own
       conversations and the guardian record -- until deleted_at + 2 years,
       when it is purged like any other: its conversations deleted and its
       review entries de-identified (deidentifyLoginShadowRows).

       WHAT THIS DOES NOT HOLD: a flagged conversation that is ABOUT a child
       (shadow_chat_sessions.athlete_id set) also goes with that child: the
       session's athlete key cascades (or, after shadow-deidentify-keys,
       shadow_rows_follow_athlete deletes it) when the child is purged at the
       child's own deleted_at + 2 years, which can come before the guardian's
       hold ends. The review entry itself stays with the held guardian.
       Holding a child's record for a guardian's chat is not decided here.

       Guarded like the other optional tables, so a database without SHADOW
       purges as before. */
    const reviewQueue = (await client.query(
      `select to_regclass('pilot.shadow_human_review_queue') is not null as present`,
    )).rows[0].present;
    const flaggedGuardianSql = reviewQueue
      ? `exists (select 1 from pilot.shadow_human_review_queue q where q.account_id = a.account_id)`
      : 'false';
    const expiredAccounts = await client.query(
      `select a.account_id from pilot.accounts a
        where a.deleted_at is not null and a.deleted_at < (now() - ${ACCOUNT_RETENTION})
          and a.role = 'parent'
          and (a.deleted_at < (now() - ${SAFEGUARDING_CHAT_RETENTION}) or not ${flaggedGuardianSql})`,
    );
    // Reported in every mode so a held guardian is never invisible: due by the
    // one-year window, not removed, and why.
    const heldGuardians = (await client.query(
      `select count(*)::int as n from pilot.accounts a
        where a.deleted_at is not null and a.deleted_at < (now() - ${ACCOUNT_RETENTION})
          and a.role = 'parent'
          and a.deleted_at >= (now() - ${SAFEGUARDING_CHAT_RETENTION}) and ${flaggedGuardianSql}`,
    )).rows[0].n;
    const expiredAthletes = await client.query(
      `select organization_id, athlete_id from pilot.athletes
        where deleted_at is not null and deleted_at < (now() - ${ATHLETE_RETENTION})`,
    );
    const present = await client.query(
      `select to_regclass('pilot.video_sessions') is not null as videos,
              to_regclass('pilot.compliance_violations') is not null as violations,
              to_regclass('pilot.account_profiles') is not null as profiles,
              to_regclass('pilot.shadow_chat_memory_corrections') is not null as corrections,
              to_regclass('pilot.shadow_user_profiles') is not null as "shadowProfiles",
              to_regclass('pilot.shadow_jobs') is not null as "shadowJobs",
              to_regclass('pilot.shadow_rate_limit_buckets') is not null as "shadowBuckets",
              to_regclass('pilot.shadow_feature_unlock_snapshots') is not null as "shadowSnapshots",
              to_regclass('pilot.shadow_chat_audit') is not null as "shadowChatAudit",
              to_regclass('pilot.shadow_feedback') is not null as "shadowFeedback",
              to_regclass('pilot.shadow_library_review_flags') is not null as "reviewFlags",
              to_regclass('pilot.shadow_research_requirements') is not null as "researchRequirements",
              to_regclass('pilot.shadow_research_submissions') is not null as "researchSubmissions",
              to_regclass('pilot.shadow_library_documents') is not null as "libraryDocuments",
              to_regclass('pilot.shadow_library_chunks') is not null as "libraryChunks",
              to_regclass('pilot.shadow_evidence_items') is not null as "evidenceItems",
              to_regclass('pilot.shadow_chat_messages') is not null as "chatMessages",
              to_regclass('pilot.shadow_events') is not null as "shadowEvents",
              to_regclass('pilot.shadow_telemetry_events') is not null as "shadowTelemetry",
              to_regclass('pilot.intake_cases') is not null as "intakeCases",
              to_regclass('pilot.shadow_chat_sessions') is not null as "chatSessions",
              to_regclass('pilot.shadow_human_review_queue') is not null as "reviewQueue",
              exists (select 1 from information_schema.columns
                       where table_schema = 'pilot' and table_name = 'shadow_human_review_queue'
                         and column_name = 'deidentified_at') as "deidentifyKeys",
              to_regclass('pilot.behaviour_observations') is not null as "behaviourObservations",
              to_regclass('pilot.public_interest_submissions') is not null as inquiries`,
    );
    const tables = present.rows[0];
    const expiredInquiries = tables.inquiries
      ? await client.query(
        `select count(*)::int as n from pilot.public_interest_submissions
          where created_at < (now() - ${INQUIRY_RETENTION})`,
      )
      : { rows: [{ n: 0 }] };
    // Reported, NOT counted against the blast radius. The cap measures how
    // many people a run removes; a child's videos go only with that child. One
    // athlete with years of footage counted here would refuse the WHOLE run --
    // every other family's purge too -- every night, and past the 200 ceiling
    // could never be purged at all.
    const expiredVideos = tables.videos && expiredAthletes.rows.length > 0
      ? await client.query(
        `select count(*)::int as n from pilot.video_sessions v
          where (v.organization_id, v.athlete_id) in (select * from unnest($1::text[], $2::text[]))`,
        [expiredAthletes.rows.map((a) => a.organization_id), expiredAthletes.rows.map((a) => a.athlete_id)],
      )
      : { rows: [{ n: 0 }] };
    const athletes = expiredAthletes.rows.length;
    const accounts = expiredAccounts.rows.length;
    const videos = expiredVideos.rows[0].n;
    const inquiries = expiredInquiries.rows[0].n;
    // Only families can trip the cap (INQUIRY_RETENTION, above). In the
    // inquiries-only mode no family is removed, so none takes room under the
    // cap: inquiries get all of it, and the whole cap is what bounds the run.
    const families = athletes + accounts;
    const inquiryRoom = applyInquiries ? maxRows : Math.max(0, maxRows - families);
    const total = families + inquiries;

    if (families > maxRows) {
      // The guard protects people's records from a runaway sweep. The
      // inquiries-only run never sweeps them, so refusing it would only stop
      // inquiry retention; it reports the number loudly and carries on.
      if (!applyInquiries) {
        await client.query('rollback');
        console.error(JSON.stringify({
          event: 'retention.cleanup.refused',
          reason: 'BLAST_RADIUS_EXCEEDED',
          athletes,
          accounts,
          videos,
          inquiries,
          total,
          guardians_held_for_safeguarding_chats: heldGuardians,
          max_rows: maxRows,
        }));
        process.exitCode = 1;
        return;
      }
      console.error(JSON.stringify({
        event: 'retention.cleanup.people_over_cap',
        mode,
        athletes,
        accounts,
        guardians_held_for_safeguarding_chats: heldGuardians,
        max_rows: maxRows,
        note: 'People\'s records are not touched by this mode. A full APPLY of these would be refused as BLAST_RADIUS_EXCEEDED; a human must look.',
      }));
    }

    const accountIds = expiredAccounts.rows.map((row) => row.account_id);
    // The inquiries-only run never enters attemptPurge, not even the rolled-back
    // rehearsal a dry run does, and never opens storage: people's records are
    // candidates it counts, nothing more.
    const outcome = families === 0 || applyInquiries
      ? {
        athletesDeleted: 0, accountsDeleted: 0, loginsUnlinked: 0, loginsRetired: 0,
        videosDeleted: 0, filesDeleted: 0, filesMissing: 0, correctionsDeleted: 0, askerQuestionsDeleted: 0,
        subjectRequirementsDeleted: 0, subjectSubmissionsDeleted: 0,
        library: { documentsDeleted: 0, chunksDeleted: 0, documentsHeld: 0, chunksHeld: 0, documentsWithFilePath: 0 },
        shadow: emptyShadowCounts(),
        blocked: {}, guardianLinkLock: 'none',
      }
      : await attemptPurge(client, expiredAthletes.rows, accountIds, { tables, blobStore: await createBlobStore() });

    // Run in both modes, like the family purge: the dry run rolls it back, so
    // its count is one the DELETE actually earned. Its own savepoint, so a
    // refused delete is reported by name and does not take the families'
    // purge or the audit row with it. Counts only ever leave this block.
    let inquiriesDeleted = 0;
    if (inquiries > 0 && inquiryRoom > 0) {
      await client.query('savepoint purge_inquiries');
      try {
        const deleted = await client.query(
          `delete from pilot.public_interest_submissions
            where submission_id in (
              select submission_id from pilot.public_interest_submissions
               where created_at < (now() - ${INQUIRY_RETENTION})
               order by created_at, submission_id
               limit $1)`,
          [inquiryRoom],
        );
        await client.query('release savepoint purge_inquiries');
        inquiriesDeleted = deleted.rowCount ?? 0;
      } catch (error) {
        await client.query('rollback to savepoint purge_inquiries');
        const by = blockedBy(error);
        outcome.blocked[by] = (outcome.blocked[by] ?? 0) + 1;
      }
    }
    const inquiriesDeferred = Math.max(0, inquiries - inquiriesDeleted);
    const blockedCount = Object.values(outcome.blocked).reduce((sum, n) => sum + n, 0);

    if (mode === 'dry_run') {
      await client.query('rollback');
      console.log(JSON.stringify({
        event: 'retention.cleanup.dry-run',
        mode,
        athletes,
        accounts,
        videos,
        inquiries,
        total,
        // What the next scheduled run deletes on its own, and what waits for
        // a person to dispatch APPLY. The dry run is the monitor, so it says
        // which is which.
        nightly_deletes_inquiries: Math.min(inquiries, maxRows),
        apply_needed_for: { athletes, accounts, videos },
        guardians_held_for_safeguarding_chats: heldGuardians,
        would_delete_athletes: outcome.athletesDeleted,
        would_delete_accounts: outcome.accountsDeleted,
        would_delete_videos: outcome.videosDeleted,
        would_delete_inquiries: inquiriesDeleted,
        inquiries_deferred: inquiriesDeferred,
        would_delete_files: outcome.filesDeleted,
        files_missing: outcome.filesMissing,
        would_unlink_athlete_logins: outcome.loginsUnlinked,
        would_retire_live_athlete_logins: outcome.loginsRetired,
        would_delete_shadow_memory_corrections: outcome.correctionsDeleted,
        would_delete_asker_research_questions: outcome.askerQuestionsDeleted,
        would_delete_subject_research_requirements: outcome.subjectRequirementsDeleted,
        would_delete_subject_research_submissions: outcome.subjectSubmissionsDeleted,
        would_delete_subject_library_documents: outcome.library.documentsDeleted,
        would_delete_subject_library_chunks: outcome.library.chunksDeleted,
        subject_library_documents_held: outcome.library.documentsHeld,
        subject_library_chunks_held: outcome.library.chunksHeld,
        subject_library_documents_with_file_path: outcome.library.documentsWithFilePath,
        ...shadowCountsFor(outcome.shadow, 'would_delete_', ''),
        blocked: blockedCount,
        blocked_by: outcome.blocked,
        guardian_link_lock: outcome.guardianLinkLock,
        note: 'the scheduled run (PPBF_RETENTION_APPLY_INQUIRIES=true) deletes the inquiries; set PPBF_RETENTION_APPLY=true to delete everything due',
      }));
      // A dry run that found rows it CANNOT delete is a failing monitor, not a
      // report. Exiting non-zero is the whole point: retention is not
      // happening, and the schedule is the only thing watching.
      if (blockedCount > 0) process.exitCode = 1;
      return;
    }

    // Nothing this mode deletes was due (or, inquiries-only, nothing due was
    // deletable within this run): no audit row, since nothing happened.
    const deletedHere = outcome.athletesDeleted + outcome.accountsDeleted + inquiriesDeleted;
    if (total === 0 || (applyInquiries && deletedHere === 0 && blockedCount === 0)) {
      await client.query('rollback');
      console.log(JSON.stringify({
        event: 'retention.cleanup.completed',
        mode,
        athletes: 0,
        accounts: 0,
        inquiries: 0,
        total: 0,
        guardians_held_for_safeguarding_chats: heldGuardians,
        ...(applyInquiries ? { people_due: { athletes, accounts, videos } } : {}),
      }));
      return;
    }

    await client.query(
      `insert into pilot.audit_events (event_type, organization_id, entity_type, entity_id, details)
       values ($1, null, 'retention_cleanup', 'system', $2)`,
      [
        'data_purged',
        JSON.stringify({
          mode,
          // Inquiries-only: the people's records the run saw and left alone.
          ...(applyInquiries ? { people_due: { athletes, accounts, videos } } : {}),
          athletes_deleted: outcome.athletesDeleted,
          accounts_deleted: outcome.accountsDeleted,
          athlete_logins_unlinked: outcome.loginsUnlinked,
          live_athlete_logins_retired: outcome.loginsRetired,
          videos_deleted: outcome.videosDeleted,
          inquiries_deleted: inquiriesDeleted,
          inquiries_deferred: inquiriesDeferred,
          files_deleted: outcome.filesDeleted,
          files_missing: outcome.filesMissing,
          shadow_memory_corrections_deleted: outcome.correctionsDeleted,
          asker_research_questions_deleted: outcome.askerQuestionsDeleted,
          subject_research_requirements_deleted: outcome.subjectRequirementsDeleted,
          subject_research_submissions_deleted: outcome.subjectSubmissionsDeleted,
          ...libraryCounts(outcome.library),
          ...shadowCountsFor(outcome.shadow, '', '_deleted'),
          guardians_held_for_safeguarding_chats: heldGuardians,
          total_rows_deleted:
            outcome.athletesDeleted + outcome.accountsDeleted + outcome.videosDeleted + inquiriesDeleted,
          blocked: blockedCount,
          blocked_by: outcome.blocked,
        }),
      ],
    );

    await client.query('commit');

    console.log(JSON.stringify({
      event: blockedCount > 0 ? 'retention.cleanup.incomplete' : 'retention.cleanup.completed',
      mode,
      ...(applyInquiries ? { people_due: { athletes, accounts, videos } } : {}),
      athletes: outcome.athletesDeleted,
      accounts: outcome.accountsDeleted,
      athlete_logins_unlinked: outcome.loginsUnlinked,
      live_athlete_logins_retired: outcome.loginsRetired,
      videos: outcome.videosDeleted,
      inquiries: inquiriesDeleted,
      inquiries_deferred: inquiriesDeferred,
      files_deleted: outcome.filesDeleted,
      files_missing: outcome.filesMissing,
      shadow_memory_corrections_deleted: outcome.correctionsDeleted,
      asker_research_questions_deleted: outcome.askerQuestionsDeleted,
      subject_research_requirements_deleted: outcome.subjectRequirementsDeleted,
      subject_research_submissions_deleted: outcome.subjectSubmissionsDeleted,
      ...libraryCounts(outcome.library),
      ...shadowCountsFor(outcome.shadow, '', '_deleted'),
      guardians_held_for_safeguarding_chats: heldGuardians,
      total: outcome.athletesDeleted + outcome.accountsDeleted + inquiriesDeleted,
      blocked: blockedCount,
      blocked_by: outcome.blocked,
      guardian_link_lock: outcome.guardianLinkLock,
    }));
    // Rows WERE deleted and the audit row records exactly what, so this commits
    // rather than throwing away good work -- but retention did not fully happen
    // and the run must not read as green.
    if (blockedCount > 0) process.exitCode = 1;
  } catch (error) {
    await client.query('rollback').catch(() => {});
    // Identifier only. This job runs against a database of minors' records and
    // its output goes to a CI log.
    console.error(JSON.stringify({
      event: 'retention.cleanup.failed',
      reason: error instanceof Error ? error.name : 'UnknownError',
      code: error && typeof error === 'object' && 'code' in error ? String(error.code) : undefined,
    }));
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

await main();
