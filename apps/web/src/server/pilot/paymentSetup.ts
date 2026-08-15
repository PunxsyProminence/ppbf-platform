// Payment setup status.
//
// Payments are a RESERVED slot (docs/PAYMENT_SERVICE_SLOT.md): no charging, no
// checkout, and CAP-012 stays BLOCKED until the owner's compliance sign-off.
// What exists here is only the question "how far along is setup?", asked so
// the admin console can show the remaining steps and stop showing them the
// moment they are done.
//
// The lanes are separate Stripe accounts on purpose. Giving (donations,
// recurring) and program (class fees, B2B wholesale) are contribution revenue
// and program-service revenue -- different things to the IRS, to an auditor,
// and on a Form 990 -- so each connects on its own and each reports its own
// status. A gym is not "set up" until both are connected.
//
// As promised when this module was configuration-only: the connected lanes
// now come from pilot.payment_accounts (written by the connect flow in
// paymentConnect.ts), and every caller keeps working unchanged apart from
// awaiting the answer.

import { getConnectedLanes, readPaymentPlatformConfig } from './paymentConnect';

export type PaymentLane = 'giving' | 'program';

export type PaymentLaneStatus = 'connected' | 'not_connected';

export interface PaymentSetupStatus {
  /** True only when money can actually move: enabled AND both lanes connected. */
  ready: boolean;
  /** The PPBF_PAYMENTS_ENABLED flag. Off is the normal state today. */
  enabled: boolean;
  lanes: Record<PaymentLane, PaymentLaneStatus>;
  /**
   * The remaining steps, in order, in the words an admin needs. Empty when
   * setup is complete -- which is what lets the console drop the prompt
   * without a second flag to keep in sync.
   */
  remainingSteps: string[];
}

export const PAYMENT_LANES: readonly PaymentLane[] = ['giving', 'program'] as const;

export const PAYMENT_LANE_LABELS: Record<PaymentLane, string> = {
  giving: 'Giving (donations and recurring)',
  program: 'Program (class fees and wholesale)',
};

function paymentsEnabled(): boolean {
  return process.env.PPBF_PAYMENTS_ENABLED === 'true';
}

function buildRemainingSteps(
  enabled: boolean,
  platformRegistered: boolean,
  lanes: Record<PaymentLane, PaymentLaneStatus>,
): string[] {
  const steps: string[] = [];
  const unconnected = PAYMENT_LANES.filter((lane) => lanes[lane] === 'not_connected');

  if (!platformRegistered) {
    // Step zero, once for the whole platform: without the Connect OAuth
    // client the connect button has nowhere to send anyone.
    steps.push(
      "Register the platform's Stripe account and Connect OAuth client"
      + ' (PAYMENT_CONNECT_CLIENT_ID) — done once, for every organization.',
    );
  }

  if (unconnected.length > 0) {
    // Giving first on purpose: its 501(c)(3) verification is the slow half, and
    // starting it late is the thing that delays the whole switch-on.
    steps.push(
      'Open the Stripe accounts you have not opened yet, starting with Giving —'
      + ' its 501(c)(3) verification takes the longest and unlocks the nonprofit rate.',
    );
    for (const lane of unconnected) {
      steps.push(`Connect the ${PAYMENT_LANE_LABELS[lane]} account.`);
    }
  }

  if (!enabled) {
    steps.push(
      'Record compliance sign-off, then turn payments on in staging before production.',
    );
  }

  return steps;
}

export async function resolvePaymentSetupStatus(organizationId: string): Promise<PaymentSetupStatus> {
  const enabled = paymentsEnabled();
  const platformRegistered = readPaymentPlatformConfig().connectClientId !== null;
  const connected = new Set(await getConnectedLanes(organizationId));
  const lanes: Record<PaymentLane, PaymentLaneStatus> = {
    giving: connected.has('giving') ? 'connected' : 'not_connected',
    program: connected.has('program') ? 'connected' : 'not_connected',
  };
  const remainingSteps = buildRemainingSteps(enabled, platformRegistered, lanes);

  return {
    ready: enabled && PAYMENT_LANES.every((lane) => lanes[lane] === 'connected'),
    enabled,
    lanes,
    remainingSteps,
  };
}
