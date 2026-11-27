import { pushOfferOnThisDevice } from './pushOffer';

// OW27-17 B: a device marked as a gym tablet never offers web push, whatever
// the server and the browser say (GO on #2228: "a device marked as a gym
// tablet is never offered push ... Test both").

const all = [true, false];

test('a device marked as a gym tablet is never offered push, in every combination', () => {
  for (const serverOffered of all) {
    for (const pushSupported of all) {
      expect(pushOfferOnThisDevice({ serverOffered, pushSupported, gymTabletMarked: true })).toBe('gym_tablet');
    }
  }
});

test('push is offered only when the server offers it, the browser can do it, and the device is not a gym tablet', () => {
  expect(pushOfferOnThisDevice({ serverOffered: true, pushSupported: true, gymTabletMarked: false })).toBe('offered');
  expect(pushOfferOnThisDevice({ serverOffered: false, pushSupported: true, gymTabletMarked: false })).toBe('not_offered');
  expect(pushOfferOnThisDevice({ serverOffered: false, pushSupported: false, gymTabletMarked: false })).toBe('not_offered');
  expect(pushOfferOnThisDevice({ serverOffered: true, pushSupported: false, gymTabletMarked: false })).toBe('unsupported');
});
