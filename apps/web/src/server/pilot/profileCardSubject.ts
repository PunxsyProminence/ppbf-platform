import { getCoachDisplayName } from './achievements';
import type { PilotPrincipal } from './auth';
import { queryOne } from './db';
import type { SubjectIdentity } from './profileDb';
import { isFamilyViewer } from './profileIdentity';

/**
 * WHOSE CARD A REQUEST NAMES.
 *
 * Shared by /api/pilot/profile/card and /api/pilot/profile/card/coach-photo so
 * the two cannot drift: the coach portrait is served only for the card the
 * same parameters would have opened. This resolves a handle to an account id
 * and nothing else -- it is not a gate. Each route runs
 * assertViewerMayReachSubject and resolveRelationship on the result itself,
 * inline, where routeGateDeclaration.convention.test.ts can see them.
 *
 * Accepts account_id or athlete_id because the callers hold different handles:
 * an athlete's own surface knows its account, a coach's roster and a guardian's
 * child switcher know athlete ids. Neither means the caller's own card.
 *
 * Null is "answer 404": an athlete id with no account in this organization, or
 * a handle longer than any id the platform issues.
 */
export async function resolveCardSubjectAccountId(
  principal: PilotPrincipal,
  url: URL,
): Promise<string | null> {
  const accountIdParam = url.searchParams.get('account_id')?.trim() ?? '';
  const athleteIdParam = url.searchParams.get('athlete_id')?.trim() ?? '';

  let accountId = accountIdParam;
  if (!accountId && athleteIdParam) {
    const row = await queryOne<{ account_id: string }>(
      `select account_id from pilot.accounts
       where organization_id = $1 and athlete_id = $2`,
      [principal.organizationId, athleteIdParam],
    );
    if (!row) return null;
    accountId = row.account_id;
  }
  if (!accountId) accountId = principal.accountId;
  if (accountId.length > 128) return null;
  return accountId;
}

/**
 * The coach's name as this viewer is given it on a card.
 *
 * Staff get the card's own staff name (profileDb.staffDisplayName), as before.
 * An athlete or parent gets getCoachDisplayName, the reader every other family
 * screen uses (OD-2026-10-06-025 ruling 2): staffDisplayName returns the
 * account id when a login email yields no name, and otherwise a capitalised
 * email stem, which for a coach provisioned with an email-shaped id is most of
 * the id. getCoachDisplayName drops digits, never returns an id, and falls to
 * "Your coach".
 */
export async function coachNameForViewer(
  principal: PilotPrincipal,
  coach: SubjectIdentity,
): Promise<string> {
  if (!isFamilyViewer(principal.role)) return coach.fullName;
  return getCoachDisplayName(principal.organizationId, coach.accountId);
}

/**
 * The response every portrait leaves the platform in. One copy, so the
 * takedown-sensitive headers are the same on profile/photo/[accountId] and on
 * the card's coach-photo route.
 */
export function portraitBytesResponse(bytes: Buffer | Uint8Array, contentType: string | null): Response {
  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: {
      'Content-Type': contentType ?? 'application/octet-stream',
      'Content-Length': String(bytes.byteLength),
      // no-store, not max-age. A photograph whose release is revoked has to
      // stop being served, and a shared cache holding a child's face for an
      // hour after a guardian asked for it to come down defeats the takedown.
      'Cache-Control': 'private, no-store, max-age=0',
      // Belt and braces against a rendering context that could reinterpret
      // the bytes, and against the response being framed elsewhere.
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'Content-Disposition': 'inline',
    },
  });
}
