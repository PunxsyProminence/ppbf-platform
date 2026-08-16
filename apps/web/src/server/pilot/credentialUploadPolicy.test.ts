import {
  CREDENTIAL_MAX_FILE_BYTES,
  CREDENTIAL_MAX_REQUEST_BYTES,
  describeCredentialUpload,
  validateCredentialContent,
  validateCredentialUploadTransport,
} from './credentialUploadPolicy';

function headers(contentType: string, contentLength: number): Headers {
  return new Headers({ 'content-type': contentType, 'content-length': String(contentLength) });
}

function pdfBytes(size = 32): Uint8Array {
  const bytes = new Uint8Array(size);
  const signature = [0x25, 0x50, 0x44, 0x46, 0x2d]; // '%PDF-'
  signature.forEach((value, index) => { bytes[index] = value; });
  return bytes;
}

function pngBytes(width = 100, height = 100): Uint8Array {
  const chunks: number[] = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const pushChunk = (type: string, data: number[]) => {
    chunks.push((data.length >>> 24) & 0xff, (data.length >>> 16) & 0xff, (data.length >>> 8) & 0xff, data.length & 0xff);
    for (const character of type) chunks.push(character.charCodeAt(0));
    chunks.push(...data);
    chunks.push(0, 0, 0, 0);
  };
  pushChunk('IHDR', [
    (width >>> 24) & 0xff, (width >>> 16) & 0xff, (width >>> 8) & 0xff, width & 0xff,
    (height >>> 24) & 0xff, (height >>> 16) & 0xff, (height >>> 8) & 0xff, height & 0xff,
    8, 6, 0, 0, 0,
  ]);
  pushChunk('IDAT', [0x78, 0x9c, 0x01]);
  pushChunk('IEND', []);
  return new Uint8Array(chunks);
}

describe('transport validation refuses before a byte is read', () => {
  it('requires multipart', () => {
    expect(validateCredentialUploadTransport(headers('application/json', 100)))
      .toMatchObject({ ok: false, status: 415 });
  });

  it('requires a bounded Content-Length', () => {
    const withoutLength = new Headers({ 'content-type': 'multipart/form-data; boundary=x' });
    expect(validateCredentialUploadTransport(withoutLength)).toMatchObject({ ok: false, status: 411 });
  });

  it('refuses a request larger than the budget', () => {
    expect(validateCredentialUploadTransport(
      headers('multipart/form-data; boundary=x', CREDENTIAL_MAX_REQUEST_BYTES + 1),
    )).toMatchObject({ ok: false, status: 413 });
  });

  it('accepts a bounded multipart request', () => {
    expect(validateCredentialUploadTransport(headers('multipart/form-data; boundary=x', 40_000)).ok).toBe(true);
  });
});

describe('describeCredentialUpload', () => {
  it('accepts a PDF and generates a fixed stored name', () => {
    const descriptor = describeCredentialUpload({ name: 'my safesport cert.pdf', type: 'application/pdf', size: 1000 });
    expect(descriptor).toEqual({ generatedFileName: 'credential.pdf', contentType: 'application/pdf' });
  });

  it('accepts JPG and PNG', () => {
    expect(describeCredentialUpload({ name: 'card.jpg', type: 'image/jpeg', size: 1000 })?.generatedFileName)
      .toBe('credential.jpg');
    expect(describeCredentialUpload({ name: 'card.png', type: 'image/png', size: 1000 })?.generatedFileName)
      .toBe('credential.png');
  });

  it('refuses an unsupported extension', () => {
    expect(describeCredentialUpload({ name: 'cert.docx', type: 'application/msword', size: 1000 })).toBeNull();
  });

  it('refuses a mismatched declared type', () => {
    expect(describeCredentialUpload({ name: 'cert.pdf', type: 'image/png', size: 1000 })).toBeNull();
  });

  it('refuses an oversized file', () => {
    expect(describeCredentialUpload({ name: 'cert.pdf', type: 'application/pdf', size: CREDENTIAL_MAX_FILE_BYTES + 1 }))
      .toBeNull();
  });

  it('refuses an empty file', () => {
    expect(describeCredentialUpload({ name: 'cert.pdf', type: 'application/pdf', size: 0 })).toBeNull();
  });

  it('strips a path-like filename down to its base name', () => {
    const descriptor = describeCredentialUpload({ name: 'C:\\fake\\path\\cert.pdf', type: 'application/pdf', size: 1000 });
    expect(descriptor?.generatedFileName).toBe('credential.pdf');
  });
});

describe('validateCredentialContent', () => {
  it('accepts real PDF bytes', () => {
    expect(validateCredentialContent({ contentType: 'application/pdf' }, pdfBytes())).toEqual({ ok: true });
  });

  it('refuses bytes that do not start with the PDF signature, even with a .pdf name', () => {
    const spoofed = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04, 0x05]);
    expect(validateCredentialContent({ contentType: 'application/pdf' }, spoofed))
      .toMatchObject({ ok: false, status: 415 });
  });

  it('accepts real PNG bytes', () => {
    expect(validateCredentialContent({ contentType: 'image/png' }, pngBytes())).toEqual({ ok: true });
  });

  it('refuses bytes that do not match the declared image type', () => {
    const spoofed = new Uint8Array([0x00, 0x01, 0x02, 0x03]);
    expect(validateCredentialContent({ contentType: 'image/png' }, spoofed))
      .toMatchObject({ ok: false, status: 415 });
  });

  it('refuses an empty payload', () => {
    expect(validateCredentialContent({ contentType: 'application/pdf' }, new Uint8Array(0)))
      .toMatchObject({ ok: false, status: 413 });
  });

  it('refuses a payload over the size cap', () => {
    const oversized = new Uint8Array(CREDENTIAL_MAX_FILE_BYTES + 1);
    expect(validateCredentialContent({ contentType: 'application/pdf' }, oversized))
      .toMatchObject({ ok: false, status: 413 });
  });
});
