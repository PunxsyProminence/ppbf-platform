import { getCoachDisplayName } from './achievements';
import type { PilotRole } from './contracts';
import { queryOne } from './db';

/*
 * WHAT A FAMILY RECEIVES ABOUT A VIDEO.
 *
 * An athlete and a linked guardian read the same two routes a coach does
 * (video/list and video/[videoId]), and until this file both routes handed
 * them the storage row: the coach's internal account id, the organization id,
 * the capture take, and the coach's notes on every row of the list -- whether
 * or not the family could play that video.
 *
 * Owner rulings this file carries (OD-2026-10-06-025):
 *   1. The athlete and their parent can read the notes a coach writes on the
 *      athlete's OWN videos.
 *   2. Families see a coach's display name, never the internal account id.
 * And from the same file: "No one watches it" for a photo-only or withdrawn
 * video, and a deleted person's identifying data is not shown.
 *
 * So the notes travel ONLY on the single-video response, which is the one
 * that has already passed mintUnderPlaybackConsent: a video a family may not
 * play carries no notes to them either, and no second consent check is
 * written here. The list carries metadata only.
 *
 * Named fields, never a spread: a spread would carry every column a later
 * change adds to the row to a family without anyone deciding it should
 * (same contract as toFamilyAssignments in progression.ts).
 */

export function isFamilyVideoCaller(role: PilotRole): boolean {
  return role === 'athlete' || role === 'parent';
}

/** The storage columns both routes select; only these are read here. */
interface VideoSessionSource {
  video_session_id: string;
  title: string;
  notes: string;
  file_name: string;
  file_size_bytes: number;
  mime_type: string;
  status: string;
  athlete_id: string | null;
  uploaded_by_account_id: string;
  created_at: string;
  updated_at?: string;
  scan_state?: string;
}

export interface FamilyVideoListItem {
  video_session_id: string;
  title: string;
  file_name: string;
  file_size_bytes: number;
  mime_type: string;
  status: string;
  scan_state: string | null;
  athlete_id: string | null;
  created_at: string;
}

export function toFamilyVideoListItem(row: VideoSessionSource): FamilyVideoListItem {
  return {
    video_session_id: row.video_session_id,
    title: row.title,
    file_name: row.file_name,
    file_size_bytes: row.file_size_bytes,
    mime_type: row.mime_type,
    status: row.status,
    scan_state: row.scan_state ?? null,
    athlete_id: row.athlete_id,
    created_at: row.created_at,
  };
}

/**
 * One coach note as a family reads it. A list, although storage holds one
 * free-text field per video today (video_sessions.notes, written at upload):
 * the screen renders a list, so a later per-note table changes nothing a
 * family sees.
 */
export interface FamilyCoachNote {
  text: string;
  coach_name: string;
  noted_at: string;
}

export interface FamilyVideoPlayback extends FamilyVideoListItem {
  coach_notes: FamilyCoachNote[];
  stream_url: string;
}

// What a family reads when the coach cannot be named: not homed or a member
// here (getCoachDisplayName's own floor), or deleted.
export const FAMILY_COACH_NAME_FLOOR = 'Your coach';

/**
 * The coach's display name for a family, or the floor phrase.
 *
 * getCoachDisplayName derives the name from the login address and already
 * refuses to name an account that is neither homed nor an active member here.
 * It does not look at accounts.deleted_at, and a deleted person's identifying
 * data is not shown to anyone, so that is checked first.
 */
export async function familyCoachName(organizationId: string, accountId: string): Promise<string> {
  const account = await queryOne<{ deleted_at: string | null }>(
    `select deleted_at from pilot.accounts where account_id = $1`,
    [accountId],
  );
  if (!account || account.deleted_at !== null) return FAMILY_COACH_NAME_FLOOR;
  return getCoachDisplayName(organizationId, accountId);
}

/**
 * The single-video response for a family. Called only after the playback
 * consent mint succeeded: `streamUrl` is that proof, and there is no path to
 * the notes that does not pass through it.
 */
export async function toFamilyVideoPlayback(
  organizationId: string,
  row: VideoSessionSource,
  streamUrl: string,
): Promise<FamilyVideoPlayback> {
  const text = row.notes.trim();
  const coachNotes: FamilyCoachNote[] = text
    ? [{
        text,
        coach_name: await familyCoachName(organizationId, row.uploaded_by_account_id),
        noted_at: row.updated_at ?? row.created_at,
      }]
    : [];
  return {
    ...toFamilyVideoListItem(row),
    coach_notes: coachNotes,
    stream_url: streamUrl,
  };
}
