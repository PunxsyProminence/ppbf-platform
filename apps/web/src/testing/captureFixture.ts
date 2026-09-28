/*
 * A RECORDING SESSION AND ONE OPEN TAKE, for Postgres suites whose subject is
 * what happens to STUDY FOOTAGE.
 *
 * WHY THESE SUITES NEED IT NOW. Cutting a calibration clip is how footage
 * becomes evidence a recognizer is taught from, and the owner's ruling is that
 * only footage recorded to teach Shadow may be used that way. assertVideoClippable
 * therefore refuses a video with no capture take -- which is every video these
 * fixtures used to insert, because they were written before takes existed.
 *
 * The fixtures were not wrong so much as pre-dated: a video a study cuts a clip
 * from is, by definition, teaching footage, and now it has to say so. Giving
 * them a take is describing them accurately, not working around a guard.
 *
 * ONE SESSION AND ONE TAKE PER ORGANIZATION is enough. Nothing in these suites
 * is about grouping; they need the video to be teaching footage, and the take
 * is what says so. A suite that wants two angles of one attempt can pass the
 * same take id to two videos.
 */

interface Queryable {
  query(sql: string, params?: unknown[]): Promise<unknown>;
}

export interface CaptureFixtureIds {
  recordingSessionId: string;
  captureTakeId: string;
}

/**
 * Seeds one recording session and its first take, both closed.
 *
 * Idempotent, like the rest of these fixtures: `on conflict do nothing`, so a
 * suite that seeds per test does not fight its own previous run.
 *
 * Seeded CLOSED, both the session and the take. Nothing here is recording, and
 * the two partial unique indexes -- one open take per session, one live join
 * code per organization -- only cover open rows, so several organizations can
 * be seeded in one database without contriving distinct codes.
 */
export async function seedCaptureTake(
  client: Queryable,
  options: { organizationId: string; createdByAccountId: string; suffix?: string },
): Promise<CaptureFixtureIds> {
  const suffix = options.suffix ?? 'a';
  const recordingSessionId = `rs-fixture-${options.organizationId}-${suffix}`;
  const captureTakeId = `take-fixture-${options.organizationId}-${suffix}`;

  await client.query(
    `insert into pilot.recording_sessions
       (recording_session_id, organization_id, created_by_account_id, training_context, join_code, state)
     values ($1, $2, $3, 'heavy_bag', $4, 'closed')
     on conflict do nothing`,
    [
      recordingSessionId,
      options.organizationId,
      options.createdByAccountId,
      // 'closed', and the code is therefore outside the partial unique index
      // on open sessions -- two organizations seeded in one database cannot
      // collide however similar their ids.
      `FX${suffix.toUpperCase()}${options.organizationId.replace(/[^A-Z0-9]/gi, '').slice(-4).toUpperCase()}`.slice(0, 12),
    ],
  );

  await client.query(
    `insert into pilot.capture_takes
       (capture_take_id, recording_session_id, organization_id, take_number, state)
     values ($1, $2, $3, 1, 'closed')
     on conflict do nothing`,
    [captureTakeId, recordingSessionId, options.organizationId],
  );

  return { recordingSessionId, captureTakeId };
}
