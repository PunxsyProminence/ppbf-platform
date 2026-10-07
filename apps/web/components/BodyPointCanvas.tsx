'use client';

import { useCallback, useEffect, useState, type MouseEvent, type RefObject } from 'react';

import {
  elementPointFromNormalized,
  isNormalizedCoordinate,
  normalizedFromElementPoint,
  pictureRectWithin,
  type PictureRect,
} from '@/src/lib/bodyPointMapping';

/**
 * THE TAP LAYER over the paused footage: where the coach places body points.
 *
 * It draws the points already marked on this moment, the skeleton lines
 * between the coach's OWN placed points (a drawing aid, so a left/right swap
 * is visible; nothing is inferred, and a line is drawn only when both of its
 * ends were placed by the coach), and turns a tap into a fraction of the
 * video's own picture, which is what the server stores.
 *
 * NO GEOMETRY HERE. The element is measured (its box, where it sits in its
 * positioned parent, and the video's own width and height once metadata has
 * loaded) and src/lib/bodyPointMapping.ts does the arithmetic, so the
 * re-draw property is tested as arithmetic, where jsdom can reach it. The
 * overlay is sized to the PICTURE, not the element, so a tap on a letterbox
 * bar lands outside it and is reported as such.
 *
 * NOTHING IS PLACED BY THIS COMPONENT. It reports a tap; the page decides
 * what point it is for and sends it to the server. There is no machine
 * proposal anywhere in this layer (OD-2026-10-02-011 section 2).
 *
 * The browser's own pinch-zoom stays available (touch-action: manipulation):
 * zooming the page is how a coach gets precision on a small screen. A tap is
 * mapped against the overlay's own on-screen box, so a zoom, or an ancestor
 * transform, cannot shift it.
 *
 * Keyboard placement is not built: a coach places points by tapping the
 * picture. The point list beside the video is keyboard-reachable for "not
 * visible" and "clear".
 */

export interface CanvasPoint {
  point_code: string;
  state: string;
  x_norm: number | null;
  y_norm: number | null;
}

export interface VideoMeasure {
  elementWidth: number;
  elementHeight: number;
  /** Where the element's box starts inside its positioned parent (the
   * overlay's own offset parent), so the overlay follows a margin or a
   * sibling above the video. */
  offsetLeft: number;
  offsetTop: number;
  videoWidth: number;
  videoHeight: number;
}

export interface BodyPointCanvasProps {
  /** The <video> the points are drawn over. The overlay must share its
   * positioned parent. */
  videoRef: RefObject<HTMLVideoElement | null>;
  /** Changes whenever the <video> element is replaced (the page re-creates it
   * when the stream link changes), so the listeners move to the new one. A
   * ref's `.current` changing re-runs nothing on its own. */
  bindKey?: string;
  points: readonly CanvasPoint[];
  /** Skeleton lines, by point code; drawn only when both ends are placed. */
  edges: readonly (readonly [string, string])[];
  /** The point the next tap places; null means taps place nothing. */
  activePointCode: string | null;
  /** True when a tap must do nothing (read-only set, a save in flight). */
  disabled?: boolean;
  onPlace: (point: { x_norm: number; y_norm: number }) => void;
  /** A tap in a bar outside the picture: nothing to place there. */
  onTapOutsidePicture?: () => void;
  /** Test seam: how the element and the video are measured. The default reads
   * the live element; jsdom lays nothing out and reports zeros. */
  measure?: (video: HTMLVideoElement) => VideoMeasure | null;
}

function measureLive(video: HTMLVideoElement): VideoMeasure | null {
  return {
    elementWidth: video.clientWidth,
    elementHeight: video.clientHeight,
    offsetLeft: video.offsetLeft,
    offsetTop: video.offsetTop,
    videoWidth: video.videoWidth,
    videoHeight: video.videoHeight,
  };
}

function sameRect(a: PictureRect | null, b: PictureRect | null): boolean {
  if (a === null || b === null) return a === b;
  return a.left === b.left && a.top === b.top && a.width === b.width && a.height === b.height;
}

/** "left glove" -> "L glove": short enough to sit beside a dot. */
export function shortPointLabel(pointCode: string): string {
  if (pointCode.startsWith('left_')) return `L ${pointCode.slice(5).replace(/_/g, ' ')}`;
  if (pointCode.startsWith('right_')) return `R ${pointCode.slice(6).replace(/_/g, ' ')}`;
  return pointCode.replace(/_/g, ' ');
}

/** Which side a point is on, for its ink and shape. The status inks
 * (--cleared, --monitor, --restricted) are not used: a dot on the footage
 * must not read as a clearance mark. */
function sideOf(pointCode: string): 'left' | 'right' | 'midline' {
  if (pointCode.startsWith('left_')) return 'left';
  if (pointCode.startsWith('right_')) return 'right';
  return 'midline';
}

const INK: Record<ReturnType<typeof sideOf>, string> = {
  left: 'var(--brass-300)',
  right: 'var(--bone-300)',
  midline: 'var(--brass-300)',
};

const DOT_RADIUS = 7;
const ACTIVE_RING = 13;

export default function BodyPointCanvas({
  videoRef,
  bindKey = '',
  points,
  edges,
  activePointCode,
  disabled = false,
  onPlace,
  onTapOutsidePicture,
  measure = measureLive,
}: BodyPointCanvasProps) {
  const [picture, setPicture] = useState<PictureRect | null>(null);

  const remeasure = useCallback(() => {
    const video = videoRef.current;
    const m = video ? measure(video) : null;
    const inElement = m ? pictureRectWithin(m.elementWidth, m.elementHeight, m.videoWidth, m.videoHeight) : null;
    const next = inElement && m
      ? { ...inElement, left: inElement.left + m.offsetLeft, top: inElement.top + m.offsetTop }
      : null;
    setPicture((current) => (sameRect(current, next) ? current : next));
  }, [measure, videoRef]);

  /* Measured once on bind, when the video gains metadata (videoWidth is 0
     before that), when its picture size changes (the media `resize` event: a
     new src on the same element), when it is emptied, on every window resize
     (which also catches a rotation), and through ResizeObserver where the
     browser has it. Re-bound whenever bindKey changes. */
  useEffect(() => {
    remeasure();
    const video = videoRef.current;
    if (!video) return undefined;
    const mediaEvents = ['loadedmetadata', 'resize', 'emptied'] as const;
    for (const name of mediaEvents) video.addEventListener(name, remeasure);
    window.addEventListener('resize', remeasure);
    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(remeasure);
      observer.observe(video);
    }
    return () => {
      for (const name of mediaEvents) video.removeEventListener(name, remeasure);
      window.removeEventListener('resize', remeasure);
      observer?.disconnect();
    };
  }, [bindKey, remeasure, videoRef]);

  /* A click, not a pointerup: a finger tap, a mouse click and a stylus all
     arrive as one click with a position, while a pointerup also fires at the
     end of a scroll or a pinch, which must not place a point. The second
     click of a double-click is ignored: with the double-tap delay removed it
     would place the NEXT point on the same spot. */
  const handleClick = useCallback((event: MouseEvent<SVGSVGElement>) => {
    if (disabled || !picture || !activePointCode) return;
    if (event.detail > 1) return;
    // The overlay IS the picture (sized and placed to it), so a tap's offset
    // inside the overlay's own on-screen box is an offset inside the
    // picture. The on-screen box is used for the division as well, so a
    // zoom or an ancestor transform that scales the box scales the tap with
    // it. jsdom reports a zero box; the picture's own size stands in then.
    const box = event.currentTarget.getBoundingClientRect();
    const width = box.width > 0 ? box.width : picture.width;
    const height = box.height > 0 ? box.height : picture.height;
    const normalized = normalizedFromElementPoint(
      { x: event.clientX - box.left, y: event.clientY - box.top },
      { left: 0, top: 0, width, height },
    );
    if (!normalized) {
      onTapOutsidePicture?.();
      return;
    }
    onPlace(normalized);
  }, [activePointCode, disabled, onPlace, onTapOutsidePicture, picture]);

  if (!picture) return null;

  const placed = new Map<string, { x: number; y: number }>();
  for (const point of points) {
    if (point.state !== 'placed') continue;
    if (!isNormalizedCoordinate(point.x_norm) || !isNormalizedCoordinate(point.y_norm)) continue;
    placed.set(
      point.point_code,
      elementPointFromNormalized(
        { x_norm: point.x_norm, y_norm: point.y_norm },
        { left: 0, top: 0, width: picture.width, height: picture.height },
      ),
    );
  }

  return (
    <svg
      data-testid="body-point-canvas"
      role="img"
      aria-label={`Marked body points: ${placed.size} placed on the picture`}
      viewBox={`0 0 ${picture.width} ${picture.height}`}
      width={picture.width}
      height={picture.height}
      style={{
        position: 'absolute',
        left: picture.left,
        top: picture.top,
        overflow: 'visible',
        touchAction: 'manipulation',
        cursor: disabled || !activePointCode ? 'default' : 'crosshair',
      }}
      onClick={handleClick}
    >
      {edges.map(([from, to]) => {
        const a = placed.get(from);
        const b = placed.get(to);
        if (!a || !b) return null;
        return (
          <line
            key={`${from}-${to}`}
            data-testid="body-point-edge"
            x1={a.x}
            y1={a.y}
            x2={b.x}
            y2={b.y}
            stroke="var(--bone-300)"
            strokeWidth={2}
            strokeOpacity={0.8}
          />
        );
      })}
      {[...placed.entries()].map(([code, at]) => {
        const side = sideOf(code);
        const ink = INK[side];
        return (
          <g key={code} data-testid="body-point-mark" data-point-code={code} data-side={side}>
            {code === activePointCode ? (
              <circle cx={at.x} cy={at.y} r={ACTIVE_RING} fill="none" stroke={ink} strokeWidth={2} />
            ) : null}
            {side === 'midline' ? (
              /* Midline points are diamonds, so the three kinds are told apart
                 by shape as well as ink. */
              <rect
                x={at.x - DOT_RADIUS}
                y={at.y - DOT_RADIUS}
                width={DOT_RADIUS * 2}
                height={DOT_RADIUS * 2}
                transform={`rotate(45 ${at.x} ${at.y})`}
                fill={ink}
                stroke="var(--hide-950)"
                strokeWidth={1.5}
              />
            ) : (
              <circle cx={at.x} cy={at.y} r={DOT_RADIUS} fill={ink} stroke="var(--hide-950)" strokeWidth={1.5} />
            )}
            <text
              x={at.x + DOT_RADIUS + 3}
              y={at.y - DOT_RADIUS}
              fill={ink}
              stroke="var(--hide-950)"
              strokeWidth={3}
              paintOrder="stroke"
              fontSize={14}
              fontFamily="var(--font-mono)"
            >
              {shortPointLabel(code)}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
