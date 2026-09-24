import { randomInt, randomUUID } from 'node:crypto';

import { query, queryOne, withTransaction } from './db';

/*
 * CAP-VID-01: grouped multi-angle capture.
 *
 * Several coaches film the same punch from different positions, each on their
 * own phone, each producing a separate file. This module is what lets the
 * platform know those files belong together.
 *
 * THE JOIN CODE IS CORRELATION, NOT AUTHORIZATION. Knowing a code lets a
 * device say WHICH session it is joining. It never says the device MAY join:
 * every route here independently requires an authenticated coach or
 * organization_admin of the owning organization, and the code is matched only
 * within that organization. This is the opposite of activation.ts, where the
 * code IS the credential and is therefore hashed and never re-displayed. A
 * reader who assumes the two are the same shape will either hash this one
 * pointlessly or, far worse, treat that one as public.
 */

// Crockford-style base32, the same alphabet activation codes use and for the
// same reason: this gets read aloud across a gym or off one phone screen onto
// another. I, L, O and U are absent because I/1, L/1 and O/0 are routinely
// mis-transcribed and U turns accidental codes into unfortunate words.
const JOIN_CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const JOIN_CODE_LENGTH = 6;

// Six characters from a 32-symbol alphabet is about a billion combinations,
// which would be far too few if this were a credential. It is not: a code only
// has to be unambiguous among the sessions currently OPEN in one organization,
// which in a gym is a handful. Length is set by what a coach can read across a
// room, not by guessing resistance.
const JOIN_CODE_ATTEMPTS = 8;

export const TRAINING_CONTEXTS = [
  'shadowboxing',
  'heavy_bag',
  'mitts',
  'sparring',
  'other',
] as const;

export type TrainingContext = (typeof TRAINING_CONTEXTS)[number];

export const CAPTURE_SOURCES = ['in_app_recording', 'file_upload'] as const;
export type CaptureSource = (typeof CAPTURE_SOURCES)[number];

export class CaptureSessionNotFoundError extends Error {
  constructor() {
    super('Not found: no open recording session for that code');
    this.name = 'CaptureSessionNotFoundError';
  }
}

export interface RecordingSession {
  recordingSessionId: string;
  organizationId: string;
  createdByAccountId: string;
  trainingContext: TrainingContext;
  joinCode: string;
  state: 'open' | 'closed';
  createdAt: string;
}

export interface CaptureTake {
  captureTakeId: string;
  recordingSessionId: string;
  takeNumber: number;
  state: 'open' | 'closed';
  createdAt: string;
}

interface RecordingSessionRow {
  recording_session_id: string;
  organization_id: string;
  created_by_account_id: string;
  training_context: TrainingContext;
  join_code: string;
  state: 'open' | 'closed';
  created_at: string;
}

interface CaptureTakeRow {
  capture_take_id: string;
  recording_session_id: string;
  take_number: number;
  state: 'open' | 'closed';
  created_at: string;
}

function toSession(row: RecordingSessionRow): RecordingSession {
  return {
    recordingSessionId: row.recording_session_id,
    organizationId: row.organization_id,
    createdByAccountId: row.created_by_account_id,
    trainingContext: row.training_context,
    joinCode: row.join_code,
    state: row.state,
    createdAt: row.created_at,
  };
}

function toTake(row: CaptureTakeRow): CaptureTake {
  return {
    captureTakeId: row.capture_take_id,
    recordingSessionId: row.recording_session_id,
    takeNumber: row.take_number,
    state: row.state,
    createdAt: row.created_at,
  };
}

export function generateJoinCode(): string {
  let code = '';
  for (let index = 0; index < JOIN_CODE_LENGTH; index += 1) {
    code += JOIN_CODE_ALPHABET[randomInt(JOIN_CODE_ALPHABET.length)];
  }
  return code;
}

/*
 * Folds the glyphs people actually mistype onto what the alphabet uses, so a
 * coach who reads O for 0 or I for 1 gets into the session instead of being
 * told the code is wrong. Same treatment activation codes get, for the same
 * reason -- and it is safe HERE for an additional reason: widening what a code
 * matches cannot widen access, because the code grants none.
 */
export function normalizeJoinCode(raw: string): string {
  return raw
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, '')
    .replace(/[IL]/g, '1')
    .replace(/O/g, '0')
    .replace(/U/g, 'V');
}

export async function createRecordingSession(params: {
  organizationId: string;
  createdByAccountId: string;
  trainingContext: TrainingContext;
}): Promise<{ session: RecordingSession; take: CaptureTake }> {
  return withTransaction(async (client) => {
    /*
     * Retried rather than pre-checked. A SELECT-then-INSERT would be a race:
     * two coaches starting sessions at the same moment can both read a code as
     * free. The partial unique index on (organization_id, join_code) where the
     * session is open is the actual arbiter, so the loop simply asks it and
     * tries another code if it says no. Bounded because an unbounded retry on
     * a genuinely full keyspace is an infinite loop, not a resilience feature.
     */
    for (let attempt = 0; attempt < JOIN_CODE_ATTEMPTS; attempt += 1) {
      const recordingSessionId = randomUUID();
      const joinCode = generateJoinCode();
      const inserted = await client.query<RecordingSessionRow>(
        `insert into pilot.recording_sessions
           (recording_session_id, organization_id, created_by_account_id, training_context, join_code)
         values ($1, $2, $3, $4, $5)
         on conflict do nothing
         returning recording_session_id, organization_id, created_by_account_id,
                   training_context, join_code, state, created_at`,
        [recordingSessionId, params.organizationId, params.createdByAccountId, params.trainingContext, joinCode],
      );

      if (inserted.rows.length === 0) {
        continue;
      }

      const take = await client.query<CaptureTakeRow>(
        `insert into pilot.capture_takes
           (capture_take_id, recording_session_id, organization_id, take_number)
         values ($1, $2, $3, 1)
         returning capture_take_id, recording_session_id, take_number, state, created_at`,
        [randomUUID(), recordingSessionId, params.organizationId],
      );

      return { session: toSession(inserted.rows[0]), take: toTake(take.rows[0]) };
    }

    throw new Error('Unsupported: could not allocate a join code, try again');
  });
}

/*
 * Resolving a code to a session. ORGANIZATION-SCOPED AND OPEN-ONLY: a code
 * from another gym, or from a session that has been closed, is not found --
 * and "not found" is the same answer for both, so the caller cannot use this
 * to learn that some other organization has a session by that code.
 */
export async function findOpenSessionByJoinCode(
  organizationId: string,
  rawJoinCode: string,
): Promise<RecordingSession | null> {
  const row = await queryOne<RecordingSessionRow>(
    `select recording_session_id, organization_id, created_by_account_id,
            training_context, join_code, state, created_at
       from pilot.recording_sessions
      where organization_id = $1 and join_code = $2 and state = 'open'`,
    [organizationId, normalizeJoinCode(rawJoinCode)],
  );
  return row ? toSession(row) : null;
}

export async function getOpenTake(recordingSessionId: string): Promise<CaptureTake | null> {
  const row = await queryOne<CaptureTakeRow>(
    `select capture_take_id, recording_session_id, take_number, state, created_at
       from pilot.capture_takes
      where recording_session_id = $1 and state = 'open'`,
    [recordingSessionId],
  );
  return row ? toTake(row) : null;
}

export async function getSessionById(
  organizationId: string,
  recordingSessionId: string,
): Promise<RecordingSession | null> {
  const row = await queryOne<RecordingSessionRow>(
    `select recording_session_id, organization_id, created_by_account_id,
            training_context, join_code, state, created_at
       from pilot.recording_sessions
      where organization_id = $1 and recording_session_id = $2`,
    [organizationId, recordingSessionId],
  );
  return row ? toSession(row) : null;
}

/*
 * Ends the current take and opens the next one, in one transaction.
 *
 * WHY BOTH HALVES TOGETHER: the database allows only one open take per session
 * (a partial unique index). Closing and opening as two statements would leave a
 * window with none open, during which a device that pressed record would have
 * nothing to attach its file to. One transaction means the session always has
 * exactly one current attempt from every reader's point of view.
 *
 * Coaches do not re-enter the join code between punches. Devices join the
 * SESSION; takes advance inside it.
 */
export async function advanceTake(params: {
  organizationId: string;
  recordingSessionId: string;
}): Promise<CaptureTake> {
  return withTransaction(async (client) => {
    const session = await client.query<{ state: string }>(
      `select state from pilot.recording_sessions
        where organization_id = $1 and recording_session_id = $2
        for update`,
      [params.organizationId, params.recordingSessionId],
    );
    if (session.rows.length === 0) {
      throw new CaptureSessionNotFoundError();
    }
    if (session.rows[0].state !== 'open') {
      throw new Error('Unsupported: that recording session is closed');
    }

    await client.query(
      `update pilot.capture_takes
          set state = 'closed', closed_at = now()
        where recording_session_id = $1 and state = 'open'`,
      [params.recordingSessionId],
    );

    const next = await client.query<CaptureTakeRow>(
      `insert into pilot.capture_takes
         (capture_take_id, recording_session_id, organization_id, take_number)
       values (
         $1, $2, $3,
         coalesce((select max(take_number) from pilot.capture_takes where recording_session_id = $2), 0) + 1
       )
       returning capture_take_id, recording_session_id, take_number, state, created_at`,
      [randomUUID(), params.recordingSessionId, params.organizationId],
    );

    return toTake(next.rows[0]);
  });
}

/*
 * TAKES THE SAME SESSION LOCK advanceTake TAKES, FIRST, and that ordering is
 * the entire correctness of this function.
 *
 * It did not, and the interleaving that produced was real: a close could shut
 * the open take, an advance already holding the session could then create take
 * N+1 as open, and the close would finally mark the session closed. End state:
 * a CLOSED session with an OPEN take -- precisely the contradiction the take
 * table exists to prevent, reached without either statement being wrong on its
 * own.
 *
 * Both writers now claim the same row before touching takes, so one waits for
 * the other and sees its committed result. Mocked tests cannot catch this;
 * only the lock ordering prevents it.
 */
export async function closeRecordingSession(params: {
  organizationId: string;
  recordingSessionId: string;
}): Promise<void> {
  await withTransaction(async (client) => {
    await client.query(
      `select 1 from pilot.recording_sessions
        where organization_id = $1 and recording_session_id = $2
        for update`,
      [params.organizationId, params.recordingSessionId],
    );

    await client.query(
      `update pilot.capture_takes
          set state = 'closed', closed_at = now()
        where recording_session_id = $1 and state = 'open'`,
      [params.recordingSessionId],
    );
    await client.query(
      `update pilot.recording_sessions
          set state = 'closed', closed_at = now()
        where organization_id = $1 and recording_session_id = $2 and state = 'open'`,
      [params.organizationId, params.recordingSessionId],
    );
  });
}

export interface TakeFile {
  videoSessionId: string;
  cameraViewId: string;
  cameraView: string | null;
  uploadedByAccountId: string;
  status: string;
  recordedAt: string | null;
  createdAt: string;
}

// Every file recorded against one attempt, which is what the capture surface
// shows the coaches so they can see their angles arriving.
export async function listTakeFiles(
  organizationId: string,
  captureTakeId: string,
): Promise<TakeFile[]> {
  const rows = await query<{
    video_session_id: string;
    camera_view_id: string | null;
    camera_view: string | null;
    uploaded_by_account_id: string;
    status: string;
    recorded_at: string | null;
    created_at: string;
  }>(
    `select video_session_id, camera_view_id, camera_view, uploaded_by_account_id,
            status, recorded_at, created_at
       from pilot.video_sessions
      where organization_id = $1 and capture_take_id = $2
      order by created_at asc`,
    [organizationId, captureTakeId],
  );

  return rows.map((row) => ({
    videoSessionId: row.video_session_id,
    cameraViewId: row.camera_view_id ?? row.video_session_id,
    cameraView: row.camera_view,
    uploadedByAccountId: row.uploaded_by_account_id,
    status: row.status,
    recordedAt: row.recorded_at,
    createdAt: row.created_at,
  }));
}
