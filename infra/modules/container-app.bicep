param name string
param location string
param tags object
param managedEnvironmentId string
param acrLoginServer string
param containerImage string = 'mcr.microsoft.com/azuredocs/containerapps-helloworld:latest'
param appPort int = 3000
param searchEndpoint string
param storageAccountUrl string
param researchContainerName string
param evidenceContainerName string
param keyVaultUrl string
param appInsightsConnectionString string
param stagingAppOrigin string
param mcpAudience string
param allowedHost string
param enableEntraAuth bool = false
param entraApiClientId string = ''
param entraClaudeClientId string = ''

var placeholderImage = 'mcr.microsoft.com/azuredocs/containerapps-helloworld:latest'
var isPlaceholder = containerImage == placeholderImage
var effectivePort = isPlaceholder ? 80 : appPort

resource app 'Microsoft.App/containerApps@2026-01-01' = {
  name: name
  location: location
  tags: tags
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    environmentId: managedEnvironmentId
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        external: enableEntraAuth
        targetPort: effectivePort
        transport: 'auto'
        allowInsecure: false
        traffic: [
          {
            latestRevision: true
            weight: 100
          }
        ]
      }
      registries: isPlaceholder
        ? []
        : [
            {
              server: acrLoginServer
              identity: 'system'
            }
          ]
      secrets: isPlaceholder ? [] : []
    }
    template: {
      containers: [
        {
          name: 'research-bridge'
          image: containerImage
          env: [
            {
              name: 'PORT'
              value: string(effectivePort)
            }
            {
              name: 'NODE_ENV'
              value: 'production'
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
              name: 'MCP_REQUIRE_PLATFORM_AUTH'
              value: 'true'
            }
            {
              name: 'MCP_ALLOWED_HOSTS'
              value: 'localhost,127.0.0.1,[::1],${allowedHost}'
            }
            {
              name: 'DATA_CLASSIFICATION'
              value: 'sanitized-staging-only'
            }
          ]
          probes: isPlaceholder
            ? [
                {
                  type: 'Liveness'
                  httpGet: {
                    path: '/'
                    port: 80
                    scheme: 'HTTP'
                  }
                  initialDelaySeconds: 5
                  periodSeconds: 30
                  timeoutSeconds: 5
                  failureThreshold: 3
                }
              ]
            : [
                {
                  type: 'Liveness'
                  httpGet: {
                    path: '/health'
                    port: appPort
                    scheme: 'HTTP'
                  }
                  initialDelaySeconds: 10
                  periodSeconds: 30
                  timeoutSeconds: 5
                  failureThreshold: 3
                }
          ]
          resources: {
            cpu: json('0.25')
            memory: '0.5Gi'
          }
        }
      ]
      scale: {
        minReplicas: 0
        maxReplicas: 1
        rules: [
          {
            name: 'http'
            http: {
              metadata: {
                concurrentRequests: '10'
              }
            }
          }
        ]
      }
    }
  }
}

resource auth 'Microsoft.App/containerApps/authConfigs@2026-01-01' = if (enableEntraAuth) {
  parent: app
  name: 'current'
  properties: {
    globalValidation: {
      excludedPaths: [
        '/health'
      ]
      unauthenticatedClientAction: 'Return401'
    }
    httpSettings: {
      requireHttps: true
    }
    identityProviders: {
      azureActiveDirectory: {
        enabled: true
        login: {
          disableWWWAuthenticate: false
        }
        registration: {
          clientId: entraApiClientId
          #disable-next-line no-hardcoded-env-urls
          openIdIssuer: 'https://login.microsoftonline.com/${tenant().tenantId}/v2.0'
        }
        validation: {
          allowedAudiences: [
            mcpAudience
          ]
          defaultAuthorizationPolicy: {
            allowedApplications: [
              entraClaudeClientId
            ]
          }
        }
      }
    }
    platform: {
      enabled: true
    }
  }
}

output id string = app.id
output name string = app.name
output principalId string = app.identity.principalId
output fqdn string = enableEntraAuth ? app.properties.configuration.ingress.fqdn : ''
