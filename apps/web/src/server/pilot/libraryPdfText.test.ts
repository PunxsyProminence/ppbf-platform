// pdf-parse is MOCKED here so this suite runs under plain `npm test`. The real
// parser cannot start under jest without --experimental-vm-modules; it is
// exercised by libraryPdfText.pdf.test.ts via `npm run test:pdf-text`.

import {
  LIBRARY_PDF_MAX_PAGES,
  LIBRARY_PDF_MAX_TOTAL_CHARS,
  LIBRARY_PDF_PARSE_TIMEOUT_MS,
  extractLibraryPdfPages,
  hasPdfSignature,
} from './libraryPdfText';

const mockGetText = jest.fn();
const mockDestroy = jest.fn();
const mockConstructor = jest.fn();

jest.mock('pdf-parse', () => ({
  PDFParse: class {
    constructor(options: unknown) {
      mockConstructor(options);
    }
    getText(params: unknown) {
      return mockGetText(params);
    }
    destroy() {
      return mockDestroy();
    }
  },
}));

const PDF_BYTES = Buffer.from('%PDF-1.7 body');

beforeEach(() => {
  jest.resetAllMocks();
  mockDestroy.mockResolvedValue(undefined);
});

// Answers the way pdf-parse does: `total` is the document's page count, and
// `pages` holds only the pages the call asked for.
function mockDocument(pages: Array<{ num: number; text: string }>): void {
  mockGetText.mockImplementation(async (params?: { partial?: number[] }) => ({
    total: pages.length,
    pages: pages.filter((page) => params?.partial?.includes(page.num)),
  }));
}

function requestedPages(): number[][] {
  return mockGetText.mock.calls.map(([params]) => (params as { partial: number[] }).partial);
}

describe('hasPdfSignature', () => {
  test('needs the %PDF- header', () => {
    expect(hasPdfSignature(Buffer.from('%PDF-1.4'))).toBe(true);
    expect(hasPdfSignature(Buffer.from('%PDF'))).toBe(false);
    expect(hasPdfSignature(Buffer.from('PK\u0003\u0004zipfile'))).toBe(false);
    expect(hasPdfSignature(Buffer.alloc(0))).toBe(false);
  });
});

describe('extractLibraryPdfPages', () => {
  test('refuses non-PDF bytes without ever starting the parser', async () => {
    await expect(extractLibraryPdfPages(Buffer.from('<html></html>'))).rejects.toMatchObject({
      status: 400,
      code: 'NOT_A_PDF',
    });
    expect(mockConstructor).not.toHaveBeenCalled();
  });

  test('returns numbered pages, trimmed, with NUL removed and line endings normalised', async () => {
    mockDocument([
      { num: 1, text: '  first\r\npage\u0000  ' },
      { num: 2, text: '' },
      { num: 3, text: 'third' },
    ]);

    const result = await extractLibraryPdfPages(PDF_BYTES);

    expect(result).toEqual({
      pages: [
        { num: 1, text: 'first\npage' },
        { num: 2, text: '' },
        { num: 3, text: 'third' },
      ],
      emptyPageCount: 1,
    });
    expect(requestedPages()).toEqual([[1], [2], [3]]);
  });

  test('hands the parser a copy and always destroys it', async () => {
    mockDocument([{ num: 1, text: 'x' }]);

    await extractLibraryPdfPages(PDF_BYTES);

    const { data } = mockConstructor.mock.calls[0][0] as { data: Buffer };
    expect(data).not.toBe(PDF_BYTES);
    expect(data.equals(PDF_BYTES)).toBe(true);
    expect(mockDestroy).toHaveBeenCalledTimes(1);
  });

  test('a parser failure becomes one fixed sentence and still destroys the parser', async () => {
    mockGetText.mockRejectedValueOnce(new Error('bad xref near SECRETWORDS from the file'));

    const failure = await extractLibraryPdfPages(PDF_BYTES).catch((error: unknown) => error);

    expect(failure).toMatchObject({ status: 422, code: 'PDF_UNREADABLE' });
    expect((failure as Error).message).not.toContain('SECRETWORDS');
    expect(mockDestroy).toHaveBeenCalledTimes(1);
  });

  test('a parse that outlasts the budget is refused', async () => {
    jest.useFakeTimers();
    try {
      mockGetText.mockReturnValueOnce(new Promise(() => undefined));
      const pending = extractLibraryPdfPages(PDF_BYTES).catch((error: unknown) => error);
      await jest.advanceTimersByTimeAsync(LIBRARY_PDF_PARSE_TIMEOUT_MS + 1);

      expect(await pending).toMatchObject({ status: 422, code: 'PDF_TIMEOUT' });
      expect(mockDestroy).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  // CL-C20: the budget used to stop only the wait. The parse ran on through
  // every remaining page after the request had already been refused.
  test('a parse that outlasts the budget mid-document reads no further pages', async () => {
    jest.useFakeTimers();
    try {
      mockGetText
        .mockResolvedValueOnce({ total: 3, pages: [{ num: 1, text: 'one' }] })
        .mockImplementationOnce(() => new Promise((resolve) => {
          setTimeout(() => resolve({ total: 3, pages: [{ num: 2, text: 'two' }] }), LIBRARY_PDF_PARSE_TIMEOUT_MS * 2);
        }))
        .mockResolvedValue({ total: 3, pages: [{ num: 3, text: 'three' }] });
      const pending = extractLibraryPdfPages(PDF_BYTES).catch((error: unknown) => error);
      await jest.advanceTimersByTimeAsync(LIBRARY_PDF_PARSE_TIMEOUT_MS + 1);

      expect(await pending).toMatchObject({ status: 422, code: 'PDF_TIMEOUT' });
      expect(mockDestroy).toHaveBeenCalledTimes(1);

      await jest.advanceTimersByTimeAsync(LIBRARY_PDF_PARSE_TIMEOUT_MS * 2);
      expect(requestedPages()).toEqual([[1], [2]]);
    } finally {
      jest.useRealTimers();
    }
  });

  test('refuses a document with no pages', async () => {
    mockDocument([]);

    await expect(extractLibraryPdfPages(PDF_BYTES)).rejects.toMatchObject({ status: 422, code: 'PDF_NO_PAGES' });
  });

  test('refuses, rather than truncates, past the page cap', async () => {
    mockDocument(Array.from({ length: LIBRARY_PDF_MAX_PAGES + 1 }, (_, index) => ({ num: index + 1, text: 'x' })));

    await expect(extractLibraryPdfPages(PDF_BYTES)).rejects.toMatchObject({ status: 413, code: 'PDF_TOO_MANY_PAGES' });
    // CL-C20: the page count is known after the first page; the other 500
    // are never read.
    expect(requestedPages()).toEqual([[1]]);
  });

  test('refuses, rather than truncates, past the total text cap', async () => {
    mockDocument([
      { num: 1, text: 'a'.repeat(LIBRARY_PDF_MAX_TOTAL_CHARS + 1) },
      { num: 2, text: 'b' },
      { num: 3, text: 'c' },
    ]);

    await expect(extractLibraryPdfPages(PDF_BYTES)).rejects.toMatchObject({ status: 413, code: 'PDF_TOO_MUCH_TEXT' });
    // CL-C20: refused at the page that crossed the cap, not after the rest.
    expect(requestedPages()).toEqual([[1]]);
  });

  test('accepts text exactly at the cap', async () => {
    mockDocument([{ num: 1, text: 'a'.repeat(LIBRARY_PDF_MAX_TOTAL_CHARS) }]);

    const result = await extractLibraryPdfPages(PDF_BYTES);

    expect(result.pages[0].text).toHaveLength(LIBRARY_PDF_MAX_TOTAL_CHARS);
  });
});
