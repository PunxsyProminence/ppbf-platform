param name string
param location string
param tags object
param workspaceId string

resource appInsights 'Microsoft.Insights/components@2020-02-02' = {
  name: name
  location: location
  tags: tags
  kind: 'web'
  properties: {
    Application_Type: 'web'
    DisableIpMasking: false
    IngestionMode: 'LogAnalytics'
    Request_Source: 'rest'
    RetentionInDays: 30
    WorkspaceResourceId: workspaceId
    publicNetworkAccessForIngestion: 'Enabled'
    publicNetworkAccessForQuery: 'Enabled'
  }
}

output id string = appInsights.id
output name string = appInsights.name
output connectionString string = appInsights.properties.ConnectionString
