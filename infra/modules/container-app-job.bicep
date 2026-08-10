param name string
param location string
param tags object
param managedEnvironmentId string
param userAssignedIdentityId string
param userAssignedIdentityClientId string
param acrLoginServer string
param containerImage string = 'mcr.microsoft.com/azuredocs/containerapps-helloworld:latest'
param searchEndpoint string
param storageAccountUrl string
param researchContainerName string
param evidenceContainerName string
param keyVaultUrl string
param appInsightsConnectionString string
param stagingAppOrigin string
param mcpAudience string
param syncCronExpression string

// 'Schedule' for the recurring sync, 'Manual' for the one-time index bootstrap.
@allowed([
  'Schedule'
  'Manual'
])
param triggerType string = 'Schedule'

// Only the bootstrap job may create or update the index definition. The
// recurring job holds Search Index Data Contributor, which cannot modify object
// definitions, so leaving this false keeps it on least privilege.
param indexBootstrapMode bool = false

var placeholderImage = 'mcr.microsoft.com/azuredocs/containerapps-helloworld:latest'
var isPlaceholder = containerImage == placeholderImage
var disabledPlaceholderCron = '0 0 31 2 *'

resource job 'Microsoft.App/jobs@2026-01-01' = {
  name: name
  location: location
  tags: tags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${userAssignedIdentityId}': {}
    }
  }
  properties: {
    environmentId: managedEnvironmentId
    configuration: {
      triggerType: triggerType
      replicaTimeout: 1800
      replicaRetryLimit: 2
      scheduleTriggerConfig: triggerType == 'Schedule' ? {
        cronExpression: isPlaceholder ? disabledPlaceholderCron : syncCronExpression
        parallelism: 1
        replicaCompletionCount: 1
      } : null
      manualTriggerConfig: triggerType == 'Manual' ? {
        parallelism: 1
        replicaCompletionCount: 1
      } : null
      registries: isPlaceholder
        ? []
        : [
            {
              server: acrLoginServer
              identity: userAssignedIdentityId
            }
          ]
      secrets: isPlaceholder ? [] : []
    }
    template: {
      containers: [
        {
          name: 'research-sync'
          image: containerImage
          command: isPlaceholder ? [] : [
            'node'
            'apps/research-bridge/dist/sync.js'
          ]
          env: [
            {
              name: 'NODE_ENV'
              value: 'production'
            }
            {
              name: 'SYNC_MODE'
              value: 'scheduled'
            }
            {
              name: 'AZURE_CLIENT_ID'
              value: userAssignedIdentityClientId
            }
            {
              name: 'AZURE_SEARCH_ENDPOINT'
              value: searchEndpoint
            }
            {
              name: 'AZURE_SEARCH_INDEX_NAME'
              value: 'ppbf-research-evidence-v1'
            }
            {
              name: 'AZURE_STORAGE_ACCOUNT_URL'
              value: storageAccountUrl
            }
            {
              name: 'AZURE_STORAGE_RESEARCH_CONTAINER'
              value: researchContainerName
            }
            {
              name: 'AZURE_STORAGE_EVIDENCE_CONTAINER'
              value: evidenceContainerName
            }
            {
              name: 'KEY_VAULT_URL'
              value: keyVaultUrl
            }
            {
              name: 'APPLICATIONINSIGHTS_CONNECTION_STRING'
              value: appInsightsConnectionString
            }
            {
              name: 'STAGING_APP_ORIGIN'
              value: stagingAppOrigin
            }
            {
              name: 'MCP_AUDIENCE'
              value: mcpAudience
            }
            {
              name: 'DATA_CLASSIFICATION'
              value: 'sanitized-staging-only'
            }
            {
              name: 'RESEARCH_INDEX_BOOTSTRAP'
              value: indexBootstrapMode ? 'true' : 'false'
            }
          ]
          resources: {
            cpu: json('0.25')
            memory: '0.5Gi'
          }
        }
      ]
    }
  }
}

output id string = job.id
output name string = job.name
