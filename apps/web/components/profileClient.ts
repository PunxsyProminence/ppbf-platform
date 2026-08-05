/**
 * Client-side identity types and the one browser-only thing the feature needs:
 * downscaling a photograph before it is uploaded.
 *
 * THE DOWNSCALE IS A COURTESY, NOT A CONTROL. The server measures the real
 * pixel dimensions out of the file header and refuses anything over its own
 * limit (profilePhotoPolicy.ts). This function exists so a member with a phone
 * photo gets a portrait instead of a 413, not so the server can trust the
 * client -- it cannot, and it does not.
 */

export type CornerChoice = 'red' | 'blue' | 'none';
export type ProgramChoice =
  | 'fitness'
  | 'recreational'
  | 'youth_mentorship'
  | 'competitive'
  | 'unstated';

export interface FightCardPayload {
  accountId: string;
  displayName: string;
  initials: string;
  ringName: string | null;
  corner: CornerChoice;
  cornerLabel: string;
  program: ProgramChoice;
  programLabel: string;
  coachName: string | null;
  coachAccountId: string | null;
  coachPhotoAvailable: boolean;
  coachInitials: string | null;
  timeAtGym: string | null;
  photoAvailable: boolean;
}

export interface ProfileSettingsPayload {
  nickname: string | null;
  nickname_cleared: boolean;
  nickname_locked: boolean;
  corner: CornerChoice;
  program: ProgramChoice;
  photo_review_state: 'pending_review' | 'released' | 'blocked' | 'removed';
  has_photo: boolean;
}

/** Kept in step with profileIdentity.ts. The server is the enforcer. */
export const NICKNAME_MAX_LENGTH = 24;
export const PROFILE_PHOTO_STORED_EDGE_PX = 512;

export const CORNER_OPTIONS: ReadonlyArray<{ value: CornerChoice; label: string; hint: string }> = [
  { value: 'red', label: 'Red corner', hint: 'Oxblood. Tints your own card, your plate and your header rope.' },
  { value: 'blue', label: 'Blue corner', hint: 'Indigo. Tints your own card, your plate and your header rope.' },
  { value: 'none', label: 'No corner', hint: 'The gym’s own brass. Nothing tinted.' },
];

export const PROGRAM_OPTIONS: ReadonlyArray<{ value: ProgramChoice; label: string }> = [
  { value: 'fitness', label: 'Fitness Programme' },
  { value: 'recreational', label: 'Adult Recreational Programme' },
  { value: 'youth_mentorship', label: 'Youth Mentorship Programme' },
  { value: 'competitive', label: 'Competitive Programme' },
  { value: 'unstated', label: 'Not recorded' },
];

/**
 * Where a portrait comes from. Always this platform, never storage: there is no
 * URL for a member's photograph that works without a session.
 */
export function portraitUrl(base: string, accountId: string): string {
  return `${base}/api/pilot/profile/photo/${encodeURIComponent(accountId)}`;
}

/**
 * Downscale to the stored edge and re-encode as JPEG.
 *
 * Re-encoding through a canvas has a side effect worth stating out loud: the
 * output carries no EXIF, because a canvas has no idea the input had any. That
 * is a happy accident and NOT the platform's metadata guarantee -- the server
 * strips independently, because this code path can be skipped by anyone who
 * wants to skip it.
 *
 * Returns the original file untouched when the browser cannot decode it, so a
 * failure here becomes a normal server-side rejection with a real message
 * rather than a silent dead end.
 */
export async function downscalePhoto(
  file: File,
  maxEdge: number = PROFILE_PHOTO_STORED_EDGE_PX,
): Promise<File> {
  if (typeof document === 'undefined' || typeof createImageBitmap !== 'function') return file;
  try {
    const bitmap = await createImageBitmap(file);
    const longEdge = Math.max(bitmap.width, bitmap.height);
    const scale = longEdge > maxEdge ? maxEdge / longEdge : 1;
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) return file;
    context.drawImage(bitmap, 0, 0, width, height);
    bitmap.close?.();

    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, 'image/jpeg', 0.86);
    });
    if (!blob) return file;
    return new File([blob], 'portrait.jpg', { type: 'image/jpeg' });
  } catch {
    return file;
  }
}
