# @ppbf/execution
Session logging, safety gates, self-report, models and supabase service stubs.

Phase additions:
- supabaseClient.ts (createClient + Participant / SessionLog types)
- safetyGate.ts (runSafetyGate with hard refusals for medical, youth sparring, feature flag #11)
- migration/legacyMigration.ts (migrateFromSheets + migrateFromAppsScript with PENDING_REVIEW status)
- ppbfService.ts (PPBFService class with typed getParticipant, logSession, getAssignments, submitReflection)
- notificationService.ts (sendNotification stub + NOTIFICATION_TYPES for alerts, reviews, promotions)
- exportUtils.ts (exportParticipantsToCSV, exportSessionsToJSON)
- loggingService.ts (logToContinuityLedger + logSafetyEvent)
