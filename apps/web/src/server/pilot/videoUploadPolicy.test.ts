import {
  describeVideoUpload,
  validateVideoUploadSignature,
  validateVideoUploadTransport,
  VIDEO_UPLOAD_MAX_REQUEST_BYTES,
} from './videoUploadPolicy';

describe('video upload policy', () => {
  test('rejects missing, malformed, and oversized request lengths before form parsing', () => {
    expect(validateVideoUploadTransport(new Headers({
      'content-type': 'multipart/form-data; boundary=test',
    }))).toEqual(expect.objectContaining({ ok: false, status: 411 }));
    expect(validateVideoUploadTransport(new Headers({
      'content-type': 'multipart/form-data; boundary=test',
      'content-length': 'not-a-number',
    }))).toEqual(expect.objectContaining({ ok: false, status: 411 }));
    expect(validateVideoUploadTransport(new Headers({
      'content-type': 'multipart/form-data; boundary=test',
      'content-length': String(VIDEO_UPLOAD_MAX_REQUEST_BYTES + 1),
    }))).toEqual(expect.objectContaining({ ok: false, status: 413 }));
  });

  test('requires extension and MIME agreement and generates the object name', () => {
    expect(describeVideoUpload({
      name: '../../unsafe\u0000 clip.mp4',
      type: 'video/mp4',
      size: 100,
    })).toEqual({
      safeOriginalName: 'unsafe clip.mp4',
      generatedFileName: 'source.mp4',
      contentType: 'video/mp4',
    });
    expect(describeVideoUpload({
      name: 'spoofed.mp4',
      type: 'video/webm',
      size: 100,
    })).toBeNull();
  });

  test('validates container signatures and rejects MIME spoofing', () => {
    const mp4 = new Uint8Array([0, 0, 0, 20, 0x66, 0x74, 0x79, 0x70, 0, 0, 0, 0]);
    const webm = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]);
    expect(validateVideoUploadSignature({ contentType: 'video/mp4' }, mp4)).toBe(true);
    expect(validateVideoUploadSignature({ contentType: 'video/webm' }, webm)).toBe(true);
    expect(validateVideoUploadSignature({ contentType: 'video/mp4' }, webm)).toBe(false);
    expect(validateVideoUploadSignature({ contentType: 'video/webm' }, new Uint8Array())).toBe(false);
  });
});
