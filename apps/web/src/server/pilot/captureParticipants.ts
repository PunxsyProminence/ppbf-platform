import { queryOne } from './db';

/**
 * WHICH DESTINATION A VIDEO BELONGS TO.
 *
 * Teaching media names nobody: a take-backed pilot.video_sessions row carries
 * capture_take_id and a NULL athlete_id, and no runtime path attaches a person
 * to it. Film Study keeps its athlete_id, and that difference is the whole
 * distinction this module answers.
 *
 * WHY IT EXISTS AT ALL. The scan sweep used to key consent and escalation off
 * video_sessions.athlete_id, where a null meant "an unattributed team upload
 * with nobody to ask". Every correctly anonymous teaching video now looks
 * exactly like that, so the sweep needs something that tells the two apart --
 * otherwise it would treat a child's teaching footage as an anonymous upload
 * and apply the wrong rules to it.
 *
 * THE PARTICIPANT TABLES ARE RETAINED SCHEMA, NOT A LIVE PATH. They were
 * built when teaching capture cleared a named participant; the owner then
 * ruled that filming to teach the recognizer is never restricted and names no
 * one, so clearance was deleted and nothing writes to them. They are left in
 * place rather than dropped, because an applied migration is not rewritten to
 * tidy history.
 */

export interface ScanSubject {
  /** True when this is Teach Shadow media, i.e. it carries a take. */
  isTeaching: boolean;
  /**
   * Who must be reachable. Film Study resolves its own athlete_id. Teach
   * Shadow resolves NOBODY -- by owner ruling that footage names no one, and
   * an identity reaching a caller from here would be that name arriving by a
   * side door.
   */
  athleteIds: string[];
}

/**
 * WHICH DESTINATION A VIDEO BELONGS TO, and who the scan may act on.
 *
 * The sweep cannot key consent or escalation off video_sessions.athlete_id
 * alone: a teaching row deliberately has none, and "no athlete" no longer
 * means "an unattributed team upload". This is what tells the two apart.
 *
 * Deliberately its own query rather than widening the claim's RETURNING or the
 * shared VideoSessionRecord. Both are read by suites that build narrower
 * schemas, and widening a shared read to answer one caller's question is what
 * broke CI on an earlier slice.
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

  // Teaching media. Nobody to return, and nothing reads the participant
  // tables at runtime any more -- they are retained schema, not a live path.
  return { isTeaching: true, athleteIds: [] };
}
