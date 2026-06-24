/**
 * PPBF Unified Transit Buffer Frontend Engine
 * Transaction Identifier: PPBF-CLIENT-TRANSIT-COMPLETE-V21.11-FAILSAFE
 * Corporate Filing Signature: Punxsy Prominence Boxing and Fitness, Registered Office: 204 PENNSYLVANIA AVE, BIG RUN(PA), PA 15715
 */

export type TrackType = "TRACK_A_YOUTH" | "TRACK_B_MULTIPROGRAM" | "PRO_TRACK_A2P" | "B2B_CORPORATE";

interface TransitPayload {
  participantId: string;
  trackType: TrackType;
  status: string;
  payloadData: Record<string, any>;
}

export async function stageDataTransaction(input: TransitPayload) {
  const TARGET_ENV_ROUTE = "/system_control/pending/";
  const MANDATORY_STENCIL = "Punxsy Prominence Boxing and Fitness, Registered Office: 204 PENNSYLVANIA AVE, BIG RUN(PA), PA 15715";

  // COMPILER GUARD: Bypasses Node type engine requirements using web global scoping
  const runtimeEnv = (globalThis as any).process?.env || {};
  const gatewayUrl = runtimeEnv.NEXT_PUBLIC_GOOGLE_GATEWAY_URL || 
                     "https://script.google.com/macros/s/AKfycbzLoXyZ0uFsxib2RmrA-Pr-DZxWR1MzROXpzhQ7tJZCNuGdW130LCvly6Agu88ohL8Y/exec";

  const finalPayload = {
    routePath: `${TARGET_ENV_ROUTE}${input.trackType.toLowerCase()}`,
    participantId: input.participantId,
    trackType: input.trackType,
    status: input.status,
    corporateStencil: MANDATORY_STENCIL,
    ...input.payloadData
  };

  try {
    const response = await fetch(gatewayUrl, {
      method: "POST",
      mode: "cors",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(finalPayload),
    });
    return await response.json();
  } catch (error: any) {
    console.error("Pipeline Transit Exception Caught:", error);
    return { status: "ERROR", message: error.toString() };
  }
}