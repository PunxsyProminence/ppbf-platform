/**
 * THE GYM'S OWN NAMES FOR ITS ROOMS AND CARD HEADINGS (lane W4-9, RN-1b;
 * OW27-11, OW27-40 A; Overwatch's Q-A to Q-C on #2212).
 *
 * One row per renamed name in pilot.organization_room_names (RN-1a). No row
 * means the name the app ships with (ROOM_NAME_DEFAULTS in
 * src/shared/roomNames.ts, the one list of what may be renamed).
 *
 * WHO. Reading: any signed-in member of the gym, because every member sees
 * the names (Search, the corridor, the pages from RN-2 and RN-3); the answer
 * is the gym's words for its rooms and nothing about a person. Writing: the
 * gym admin only (isOrganizationAdminRole). The route applies both;
 * setRoomName checks the role again so a second caller cannot skip it.
 *
 * THE RULES ON A NEW NAME:
 * - the key must be on the closed list;
 * - the name follows Q-C A (normalizeRoomName: trimmed, 1 to 40 characters,
 *   no line breaks or control characters); blank or null puts the default
 *   back, and the row is deleted;
 * - Q-B A: no two names in one list (the Room Map rooms, the 7 rooms, the
 *   card names) read the same, compared trimmed and case-insensitive, after
 *   the change. That covers a default too: a name may not take another room's
 *   default, and "Use the default" is refused while another room holds that
 *   default as its name. The 409 names the room that holds it.
 */

import { isOrganizationAdminRole } from './access';
import { writePilotAuditEvent } from './audit';
import type { PilotRole } from './contracts';
import { query, withTransaction } from './db';
import { ConflictError, ForbiddenError, ValidationError } from './errors';

import {
  isRoomNameKey,
  normalizeRoomName,
  ROOM_NAME_DEFAULTS,
  ROOM_NAME_KEYS,
  roomNameCompareKey,
  roomNameList,
  type RoomNameKey,
} from '@/src/shared/roomNames';

export interface RoomName {
  readonly name: string;
  /** true when the gym has not changed it (or put it back). */
  readonly is_default: boolean;
}

export type RoomNames = Readonly<Record<RoomNameKey, RoomName>>;

interface StoredRow {
  readonly name_key: string;
  readonly display_name: string;
}

/**
 * Every key with the name it shows. A stored row whose key has left the code
 * list is ignored: there is nowhere left to show it.
 */
function namesFrom(rows: readonly StoredRow[]): RoomNames {
  const stored = new Map<string, string>();
  for (const row of rows) {
    if (isRoomNameKey(row.name_key)) stored.set(row.name_key, row.display_name);
  }
  return Object.fromEntries(
    ROOM_NAME_KEYS.map((key) => {
      const name = stored.get(key);
      return [key, name === undefined ? { name: ROOM_NAME_DEFAULTS[key], is_default: true } : { name, is_default: false }];
    }),
  ) as Record<RoomNameKey, RoomName>;
}

export async function readRoomNames(organizationId: string): Promise<RoomNames> {
  const rows = await query<StoredRow>(
    'select name_key, display_name from pilot.organization_room_names where organization_id = $1',
    [organizationId],
  );
  return namesFrom(rows);
}

/**
 * Sets one name for the gym, or with a blank or null name deletes its row so
 * the default applies again ("Use the default"). The change and its audit row
 * (old and new name) commit together; the answer is every name after it.
 */
export async function setRoomName(input: {
  readonly organizationId: string;
  readonly actorAccountId: string;
  readonly actorRole: PilotRole;
  readonly nameKey: unknown;
  readonly displayName: unknown;
}): Promise<RoomNames> {
  if (!isOrganizationAdminRole(input.actorRole)) {
    throw new ForbiddenError('Forbidden: only the gym admin renames the gym\'s rooms');
  }
  if (!isRoomNameKey(input.nameKey)) {
    throw new ValidationError('Unsupported name_key: not a name the gym can change');
  }
  const key = input.nameKey;
  const normalized = normalizeRoomName(input.displayName);
  if (!normalized.ok) throw new ValidationError(normalized.error);
  const newName = normalized.name;

  return withTransaction(async (client) => {
    // Lock the gym's own row first, as tabletIdlePolicy.ts does: two admins
    // renaming two rooms to the same word at once must not both pass the
    // duplicate check below. FOR NO KEY UPDATE, so inserts elsewhere that
    // reference this gym are not held up.
    await client.query('select 1 from pilot.organizations where organization_id = $1 for no key update', [input.organizationId]);
    const before = await client.query<StoredRow>(
      `select name_key, display_name from pilot.organization_room_names
        where organization_id = $1 for update`,
      [input.organizationId],
    );
    const current = namesFrom(before.rows);
    const previous = current[key].is_default ? null : current[key].name;

    // Q-B A: the name this key will show, against every other name in its list.
    const shown = newName ?? ROOM_NAME_DEFAULTS[key];
    const list = roomNameList(key);
    const clash = ROOM_NAME_KEYS.find(
      (other) => other !== key && roomNameList(other) === list
        && roomNameCompareKey(current[other].name) === roomNameCompareKey(shown),
    );
    if (clash) {
      throw new ConflictError(
        `"${shown}" is already the name of another room in this list (${clash}). Choose a different name.`,
        'ROOM_NAME_TAKEN',
      );
    }

    if (newName === null) {
      await client.query(
        'delete from pilot.organization_room_names where organization_id = $1 and name_key = $2',
        [input.organizationId, key],
      );
    } else {
      await client.query(
        `insert into pilot.organization_room_names (organization_id, name_key, display_name, set_by_account_id, set_at)
         values ($1, $2, $3, $4, clock_timestamp())
         on conflict (organization_id, name_key) do update
           set display_name = excluded.display_name,
               set_by_account_id = excluded.set_by_account_id,
               set_at = excluded.set_at`,
        [input.organizationId, key, newName, input.actorAccountId],
      );
    }
    await writePilotAuditEvent({
      // 'update' either way (AUDIT_EVENT_TYPES has no delete); display_name null says the row went.
      event_type: 'update',
      actor_account_id: input.actorAccountId,
      actor_role: input.actorRole,
      organization_id: input.organizationId,
      entity_type: 'organization_room_name',
      entity_id: `${input.organizationId}:${key}`,
      details: { name_key: key, display_name: newName, previous_display_name: previous },
      // A gym's words for its rooms, not a person's record: nothing for SHADOW to learn from.
      shadow_mirror: false,
    }, client);

    return {
      ...current,
      [key]: newName === null ? { name: ROOM_NAME_DEFAULTS[key], is_default: true } : { name: newName, is_default: false },
    };
  });
}
