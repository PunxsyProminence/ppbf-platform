/**
 * Which Library shelf a curator or reviewer request works on.
 *
 * There are two shelves. The gym shelf is the caller's own organization. The
 * platform shelf is the reserved organization every gym reads
 * (platformLibraryScope.ts). Owner rulings:
 *
 * - OD-2026-10-02-013 answer 1B: the platform owner writes the platform shelf
 *   in the app, and answer 3: platform material on the platform shelf, gym
 *   material on the gym shelf.
 * - OD-2026-10-02-015 D3: the platform owner no longer writes a gym's shelf.
 *
 * The shelf is named by the request ('gym' or 'platform') and resolved to an
 * organization id HERE, on the server. No organization id is ever taken from a
 * request: a gym caller can only reach its own organization, and the platform
 * shelf resolves to a constant. This is the one place an authenticated request
 * can be pointed at the reserved organization, so the route files never name it
 * (platformLibraryWriteScope.convention.test.ts).
 *
 * A request that names no shelf is a gym-shelf request, which is every request
 * that existed before this module. For every role but the platform owner it
 * behaves exactly as it did.
 */

import type { PilotPrincipal } from './auth';
import { ForbiddenError, ValidationError } from './errors';
import { PLATFORM_LIBRARY_ORGANIZATION_ID } from './platformLibraryScope';

export type LibraryShelf = 'gym' | 'platform';

/**
 * What the request does on the shelf. Only 'write' (register or change a
 * source, document or chunk) is barred to the platform owner on the gym shelf
 * by D3. Reading a gym's Library and approving on /evidence stay as they were:
 * OD-2026-10-02-013 answer 5A keeps approval "as today", platform owner
 * included.
 */
export type LibraryShelfAccess = 'read' | 'write' | 'review';

/** Absent means the gym shelf; anything other than the two names is refused. */
export function parseLibraryShelf(value: unknown): LibraryShelf {
  if (value === undefined || value === null) return 'gym';
  if (value === 'gym' || value === 'platform') return value;
  throw new ValidationError("shelf must be 'gym' or 'platform'");
}

/**
 * The organization id a Library request works on.
 *
 * - platform shelf: platform_owner only, for every access; everyone else 403.
 * - gym shelf: the principal's own organization. A platform_owner WRITE is
 *   refused (D3); its reads and reviews are unchanged.
 */
export function resolveLibraryShelf(
  principal: Pick<PilotPrincipal, 'role' | 'organizationId'>,
  requested: unknown,
  access: LibraryShelfAccess,
): string {
  const shelf = parseLibraryShelf(requested);

  if (shelf === 'platform') {
    if (principal.role !== 'platform_owner') {
      throw new ForbiddenError('Only the platform owner works on the platform shelf', 'LIBRARY_PLATFORM_SHELF_FORBIDDEN');
    }
    return PLATFORM_LIBRARY_ORGANIZATION_ID;
  }

  if (access === 'write' && principal.role === 'platform_owner') {
    throw new ForbiddenError(
      "The platform owner writes the platform shelf; a gym's shelf is written by that gym's admin",
      'LIBRARY_GYM_SHELF_PLATFORM_OWNER_WRITE_FORBIDDEN',
    );
  }

  return principal.organizationId;
}
