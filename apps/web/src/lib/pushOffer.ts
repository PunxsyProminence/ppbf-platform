/**
 * WHETHER THIS DEVICE MAY SHOW THE PUSH CONTROL (lane W5-WP, WP-1b; the
 * control itself is WP-3).
 *
 * OW27-17 B: "a device marked as a gym tablet never offers web push". The mark
 * is one key in this browser's own storage (gymTabletMark.ts), a fact about
 * the device that the server never sees, so the rule is kept here, on the
 * device, and the server's own offer (GET /api/pilot/push/subscription) is the
 * other half: no offer there, no control here.
 *
 * Push needs a service worker, the Push API and notifications in this browser;
 * without them the control is not shown either (QE A on #2228: a plain line
 * instead, never a control that does nothing).
 */

export interface PushOfferInput {
  /** GET /api/pilot/push/subscription said `offered: true`. */
  readonly serverOffered: boolean;
  /** isGymTabletMarked() for this browser. */
  readonly gymTabletMarked: boolean;
  /** This browser has a service worker, the Push API and notifications. */
  readonly pushSupported: boolean;
}

export type PushOfferState = 'offered' | 'gym_tablet' | 'not_offered' | 'unsupported';

/** What the device shows: the control only when every part says yes; the gym tablet rule first. */
export function pushOfferOnThisDevice(input: PushOfferInput): PushOfferState {
  if (input.gymTabletMarked) return 'gym_tablet';
  if (!input.serverOffered) return 'not_offered';
  if (!input.pushSupported) return 'unsupported';
  return 'offered';
}
