import { query, queryOne } from '../db';
import { getVideoSessionById } from '../videoSessions';
import {
  BOXING_ONTOLOGY_VERSION,
  CALIBRATION_PROJECT_STATUSES,
  CLIP_SAMPLING_REASONS,
  isInVocabulary,
  type CalibrationProjectStatus,
  type ClipSamplingReason,
} from './ontology';

// Calibration projects and clips -- the write and read paths for defining a
// human-annotation experiment over footage the platform already holds.
//
// WHAT THIS MODULE REFUSES, stated once so every function below can be read
// against it:
//
//   * A video that is not 'ready'. Quarantine is not opened here.
//   * A video, project or athlete in another organization.
//   * A vocabulary value this build does not recognise -- rejected, never
//     coerced to a default or to 'unknown'.
//   * A clip with no width.
//
// WHAT IT DOES NOT DO. It writes no athlete record, emits no SHADOW event,
// produces no score, and is read by no coaching surface. A calibration clip
// says "two people are going to label this span"; it says nothing about the
// boxer in it.

/** The video states a clip may be cut from.
 *
 * EXACTLY ONE, and it is the same literal the three existing playback paths
 * check ([videoId]/route.ts, publications/create, shadow/video-analysis).
 *
 * Quarantined footage is deliberately absent. It IS reachable elsewhere --
 * authorizeVideoScanReview mints a 15-minute link for a safeguarding reviewer
 * -- and that is a different act with a different justification: looking at
 * footage flagged as possibly unsafe, in order to decide about it. Annotating
 * it into a research corpus is not that act. Building calibration on top of
 * the quarantine review path would turn a narrow safeguarding exception into
 * a general-purpose way to watch unscanned video of minors, which is the
 * outcome this constant exists to prevent. */
const CLIPPABLE_VIDEO_STATUS = 'ready';

export interface CalibrationProjectRow {
  organization_id: string;
  calibration_project_id: string;
  name: string;
  ontology_version: string;
  status: string;
  created_by_account_id: string;
  created_at: string;
  updated_at: string;
}

export interface CalibrationClipRow {
  organization_id: string;
  calibration_clip_id: string;
  calibration_project_id: string;
  video_session_id: string;
  athlete_id: string | null;
  clip_code: string;
  start_ms: number;
  end_ms: number;
  primary_sampling_reason: string;
  created_by_account_id: string;
  created_at: string;
}

const PROJECT_COLUMNS = `
  organization_id, calibration_project_id, name, ontology_version, status,
  created_by_account_id, created_at, updated_at
`;

const CLIP_COLUMNS = `
  organization_id, calibration_clip_id, calibration_project_id, video_session_id,
  athlete_id, clip_code, start_ms, end_ms, primary_sampling_reason,
  created_by_account_id, created_at
`;

/**
 * A millisecond offset, or a refusal.
 *
 * WHY THIS IS STRICTER THAN Number(). `Number('')` is 0, `Number(' 12 ')` is
 * 12, `Number(null)` is 0, and `Number(true)` is 1. Every one of those would
 * turn a missing or malformed bound into a confident, wrong timestamp -- and
 * a clip silently starting at 0 because a field arrived empty is precisely
 * the kind of fabricated datum this subsystem exists not to produce.
 *
 * Rejects non-integers too. A start of 12.5 ms is not a finer measurement
 * than 12; it is a number that came from somewhere this code cannot account
 * for.
 */
function requireOffsetMs(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(`Missing ${field}: expected a whole number of milliseconds, zero or greater`);
  }
  // The column is `integer`. A value beyond its range would be a database
  // error at insert time; catching it here makes it a 400 naming the field
  // rather than a 500 naming a constraint.
  if (value > 2_147_483_647) {
    throw new Error(`Missing ${field}: exceeds the maximum supported video offset`);
  }
  return value;
}

function requireNonEmpty(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Missing ${field}`);
  }
  return value.trim();
}

/**
 * The ontology version a new project may be created under.
 *
 * Only the version this build actually implements. A project stamped
 * 'boxing-ontology-0.2' by a client would be a row whose vocabulary no code
 * here can validate against -- its events would be checked by 0.1's rules
 * while claiming to be 0.2, which is worse than refusing outright.
 *
 * The DATABASE deliberately accepts any non-empty string, so historical rows
 * under an older version keep their true stamp and remain readable. It is
 * only CREATION that is pinned, and pinning it here rather than in a CHECK
 * means the next version is a code change, not a migration.
 */
function requireSupportedOntologyVersion(value: unknown): string {
  const version = requireNonEmpty(value, 'ontology_version');
  if (version !== BOXING_ONTOLOGY_VERSION) {
    throw new Error(
      `Missing ontology_version: this build implements ${BOXING_ONTOLOGY_VERSION} and cannot validate ${version}`,
    );
  }
  return version;
}

export interface CreateCalibrationProjectInput {
  organizationId: string;
  calibrationProjectId: string;
  name: string;
  ontologyVersion: string;
  createdByAccountId: string;
}

/**
 * Opens a calibration study.
 *
 * Always starts at 'draft'. There is no input that can create a project
 * already in 'annotating' or 'completed' -- a study that begins settled has
 * no honest account of when its clips were chosen, and the status column is
 * the only record of that sequence.
 */
export async function createCalibrationProject(
  input: CreateCalibrationProjectInput,
): Promise<CalibrationProjectRow> {
  const name = requireNonEmpty(input.name, 'name');
  const ontologyVersion = requireSupportedOntologyVersion(input.ontologyVersion);

  const row = await queryOne<CalibrationProjectRow>(
    `insert into pilot.calibration_projects
       (organization_id, calibration_project_id, name, ontology_version, status, created_by_account_id)
     values ($1, $2, $3, $4, 'draft', $5)
     returning ${PROJECT_COLUMNS}`,
    [
      input.organizationId,
      requireNonEmpty(input.calibrationProjectId, 'calibration_project_id'),
      name,
      ontologyVersion,
      requireNonEmpty(input.createdByAccountId, 'created_by_account_id'),
    ],
  );

  if (!row) {
    throw new Error('CALIBRATION_PROJECT_WRITE_FAILED');
  }
  return row;
}

export async function getCalibrationProject(
  organizationId: string,
  calibrationProjectId: string,
): Promise<CalibrationProjectRow | null> {
  return queryOne<CalibrationProjectRow>(
    `select ${PROJECT_COLUMNS}
     from pilot.calibration_projects
     where organization_id = $1 and calibration_project_id = $2`,
    [organizationId, calibrationProjectId],
  );
}

export async function listCalibrationProjects(
  organizationId: string,
): Promise<CalibrationProjectRow[]> {
  return query<CalibrationProjectRow>(
    `select ${PROJECT_COLUMNS}
     from pilot.calibration_projects
     where organization_id = $1
     order by created_at desc, calibration_project_id asc`,
    [organizationId],
  );
}

/**
 * Moves a project through its workflow.
 *
 * Org-scoped in the WHERE, so a project id from another organization updates
 * nothing and returns null rather than throwing -- the caller turns that into
 * the same 404 a nonexistent project gets, which is what keeps this from
 * being an oracle for whether another gym is running a study.
 */
export async function setCalibrationProjectStatus(
  organizationId: string,
  calibrationProjectId: string,
  status: CalibrationProjectStatus,
): Promise<CalibrationProjectRow | null> {
  if (!isInVocabulary(CALIBRATION_PROJECT_STATUSES, status)) {
    throw new Error(`Missing status: not a calibration project status`);
  }

  return queryOne<CalibrationProjectRow>(
    `update pilot.calibration_projects
        set status = $3, updated_at = now()
      where organization_id = $1 and calibration_project_id = $2
      returning ${PROJECT_COLUMNS}`,
    [organizationId, calibrationProjectId, status],
  );
}

/** Raised when a video cannot be the source of a calibration clip.
 *
 * Carries the status it found so an operator can tell "still in quarantine,
 * come back after the scan" apart from "this video does not exist here" --
 * two situations with the same answer and very different next actions. The
 * ROUTE is what decides how much of that reaches a client; the distinction
 * exists here so it is available to be withheld deliberately rather than
 * lost. */
export class VideoNotClippableError extends Error {
  readonly videoStatus: string | null;

  constructor(videoStatus: string | null) {
    super(
      videoStatus === null
        ? 'Not found: no such video in this organization'
        : `Forbidden: video is not available for calibration (status ${videoStatus})`,
    );
    this.name = 'VideoNotClippableError';
    this.videoStatus = videoStatus;
  }
}

/**
 * The gate every calibration read and write of a video passes through.
 *
 * CALLED AT READ TIME, NOT ONLY AT CLIP CREATION, and that is the point. A
 * video can leave 'ready' after a clip is cut -- a late scanner verdict, an
 * admin block, an archive. If annotation trusted the clip row, a video the
 * platform had since decided nobody may watch would go on being served to
 * annotators forever, because the clip remembered a permission that had been
 * withdrawn. The clip row is a pointer, never a cached grant.
 *
 * Returns the athlete_id from the VIDEO rather than accepting one from the
 * caller, so the athlete a clip is attributed to is always the one the
 * footage is actually attributed to.
 */
export async function assertVideoClippable(
  organizationId: string,
  videoSessionId: string,
): Promise<{ videoSessionId: string; athleteId: string | null }> {
  const video = await getVideoSessionById(organizationId, videoSessionId);

  if (!video) {
    throw new VideoNotClippableError(null);
  }
  if (video.status !== CLIPPABLE_VIDEO_STATUS) {
    throw new VideoNotClippableError(video.status);
  }

  return { videoSessionId: video.video_session_id, athleteId: video.athlete_id };
}

export interface CreateCalibrationClipInput {
  organizationId: string;
  calibrationClipId: string;
  calibrationProjectId: string;
  videoSessionId: string;
  clipCode: string;
  startMs: number;
  endMs: number;
  primarySamplingReason: ClipSamplingReason;
  createdByAccountId: string;
}

/**
 * Marks out a span of an existing video for annotation.
 *
 * NO ATHLETE ID PARAMETER, deliberately. It is read from the video row inside
 * assertVideoClippable. A caller-supplied athlete_id could attribute a clip
 * to a boxer who is not in the footage -- and since the composite foreign key
 * only proves the athlete is in the same ORGANIZATION, the database could not
 * catch it. Taking it from the source removes the possibility rather than
 * guarding against it.
 *
 * The bounds are checked here AND by pilot_calibration_clips_bounds. The
 * duplication is intended: this one names the field in a 400, the constraint
 * is what makes the invariant true for every writer, including one that
 * bypasses this function.
 */
export async function createCalibrationClip(
  input: CreateCalibrationClipInput,
): Promise<CalibrationClipRow> {
  const startMs = requireOffsetMs(input.startMs, 'start_ms');
  const endMs = requireOffsetMs(input.endMs, 'end_ms');

  if (startMs >= endMs) {
    throw new Error('Missing end_ms: a clip must end after it starts');
  }

  if (!isInVocabulary(CLIP_SAMPLING_REASONS, input.primarySamplingReason)) {
    throw new Error('Missing primary_sampling_reason: not a recognised sampling reason');
  }

  const { videoSessionId, athleteId } = await assertVideoClippable(
    input.organizationId,
    requireNonEmpty(input.videoSessionId, 'video_session_id'),
  );

  const row = await queryOne<CalibrationClipRow>(
    `insert into pilot.calibration_clips
       (organization_id, calibration_clip_id, calibration_project_id, video_session_id,
        athlete_id, clip_code, start_ms, end_ms, primary_sampling_reason, created_by_account_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     returning ${CLIP_COLUMNS}`,
    [
      input.organizationId,
      requireNonEmpty(input.calibrationClipId, 'calibration_clip_id'),
      requireNonEmpty(input.calibrationProjectId, 'calibration_project_id'),
      videoSessionId,
      athleteId,
      requireNonEmpty(input.clipCode, 'clip_code'),
      startMs,
      endMs,
      input.primarySamplingReason,
      requireNonEmpty(input.createdByAccountId, 'created_by_account_id'),
    ],
  );

  if (!row) {
    throw new Error('CALIBRATION_CLIP_WRITE_FAILED');
  }
  return row;
}

export async function listCalibrationClips(
  organizationId: string,
  calibrationProjectId: string,
): Promise<CalibrationClipRow[]> {
  return query<CalibrationClipRow>(
    `select ${CLIP_COLUMNS}
     from pilot.calibration_clips
     where organization_id = $1 and calibration_project_id = $2
     order by clip_code asc`,
    [organizationId, calibrationProjectId],
  );
}

export async function getCalibrationClip(
  organizationId: string,
  calibrationClipId: string,
): Promise<CalibrationClipRow | null> {
  return queryOne<CalibrationClipRow>(
    `select ${CLIP_COLUMNS}
     from pilot.calibration_clips
     where organization_id = $1 and calibration_clip_id = $2`,
    [organizationId, calibrationClipId],
  );
}
