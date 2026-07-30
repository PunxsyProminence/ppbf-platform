import { query } from '@/src/server/pilot/db'

interface IngestAuditEvent {
  at: string
  status: 'success' | 'failure'
  fileName?: string
  message?: string
  details?: Record<string, unknown>
}

export async function appendIngestAudit(event: IngestAuditEvent): Promise<void> {
  try {
    await query(
      `insert into pilot.document_ingest_audit (
         occurred_at,
         status,
         file_name,
         message,
         details
       ) values ($1,$2,$3,$4,$5)`,
      [
        event.at,
        event.status,
        event.fileName ?? null,
        event.message ?? null,
        event.details ?? {},
      ],
    )
  } catch (error) {
    // Do not fail ingest workflow if audit logging itself fails.
    console.error('document-ingest-audit-write-failed', error)
  }
}
