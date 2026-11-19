import { apiBase } from '@/lib/apiBase';

/**
 * Ends the session in this browser's cookie, and says whether it is gone
 * (lane U1, AS2-b: the gym tablet's idle sign-out WAITS for this answer).
 *
 * The session cookie is HttpOnly, so script cannot clear it: only the logout
 * route's response can. A sign-out that did not reach the server leaves the
 * session alive on the device, and /login would then send the next person
 * straight back into it. So a failed request is reported as not done, never
 * assumed done.
 *
 * 401 counts as done: the route found no session to end (it had already
 * expired or been revoked elsewhere), which is the state this was asked for.
 * keepalive lets the request finish if the page is unloading.
 */
export async function endThisSession(fetcher: typeof fetch = fetch): Promise<boolean> {
  try {
    const response = await fetcher(`${apiBase()}/api/pilot/auth/logout`, {
      method: 'POST',
      credentials: 'include',
      keepalive: true,
    });
    return response.ok || response.status === 401;
  } catch {
    return false;
  }
}

/**
 * A full document load of /login, not a router move: nothing of the last
 * person's page stays in memory. replace, so Back does not return to it.
 */
export function leaveForLogin(): void {
  window.location.replace('/login');
}
