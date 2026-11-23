param name string
param location string
param tags object
param workspaceName string

resource workspace 'Microsoft.OperationalInsights/workspaces@2026-03-01' existing = {
  name: workspaceName
}

// Logs go through Azure Monitor diagnostic settings, not the retired HTTP Data
// Collector API (destination 'log-analytics' + shared key). Support for that API
// ended 2026-09-14: https://learn.microsoft.com/azure/container-apps/migrate-logs-azure-monitor
resource environment 'Microsoft.App/managedEnvironments@2026-01-01' = {
  name: name
  location: location
  tags: tags
  properties: {
    appLogsConfiguration: {
      destination: 'azure-monitor'
    }
    publicNetworkAccess: 'Enabled'
    zoneRedundant: false
  }
}

// Required with 'azure-monitor': without a diagnostic setting the logs go nowhere.
// New tables are ContainerAppConsoleLogs / ContainerAppSystemLogs (no _CL suffix,
// no column type suffixes). Old _CL data stays where it is.
resource logs 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  name: 'container-app-logs'
  scope: environment
  properties: {
    workspaceId: workspace.id
    logs: [
      {
        category: 'ContainerAppConsoleLogs'
        enabled: true
      }
      {
        category: 'ContainerAppSystemLogs'
        enabled: true
      }
    ]
  }
}

output id string = environment.id
output name string = environment.name
output defaultDomain string = environment.properties.defaultDomain
