targetScope = 'subscription'

@minLength(1)
@maxLength(64)
param environmentName string

@minLength(1)
param location string

@minLength(1)
param sessionId string

@minLength(1)
param deployedBy string

@minLength(1)
param createdAt string

@description('Object ID of the deploying user. Supply at deployment time; do not commit credentials.')
param deployerObjectId string

@description('Container image used by both the MCP endpoint and sync job. Phase 1 uses the public placeholder.')
param containerImage string = 'mcr.microsoft.com/azuredocs/containerapps-helloworld:latest'

@description('Origin of the authenticated PPBF staging export route. Required with the real image.')
param stagingAppOrigin string = ''

@description('OAuth audience exposed by the Entra API registration. Required with the real image.')
param mcpAudience string = ''

@description('Client ID of the Entra API registration protecting the MCP endpoint.')
param entraApiClientId string = ''

@description('Client ID of the Entra Claude connector registration allowed to call the MCP endpoint.')
param entraClaudeClientId string = ''

@description('Keep false for the private placeholder phase. Set true only after both Entra registrations exist.')
param enableEntraAuth bool = false

@description('Enable resource diagnostic settings after the core resources and Log Analytics workspace are provisioned.')
param enableDiagnostics bool = false

@description('Email recipients for Azure budget alerts. Supply at deployment time; empty disables notifications.')
param budgetAlertEmails array = []

param budgetStartDate string
param budgetEndDate string

param resourceGroupName string = 'rg-ppbf-staging-dfbc'
param managedEnvironmentName string = 'cae-ppbf-staging-dfbc'
param containerAppName string = 'ca-ppbf-research-dfbc'
param containerJobName string = 'caj-ppbf-sync-dfbc'
param bootstrapJobName string = 'caj-ppbf-index-bootstrap-dfbc'
param containerRegistryName string = 'crppbfstagingdfbc'
param searchServiceName string = 'srch-ppbf-staging-dfbc'
param storageAccountName string = 'stppbfstagingdfbc'
param keyVaultName string = 'kv-ppbf-staging-dfbc'
param logAnalyticsName string = 'log-ppbf-staging-dfbc'
param appInsightsName string = 'appi-ppbf-staging-dfbc'
param managedIdentityName string = 'id-ppbf-staging-dfbc'
param bootstrapIdentityName string = 'id-ppbf-bootstrap-dfbc'
param budgetName string = 'budget-ppbf-staging-dfbc'
param syncCronExpression string = '0 */6 * * *'

var tags = {
  'app-onboard-skill': 'true'
  'app-onboard-session-id': sessionId
  'created-at': createdAt
  environment: environmentName
  'deployed-by': deployedBy
}

resource rg 'Microsoft.Resources/resourceGroups@2023-07-01' = {
  name: resourceGroupName
  location: location
  tags: tags
}

module logAnalytics './modules/log-analytics.bicep' = {
  name: 'log-analytics'
  scope: rg
  params: {
    name: logAnalyticsName
    location: location
    tags: tags
  }
}

module managedIdentity './modules/managed-identity.bicep' = {
  name: 'managed-identity'
  scope: rg
  params: {
    name: managedIdentityName
    location: location
    tags: tags
  }
}

// Separate from managedIdentity on purpose. This one holds Search Service
// Contributor so it can create the index definition; keeping it distinct is
// what stops the scheduled sync from inheriting object-management rights.
module bootstrapIdentity './modules/managed-identity.bicep' = {
  name: 'bootstrap-identity'
  scope: rg
  params: {
    name: bootstrapIdentityName
    location: location
    tags: tags
  }
}

module keyVault './modules/key-vault.bicep' = {
  name: 'key-vault'
  scope: rg
  params: {
    name: keyVaultName
    location: location
    tags: tags
    workspaceId: logAnalytics.outputs.id
    enableDiagnostics: enableDiagnostics
  }
}

module storage './modules/storage.bicep' = {
  name: 'storage'
  scope: rg
  params: {
    name: storageAccountName
    location: location
    tags: tags
    workspaceId: logAnalytics.outputs.id
    enableDiagnostics: enableDiagnostics
  }
}

module search './modules/search.bicep' = {
  name: 'search'
  scope: rg
  params: {
    name: searchServiceName
    location: location
    tags: tags
    workspaceId: logAnalytics.outputs.id
    enableDiagnostics: enableDiagnostics
  }
}

module registry './modules/container-registry.bicep' = {
  name: 'container-registry'
  scope: rg
  params: {
    name: containerRegistryName
    location: location
    tags: tags
    workspaceId: logAnalytics.outputs.id
    enableDiagnostics: enableDiagnostics
  }
}

module appInsights './modules/app-insights.bicep' = {
  name: 'app-insights'
  scope: rg
  params: {
    name: appInsightsName
    location: location
    tags: tags
    workspaceId: logAnalytics.outputs.id
  }
}

module managedEnvironment './modules/container-app-environment.bicep' = {
  name: 'container-app-environment'
  scope: rg
  params: {
    name: managedEnvironmentName
    location: location
    tags: tags
    workspaceName: logAnalytics.outputs.name
  }
}

module containerApp './modules/container-app.bicep' = {
  name: 'container-app'
  scope: rg
  params: {
    name: containerAppName
    location: location
    tags: tags
    managedEnvironmentId: managedEnvironment.outputs.id
    acrLoginServer: registry.outputs.loginServer
    containerImage: containerImage
    appPort: 3000
    searchEndpoint: search.outputs.endpoint
    storageAccountUrl: storage.outputs.blobEndpoint
    researchContainerName: storage.outputs.researchContainerName
    evidenceContainerName: storage.outputs.evidenceContainerName
    keyVaultUrl: keyVault.outputs.vaultUri
    appInsightsConnectionString: appInsights.outputs.connectionString
    stagingAppOrigin: stagingAppOrigin
    mcpAudience: mcpAudience
    allowedHost: '${containerAppName}.${managedEnvironment.outputs.defaultDomain}'
    enableEntraAuth: enableEntraAuth
    entraApiClientId: entraApiClientId
    entraClaudeClientId: entraClaudeClientId
  }
}

module containerJob './modules/container-app-job.bicep' = {
  name: 'container-app-job'
  scope: rg
  params: {
    name: containerJobName
    location: location
    tags: tags
    managedEnvironmentId: managedEnvironment.outputs.id
    userAssignedIdentityId: managedIdentity.outputs.id
    userAssignedIdentityClientId: managedIdentity.outputs.clientId
    acrLoginServer: registry.outputs.loginServer
    containerImage: containerImage
    searchEndpoint: search.outputs.endpoint
    storageAccountUrl: storage.outputs.blobEndpoint
    researchContainerName: storage.outputs.researchContainerName
    evidenceContainerName: storage.outputs.evidenceContainerName
    keyVaultUrl: keyVault.outputs.vaultUri
    appInsightsConnectionString: appInsights.outputs.connectionString
    stagingAppOrigin: stagingAppOrigin
    mcpAudience: mcpAudience
    syncCronExpression: syncCronExpression
    triggerType: 'Schedule'
    manageIndexSchema: false
  }
}

// Manual trigger, run once after a schema change. Same image and same code path
// as the sync; the only difference is that it is allowed to write the index
// definition and runs under the identity that carries that right.
module bootstrapJob './modules/container-app-job.bicep' = {
  name: 'container-app-job-bootstrap'
  scope: rg
  // Container Apps validates that the identity can pull the image at create
  // time, so the AcrPull assignment has to exist first. Without this the two
  // modules run in parallel and the job fails with
  // InvalidParameterValueInContainerTemplate -- which is exactly how the first
  // deployment of it failed. The recurring job does not need this: its identity
  // has held AcrPull since long before.
  dependsOn: [
    roleAssignments
  ]
  params: {
    name: bootstrapJobName
    location: location
    tags: tags
    managedEnvironmentId: managedEnvironment.outputs.id
    userAssignedIdentityId: bootstrapIdentity.outputs.id
    userAssignedIdentityClientId: bootstrapIdentity.outputs.clientId
    acrLoginServer: registry.outputs.loginServer
    containerImage: containerImage
    searchEndpoint: search.outputs.endpoint
    storageAccountUrl: storage.outputs.blobEndpoint
    researchContainerName: storage.outputs.researchContainerName
    evidenceContainerName: storage.outputs.evidenceContainerName
    keyVaultUrl: keyVault.outputs.vaultUri
    appInsightsConnectionString: appInsights.outputs.connectionString
    stagingAppOrigin: stagingAppOrigin
    mcpAudience: mcpAudience
    syncCronExpression: syncCronExpression
    triggerType: 'Manual'
    manageIndexSchema: true
  }
}

module roleAssignments './modules/role-assignments.bicep' = {
  name: 'role-assignments'
  scope: rg
  params: {
    keyVaultName: keyVault.outputs.name
    storageAccountName: storage.outputs.name
    searchServiceName: search.outputs.name
    containerRegistryName: registry.outputs.name
    deployerObjectId: deployerObjectId
    appPrincipalId: containerApp.outputs.principalId
    jobPrincipalId: managedIdentity.outputs.principalId
    bootstrapPrincipalId: bootstrapIdentity.outputs.principalId
  }
}

module budget './modules/budget.bicep' = {
  name: 'budget'
  params: {
    name: budgetName
    amount: 125
    startDate: budgetStartDate
    endDate: budgetEndDate
    contactEmails: budgetAlertEmails
  }
}

output resourceGroupName string = rg.name
output containerAppName string = containerApp.outputs.name
output containerAppFqdn string = containerApp.outputs.fqdn
output containerJobName string = containerJob.outputs.name
output bootstrapJobName string = bootstrapJob.outputs.name
output containerRegistryName string = registry.outputs.name
output keyVaultName string = keyVault.outputs.name
output searchServiceName string = search.outputs.name
output storageAccountName string = storage.outputs.name
output managedIdentityClientId string = managedIdentity.outputs.clientId
