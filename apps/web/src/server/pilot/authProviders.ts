/**
 * The canonical auth_provider vocabulary. One list; SQL and TypeScript both
 * answer to it.
 *
 * WHY A SHARED LIST RATHER THAN INLINE UNIONS
 *
 * This vocabulary was declared in six independent places -- the base schema's
 * check constraint, the multiorg migration's replacement of it, and four
 * separate inline `'ppbf_local' | 'microsoft'` annotations in auth.ts, plus one
 * in staffProvisioning.ts. Adding a value meant finding all of them.
 *
 * That is precisely the shape of the bug that shipped on 2026-08-07:
 * 'shadow_research_upload_requirement' went into the TypeScript audit
 * vocabulary and the route that wrote it, but never into the database check
 * constraint. tsc was satisfied, every unit test mocked the database away, and
 * the mismatch surfaced as SQLSTATE 23514 in production -- against an endpoint
 * that had therefore never once worked.
 *
 * authProviderVocabulary.test.ts reads the real SQL files and fails if any
 * declaration drifts from this list.
 */
export const AUTH_PROVIDERS = [
  // Account ID + PIN. Athletes only -- see credentialPolicy.ts. A non-athlete
  // row carrying this provider has no working login path at all, which is what
  // made the abandoned platform-owner accounts found in production inert.
  'ppbf_local',
  // Entra ID. Administrators and board members.
  'microsoft',
  // One-time link to a real email address. Coaches, staff, volunteers, parents.
  'magic_link',
] as const;

export type AuthProvider = (typeof AUTH_PROVIDERS)[number];

export function isAuthProvider(value: unknown): value is AuthProvider {
  return typeof value === 'string' && (AUTH_PROVIDERS as readonly string[]).includes(value);
}
