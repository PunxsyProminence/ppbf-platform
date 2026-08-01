// Payment setup status.
//
// Payments are a RESERVED slot (docs/PAYMENT_SERVICE_SLOT.md): no charging, no
// checkout, no webhook, and CAP-012 stays BLOCKED until the owner's compliance
// sign-off. What exists here is only the question "how far along is setup?",
// asked so the admin console can show the remaining steps and stop showing
// them the moment they are done.
//
// The lanes are separate Stripe accounts on purpose. Giving (donations,
// recurring) and program (class fees, B2B wholesale) are contribution revenue
// and program-service revenue -- different things to the IRS, to an auditor,
// and on a Form 990 -- so each connects on its own and each reports its own
// status. A gym is not "set up" until both are connected.
//
// This reads configuration only. When the connect flow is built, the connected
// lanes come from pilot.payment_accounts instead and every caller of
// resolvePaymentSetupStatus keeps working unchanged.

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

// A lane counts as connected only once an account id has been stored for it.
// Until the connect flow exists there is nowhere for one to come from, so both
// lanes read not_connected -- which is the truth, not a placeholder.
function laneStatus(lane: PaymentLane): PaymentLaneStatus {
  const configured = lane === 'giving'
    ? process.env.PAYMENT_GIVING_ACCOUNT_ID?.trim()
    : process.env.PAYMENT_PROGRAM_ACCOUNT_ID?.trim();
  return configured ? 'connected' : 'not_connected';
}

function buildRemainingSteps(enabled: boolean, lanes: Record<PaymentLane, PaymentLaneStatus>): string[] {
  const steps: string[] = [];
  const unconnected = PAYMENT_LANES.filter((lane) => lanes[lane] === 'not_connected');

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

export function resolvePaymentSetupStatus(): PaymentSetupStatus {
  const enabled = paymentsEnabled();
  const lanes: Record<PaymentLane, PaymentLaneStatus> = {
    giving: laneStatus('giving'),
    program: laneStatus('program'),
  };
  const remainingSteps = buildRemainingSteps(enabled, lanes);

  return {
    ready: enabled && PAYMENT_LANES.every((lane) => lanes[lane] === 'connected'),
    enabled,
    lanes,
    remainingSteps,
  };
}
