// Builds in-memory PDF fixtures for libraryPdfText.pdf.test.ts.
//
// Run as a child process, not imported: pdfkit 0.21 depends on fontkit 3, which
// is ESM-only, and this repo's jest compiles test files to CommonJS, so jest
// cannot load pdfkit in-process (CI Node 22). Native Node loads it fine.
// Input on stdin: JSON array of page texts (string, or null for a page with no
// text). Output on stdout: the PDF as base64. Generated fixtures only: no real
// paper is committed (owner decision 2A).
import PDFDocument from 'pdfkit';

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const pageTexts = JSON.parse(Buffer.concat(chunks).toString('utf8'));

const doc = new PDFDocument({ autoFirstPage: false });
const parts = [];
doc.on('data', (part) => parts.push(part));
doc.on('end', () => process.stdout.write(Buffer.concat(parts).toString('base64')));
for (const text of pageTexts) {
  doc.addPage();
  if (text !== null) doc.fontSize(14).text(text, 72, 72);
}
doc.end();
