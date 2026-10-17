/**
 * THE GYM ADMIN SAVES THE GYM'S PROFILE (lane L31 P3, issue #1469).
 *
 * The organization admin edits their own gym's display names, website,
 * contact details, addresses and head coach on /admin/customize. This is the
 * one writer of pilot.organization_profiles after its seed. The legal name is
 * not written here: it is the gym's name of record, pilot.organizations.
 * organization_name, which the platform owner sets.
 *
 * The rules are the table's own (the organization-profiles migration), checked
 * here first so a bad value is a 400 naming the field rather than a 500 from
 * the constraint. The save and its audit row are one transaction, and the
 * store's cached row for this gym is dropped, so this instance shows the new
 * profile at once (another instance within its 60 seconds).
 */

import type { PoolClient } from 'pg';

import { writePilotAuditEvent } from './audit';
import type { PilotRole } from './contracts';
import { queryOne, withTransaction } from './db';
import { ValidationError } from './errors';
import { forgetOrganizationProfile } from './organizationProfileStore';

/** The editable fields, as the screen and the route name them. */
export const PROFILE_FIELDS = [
  ['brand', 200],
  ['short_name', 40],
  ['common_name', 200],
  ['website_url', 200],
  ['domain', 200],
  ['ein', 20],
  ['contact_email', 254],
  ['donations_email', 254],
  ['grants_email', 254],
  ['established', 20],
  ['town', 100],
  ['service_area', 300],
  ['service_area_short', 300],
  ['physical_street', 200],
  ['physical_city', 100],
  ['physical_region', 50],
  ['physical_postal_code', 20],
  ['mailing_address', 300],
  ['head_coach_name', 200],
] as const;

export type ProfileField = (typeof PROFILE_FIELDS)[number][0];
export type StoredProfileInput = Record<ProfileField, string>;

const REQUIRED: readonly ProfileField[] = ['brand', 'short_name', 'common_name', 'website_url', 'domain'];
const WEBSITE = /^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)+$/i;
const DOMAIN = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i;

/** Every field present and trimmed, the table's rules held; or a 400 naming the field. */
export function validateProfileInput(raw: unknown): StoredProfileInput {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ValidationError('profile must be a JSON object');
  }
  const body = raw as Record<string, unknown>;
  const input = {} as StoredProfileInput;
  for (const [field, limit] of PROFILE_FIELDS) {
    const value = body[field];
    if (value !== undefined && value !== null && typeof value !== 'string') {
      throw new ValidationError(`${field} must be text`);
    }
    const text = typeof value === 'string' ? value.trim() : '';
    if (REQUIRED.includes(field) && !text) throw new ValidationError(`${field} is required`);
    if (text.length > limit) throw new ValidationError(`${field} must be ${limit} characters or fewer`);
    input[field] = text;
  }
  if (!WEBSITE.test(input.website_url)) {
    throw new ValidationError('website_url must be an https address with no path, like https://www.example.org');
  }
  if (!DOMAIN.test(input.domain)) {
    throw new ValidationError('domain must be a bare host name, like example.org');
  }
  return input;
}

/** The stored row for one gym, for the edit screen: no development profile, no cache. */
export async function readStoredProfileInput(organizationId: string): Promise<StoredProfileInput | null> {
  const columns = PROFILE_FIELDS.map(([field]) => field).join(', ');
  return queryOne<StoredProfileInput>(
    `select ${columns} from pilot.organization_profiles where organization_id = $1`,
    [organizationId],
  );
}

export async function saveOrganizationProfile(
  organizationId: string,
  raw: unknown,
  actor: { accountId: string; role: PilotRole },
): Promise<StoredProfileInput> {
  const input = validateProfileInput(raw);
  const fields = PROFILE_FIELDS.map(([field]) => field);
  await withTransaction(async (client: PoolClient) => {
    await client.query(
      `insert into pilot.organization_profiles (organization_id, ${fields.join(', ')})
       values ($1, ${fields.map((_, index) => `$${index + 2}`).join(', ')})
       on conflict (organization_id) do update set
         ${fields.map((field) => `${field} = excluded.${field}`).join(',\n         ')},
         updated_at = now()`,
      [organizationId, ...fields.map((field) => input[field])],
    );
    await writePilotAuditEvent(
      {
        event_type: 'update',
        actor_account_id: actor.accountId,
        actor_role: actor.role,
        organization_id: organizationId,
        entity_type: 'organization_profile',
        entity_id: organizationId,
        details: { action: 'organization_profile_saved', profile: input },
      },
      client,
    );
  });
  forgetOrganizationProfile(organizationId);
  return input;
}
