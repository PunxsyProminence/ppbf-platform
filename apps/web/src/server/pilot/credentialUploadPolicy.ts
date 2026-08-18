/**
 * CREDENTIAL DOCUMENT UPLOAD POLICY.
 *
 * The same shape as profilePhotoPolicy.ts, shadowUploadPolicy.ts and
 * videoUploadPolicy.ts: a transport check on the headers, a descriptor built
 * from the declared name/type/size that never trusts the client, and a
 * content-signature check on the actual bytes. This is the fourth upload
 * path, not a fifth way to validate a file.
 *
 * WHAT IS DIFFERENT FROM A PORTRAIT, AND WHY:
 *
 *   A credential document is usually a scanned CERTIFICATE OR CLEARANCE
 *   LETTER -- a PDF most of the time, a photographed page sometimes. It is
 *   not a portrait: nobody needs it downscaled to a card thumbnail, and
 *   there is no pixel budget to enforce. What still matters is that the
 *   bytes are actually the format they claim to be (a renamed .exe is not a
 *   PDF because someone typed .pdf on it) and that the upload is bounded, so
 *   the size cap here is a plain byte ceiling rather than a measured pixel
 *   edge.
 *
 *   Metadata stripping is deliberately NOT done here, unlike the portrait
 *   path. A certificate's embedded metadata is not a location a person's
 *   photograph was taken at -- it is at most the producing software's name --
 *   and the document is never broadly visible in the first place (see
 *   blob.ts's header on this container): only the document's own owner and
 *   an organization admin can ever reach the bytes at all.
 */

import { readImageDimensions } from './profilePhotoPolicy';

/** 10MB: generous for a scanned certificate or a phone photo of one, and far
 * below anything that would strain the authenticated download path this
 * platform never serves through a CDN. */
export const CREDENTIAL_MAX_FILE_BYTES = 10 * 1024 * 1024;
export const CREDENTIAL_MAX_REQUEST_BYTES = CREDENTIAL_MAX_FILE_BYTES + (512 * 1024);

/**
 * Formats this platform will store a credential document as. PDF is the
 * expected shape for most issuing authorities' certificates; JPG/PNG cover a
 * phone photo of a physical card or letter. No other format is accepted --
 * a credential document is not a video, and this container is not a general
 * file drop.
 */
const ALLOWED_CREDENTIAL_TYPES = new Map<string, string>([
  ['.pdf', 'application/pdf'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.png', 'image/png'],
]);

export interface CredentialUploadDescriptor {
  readonly generatedFileName: string;
  readonly contentType: string;
}

export function validateCredentialUploadTransport(headers: Headers): {
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
  if (
    !Number.isSafeInteger(contentLength)
    || contentLength <= 0
    || contentLength > CREDENTIAL_MAX_REQUEST_BYTES
  ) {
    return { ok: false, status: 413, error: 'The document upload is too large.' };
  }
  return { ok: true, status: 200 };
}

/**
 * Builds the descriptor for a stored credential document. The stored name
 * never carries the uploader's filename -- a blob path is read by an admin
 * reviewing the queue and appears in audit details, and
 * "my_safesport_cert_final_v2.pdf" does not need to be in either. The
 * generated name is fixed per format ('credential.pdf' / 'credential.jpg' /
 * 'credential.png'); the caller composes the full path from the
 * organization, account and clearance type, which is what actually makes
 * the name unique.
 */
export function describeCredentialUpload(file: {
  name: string;
  type: string;
  size: number;
}): CredentialUploadDescriptor | null {
  if (
    !Number.isSafeInteger(file.size)
    || file.size <= 0
    || file.size > CREDENTIAL_MAX_FILE_BYTES
  ) {
    return null;
  }

  const untrustedBaseName = file.name.split(/[\\/]/).pop() ?? '';
  const extensionMatch = /(\.[A-Za-z0-9]+)$/.exec(untrustedBaseName);
  const extension = extensionMatch?.[1]?.toLowerCase() ?? '';
  const expectedType = ALLOWED_CREDENTIAL_TYPES.get(extension);
  if (!expectedType || file.type.toLowerCase() !== expectedType) {
    return null;
  }

  const generatedFileName = expectedType === 'application/pdf'
    ? 'credential.pdf'
    : expectedType === 'image/png'
      ? 'credential.png'
      : 'credential.jpg';

  return { generatedFileName, contentType: expectedType };
}

/* -------------------------------------------------------------- CONTENT --- */

const PDF_SIGNATURE = [0x25, 0x50, 0x44, 0x46, 0x2d]; // '%PDF-'

function looksLikePdf(bytes: Uint8Array): boolean {
  if (bytes.byteLength < PDF_SIGNATURE.length) return false;
  return PDF_SIGNATURE.every((value, index) => bytes[index] === value);
}

export interface CredentialContentValidation {
  readonly ok: boolean;
  readonly error?: string;
  readonly status?: number;
}

/**
 * The single server-side gate on the bytes. A PDF is checked by its magic
 * bytes; a JPG/PNG reuses profilePhotoPolicy's own structural walk (imported
 * rather than re-implemented -- a second hand-rolled JPEG/PNG header parser
 * in this codebase is exactly the kind of drift this platform's upload
 * policies otherwise avoid) purely to confirm the bytes are the format they
 * claim, ignoring the pixel dimensions it returns: a credential document
 * carries no pixel budget.
 */
export function validateCredentialContent(
  descriptor: Pick<CredentialUploadDescriptor, 'contentType'>,
  bytes: Uint8Array,
): CredentialContentValidation {
  if (bytes.byteLength === 0 || bytes.byteLength > CREDENTIAL_MAX_FILE_BYTES) {
    return { ok: false, status: 413, error: 'The document is empty or too large.' };
  }

  if (descriptor.contentType === 'application/pdf') {
    if (!looksLikePdf(bytes)) {
      return { ok: false, status: 415, error: 'The document content does not match its declared file type.' };
    }
    return { ok: true };
  }

  if (!readImageDimensions(descriptor.contentType, bytes)) {
    return { ok: false, status: 415, error: 'The document content does not match its declared file type.' };
  }
  return { ok: true };
}
