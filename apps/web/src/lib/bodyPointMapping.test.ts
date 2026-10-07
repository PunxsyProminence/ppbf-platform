// The re-draw property, as arithmetic.
//
// What this suite pins: a point stored as a fraction of the picture draws at
// the same place ON THE FOOTAGE at every display size and shape; a tap in a
// letterbox or pillarbox bar maps to nothing, never to the picture's edge;
// and nothing is mapped before the element and the video both have a size.

import {
  elementPointFromNormalized,
  isNormalizedCoordinate,
  normalizedFromElementPoint,
  pictureRectWithin,
} from './bodyPointMapping';

/* A 16:9 camera picture shown in boxes of several shapes: a wide PC window
   (pillarbox-free, bars above and below), a portrait phone (bars above and
   below, much taller), a tablet in landscape that is taller than 16:9, and a
   box narrower than the picture's shape (bars left and right). */
const VIDEO = { width: 1920, height: 1080 };
const DISPLAYS = [
  { name: 'PC, 960x540 (exact fit)', width: 960, height: 540 },
  { name: 'phone portrait, 390x844', width: 390, height: 844 },
  { name: 'tablet landscape, 1180x820', width: 1180, height: 820 },
  { name: 'narrow panel, 300x600', width: 300, height: 600 },
];

function rectFor(display: { width: number; height: number }) {
  const rect = pictureRectWithin(display.width, display.height, VIDEO.width, VIDEO.height);
  if (!rect) throw new Error('expected a picture rect');
  return rect;
}

describe('pictureRectWithin', () => {
  test('an exact-shape box holds the whole picture with no bars', () => {
    expect(rectFor(DISPLAYS[0])).toEqual({ left: 0, top: 0, width: 960, height: 540 });
  });

  test('a portrait box letterboxes: full width, bars above and below', () => {
    const rect = rectFor(DISPLAYS[1]);
    expect(rect.left).toBe(0);
    expect(rect.width).toBe(390);
    expect(rect.height).toBeCloseTo(390 * 9 / 16, 6);
    expect(rect.top).toBeCloseTo((844 - rect.height) / 2, 6);
  });

  test('a box narrower in shape than the picture pillarboxes: full height, bars either side', () => {
    const rect = pictureRectWithin(1000, 300, VIDEO.width, VIDEO.height);
    expect(rect).not.toBeNull();
    expect(rect!.top).toBe(0);
    expect(rect!.height).toBe(300);
    expect(rect!.width).toBeCloseTo(300 * 16 / 9, 6);
    expect(rect!.left).toBeCloseTo((1000 - rect!.width) / 2, 6);
  });

  test('no picture before layout or before metadata: null, never a guess', () => {
    expect(pictureRectWithin(0, 0, 1920, 1080)).toBeNull();
    expect(pictureRectWithin(960, 540, 0, 0)).toBeNull();
    expect(pictureRectWithin(960, 0, 1920, 1080)).toBeNull();
    expect(pictureRectWithin(Number.NaN, 540, 1920, 1080)).toBeNull();
  });
});

describe('the re-draw property', () => {
  const STORED = [
    { x_norm: 0, y_norm: 0 },
    { x_norm: 1, y_norm: 1 },
    { x_norm: 0.5, y_norm: 0.5 },
    { x_norm: 0.3125, y_norm: 0.8 },
    { x_norm: 0.999, y_norm: 0.001 },
  ];

  test.each(DISPLAYS)('a stored point round-trips through the element at $name', (display) => {
    const rect = rectFor(display);
    for (const stored of STORED) {
      const onScreen = elementPointFromNormalized(stored, rect);
      const back = normalizedFromElementPoint(onScreen, rect);
      expect(back).not.toBeNull();
      expect(back!.x_norm).toBeCloseTo(stored.x_norm, 9);
      expect(back!.y_norm).toBeCloseTo(stored.y_norm, 9);
    }
  });

  test('a point tapped on one display draws at the same place on the footage on every other', () => {
    // Tap the glove at a spot on the PC, store it, then draw it on each other
    // display and read back the picture fraction there: it must be the same
    // fraction, which is the only thing "the same place on the footage" can
    // mean once the pixels differ.
    const pcRect = rectFor(DISPLAYS[0]);
    const tapOnPc = { x: 700, y: 400 };
    const stored = normalizedFromElementPoint(tapOnPc, pcRect);
    expect(stored).toEqual({ x_norm: 700 / 960, y_norm: 400 / 540 });

    for (const display of DISPLAYS.slice(1)) {
      const rect = rectFor(display);
      const drawn = elementPointFromNormalized(stored!, rect);
      // Inside the picture, not in a bar.
      expect(drawn.x).toBeGreaterThanOrEqual(rect.left);
      expect(drawn.x).toBeLessThanOrEqual(rect.left + rect.width);
      expect(drawn.y).toBeGreaterThanOrEqual(rect.top);
      expect(drawn.y).toBeLessThanOrEqual(rect.top + rect.height);
      // And the same fraction of the picture.
      const readBack = normalizedFromElementPoint(drawn, rect);
      expect(readBack!.x_norm).toBeCloseTo(stored!.x_norm, 9);
      expect(readBack!.y_norm).toBeCloseTo(stored!.y_norm, 9);
    }
  });

  test('the same stored point lands in the picture at the same proportion after a resize', () => {
    const before = rectFor({ width: 640, height: 480 });
    const after = rectFor({ width: 1280, height: 720 });
    const stored = { x_norm: 0.25, y_norm: 0.75 };
    const a = elementPointFromNormalized(stored, before);
    const b = elementPointFromNormalized(stored, after);
    expect((a.x - before.left) / before.width).toBeCloseTo((b.x - after.left) / after.width, 9);
    expect((a.y - before.top) / before.height).toBeCloseTo((b.y - after.top) / after.height, 9);
  });
});

describe('taps in the bars', () => {
  test('a tap in the letterbox bar maps to nothing, not to the picture edge', () => {
    const rect = rectFor(DISPLAYS[1]); // portrait phone, bars above and below
    expect(normalizedFromElementPoint({ x: 100, y: 10 }, rect)).toBeNull();
    expect(normalizedFromElementPoint({ x: 100, y: 840 }, rect)).toBeNull();
    // Just inside the top edge of the picture is a real point.
    const inside = normalizedFromElementPoint({ x: 100, y: rect.top + 0.5 }, rect);
    expect(inside).not.toBeNull();
    expect(inside!.y_norm).toBeGreaterThan(0);
    expect(inside!.y_norm).toBeLessThan(0.01);
  });

  test('a tap in the pillarbox bar maps to nothing', () => {
    const rect = pictureRectWithin(1000, 300, VIDEO.width, VIDEO.height)!;
    expect(normalizedFromElementPoint({ x: 5, y: 150 }, rect)).toBeNull();
    expect(normalizedFromElementPoint({ x: 995, y: 150 }, rect)).toBeNull();
  });

  test('a tap with no finite position maps to nothing, never to NaN', () => {
    const rect = rectFor(DISPLAYS[0]);
    expect(normalizedFromElementPoint({ x: Number.NaN, y: 10 }, rect)).toBeNull();
    expect(normalizedFromElementPoint({ x: 10, y: Number.POSITIVE_INFINITY }, rect)).toBeNull();
  });

  test('the picture edges themselves are in range (0 and 1 are real positions)', () => {
    const rect = rectFor(DISPLAYS[0]);
    expect(normalizedFromElementPoint({ x: 0, y: 0 }, rect)).toEqual({ x_norm: 0, y_norm: 0 });
    expect(normalizedFromElementPoint({ x: 960, y: 540 }, rect)).toEqual({ x_norm: 1, y_norm: 1 });
  });
});

describe('isNormalizedCoordinate', () => {
  test('accepts numbers in [0, 1] and nothing else', () => {
    expect(isNormalizedCoordinate(0)).toBe(true);
    expect(isNormalizedCoordinate(1)).toBe(true);
    expect(isNormalizedCoordinate(0.5)).toBe(true);
    expect(isNormalizedCoordinate(-0.01)).toBe(false);
    expect(isNormalizedCoordinate(1.01)).toBe(false);
    expect(isNormalizedCoordinate('0.5')).toBe(false);
    expect(isNormalizedCoordinate(Number.NaN)).toBe(false);
    expect(isNormalizedCoordinate(null)).toBe(false);
  });
});
