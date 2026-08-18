export interface AadClientCredentials {
  tenantId: string
  clientId: string
  clientSecret: string
}

// Backs both writeDataverseRecord and uploadToSharePoint's token fetch. Not
// bounding it left a stall on login.microsoftonline.com hang the whole
// intake ingest chain indefinitely; 10s is generous for a token endpoint.
const AAD_TOKEN_TIMEOUT_MS = 10_000

export async function getClientCredentialToken(
  credentials: AadClientCredentials,
  scope: string,
): Promise<string> {
  const tokenUrl = `https://login.microsoftonline.com/${credentials.tenantId}/oauth2/v2.0/token`

  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: credentials.clientId,
    client_secret: credentials.clientSecret,
    scope,
  })

  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(AAD_TOKEN_TIMEOUT_MS),
  })

  if (!response.ok) {
    const detail = await response.text()
    throw new Error(`Token request failed (${response.status}): ${detail}`)
  }

  const payload = (await response.json()) as { access_token?: string }

  if (!payload.access_token) {
    throw new Error('Token response was missing access_token')
  }

  return payload.access_token
}
