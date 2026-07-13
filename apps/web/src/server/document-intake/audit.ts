import { appendFile, mkdir } from 'node:fs/promises'
import path from 'node:path'

interface IngestAuditEvent {
  at: string
  status: 'success' | 'failure'
  fileName?: string
  message?: string
  details?: Record<string, unknown>
}

const AUDIT_DIR = path.join(process.cwd(), '.audit')
const AUDIT_FILE = path.join(AUDIT_DIR, 'document-ingest.jsonl')

export async function appendIngestAudit(event: IngestAuditEvent): Promise<void> {
  await mkdir(AUDIT_DIR, { recursive: true })
  await appendFile(AUDIT_FILE, `${JSON.stringify(event)}\n`, 'utf8')
}
