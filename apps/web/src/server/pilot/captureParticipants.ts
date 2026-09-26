import { randomUUID } from 'node:crypto';

import { query, queryOne } from './db';

/**
 * THE RESTRICTED CONTROL PLANE for teaching media.
 *
 * Teaching media names nobody: a take-backed pilot.video_sessions row carries
 * capture_take_id and a NULL athlete_id. This module is the only way back from
 * that footage to a person, and it exists for exactly the three uses the owner
 * approved -- verify consent, enforce withdrawal, handle safeguarding events.
 *
 * WHAT MUST NOT IMPORT THIS. Anything that renders Teach Shadow, annotates it,
 * builds the corpus, or feeds a model. Those surfaces get the participant id at
 * most, never the athlete behind it; a teaching surface that resolved identity
 * would make "anonymous" a naming convention rather than a property. The Film
 * Study side does not use this at all -- it keeps video_sessions.athlete_id,
 * which is the whole distinction.
 *
 * WHY RESOLUTION IS A QUERY AND NOT A COLUMN. Putting the athlete back onto a
 * teaching table under a different name would be the same leak with better
 * manners: every later join would reach it. Keeping it one hop away means a
 * caller has to mean it.
 */

export interface CaptureParticipant {
  capture_participant_id: string;
  organization_id: string;
  athlete_id: string;
}

/**
 * The participant row for an athlete, created if this organization has never
 * filmed them before.
 *
 * ONE ROW PER ATHLETE PER ORGANIZATION, enforced by a unique index as well as
 * by this function. Two rows would split a person's footage across two
 * identities, and a guardian withdrawing consent would reach one of them while
 * footage hung off the other -- a withdrawal that silently does not withdraw.
 */
export async function ensureCaptureParticipant(params: {
  organizationId: string;
  athleteId: string;
  createdByAccountId: string;
}): Promise<CaptureParticipant> {
  const existing = await queryOne<CaptureParticipant>(
    `select capture_participant_id, organization_id, athlete_id
       from pilot.capture_participants
      where organization_id = $1 and athlete_id = $2`,
    [params.organizationId, params.athleteId],
  );
  if (existing) return existing;

  // ON CONFLICT rather than trusting the read above: two devices clearing the
  // same athlete at once would both see no row and both insert.
  const created = await queryOne<CaptureParticipant>(
    `insert into pilot.capture_participants
       (capture_participant_id, organization_id, athlete_id, created_by_account_id)
     values ($1, $2, $3, $4)
     on conflict (organization_id, athlete_id) do update
       set athlete_id = excluded.athlete_id
     returning capture_participant_id, organization_id, athlete_id`,
    [randomUUID(), params.organizationId, params.athleteId, params.createdByAccountId],
  );

  if (!created) {
    throw new Error('Could not establish a capture participant for this athlete.');
  }
  return created;
}

/** Records who a filming session is of. Idempotent. */
export async function linkParticipantToSession(params: {
  organizationId: string;
  recordingSessionId: string;
  captureParticipantId: string;
}): Promise<void> {
  await query(
    `insert into pilot.recording_session_participants
       (organization_id, recording_session_id, capture_participant_id)
     values ($1, $2, $3)
     on conflict (recording_session_id, capture_participant_id) do nothing`,
    [params.organizationId, params.recordingSessionId, params.captureParticipantId],
  );
}

/** Records who one teaching video is of. Idempotent. */
export async function linkParticipantToVideo(params: {
  organizationId: string;
  videoSessionId: string;
  captureParticipantId: string;
}): Promise<void> {
  await query(
    `insert into pilot.video_capture_participants
       (organization_id, video_session_id, capture_participant_id)
     values ($1, $2, $3)
     on conflict (video_session_id, capture_participant_id) do nothing`,
    [params.organizationId, params.videoSessionId, params.captureParticipantId],
  );
}

/**
 * The participants of a filming session, so a device joining by code inherits
 * who is being filmed WITHOUT being told who that is. The join surface never
 * sees these ids; the server uses them to attach the joining device's upload.
 */
export async function participantsForSession(
  organizationId: string,
  recordingSessionId: string,
): Promise<string[]> {
  const rows = await query<{ capture_participant_id: string }>(
    `select capture_participant_id
       from pilot.recording_session_participants
      where organization_id = $1 and recording_session_id = $2`,
    [organizationId, recordingSessionId],
  );
  return rows.map((row) => row.capture_participant_id);
}

/**
 * RESTRICTED. The athletes behind a set of participant ids.
 *
 * Used at upload time, where the participants come from the session and the
 * consent check needs the people behind them. Org-scoped for the same reason
 * as every other read here: a participant id from another gym resolves to
 * nothing rather than to somebody.
 */
export async function athleteIdsForParticipants(
  organizationId: string,
  captureParticipantIds: string[],
): Promise<string[]> {
  if (captureParticipantIds.length === 0) return [];
  const rows = await query<{ athlete_id: string }>(
    `select athlete_id
       from pilot.capture_participants
      where organization_id = $1 and capture_participant_id = any($2::text[])`,
    [organizationId, captureParticipantIds],
  );
  return rows.map((row) => row.athlete_id);
}

/**
 * RESTRICTED. The athletes behind one teaching video.
 *
 * Org-scoped, so a caller holding a video id from another gym resolves
 * nothing. Returns ids rather than names: a caller that needs a name has to
 * go and read the athlete, which is a separate, auditable act.
 */
export async function resolveParticipantAthleteIds(
  organizationId: string,
  videoSessionId: string,
): Promise<string[]> {
  const rows = await query<{ athlete_id: string }>(
    `select cp.athlete_id
       from pilot.video_capture_participants vcp
       join pilot.capture_participants cp
         on cp.organization_id = vcp.organization_id
        and cp.capture_participant_id = vcp.capture_participant_id
      where vcp.organization_id = $1 and vcp.video_session_id = $2`,
    [organizationId, videoSessionId],
  );
  return rows.map((row) => row.athlete_id);
}

export interface ScanSubject {
  /** True when this is Teach Shadow media, i.e. it carries a take. */
  isTeaching: boolean;
  /**
   * Who must have consented. For Film Study this is the video's own
   * athlete_id; for teaching media it is resolved through the restricted
   * link. Empty means nobody could be resolved, which every caller must
   * treat as "cannot verify", never as "nobody to ask".
   */
  athleteIds: string[];
}

/**
 * WHO THE SCAN MUST ASK ABOUT, for either destination, in one lookup.
 *
 * The sweep cannot key consent off video_sessions.athlete_id any more: a
 * teaching row deliberately has none. It also must not simply skip a row with
 * no athlete -- that used to mean "an unattributed team upload with no
 * guardian to ask", and now it is also what every properly anonymised
 * teaching video looks like. Treating the two alike would send a child's
 * footage to the content screen with no consent check at all, which is the
 * failure this whole slice exists to prevent.
 *
 * Deliberately its own query rather than widening the claim's RETURNING or the
 * shared VideoSessionRecord. Both are read by suites that build narrower
 * schemas, and widening a shared read to answer one caller's question is what
 * broke CI on the previous slice.
 */
export async function resolveScanSubject(
  organizationId: string,
  videoSessionId: string,
): Promise<ScanSubject> {
  const row = await queryOne<{ capture_take_id: string | null; athlete_id: string | null }>(
    `select capture_take_id, athlete_id
       from pilot.video_sessions
      where organization_id = $1 and video_session_id = $2`,
    [organizationId, videoSessionId],
  );

  if (!row) return { isTeaching: false, athleteIds: [] };

  if (row.capture_take_id === null) {
    return { isTeaching: false, athleteIds: row.athlete_id ? [row.athlete_id] : [] };
  }

  return {
    isTeaching: true,
    athleteIds: await resolveParticipantAthleteIds(organizationId, videoSessionId),
  };
}
