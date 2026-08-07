param name string
param location string
param tags object
param workspaceId string
param enableDiagnostics bool = false

resource vault 'Microsoft.KeyVault/vaults@2026-02-01' = {
  name: name
  location: location
  tags: tags
  properties: {
    sku: {
      family: 'A'
      name: 'standard'
    }
    tenantId: subscription().tenantId
    enableRbacAuthorization: true
    enableSoftDelete: true
    softDeleteRetentionInDays: 7
    networkAcls: {
      defaultAction: 'Allow'
      bypass: 'AzureServices'
    }
  }
}

resource diagnostics 'Microsoft.Insights/diagnosticSettings@2016-09-01' = if (enableDiagnostics) {
  name: 'service'
  location: location
  scope: vault
  properties: {
    workspaceId: workspaceId
    logs: [
      {
        category: 'AuditEvent'
        enabled: true
      }
    ]
    metrics: [
      {
        enabled: true
        timeGrain: 'PT1M'
      }
    ]
  }
}

output id string = vault.id
output name string = vault.name
output vaultUri string = vault.properties.vaultUri
