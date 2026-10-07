/**
 * @jest-environment jsdom
 */

// The body-point progress view says what the SERVER says, event by event.
// What this suite pins: the section is absent for a set with no body-point
// version; the missing list is the server's text with only the leading event
// id made readable; an event the server names but the page does not hold is
// shown with its id rather than dropped.

import { render, screen } from '@testing-library/react';

import { BODY_POINTS_0_4 } from '@/src/server/pilot/calibration/ontology';

import BodyPointProgress, { readableMissingItem } from './BodyPointProgress';

const PUNCH = {
  event_id: 'evt-1',
  event_class: 'punch',
  actor_track: 'red corner',
  start_ms: 12_400,
  end_ms: 12_800,
  contact_ms: 12_600,
};

const DEFENSE = {
  event_id: 'evt-2',
  event_class: 'defense',
  actor_track: 'blue corner',
  start_ms: 13_000,
  end_ms: 13_300,
  contact_ms: null,
};

const MOMENT = {
  body_moment_id: 'mom-1',
  event_id: 'evt-1',
  moment_slot: 'middle',
  moment_kind: 'contact',
  observation_ms: 12_600,
  lead_side: null,
  guard_type: 'usa_boxing__half_guard',
  points: BODY_POINTS_0_4.map((point_code) => ({ point_code, state: 'placed' })),
};

test('renders nothing for a set whose version holds no body points', () => {
  const { container } = render(
    <BodyPointProgress events={[PUNCH]} expectedPoints={null} moments={[]} stanceLabels={[]} missing={[]} />,
  );
  expect(container.innerHTML).toBe('');
});

test('shows each event with its three moments and its stance type, from the server\'s rows', () => {
  render(
    <BodyPointProgress
      events={[PUNCH, DEFENSE]}
      expectedPoints={BODY_POINTS_0_4}
      moments={[MOMENT]}
      stanceLabels={[{ event_id: 'evt-2', stance_type: 'aiba__classic' }]}
      missing={['evt-1: start moment']}
    />,
  );

  expect(screen.getAllByTestId('body-point-event')).toHaveLength(2);
  expect(screen.getByTestId('body-point-totals').textContent).toBe(
    'Points 23 of 138 · moments opened 1 of 6 · stance types 1 of 2',
  );
  const [punch, defense] = screen.getAllByTestId('body-point-event');
  expect(punch.textContent).toContain('middle (contact at 0:12.600) · 23 of 23 points · lead side not set · guard usa boxing  half guard');
  expect(punch.textContent).toContain('start · not opened');
  expect(punch.textContent).toContain('stance type · not set');
  expect(defense.textContent).toContain('stance type · aiba  classic');
  expect(screen.getByText('1 still to mark')).toBeTruthy();
});

test('an empty missing list reads as complete', () => {
  render(
    <BodyPointProgress events={[PUNCH]} expectedPoints={BODY_POINTS_0_4} moments={[]} stanceLabels={[]} missing={[]} />,
  );
  expect(screen.getByText('Complete')).toBeTruthy();
  expect(screen.queryByTestId('body-point-missing')).toBeNull();
});

describe('readableMissingItem', () => {
  test('swaps the event id for the event\'s place in the clip and keeps the server\'s words', () => {
    expect(readableMissingItem('evt-1: start points, 2 of 23', [PUNCH])).toBe('punch at 0:12.400: start points, 2 of 23');
    expect(readableMissingItem('evt-2: middle lead side', [PUNCH, DEFENSE])).toBe('defense at 0:13.000: middle lead side');
  });

  test('an event the page does not hold is shown as the server sent it, never dropped', () => {
    expect(readableMissingItem('evt-9: stance type', [PUNCH])).toBe('evt-9: stance type');
    expect(readableMissingItem('no colon here', [PUNCH])).toBe('no colon here');
  });
});
