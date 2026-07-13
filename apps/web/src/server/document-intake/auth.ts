export interface AadClientCredentials {
  tenantId: string
  clientId: string
  clientSecret: string
}

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
