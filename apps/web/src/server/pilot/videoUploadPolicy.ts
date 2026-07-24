// Interim server-mediated uploads are intentionally small because formData()
// buffers the request. Larger footage must wait for direct-to-Blob upload.
export const VIDEO_UPLOAD_MAX_FILE_BYTES = 50 * 1024 * 1024;
export const VIDEO_UPLOAD_MAX_REQUEST_BYTES = VIDEO_UPLOAD_MAX_FILE_BYTES + (1024 * 1024);

const VIDEO_TYPES = new Map<string, string>([
  ['.mp4', 'video/mp4'],
  ['.mov', 'video/quicktime'],
  ['.avi', 'video/x-msvideo'],
  ['.webm', 'video/webm'],
  ['.mpeg', 'video/mpeg'],
  ['.mpg', 'video/mpeg'],
]);

export interface VideoUploadDescriptor {
  safeOriginalName: string;
  generatedFileName: string;
  contentType: string;
}

export function validateVideoUploadTransport(headers: Headers): {
  ok: boolean;
  status: number;
  error?: string;
} {
  const contentType = headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().startsWith('multipart/form-data;')) {
    return { ok: false, status: 415, error: 'A multipart video upload is required.' };
  }

  const rawLength = headers.get('content-length');
  if (!rawLength || !/^\d+$/.test(rawLength)) {
    return { ok: false, status: 411, error: 'A bounded Content-Length is required.' };
  }
  const contentLength = Number(rawLength);
  if (
    !Number.isSafeInteger(contentLength)
    || contentLength <= 0
    || contentLength > VIDEO_UPLOAD_MAX_REQUEST_BYTES
  ) {
    return { ok: false, status: 413, error: 'The video upload is too large.' };
  }
  return { ok: true, status: 200 };
}

export function describeVideoUpload(file: {
  name: string;
  type: string;
  size: number;
}): VideoUploadDescriptor | null {
  if (
    !Number.isSafeInteger(file.size)
    || file.size <= 0
    || file.size > VIDEO_UPLOAD_MAX_FILE_BYTES
  ) {
    return null;
  }

  const untrustedBaseName = file.name.split(/[\\/]/).pop() ?? '';
  const extensionMatch = /(\.[A-Za-z0-9]+)$/.exec(untrustedBaseName);
  const extension = extensionMatch?.[1]?.toLowerCase() ?? '';
  const expectedType = VIDEO_TYPES.get(extension);
  if (!expectedType || file.type.toLowerCase() !== expectedType) {
    return null;
  }

  const rawStem = untrustedBaseName.slice(0, -extension.length);
  const safeStem = rawStem
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[^A-Za-z0-9 _.-]+/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 160) || 'video';

  return {
    safeOriginalName: `${safeStem}${extension}`,
    generatedFileName: `source${extension}`,
    contentType: expectedType,
  };
}

export function validateVideoUploadSignature(
  descriptor: Pick<VideoUploadDescriptor, 'contentType'>,
  bytes: Uint8Array,
): boolean {
  if (bytes.byteLength < 4) return false;

  if (descriptor.contentType === 'video/mp4' || descriptor.contentType === 'video/quicktime') {
    return bytes.byteLength >= 8
      && bytes[4] === 0x66
      && bytes[5] === 0x74
      && bytes[6] === 0x79
      && bytes[7] === 0x70; // ISO Base Media File Format: ftyp
  }

  if (descriptor.contentType === 'video/x-msvideo') {
    return bytes.byteLength >= 12
      && bytes[0] === 0x52
      && bytes[1] === 0x49
      && bytes[2] === 0x46
      && bytes[3] === 0x46
      && bytes[8] === 0x41
      && bytes[9] === 0x56
      && bytes[10] === 0x49
      && bytes[11] === 0x20; // RIFF....AVI
  }

  if (descriptor.contentType === 'video/webm') {
    return bytes[0] === 0x1a
      && bytes[1] === 0x45
      && bytes[2] === 0xdf
      && bytes[3] === 0xa3; // EBML header
  }

  if (descriptor.contentType === 'video/mpeg') {
    return bytes[0] === 0x00
      && bytes[1] === 0x00
      && bytes[2] === 0x01
      && (bytes[3] === 0xba || bytes[3] === 0xb3);
  }

  return false;
}
