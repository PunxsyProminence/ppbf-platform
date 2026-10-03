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
// server-side. This bounds a single paste to about 40 of them for ordinary
// prose (more when the text has few places to break); a longer source goes in
// as several labelled excerpts.
export const INTAKE_MAX_TEXT_LENGTH = 48_000;

export const INTAKE_METHOD = 'manual_text';

// Where a PDF-sourced excerpt says it came from (RINT-02). This is a SEPARATE
// metadata key on purpose, never a different intake_method: the completeness
// gate in shadowLibrary.ts (MANUAL_TEXT_INTAKE_COMPLETE_SQL) runs only when
// intake_method is exactly 'manual_text', so a PDF excerpt must keep that value
// to keep being held to it. libraryTextIntake.test.ts pins both.
export const TEXT_ORIGIN_PDF_PAGE = 'pdf_page';

// Mirrors LIBRARY_PDF_MAX_BYTES in the server's libraryPdfText.ts (a client
// file cannot import it: it pulls in the parser). The route test pins them equal.
export const PDF_READ_MAX_BYTES = 10 * 1024 * 1024;

// Which Library shelf an entry goes to (RINT-05b). The server resolves it
// (libraryShelf.ts); only the platform owner may name 'platform', and it may
// not write the gym shelf (OD-2026-10-02-015 D3). 'gym' is the default and is
// never sent, so every gym curator's requests stay exactly as they were.
export type IntakeShelf = 'gym' | 'platform';

function shelfField(shelf: IntakeShelf | undefined): { shelf?: 'platform' } {
  return shelf === 'platform' ? { shelf: 'platform' } : {};
}

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
  // Set when the text was taken from a page of a PDF read in this browser
  // session (RINT-02). The text must then be words that appear on that page,
  // and the document is stamped with text_origin. notOnPageMessage is the
  // sentence shown when it is not; the panel owns the wording.
  pdfPage?: { num: number; text: string; notOnPageMessage: string };
  shelf?: IntakeShelf;
}

// Everything needed to finish a submission whose document exists but whose
// chunks do not all exist yet. Carries the ORIGINAL split, so a retry writes
// the same text at the same ordinals even if the form has changed since.
export interface IntakeResume {
  documentId: string;
  nextOrdinal: number;
  locator: string;
  chunks: IntakeChunk[];
  // The shelf the document was created on: its chunks must go to the same one.
  shelf?: IntakeShelf;
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

// A count with thousands separators. Intl.NumberFormat rather than
// Number#toLocaleString: gymTimeDrift.test.ts forbids every toLocale* call
// outside src/lib/gymTime.ts, numbers included.
const COUNT_FORMAT = new Intl.NumberFormat('en-US');

export function formatIntakeCount(value: number): string {
  return COUNT_FORMAT.format(value);
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/**
 * True when `excerpt` is a run of the page's own words: after collapsing every
 * run of whitespace to one space, the excerpt appears in the page text. A trimmed
 * span passes; a retyped or reworded one does not. This keeps the PDF path to
 * "the source's own words" (OD-2026-10-02-006 s.2). It is a check in the
 * curator's browser, not a server guarantee: the server stores nothing from the
 * PDF and cannot compare it with what is later submitted.
 */
export function isTextFromPage(excerpt: string, pageText: string): boolean {
  const wanted = collapseWhitespace(excerpt);
  return wanted.length > 0 && collapseWhitespace(pageText).includes(wanted);
}

/** "p. 12" for the page a curator chose. */
export function pdfPageLocator(pageNumber: number): string {
  return `p. ${pageNumber}`;
}

export interface PdfPageText {
  num: number;
  text: string;
}

export type PdfReadResult =
  | { ok: true; pages: PdfPageText[]; emptyPageCount: number }
  // serverMessage is the route's own sentence for a refusal it authored (a
  // too-long or unreadable PDF); null when there was none or no answer at all.
  | { ok: false; status: number; serverMessage: string | null };

// A parse can take 15 s on the server; this only stops a request that never
// answers from leaving the picker on "Reading".
const PDF_READ_TIMEOUT_MS = 45_000;

/**
 * Sends the chosen PDF to the reader route and returns its pages. The route
 * keeps nothing; the pages exist only in what this returns. Never throws.
 */
export async function readLibraryPdf(
  apiBaseUrl: string,
  file: File,
  options: { fetchImpl?: typeof fetch } = {},
): Promise<PdfReadResult> {
  if (file.size > PDF_READ_MAX_BYTES) return { ok: false, status: 413, serverMessage: null };
  const fetchImpl = options.fetchImpl ?? fetch;
  const form = new FormData();
  form.append('file', file);
  try {
    // No Content-Type header: the browser must set it, with the boundary.
    const response = await fetchImpl(`${apiBaseUrl}/api/pilot/shadow/library/pdf-text`, {
      method: 'POST',
      credentials: 'include',
      body: form,
      signal: typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(PDF_READ_TIMEOUT_MS) : undefined,
    });
    const payload: unknown = await response.json().catch(() => null);
    const body = typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>) : {};
    if (response.status === 200 && body.ok === true && Array.isArray(body.pages)) {
      const pages: PdfPageText[] = [];
      for (const page of body.pages) {
        const row = typeof page === 'object' && page !== null ? (page as Record<string, unknown>) : null;
        if (!row || typeof row.num !== 'number' || typeof row.text !== 'string') {
          return { ok: false, status: 0, serverMessage: null };
        }
        pages.push({ num: row.num, text: row.text });
      }
      return {
        ok: true,
        pages,
        emptyPageCount: pages.filter((page) => page.text === '').length,
      };
    }
    return {
      ok: false,
      status: response.status,
      serverMessage: typeof body.error === 'string' && body.error ? body.error : null,
    };
  } catch {
    return { ok: false, status: 0, serverMessage: null };
  }
}

const UNPAIRED_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** Null when the input may be submitted; otherwise the sentence to show. */
export function validateIntakeInput(input: IntakeInput): string | null {
  if (!input.sourceId.trim()) return 'Choose the registered source this text comes from.';
  if (!input.documentName.trim()) return 'Give this excerpt a label.';
  if (!input.locator.trim()) return 'Say where in the source this text is: a page, section or timestamp.';
  const text = normalizeIntakeText(input.text);
  if (!text) return 'Paste or type the source text.';
  // Refused rather than repaired: stripping them would change the source text,
  // and storing them cannot work. Postgres text has no NUL, and an unpaired
  // surrogate is stored as U+FFFD, so the saved text would not be what was
  // submitted. Both are copy-paste damage the curator can see and fix.
  if (text.includes('\u0000') || UNPAIRED_SURROGATE.test(text)) {
    return 'This text contains a damaged character (often left by copying from a PDF). Remove it and try again.';
  }
  if (text.length > INTAKE_MAX_TEXT_LENGTH) {
    return `This text is ${formatIntakeCount(text.length)} characters. One entry holds up to ${formatIntakeCount(INTAKE_MAX_TEXT_LENGTH)}; split it into separate labelled excerpts.`;
  }
  if (input.pdfPage && !isTextFromPage(text, input.pdfPage.text)) {
    return input.pdfPage.notOnPageMessage;
  }
  return null;
}

function refusalMessage(status: number, what: string, shelf: IntakeShelf | undefined): string {
  if (status === 401) return 'Sign in again, then retry.';
  if (status === 403) return 'Your role cannot add text to the Library.';
  if (status === 404) {
    return shelf === 'platform'
      ? `The ${what} was not found on the platform shelf.`
      : `The ${what} was not found in this gym's Library.`;
  }
  if (status === 429) return 'The Library is rate limited right now. Wait a moment and retry.';
  return `The Library refused the ${what} (${status}).`;
}

// Generous: a chunk write embeds its text before it answers.
const REQUEST_TIMEOUT_MS = 60_000;

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
      // A request that never answers must not leave the form on "Saving…".
      signal: typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(REQUEST_TIMEOUT_MS) : undefined,
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
  let shelf: IntakeShelf | undefined;

  if (resume) {
    documentId = resume.documentId;
    chunks = resume.chunks;
    locator = resume.locator;
    startAt = resume.nextOrdinal;
    shelf = resume.shelf;
  } else {
    const invalid = validateIntakeInput(input);
    if (invalid) {
      return { ok: false, message: invalid, resume: null, writtenChunks: 0, totalChunks: 0 };
    }
    chunks = splitIntakeText(input.text);
    locator = input.locator.trim();
    startAt = 0;
    shelf = input.shelf;

    const created = await postJson(fetchImpl, `${apiBaseUrl}/api/pilot/shadow/library/documents`, {
      source_id: input.sourceId,
      document_name: input.documentName.trim(),
      metadata: {
        intake_method: INTAKE_METHOD,
        ...(input.pdfPage ? { text_origin: TEXT_ORIGIN_PDF_PAGE } : {}),
        locator,
        chunk_count: chunks.length,
        text_length: rejoinIntakeChunks(chunks).length,
      },
      ...shelfField(shelf),
    });
    const createdId = created.status === 201 ? documentIdFrom(created.payload) : null;
    if (!createdId) {
      // Only a 4xx is a refusal, and only a refusal proves nothing was stored.
      // No answer, a 5xx, or a 201 without an id can each follow a row that
      // WAS written (the route inserts before it logs), so those say "check"
      // instead of inviting a retry that would file the same text twice.
      const refused = created.status >= 400 && created.status < 500;
      return {
        ok: false,
        message: refused
          ? `${refusalMessage(created.status, 'source', shelf)} Nothing was saved.`
          : 'The Library did not confirm the save. An empty entry with this label may exist: check Evidence Review before trying again, and reject it there if it does.',
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
      ...shelfField(shelf),
    });
    const alreadyStored = resume !== null && written.status === 409;
    if (written.status !== 201 && !alreadyStored) {
      return {
        ok: false,
        message: `Saved ${index} of ${chunks.length} parts, then stopped: ${
          written.status === 0 ? 'the Library could not be reached.' : refusalMessage(written.status, 'document', shelf)
        } The entry is incomplete. Use Finish saving to write the rest.`,
        resume: { documentId, nextOrdinal: index, locator, chunks, ...(shelf === 'platform' ? { shelf } : {}) },
        writtenChunks: index,
        totalChunks: chunks.length,
      };
    }
  }

  return { ok: true, documentId, chunkCount: chunks.length };
}
