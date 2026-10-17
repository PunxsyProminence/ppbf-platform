// #1474 item 5: the hand-off the "Record what you did" link gives the
// Decision Loop is taken once, so a later visit opens on nobody.

import { ARRIVAL_WINDOW_MS, handOffArrivalAthlete, takeArrivalAthlete } from './decisionLoopArrival';

afterEach(() => {
  takeArrivalAthlete();
  jest.restoreAllMocks();
});

test('nothing handed over: nothing taken', () => {
  expect(takeArrivalAthlete()).toBeNull();
});

test('the athlete handed over is taken once, then nothing', () => {
  handOffArrivalAthlete('ath-1');
  expect(takeArrivalAthlete()).toBe('ath-1');
  expect(takeArrivalAthlete()).toBeNull();
});

test('the newest hand-off wins, and a blank id hands over nothing', () => {
  handOffArrivalAthlete('ath-1');
  handOffArrivalAthlete('ath-2');
  expect(takeArrivalAthlete()).toBe('ath-2');
  handOffArrivalAthlete('   ');
  expect(takeArrivalAthlete()).toBeNull();
});

test('a hand-off whose page never arrived does not pick anyone on a later visit', () => {
  const now = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
  handOffArrivalAthlete('ath-1');
  now.mockReturnValue(1_000_000 + ARRIVAL_WINDOW_MS + 1);
  expect(takeArrivalAthlete()).toBeNull();
});

test('a hand-off taken within the window is the athlete', () => {
  const now = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
  handOffArrivalAthlete('ath-1');
  now.mockReturnValue(1_000_000 + ARRIVAL_WINDOW_MS);
  expect(takeArrivalAthlete()).toBe('ath-1');
});
