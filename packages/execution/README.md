# @ppbf/execution
Session logging, safety gates, self-report, and execution helpers.

Phase additions:
- safetyGate.ts (runSafetyGate with hard refusals for medical, youth sparring, feature flag #11)
- ppbfService.ts (PPBFService class with typed getParticipant, logSession, getAssignments, submitReflection)
- notificationService.ts (sendNotification stub + NOTIFICATION_TYPES for alerts, reviews, promotions)
- exportUtils.ts (exportParticipantsToCSV, exportSessionsToJSON)
- loggingService.ts (logToContinuityLedger + logSafetyEvent)
