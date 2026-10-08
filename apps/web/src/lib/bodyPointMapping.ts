/**
 * BODY-POINT COORDINATES: between the screen and the video's own picture.
 *
 * A stored point is a fraction of the PICTURE -- x_norm 0.5 is the middle of
 * the frame the camera recorded -- never a fraction of the <video> element.
 * The two differ whenever the element's box has a different shape from the
 * picture: with `object-fit: contain` (the element's default) the picture sits
 * centred with bars above and below (letterbox) or either side (pillarbox),
 * and a tap in a bar is a tap on nothing.
 *
 * WHY A PURE MODULE. The same point must re-draw at the same place on the
 * footage on a phone, a tablet and the PC, in portrait and landscape, and
 * after a window resize. That property cannot be tested in jsdom, which lays
 * nothing out; it can be tested here, as arithmetic, which is also where it
 * is easiest to get wrong. The canvas component does no geometry of its own:
 * it measures the element and the video, and asks this module.
 *
 * Units: element pixels in, element pixels out; normalised fractions in
 * [0, 1] on the picture. No frame numbers (src/lib/clipTime.ts explains why).
 */

export interface PictureRect {
  /** Where the picture's left edge sits inside the element, element px. */
  left: number;
  /** Where the picture's top edge sits inside the element, element px. */
  top: number;
  width: number;
  height: number;
}

export interface NormalizedPoint {
  x_norm: number;
  y_norm: number;
}

export interface ElementPoint {
  x: number;
  y: number;
}

/** A number in [0, 1]. A string "0.5" is not one; the wire is numbers. */
export function isNormalizedCoordinate(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

/**
 * Where the picture sits inside a <video> element of the given size, for
 * `object-fit: contain`: scaled to fit whole, centred, bars on the long sides.
 *
 * Null when either box has no area yet -- the element before layout, the
 * video before `loadedmetadata` (videoWidth and videoHeight are 0 then). A
 * caller that gets null must not map a tap: it has no picture to map onto.
 */
export function pictureRectWithin(
  elementWidth: number,
  elementHeight: number,
  videoWidth: number,
  videoHeight: number,
): PictureRect | null {
  if (!(elementWidth > 0 && elementHeight > 0 && videoWidth > 0 && videoHeight > 0)) {
    return null;
  }
  const scale = Math.min(elementWidth / videoWidth, elementHeight / videoHeight);
  const width = videoWidth * scale;
  const height = videoHeight * scale;
  return {
    left: (elementWidth - width) / 2,
    top: (elementHeight - height) / 2,
    width,
    height,
  };
}

/**
 * A tap at an element position, as a fraction of the picture. Null when the
 * tap landed in a bar outside the picture: that is not "the edge of the
 * picture", it is nothing, and a point placed there would be a fabricated
 * observation. The caller tells the coach rather than clamping.
 */
export function normalizedFromElementPoint(
  point: ElementPoint,
  picture: PictureRect,
): NormalizedPoint | null {
  if (!(picture.width > 0 && picture.height > 0)) return null;
  // A tap with no finite position (an event the browser could not locate) is
  // not a tap on the picture. NaN would pass every comparison below.
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;
  const x = (point.x - picture.left) / picture.width;
  const y = (point.y - picture.top) / picture.height;
  if (x < 0 || x > 1 || y < 0 || y > 1) return null;
  return { x_norm: x, y_norm: y };
}

/** Where a stored point draws inside the element, at this element's size. */
export function elementPointFromNormalized(
  point: NormalizedPoint,
  picture: PictureRect,
): ElementPoint {
  return {
    x: picture.left + point.x_norm * picture.width,
    y: picture.top + point.y_norm * picture.height,
  };
}
