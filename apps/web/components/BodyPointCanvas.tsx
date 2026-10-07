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
 * NO GEOMETRY HERE. The element is measured (its box, and the video's own
 * width and height once metadata has loaded) and src/lib/bodyPointMapping.ts
 * does the arithmetic, so the re-draw property is tested as arithmetic, where
 * jsdom can reach it. The overlay is sized to the PICTURE, not the element,
 * so a tap on a letterbox bar lands outside it and is reported as such.
 *
 * NOTHING IS PLACED BY THIS COMPONENT. It reports a tap; the page decides
 * what point it is for and sends it to the server. There is no machine
 * proposal anywhere in this layer (OD-2026-10-02-011 section 2).
 *
 * The browser's own pinch-zoom stays available (touch-action: manipulation):
 * zooming the page is how a coach gets precision on a small screen, and a
 * tap on the zoomed picture maps the same way, because clientX/Y and the
 * overlay's own box both move with the zoom.
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
  videoWidth: number;
  videoHeight: number;
}

export interface BodyPointCanvasProps {
  /** The <video> the points are drawn over. The overlay's parent must be
   * positioned (relative) and wrap exactly that element. */
  videoRef: RefObject<HTMLVideoElement | null>;
  points: readonly CanvasPoint[];
  /** Skeleton lines, by point code; drawn only when both ends are placed. */
  edges: readonly (readonly [string, string])[];
  /** The point the next tap places, named so the canvas can show it. */
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
    videoWidth: video.videoWidth,
    videoHeight: video.videoHeight,
  };
}

/** "left glove" -> "L glove": short enough to sit beside a dot. */
export function shortPointLabel(pointCode: string): string {
  if (pointCode.startsWith('left_')) return `L ${pointCode.slice(5).replace(/_/g, ' ')}`;
  if (pointCode.startsWith('right_')) return `R ${pointCode.slice(6).replace(/_/g, ' ')}`;
  return pointCode.replace(/_/g, ' ');
}

/** Left, right and midline points in three inks, so a swapped side shows. */
function inkFor(pointCode: string): string {
  if (pointCode.startsWith('left_')) return 'var(--monitor)';
  if (pointCode.startsWith('right_')) return 'var(--cleared)';
  return 'var(--brass-300)';
}

const DOT_RADIUS = 7;
const ACTIVE_RING = 13;

export default function BodyPointCanvas({
  videoRef,
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
    if (!video) {
      setPicture(null);
      return;
    }
    const m = measure(video);
    setPicture(m ? pictureRectWithin(m.elementWidth, m.elementHeight, m.videoWidth, m.videoHeight) : null);
  }, [measure, videoRef]);

  /* Measured when the video gains metadata (videoWidth is 0 before that), on
     every resize, and once on mount. ResizeObserver is used where the browser
     has it; the window resize event is the fallback and also catches a
     rotation on a phone or tablet. */
  useEffect(() => {
    remeasure();
    const video = videoRef.current;
    if (!video) return undefined;
    video.addEventListener('loadedmetadata', remeasure);
    window.addEventListener('resize', remeasure);
    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(remeasure);
      observer.observe(video);
    }
    return () => {
      video.removeEventListener('loadedmetadata', remeasure);
      window.removeEventListener('resize', remeasure);
      observer?.disconnect();
    };
  }, [remeasure, videoRef]);

  /* A click, not a pointerup: a finger tap, a mouse click and a stylus all
     arrive as one click with a position, while a pointerup also fires at the
     end of a scroll or a pinch, which must not place a point. */
  const handleClick = useCallback((event: MouseEvent<SVGSVGElement>) => {
    if (disabled || !picture) return;
    // The overlay IS the picture (sized and placed to it), so a tap's offset
    // inside the overlay is an offset inside the picture.
    const box = event.currentTarget.getBoundingClientRect();
    const local = { x: event.clientX - box.left, y: event.clientY - box.top };
    const normalized = normalizedFromElementPoint(local, {
      left: 0,
      top: 0,
      width: picture.width,
      height: picture.height,
    });
    if (!normalized) {
      onTapOutsidePicture?.();
      return;
    }
    onPlace(normalized);
  }, [disabled, onPlace, onTapOutsidePicture, picture]);

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
      aria-label={
        activePointCode && !disabled
          ? `Tap the picture to place ${shortPointLabel(activePointCode)}`
          : 'Marked body points'
      }
      viewBox={`0 0 ${picture.width} ${picture.height}`}
      width={picture.width}
      height={picture.height}
      style={{
        position: 'absolute',
        left: picture.left,
        top: picture.top,
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
      {[...placed.entries()].map(([code, at]) => (
        <g key={code} data-testid="body-point-mark" data-point-code={code}>
          {code === activePointCode ? (
            <circle cx={at.x} cy={at.y} r={ACTIVE_RING} fill="none" stroke={inkFor(code)} strokeWidth={2} />
          ) : null}
          <circle cx={at.x} cy={at.y} r={DOT_RADIUS} fill={inkFor(code)} stroke="var(--hide-950)" strokeWidth={1.5} />
          <text
            x={at.x + DOT_RADIUS + 3}
            y={at.y - DOT_RADIUS}
            fill={inkFor(code)}
            stroke="var(--hide-950)"
            strokeWidth={3}
            paintOrder="stroke"
            fontSize={14}
            fontFamily="var(--font-mono)"
          >
            {shortPointLabel(code)}
          </text>
        </g>
      ))}
    </svg>
  );
}
