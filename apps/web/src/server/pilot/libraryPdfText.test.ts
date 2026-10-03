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
    getText() {
      return mockGetText();
    }
    destroy() {
      return mockDestroy();
    }
  },
}));

const PDF_BYTES = Buffer.from('%PDF-1.7 body');

beforeEach(() => {
  jest.clearAllMocks();
  mockDestroy.mockResolvedValue(undefined);
});

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
    mockGetText.mockResolvedValueOnce({
      pages: [
        { num: 1, text: '  first\r\npage\u0000  ' },
        { num: 2, text: '' },
        { num: 3, text: 'third' },
      ],
    });

    const result = await extractLibraryPdfPages(PDF_BYTES);

    expect(result).toEqual({
      pages: [
        { num: 1, text: 'first\npage' },
        { num: 2, text: '' },
        { num: 3, text: 'third' },
      ],
      emptyPageCount: 1,
    });
  });

  test('hands the parser a copy and always destroys it', async () => {
    mockGetText.mockResolvedValueOnce({ pages: [{ num: 1, text: 'x' }] });

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

  test('refuses a document with no pages', async () => {
    mockGetText.mockResolvedValueOnce({ pages: [] });

    await expect(extractLibraryPdfPages(PDF_BYTES)).rejects.toMatchObject({ status: 422, code: 'PDF_NO_PAGES' });
  });

  test('refuses, rather than truncates, past the page cap', async () => {
    mockGetText.mockResolvedValueOnce({
      pages: Array.from({ length: LIBRARY_PDF_MAX_PAGES + 1 }, (_, index) => ({ num: index + 1, text: 'x' })),
    });

    await expect(extractLibraryPdfPages(PDF_BYTES)).rejects.toMatchObject({ status: 413, code: 'PDF_TOO_MANY_PAGES' });
  });

  test('refuses, rather than truncates, past the total text cap', async () => {
    mockGetText.mockResolvedValueOnce({
      pages: [{ num: 1, text: 'a'.repeat(LIBRARY_PDF_MAX_TOTAL_CHARS + 1) }],
    });

    await expect(extractLibraryPdfPages(PDF_BYTES)).rejects.toMatchObject({ status: 413, code: 'PDF_TOO_MUCH_TEXT' });
  });

  test('accepts text exactly at the cap', async () => {
    mockGetText.mockResolvedValueOnce({ pages: [{ num: 1, text: 'a'.repeat(LIBRARY_PDF_MAX_TOTAL_CHARS) }] });

    const result = await extractLibraryPdfPages(PDF_BYTES);

    expect(result.pages[0].text).toHaveLength(LIBRARY_PDF_MAX_TOTAL_CHARS);
  });
});
