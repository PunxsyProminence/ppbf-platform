/**
 * @jest-environment jsdom
 */

// One moment's controls. What this suite pins: the points are listed in the
// set's marking order with the side spelled out and the placement note where
// one was ratified; each point's state is the server's; "Place" only chooses
// the next tap's point; the lead side and guard are the moment's own; a
// playing video switches the instruction for a "go to the moment" button.

import { fireEvent, render, screen } from '@testing-library/react';

import { BODY_POINTS_0_4 } from '@/src/server/pilot/calibration/ontology';

import BodyPointMomentPanel, { namedPositionOption } from './BodyPointMomentPanel';

const MOMENT = {
  body_moment_id: 'mom-1',
  moment_slot: 'middle',
  moment_kind: 'full_extension',
  observation_ms: 12_600,
  lead_side: 'orthodox',
  guard_type: null,
  points: [
    { point_code: 'nose', state: 'placed', x_norm: 0.5, y_norm: 0.2 },
    { point_code: 'left_glove', state: 'not_visible', x_norm: null, y_norm: null },
  ],
};

function renderPanel(overrides: Partial<React.ComponentProps<typeof BodyPointMomentPanel>> = {}) {
  const handlers = {
    onSelectPoint: jest.fn(),
    onNotVisible: jest.fn(),
    onClearPoint: jest.fn(),
    onUndo: jest.fn(),
    onSetLeadSide: jest.fn(),
    onSetGuard: jest.fn(),
    onGoToMoment: jest.fn(),
    onClose: jest.fn(),
  };
  render(
    <BodyPointMomentPanel
      moment={MOMENT}
      actorTrack="blue corner"
      expectedPoints={BODY_POINTS_0_4}
      activePointCode="chin"
      disabled={false}
      canUndo={false}
      awayFromMoment={false}
      {...handlers}
      {...overrides}
    />,
  );
  return handlers;
}

test('lists every point of the version in marking order, with its state and note', () => {
  renderPanel();
  const rows = screen.getAllByTestId('body-point-row');
  expect(rows.map((row) => row.getAttribute('data-point-code'))).toEqual([...BODY_POINTS_0_4]);
  expect(rows[0].getAttribute('data-state')).toBe('placed'); // nose
  expect(rows[1].getAttribute('data-state')).toBe('not marked'); // chin
  expect(rows[1].textContent).toContain('chin · the tip of the chin');
  expect(rows[7].getAttribute('data-state')).toBe('not visible'); // left glove
  expect(rows[7].textContent).toContain('left glove · the centre of the padded knuckle area');
  expect(screen.getByText('2 of 23 points')).toBeTruthy();
});

test('says which point the next tap places, with its note', () => {
  renderPanel();
  expect(screen.getByTestId('body-point-next').textContent).toBe('Tap the picture to place chin (the tip of the chin).');
});

test('the heading names the actor whose body this is, and the moment', () => {
  renderPanel();
  expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('Marking blue corner, middle moment (full extension at 0:12.600)');
});

test('when every point is marked it says so', () => {
  renderPanel({ activePointCode: null });
  expect(screen.getByTestId('body-point-next').textContent).toContain('Every point on this moment is marked');
});

test('Place chooses a point; Not visible and Clear report the point; the active row says Placing', () => {
  const handlers = renderPanel();
  const row = (code: string) => screen.getByTestId('body-point-list').querySelector(`[data-point-code="${code}"]`) as HTMLElement;

  expect(row('chin').querySelector('button')?.textContent).toBe('Placing');
  fireEvent.click(row('neck').querySelector('button') as HTMLElement);
  expect(handlers.onSelectPoint).toHaveBeenCalledWith('neck');

  fireEvent.click(row('neck').querySelectorAll('button')[1]);
  expect(handlers.onNotVisible).toHaveBeenCalledWith('neck');

  // Clear exists only on a point the server holds.
  expect(row('neck').querySelectorAll('button')).toHaveLength(2);
  fireEvent.click(row('nose').querySelectorAll('button')[2]);
  expect(handlers.onClearPoint).toHaveBeenCalledWith('nose');
});

test('lead side and guard show the moment\'s own values and report a change', () => {
  const handlers = renderPanel();
  expect((screen.getByLabelText('Lead side at this moment') as HTMLSelectElement).value).toBe('orthodox');
  expect((screen.getByLabelText('Guard at this moment') as HTMLSelectElement).value).toBe('');

  fireEvent.change(screen.getByLabelText('Lead side at this moment'), { target: { value: 'neutral' } });
  expect(handlers.onSetLeadSide).toHaveBeenCalledWith('neutral');
  fireEvent.change(screen.getByLabelText('Guard at this moment'), { target: { value: 'aiba__high_guard' } });
  expect(handlers.onSetGuard).toHaveBeenCalledWith('aiba__high_guard');
});

test('while the video is not held on the moment, the instruction gives way to a go-to button', () => {
  const handlers = renderPanel({ awayFromMoment: true });
  expect(screen.queryByTestId('body-point-next')).toBeNull();
  expect(screen.getByRole('status').textContent).toContain('not held on this moment');
  fireEvent.click(screen.getByRole('button', { name: 'Go to the moment' }));
  expect(handlers.onGoToMoment).toHaveBeenCalledTimes(1);
});

test('undo is offered only when there is a placement to take back', () => {
  renderPanel({ canUndo: false });
  expect((screen.getByRole('button', { name: 'Undo last placement' }) as HTMLButtonElement).disabled).toBe(true);
});

test('a guard option reads as the manual\'s heading, its body and its pages', () => {
  expect(namedPositionOption('usa_boxing__high_double_guard')).toBe('High (Double) Guard, USA Boxing, p. 82 (PDF 83)');
  expect(namedPositionOption('other')).toBe('other');
});
