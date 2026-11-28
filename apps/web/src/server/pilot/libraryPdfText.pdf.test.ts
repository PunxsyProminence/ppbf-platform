import { spawn } from 'node:child_process';
import path from 'node:path';

import {
  LIBRARY_PDF_MAX_PAGES,
  extractLibraryPdfPages,
  hasPdfSignature,
} from './libraryPdfText';

const FIXTURE_SCRIPT = path.join(__dirname, 'libraryPdfFixture.mjs');

// Run by `npm run test:pdf-text` with --experimental-vm-modules (npm test ignores
// .pdf.test.ts files). REAL pdf-parse (no mock) over PDFs built in memory, so the
// suite proves the parser loads and keeps page numbers under this repo's jest.
// Generated fixtures only: no real paper is committed (owner decision 2A).

function buildPdf(pageTexts: readonly (string | null)[]): Promise<Buffer> {
  // pdfkit is ESM-only below the surface now (fontkit 3), so it runs in a child
  // process under native Node; see libraryPdfFixture.mjs.
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [FIXTURE_SCRIPT], { stdio: ['pipe', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (part: Buffer) => out.push(part));
    child.stderr.on('data', (part: Buffer) => err.push(part));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`PDF fixture build failed (${code}): ${Buffer.concat(err).toString('utf8')}`));
        return;
      }
      resolve(Buffer.from(Buffer.concat(out).toString('utf8'), 'base64'));
    });
    child.stdin.end(JSON.stringify(pageTexts));
  });
}

describe('extractLibraryPdfPages (real pdf-parse)', () => {
  test('returns each page as its own numbered page', async () => {
    const pdf = await buildPdf(['Alpha page one words.', 'Bravo page two words.', 'Charlie page three words.']);

    const result = await extractLibraryPdfPages(pdf);

    expect(result.pages.map((page) => page.num)).toEqual([1, 2, 3]);
    expect(result.pages[0].text).toContain('Alpha page one words.');
    expect(result.pages[1].text).toContain('Bravo page two words.');
    expect(result.pages[1].text).not.toContain('Alpha');
    expect(result.pages[2].text).toContain('Charlie page three words.');
    expect(result.emptyPageCount).toBe(0);
  });

  test('counts a page with no text layer instead of dropping it', async () => {
    const pdf = await buildPdf(['Has words on this page.', null]);

    const result = await extractLibraryPdfPages(pdf);

    expect(result.pages).toHaveLength(2);
    expect(result.pages[1]).toEqual({ num: 2, text: '' });
    expect(result.emptyPageCount).toBe(1);
  });

  test('does not detach the caller\'s buffer', async () => {
    const pdf = await buildPdf(['Keep my bytes.']);
    const before = pdf.length;

    await extractLibraryPdfPages(pdf);

    expect(pdf.length).toBe(before);
    expect(hasPdfSignature(pdf)).toBe(true);
  });

  test('refuses bytes that are not a PDF, before the parser sees them', async () => {
    await expect(extractLibraryPdfPages(Buffer.from('<html>not a pdf</html>'))).rejects.toMatchObject({
      status: 400,
      code: 'NOT_A_PDF',
    });
  });

  test('a damaged PDF becomes one fixed sentence that does not echo the file', async () => {
    const damaged = Buffer.from('%PDF-1.7\nSECRETWORDS this is not a real pdf body\n%%EOF');

    const failure = await extractLibraryPdfPages(damaged).catch((error: unknown) => error);

    expect(failure).toMatchObject({ status: 422, code: 'PDF_UNREADABLE' });
    expect((failure as Error).message).not.toContain('SECRETWORDS');
  });

  test('refuses a PDF with more pages than the reader sends back', async () => {
    const pdf = await buildPdf(Array.from({ length: LIBRARY_PDF_MAX_PAGES + 1 }, () => 'x'));

    await expect(extractLibraryPdfPages(pdf)).rejects.toMatchObject({ status: 413, code: 'PDF_TOO_MANY_PAGES' });
  }, 60_000);
});

