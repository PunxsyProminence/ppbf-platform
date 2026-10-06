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
 *   PPBF_RETENTION_APPLY=true npm run pilot:cleanup-deleted-data
 */

import { Pool } from 'pg';

import { assertDeclaredWriteTargetFromEnv } from './lib/postgres-write-target.mjs';

const ATHLETE_RETENTION = "interval '2 years'";
const ACCOUNT_RETENTION = "interval '1 year'";
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
        `select account_id, role, deleted_at is null as live
           from pilot.accounts
          where organization_id = $1 and athlete_id = $2
            for update`,
        key,
      );
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
      if (tables.videos) {
        const videos = await client.query(
          `select video_session_id from pilot.video_sessions
            where organization_id = $1 and athlete_id = $2
              for update`,
          key,
        );
        const videoIds = videos.rows.map((row) => row.video_session_id);
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
      const removed = await client.query(
        'delete from pilot.athletes where organization_id = $1 and athlete_id = $2 returning athlete_id',
        key,
      );
      // Counted from what the delete removed, not from having tried, and only
      // once the savepoint is released: the audit row is the only record of a
      // purge and must not claim a deletion, or an unlinking, that was rolled
      // back or never happened.
      let unlinkedHere = 0;
      let retiredHere = 0;
      if (removed.rows.length > 0) {
        for (const login of linked.rows) {
          await client.query(
            `update pilot.accounts
                set athlete_id = null,
                    deleted_at = case when role = 'athlete' then coalesce(deleted_at, now()) else deleted_at end,
                    active_flag = case when role = 'athlete' then false else active_flag end,
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
          }
        }
      }
      /* THE PORTRAIT GOES TOO: the athlete login's own photo in this gym,
         cleared the way a reviewer's removal clears it (profileDb.ts). */
      const portraitPaths = [];
      if (removed.rows.length > 0 && tables.profiles) {
        for (const login of linked.rows.filter((row) => row.role === 'athlete')) {
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
         this script cannot import. dataDeletion.ts purgeExpiredDeletedData
         carries the same statement. */
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
      await client.query('delete from pilot.accounts where account_id = $1', [accountId]);
      await client.query('release savepoint purge_account');
      accountsDeleted += 1;
    } catch (error) {
      await client.query('rollback to savepoint purge_account');
      record(error);
    }
  }

  return {
    athletesDeleted, accountsDeleted, loginsUnlinked, loginsRetired, videosDeleted, filesDeleted, filesMissing,
    blocked, guardianLinkLock,
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

    const expiredAccounts = await client.query(
      `select account_id from pilot.accounts
        where deleted_at is not null and deleted_at < (now() - ${ACCOUNT_RETENTION})
          and role = 'parent'`,
    );
    const expiredAthletes = await client.query(
      `select organization_id, athlete_id from pilot.athletes
        where deleted_at is not null and deleted_at < (now() - ${ATHLETE_RETENTION})`,
    );
    const present = await client.query(
      `select to_regclass('pilot.video_sessions') is not null as videos,
              to_regclass('pilot.compliance_violations') is not null as violations,
              to_regclass('pilot.account_profiles') is not null as profiles,
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
    // Only families can trip the cap (INQUIRY_RETENTION, above).
    const families = athletes + accounts;
    const inquiryRoom = Math.max(0, maxRows - families);
    const total = families + inquiries;

    if (families > maxRows) {
      await client.query('rollback');
      console.error(JSON.stringify({
        event: 'retention.cleanup.refused',
        reason: 'BLAST_RADIUS_EXCEEDED',
        athletes,
        accounts,
        videos,
        inquiries,
        total,
        max_rows: maxRows,
      }));
      process.exitCode = 1;
      return;
    }

    const accountIds = expiredAccounts.rows.map((row) => row.account_id);
    const outcome = families === 0
      ? {
        athletesDeleted: 0, accountsDeleted: 0, loginsUnlinked: 0, loginsRetired: 0,
        videosDeleted: 0, filesDeleted: 0, filesMissing: 0, blocked: {}, guardianLinkLock: 'none',
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

    if (!apply) {
      await client.query('rollback');
      console.log(JSON.stringify({
        event: 'retention.cleanup.dry-run',
        athletes,
        accounts,
        videos,
        inquiries,
        total,
        would_delete_athletes: outcome.athletesDeleted,
        would_delete_accounts: outcome.accountsDeleted,
        would_delete_videos: outcome.videosDeleted,
        would_delete_inquiries: inquiriesDeleted,
        inquiries_deferred: inquiriesDeferred,
        would_delete_files: outcome.filesDeleted,
        files_missing: outcome.filesMissing,
        would_unlink_athlete_logins: outcome.loginsUnlinked,
        would_retire_live_athlete_logins: outcome.loginsRetired,
        blocked: blockedCount,
        blocked_by: outcome.blocked,
        guardian_link_lock: outcome.guardianLinkLock,
        note: 'set PPBF_RETENTION_APPLY=true to delete',
      }));
      // A dry run that found rows it CANNOT delete is a failing monitor, not a
      // report. Exiting non-zero is the whole point: retention is not
      // happening, and the schedule is the only thing watching.
      if (blockedCount > 0) process.exitCode = 1;
      return;
    }

    if (total === 0) {
      await client.query('rollback');
      console.log(JSON.stringify({
        event: 'retention.cleanup.completed', athletes: 0, accounts: 0, inquiries: 0, total: 0,
      }));
      return;
    }

    await client.query(
      `insert into pilot.audit_events (event_type, organization_id, entity_type, entity_id, details)
       values ($1, null, 'retention_cleanup', 'system', $2)`,
      [
        'data_purged',
        JSON.stringify({
          athletes_deleted: outcome.athletesDeleted,
          accounts_deleted: outcome.accountsDeleted,
          athlete_logins_unlinked: outcome.loginsUnlinked,
          live_athlete_logins_retired: outcome.loginsRetired,
          videos_deleted: outcome.videosDeleted,
          inquiries_deleted: inquiriesDeleted,
          inquiries_deferred: inquiriesDeferred,
          files_deleted: outcome.filesDeleted,
          files_missing: outcome.filesMissing,
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
      athletes: outcome.athletesDeleted,
      accounts: outcome.accountsDeleted,
      athlete_logins_unlinked: outcome.loginsUnlinked,
      live_athlete_logins_retired: outcome.loginsRetired,
      videos: outcome.videosDeleted,
      inquiries: inquiriesDeleted,
      inquiries_deferred: inquiriesDeferred,
      files_deleted: outcome.filesDeleted,
      files_missing: outcome.filesMissing,
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
