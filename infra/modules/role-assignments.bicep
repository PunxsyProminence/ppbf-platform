param keyVaultName string
param storageAccountName string
param searchServiceName string
param containerRegistryName string
param deployerObjectId string
param appPrincipalId string
param jobPrincipalId string

// The identity that manages index *definitions*. Deliberately separate from
// jobPrincipalId: Search Service Contributor is what createOrUpdateIndex needs,
// and it also confers admin-key retrieval, so it must not land on the identity
// that runs on a schedule. Only the one-time bootstrap job carries it.
param bootstrapPrincipalId string

var acrPullRoleId = '7f951dda-4ed3-4680-a7ca-43fe172d538d'
var keyVaultSecretsOfficerRoleId = 'b86a8fe4-44ce-4948-aee5-eccb2c155cd7'
var keyVaultSecretsUserRoleId = '4633458b-17de-408a-b874-0445c86b69e6'
var storageBlobDataContributorRoleId = 'ba92f5b4-2d11-453d-a403-e96b0029c9fe'
var storageBlobDataReaderRoleId = '2a2b9908-6ea1-4ae2-8e65-a410df84e7d1'
var searchIndexDataReaderRoleId = '1407120a-92aa-4202-b7e9-c0e197c71c8f'
var searchIndexDataContributorRoleId = '8ebe5a00-799e-43f5-93ac-243d3dce84a7'
// Object management (create/update index definitions). Per Azure AI Search RBAC,
// Search Index Data Contributor grants content access only and explicitly
// "can't modify object definitions", so createOrUpdateIndex requires this.
var searchServiceContributorRoleId = '7ca78c08-252a-4471-8644-bb5ff32d4ba0'

resource keyVault 'Microsoft.KeyVault/vaults@2026-02-01' existing = {
  name: keyVaultName
}

resource storage 'Microsoft.Storage/storageAccounts@2026-04-01' existing = {
  name: storageAccountName
}

resource search 'Microsoft.Search/searchServices@2025-05-01' existing = {
  name: searchServiceName
}

resource registry 'Microsoft.ContainerRegistry/registries@2025-11-01' existing = {
  name: containerRegistryName
}

resource deployerKeyVaultOfficer 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(keyVault.id, deployerObjectId, keyVaultSecretsOfficerRoleId)
  scope: keyVault
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', keyVaultSecretsOfficerRoleId)
    principalId: deployerObjectId
    principalType: 'User'
  }
}

resource appKeyVaultUser 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(keyVault.id, appPrincipalId, keyVaultSecretsUserRoleId)
  scope: keyVault
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', keyVaultSecretsUserRoleId)
    principalId: appPrincipalId
    principalType: 'ServicePrincipal'
  }
}

resource jobKeyVaultUser 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(keyVault.id, jobPrincipalId, keyVaultSecretsUserRoleId)
  scope: keyVault
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', keyVaultSecretsUserRoleId)
    principalId: jobPrincipalId
    principalType: 'ServicePrincipal'
  }
}

resource appAcrPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(registry.id, appPrincipalId, acrPullRoleId)
  scope: registry
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', acrPullRoleId)
    principalId: appPrincipalId
    principalType: 'ServicePrincipal'
  }
}

resource jobAcrPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(registry.id, jobPrincipalId, acrPullRoleId)
  scope: registry
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', acrPullRoleId)
    principalId: jobPrincipalId
    principalType: 'ServicePrincipal'
  }
}

// The bootstrap job runs the same image, so it needs to pull it. This is the
// only role it holds outside the single search service.
resource bootstrapAcrPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(registry.id, bootstrapPrincipalId, acrPullRoleId)
  scope: registry
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', acrPullRoleId)
    principalId: bootstrapPrincipalId
    principalType: 'ServicePrincipal'
  }
}

resource appStorageReader 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(storage.id, appPrincipalId, storageBlobDataReaderRoleId)
  scope: storage
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', storageBlobDataReaderRoleId)
    principalId: appPrincipalId
    principalType: 'ServicePrincipal'
  }
}

resource jobStorageContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(storage.id, jobPrincipalId, storageBlobDataContributorRoleId)
  scope: storage
  properties: {
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      storageBlobDataContributorRoleId
    )
    principalId: jobPrincipalId
    principalType: 'ServicePrincipal'
  }
}

resource appSearchReader 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(search.id, appPrincipalId, searchIndexDataReaderRoleId)
  scope: search
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', searchIndexDataReaderRoleId)
    principalId: appPrincipalId
    principalType: 'ServicePrincipal'
  }
}

// Scoped to this one staging search service -- never the resource group or
// subscription -- so the bootstrap identity cannot reach any other resource.
resource bootstrapSearchServiceContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(search.id, bootstrapPrincipalId, searchServiceContributorRoleId)
  scope: search
  properties: {
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      searchServiceContributorRoleId
    )
    principalId: bootstrapPrincipalId
    principalType: 'ServicePrincipal'
  }
}

// The bootstrap job writes no documents; it only creates the index definition.
// It therefore gets no data-plane role at all.
resource jobSearchContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(search.id, jobPrincipalId, searchIndexDataContributorRoleId)
  scope: search
  properties: {
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      searchIndexDataContributorRoleId
    )
    principalId: jobPrincipalId
    principalType: 'ServicePrincipal'
  }
}
