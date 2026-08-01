// SHADOW Data Archival - Safe Data Management with Parameterized SQL
// All queries use parameterized statements to prevent SQL injection

import { query } from './db';
import { BlobServiceClient } from '@azure/storage-blob';
import { gzip } from 'node:zlib';
import { promisify } from 'node:util';

const gzipAsync = promisify(gzip);

export interface ArchiveConfig {
  hotDays: number;      // Days to keep in hot storage
  coldDays: number;     // Days before archiving to cold storage
  blobConnectionString: string;
  containerName: string;
}

export interface ArchiveResult {
  success: boolean;
  archivedCount: number;
  aggregatedMonths: number;
  error?: string;
}

// Insert monthly statistics (parameterized query)
export async function insertMonthlyStats(
  organizationId: string,
  year: number,
  month: number,
  interactionCount: number,
  avgFilterRate: number,
  avgEffectivenessScore: number,
): Promise<void> {
  const monthStr = `${year}-${String(month).padStart(2, '0')}`;

  // FIX 3: Parameterized query - no string interpolation
  await query(
    `INSERT INTO pilot.shadow_monthly_stats 
     (organization_id, month, interaction_count, avg_filter_rate, avg_effectiveness_score, created_at)
     VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)
     ON CONFLICT (organization_id, month) 
     DO UPDATE SET 
       interaction_count = $3,
       avg_filter_rate = $4,
       avg_effectiveness_score = $5,
       updated_at = CURRENT_TIMESTAMP`,
    [organizationId, monthStr, interactionCount, avgFilterRate, avgEffectivenessScore],
  );
}

// Archive old data and aggregate monthly statistics
export async function archiveOldData(config: ArchiveConfig): Promise<ArchiveResult> {
  try {
    // Calculate cutoff date (data older than coldDays)
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - config.coldDays);
    const cutoffDateStr = cutoffDate.toISOString().split('T')[0];

    // FIX 3: Parameterized SELECT - no string interpolation
    const oldDataResult = await query<{ created_at: string; interaction_count?: number }>(
      `SELECT * FROM pilot.shadow_chat_audit 
       WHERE created_at < $1::date`,
      [cutoffDateStr],
    );

    const oldRecords = oldDataResult;
    let archivedCount = 0;

    // Archive to blob storage if configured
    if (config.blobConnectionString && oldRecords.length > 0) {
      const blobClient = BlobServiceClient.fromConnectionString(config.blobConnectionString);
      const containerClient = blobClient.getContainerClient(config.containerName);
      await containerClient.createIfNotExists();

      const archiveFileName = `shadow_audit_${cutoffDateStr}.json.gz`;
      const jsonData = JSON.stringify(oldRecords);
      const compressedData = await gzipAsync(jsonData);

      await containerClient.getBlockBlobClient(archiveFileName).upload(compressedData, compressedData.length);
    }

    // FIX 3: Parameterized DELETE - no string interpolation
    if (oldRecords.length > 0) {
      await query(
        `DELETE FROM pilot.shadow_chat_audit WHERE created_at < $1::date`,
        [cutoffDateStr],
      );
      archivedCount = oldRecords.length;
    }

    // Aggregate monthly statistics for all organizations
    const orgResult = await query<{organization_id: string}>(
      `SELECT DISTINCT organization_id FROM pilot.shadow_chat_audit`,
    );
    let aggregatedMonths = 0;

    for (const orgRow of orgResult) {
      const organizationId = orgRow.organization_id;

      // Get last month's date range
      const now = new Date();
      const monthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const monthEnd = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59);
      const monthStartStr = monthStart.toISOString().split('T')[0];
      const monthEndStr = monthEnd.toISOString().split('T')[0];

      // FIX 3: Parameterized aggregation query - no string interpolation
      const statsResult = await query<{interaction_count: string; avg_filter_rate: string | null}>(
        `SELECT 
           COUNT(*) as interaction_count,
           AVG(CASE WHEN was_filtered THEN 1 ELSE 0 END) as avg_filter_rate
         FROM pilot.shadow_chat_audit
         WHERE organization_id = $1 
         AND created_at >= $2::date 
         AND created_at <= $3::date`,
        [organizationId, monthStartStr, monthEndStr],
      );

      const stats = statsResult[0];
      if (stats && Number.parseInt(stats.interaction_count, 10) > 0) {
        await insertMonthlyStats(
          organizationId,
          monthStart.getFullYear(),
          monthStart.getMonth() + 1,
          Number.parseInt(stats.interaction_count, 10),
          Number.parseFloat(stats.avg_filter_rate || '0'),
          0, // avg_effectiveness_score would come from recommendation tracking
        );
        aggregatedMonths++;
      }
    }

    return {
      success: true,
      archivedCount,
      aggregatedMonths,
    };
  } catch (error) {
    return {
      success: false,
      archivedCount: 0,
      aggregatedMonths: 0,
      error: `Archive failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

// Scheduled job hook for daily archival (to be called by your job scheduler)
export async function runDailyArchival(config: ArchiveConfig): Promise<ArchiveResult> {
  return archiveOldData(config);
}

export const ARCHIVE_HOT_DAYS = 90;
export const ARCHIVE_COLD_DAYS = 365;
export const ARCHIVAL_MIN_INTERVAL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_ARCHIVE_CONTAINER = 'ppbf-pilot-shadow-archive';

// Archival removes rows from the hot table, so it is only configured when the
// destination it writes them to is. Without a storage connection string the
// rows would leave Postgres with nothing written anywhere, and this is minors'
// conversation history: no destination means no archival rather than a delete.
export function resolveArchiveConfig(
  env: Record<string, string | undefined> = process.env,
): ArchiveConfig | null {
  const blobConnectionString = env.AZURE_STORAGE_CONNECTION_STRING?.trim() || '';
  if (!blobConnectionString) {
    return null;
  }

  return {
    hotDays: ARCHIVE_HOT_DAYS,
    coldDays: ARCHIVE_COLD_DAYS,
    blobConnectionString,
    containerName: env.PPBF_PILOT_SHADOW_ARCHIVE_CONTAINER?.trim() || DEFAULT_ARCHIVE_CONTAINER,
  };
}

export interface ArchivalSweepOutcome {
  ran: boolean;
  skipped?: 'not_due' | 'not_configured';
  result?: ArchiveResult;
}

interface SweepDependencies {
  env?: Record<string, string | undefined>;
  archive?: (config: ArchiveConfig) => Promise<ArchiveResult>;
  now?: () => number;
}

// The sweep carries its own daily floor rather than trusting the cadence of
// whatever calls it: the caller's interval is deploy-configurable, and each run
// reads, uploads, and deletes every audit row past the cutoff. The stamp is
// per-process, so a restart re-arms it -- at worst a second pass over the same
// cutoff date, which finds nothing left to archive.
//
// It also never throws. It rides the same tick as job processing, so a storage
// outage or an unreachable database must degrade to a logged failure rather
// than surface as a worker error.
export function createShadowArchivalSweep(
  dependencies: SweepDependencies = {},
): () => Promise<ArchivalSweepOutcome> {
  const archive = dependencies.archive ?? runDailyArchival;
  const now = dependencies.now ?? Date.now;
  let lastRunMs: number | null = null;

  return async () => {
    const startedAt = now();

    if (lastRunMs !== null && startedAt - lastRunMs < ARCHIVAL_MIN_INTERVAL_MS) {
      return { ran: false, skipped: 'not_due' };
    }

    const config = resolveArchiveConfig(dependencies.env ?? process.env);
    if (!config) {
      return { ran: false, skipped: 'not_configured' };
    }

    lastRunMs = startedAt;

    try {
      return { ran: true, result: await archive(config) };
    } catch (error) {
      return {
        ran: true,
        result: {
          success: false,
          archivedCount: 0,
          aggregatedMonths: 0,
          error: `Archive failed: ${error instanceof Error ? error.message : String(error)}`,
        },
      };
    }
  };
}

// Verify archival integrity
export async function verifyArchiveIntegrity(config: ArchiveConfig): Promise<{ isValid: boolean; issues: string[] }> {
  const issues: string[] = [];

  // Check that monthly stats exist for recent months
  const monthlyStatsResult = await query<{count: string}>(
    `SELECT COUNT(*) as count FROM pilot.shadow_monthly_stats 
     WHERE created_at > NOW() - INTERVAL '90 days'`,
  );

  if (monthlyStatsResult[0] && Number.parseInt(monthlyStatsResult[0].count, 10) === 0) {
    issues.push('No monthly statistics found for recent months');
  }

  // Check that audit table doesn't have very old records
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - config.coldDays);
  const cutoffDateStr = cutoffDate.toISOString().split('T')[0];

  // FIX 3: Parameterized verification query
  const oldRecordsResult = await query<{count: string}>(
    `SELECT COUNT(*) as count FROM pilot.shadow_chat_audit 
     WHERE created_at < $1::date`,
    [cutoffDateStr],
  );

  const oldRecordCount = Number.parseInt(oldRecordsResult[0]?.count || '0', 10);
  if (oldRecordCount > 100) {
    issues.push(`${oldRecordCount} old audit records still in active table`);
  }

  return {
    isValid: issues.length === 0,
    issues,
  };
}
