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

// Mirrors MAX_LOCATOR_LENGTH in the chunk route.
export const INTAKE_MAX_LOCATOR_LENGTH = 200;

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
  // The Research Archive original the PDF was filed as (lane L57). Sent only
  // with pdfPage: an excerpt is linked to a filed PDF only when it was read
  // from that PDF in this session.
  archivedOriginalId?: string;
}

// Everything needed to finish a submission whose chunks do not all exist yet.
// Carries the ORIGINAL split, so a retry writes the same text at the same
// ordinals even if the form has changed since.
//
// documentId is null when the document's own answer was lost (L54): it may or
// may not exist. Finish saving then sends the same document request again with
// the same requestId, and the server answers with the document it already made
// if there is one, so nothing is filed twice and the entry stays with the
// source it was started under.
export interface IntakeResume {
  documentId: string | null;
  nextOrdinal: number;
  locator: string;
  chunks: IntakeChunk[];
  // The shelf the document was created on: its chunks must go to the same one.
  shelf?: IntakeShelf;
  requestId: string;
  // The document request exactly as first sent; used only while documentId is null.
  documentRequest: Record<string, unknown>;
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
  // contentSha256: of the bytes the reader parsed, so a filed original can be
  // matched to the file the pages came from. Null if the server sent none.
  | { ok: true; pages: PdfPageText[]; emptyPageCount: number; contentSha256: string | null }
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
      const sha = body.content_sha256;
      return {
        ok: true,
        pages,
        emptyPageCount: pages.filter((page) => page.text === '').length,
        contentSha256: typeof sha === 'string' && /^[0-9a-f]{64}$/.test(sha) ? sha : null,
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
  // The chunk route's limit (chunks/route.ts MAX_LOCATOR_LENGTH): said here, before any part is saved.
  if (input.locator.trim().length > INTAKE_MAX_LOCATOR_LENGTH) {
    return `Keep "where in the source" to ${INTAKE_MAX_LOCATOR_LENGTH} characters or fewer.`;
  }
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

// The excerpt budget's refusal code (shadowLibrary.ts EXCERPT_BUDGET_EXCEEDED_CODE;
// not imported, so this client module carries no server import).
const EXCERPT_BUDGET_EXCEEDED_CODE = 'SHADOW_LIBRARY_EXCERPT_BUDGET_EXCEEDED';
// The chunk route's answer when different text is stored at that part (L54).
const CHUNK_CONFLICT_CODE = 'SHADOW_LIBRARY_CHUNK_CONFLICT';

function serverError(payload: unknown): { error: string | null; code: string | null } {
  if (typeof payload !== 'object' || payload === null) return { error: null, code: null };
  const { error, code } = payload as { error?: unknown; code?: unknown };
  return {
    error: typeof error === 'string' && error.trim() ? error.trim() : null,
    code: typeof code === 'string' ? code : null,
  };
}

function refusalMessage(status: number, what: string, shelf: IntakeShelf | undefined, payload?: unknown): string {
  // A 422 is a Library rule (source rights, the excerpt budget), and the
  // server's sentence says which and what to do; a status number does not.
  if (status === 422) {
    const { error } = serverError(payload);
    if (error) return error;
  }
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

// One id per entry, sent with the document request and again on every retry
// of it. Uniqueness is all it needs; it is not a secret.
export function newIntakeRequestId(): string {
  const cryptoApi = (globalThis as { crypto?: Crypto }).crypto;
  if (cryptoApi && typeof cryptoApi.randomUUID === 'function') return cryptoApi.randomUUID();
  const bytes = new Uint8Array(16);
  if (cryptoApi && typeof cryptoApi.getRandomValues === 'function') cryptoApi.getRandomValues(bytes);
  else for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

// L54 copy (accepted by Overwatch 2026-10-18).
export const INTAKE_RECOVERY_WORDS = {
  documentUnconfirmed:
    'The Library did not confirm the save. Use Finish saving: it finds the entry if it was saved and finishes it, without saving anything twice.',
  chunkConflict: (saved: number, total: number) =>
    `Saved ${saved} of ${total} parts, then stopped: part ${saved + 1} is already saved with different text. Nothing was overwritten. The entry is incomplete; reject it in Evidence Review, then enter the text again.`,
};

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

function alreadyStoredFrom(status: number, payload: unknown): boolean {
  return status === 200
    && typeof payload === 'object' && payload !== null
    && (payload as { already_stored?: unknown }).already_stored === true;
}

/**
 * Writes the document, then each chunk in ordinal order, stopping at the first
 * failure.
 *
 * Not atomic, and it does not pretend to be: the routes are separate requests.
 * When a write's answer is lost or refused part-way, the result says how far it
 * got and carries a resume token. Passing that token back finishes the same
 * entry: the document request goes again with the same request id when its
 * own answer was lost, then the chunks from the failed ordinal.
 *
 * A part counts as written only when the server says so: 201, or 200 with
 * already_stored (it compared the stored part with this one and they are the
 * same). A 409 means different text is already stored there; that is never
 * reported as saved (L54; audit 2026-10-17 item 2).
 */
export async function submitLibraryTextIntake(
  apiBaseUrl: string,
  input: IntakeInput,
  options: { resume?: IntakeResume | null; fetchImpl?: typeof fetch } = {},
): Promise<IntakeResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const resume = options.resume ?? null;

  let documentId: string | null;
  let chunks: IntakeChunk[];
  let locator: string;
  let startAt: number;
  let shelf: IntakeShelf | undefined;
  let requestId: string;
  let documentRequest: Record<string, unknown>;

  if (resume) {
    documentId = resume.documentId;
    chunks = resume.chunks;
    locator = resume.locator;
    startAt = resume.nextOrdinal;
    shelf = resume.shelf;
    requestId = resume.requestId;
    documentRequest = resume.documentRequest;
  } else {
    const invalid = validateIntakeInput(input);
    if (invalid) {
      return { ok: false, message: invalid, resume: null, writtenChunks: 0, totalChunks: 0 };
    }
    chunks = splitIntakeText(input.text);
    locator = input.locator.trim();
    startAt = 0;
    shelf = input.shelf;
    requestId = newIntakeRequestId();
    documentRequest = {
      source_id: input.sourceId,
      document_name: input.documentName.trim(),
      metadata: {
        intake_method: INTAKE_METHOD,
        ...(input.pdfPage ? { text_origin: TEXT_ORIGIN_PDF_PAGE } : {}),
        locator,
        chunk_count: chunks.length,
        text_length: rejoinIntakeChunks(chunks).length,
      },
      ...(input.pdfPage && input.archivedOriginalId ? { archived_original_id: input.archivedOriginalId } : {}),
      request_id: requestId,
      ...shelfField(shelf),
    };
    documentId = null;
  }
  const resumeFrom = (nextOrdinal: number, id: string | null): IntakeResume => ({
    documentId: id,
    nextOrdinal,
    locator,
    chunks,
    ...(shelf === 'platform' ? { shelf } : {}),
    requestId,
    documentRequest,
  });

  if (documentId === null) {
    const created = await postJson(fetchImpl, `${apiBaseUrl}/api/pilot/shadow/library/documents`, documentRequest);
    // 201: made now. 200: the server found the document this request id made
    // earlier, whose answer was lost.
    const createdId = created.status === 201 || created.status === 200 ? documentIdFrom(created.payload) : null;
    if (!createdId) {
      // On a first attempt only a 4xx is a refusal, and only a refusal proves
      // nothing was stored. No answer, a 5xx, or a success without an id can
      // each follow a document that WAS written, so they offer Finish saving,
      // which asks again with the same request id instead of filing the text
      // twice. On Finish saving even a refusal proves nothing about the FIRST
      // request (a session that expired since, a rate limit), so the entry
      // stays resumable and locked to what was first sent.
      const refused = created.status >= 400 && created.status < 500;
      if (refused && resume === null) {
        return {
          ok: false,
          message: `${refusalMessage(created.status, 'source', shelf, created.payload)} Nothing was saved.`,
          resume: null,
          writtenChunks: 0,
          totalChunks: chunks.length,
        };
      }
      return {
        ok: false,
        message: refused
          ? `${refusalMessage(created.status, 'source', shelf, created.payload)} ${INTAKE_RECOVERY_WORDS.documentUnconfirmed}`
          : INTAKE_RECOVERY_WORDS.documentUnconfirmed,
        resume: resumeFrom(0, null),
        writtenChunks: 0,
        totalChunks: chunks.length,
      };
    }
    documentId = createdId;
    startAt = 0;
  }

  for (let index = startAt; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    const written = await postJson(fetchImpl, `${apiBaseUrl}/api/pilot/shadow/library/chunks`, {
      document_id: documentId,
      ordinal: chunk.ordinal,
      text_content: chunk.text,
      // An excerpt names where it comes from; the chunk route stores it as one
      // (source rights, OD-2026-10-03-002 section 3).
      excerpt_locator: locator,
      metadata: { intake_method: INTAKE_METHOD, locator, join_before: chunk.joinBefore },
      ...shelfField(shelf),
    });
    if (written.status !== 201 && !alreadyStoredFrom(written.status, written.payload)) {
      // Different text is already stored at this part: retrying cannot change
      // that, so no Finish saving is offered, and it is never counted as saved.
      // Only the route's own comparison says so; any other 409 (a document
      // that moved source mid-save) is an ordinary failure, resumable.
      if (written.status === 409 && serverError(written.payload).code === CHUNK_CONFLICT_CODE) {
        return {
          ok: false,
          message: INTAKE_RECOVERY_WORDS.chunkConflict(index, chunks.length),
          resume: null,
          writtenChunks: index,
          totalChunks: chunks.length,
        };
      }
      // Over the source's excerpt budget, a retry is refused the same way, so
      // no "Finish saving" is offered (CL-C2).
      if (written.status === 422 && serverError(written.payload).code === EXCERPT_BUDGET_EXCEEDED_CODE) {
        return {
          ok: false,
          message: `Saved ${index} of ${chunks.length} parts, then stopped: ${
            refusalMessage(written.status, 'document', shelf, written.payload)
          } The entry is incomplete; reject it in Evidence Review, or save a shorter excerpt.`,
          resume: null,
          writtenChunks: index,
          totalChunks: chunks.length,
        };
      }
      return {
        ok: false,
        message: `Saved ${index} of ${chunks.length} parts, then stopped: ${
          written.status === 0 ? 'the Library could not be reached.' : refusalMessage(written.status, 'document', shelf, written.payload)
        } The entry is incomplete. Use Finish saving to write the rest.`,
        resume: resumeFrom(index, documentId),
        writtenChunks: index,
        totalChunks: chunks.length,
      };
    }
  }

  return { ok: true, documentId, chunkCount: chunks.length };
}

// ---------------------------------------------------------------------------
// Filing the PDF in the SharePoint Research Archive (lane L57, issue #345).
// The archive-original route files it and records where it went; the app keeps
// no copy. ON only where the deployment and the shelf are set up for it.

export type ArchiveFilingStatus = 'on' | 'off' | 'unavailable';

export const ARCHIVE_ACQUISITION_CHANNELS = [
  'library_database',
  'publisher_site',
  'open_access_repository',
  'author_copy',
  'ppbf_created',
  'other',
] as const;
export type ArchiveAcquisitionChannel = (typeof ARCHIVE_ACQUISITION_CHANNELS)[number];

export const ARCHIVE_VERSION_KINDS = [
  'version_of_record',
  'accepted_manuscript',
  'author_original',
  'corrected_version_of_record',
  'other',
  'unknown',
] as const;
export type ArchiveVersionKind = (typeof ARCHIVE_VERSION_KINDS)[number];

export interface FiledOriginal {
  archivedOriginalId: string;
  sourceId: string;
  archiveDomainCode: string;
  archiveFilename: string;
  webUrl: string | null;
  contentSha256: string;
}

export type ArchiveFilingResult =
  | { ok: true; alreadyFiled: boolean; original: FiledOriginal }
  | { ok: false; status: number; serverMessage: string | null; code: string | null };

/** Whether this shelf files originals here. Never throws; no answer reads as unavailable. */
export async function readArchiveFilingStatus(
  apiBaseUrl: string,
  shelf: IntakeShelf | undefined,
  options: { fetchImpl?: typeof fetch } = {},
): Promise<ArchiveFilingStatus> {
  const fetchImpl = options.fetchImpl ?? fetch;
  try {
    const response = await fetchImpl(
      `${apiBaseUrl}/api/pilot/shadow/library/archive-original${shelf === 'platform' ? '?shelf=platform' : ''}`,
      { method: 'GET', credentials: 'include' },
    );
    const payload = (await response.json().catch(() => null)) as { archive?: unknown } | null;
    const archive = payload?.archive;
    if (response.status === 200 && (archive === 'on' || archive === 'off' || archive === 'unavailable')) return archive;
    // A role that cannot file sees no filing at all.
    return response.status === 403 ? 'off' : 'unavailable';
  } catch {
    return 'unavailable';
  }
}

// One upload of up to 10 MB plus a SharePoint write.
const ARCHIVE_FILING_TIMEOUT_MS = 90_000;

/** Files the PDF for this source. Never throws. */
export async function fileLibraryPdfOriginal(
  apiBaseUrl: string,
  file: File,
  fields: {
    sourceId: string;
    acquisitionProvider: string;
    acquisitionChannel: ArchiveAcquisitionChannel;
    versionKind: ArchiveVersionKind;
    acquiredAt: string;
    shelf?: IntakeShelf;
  },
  options: { fetchImpl?: typeof fetch } = {},
): Promise<ArchiveFilingResult> {
  if (file.size > PDF_READ_MAX_BYTES) return { ok: false, status: 413, serverMessage: null, code: null };
  const fetchImpl = options.fetchImpl ?? fetch;
  const form = new FormData();
  form.append('file', file);
  form.append('source_id', fields.sourceId);
  form.append('acquisition_provider', fields.acquisitionProvider);
  form.append('acquisition_channel', fields.acquisitionChannel);
  form.append('version_kind', fields.versionKind);
  if (fields.acquiredAt.trim()) form.append('acquired_at', fields.acquiredAt.trim());
  if (fields.shelf === 'platform') form.append('shelf', 'platform');
  try {
    const response = await fetchImpl(`${apiBaseUrl}/api/pilot/shadow/library/archive-original`, {
      method: 'POST',
      credentials: 'include',
      body: form,
      signal: typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(ARCHIVE_FILING_TIMEOUT_MS) : undefined,
    });
    const payload: unknown = await response.json().catch(() => null);
    const body = typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>) : {};
    const row = typeof body.archived_original === 'object' && body.archived_original !== null
      ? (body.archived_original as Record<string, unknown>)
      : null;
    if (
      (response.status === 201 || response.status === 200)
      && body.ok === true
      && row
      && typeof row.archived_original_id === 'string'
      && typeof row.source_id === 'string'
      && typeof row.archive_domain_code === 'string'
      && typeof row.archive_filename === 'string'
      && typeof row.content_sha256 === 'string'
    ) {
      return {
        ok: true,
        alreadyFiled: body.status === 'already_filed',
        original: {
          archivedOriginalId: row.archived_original_id,
          sourceId: row.source_id,
          archiveDomainCode: row.archive_domain_code,
          archiveFilename: row.archive_filename,
          webUrl: typeof row.web_url === 'string' ? row.web_url : null,
          contentSha256: row.content_sha256,
        },
      };
    }
    const { error, code } = serverError(payload);
    return { ok: false, status: response.status, serverMessage: error, code };
  } catch {
    return { ok: false, status: 0, serverMessage: null, code: null };
  }
}

/**
 * The filed original an excerpt may be linked to: only one filed for the
 * excerpt's own source, from the very bytes the pages were read from.
 */
export function linkableOriginal(
  filed: FiledOriginal | null,
  sourceId: string,
  readSha256: string | null,
): FiledOriginal | null {
  if (!filed || readSha256 === null) return null;
  return filed.sourceId === sourceId && filed.contentSha256 === readSha256 ? filed : null;
}
