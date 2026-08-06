param name string
param location string
param tags object
param workspaceId string
param enableDiagnostics bool = false

resource storage 'Microsoft.Storage/storageAccounts@2026-04-01' = {
  name: name
  location: location
  tags: tags
  kind: 'StorageV2'
  sku: {
    name: 'Standard_LRS'
  }
  properties: {
    accessTier: 'Hot'
    allowBlobPublicAccess: false
    allowCrossTenantReplication: false
    allowSharedKeyAccess: false
    defaultToOAuthAuthentication: true
    minimumTlsVersion: 'TLS1_2'
    publicNetworkAccess: 'Enabled'
    supportsHttpsTrafficOnly: true
    networkAcls: {
      bypass: 'AzureServices'
      defaultAction: 'Allow'
    }
    encryption: {
      keySource: 'Microsoft.Storage'
      services: {
        blob: {
          enabled: true
          keyType: 'Account'
        }
        file: {
          enabled: true
          keyType: 'Account'
        }
      }
    }
  }
}

resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2026-04-01' = {
  name: 'default'
  parent: storage
  properties: {
    containerDeleteRetentionPolicy: {
      enabled: true
      days: 7
    }
  }
}

resource researchNeeds 'Microsoft.Storage/storageAccounts/blobServices/containers@2026-04-01' = {
  name: 'research-needs'
  parent: blobService
  properties: {
    publicAccess: 'None'
  }
}

resource evidenceDrafts 'Microsoft.Storage/storageAccounts/blobServices/containers@2026-04-01' = {
  name: 'evidence-drafts'
  parent: blobService
  properties: {
    publicAccess: 'None'
  }
}

resource diagnostics 'Microsoft.Insights/diagnosticSettings@2016-09-01' = if (enableDiagnostics) {
  name: 'service'
  location: location
  scope: storage
  properties: {
    workspaceId: workspaceId
    metrics: [
      {
        enabled: true
        timeGrain: 'PT1M'
      }
    ]
  }
}

output id string = storage.id
output name string = storage.name
output blobEndpoint string = storage.properties.primaryEndpoints.blob
output researchContainerName string = researchNeeds.name
output evidenceContainerName string = evidenceDrafts.name
