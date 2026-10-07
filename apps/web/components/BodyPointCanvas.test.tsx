/**
 * @jest-environment jsdom
 */

// The tap layer. What this suite pins: a tap becomes a fraction of the
// PICTURE (letterbox-aware, and against the overlay's own on-screen box), a
// tap in a bar places nothing, a disabled canvas or one with no point waiting
// places nothing, the second click of a double-click places nothing, stored
// points draw at the picture-relative place at two different sizes, the
// overlay follows the video's offset inside its parent, a size change
// remeasures, and a skeleton line appears only between two points the coach
// placed. jsdom lays nothing out, so sizes come through the `measure` seam.

import { act, fireEvent, render, screen } from '@testing-library/react';
import { createRef } from 'react';

import { BODY_POINT_EDGES_0_4 } from '@/src/server/pilot/calibration/ontology';

import BodyPointCanvas, { shortPointLabel, type CanvasPoint, type VideoMeasure } from './BodyPointCanvas';

/* A 16:9 video in a portrait 400x800 box: the picture is 400x225, with a
   287.5px bar above and below. */
const PORTRAIT: VideoMeasure = { elementWidth: 400, elementHeight: 800, offsetLeft: 0, offsetTop: 0, videoWidth: 1920, videoHeight: 1080 };
/* The same video in a 1600x900 box: the picture fills it. */
const WIDE: VideoMeasure = { elementWidth: 1600, elementHeight: 900, offsetLeft: 0, offsetTop: 0, videoWidth: 1920, videoHeight: 1080 };
/* A 1000x300 box: pillarboxed, picture 533.33 wide, bars 233.33 either side. */
const PILLAR: VideoMeasure = { elementWidth: 1000, elementHeight: 300, offsetLeft: 0, offsetTop: 0, videoWidth: 1920, videoHeight: 1080 };

function renderCanvas(
  overrides: Partial<React.ComponentProps<typeof BodyPointCanvas>> = {},
  measure: VideoMeasure | (() => VideoMeasure) = PORTRAIT,
) {
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
        measure={typeof measure === 'function' ? measure : () => measure}
        {...overrides}
      />
    </div>,
  );
  return { ...utils, videoRef, onPlace, onTapOutsidePicture };
}

/* jsdom's getBoundingClientRect is all zeros unless stubbed, so a client
   coordinate IS the offset inside the overlay, and the overlay is the
   picture: (x, y) here is a position inside the 400x225 picture. */
function tap(x: number, y: number, detail = 1) {
  fireEvent.click(screen.getByTestId('body-point-canvas'), { clientX: x, clientY: y, detail });
}

test('the overlay is sized and placed to the picture, not the element', () => {
  renderCanvas();
  const svg = screen.getByTestId('body-point-canvas');
  expect(svg.getAttribute('width')).toBe('400');
  expect(svg.getAttribute('height')).toBe('225');
  expect(svg.style.top).toBe('287.5px');
  expect(svg.style.left).toBe('0px');
});

test('a pillarboxed picture puts the overlay inside the side bars', () => {
  renderCanvas({}, PILLAR);
  const svg = screen.getByTestId('body-point-canvas');
  expect(Number.parseFloat(svg.style.left)).toBeCloseTo((1000 - 300 * 16 / 9) / 2, 3);
  expect(svg.style.top).toBe('0px');
  expect(Number.parseFloat(svg.getAttribute('width') ?? '')).toBeCloseTo(300 * 16 / 9, 3);
});

test('the overlay follows the video\'s own offset inside the positioned parent', () => {
  // A margin above the video, or a heading before it, moves the video down
  // inside the parent; the overlay must move with it or every point is
  // stored too low.
  renderCanvas({}, { ...PORTRAIT, offsetLeft: 12, offsetTop: 40 });
  const svg = screen.getByTestId('body-point-canvas');
  expect(svg.style.left).toBe('12px');
  expect(svg.style.top).toBe('327.5px');
});

test('a tap becomes a fraction of the picture', () => {
  const { onPlace } = renderCanvas();
  act(() => tap(100, 45));
  expect(onPlace).toHaveBeenCalledTimes(1);
  expect(onPlace.mock.calls[0][0].x_norm).toBeCloseTo(0.25, 9);
  expect(onPlace.mock.calls[0][0].y_norm).toBeCloseTo(0.2, 9);
});

test('a tap is mapped against the overlay\'s on-screen box, so a moved or scaled overlay still maps right', () => {
  const { onPlace } = renderCanvas();
  const svg = screen.getByTestId('body-point-canvas');
  // The overlay is on screen at (300, 500), drawn twice its size (a zoom or
  // an ancestor transform): a tap at its exact centre is (0.5, 0.5).
  svg.getBoundingClientRect = () => ({
    left: 300, top: 500, width: 800, height: 450, right: 1100, bottom: 950, x: 300, y: 500, toJSON: () => ({}),
  });
  act(() => tap(700, 725));
  expect(onPlace.mock.calls[0][0].x_norm).toBeCloseTo(0.5, 9);
  expect(onPlace.mock.calls[0][0].y_norm).toBeCloseTo(0.5, 9);
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

test('with no point waiting to be placed, a tap places nothing', () => {
  const { onPlace, onTapOutsidePicture } = renderCanvas({ activePointCode: null });
  act(() => tap(100, 45));
  expect(onPlace).not.toHaveBeenCalled();
  expect(onTapOutsidePicture).not.toHaveBeenCalled();
});

test('the second click of a double-click places nothing', () => {
  const { onPlace } = renderCanvas();
  act(() => tap(100, 45, 1));
  act(() => tap(100, 45, 2));
  expect(onPlace).toHaveBeenCalledTimes(1);
});

test('nothing renders before the video has a size, and it appears once metadata loads', () => {
  let current: VideoMeasure = { ...PORTRAIT, videoWidth: 0, videoHeight: 0 };
  const { videoRef } = renderCanvas({}, () => current);
  expect(screen.queryByTestId('body-point-canvas')).toBeNull();

  current = PORTRAIT;
  act(() => {
    fireEvent(videoRef.current!, new Event('loadedmetadata'));
  });
  expect(screen.getByTestId('body-point-canvas')).toBeTruthy();
});

test('a window resize remeasures, so a rotation moves the overlay', () => {
  let current: VideoMeasure = PORTRAIT;
  renderCanvas({}, () => current);
  expect(screen.getByTestId('body-point-canvas').style.top).toBe('287.5px');

  current = WIDE;
  act(() => {
    fireEvent(window, new Event('resize'));
  });
  expect(screen.getByTestId('body-point-canvas').style.top).toBe('0px');
  expect(screen.getByTestId('body-point-canvas').getAttribute('width')).toBe('1600');
});

test('a stored point draws at the same place on the picture at two display sizes', () => {
  const points: CanvasPoint[] = [{ point_code: 'left_knee', state: 'placed', x_norm: 0.25, y_norm: 0.6 }];

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

test('a not-visible point, a point with no coordinates and a point out of range draw nothing', () => {
  renderCanvas({
    points: [
      { point_code: 'chin', state: 'not_visible', x_norm: null, y_norm: null },
      { point_code: 'neck', state: 'placed', x_norm: null, y_norm: null },
      { point_code: 'nose', state: 'placed', x_norm: 1.5, y_norm: 0.2 },
    ],
  });
  expect(screen.queryAllByTestId('body-point-mark')).toHaveLength(0);
});

test('left, right and midline points are told apart by side, with the side spelled out', () => {
  renderCanvas({
    points: [
      { point_code: 'left_glove', state: 'placed', x_norm: 0.2, y_norm: 0.2 },
      { point_code: 'right_glove', state: 'placed', x_norm: 0.8, y_norm: 0.2 },
      { point_code: 'nose', state: 'placed', x_norm: 0.5, y_norm: 0.1 },
    ],
  });
  const marks = screen.getAllByTestId('body-point-mark');
  expect(marks.map((m) => m.getAttribute('data-side'))).toEqual(['left', 'right', 'midline']);
  expect(marks[0].textContent).toBe('L glove');
  expect(marks[1].textContent).toBe('R glove');
  expect(marks[2].querySelector('rect')).not.toBeNull();
  // No status ink on the footage: a dot must not read as a clearance mark.
  const svg = screen.getByTestId('body-point-canvas').outerHTML;
  expect(svg).not.toMatch(/--cleared|--monitor|--restricted|--locked/);
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

test('the overlay names what it shows, and does not invite a tap', () => {
  renderCanvas({ points: [{ point_code: 'nose', state: 'placed', x_norm: 0.5, y_norm: 0.1 }] });
  expect(screen.getByRole('img').getAttribute('aria-label')).toBe('Marked body points: 1 placed on the picture');
});

test('shortPointLabel spells the side out as L / R and leaves midline points alone', () => {
  expect(shortPointLabel('left_glove')).toBe('L glove');
  expect(shortPointLabel('right_small_toe')).toBe('R small toe');
  expect(shortPointLabel('solar_plexus')).toBe('solar plexus');
});
