import { randomInt, randomUUID } from 'node:crypto';

import { query, queryOne, withTransaction } from './db';
import { PilotError } from './errors';
import { createOpaqueToken, hashToken } from './security';

// Gym TVs: pairing from the coach dashboard, and the TV's own device key.
//
// Columns owned by infra/azure/pilot_slice_postgres_gym_tvs_migration.sql. Nothing here issues DDL.
//
// HOW A TV GETS IN (Jason, 2026-10-06: "Pair with code (Recommended)"). A coach presses Pair a TV
// on the dashboard and names it ("Gym main", "House"). The server mints a 6-character code, shows
// it ONCE, and stores only its hash with a 5-minute expiry. Someone types the code on the TV. The
// TV endpoint redeems it: the row gets a device key (stored hashed; the plain key goes into the
// TV's httpOnly cookie and nowhere else), the code is cleared, and the TV is paired "Until
// disconnected" (Jason). A keyed read touches last_seen_at. Disconnect sets revoked_at: the row
// stays for the Paired TVs list, the key is refused from then on.
//
// WHAT THE KEY IS NOT. It is not a session and it is not an account. It opens exactly the TV read
// (S2b) and nothing else in the app, so a remote in the wrong hands reaches no athlete record.
//
// ONLY HASHES ARE STORED. A database read yields neither a code nor a key. The code's space is
// 32^6 (about a billion): small enough to brute force offline against a leaked hash, which is why
// it lives five minutes and is single use, and why the TV endpoint sits behind a per-IP budget.

export const PAIR_CODE_LENGTH = 6;
export const PAIR_CODE_LIFETIME_MS = 5 * 60 * 1000;
// No 0/O/1/I: a code is typed with a TV remote, where those four are indistinguishable at a
// distance, and a mistyped code is a failed attempt against the budget.
export const PAIR_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
// How many codes one coach may have minted in the last ten minutes. A coach pairing two TVs and
// mistyping once is three; this is a brake on a script, not on a person.
export const PAIR_CODE_MINT_LIMIT = 5;
export const PAIR_CODE_MINT_WINDOW_MS = 10 * 60 * 1000;
export const TV_NAME_MAX_LENGTH = 60;
// The TV's cookie. 400 days is the longest a browser will keep a cookie (Chrome caps Max-Age
// there), which is how "Until disconnected" is implemented: the TV stays paired until a coach
// presses Disconnect or the browser clears its cookies, and then it simply re-pairs.
export const GYM_TV_DEVICE_COOKIE = 'ppbf_gym_tv';
export const GYM_TV_DEVICE_COOKIE_MAX_AGE_SECONDS = 400 * 24 * 60 * 60;

export class GymTvError extends PilotError {
  constructor(status: number, code: string) {
    super(status, code, code);
  }
}

export interface GymTvRow {
  organization_id: string;
  tv_id: string;
  tv_name: string;
  created_by_account_id: string | null;
  created_at: string;
  pair_code_hash: string | null;
  pair_code_expires_at: string | null;
  device_key_hash: string | null;
  paired_at: string | null;
  last_seen_at: string | null;
  revoked_at: string | null;
  current_run_id: string | null;
  current_run_set_by_account_id: string | null;
}

export type GymTvStatus = 'pending' | 'expired' | 'paired' | 'disconnected';

// What the dashboard sees: the row minus every hash. The hashes never leave this module.
export interface GymTvListItem {
  tv_id: string;
  tv_name: string;
  status: GymTvStatus;
  created_by_account_id: string | null;
  created_at: string;
  pair_code_expires_at: string | null;
  paired_at: string | null;
  last_seen_at: string | null;
  revoked_at: string | null;
  current_run_id: string | null;
  current_run_set_by_account_id: string | null;
}

const LIST_COLUMNS = `tv_id, tv_name, created_by_account_id, created_at, pair_code_expires_at,
  paired_at, last_seen_at, revoked_at, current_run_id, current_run_set_by_account_id,
  (pair_code_expires_at is not null and pair_code_expires_at <= now()) as code_expired`;

function statusOf(row: { paired_at: string | null; revoked_at: string | null; code_expired: boolean }): GymTvStatus {
  if (row.revoked_at) return 'disconnected';
  if (row.paired_at) return 'paired';
  return row.code_expired ? 'expired' : 'pending';
}

export function normalizePairCode(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function isWellFormedPairCode(code: string): boolean {
  if (code.length !== PAIR_CODE_LENGTH) return false;
  for (const ch of code) {
    if (!PAIR_CODE_ALPHABET.includes(ch)) return false;
  }
  return true;
}

export function newPairCode(): string {
  let code = '';
  for (let i = 0; i < PAIR_CODE_LENGTH; i += 1) {
    code += PAIR_CODE_ALPHABET[randomInt(PAIR_CODE_ALPHABET.length)];
  }
  return code;
}

export function validateTvName(raw: unknown): string {
  if (typeof raw !== 'string') {
    throw new GymTvError(400, 'TV_NAME_REQUIRED');
  }
  const name = raw.trim();
  if (name.length === 0 || name.length > TV_NAME_MAX_LENGTH) {
    throw new GymTvError(400, 'TV_NAME_LENGTH');
  }
  return name;
}

export interface MintedPairCode {
  tv_id: string;
  tv_name: string;
  /** The plain code. Returned once, to the coach who asked; never stored. */
  code: string;
  expires_at: string;
}

// Mint a code for a new TV row. The code is returned to the caller exactly once.
//
// The mint budget is counted in the database, not in process memory, so it holds across replicas
// and restarts. Codes that were never redeemed are left in place: an expired pending row is
// harmless (its code cannot be redeemed) and the Paired TVs list shows it as expired, which is the
// honest state.
export async function mintGymTvPairCode(
  organizationId: string,
  accountId: string,
  tvNameRaw: unknown,
): Promise<MintedPairCode> {
  const tvName = validateTvName(tvNameRaw);

  const recent = await queryOne<{ n: string }>(
    `select count(*)::text as n from pilot.gym_tvs
      where organization_id = $1 and created_by_account_id = $2
        and created_at > now() - ($3::int * interval '1 millisecond')`,
    [organizationId, accountId, PAIR_CODE_MINT_WINDOW_MS],
  );
  if (Number(recent?.n ?? 0) >= PAIR_CODE_MINT_LIMIT) {
    throw new GymTvError(429, 'TV_PAIR_CODE_RATE_LIMITED');
  }

  // The code hash is unique across every gym. A collision is a one-in-a-billion insert failure,
  // so one retry with a fresh code is enough; a second failure is reported, not swallowed.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const code = newPairCode();
    const tvId = `gymtv_${Date.now()}_${randomUUID().substring(0, 8)}`;
    try {
      const row = await queryOne<{ tv_id: string; tv_name: string; pair_code_expires_at: string }>(
        `insert into pilot.gym_tvs
           (organization_id, tv_id, tv_name, created_by_account_id, pair_code_hash, pair_code_expires_at)
         values ($1, $2, $3, $4, $5, now() + ($6::int * interval '1 millisecond'))
         returning tv_id, tv_name, pair_code_expires_at`,
        [organizationId, tvId, tvName, accountId, hashToken(code), PAIR_CODE_LIFETIME_MS],
      );
      if (!row) throw new Error('gym_tvs insert returned no row');
      return { tv_id: row.tv_id, tv_name: row.tv_name, code, expires_at: row.pair_code_expires_at };
    } catch (error) {
      const sqlState = (error as { code?: unknown }).code;
      if (sqlState === '23505' && attempt === 0) continue;
      throw error;
    }
  }
  throw new Error('unreachable: pair code mint loop');
}

export async function listGymTvs(organizationId: string): Promise<GymTvListItem[]> {
  const rows = await query<GymTvListItem & { code_expired: boolean }>(
    `select ${LIST_COLUMNS} from pilot.gym_tvs
      where organization_id = $1
      order by (revoked_at is not null), coalesce(paired_at, created_at) desc, tv_id`,
    [organizationId],
  );
  return rows.map(({ code_expired, ...row }) => ({ ...row, status: statusOf({ ...row, code_expired }) }));
}

// Disconnect: the key is refused from now on and the session, if any, is taken off this TV.
// Idempotent on an already-disconnected row. A row the caller's organization does not hold is a
// 404, indistinguishable from a missing one.
export async function disconnectGymTv(organizationId: string, tvId: string): Promise<GymTvListItem> {
  const row = await queryOne<GymTvListItem & { code_expired: boolean }>(
    `update pilot.gym_tvs
        set revoked_at = coalesce(revoked_at, now()),
            current_run_id = null,
            current_run_set_by_account_id = null,
            pair_code_hash = null,
            pair_code_expires_at = null
      where organization_id = $1 and tv_id = $2
      returning ${LIST_COLUMNS}`,
    [organizationId, tvId],
  );
  if (!row) {
    throw new GymTvError(404, 'TV_NOT_FOUND');
  }
  const { code_expired, ...rest } = row;
  return { ...rest, status: statusOf({ ...rest, code_expired }) };
}

export interface RedeemedPairCode {
  /** The plain device key. Goes into the TV's cookie and nowhere else. */
  device_key: string;
  organization_id: string;
  tv_id: string;
  tv_name: string;
}

// The TV's side of pairing. One statement, under a row lock, so two TVs typing the same code in the
// same second cannot both be paired to it: the second UPDATE finds pair_code_hash already null and
// returns nothing. Wrong, expired, used and disconnected codes all return null -- the caller
// reports one failure for all of them, because telling them apart would tell a guesser which codes
// are live.
export async function redeemGymTvPairCode(rawCode: string): Promise<RedeemedPairCode | null> {
  const code = normalizePairCode(rawCode);
  if (!isWellFormedPairCode(code)) return null;
  const codeHash = hashToken(code);
  const deviceKey = createOpaqueToken();
  const deviceKeyHash = hashToken(deviceKey);

  return withTransaction(async (client) => {
    const locked = await client.query<{ organization_id: string; tv_id: string }>(
      `select organization_id, tv_id from pilot.gym_tvs
        where pair_code_hash = $1
          and pair_code_expires_at > now()
          and device_key_hash is null
          and revoked_at is null
        for update`,
      [codeHash],
    );
    if (locked.rows.length !== 1) return null;
    const { organization_id, tv_id } = locked.rows[0];

    const updated = await client.query<{ organization_id: string; tv_id: string; tv_name: string }>(
      `update pilot.gym_tvs
          set device_key_hash = $3,
              paired_at = now(),
              last_seen_at = now(),
              pair_code_hash = null,
              pair_code_expires_at = null
        where organization_id = $1 and tv_id = $2
          and pair_code_hash = $4 and device_key_hash is null and revoked_at is null
        returning organization_id, tv_id, tv_name`,
      [organization_id, tv_id, deviceKeyHash, codeHash],
    );
    if (updated.rows.length !== 1) return null;
    return { device_key: deviceKey, ...updated.rows[0] };
  });
}

export interface PairedGymTv {
  organization_id: string;
  tv_id: string;
  tv_name: string;
  current_run_id: string | null;
  current_run_set_by_account_id: string | null;
}

// Resolve a TV from its device key (S2b's reader). A disconnected TV resolves to null exactly like
// an unknown key. Touches last_seen_at in the same statement, so "when did this TV last ask" is
// never a separate write that can be forgotten.
export async function resolveGymTvByDeviceKey(deviceKey: string): Promise<PairedGymTv | null> {
  if (typeof deviceKey !== 'string' || deviceKey.length === 0) return null;
  return queryOne<PairedGymTv>(
    `update pilot.gym_tvs
        set last_seen_at = now()
      where device_key_hash = $1 and revoked_at is null
      returning organization_id, tv_id, tv_name, current_run_id, current_run_set_by_account_id`,
    [hashToken(deviceKey)],
  );
}
