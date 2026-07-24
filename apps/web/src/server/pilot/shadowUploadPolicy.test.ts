import {
  describeShadowUpload,
  SHADOW_UPLOAD_MAX_FILE_BYTES,
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
});
