import { randomUUID } from 'node:crypto';

import { writePilotAuditEvent } from '../audit';
import { getAccountRoleInOrganization } from '../auth';
import type { PilotRole } from '../contracts';
import { queryOne } from '../db';
import {
  assertVideoClippable,
  createCalibrationClip,
  createCalibrationProject,
  type CalibrationClipRow,
  type CalibrationProjectRow,
} from './projects';
import {
  BOXING_ONTOLOGY_VERSION,
  CLIP_SAMPLING_REASONS,
  isInVocabulary,
  type ClipSamplingReason,
} from './ontology';

// The operator seam between footage the platform already holds and the
// annotation workflow that already exists.
//
// WHY THERE IS ANYTHING HERE AT ALL. createCalibrationProject and
// createCalibrationClip have been shipped and tested since the calibration
// foundation landed, and /coach/calibration has been able to annotate a clip
// for just as long -- but nothing outside a .pg.test.ts had ever called the
// two creators, so no study existed for that page to open. The routes under
// app/api/pilot/calibration are read-only by deliberate design, and say so:
// "Creating a project and cutting its clips is an operator act performed
// against src/server/pilot/calibration/projects.ts". This module is that
// operator act, written down once so it is testable, with
// scripts/pilot-bootstrap-calibration-clip.ts as its command line.
//
// WHAT IT DOES NOT DO, because the modules it calls already do it:
//
//   * It does not re-check that the source video is 'ready', is in the
//     caller's organization, or exists. assertVideoClippable is the gate, and
//     copying its rules here would create a second answer that can drift from
//     the first.
//   * It does not decide the athlete. createCalibrationClip takes no athlete
//     parameter at all -- attribution is read off the source row -- and this
//     module deliberately offers no way to supply one, so an operator typing
//     a name cannot attach a clip to a boxer who is not in the footage.
//   * It does not grant, widen, or cache permission. A clip row is a pointer
//     to a video, re-checked on every read; creating one says nothing about
//     who may later watch it.
//   * It creates no derived media. The clip references the source video's own
//     video_session_id; the blob is neither copied, re-encoded, nor renamed.
//   * It promotes nothing. A bootstrapped clip is not gold, not accepted
//     truth, not training data, and not eligible to become any of those by
//     having been created this way.

/** One clip cut from one existing video, and the study it belongs to.
 *
 * Every field is required. There is no default for any of them, because every
 * one carries meaning an operator has to mean: which footage, which span of
 * it, why that span was chosen, and who is answerable for the choice.
 */
export interface CalibrationBootstrapRequest {
  organizationId: string;
  videoSessionId: string;
  projectName: string;
  clipCode: string;
  startMs: number;
  endMs: number;
  primarySamplingReason: ClipSamplingReason;
  createdByAccountId: string;
}

export interface CalibrationBootstrapResult {
  project: CalibrationProjectRow;
  clip: CalibrationClipRow;
}

/** The flags this bootstrap accepts, in the order the usage line prints them. */
const REQUIRED_FLAGS = [
  '--organization-id',
  '--video-session-id',
  '--project-name',
  '--clip-code',
  '--start-ms',
  '--end-ms',
  '--sampling-reason',
  '--created-by-account-id',
] as const;

export const BOOTSTRAP_USAGE = [
  'usage: tsx scripts/pilot-bootstrap-calibration-clip.ts \\',
  ...REQUIRED_FLAGS.map((flag) => `  ${flag} <value> \\`),
  '',
  `  --sampling-reason is one of: ${CLIP_SAMPLING_REASONS.join(', ')}`,
].join('\n');

/** Reads a whole number of milliseconds, or refuses.
 *
 * Number.parseInt is not enough on its own: it reads '5s' as 5 and '1_000' as
 * 1, so a mistyped offset would become a real, wrong, silently accepted clip
 * boundary. The exact-digits test means a value this function returns is the
 * value the operator typed.
 */
function requireWholeMs(raw: string, flag: string): number {
  if (!/^\d+$/.test(raw)) {
    throw new Error(`Invalid ${flag}: expected a whole number of milliseconds, got "${raw}"`);
  }
  return Number.parseInt(raw, 10);
}

/**
 * Turns `--flag value` pairs into a request, refusing anything it does not
 * recognise.
 *
 * UNKNOWN FLAGS ARE REFUSED, not ignored. The flag this exists to refuse is
 * `--athlete-id`: it is the one an operator would most reasonably expect to
 * exist, it is the one the data model deliberately does not accept, and a
 * parser that skipped it would take the argument, discard it, and report
 * success while attributing the clip to somebody else.
 *
 * The ontology version is not a flag either. createCalibrationProject accepts
 * exactly one value -- the version this build implements -- and rejects every
 * other, so offering it as an input would offer a choice that does not exist.
 */
export function parseCalibrationBootstrapArgv(
  argv: readonly string[],
): CalibrationBootstrapRequest {
  const values = new Map<string, string>();

  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];

    if (!REQUIRED_FLAGS.includes(flag as (typeof REQUIRED_FLAGS)[number])) {
      throw new Error(`Unrecognised argument: ${flag}\n\n${BOOTSTRAP_USAGE}`);
    }
    // A value that is itself a flag means the operator left one blank. Taking
    // it literally would set organizationId to '--athlete-id' and then refuse
    // the NEXT token with an unrecognised-argument error naming something the
    // operator never typed as a flag.
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`Missing value for ${flag}\n\n${BOOTSTRAP_USAGE}`);
    }
    // Blank refused HERE rather than left to requireNonEmpty inside the
    // services. Both refuse it, but they refuse it at different costs: an
    // empty --clip-code survives all the way past the project INSERT and
    // strands a study, while an empty value caught on this side costs a
    // database connection that was never opened.
    if (value.trim().length === 0) {
      throw new Error(`Empty value for ${flag}\n\n${BOOTSTRAP_USAGE}`);
    }
    if (values.has(flag)) {
      throw new Error(`Repeated argument: ${flag}`);
    }
    values.set(flag, value);
  }

  const missing = REQUIRED_FLAGS.filter((flag) => !values.has(flag));
  if (missing.length > 0) {
    throw new Error(`Missing required argument(s): ${missing.join(', ')}\n\n${BOOTSTRAP_USAGE}`);
  }

  const samplingReason = values.get('--sampling-reason') as string;
  // Narrowed against the ontology's own list rather than a copy of it, so the
  // accepted set here cannot drift from the one createCalibrationClip
  // enforces. That function stays the authority; this only lets the command
  // line refuse a typo before it opens a database connection.
  if (!isInVocabulary(CLIP_SAMPLING_REASONS, samplingReason)) {
    throw new Error(
      `Invalid --sampling-reason: "${samplingReason}" is not a recognised sampling reason. `
      + `One of: ${CLIP_SAMPLING_REASONS.join(', ')}`,
    );
  }

  return {
    organizationId: values.get('--organization-id') as string,
    videoSessionId: values.get('--video-session-id') as string,
    projectName: values.get('--project-name') as string,
    clipCode: values.get('--clip-code') as string,
    startMs: requireWholeMs(values.get('--start-ms') as string, '--start-ms'),
    endMs: requireWholeMs(values.get('--end-ms') as string, '--end-ms'),
    primarySamplingReason: samplingReason,
    createdByAccountId: values.get('--created-by-account-id') as string,
  };
}

/** Refuses a creator account that is not a LIVE member of the organization
 * being written to.
 *
 * MEMBERSHIP AND LIVENESS, AND DELIBERATELY NOT ROLE. Who may set up a
 * calibration study is an open owner question, so this still takes no view on
 * it: any live account in the organization is accepted, whatever its role.
 * What it will not accept is:
 *
 *   * an account from ANOTHER organization, because the schema cannot refuse
 *     one -- created_by_account_id references pilot.accounts(account_id)
 *     alone (a single-column foreign key), so the database proves only that
 *     the account exists somewhere on the platform;
 *   * an account that is INACTIVE or SOFT-DELETED, because the same foreign
 *     key is equally blind to those. active_flag and deleted_at are the two
 *     ways an account stops being someone the platform lets act, and neither
 *     is checked by anything between the operator and this INSERT.
 *
 * All of it matters for one reason: created_by_account_id is what the study row
 * itself says about who chose these clips. It is no longer the ONLY record --
 * recordCalibrationCreation now writes a dated audit row beside it -- but both
 * name the same account, so a bad value here becomes a provenance claim in two
 * places rather than one. A study in org A stamped with a coach from org B, or
 * with an account retired a year ago, is still a claim no later reader can
 * correct. The audit row dates the act; it does not check it. This does.
 *
 * Both prior operator-identity mechanisms in this repository read liveness,
 * and this follows them rather than inventing a third rule. assertActor in
 * scripts/import-shadow-research.mjs selects active_flag and refuses
 * SEED_ACCOUNT_INACTIVE (~:501-519). resolveApprover in
 * scripts/pilot-approve-library-baseline.mjs filters
 * `active_flag = true and deleted_at is null`, under the rule that "an
 * attestation by an account that cannot sign in is not an attestation"
 * (~:136-167). Signing a study is the same kind of act.
 */
async function assertCreatorInOrganization(
  organizationId: string,
  createdByAccountId: string,
): Promise<void> {
  const account = await queryOne<{ account_id: string }>(
    `select account_id
     from pilot.accounts
     where account_id = $1
       and organization_id = $2
       and active_flag = true
       and deleted_at is null`,
    [createdByAccountId, organizationId],
  );

  if (!account) {
    // ONE MESSAGE FOR ALL FOUR REFUSALS -- no such account, an account in
    // another organization, an inactive one, a soft-deleted one -- and that
    // is a choice, not a side effect of adding two predicates.
    //
    // Same shape as the source video's refusal: no existence oracle. An
    // operator learns nothing about whether an account exists in some other
    // organization. A distinct "that account is inactive" would be more
    // useful to whoever typed the id, but it confirms the account exists in
    // THIS organization, and this is a server module a route could later
    // call rather than only the CLI it has today. The two precedents above
    // do distinguish their reasons -- SEED_ACCOUNT_INACTIVE,
    // NO_ACTIVE_PLATFORM_OWNER -- and both are scripts run by someone who
    // already holds the connection string, so they have no oracle to give
    // away. This does not have that.
    //
    // The liveness predicate therefore lives in the WHERE clause rather than
    // in a second branch out here: there is exactly one refusal path, so a
    // later edit cannot add a second message without deciding to.
    throw new Error('Not found: no such account in this organization');
  }
}

/**
 * The audit row for one calibration creation.
 *
 * WHY THIS EXISTS AT ALL. created_by_account_id is recorded on both tables and
 * read by nothing -- not the annotator page, not adjudication, gold promotion,
 * blinding, comparison or the QA read model. The refusal above says that column
 * is "the only record of who chose these clips", and that was true in the worst
 * way: one column on one row, with nothing dated, nothing queryable, and no
 * trace at all of a study that was later renamed or deleted. This is the other
 * record. OD-2026-08-28-007: the creator must be a live account, AND the act
 * must be recorded.
 *
 * BARE 'create', WITH THE MEANING IN entity_type -- NOT A NEW EVENT TYPE, AND
 * THEREFORE NO MIGRATION. The event vocabulary is closed and declared twice on
 * purpose: auditEventTypes.ts holds the TypeScript union, a CHECK constraint on
 * pilot.audit_events.event_type mirrors it, and auditEventVocabulary.test.ts
 * fails when the two disagree -- so a value like 'calibration_project_created'
 * costs a migration on both. entity_type carries no constraint at all
 * (`entity_type text not null`, pilot_slice_postgres.sql), and calibration
 * already uses that fact: annotatorGate.ts writes
 * 'calibration_annotation_set' and 'calibration_annotation_event' under bare
 * 'create'/'update' and documents why. These two names extend that convention
 * rather than breaking it.
 *
 * shadow_mirror IS FORCED FALSE, for the reason annotatorGate.ts forces it:
 * calibration measures where trained humans disagree, and a disagreement corpus
 * that silently became model input would make the measurement unrepeatable --
 * the study would be observing a system it had already changed. That helper is
 * not reachable from here (it lives in the route tree and takes a
 * PilotPrincipal, which a command line has no way to produce), so the flag is
 * set again rather than imported. It is a literal at both call sites, so no
 * caller can turn it back on.
 *
 * THE ROW IS WRITTEN AFTER THE INSERT IT DESCRIBES, NEVER BEFORE. The ids are
 * minted in this module, so an audit row written first would survive a failed
 * insert and assert that a study exists which does not. A missing record is a
 * gap; a record of something that never happened is a fabricated fact, and this
 * subsystem exists not to produce those.
 *
 * IT IS NOT ATOMIC WITH THAT INSERT, AND CANNOT BE FROM HERE.
 * writePilotAuditEvent takes its own pooled connection, exactly as
 * createCalibrationProject and createCalibrationClip do -- the same reason the
 * catch below gives for why the two creates are not one transaction. Atomicity
 * would mean giving those two functions a client parameter, which is a change
 * to projects.ts rather than to its caller, and a different slice.
 *
 * The repository DOES have a transactional audit precedent, and it is named
 * here rather than left for a reviewer to raise: pilot.shadow_audit_entries
 * says in its own header that every write path in that loop writes its audit
 * row "inside the same transaction as its primary write". It does not transfer.
 * That is a second, purpose-built table written by code that already holds a
 * client; this is pilot.audit_events, reached through a shared helper, from a
 * caller that holds no client and may not hand one down. Which is a real
 * limitation, so the failure behaviour below is written to be honest about it
 * rather than to hide it.
 */
async function recordCalibrationCreation(input: {
  organizationId: string;
  actorAccountId: string;
  actorRole: PilotRole | null;
  entityType: 'calibration_project' | 'calibration_clip';
  entityId: string;
  details: Record<string, unknown>;
}): Promise<void> {
  await writePilotAuditEvent({
    event_type: 'create',
    actor_account_id: input.actorAccountId,
    actor_role: input.actorRole,
    organization_id: input.organizationId,
    entity_type: input.entityType,
    entity_id: input.entityId,
    details: input.details,
    shadow_mirror: false,
  });
}

/**
 * Creates the study and the clip, in that order, through the existing
 * services.
 *
 * THE SOURCE IS CHECKED FIRST, before the project row exists. Not for safety
 * -- createCalibrationClip checks it again and is the gate that matters -- but
 * so a refused SOURCE leaves nothing behind. Without this call, pointing the
 * bootstrap at a quarantined video would create an empty draft study and then
 * fail, and the operator's next attempt would be their second study.
 *
 * That covers the source and nothing else. A clip refused on its own merits
 * -- no width, an empty code, a duplicate code -- is refused after the study
 * exists, and the study stays. See the catch below, which names it rather
 * than pretending otherwise.
 *
 * The ids are minted here with randomUUID, the same way the annotation-set
 * and event routes mint theirs, because both services require the caller to
 * supply one and the repository has no other source for them. They are
 * opaque, and carry no meaning an operator could get wrong. Everything that
 * does carry meaning is required from the caller.
 *
 * A study NAME, by contrast, is unique per organization in the schema
 * (pilot_calibration_projects_name_uq), so re-running this with a name that
 * has already been used is refused by the database rather than quietly
 * creating a second study that looks like the first.
 *
 * EACH ROW IS AUDITED AS IT IS CREATED, and a failed audit write is NOT
 * swallowed. The whole point of OD-2026-08-28-007's second half is that the
 * act is recorded; a bootstrap that printed PASS while its record had failed to
 * write would be worse than today, because an operator would then believe an
 * audit trail existed. Nothing can be rolled back from here -- see
 * recordCalibrationCreation on why the writes cannot share a transaction -- so
 * the refusal names exactly what was left behind instead, which is the posture
 * this module already takes towards the stranded study below.
 */
export async function bootstrapCalibrationClip(
  request: CalibrationBootstrapRequest,
): Promise<CalibrationBootstrapResult> {
  await assertVideoClippable(request.organizationId, request.videoSessionId);
  await assertCreatorInOrganization(request.organizationId, request.createdByAccountId);

  // THE ROLE IS READ SEPARATELY, AND THE GATE ABOVE IS LEFT ALONE.
  //
  // getAccountRoleInOrganization is auth.ts's existing org-scoped role read, so
  // this reuses a primitive rather than widening assertCreatorInOrganization to
  // hand back a column it already had in reach. Two reasons, and the first is
  // the durable one:
  //
  //   * A GATE THAT RETURNS A ROLE INVITES A CALLER TO GATE ON IT.
  //     OD-2026-08-28-007 excludes a role requirement explicitly, and the
  //     refusal above says in its own words that it takes no view on role.
  //     Keeping it returning void keeps "who may open a study" and "what was
  //     recorded about the opening" two questions rather than one. RECORDING a
  //     role is not GATING on one, and nothing here refuses any role.
  //   * That function's SQL was being edited on another branch at the same
  //     time -- the liveness predicates it now carries arrived with #822 -- and
  //     a second branch extending the same query is a conflict nobody needed.
  //
  // Read BEFORE the project insert, so a failure here costs nothing: there is
  // no study yet to strand. A null role is passed through rather than defaulted
  // -- actor_role is nullable, and a role this code could not read is not a
  // role it may invent.
  const actorRole = await getAccountRoleInOrganization(
    request.createdByAccountId,
    request.organizationId,
  );

  const project = await createCalibrationProject({
    organizationId: request.organizationId,
    calibrationProjectId: randomUUID(),
    name: request.projectName,
    ontologyVersion: BOXING_ONTOLOGY_VERSION,
    createdByAccountId: request.createdByAccountId,
  });

  try {
    await recordCalibrationCreation({
      organizationId: project.organization_id,
      // The value the ROW carries, not the one the request asked for. They are
      // the same string today; taking it from the row means the audit trail
      // records what was actually written even if that ever stops being true.
      actorAccountId: project.created_by_account_id,
      actorRole,
      entityType: 'calibration_project',
      entityId: project.calibration_project_id,
      details: {
        name: project.name,
        ontology_version: project.ontology_version,
        // Always 'draft'. Recorded anyway, because "the study began unsettled"
        // is the claim createCalibrationProject's docblock makes and this is
        // the only place a later reader can check it against a timestamp.
        status: project.status,
      },
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `${reason} -- the study "${project.name}" (${project.calibration_project_id}) was `
      + 'created before its audit record could be written and still exists, unaudited and '
      + 'with no clips. Re-run with a different --project-name, or use that study.',
      { cause: error },
    );
  }

  let clip: CalibrationClipRow;

  try {
    clip = await createCalibrationClip({
      organizationId: request.organizationId,
      calibrationClipId: randomUUID(),
      calibrationProjectId: project.calibration_project_id,
      videoSessionId: request.videoSessionId,
      clipCode: request.clipCode,
      startMs: request.startMs,
      endMs: request.endMs,
      primarySamplingReason: request.primarySamplingReason,
      createdByAccountId: request.createdByAccountId,
    });
  } catch (error) {
    // THE STUDY SURVIVES A REFUSED CLIP, and saying so is the whole of this
    // catch. The two writes cannot be made one transaction from here:
    // createCalibrationProject and createCalibrationClip each take their own
    // pooled connection and neither accepts a client, so atomicity would be a
    // change to projects.ts rather than to its caller -- a different slice.
    //
    // What can be fixed here is the operator being left to discover it. A
    // study name is unique per organization, so a silent survivor turns the
    // obvious next move -- run it again with the same name -- into a
    // collision with a row nobody knew existed. Naming it costs one sentence
    // and makes the failure recoverable.
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `${reason} -- the study "${project.name}" (${project.calibration_project_id}) was `
      + 'created before the clip was refused and still exists, with no clips. Re-run with a '
      + 'different --project-name, or use that study.',
      { cause: error },
    );
  }

  // OUTSIDE THE CATCH ABOVE, DELIBERATELY. Folded in, a failure here would be
  // reported with that message -- "created before the clip was refused" -- and
  // the clip was not refused, it was created. An audit failure that describes
  // itself as a clip refusal sends the operator looking for a clip problem
  // that does not exist, in a module whose entire argument is that a record
  // nobody can correct later is worse than no record.
  try {
    await recordCalibrationCreation({
      organizationId: clip.organization_id,
      actorAccountId: clip.created_by_account_id,
      actorRole,
      entityType: 'calibration_clip',
      entityId: clip.calibration_clip_id,
      details: {
        calibration_project_id: clip.calibration_project_id,
        video_session_id: clip.video_session_id,
        clip_code: clip.clip_code,
        start_ms: clip.start_ms,
        end_ms: clip.end_ms,
        primary_sampling_reason: clip.primary_sampling_reason,
        // NO athlete_id, and that is a choice. The clip row already records the
        // attribution, this row names the clip, and copying a minor's
        // identifier into a second table buys a reader nothing they could not
        // already get. details.athlete_id is also load-bearing elsewhere --
        // api/pilot/audit/get scopes a coach's rows by it -- so putting one
        // here would enlist a relationship gate in a question it was not
        // written to answer.
      },
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `${reason} -- the study "${project.name}" (${project.calibration_project_id}) and its `
      + `clip ${clip.clip_code} (${clip.calibration_clip_id}) were created before the audit `
      + 'record for the clip could be written, and both still exist. Re-run with a different '
      + '--project-name, or use that study.',
      { cause: error },
    );
  }

  return { project, clip };
}
