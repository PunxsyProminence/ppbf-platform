import type { DataverseConfig } from './dataverse'
import type { GoogleDriveConfig } from './googleDrive'
import type { SharePointConfig } from './sharepoint'

// Document-intake destination configuration.
//
// TWO DEFECTS THIS FILE USED TO HAVE, both of which reported success while
// doing the wrong thing:
//
// 1. IT CHECKED CREDENTIALS, NOT DESTINATIONS. GOOGLE_DRIVE_FOLDER_ID was
//    optional, so a fully "configured" pipeline could have a blank Drive
//    destination. googleDrive.ts then passed `parents: undefined`, which
//    uploads into the SERVICE ACCOUNT's own Drive -- storage no human on this
//    project can open. The API call succeeds, the audit row says success, and
//    the file is effectively gone. A silent fallback that loses files is worse
//    than a refusal to start, so the folder id is now REQUIRED whenever Drive
//    is enabled.
//
// 2. IT WAS ALL-OR-NOTHING. getPipelineConfig() demanded Dataverse AND
//    Microsoft Graph AND Google Drive or it threw, so getting PDFs into a
//    Drive folder required standing up a Dataverse instance. The three
//    destinations are now independent: enable one, none, or all.
//
// HOW "ENABLED" IS DECIDED, and why it is not "all its variables are present".
// A destination is enabled when ANY of its own settings is present -- that is
// read as intent. If enabled-but-incomplete instead reported "disabled", a
// typo'd variable name would silently switch a destination off and every
// document would quietly stop going there. Intent-then-validate makes a
// half-configured destination LOUD, which is the whole point of this file.
//
// SINGLE SOURCE OF TRUTH. pilotOpsReadiness.ts used to mirror the required
// variable list with a comment admitting the hazard ("if config.ts adds a
// required variable, add it here too"). It now calls
// describeDocumentIngestDestinations() instead, so the readiness report and
// the thing it reports on cannot drift apart.

export type DocumentIngestDestinationName = 'dataverse' | 'sharepoint' | 'googleDrive'

export interface DocumentIngestDestinationStatus {
  /** Somebody set at least one of this destination's variables. */
  enabled: boolean
  /** Enabled AND every setting it needs to deliver a file is present. */
  ready: boolean
  /**
   * Required variables an ENABLED destination still lacks. Names only -- never
   * values, because an ops-readiness endpoint echoes this back.
   *
   * Empty for a destination nobody switched on, so `missing.length > 0` is a
   * reliable signal of a real problem. Listing every variable for a
   * deliberately-off destination would make "off on purpose" and "broken" look
   * identical to any caller checking this field.
   */
  missing: string[]
  reason: string
}

export type DocumentIngestDestinationReport =
  Record<DocumentIngestDestinationName, DocumentIngestDestinationStatus>

export interface PipelineConfig {
  dataverse: DataverseConfig | null
  sharepoint: SharePointConfig | null
  googleDrive: GoogleDriveConfig | null
}

interface DestinationSpec {
  label: string
  /**
   * Every variable this destination owns. Presence of ANY of them means
   * somebody intended to turn it on.
   */
  signals: readonly string[]
  /** Variables that must be present before a file can actually be delivered. */
  required: readonly string[]
}

/**
 * Note which variables are required and which are merely signals.
 *
 * GOOGLE_DRIVE_FOLDER_ID is required; SHAREPOINT_FOLDER_PATH and
 * DATAVERSE_TABLE_LOGICAL_NAME are not, and the asymmetry is deliberate rather
 * than an oversight. A missing SharePoint folder path falls back to
 * 'PPBF/Intake' INSIDE the site and drive the operator explicitly configured,
 * so the file lands somewhere a human can navigate to and find. A missing
 * Dataverse table name falls back to 'annotations' in the org they configured
 * -- same reasoning. A missing Drive folder id has no such anchor: there is no
 * configured "drive" to fall back within, so the file goes to the service
 * account's own storage, which nobody can browse. One fallback is a default;
 * the other is data loss.
 */
const DESTINATIONS: Record<DocumentIngestDestinationName, DestinationSpec> = {
  dataverse: {
    label: 'Dataverse',
    signals: [
      'DATAVERSE_ORG_URL',
      'DATAVERSE_TENANT_ID',
      'DATAVERSE_CLIENT_ID',
      'DATAVERSE_CLIENT_SECRET',
      'DATAVERSE_TABLE_LOGICAL_NAME',
    ],
    required: [
      'DATAVERSE_ORG_URL',
      'DATAVERSE_TENANT_ID',
      'DATAVERSE_CLIENT_ID',
      'DATAVERSE_CLIENT_SECRET',
    ],
  },
  sharepoint: {
    label: 'SharePoint',
    signals: [
      'GRAPH_TENANT_ID',
      'GRAPH_CLIENT_ID',
      'GRAPH_CLIENT_SECRET',
      'SHAREPOINT_SITE_ID',
      'SHAREPOINT_DRIVE_ID',
      'SHAREPOINT_FOLDER_PATH',
    ],
    required: [
      'GRAPH_TENANT_ID',
      'GRAPH_CLIENT_ID',
      'GRAPH_CLIENT_SECRET',
      'SHAREPOINT_SITE_ID',
      'SHAREPOINT_DRIVE_ID',
    ],
  },
  googleDrive: {
    label: 'Google Drive',
    signals: ['GOOGLE_SERVICE_ACCOUNT_JSON', 'GOOGLE_DRIVE_FOLDER_ID'],
    // The folder id sits here, not among the optional settings, for the reason
    // in the block comment above: without it the upload silently lands
    // somewhere nobody can reach.
    required: ['GOOGLE_SERVICE_ACCOUNT_JSON', 'GOOGLE_DRIVE_FOLDER_ID'],
  },
}

type Env = Record<string, string | undefined>

function present(env: Env, name: string): boolean {
  return Boolean(env[name]?.trim())
}

/**
 * Per-destination status for an environment. Pure, synchronous, no I/O, and it
 * returns variable NAMES only -- never a value, because callers include an
 * ops-readiness endpoint that must never echo a secret.
 */
export function describeDocumentIngestDestinations(
  env: Env = process.env,
): DocumentIngestDestinationReport {
  const entries = Object.entries(DESTINATIONS) as Array<[DocumentIngestDestinationName, DestinationSpec]>

  return Object.fromEntries(entries.map(([name, spec]) => {
    const enabled = spec.signals.some((variable) => present(env, variable))
    const missing = enabled
      ? spec.required.filter((variable) => !present(env, variable))
      : []
    const ready = enabled && missing.length === 0

    let reason: string
    if (!enabled) {
      reason = `${spec.label} is not configured -- no ${spec.label} setting is present. Documents will not be sent there.`
    } else if (ready) {
      reason = `${spec.label} is configured and has a destination to write to.`
    } else {
      reason = `${spec.label} is partly configured: ${missing.join(', ')} missing. `
        + 'Ingest refuses to start rather than writing somewhere nobody can find.'
    }

    return [name, { enabled, ready, missing, reason }]
  })) as DocumentIngestDestinationReport
}

/**
 * Builds the config for whichever destinations are enabled.
 *
 * Throws when a destination is enabled but incomplete. That is the intended
 * behaviour, not a rough edge: the alternative -- carrying on with the
 * destination quietly dropped, or with a fallback that writes into unreachable
 * storage -- is how a pipeline comes to report success while losing files.
 *
 * Also throws when NOTHING is configured, because an ingest that writes to no
 * destination at all still returns 200 and still records an audit row saying
 * the document was handled.
 */
export function getPipelineConfig(env: Env = process.env): PipelineConfig {
  const status = describeDocumentIngestDestinations(env)

  const incomplete = (Object.entries(status) as Array<[DocumentIngestDestinationName, DocumentIngestDestinationStatus]>)
    .filter(([, value]) => value.enabled && !value.ready)

  if (incomplete.length > 0) {
    const detail = incomplete
      .map(([name, value]) => `${DESTINATIONS[name].label} (missing ${value.missing.join(', ')})`)
      .join('; ')
    throw new Error(
      `Document ingest destination is configured but incomplete: ${detail}. `
      + 'Set the missing variables or remove the destination\'s settings entirely.',
    )
  }

  if (!status.dataverse.ready && !status.sharepoint.ready && !status.googleDrive.ready) {
    throw new Error(
      'Document ingest has no configured destination. Set at least one of Dataverse, '
      + 'SharePoint/Graph, or Google Drive before enabling ingest.',
    )
  }

  return {
    dataverse: status.dataverse.ready
      ? {
        orgUrl: env.DATAVERSE_ORG_URL as string,
        tableName: env.DATAVERSE_TABLE_LOGICAL_NAME?.trim() || 'annotations',
        tenantId: env.DATAVERSE_TENANT_ID as string,
        clientId: env.DATAVERSE_CLIENT_ID as string,
        clientSecret: env.DATAVERSE_CLIENT_SECRET as string,
      }
      : null,
    sharepoint: status.sharepoint.ready
      ? {
        tenantId: env.GRAPH_TENANT_ID as string,
        clientId: env.GRAPH_CLIENT_ID as string,
        clientSecret: env.GRAPH_CLIENT_SECRET as string,
        siteId: env.SHAREPOINT_SITE_ID as string,
        driveId: env.SHAREPOINT_DRIVE_ID as string,
        folderPath: env.SHAREPOINT_FOLDER_PATH?.trim() || 'PPBF/Intake',
      }
      : null,
    googleDrive: status.googleDrive.ready
      ? {
        serviceAccountJson: env.GOOGLE_SERVICE_ACCOUNT_JSON as string,
        // Non-optional now. See googleDrive.ts, which also refuses a blank one
        // at the point of upload rather than trusting this to have checked.
        folderId: env.GOOGLE_DRIVE_FOLDER_ID as string,
      }
      : null,
  }
}
