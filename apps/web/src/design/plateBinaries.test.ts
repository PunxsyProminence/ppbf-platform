import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

/**
 * THE PLATE LAWS, ENFORCED ON THE BYTES.
 *
 * Three attempts were made to get background images into this repository.
 * Two failed, and both failed in ways a human reviewer could not see:
 *
 *   - base64 sidecars relayed through a chat channel arrived as 11-41 byte
 *     stubs;
 *   - one that looked plausible at 2.3KB had a valid JPEG *header*, no
 *     end-of-image trailer, and was 600x360 against a 1920x1080 spec.
 *
 * That second one is the reason this file opens the bytes. A truncated JPEG
 * has a correct SOI marker and correct dimensions in its SOF segment. It
 * renders as a partial image or not at all, and every check short of reading
 * to the last two bytes says it is fine.
 *
 * The Grok visual lane (docs/GROK-VISUAL-LANE.md) makes this a gate rather
 * than a habit: a plate that does not satisfy every law below does not enter
 * the repository, and the producer is told which law it broke rather than
 * having it silently corrected here.
 */

const PLATES_DIR = path.join(__dirname, '../../public/plates');
const CSS = path.join(__dirname, '../../../../design-system/ppbf.css');

const SOI = Buffer.from([0xff, 0xd8]);
const EOI = Buffer.from([0xff, 0xd9]);

/** Per-plate budget. Each route fetches only its own plate and it caches. */
const MAX_BYTES = 400 * 1024;

interface Sof {
  readonly width: number;
  readonly height: number;
  /** [horizontal, vertical] sampling factor per colour component. */
  readonly sampling: ReadonlyArray<readonly [number, number]>;
}

/**
 * Parses the start-of-frame segment by walking JPEG markers.
 *
 * Deliberately hand-rolled: this repository has no image library, and adding
 * one to read nine bytes would be a dependency whose own supply chain then
 * needs watching. The walk skips standalone markers (SOI/EOI and the RSTn
 * range carry no length field) and otherwise jumps by each segment's declared
 * length.
 */
function readSof(bytes: Buffer): Sof | null {
  let i = 2;
  while (i < bytes.length - 1) {
    if (bytes[i] !== 0xff) {
      i += 1;
      continue;
    }
    const marker = bytes[i + 1];
    // SOF0 baseline, SOF1 extended, SOF2 progressive, SOF3 lossless.
    if (marker >= 0xc0 && marker <= 0xc3) {
      const componentCount = bytes[i + 9];
      const sampling: Array<readonly [number, number]> = [];
      for (let c = 0; c < componentCount; c += 1) {
        const factors = bytes[i + 10 + c * 3 + 1];
        sampling.push([factors >> 4, factors & 0x0f]);
      }
      return { height: bytes.readUInt16BE(i + 5), width: bytes.readUInt16BE(i + 7), sampling };
    }
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    i += 2 + bytes.readUInt16BE(i + 2);
  }
  return null;
}

const files = readdirSync(PLATES_DIR).filter((name) => name.endsWith('.jpg')).sort();

describe('every committed plate is a whole file', () => {
  it('finds plates to check at all, or this suite proves nothing', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files)('%s starts with a JPEG start-of-image marker', (name) => {
    const bytes = readFileSync(path.join(PLATES_DIR, name));
    expect(bytes.subarray(0, 2).equals(SOI)).toBe(true);
  });

  /* The law the 2.3KB file broke. A header-only check installs it silently. */
  it.each(files)('%s ends with an end-of-image marker, so it is not truncated', (name) => {
    const bytes = readFileSync(path.join(PLATES_DIR, name));
    expect(bytes.subarray(bytes.length - 2).equals(EOI)).toBe(true);
  });

  /* The law the base64 relay broke. A stub can still carry both markers. */
  it.each(files)('%s is a plausible photograph, not a stub', (name) => {
    const bytes = readFileSync(path.join(PLATES_DIR, name));
    expect(bytes.length).toBeGreaterThan(8 * 1024);
  });

  it.each(files)('%s stays inside the per-plate budget', (name) => {
    const bytes = readFileSync(path.join(PLATES_DIR, name));
    expect(bytes.length).toBeLessThanOrEqual(MAX_BYTES);
  });
});

describe('every committed plate is encoded for dark material', () => {
  /**
   * 4:4:4. The plates README states it and every current plate satisfies it,
   * but nothing enforced it: dark leather and ink wells band badly under
   * 4:2:0, and banding on a wall behind a panel reads as a rendering fault in
   * the app rather than as a compression artefact in an image.
   *
   * This sandbox has no cjpeg, no ImageMagick and no Pillow, so a subsampled
   * plate cannot be silently re-encoded on the way in even if that were
   * desirable. It is refused and sent back instead, which keeps the fix with
   * whoever produced the file.
   */
  it.each(files)('%s carries no chroma subsampling', (name) => {
    const sof = readSof(readFileSync(path.join(PLATES_DIR, name)));
    expect(sof).not.toBeNull();
    expect(sof?.sampling.every(([h, v]) => h === 1 && v === 1)).toBe(true);
  });

  /* Landscape walls and the one portrait crop, at the shipped resolution.
     A plate arriving at the wrong size is the other half of what the 600x360
     file got wrong, and it is invisible until somebody opens the image. */
  it.each(files)('%s is one of the declared plate geometries', (name) => {
    const sof = readSof(readFileSync(path.join(PLATES_DIR, name)));
    const geometry = `${sof?.width}x${sof?.height}`;
    expect(['1280x720', '2560x1440', '405x720', '810x1440']).toContain(geometry);
  });
});

describe('the sheet and the directory agree', () => {
  const sheet = readFileSync(CSS, 'utf8');
  const declared = [...sheet.matchAll(/url\("\/plates\/([^"]+)"\)/g)].map((m) => m[1]);

  it('declares plates in the sheet at all', () => {
    expect(declared.length).toBeGreaterThan(0);
  });

  /* A declaration pointing at a missing file is the defect that stood for as
     long as the CSS named eight .png paths that resolved to nothing. It fails
     silently by design -- a background layer whose URL 404s is simply not
     painted -- so only a test catches it. */
  it.each([...new Set(declared)])('%s is declared by the sheet and exists on disk', (name) => {
    expect(files).toContain(name);
  });
});
