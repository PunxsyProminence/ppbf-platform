export function sendNotification(type: string, recipient: string, message: string) {
  // In production: integrate with email/SMS service
  console.log(`[NOTIFICATION] To: ${recipient} | Type: ${type}`);
  console.log(`Message: ${message}`);
  return { success: true, loggedToLedger: true };
}

export const NOTIFICATION_TYPES = {
  SAFETY_ALERT: 'safety_alert',
  PROGRESS_UPDATE: 'progress_update',
  COACH_REVIEW: 'coach_review_required',
  GOVERNANCE_PROMOTION: 'governance_promotion',
};
