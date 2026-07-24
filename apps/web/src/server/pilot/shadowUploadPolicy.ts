export const SHADOW_UPLOAD_MAX_FILE_BYTES = 10 * 1024 * 1024;
export const SHADOW_UPLOAD_MAX_REQUEST_BYTES = SHADOW_UPLOAD_MAX_FILE_BYTES + (1024 * 1024);

const ALLOWED_UPLOAD_TYPES = new Map([
  ['.pdf', 'application/pdf'],
  ['.txt', 'text/plain'],
  ['.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
]);

export const SHADOW_INTAKE_DOCUMENT_TYPES = new Set([
  'athlete_registration',
  'emergency_contact',
  'medical_form',
  'waiver_consent',
  'assessment_document',
  'general_intake',
]);

export interface ShadowUploadDescriptor {
  safeOriginalName: string;
  generatedFileName: string;
  contentType: string;
}

export function validateShadowUploadTransport(headers: Headers): {
  ok: boolean;
  status: number;
  error?: string;
} {
  const contentType = headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().startsWith('multipart/form-data;')) {
    return { ok: false, status: 415, error: 'A multipart document upload is required.' };
  }

  const rawLength = headers.get('content-length');
  if (!rawLength || !/^\d+$/.test(rawLength)) {
    return { ok: false, status: 411, error: 'A bounded Content-Length is required.' };
  }
  const contentLength = Number(rawLength);
  if (!Number.isSafeInteger(contentLength) || contentLength > SHADOW_UPLOAD_MAX_REQUEST_BYTES) {
    return { ok: false, status: 413, error: 'The upload is too large.' };
  }
  return { ok: true, status: 200 };
}

export function describeShadowUpload(file: {
  name: string;
  type: string;
  size: number;
}): ShadowUploadDescriptor | null {
  if (
    !Number.isSafeInteger(file.size)
    || file.size <= 0
    || file.size > SHADOW_UPLOAD_MAX_FILE_BYTES
  ) {
    return null;
  }

  const untrustedBaseName = file.name.split(/[\\/]/).pop() ?? '';
  const extensionMatch = /(\.[A-Za-z0-9]+)$/.exec(untrustedBaseName);
  const extension = extensionMatch?.[1]?.toLowerCase() ?? '';
  const expectedType = ALLOWED_UPLOAD_TYPES.get(extension);
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
    .slice(0, 160) || 'document';

  return {
    safeOriginalName: `${safeStem}${extension}`,
    generatedFileName: `source${extension}`,
    contentType: expectedType,
  };
}
