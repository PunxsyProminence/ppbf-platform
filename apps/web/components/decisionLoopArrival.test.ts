// #1474 item 5: the hand-off the "Record what you did" link gives the
// Decision Loop is taken once, so a later visit opens on nobody.

import { handOffArrivalAthlete, takeArrivalAthlete } from './decisionLoopArrival';

afterEach(() => {
  takeArrivalAthlete();
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
