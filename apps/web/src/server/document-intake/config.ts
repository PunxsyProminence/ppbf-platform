import type { DataverseConfig } from './dataverse'
import type { GoogleDriveConfig } from './googleDrive'
import type { SharePointConfig } from './sharepoint'

interface PipelineConfig {
  dataverse: DataverseConfig
  sharepoint: SharePointConfig
  googleDrive: GoogleDriveConfig
}

function required(name: string): string {
  const value = process.env[name]
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`)
  }
  return value
}

export function getPipelineConfig(): PipelineConfig {
  return {
    dataverse: {
      orgUrl: required('DATAVERSE_ORG_URL'),
      tableName: process.env.DATAVERSE_TABLE_LOGICAL_NAME || 'annotations',
      tenantId: required('DATAVERSE_TENANT_ID'),
      clientId: required('DATAVERSE_CLIENT_ID'),
      clientSecret: required('DATAVERSE_CLIENT_SECRET'),
    },
    sharepoint: {
      tenantId: required('GRAPH_TENANT_ID'),
      clientId: required('GRAPH_CLIENT_ID'),
      clientSecret: required('GRAPH_CLIENT_SECRET'),
      siteId: required('SHAREPOINT_SITE_ID'),
      driveId: required('SHAREPOINT_DRIVE_ID'),
      folderPath: process.env.SHAREPOINT_FOLDER_PATH || 'PPBF/Intake',
    },
    googleDrive: {
      serviceAccountJson: required('GOOGLE_SERVICE_ACCOUNT_JSON'),
      folderId: process.env.GOOGLE_DRIVE_FOLDER_ID,
    },
  }
}
