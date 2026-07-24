import {
  describeShadowUpload,
  SHADOW_UPLOAD_MAX_FILE_BYTES,
  validateShadowUploadContent,
  validateShadowUploadTransport,
} from './shadowUploadPolicy';

describe('SHADOW upload policy', () => {
  test('requires a bounded multipart request before form parsing', () => {
    expect(validateShadowUploadTransport(new Headers({
      'content-type': 'multipart/form-data; boundary=test',
    }))).toEqual(expect.objectContaining({ ok: false, status: 411 }));
  });

  test('rejects an oversized request before form parsing', () => {
    expect(validateShadowUploadTransport(new Headers({
      'content-type': 'multipart/form-data; boundary=test',
      'content-length': String(12 * 1024 * 1024),
    }))).toEqual(expect.objectContaining({ ok: false, status: 413 }));
  });

  test('allows a bounded multipart request', () => {
    expect(validateShadowUploadTransport(new Headers({
      'content-type': 'multipart/form-data; boundary=test',
      'content-length': '4096',
    })).ok).toBe(true);
  });

  test('uses a generated blob filename and sanitizes metadata names', () => {
    expect(describeShadowUpload({
      name: '../../unsafe\u0000 report.pdf',
      type: 'application/pdf',
      size: 100,
    })).toEqual({
      safeOriginalName: 'unsafe report.pdf',
      generatedFileName: 'source.pdf',
      contentType: 'application/pdf',
    });
  });

  test.each([
    { name: 'script.exe', type: 'application/octet-stream', size: 100 },
    { name: 'spoofed.pdf', type: 'application/x-msdownload', size: 100 },
    { name: 'empty.pdf', type: 'application/pdf', size: 0 },
    { name: 'huge.pdf', type: 'application/pdf', size: SHADOW_UPLOAD_MAX_FILE_BYTES + 1 },
  ])('rejects unsupported or unsafe file %#', (file) => {
    expect(describeShadowUpload(file)).toBeNull();
  });

  test('accepts matching bounded PDF, DOCX, and UTF-8 text signatures', () => {
    expect(validateShadowUploadContent(
      { contentType: 'application/pdf' },
      new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]),
    )).toEqual({ ok: true });
    expect(validateShadowUploadContent(
      { contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
      new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00]),
    )).toEqual({ ok: true });
    expect(validateShadowUploadContent(
      { contentType: 'text/plain' },
      new TextEncoder().encode('Safe UTF-8 text'),
    )).toEqual({ ok: true });
  });

  test.each([
    ['application/pdf', new Uint8Array([0x50, 0x4b, 0x03, 0x04])],
    [
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]),
    ],
    ['text/plain', new Uint8Array([0x61, 0x00, 0x62])],
  ])('rejects spoofed or binary content declared as %s', (contentType, bytes) => {
    expect(validateShadowUploadContent({ contentType }, bytes).ok).toBe(false);
  });

  test('rejects invalid UTF-8 and empty content', () => {
    expect(validateShadowUploadContent(
      { contentType: 'text/plain' },
      new Uint8Array([0xc3, 0x28]),
    ).ok).toBe(false);
    expect(validateShadowUploadContent(
      { contentType: 'application/pdf' },
      new Uint8Array(),
    ).ok).toBe(false);
  });
});
