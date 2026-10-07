/**
 * @jest-environment jsdom
 */

// The tap layer. What this suite pins: a tap becomes a fraction of the
// PICTURE (letterbox-aware), a tap in a bar places nothing, a disabled canvas
// places nothing, stored points draw at the picture-relative place at two
// different sizes, and a skeleton line appears only between two points the
// coach placed. jsdom lays nothing out, so the element and video sizes come
// through the `measure` seam and the overlay's own box is the origin.

import { act, fireEvent, render, screen } from '@testing-library/react';
import { createRef } from 'react';

import { BODY_POINT_EDGES_0_4 } from '@/src/server/pilot/calibration/ontology';

import BodyPointCanvas, { shortPointLabel, type CanvasPoint, type VideoMeasure } from './BodyPointCanvas';

/* A 16:9 video in a portrait 400x800 box: the picture is 400x225, with a
   287.5px bar above and below. */
const PORTRAIT: VideoMeasure = { elementWidth: 400, elementHeight: 800, videoWidth: 1920, videoHeight: 1080 };
/* The same video in a 1600x900 box: the picture fills it. */
const WIDE: VideoMeasure = { elementWidth: 1600, elementHeight: 900, videoWidth: 1920, videoHeight: 1080 };

function renderCanvas(overrides: Partial<React.ComponentProps<typeof BodyPointCanvas>> = {}, measure: VideoMeasure = PORTRAIT) {
  const videoRef = createRef<HTMLVideoElement>();
  const onPlace = jest.fn();
  const onTapOutsidePicture = jest.fn();
  const utils = render(
    <div style={{ position: 'relative' }}>
      <video ref={videoRef} />
      <BodyPointCanvas
        videoRef={videoRef}
        points={[]}
        edges={[]}
        activePointCode="left_glove"
        onPlace={onPlace}
        onTapOutsidePicture={onTapOutsidePicture}
        measure={() => measure}
        {...overrides}
      />
    </div>,
  );
  return { ...utils, onPlace, onTapOutsidePicture };
}

/* jsdom's getBoundingClientRect is all zeros, so a client coordinate IS the
   offset inside the overlay. The overlay is the picture, so (x, y) here is a
   position inside the 400x225 picture. */
function tap(x: number, y: number) {
  fireEvent.click(screen.getByTestId('body-point-canvas'), { clientX: x, clientY: y });
}

test('the overlay is sized and placed to the picture, not the element', () => {
  renderCanvas();
  const svg = screen.getByTestId('body-point-canvas');
  expect(svg.getAttribute('width')).toBe('400');
  expect(svg.getAttribute('height')).toBe('225');
  expect(svg.style.top).toBe('287.5px');
  expect(svg.style.left).toBe('0px');
});

test('a tap becomes a fraction of the picture', () => {
  const { onPlace } = renderCanvas();
  act(() => tap(100, 45));
  expect(onPlace).toHaveBeenCalledTimes(1);
  expect(onPlace.mock.calls[0][0].x_norm).toBeCloseTo(0.25, 9);
  expect(onPlace.mock.calls[0][0].y_norm).toBeCloseTo(0.2, 9);
});

test('a tap past the picture edge places nothing and says so', () => {
  const { onPlace, onTapOutsidePicture } = renderCanvas();
  act(() => tap(100, 300));
  expect(onPlace).not.toHaveBeenCalled();
  expect(onTapOutsidePicture).toHaveBeenCalledTimes(1);
});

test('a disabled canvas places nothing', () => {
  const { onPlace } = renderCanvas({ disabled: true });
  act(() => tap(100, 45));
  expect(onPlace).not.toHaveBeenCalled();
});

test('nothing renders before the video has a size', () => {
  renderCanvas({}, { ...PORTRAIT, videoWidth: 0, videoHeight: 0 });
  expect(screen.queryByTestId('body-point-canvas')).toBeNull();
});

test('a stored point draws at the same place on the picture at two display sizes', () => {
  const points: CanvasPoint[] = [{ point_code: 'nose', state: 'placed', x_norm: 0.25, y_norm: 0.6 }];

  renderCanvas({ points }, PORTRAIT);
  const narrowDot = screen.getByTestId('body-point-mark').querySelector('circle[r="7"]')!;
  expect(Number(narrowDot.getAttribute('cx')) / 400).toBeCloseTo(0.25, 9);
  expect(Number(narrowDot.getAttribute('cy')) / 225).toBeCloseTo(0.6, 9);

  screen.getByTestId('body-point-canvas').remove();
  renderCanvas({ points }, WIDE);
  const wideDot = screen.getByTestId('body-point-mark').querySelector('circle[r="7"]')!;
  expect(Number(wideDot.getAttribute('cx')) / 1600).toBeCloseTo(0.25, 9);
  expect(Number(wideDot.getAttribute('cy')) / 900).toBeCloseTo(0.6, 9);
});

test('a not-visible point and a point with no coordinates draw nothing', () => {
  renderCanvas({
    points: [
      { point_code: 'chin', state: 'not_visible', x_norm: null, y_norm: null },
      { point_code: 'neck', state: 'placed', x_norm: null, y_norm: null },
    ],
  });
  expect(screen.queryAllByTestId('body-point-mark')).toHaveLength(0);
});

test('a skeleton line is drawn only between two points the coach placed', () => {
  const points: CanvasPoint[] = [
    { point_code: 'left_shoulder', state: 'placed', x_norm: 0.3, y_norm: 0.3 },
    { point_code: 'left_elbow', state: 'placed', x_norm: 0.35, y_norm: 0.5 },
    { point_code: 'left_wrist', state: 'not_visible', x_norm: null, y_norm: null },
  ];
  renderCanvas({ points, edges: BODY_POINT_EDGES_0_4 });
  const lines = screen.getAllByTestId('body-point-edge');
  // shoulder-elbow only: elbow-wrist has an unplaced end, every other edge
  // has both ends unplaced.
  expect(lines).toHaveLength(1);
  expect(Number(lines[0].getAttribute('x1')) / 400).toBeCloseTo(0.3, 9);
  expect(Number(lines[0].getAttribute('x2')) / 400).toBeCloseTo(0.35, 9);
});

test('the active point is named for the coach, and a read-only canvas is not an invitation to tap', () => {
  renderCanvas({ activePointCode: 'right_big_toe' });
  expect(screen.getByRole('img').getAttribute('aria-label')).toBe('Tap the picture to place R big toe');

  screen.getByTestId('body-point-canvas').remove();
  renderCanvas({ activePointCode: 'right_big_toe', disabled: true });
  expect(screen.getByRole('img').getAttribute('aria-label')).toBe('Marked body points');
});

test('shortPointLabel spells the side out as L / R and leaves midline points alone', () => {
  expect(shortPointLabel('left_glove')).toBe('L glove');
  expect(shortPointLabel('right_small_toe')).toBe('R small toe');
  expect(shortPointLabel('solar_plexus')).toBe('solar plexus');
});
