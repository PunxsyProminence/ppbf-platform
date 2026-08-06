import {
  readImageDimensions,
  stripPhotoMetadata,
  type ImageDimensions,
} from './profilePhotoPolicy';

/**
 * Upload policy for gym-wall photographs -- pictures of the BUILDING an admin
 * uploads from /admin/gym-photos.
 *
 * This is the portrait policy's machinery pointed at a different subject. The
 * validation chain is identical (declared type must match the bytes, dimensions
 * are read from the file, EXIF/GPS is stripped before storage, never after) but
 * the bounds differ: a portrait is stored at 512px because a face does not need
 * more, while a photograph of a room is shown wide on a dashboard and printed
 * on the public page, so it is allowed to be a real camera file.
 *
 * The format allowlist is the same and for the same reason: only formats whose
 * metadata this platform can remove exactly. No WebP, no HEIC, no SVG (a
 * script host wearing an image's extension), no GIF.
 */

export const GYM_WALL_MAX_FILE_BYTES = 8 * 1024 * 1024;
export const GYM_WALL_MAX_REQUEST_BYTES = GYM_WALL_MAX_FILE_BYTES + 256 * 1024;
/** Generous: a modern phone photographs a room at 4000px on the long edge. */
export const GYM_WALL_MAX_EDGE_PX = 6000;
/** A room shot smaller than this is a thumbnail, not a wall photograph. */
export const GYM_WALL_MIN_EDGE_PX = 320;

const ALLOWED_TYPES = new Map<string, string>([
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.png', 'image/png'],
]);

export function validateGymWallTransport(headers: Headers): {
  ok: boolean;
  status: number;
  error?: string;
} {
  const contentType = headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().startsWith('multipart/form-data;')) {
    return { ok: false, status: 415, error: 'A multipart photo upload is required.' };
  }
  const rawLength = headers.get('content-length');
  if (!rawLength || !/^\d+$/.test(rawLength)) {
    return { ok: false, status: 411, error: 'A bounded Content-Length is required.' };
  }
  const contentLength = Number(rawLength);
  if (
    !Number.isSafeInteger(contentLength)
    || contentLength <= 0
    || contentLength > GYM_WALL_MAX_REQUEST_BYTES
  ) {
    return { ok: false, status: 413, error: 'The photo upload is too large.' };
  }
  return { ok: true, status: 200 };
}

/** The declared content type when name, type, and size agree; null otherwise. */
export function describeGymWallUpload(file: {
  name: string;
  type: string;
  size: number;
}): { contentType: string } | null {
  if (!Number.isSafeInteger(file.size) || file.size <= 0 || file.size > GYM_WALL_MAX_FILE_BYTES) {
    return null;
  }
  const baseName = file.name.split(/[\\/]/).pop() ?? '';
  const extensionMatch = /(\.[A-Za-z0-9]+)$/.exec(baseName);
  const extension = extensionMatch?.[1]?.toLowerCase() ?? '';
  const expectedType = ALLOWED_TYPES.get(extension);
  if (!expectedType || file.type.toLowerCase() !== expectedType) return null;
  return { contentType: expectedType };
}

export interface GymWallValidation {
  readonly ok: boolean;
  readonly error?: string;
  readonly status?: number;
  readonly dimensions?: ImageDimensions;
}

/** Signature, dimensions, size -- measured from the bytes, never the request. */
export function validateGymWallContent(contentType: string, bytes: Uint8Array): GymWallValidation {
  if (bytes.byteLength === 0 || bytes.byteLength > GYM_WALL_MAX_FILE_BYTES) {
    return { ok: false, status: 413, error: 'The photo is empty or too large.' };
  }
  const dimensions = readImageDimensions(contentType, bytes);
  if (!dimensions) {
    return {
      ok: false,
      status: 415,
      error: 'The photo content does not match its declared file type.',
    };
  }
  const longEdge = Math.max(dimensions.width, dimensions.height);
  const shortEdge = Math.min(dimensions.width, dimensions.height);
  if (longEdge > GYM_WALL_MAX_EDGE_PX) {
    return {
      ok: false,
      status: 413,
      error: `This photo is ${longEdge}px on its long edge; the wall accepts up to ${GYM_WALL_MAX_EDGE_PX}px. Resize it and try again.`,
      dimensions,
    };
  }
  if (shortEdge < GYM_WALL_MIN_EDGE_PX) {
    return {
      ok: false,
      status: 400,
      error: `A wall photograph needs at least ${GYM_WALL_MIN_EDGE_PX}px on its short edge.`,
      dimensions,
    };
  }
  return { ok: true, dimensions };
}

/**
 * Strip before storing, never after -- same stance as portraits. A photo of the
 * gym's own room still carries the GPS of the phone that took it.
 */
export function stripGymWallMetadata(contentType: string, bytes: Uint8Array): Uint8Array {
  return stripPhotoMetadata(contentType, bytes);
}
