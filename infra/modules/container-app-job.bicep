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
      triggerType: 'Schedule'
      replicaTimeout: 1800
      replicaRetryLimit: 2
      scheduleTriggerConfig: {
        cronExpression: isPlaceholder ? disabledPlaceholderCron : syncCronExpression
        parallelism: 1
        replicaCompletionCount: 1
      }
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
