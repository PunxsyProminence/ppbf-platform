/**
 * PROFILE PHOTO UPLOAD POLICY.
 *
 * The third upload path in the platform, and deliberately the same shape as the
 * two that already work: a transport check on the headers, a descriptor built
 * from the declared name/type/size, a content-signature check on the bytes, and
 * nothing trusted from the client. shadowUploadPolicy.ts and
 * videoUploadPolicy.ts are the pattern; this extends it rather than inventing
 * a fourth way to validate a file.
 *
 * What is NEW here, and why:
 *
 *   1. DIMENSIONS ARE MEASURED, NOT ASKED FOR. A portrait is served to a coach
 *      looking at a roster of forty faces. A 12-megapixel phone photo in that
 *      grid is forty 12-megapixel decodes on a gym tablet. The browser
 *      downscales before it uploads (see the client helper), but the browser is
 *      not the authority on anything -- so the server reads the real pixel
 *      dimensions out of the file header and refuses anything above the stored
 *      budget. A client that skips the downscale gets a 413, not a 12MP blob in
 *      the container.
 *
 *   2. METADATA IS STRIPPED SERVER-SIDE. A photograph off a phone carries EXIF,
 *      and EXIF routinely carries GPS coordinates, a device serial and an
 *      embedded thumbnail that survives cropping. On a platform holding
 *      children's records, storing a child's portrait with the coordinates of
 *      the house it was taken in is not an acceptable default. Both accepted
 *      formats are container formats whose metadata lives in whole, skippable
 *      blocks, so the strip is exact and needs no image library.
 *
 *      This is also why WebP and HEIC are refused despite being common: the
 *      rule is that this platform only accepts a format it can strip, and
 *      accepting one it cannot would quietly break the guarantee for everyone.
 */

/**
 * The stored size. 512px on the long edge is the target the client downscales
 * to -- ample for a 144px card portrait at 3x, and small enough that forty of
 * them are a rounding error on a tablet.
 */
export const PROFILE_PHOTO_STORED_EDGE_PX = 512;

/**
 * The server's refusal line, above the target so a client that rounds up or
 * downscales to 600 is not punished for it, and far below a phone's native
 * output so a client that skips the step entirely is caught.
 */
export const PROFILE_PHOTO_MAX_EDGE_PX = 640;

/** Below this it is an icon, not a portrait, and it will render as mush. */
export const PROFILE_PHOTO_MIN_EDGE_PX = 96;

/** A 640px JPEG is ~120 KB. 1.5 MB is generous slack, and refuses a raw phone photo. */
export const PROFILE_PHOTO_MAX_FILE_BYTES = 1_536 * 1024;
export const PROFILE_PHOTO_MAX_REQUEST_BYTES = PROFILE_PHOTO_MAX_FILE_BYTES + (256 * 1024);

/**
 * Only formats whose metadata this module can remove exactly. GIF is absent
 * because an animated portrait is not a portrait; SVG because it is a script
 * host wearing an image's file extension; HEIC and WebP because stripping them
 * correctly needs a decoder this platform does not ship.
 */
const ALLOWED_PHOTO_TYPES = new Map<string, string>([
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.png', 'image/png'],
]);

export interface ProfilePhotoDescriptor {
  readonly safeOriginalName: string;
  readonly generatedFileName: string;
  readonly contentType: string;
}

export function validateProfilePhotoTransport(headers: Headers): {
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
    || contentLength > PROFILE_PHOTO_MAX_REQUEST_BYTES
  ) {
    return { ok: false, status: 413, error: 'The photo upload is too large.' };
  }
  return { ok: true, status: 200 };
}

export function describeProfilePhotoUpload(file: {
  name: string;
  type: string;
  size: number;
}): ProfilePhotoDescriptor | null {
  if (
    !Number.isSafeInteger(file.size)
    || file.size <= 0
    || file.size > PROFILE_PHOTO_MAX_FILE_BYTES
  ) {
    return null;
  }

  const untrustedBaseName = file.name.split(/[\\/]/).pop() ?? '';
  const extensionMatch = /(\.[A-Za-z0-9]+)$/.exec(untrustedBaseName);
  const extension = extensionMatch?.[1]?.toLowerCase() ?? '';
  const expectedType = ALLOWED_PHOTO_TYPES.get(extension);
  if (!expectedType || file.type.toLowerCase() !== expectedType) {
    return null;
  }

  const rawStem = untrustedBaseName.slice(0, Math.max(0, untrustedBaseName.length - extension.length));
  const safeStem = rawStem
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[^A-Za-z0-9 _.-]+/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 160) || 'portrait';

  return {
    safeOriginalName: `${safeStem}${extension}`,
    // The stored name never carries the uploader's filename. A blob path is
    // read by staff and appears in logs; "my_kid_at_home_2019.jpg" does not
    // need to be in either.
    generatedFileName: expectedType === 'image/png' ? 'portrait.png' : 'portrait.jpg',
    contentType: expectedType,
  };
}

/* ------------------------------------------------------------ DIMENSIONS -- */

export interface ImageDimensions {
  readonly width: number;
  readonly height: number;
}

function readUint32BE(bytes: Uint8Array, at: number): number {
  return ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0;
}

/**
 * PNG: fixed layout. The 8-byte signature, then the IHDR chunk, whose width and
 * height are the first two big-endian uint32s of its data at offsets 16 and 20.
 * A PNG that does not open with IHDR is not a PNG this platform will store.
 */
function pngDimensions(bytes: Uint8Array): ImageDimensions | null {
  if (bytes.byteLength < 24) return null;
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (!signature.every((value, index) => bytes[index] === value)) return null;
  // 'IHDR'
  if (bytes[12] !== 0x49 || bytes[13] !== 0x48 || bytes[14] !== 0x44 || bytes[15] !== 0x52) return null;
  const width = readUint32BE(bytes, 16);
  const height = readUint32BE(bytes, 20);
  return width > 0 && height > 0 ? { width, height } : null;
}

/**
 * JPEG: a marker stream. Walk it to the first Start Of Frame and read the size
 * out of it. Everything before that is metadata, quantisation tables and
 * restart markers, all of which carry their own length so the walk is exact
 * rather than a scan for a byte pattern -- a scan finds "SOF" inside an
 * embedded EXIF thumbnail and reports the thumbnail's dimensions.
 */
const JPEG_SOF_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7,
  0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

function jpegDimensions(bytes: Uint8Array): ImageDimensions | null {
  if (bytes.byteLength < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;

  let offset = 2;
  while (offset + 3 < bytes.byteLength) {
    if (bytes[offset] !== 0xff) return null;
    let marker = bytes[offset + 1];
    // Fill bytes: a run of 0xFF before a marker is legal padding.
    while (marker === 0xff && offset + 2 < bytes.byteLength) {
      offset += 1;
      marker = bytes[offset + 1];
    }
    // Standalone markers carry no length.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return null; // end, or entropy data
    const length = (bytes[offset + 2] << 8) | bytes[offset + 3];
    if (length < 2 || offset + 2 + length > bytes.byteLength) return null;
    if (JPEG_SOF_MARKERS.has(marker)) {
      if (offset + 9 > bytes.byteLength) return null;
      const height = (bytes[offset + 5] << 8) | bytes[offset + 6];
      const width = (bytes[offset + 7] << 8) | bytes[offset + 8];
      return width > 0 && height > 0 ? { width, height } : null;
    }
    offset += 2 + length;
  }
  return null;
}

export function readImageDimensions(
  contentType: string,
  bytes: Uint8Array,
): ImageDimensions | null {
  if (contentType === 'image/png') return pngDimensions(bytes);
  if (contentType === 'image/jpeg') return jpegDimensions(bytes);
  return null;
}

/* -------------------------------------------------------------- CONTENT --- */

export interface ProfilePhotoValidation {
  readonly ok: boolean;
  readonly error?: string;
  readonly status?: number;
  readonly dimensions?: ImageDimensions;
}

/**
 * The single server-side gate on the bytes. Signature, dimensions, and size --
 * measured from the file, never read from the request.
 */
export function validateProfilePhotoContent(
  descriptor: Pick<ProfilePhotoDescriptor, 'contentType'>,
  bytes: Uint8Array,
): ProfilePhotoValidation {
  if (bytes.byteLength === 0 || bytes.byteLength > PROFILE_PHOTO_MAX_FILE_BYTES) {
    return { ok: false, status: 413, error: 'The photo is empty or too large.' };
  }

  const dimensions = readImageDimensions(descriptor.contentType, bytes);
  if (!dimensions) {
    // The signature check and the dimension read are the same operation: a file
    // whose header cannot be walked is not the format it claims to be.
    return {
      ok: false,
      status: 415,
      error: 'The photo content does not match its declared file type.',
    };
  }

  const longEdge = Math.max(dimensions.width, dimensions.height);
  const shortEdge = Math.min(dimensions.width, dimensions.height);

  if (longEdge > PROFILE_PHOTO_MAX_EDGE_PX) {
    return {
      ok: false,
      status: 413,
      error: `Photos are stored at ${PROFILE_PHOTO_STORED_EDGE_PX}px. This one is ${longEdge}px on its long edge -- resize it and try again.`,
      dimensions,
    };
  }
  if (shortEdge < PROFILE_PHOTO_MIN_EDGE_PX) {
    return {
      ok: false,
      status: 400,
      error: `A portrait needs to be at least ${PROFILE_PHOTO_MIN_EDGE_PX}px on its short edge.`,
      dimensions,
    };
  }

  return { ok: true, dimensions };
}

/* --------------------------------------------------------- METADATA STRIP -- */

/**
 * Remove every APPn segment from a JPEG.
 *
 * APP1 is where EXIF lives, which is where GPS lives. APP1 is also where XMP
 * lives, and APP13 where an IPTC block with a photographer's name and address
 * lives. None of it is pixels, all of it is self-describing, and dropping whole
 * segments leaves a JPEG that every decoder reads identically -- so this is an
 * exact edit, not a re-encode, and it cannot degrade the image.
 *
 * The walk stops at Start Of Scan and copies the rest verbatim: entropy-coded
 * data has no segment structure and must not be parsed.
 */
export function stripJpegMetadata(bytes: Uint8Array): Uint8Array {
  if (bytes.byteLength < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return bytes;

  const kept: Array<[number, number]> = [[0, 2]]; // SOI
  let offset = 2;

  while (offset + 3 < bytes.byteLength) {
    if (bytes[offset] !== 0xff) break;
    let markerAt = offset;
    let marker = bytes[markerAt + 1];
    while (marker === 0xff && markerAt + 2 < bytes.byteLength) {
      markerAt += 1;
      marker = bytes[markerAt + 1];
    }
    if (marker === 0xda) {
      // Scan header onward: copy to the end untouched.
      kept.push([markerAt, bytes.byteLength]);
      break;
    }
    if (marker === 0xd9 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      kept.push([markerAt, markerAt + 2]);
      offset = markerAt + 2;
      continue;
    }
    const length = (bytes[markerAt + 2] << 8) | bytes[markerAt + 3];
    if (length < 2 || markerAt + 2 + length > bytes.byteLength) break;
    const isApp = marker >= 0xe0 && marker <= 0xef;
    const isComment = marker === 0xfe;
    if (!isApp && !isComment) {
      kept.push([markerAt, markerAt + 2 + length]);
    }
    offset = markerAt + 2 + length;
  }

  const total = kept.reduce((sum, [from, to]) => sum + (to - from), 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const [from, to] of kept) {
    out.set(bytes.subarray(from, to), at);
    at += to - from;
  }
  return out;
}

/**
 * Remove every non-essential chunk from a PNG.
 *
 * PNG is a chunk stream with a length and a CRC on each chunk, so dropping one
 * whole is exact. The allow-list is the chunks a decoder needs to render the
 * image correctly; eXIf, tEXt, iTXt, zTXt and the timestamp are all dropped,
 * which is where a phone or an editor writes location and authorship.
 */
const PNG_KEPT_CHUNKS = new Set([
  'IHDR', 'PLTE', 'IDAT', 'IEND',
  'tRNS', 'gAMA', 'cHRM', 'sRGB', 'iCCP', 'sBIT', 'bKGD', 'pHYs',
]);

export function stripPngMetadata(bytes: Uint8Array): Uint8Array {
  if (bytes.byteLength < 8) return bytes;
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (!signature.every((value, index) => bytes[index] === value)) return bytes;

  const kept: Array<[number, number]> = [[0, 8]];
  let offset = 8;

  while (offset + 8 <= bytes.byteLength) {
    const length = readUint32BE(bytes, offset);
    const end = offset + 12 + length;
    if (length > bytes.byteLength || end > bytes.byteLength) break;
    const type = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);
    if (PNG_KEPT_CHUNKS.has(type)) {
      kept.push([offset, end]);
    }
    offset = end;
    if (type === 'IEND') break;
  }

  const total = kept.reduce((sum, [from, to]) => sum + (to - from), 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const [from, to] of kept) {
    out.set(bytes.subarray(from, to), at);
    at += to - from;
  }
  return out;
}

export function stripPhotoMetadata(contentType: string, bytes: Uint8Array): Uint8Array {
  if (contentType === 'image/jpeg') return stripJpegMetadata(bytes);
  if (contentType === 'image/png') return stripPngMetadata(bytes);
  return bytes;
}
