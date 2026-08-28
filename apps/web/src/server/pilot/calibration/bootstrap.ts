import { randomUUID } from 'node:crypto';

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

/** Refuses a creator account that is not in the organization being written to.
 *
 * MEMBERSHIP ONLY, AND DELIBERATELY NOT ROLE. Who may set up a calibration
 * study is an open owner question, so this takes no view on it: any account
 * in the organization is accepted, exactly as before. What it will not accept
 * is an account from ANOTHER organization, because the schema cannot refuse
 * one -- created_by_account_id references pilot.accounts(account_id) alone
 * (a single-column foreign key), so the database proves only that the account
 * exists somewhere on the platform.
 *
 * That matters because calibration writes no audit event: created_by_account_id
 * is the only record of who chose these clips, and a study in org A stamped
 * with a coach from org B is a provenance claim no later reader can correct.
 * assertActor in scripts/import-shadow-research.mjs makes the same check for
 * the same reason.
 */
async function assertCreatorInOrganization(
  organizationId: string,
  createdByAccountId: string,
): Promise<void> {
  const account = await queryOne<{ account_id: string }>(
    `select account_id
     from pilot.accounts
     where account_id = $1 and organization_id = $2`,
    [createdByAccountId, organizationId],
  );

  if (!account) {
    // Same shape as the source video's refusal: no existence oracle. An
    // operator learns nothing about whether an account exists in some other
    // organization.
    throw new Error('Not found: no such account in this organization');
  }
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
 */
export async function bootstrapCalibrationClip(
  request: CalibrationBootstrapRequest,
): Promise<CalibrationBootstrapResult> {
  await assertVideoClippable(request.organizationId, request.videoSessionId);
  await assertCreatorInOrganization(request.organizationId, request.createdByAccountId);

  const project = await createCalibrationProject({
    organizationId: request.organizationId,
    calibrationProjectId: randomUUID(),
    name: request.projectName,
    ontologyVersion: BOXING_ONTOLOGY_VERSION,
    createdByAccountId: request.createdByAccountId,
  });

  try {
    const clip = await createCalibrationClip({
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

    return { project, clip };
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
}
