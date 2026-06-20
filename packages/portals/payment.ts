export interface PaymentRequest {
  participantId: string;
  amount: number;
  purpose: string;
  proofOfSuccess: boolean;
  jasonApproval: boolean;
}

export function processPayment(request: PaymentRequest) {
  if (!request.proofOfSuccess) {
    return { success: false, reason: 'Payment blocked - proof of success required per governance rules' };
  }
  if (!request.jasonApproval) {
    return { success: false, reason: 'Payment blocked - explicit Jason approval required (Layer 0)' };
  }
  return { success: true, transactionId: 'TX-' + Date.now(), message: 'Payment processed under governance' };
}
