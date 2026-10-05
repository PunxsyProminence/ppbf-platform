// Page-by-page text from a PDF, held in memory for one request (RINT-02).
//
// A curator on /research picks a PDF so they can copy ONE page's (or a trimmed
// span's) own words into the Add Source Text excerpt. Owner decision
// OD-2026-10-02-013, answer 4A: the app keeps only curator-chosen excerpts with
// their citation and page; whole PDFs stay in the SharePoint Research Archive.
//
// So this module is deliberately a pure function of its bytes. It imports no
// database, blob, Graph or filesystem code, returns the text to its caller and
// keeps nothing: the parser is destroyed in `finally`, and neither the buffer
// nor any text is logged or placed in an error message. libraryPdfText.test.ts
// and the route test hold that.

import { Buffer } from 'node:buffer';

import { PDFParse } from 'pdf-parse';

import { PilotError } from './errors';

// The same ceiling /api/document-ingest used (retired 2026-10-03). Library PDFs are papers and book
// chapters; past this the parse is slow, not more useful, and the route holds
// the whole file in memory.
export const LIBRARY_PDF_MAX_BYTES = 10 * 1024 * 1024;

// The same parse budget /api/document-ingest used.
export const LIBRARY_PDF_PARSE_TIMEOUT_MS = 15_000;

// A page list this long is already past what a curator pages through to pick an
// excerpt, and it bounds the response (text of every page travels back in one
// JSON body). Refused rather than truncated: a silently shortened page list
// would let the curator believe the PDF ends where the app stopped reading.
export const LIBRARY_PDF_MAX_PAGES = 500;
export const LIBRARY_PDF_MAX_TOTAL_CHARS = 1_500_000;

export interface LibraryPdfPage {
  // 1-based, as printed on the parser's page index (not the page label).
  num: number;
  text: string;
}

export interface LibraryPdfText {
  pages: LibraryPdfPage[];
  // How many pages had no text layer at all (scans, full-page images).
  emptyPageCount: number;
}

export function hasPdfSignature(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 5
    && bytes[0] === 0x25 // %
    && bytes[1] === 0x50 // P
    && bytes[2] === 0x44 // D
    && bytes[3] === 0x46 // F
    && bytes[4] === 0x2d // -
  );
}

// Text that cannot be stored later is cleaned here rather than at the excerpt:
// Postgres text has no NUL and the intake client refuses it. This removes the
// NUL only and does not touch anything else. Trimming per page is the same
// edge-whitespace rule the intake text already follows.
function cleanPageText(raw: string): string {
  return raw.replace(/\r\n?/g, '\n').replace(/\u0000/g, '').trim();
}

export async function extractLibraryPdfPages(bytes: Uint8Array): Promise<LibraryPdfText> {
  if (!hasPdfSignature(bytes)) {
    throw new PilotError(400, 'That file is not a PDF.', 'NOT_A_PDF');
  }

  // A copy: pdfjs transfers the buffer it is handed to its worker, which would
  // detach the caller's.
  const parser = new PDFParse({ data: Buffer.from(bytes) });
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error('PDF_PARSE_TIMEOUT')), LIBRARY_PDF_PARSE_TIMEOUT_MS);
    });
    // The parser's own error text can echo document content, so it is never
    // passed on: every failure becomes one fixed sentence.
    const result = await Promise.race([parser.getText(), timeout]).catch((error: unknown) => {
      if (error instanceof Error && error.message === 'PDF_PARSE_TIMEOUT') {
        throw new PilotError(422, 'Reading that PDF took too long. Try a smaller file.', 'PDF_TIMEOUT');
      }
      throw new PilotError(422, 'That PDF could not be read. It may be damaged or password protected.', 'PDF_UNREADABLE');
    });

    const parsedPages = Array.isArray(result.pages) ? result.pages : [];
    if (parsedPages.length === 0) {
      throw new PilotError(422, 'That PDF has no pages.', 'PDF_NO_PAGES');
    }
    if (parsedPages.length > LIBRARY_PDF_MAX_PAGES) {
      throw new PilotError(
        413,
        `That PDF has ${parsedPages.length} pages. The reader handles up to ${LIBRARY_PDF_MAX_PAGES}. Split the PDF and read the part you need.`,
        'PDF_TOO_MANY_PAGES',
      );
    }

    let totalChars = 0;
    let emptyPageCount = 0;
    const pages: LibraryPdfPage[] = parsedPages.map((page, index) => {
      const text = cleanPageText(typeof page.text === 'string' ? page.text : '');
      totalChars += text.length;
      if (!text) emptyPageCount += 1;
      return { num: typeof page.num === 'number' && page.num >= 1 ? page.num : index + 1, text };
    });
    if (totalChars > LIBRARY_PDF_MAX_TOTAL_CHARS) {
      throw new PilotError(
        413,
        'That PDF holds more text than the reader will send back. Split the PDF and read the part you need.',
        'PDF_TOO_MUCH_TEXT',
      );
    }

    return { pages, emptyPageCount };
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
    await parser.destroy().catch(() => undefined);
  }
}
