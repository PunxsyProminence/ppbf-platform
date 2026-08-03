/**
 * @jest-environment jsdom
 */

// The ceremony, as the card actually renders it. milestoneCeremony.test.ts pins
// the rule; this pins the wiring, and specifically the two ways the wiring can
// betray the rule: a seal that presses on every render because the component
// read a state instead of an event, and a bell that rings for history because
// the ledger had not finished loading on the first render.

import { render } from '@testing-library/react';

import { resetCeremonyMemory } from './milestoneCeremony';
import TrainingCard, { type TrainingSession } from './TrainingCard';

// Recorded at call time, never read while the factory below is evaluated, so
// there is no temporal-dead-zone problem with jest.mock's hoisting.
const played: string[] = [];

jest.mock('./useGymSound', () => ({
  __esModule: true,
  default: () => ({
    enabled: false,
    ready: false,
    status: 'off' as const,
    play: (name: string) => {
      played.push(name);
      return false;
    },
    setEnabled: async () => false,
  }),
}));

function sessions(count: number, from = 0): TrainingSession[] {
  return Array.from({ length: count }, (_, i) => ({
    session_id: `s${from + i}`,
    date: `2026-01-${String((i % 28) + 1).padStart(2, '0')}`,
    rpe: 6,
    completed_flag: true,
  }));
}

function pressedSeals(container: HTMLElement): string[] {
  return [...container.querySelectorAll('.tcard-seal-slot--pressed')]
    .map((slot) => slot.querySelector('svg')?.getAttribute('aria-label') ?? '');
}

beforeEach(() => {
  played.length = 0;
  window.localStorage.clear();
  resetCeremonyMemory();
});

it('presses nothing the first time it sees a card, however much is already on it', () => {
  // A year of training, opened on a phone that has never shown this card. The
  // athlete crossed nothing by opening it, so nothing is celebrated.
  const { container } = render(<TrainingCard sessions={sessions(40)} athleteId="ath_1" />);

  expect(pressedSeals(container)).toEqual([]);
  expect(container.querySelector('.tcard-earned')).toBeNull();
  expect(played).toEqual([]);
});

it('presses the seal, says it in words, and rings once on the crossing', () => {
  const { container, rerender } = render(
    <TrainingCard sessions={sessions(12)} athleteId="ath_1" />,
  );
  expect(played).toEqual([]);

  rerender(<TrainingCard sessions={sessions(13)} athleteId="ath_1" />);

  expect(pressedSeals(container)).toEqual(['13 session milestone, earned']);
  // Law 3 and rule 2 of the sound system: the words carry the whole message on
  // their own, for the volume-down, the reduced-motion and the screen reader.
  const note = container.querySelector('.tcard-earned');
  expect(note?.textContent).toContain('13 sessions');
  expect(note?.getAttribute('role')).toBe('status');
  expect(played).toEqual(['bell']);
});

it('does not ring again on any number of re-renders at the same count', () => {
  const { rerender } = render(<TrainingCard sessions={sessions(12)} athleteId="ath_1" />);
  rerender(<TrainingCard sessions={sessions(13)} athleteId="ath_1" />);
  expect(played).toEqual(['bell']);

  for (let i = 0; i < 5; i++) {
    rerender(<TrainingCard sessions={sessions(13)} athleteId="ath_1" />);
  }
  // And on counts above it, which is where `completed >= 13` would have rung
  // forever.
  for (const count of [14, 20, 33]) {
    rerender(<TrainingCard sessions={sessions(count)} athleteId="ath_1" />);
  }

  expect(played).toEqual(['bell']);
});

it('does not replay the ceremony after a reload', () => {
  const first = render(<TrainingCard sessions={sessions(12)} athleteId="ath_1" />);
  first.rerender(<TrainingCard sessions={sessions(13)} athleteId="ath_1" />);
  expect(played).toEqual(['bell']);
  first.unmount();

  // A reload keeps localStorage and loses everything in memory.
  resetCeremonyMemory();
  played.length = 0;

  const second = render(<TrainingCard sessions={sessions(13)} athleteId="ath_1" />);
  expect(pressedSeals(second.container)).toEqual([]);
  expect(second.container.querySelector('.tcard-earned')).toBeNull();
  expect(played).toEqual([]);
});

it('does not mistake the ledger arriving for five milestones crossing at once', () => {
  // The workspace renders the card with an empty array while the fetch is in
  // flight. An empty card is "nobody has said yet", not a count of zero.
  const { container, rerender } = render(<TrainingCard sessions={[]} athleteId="ath_1" />);
  rerender(<TrainingCard sessions={sessions(40)} athleteId="ath_1" />);

  expect(pressedSeals(container)).toEqual([]);
  expect(played).toEqual([]);
});

it('does not let a failed re-read of the ledger stage a false crossing', () => {
  // loadTrainingCard() sets [] when the read fails, then a retry succeeds. The
  // empty state in between must not reset what the card already knows.
  const { rerender } = render(<TrainingCard sessions={sessions(12)} athleteId="ath_1" />);
  rerender(<TrainingCard sessions={[]} athleteId="ath_1" />);
  rerender(<TrainingCard sessions={sessions(12)} athleteId="ath_1" />);

  expect(played).toEqual([]);
});

it('keeps one athlete ceremony off the next athlete card on a shared tablet', () => {
  const first = render(<TrainingCard sessions={sessions(12)} athleteId="ath_1" />);
  first.rerender(<TrainingCard sessions={sessions(13)} athleteId="ath_1" />);
  expect(played).toEqual(['bell']);
  first.unmount();
  played.length = 0;

  // The next athlete signs in on the same tablet, already past 13.
  const second = render(<TrainingCard sessions={sessions(13)} athleteId="ath_2" />);
  expect(pressedSeals(second.container)).toEqual([]);
  expect(played).toEqual([]);

  // ...and their own crossing still rings.
  second.rerender(<TrainingCard sessions={sessions(34)} athleteId="ath_2" />);
  expect(pressedSeals(second.container)).toEqual(['34 session milestone, earned']);
  expect(played).toEqual(['bell']);
});

it('rings once, for the furthest seal, when a backfill crosses two at a time', () => {
  const { container, rerender } = render(
    <TrainingCard sessions={sessions(4)} athleteId="ath_1" />,
  );
  rerender(<TrainingCard sessions={sessions(14)} athleteId="ath_1" />);

  expect(pressedSeals(container)).toEqual(['13 session milestone, earned']);
  expect(played).toEqual(['bell']);
});

it('celebrates a count, never a run of consecutive days', () => {
  // The no-streaks argument in TrainingCard.tsx is load-bearing: a streak would
  // punish a medically-locked athlete and reward hiding a concussion. Ten
  // sessions spread over three years cross the same milestone as ten in a
  // fortnight, and a long absence before them takes nothing away.
  const sparse: TrainingSession[] = [
    ...sessions(4).map((s, i) => ({ ...s, date: `202${i}-03-0${i + 1}` })),
  ];
  const { container, rerender } = render(<TrainingCard sessions={sparse} athleteId="ath_1" />);
  rerender(
    <TrainingCard
      sessions={[...sparse, { session_id: 'late', date: '2029-11-02', rpe: 5, completed_flag: true }]}
      athleteId="ath_1"
    />,
  );

  expect(pressedSeals(container)).toEqual(['5 session milestone, earned']);
  expect(played).toEqual(['bell']);
  expect(container.innerHTML.toLowerCase()).not.toMatch(/streak|consecutive|in a row/);
});
