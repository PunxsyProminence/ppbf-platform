type ShadowLogoutResponse = {
  ok: boolean;
  status: number;
};

type ShadowLogoutFetch = (
  input: string,
  init: RequestInit,
) => Promise<ShadowLogoutResponse>;

export async function revokeShadowSession(
  apiBaseUrl: string,
  fetchImpl: ShadowLogoutFetch = fetch,
): Promise<void> {
  const normalizedBaseUrl = apiBaseUrl.replace(/\/$/, '');
  const response = await fetchImpl(
    `${normalizedBaseUrl}/api/pilot/auth/logout`,
    {
      method: 'POST',
      credentials: 'include',
    },
  );

  if (!response.ok) {
    throw new Error(`shadow_logout_failed_${response.status}`);
  }
}
