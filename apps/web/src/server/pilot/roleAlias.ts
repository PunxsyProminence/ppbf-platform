import type { PilotRole } from './contracts';

/**
 * The one answer to "does this principal hold that role?". 'admin' is the
 * legacy row name for organization_admin (ORGANIZATION_ROLE_MODEL.md), so each
 * satisfies a gate that names the other.
 *
 * Both requireRole functions (access.ts and http.ts) call this. It lives in its
 * own module, with no imports but a type, so that the many tests that replace
 * access.ts with a factory mock cannot take http.ts's role check down with it.
 * http.ts used to match exactly, and a route listing ['coach', 'admin'] refused
 * the real organization_admin account (multidiscipline, competence-cohorts).
 */
export function roleEquals(actual: PilotRole, expected: PilotRole): boolean {
  if (actual === expected) {
    return true;
  }

  // Preserve compatibility while migrating legacy 'admin' rows.
  if ((actual === 'admin' && expected === 'organization_admin') || (actual === 'organization_admin' && expected === 'admin')) {
    return true;
  }

  return false;
}
