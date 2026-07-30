/**
 * PPBF Data Seed Configuration Example
 *
 * Copy this file to seed-data.config.ts and customize for your data
 *
 * Expected CSV columns:
 * - Athletes: athlete_id, full_name, dob, weight_class, gym_status, emergency_contact, active_flag, coach_id
 * - Goals: goal_id, athlete_id, title, target_date, metric, status
 * - Sessions: session_id, athlete_id, date, rpe, notes, completed_flag
 *
 * Expected JSON format (array of objects with same fields)
 */

export default {
  // Organization to seed data into
  organizationId: 'ppbf-demo-org',

  // Directory containing data files (relative to project root)
  dataDir: './scripts/data',

  // Files to load (set to undefined to skip)
  files: {
    // CSV or JSON file with athlete records
    athletes: 'athletes.csv',

    // CSV or JSON file with goal records
    goals: 'goals.csv',

    // CSV or JSON file with session (workout) records
    sessions: 'sessions.csv',

    // Future: research sources and documents
    // researchSources: 'research-sources.json',
    // researchDocuments: 'research-docs.json',
  },

  options: {
    // Run without making changes to database
    dryRun: false,

    // Skip validation (not recommended)
    skipValidation: false,

    // Batch size for bulk operations (if implemented)
    batchSize: 1000,

    // Continue seeding even if some rows fail
    continueOnError: true,
  },
};
