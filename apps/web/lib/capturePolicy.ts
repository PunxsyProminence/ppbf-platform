/*
 * What the in-app recorder is allowed to produce.
 *
 * THIS IS A POLICY VALUE, NOT A CONSTANT IN THE RECORDER, and the distinction
 * is the point. Today's upload path is server-mediated multipart: the route
 * buffers the whole request, which is why videoUploadPolicy caps a file at
 * 50 MiB and says in its own first line that larger footage must wait for
 * direct-to-Blob. The owner's horizon is explicitly beyond that -- single
 * punches and short combinations now, a full fight round later. When the
 * transport changes, this number changes and the recorder does not.
 *
 * STOPPING IS BYTE-BASED, NEVER A GUESSED MINUTE COUNT. How long a phone can
 * record before hitting a size limit depends on its camera, its codec and its
 * bitrate, and those vary by more than enough to make any duration wrong on
 * some device in the gym. A coach who films a combination and is told at the
 * end that it was refused has lost the take and the athlete's rep. The
 * recorder therefore watches the bytes it has actually accumulated and stops
 * itself before the ceiling.
 */

// Deliberately under the server's 50 MiB hard limit rather than at it. The
// final chunk arrives whole, multipart adds its own framing, and stopping
// exactly at the ceiling would mean discovering the overshoot as a 413 after
// the footage was already shot.
export const CAPTURE_MAX_BLOB_BYTES = 45 * 1024 * 1024;

// Chunk cadence. Small enough that the accumulated size is known closely
// enough to stop in time, large enough not to spend the recording assembling
// thousands of fragments.
export const CAPTURE_CHUNK_MS = 1000;

/*
 * MediaRecorder reports a parameterised type such as
 * video/webm;codecs="vp8,opus". The upload route compares the file's MIME to
 * its allow-list with STRICT equality, so that string is refused even though
 * WebM itself is perfectly acceptable.
 *
 * NORMALISE PARAMETERS, NEVER RENAME A CONTAINER. Stripping ;codecs=... from a
 * WebM blob is describing the same bytes more plainly. Calling those bytes
 * video/mp4 because the server prefers mp4 would be a lie the magic-byte check
 * catches -- and would deserve to.
 */
export function captureFileDescriptor(recorderMimeType: string): { extension: string; contentType: string } | null {
  const base = recorderMimeType.split(';')[0]!.trim().toLowerCase();
  if (base === 'video/webm') return { extension: '.webm', contentType: 'video/webm' };
  if (base === 'video/mp4') return { extension: '.mp4', contentType: 'video/mp4' };
  // Anything else is a container this platform's upload path does not accept.
  // Returning null makes the caller say so plainly rather than uploading bytes
  // under a type they are not.
  return null;
}

// Ordered by preference, and every one of these is a container the upload
// route already accepts. isTypeSupported answers per browser, so the recorder
// asks rather than assuming: Chrome and Android answer WebM, and Safari
// answers mp4 or nothing at all.
export const CAPTURE_MIME_CANDIDATES = [
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
  'video/webm',
  'video/mp4',
] as const;
