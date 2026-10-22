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
  /** Null for an athlete or parent viewer. Use portraitPath, not this. */
  accountId: string | null;
  displayName: string;
  initials: string;
  ringName: string | null;
  corner: CornerChoice;
  cornerLabel: string;
  program: ProgramChoice;
  programLabel: string;
  coachName: string | null;
  /** Null for an athlete or parent viewer. Use coachPortraitPath, not this. */
  coachAccountId: string | null;
  coachPhotoAvailable: boolean;
  coachInitials: string | null;
  timeAtGym: string | null;
  photoAvailable: boolean;
  /** The card subject's portrait, relative to apiBase(); cardPhotoUrl. */
  portraitPath: string | null;
  /** The coach line's portrait, relative to apiBase(); cardPhotoUrl. */
  coachPortraitPath: string | null;
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
  { value: 'fitness', label: 'Fitness Program' },
  { value: 'recreational', label: 'Adult Recreational Program' },
  { value: 'youth_mentorship', label: 'Youth Mentorship Program' },
  { value: 'competitive', label: 'Competitive Program' },
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
 * A portrait on a fight card, addressed by the card rather than by anybody's
 * account id. A family's card carries no account id at all (OD-2026-10-06-025
 * ruling 2; F-119), so the server builds the path from a handle the viewer
 * already holds and gates the subject, and for the coach line the coach, on
 * every fetch. Undefined when the card has no path: the plate.
 */
export function cardPhotoUrl(base: string, path: string | null | undefined): string | undefined {
  // Loose on purpose: a payload from a server older than the field has no
  // path at all, and that is the plate too, not a request for ".../undefined".
  return path ? `${base}${path}` : undefined;
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
