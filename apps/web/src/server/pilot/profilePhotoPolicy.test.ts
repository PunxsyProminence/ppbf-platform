import {
  describeProfilePhotoUpload,
  PROFILE_PHOTO_MAX_EDGE_PX,
  PROFILE_PHOTO_MAX_FILE_BYTES,
  PROFILE_PHOTO_MAX_REQUEST_BYTES,
  PROFILE_PHOTO_MIN_EDGE_PX,
  readImageDimensions,
  stripJpegMetadata,
  stripPngMetadata,
  stripPhotoMetadata,
  validateProfilePhotoContent,
  validateProfilePhotoTransport,
} from './profilePhotoPolicy';

/* ------------------------------------------------------------- FIXTURES -- */

function pngBytes(width: number, height: number, extraChunks: Array<[string, Uint8Array]> = []): Uint8Array {
  const chunks: number[] = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

  const pushChunk = (type: string, data: number[]) => {
    chunks.push((data.length >>> 24) & 0xff, (data.length >>> 16) & 0xff, (data.length >>> 8) & 0xff, data.length & 0xff);
    for (const character of type) chunks.push(character.charCodeAt(0));
    chunks.push(...data);
    chunks.push(0, 0, 0, 0); // CRC placeholder; nothing here verifies it.
  };

  pushChunk('IHDR', [
    (width >>> 24) & 0xff, (width >>> 16) & 0xff, (width >>> 8) & 0xff, width & 0xff,
    (height >>> 24) & 0xff, (height >>> 16) & 0xff, (height >>> 8) & 0xff, height & 0xff,
    8, 6, 0, 0, 0,
  ]);
  for (const [type, data] of extraChunks) pushChunk(type, [...data]);
  pushChunk('IDAT', [0x78, 0x9c, 0x01]);
  pushChunk('IEND', []);
  return new Uint8Array(chunks);
}

function jpegBytes(width: number, height: number, options: { exif?: boolean } = {}): Uint8Array {
  const bytes: number[] = [0xff, 0xd8]; // SOI

  if (options.exif) {
    // APP1 carrying an "Exif\0\0" header and a GPS-looking payload. This is the
    // segment a phone writes the coordinates into.
    const payload = [...'Exif\0\0GPSLatitude 40.9432 GPSLongitude -78.9714'].map((c) => c.charCodeAt(0));
    const length = payload.length + 2;
    bytes.push(0xff, 0xe1, (length >> 8) & 0xff, length & 0xff, ...payload);
  }

  // A quantisation table, which must SURVIVE the strip.
  const dqt = new Array(65).fill(0x10);
  bytes.push(0xff, 0xdb, ((dqt.length + 2) >> 8) & 0xff, (dqt.length + 2) & 0xff, ...dqt);

  // SOF0: length(8), precision, height, width, components
  bytes.push(0xff, 0xc0, 0x00, 0x0b, 0x08,
    (height >> 8) & 0xff, height & 0xff,
    (width >> 8) & 0xff, width & 0xff,
    0x01, 0x01, 0x11, 0x00);

  bytes.push(0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00); // SOS
  bytes.push(0x12, 0x34, 0x56, 0x78); // entropy data
  bytes.push(0xff, 0xd9); // EOI
  return new Uint8Array(bytes);
}

function headers(contentType: string, contentLength: number): Headers {
  return new Headers({ 'content-type': contentType, 'content-length': String(contentLength) });
}

/* --------------------------------------------------------------- TESTS --- */

describe('transport validation refuses before a byte is read', () => {
  it('requires multipart', () => {
    expect(validateProfilePhotoTransport(headers('application/json', 100)))
      .toMatchObject({ ok: false, status: 415 });
  });

  it('requires a bounded Content-Length', () => {
    const withoutLength = new Headers({ 'content-type': 'multipart/form-data; boundary=x' });
    expect(validateProfilePhotoTransport(withoutLength)).toMatchObject({ ok: false, status: 411 });
  });

  it('refuses a request larger than the budget', () => {
    expect(validateProfilePhotoTransport(
      headers('multipart/form-data; boundary=x', PROFILE_PHOTO_MAX_REQUEST_BYTES + 1),
    )).toMatchObject({ ok: false, status: 413 });
  });

  it('accepts a bounded multipart request', () => {
    expect(validateProfilePhotoTransport(headers('multipart/form-data; boundary=x', 40_000)).ok).toBe(true);
  });
});

describe('the descriptor does not trust the client', () => {
  it('accepts a jpeg whose declared type matches its extension', () => {
    expect(describeProfilePhotoUpload({ name: 'me.jpg', type: 'image/jpeg', size: 40_000 }))
      .toMatchObject({ contentType: 'image/jpeg', generatedFileName: 'portrait.jpg' });
  });

  it('refuses a mismatch between the extension and the declared type', () => {
    expect(describeProfilePhotoUpload({ name: 'me.png', type: 'image/jpeg', size: 40_000 })).toBeNull();
  });

  it.each(['me.svg', 'me.gif', 'me.webp', 'me.heic', 'me.exe'])('refuses %s outright', (name) => {
    expect(describeProfilePhotoUpload({ name, type: 'image/jpeg', size: 40_000 })).toBeNull();
  });

  it('refuses a file over the byte cap', () => {
    expect(describeProfilePhotoUpload({
      name: 'me.jpg', type: 'image/jpeg', size: PROFILE_PHOTO_MAX_FILE_BYTES + 1,
    })).toBeNull();
  });

  it('refuses an empty or nonsense size', () => {
    expect(describeProfilePhotoUpload({ name: 'me.jpg', type: 'image/jpeg', size: 0 })).toBeNull();
    expect(describeProfilePhotoUpload({ name: 'me.jpg', type: 'image/jpeg', size: Number.NaN })).toBeNull();
  });

  it('never carries the uploader’s filename into the stored name', () => {
    const descriptor = describeProfilePhotoUpload({
      name: '../../etc/my kid at home 2019.jpg', type: 'image/jpeg', size: 40_000,
    });
    expect(descriptor?.generatedFileName).toBe('portrait.jpg');
    expect(descriptor?.safeOriginalName).not.toContain('/');
    expect(descriptor?.safeOriginalName).not.toContain('..');
  });
});

describe('dimensions are measured from the bytes', () => {
  it('reads a PNG header', () => {
    expect(readImageDimensions('image/png', pngBytes(512, 384))).toEqual({ width: 512, height: 384 });
  });

  it('reads a JPEG SOF', () => {
    expect(readImageDimensions('image/jpeg', jpegBytes(512, 384))).toEqual({ width: 512, height: 384 });
  });

  it('walks past an EXIF segment rather than finding a thumbnail inside it', () => {
    // The APP1 payload is skipped by its own length, so the size that comes
    // back is the real frame's and not something scanned out of the metadata.
    expect(readImageDimensions('image/jpeg', jpegBytes(600, 400, { exif: true })))
      .toEqual({ width: 600, height: 400 });
  });

  it('returns null for bytes that are not the declared format', () => {
    expect(readImageDimensions('image/png', jpegBytes(100, 100))).toBeNull();
    expect(readImageDimensions('image/jpeg', pngBytes(100, 100))).toBeNull();
    expect(readImageDimensions('image/jpeg', new Uint8Array([1, 2, 3, 4]))).toBeNull();
  });
});

describe('content validation is the honest gate', () => {
  it('accepts a portrait at the stored size', () => {
    const result = validateProfilePhotoContent({ contentType: 'image/jpeg' }, jpegBytes(512, 512));
    expect(result.ok).toBe(true);
    expect(result.dimensions).toEqual({ width: 512, height: 512 });
  });

  it('refuses a 12-megapixel phone photo by DIMENSION, not only by bytes', () => {
    // 4032x3024 is an iPhone's native output. The byte payload here is tiny --
    // the point is that the refusal comes from the measured pixel size, so a
    // client that skips the downscale cannot slip one through by compressing
    // hard.
    const huge = jpegBytes(4032, 3024);
    expect(huge.byteLength).toBeLessThan(PROFILE_PHOTO_MAX_FILE_BYTES);
    const result = validateProfilePhotoContent({ contentType: 'image/jpeg' }, huge);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(413);
    expect(result.error).toContain('4032');
  });

  it('refuses one pixel over the edge limit and accepts one pixel under it', () => {
    expect(validateProfilePhotoContent({ contentType: 'image/png' },
      pngBytes(PROFILE_PHOTO_MAX_EDGE_PX + 1, 400)).ok).toBe(false);
    expect(validateProfilePhotoContent({ contentType: 'image/png' },
      pngBytes(PROFILE_PHOTO_MAX_EDGE_PX, 400)).ok).toBe(true);
  });

  it('refuses an icon masquerading as a portrait', () => {
    const result = validateProfilePhotoContent({ contentType: 'image/png' },
      pngBytes(PROFILE_PHOTO_MIN_EDGE_PX - 1, 400));
    expect(result.ok).toBe(false);
    expect(result.status).toBe(400);
  });

  it('refuses empty bytes', () => {
    expect(validateProfilePhotoContent({ contentType: 'image/jpeg' }, new Uint8Array(0)).ok).toBe(false);
  });

  it('refuses a file whose header does not match its declared type', () => {
    const result = validateProfilePhotoContent({ contentType: 'image/png' }, jpegBytes(200, 200));
    expect(result.ok).toBe(false);
    expect(result.status).toBe(415);
  });
});

describe('metadata is stripped before anything is stored', () => {
  it('removes an EXIF segment carrying GPS coordinates from a JPEG', () => {
    const withExif = jpegBytes(400, 300, { exif: true });
    const asText = Buffer.from(withExif).toString('latin1');
    expect(asText).toContain('GPSLatitude');

    const stripped = stripJpegMetadata(withExif);
    expect(Buffer.from(stripped).toString('latin1')).not.toContain('GPSLatitude');
    expect(Buffer.from(stripped).toString('latin1')).not.toContain('Exif');
  });

  it('leaves the image itself intact -- same dimensions, quantisation table kept', () => {
    const stripped = stripJpegMetadata(jpegBytes(400, 300, { exif: true }));
    expect(readImageDimensions('image/jpeg', stripped)).toEqual({ width: 400, height: 300 });
    // 0xFFDB is the quantisation table. Losing it would be losing the image.
    const hasDqt = stripped.some((byte, index) => byte === 0xff && stripped[index + 1] === 0xdb);
    expect(hasDqt).toBe(true);
    // And the entropy-coded scan survives to the end marker.
    expect(stripped[stripped.length - 2]).toBe(0xff);
    expect(stripped[stripped.length - 1]).toBe(0xd9);
  });

  it('removes eXIf and tEXt chunks from a PNG and keeps IHDR/IDAT/IEND', () => {
    const location = new Uint8Array([...'40.9432,-78.9714'].map((c) => c.charCodeAt(0)));
    const withMetadata = pngBytes(300, 300, [['eXIf', location], ['tEXt', location]]);
    expect(Buffer.from(withMetadata).toString('latin1')).toContain('40.9432');

    const stripped = stripPngMetadata(withMetadata);
    const text = Buffer.from(stripped).toString('latin1');
    expect(text).not.toContain('40.9432');
    expect(text).not.toContain('eXIf');
    expect(text).toContain('IHDR');
    expect(text).toContain('IDAT');
    expect(text).toContain('IEND');
    expect(readImageDimensions('image/png', stripped)).toEqual({ width: 300, height: 300 });
  });

  it('dispatches by content type and leaves anything else untouched', () => {
    const png = pngBytes(200, 200);
    expect(stripPhotoMetadata('image/png', png)).not.toBe(png);
    const other = new Uint8Array([1, 2, 3]);
    expect(stripPhotoMetadata('application/octet-stream', other)).toBe(other);
  });

  it('is a no-op on bytes that are not the format it was told they are', () => {
    const notJpeg = new Uint8Array([1, 2, 3, 4]);
    expect(stripJpegMetadata(notJpeg)).toBe(notJpeg);
    expect(stripPngMetadata(notJpeg)).toBe(notJpeg);
  });
});
