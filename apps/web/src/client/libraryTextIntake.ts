// Client for manual research text intake (RINT-01).
//
// A curator pastes the source's own words against an already-registered
// Library source. This writes one document and its ordered chunks through the
// two existing routes -- POST /api/pilot/shadow/library/documents and
// POST /api/pilot/shadow/library/chunks -- and nothing else. It never calls
// the evidence review route: what it writes lands pending_review/unverified,
// and /evidence stays the only place anything becomes citable.
//
// SOURCE-FAITHFUL, NOT CLAIMS (owner decision, 2026-10-02: option A). Chunks
// are mechanical divisions of the submitted text. Nothing here rewrites,
// summarizes or reorders it: rejoinIntakeChunks(splitIntakeText(text)) is
// exactly normalizeIntakeText(text), and the tests hold that.

// A chunk is what a reader is eventually shown as one piece of evidence, so it
// is kept near a paragraph in size. Far below the chunk route's own 20,000
// ceiling on purpose.
export const INTAKE_CHUNK_TARGET_LENGTH = 1_200;

// One submission is a sequence of chunk writes, each of which embeds
// server-side. This bounds a single paste to 40 of them; a longer source goes
// in as several labelled excerpts.
export const INTAKE_MAX_TEXT_LENGTH = 48_000;

export const INTAKE_METHOD = 'manual_text';

export interface IntakeChunk {
  ordinal: number;
  text: string;
  // The exact whitespace that stood between the previous chunk and this one.
  // The chunk route trims what it stores, so the separator would otherwise be
  // lost and the stored chunks could not be rejoined into the submitted text.
  // Always '' for ordinal 0.
  joinBefore: string;
}

export interface IntakeInput {
  sourceId: string;
  documentName: string;
  locator: string;
  text: string;
}

// Everything needed to finish a submission whose document exists but whose
// chunks do not all exist yet. Carries the ORIGINAL split, so a retry writes
// the same text at the same ordinals even if the form has changed since.
export interface IntakeResume {
  documentId: string;
  nextOrdinal: number;
  locator: string;
  chunks: IntakeChunk[];
}

export type IntakeResult =
  | { ok: true; documentId: string; chunkCount: number }
  | {
      ok: false;
      message: string;
      // Present only when a document was created and is incomplete.
      resume: IntakeResume | null;
      writtenChunks: number;
      totalChunks: number;
    };

/**
 * The only changes ever made to submitted text: line endings become \n, and
 * leading and trailing whitespace is dropped. Interior text, including blank
 * lines and spacing, is left exactly as pasted.
 */
export function normalizeIntakeText(raw: string): string {
  return raw.replace(/\r\n?/g, '\n').trim();
}

// Where to cut a remainder that is longer than the target. Prefers the last
// paragraph break inside the window, then the last line break, then the last
// space, and only hard-cuts when the window holds no whitespace at all.
function findCut(remaining: string): { end: number; nextStart: number } {
  const window = remaining.slice(0, INTAKE_CHUNK_TARGET_LENGTH + 1);
  const patterns = [/\n[ \t]*\n/g, /\n/g, /\s/g];
  for (const pattern of patterns) {
    let best: { end: number; nextStart: number } | null = null;
    for (const match of window.matchAll(pattern)) {
      // Widen the hit to the whole whitespace run around it, in both
      // directions and past the window if need be: a chunk must start and end
      // on text, because the chunk route trims what it stores.
      let end = match.index ?? 0;
      while (end > 0 && /\s/.test(remaining[end - 1])) end -= 1;
      if (end === 0 || end > INTAKE_CHUNK_TARGET_LENGTH) continue;
      const run = /^\s+/.exec(remaining.slice(end))?.[0].length ?? 0;
      best = { end, nextStart: end + run };
    }
    if (best) return best;
  }
  // No whitespace anywhere in the window: cut mid-token, but never between the
  // two halves of a surrogate pair.
  const lastCode = remaining.charCodeAt(INTAKE_CHUNK_TARGET_LENGTH - 1);
  const end = lastCode >= 0xd800 && lastCode <= 0xdbff
    ? INTAKE_CHUNK_TARGET_LENGTH - 1
    : INTAKE_CHUNK_TARGET_LENGTH;
  return { end, nextStart: end };
}

export function splitIntakeText(raw: string): IntakeChunk[] {
  const text = normalizeIntakeText(raw);
  const chunks: IntakeChunk[] = [];
  let position = 0;
  let joinBefore = '';
  while (position < text.length) {
    const remaining = text.slice(position);
    if (remaining.length <= INTAKE_CHUNK_TARGET_LENGTH) {
      chunks.push({ ordinal: chunks.length, text: remaining, joinBefore });
      break;
    }
    const cut = findCut(remaining);
    chunks.push({ ordinal: chunks.length, text: remaining.slice(0, cut.end), joinBefore });
    joinBefore = remaining.slice(cut.end, cut.nextStart);
    position += cut.nextStart;
  }
  return chunks;
}

export function rejoinIntakeChunks(chunks: readonly Pick<IntakeChunk, 'text' | 'joinBefore'>[]): string {
  return chunks.map((chunk) => `${chunk.joinBefore}${chunk.text}`).join('');
}

/** Null when the input may be submitted; otherwise the sentence to show. */
export function validateIntakeInput(input: IntakeInput): string | null {
  if (!input.sourceId.trim()) return 'Choose the registered source this text comes from.';
  if (!input.documentName.trim()) return 'Give this excerpt a label.';
  if (!input.locator.trim()) return 'Say where in the source this text is: a page, section or timestamp.';
  const text = normalizeIntakeText(input.text);
  if (!text) return 'Paste or type the source text.';
  if (text.length > INTAKE_MAX_TEXT_LENGTH) {
    return `This text is ${text.length.toLocaleString('en-US')} characters. One entry holds up to ${INTAKE_MAX_TEXT_LENGTH.toLocaleString('en-US')}; split it into separate labelled excerpts.`;
  }
  return null;
}

function refusalMessage(status: number, what: string): string {
  if (status === 401) return 'Sign in again, then retry.';
  if (status === 403) return 'Your role cannot add text to the Library.';
  if (status === 404) return `The ${what} was not found in this gym's Library.`;
  if (status === 429) return 'The Library is rate limited right now. Wait a moment and retry.';
  return `The Library refused the ${what} (${status}).`;
}

async function postJson(
  fetchImpl: typeof fetch,
  url: string,
  body: Record<string, unknown>,
): Promise<{ status: number; payload: unknown }> {
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: response.status, payload: await response.json().catch(() => null) };
  } catch {
    // 0 = the request never got an answer.
    return { status: 0, payload: null };
  }
}

function documentIdFrom(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const document = (payload as { document?: unknown }).document;
  if (typeof document !== 'object' || document === null) return null;
  const id = (document as { document_id?: unknown }).document_id;
  return typeof id === 'string' && id ? id : null;
}

/**
 * Writes the document, then each chunk in ordinal order, stopping at the first
 * failure.
 *
 * Not atomic, and it does not pretend to be: the two routes are separate
 * requests. When the document exists and a chunk fails, the result says how
 * far it got and carries a resume token. Passing that token back finishes the
 * same document from the failed ordinal. A 409 on a chunk during a resume
 * means that ordinal is already stored (the earlier request landed and its
 * answer was lost), so it counts as written rather than as a failure.
 */
export async function submitLibraryTextIntake(
  apiBaseUrl: string,
  input: IntakeInput,
  options: { resume?: IntakeResume | null; fetchImpl?: typeof fetch } = {},
): Promise<IntakeResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const resume = options.resume ?? null;

  let documentId: string;
  let chunks: IntakeChunk[];
  let locator: string;
  let startAt: number;

  if (resume) {
    documentId = resume.documentId;
    chunks = resume.chunks;
    locator = resume.locator;
    startAt = resume.nextOrdinal;
  } else {
    const invalid = validateIntakeInput(input);
    if (invalid) {
      return { ok: false, message: invalid, resume: null, writtenChunks: 0, totalChunks: 0 };
    }
    chunks = splitIntakeText(input.text);
    locator = input.locator.trim();
    startAt = 0;

    const created = await postJson(fetchImpl, `${apiBaseUrl}/api/pilot/shadow/library/documents`, {
      source_id: input.sourceId,
      document_name: input.documentName.trim(),
      metadata: {
        intake_method: INTAKE_METHOD,
        locator,
        chunk_count: chunks.length,
        text_length: rejoinIntakeChunks(chunks).length,
      },
    });
    const createdId = created.status === 201 ? documentIdFrom(created.payload) : null;
    if (!createdId) {
      return {
        ok: false,
        message: created.status === 0
          ? 'The Library could not be reached. Nothing was saved. Check your connection and try again.'
          : created.status === 201
            ? 'The Library answered without a document id. Check Evidence Review before trying again.'
            : `${refusalMessage(created.status, 'source')} Nothing was saved.`,
        resume: null,
        writtenChunks: 0,
        totalChunks: chunks.length,
      };
    }
    documentId = createdId;
  }

  for (let index = startAt; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    const written = await postJson(fetchImpl, `${apiBaseUrl}/api/pilot/shadow/library/chunks`, {
      document_id: documentId,
      ordinal: chunk.ordinal,
      text_content: chunk.text,
      metadata: { intake_method: INTAKE_METHOD, locator, join_before: chunk.joinBefore },
    });
    const alreadyStored = resume !== null && written.status === 409;
    if (written.status !== 201 && !alreadyStored) {
      return {
        ok: false,
        message: `Saved ${index} of ${chunks.length} parts, then stopped: ${
          written.status === 0 ? 'the Library could not be reached.' : refusalMessage(written.status, 'document')
        } The entry is incomplete. Use Finish saving to write the rest.`,
        resume: { documentId, nextOrdinal: index, locator, chunks },
        writtenChunks: index,
        totalChunks: chunks.length,
      };
    }
  }

  return { ok: true, documentId, chunkCount: chunks.length };
}
