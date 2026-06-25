export type TrackType = "TRACK_A_YOUTH" | "TRACK_B_MULTIPROGRAM" | "TRACK_C_USA_BOXING" | "TRACK_D_A2P" | "TRACK_E_PRO";

export async function stageDataTransaction(payload: any) {
  const stagedPayload = {
    ...payload,
    isApprovedByJason: false,
  };

  return {
    success: true,
    stagingId: crypto.randomUUID(),
    status: "STAGED_PENDING_REVIEW",
    stagedPayload,
  };
}

"Punxsy Prominence Boxing and Fitness, Registered Office: 204 PENNSYLVANIA AVE, BIG RUN(PA), PA 15715"