import { randomInt, randomUUID } from 'node:crypto';

import { query, queryOne, withTransaction } from './db';
import { PilotError } from './errors';
import { createOpaqueToken, hashToken } from './security';
import type { WallBoard, WallNameMode } from './wallDisplay';
import { loadWallBoard } from './wallDisplayDb';

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
// (readGymTvScreen, below: the live session plus the wall board) and nothing else in the app, so a
// remote in the wrong hands reaches the same screen the room already sees and no athlete record.
//
// ONLY HASHES ARE STORED. A database read yields neither a code nor a key. The code's space is
// 32^6 (about a billion): small enough to brute force offline against a leaked hash, which is why
// it lives five minutes and is single use, and why the TV endpoint sits behind a per-IP budget.
//
// WHAT A TV SHOWS (S2b). A coach running a live session with "Show on TV" on sends it to a paired
// TV: current_run_id. Jason (OD-2026-10-06-014, rulings 5-6): "TV session should be tied to coach,
// there may be two coachs running sessions at the same time", and any coach may choose any gym TV,
// one session per TV. So the run must be the caller's own, and a TV already showing ANOTHER coach's
// live session is refused (TV_IN_USE) rather than taken over -- replace-vs-refuse is not ruled,
// and the refusal is the one that cannot lose a class mid-round.
//
// "ON THE TV" IS DERIVED, NEVER TRUSTED FROM THE POINTER ALONE. current_run_id is only honoured
// while that run is in_progress AND show_on_wall. Finishing a run or switching it off the TV does
// not write to this table on purpose: a coach ending a class must never depend on the TV table
// existing in that environment. The TV read, the Paired TVs list and the in-use check all apply
// the same liveness condition (LIVE_SHOWN_RUN), so a stale pointer reads as "nothing on this TV".

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
// The TV read's budget: a fixed window with no backoff (rateLimit.ts escalates on every call,
// which would black out a screen that is supposed to ask every few seconds forever). Two buckets:
//   per address  600 a minute. The gym's TVs share one public address, and anything else on the
//                gym wifi can spend this bucket before its key is even checked (reviewer A), so it
//                is sized for a flood, not for the TVs: a TV in session mode polls every 3 s = 20.
//   per key      60 a minute, so one screen stuck in a reload loop cannot starve the others.
// The budget protects the database from load; the key protects the content.
export const GYM_TV_READ_WINDOW_MS = 60_000;
export const GYM_TV_READ_MAX_PER_ADDRESS = 600;
export const GYM_TV_READ_MAX_PER_KEY = 60;
// The cookie is scoped to the TV routes, so the key never travels with any other request.
export const GYM_TV_DEVICE_COOKIE_PATH = '/api/pilot/tv';

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
// and restarts -- and it is counted under a transaction-scoped advisory lock on (org, account), so
// five parallel requests from one script cannot each see "4 so far" and all insert (reviewer A,
// S2a-1). Codes that were never redeemed are left in place: an expired pending row is harmless
// (its code cannot be redeemed) and the Paired TVs list shows it as expired, which is the honest
// state.
export async function mintGymTvPairCode(
  organizationId: string,
  accountId: string,
  tvNameRaw: unknown,
): Promise<MintedPairCode> {
  const tvName = validateTvName(tvNameRaw);

  return withTransaction(async (client) => {
    await client.query('select pg_advisory_xact_lock(hashtext($1))', [`gym_tv_mint:${organizationId}:${accountId}`]);

    const recent = await client.query<{ n: string }>(
      `select count(*)::text as n from pilot.gym_tvs
        where organization_id = $1 and created_by_account_id = $2
          and created_at > now() - ($3::int * interval '1 millisecond')`,
      [organizationId, accountId, PAIR_CODE_MINT_WINDOW_MS],
    );
    if (Number(recent.rows[0]?.n ?? 0) >= PAIR_CODE_MINT_LIMIT) {
      throw new GymTvError(429, 'TV_PAIR_CODE_RATE_LIMITED');
    }

    // The code hash is unique across every gym. A collision is a one-in-a-billion event; one fresh
    // draw covers it, and a second collision surfaces as the unique-index error rather than being
    // swallowed.
    let code = newPairCode();
    const clash = await client.query('select 1 from pilot.gym_tvs where pair_code_hash = $1', [hashToken(code)]);
    if (clash.rows.length > 0) code = newPairCode();

    const tvId = `gymtv_${Date.now()}_${randomUUID().substring(0, 8)}`;
    const inserted = await client.query<{ tv_id: string; tv_name: string; pair_code_expires_at: string }>(
      `insert into pilot.gym_tvs
         (organization_id, tv_id, tv_name, created_by_account_id, pair_code_hash, pair_code_expires_at)
       values ($1, $2, $3, $4, $5, now() + ($6::int * interval '1 millisecond'))
       returning tv_id, tv_name, pair_code_expires_at`,
      [organizationId, tvId, tvName, accountId, hashToken(code), PAIR_CODE_LIFETIME_MS],
    );
    const row = inserted.rows[0];
    return { tv_id: row.tv_id, tv_name: row.tv_name, code, expires_at: row.pair_code_expires_at };
  });
}

// The condition under which a run pointed at by current_run_id is actually on the TV. Used, as the
// same text, by the list, the in-use check and the TV read, so the three cannot disagree. `r` is
// the run row, `t` the TV row.
const LIVE_SHOWN_RUN = `r.organization_id = t.organization_id and r.run_id = t.current_run_id
  and r.run_state = 'in_progress' and r.show_on_wall = true and r.started_at is not null`;

// The Paired TVs list reports a run on a TV only while it is live and shown (LIVE_SHOWN_RUN): a
// pointer left behind by a finished session reads as null, and so does its set_by.
export async function listGymTvs(organizationId: string): Promise<GymTvListItem[]> {
  const rows = await query<GymTvListItem & { code_expired: boolean }>(
    `select t.tv_id, t.tv_name, t.created_by_account_id, t.created_at, t.pair_code_expires_at,
            t.paired_at, t.last_seen_at, t.revoked_at,
            r.run_id as current_run_id,
            case when r.run_id is null then null else t.current_run_set_by_account_id end
              as current_run_set_by_account_id,
            (t.pair_code_expires_at is not null and t.pair_code_expires_at <= now()) as code_expired
       from pilot.gym_tvs t
       left join pilot.session_script_runs r on ${LIVE_SHOWN_RUN}
      where t.organization_id = $1
      order by (t.revoked_at is not null), coalesce(t.paired_at, t.created_at) desc, t.tv_id`,
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
//
// RE-PAIRING REVOKES THE OLD ROW. A TV that already holds a key and types a new code (it was
// renamed, or moved to another gym) gets a new row and a new key; the row its old key named is
// revoked in the same transaction, so one device never holds two live rows and the old key, which
// the TV is about to overwrite in its cookie, cannot be replayed. `previousDeviceKey` is whatever
// the TV presented; an unknown or already-revoked one revokes nothing and pairing still succeeds.
export async function redeemGymTvPairCode(
  rawCode: string,
  previousDeviceKey: string | null = null,
): Promise<RedeemedPairCode | null> {
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

    if (typeof previousDeviceKey === 'string' && previousDeviceKey.length > 0) {
      await client.query(
        `update pilot.gym_tvs
            set revoked_at = coalesce(revoked_at, now()),
                current_run_id = null,
                current_run_set_by_account_id = null
          where device_key_hash = $1 and not (organization_id = $2 and tv_id = $3)`,
        [hashToken(previousDeviceKey), organization_id, tv_id],
      );
    }
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

// Resolve a TV from its device key (the TV read's first step). A disconnected TV resolves to null
// exactly like an unknown key. Touches last_seen_at in the same statement, so "when did this TV
// last ask" is never a separate write that can be forgotten.
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

// ---------------------------------------------------------------------------------------------
// The coach side: send a live session to a TV, take it off.
// ---------------------------------------------------------------------------------------------

interface LockedTv {
  tv_id: string;
  paired: boolean;
  revoked: boolean;
  current_run_id: string | null;
}

type PoolLike = Parameters<Parameters<typeof withTransaction>[0]>[0];

async function lockGymTv(client: PoolLike, organizationId: string, tvId: string): Promise<LockedTv> {
  const locked = await client.query<LockedTv>(
    `select tv_id,
            (device_key_hash is not null) as paired,
            (revoked_at is not null) as revoked,
            current_run_id
       from pilot.gym_tvs
      where organization_id = $1 and tv_id = $2
        for update`,
    [organizationId, tvId],
  );
  if (locked.rows.length !== 1) {
    throw new GymTvError(404, 'TV_NOT_FOUND');
  }
  return locked.rows[0];
}

// Who is on this TV right now, by the same liveness condition the list and the TV read use. Null
// when the pointer is null or names a run that has ended or been switched off.
async function liveRunOnTv(
  client: PoolLike,
  organizationId: string,
  tvId: string,
): Promise<{ run_id: string; delivered_by_account_id: string } | null> {
  const live = await client.query<{ run_id: string; delivered_by_account_id: string }>(
    `select r.run_id, r.delivered_by_account_id
       from pilot.gym_tvs t
       join pilot.session_script_runs r on ${LIVE_SHOWN_RUN}
      where t.organization_id = $1 and t.tv_id = $2`,
    [organizationId, tvId],
  );
  return live.rows[0] ?? null;
}

// The same shape and the same liveness rule as the list, for one TV.
async function toListItem(client: PoolLike, organizationId: string, tvId: string): Promise<GymTvListItem> {
  const rows = await client.query<GymTvListItem & { code_expired: boolean }>(
    `select t.tv_id, t.tv_name, t.created_by_account_id, t.created_at, t.pair_code_expires_at,
            t.paired_at, t.last_seen_at, t.revoked_at,
            r.run_id as current_run_id,
            case when r.run_id is null then null else t.current_run_set_by_account_id end
              as current_run_set_by_account_id,
            (t.pair_code_expires_at is not null and t.pair_code_expires_at <= now()) as code_expired
       from pilot.gym_tvs t
       left join pilot.session_script_runs r on ${LIVE_SHOWN_RUN}
      where t.organization_id = $1 and t.tv_id = $2`,
    [organizationId, tvId],
  );
  const { code_expired, ...rest } = rows.rows[0];
  return { ...rest, status: statusOf({ ...rest, code_expired }) };
}

// Send the caller's live session to a TV.
//
// The run must be the CALLER'S OWN (delivered_by_account_id), live, and switched on with "Show on
// TV": another coach's run id gets the same 404 as a missing one, exactly as sessionScriptRuns.ts
// requireOwnLiveRun answers, so this route cannot be used to discover other coaches' run ids. The
// TV must be paired and not disconnected (pilot_gym_tvs_run_only_when_paired would refuse the
// write anyway; this names the reason). A TV already showing ANOTHER coach's live session is
// refused with TV_IN_USE; a coach may always re-send or replace their own, and a TV whose run has
// ended or been switched off is free. The TV row is locked first so two coaches sending to the
// same TV in the same instant are serialised: the second sees the first's run and is refused.
export async function sendRunToGymTv(
  organizationId: string,
  accountId: string,
  tvId: string,
  runId: string,
): Promise<GymTvListItem> {
  return withTransaction(async (client) => {
    const tv = await lockGymTv(client, organizationId, tvId);
    if (!tv.paired || tv.revoked) {
      throw new GymTvError(409, 'TV_NOT_PAIRED');
    }

    // The run row is locked too, so a finish or a "Show on TV" off that lands between this read
    // and the UPDATE below waits for this transaction instead of slipping past it (Codex review:
    // the earlier version could store a run that had just settled and answer success for a blank
    // TV). Lock order is TV then run, the same in takeRunOffGymTv, which never locks a run.
    const run = await client.query<{ delivered_by_account_id: string; run_state: string | null; show_on_wall: boolean; started_at: string | null }>(
      `select delivered_by_account_id, run_state, show_on_wall, started_at
         from pilot.session_script_runs
        where organization_id = $1 and run_id = $2
          for update`,
      [organizationId, runId],
    );
    const runRow = run.rows[0];
    if (!runRow || runRow.delivered_by_account_id !== accountId) {
      throw new GymTvError(404, 'SESSION_RUN_NOT_FOUND');
    }
    if (runRow.run_state !== 'in_progress' || !runRow.started_at) {
      throw new GymTvError(409, 'SESSION_RUN_NOT_LIVE');
    }
    if (!runRow.show_on_wall) {
      throw new GymTvError(409, 'SESSION_RUN_NOT_ON_TV');
    }

    if (tv.current_run_id && tv.current_run_id !== runId) {
      const occupant = await liveRunOnTv(client, organizationId, tvId);
      if (occupant && occupant.delivered_by_account_id !== accountId) {
        throw new GymTvError(409, 'TV_IN_USE');
      }
    }

    // The write re-states every condition it depends on, so it cannot store a pointer the reads
    // above would not have allowed, whatever happened in between.
    const updated = await client.query(
      `update pilot.gym_tvs
          set current_run_id = $3,
              current_run_set_by_account_id = $4
        where organization_id = $1 and tv_id = $2
          and device_key_hash is not null and revoked_at is null
          and exists (
            select 1 from pilot.session_script_runs r
             where r.organization_id = $1 and r.run_id = $3
               and r.delivered_by_account_id = $4
               and r.run_state = 'in_progress' and r.show_on_wall = true and r.started_at is not null
          )`,
      [organizationId, tvId, runId, accountId],
    );
    if (updated.rowCount !== 1) {
      throw new GymTvError(409, 'SESSION_RUN_NOT_LIVE');
    }
    return toListItem(client, organizationId, tvId);
  });
}

// Take the session off a TV. Idempotent on a TV showing nothing. The same in-use rule as sending:
// only the coach whose live session is on the TV may clear it; once that run has ended or been
// switched off, any staff member may clear the leftover pointer. Both columns are cleared together
// -- set_by means nothing without a run.
export async function takeRunOffGymTv(
  organizationId: string,
  accountId: string,
  tvId: string,
): Promise<GymTvListItem> {
  return withTransaction(async (client) => {
    const tv = await lockGymTv(client, organizationId, tvId);
    if (tv.current_run_id) {
      const occupant = await liveRunOnTv(client, organizationId, tvId);
      if (occupant && occupant.delivered_by_account_id !== accountId) {
        throw new GymTvError(409, 'TV_IN_USE');
      }
      await client.query(
        `update pilot.gym_tvs
            set current_run_id = null,
                current_run_set_by_account_id = null
          where organization_id = $1 and tv_id = $2`,
        [organizationId, tvId],
      );
    }
    return toListItem(client, organizationId, tvId);
  });
}

// ---------------------------------------------------------------------------------------------
// The TV side: what a paired TV may read.
// ---------------------------------------------------------------------------------------------

// THE ALLOWLIST. Every field a TV can ever receive is named here, and the projection functions
// below build the payload by picking these names one by one -- a column added to a SELECT never
// reaches the screen by accident. The tests assert the whole serialized body against these lists,
// spelled out literally there so a field added here and there together still fails.
// No person FIELD is here: no coach, no athlete, no account id, no roster, no notes (what_to_say /
// explain / watch / fix are the coach's script and stay on the coach's phone). What staff TYPE into
// a script name, block label, drill name or TV name is free text and is shown as written; that is
// an authoring matter, not something this code can police.
export const GYM_TV_BLOCK_FIELDS = [
  'block_id',
  'block_order',
  'block_label',
  'block_kind',
  'drill_name',
  'scale_level',
  'start_offset_min',
  'end_offset_min',
] as const;

export const GYM_TV_SESSION_FIELDS = [
  'run_id',
  'script_name',
  'total_minutes',
  'started_at',
  'server_time',
  'elapsed_seconds',
  'is_paused',
  'current_block',
  'next_block',
  'blocks',
] as const;

export interface GymTvSessionBlock {
  block_id: string;
  block_order: number;
  block_label: string;
  block_kind: string;
  drill_name: string | null;
  scale_level: string | null;
  start_offset_min: number;
  end_offset_min: number;
}

export interface GymTvSession {
  run_id: string;
  script_name: string;
  total_minutes: number | null;
  started_at: string;
  /** The database clock at the time of the read, so the TV can schedule against server time. */
  server_time: string;
  elapsed_seconds: number;
  is_paused: boolean;
  /**
   * seconds_to_scheduled_end counts against the PLAN's clock (the block's end offset minus the
   * run's elapsed time), not against when the coach moved to this block: a coach running behind
   * reads 0 for the rest of the block, one running ahead reads more than the block's length. The
   * run stores no per-block start, so a true per-block countdown is S4's timer, not this field;
   * S3 labels it as "scheduled".
   */
  current_block: (GymTvSessionBlock & { seconds_to_scheduled_end: number }) | null;
  next_block: GymTvSessionBlock | null;
  blocks: GymTvSessionBlock[];
}

export interface GymTvRead {
  tv: { tv_name: string };
  /** Null is "nothing on this TV": unassigned, or the run has ended or been switched off. */
  session: GymTvSession | null;
}

function pickBlock(row: Record<string, unknown>): GymTvSessionBlock {
  return {
    block_id: String(row.block_id),
    block_order: Number(row.block_order),
    block_label: String(row.block_label),
    block_kind: String(row.block_kind),
    drill_name: row.drill_name == null ? null : String(row.drill_name),
    scale_level: row.scale_level == null ? null : String(row.scale_level),
    start_offset_min: Number(row.start_offset_min),
    end_offset_min: Number(row.end_offset_min),
  };
}

function isoOf(value: unknown): string {
  return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
}

// What the TV holding this key may see. Null when the key opens nothing (unknown or disconnected:
// the caller tells the TV to pair again). Otherwise the TV's name and, only while the run pointed
// at is live and shown (LIVE_SHOWN_RUN), the session: the plan's blocks with times and drill
// names, where the coach is in it, and the server clock. The clock arithmetic is the same as
// sessionScriptRuns.ts computeElapsedSeconds, done in SQL against the database's now() (the coach's
// phone reads the app server's Date; the two clocks are milliseconds apart), and server_time is
// sent so the TV can run its own countdown between polls against that same reading.
export async function readGymTvSession(deviceKey: string): Promise<GymTvRead | null> {
  const tv = await resolveGymTvByDeviceKey(deviceKey);
  if (!tv) return null;
  return readSessionForTv(tv);
}

/**
 * The whole screen for one paired TV: the live session (readGymTvSession's shape, unchanged) and
 * the wall board with people on it. OD-2026-10-07-008 (Jason, "Paired gym TV only"): initials and
 * milestones go only to a TV paired with a code, so this is the ONLY read that serves WallBoard,
 * and the public address serves WallPublicBoard instead (wallDisplayDb.ts loadPublicWallBoard).
 *
 * The organization is the paired TV row's, never the caller's: a TV paired at one gym cannot ask
 * for another gym's board. The device key is resolved once (one last_seen_at touch per poll), and
 * the name mode is the operator's setting, applied by wallDisplay.ts exactly as before.
 */
export interface GymTvScreen extends GymTvRead {
  board: WallBoard;
}

export async function readGymTvScreen(deviceKey: string, options: { mode: WallNameMode }): Promise<GymTvScreen | null> {
  const tv = await resolveGymTvByDeviceKey(deviceKey);
  if (!tv) return null;
  const [read, board] = await Promise.all([
    readSessionForTv(tv),
    loadWallBoard({ organizationId: tv.organization_id, mode: options.mode }),
  ]);
  return { ...read, board };
}

async function readSessionForTv(tv: PairedGymTv): Promise<GymTvRead> {
  const empty: GymTvRead = { tv: { tv_name: tv.tv_name }, session: null };
  if (!tv.current_run_id) return empty;

  const run = await queryOne<Record<string, unknown>>(
    `select r.run_id, s.name as script_name, s.total_minutes, r.started_at, now() as server_time,
            r.current_block_id, r.script_id,
            (r.paused_at is not null) as is_paused,
            greatest(0,
              floor(extract(epoch from (coalesce(r.paused_at, now()) - r.started_at)))::int
              - coalesce(r.paused_seconds, 0)) as elapsed_seconds
       from pilot.gym_tvs t
       join pilot.session_script_runs r on ${LIVE_SHOWN_RUN}
       join pilot.session_scripts s on s.organization_id = r.organization_id and s.script_id = r.script_id
      where t.organization_id = $1 and t.tv_id = $2`,
    [tv.organization_id, tv.tv_id],
  );
  if (!run) return empty;

  const blockRows = await query<Record<string, unknown>>(
    `select b.block_id, b.block_order, b.block_label, b.block_kind, d.name as drill_name,
            b.scale_level, b.start_offset_min, b.end_offset_min
       from pilot.session_script_blocks b
       left join pilot.drill_library d on d.organization_id = b.organization_id and d.drill_id = b.drill_id
      where b.organization_id = $1 and b.script_id = $2
      order by b.block_order asc`,
    [tv.organization_id, String(run.script_id)],
  );
  const blocks = blockRows.map(pickBlock);
  const elapsed = Number(run.elapsed_seconds);
  const currentIndex = blocks.findIndex((b) => b.block_id === run.current_block_id);
  const current = currentIndex >= 0 ? blocks[currentIndex] : null;
  const next = currentIndex >= 0 ? blocks[currentIndex + 1] ?? null : null;

  return {
    tv: { tv_name: tv.tv_name },
    session: {
      run_id: String(run.run_id),
      script_name: String(run.script_name),
      total_minutes: run.total_minutes == null ? null : Number(run.total_minutes),
      started_at: isoOf(run.started_at),
      server_time: isoOf(run.server_time),
      elapsed_seconds: elapsed,
      is_paused: run.is_paused === true,
      current_block: current
        ? { ...current, seconds_to_scheduled_end: Math.max(0, current.end_offset_min * 60 - elapsed) }
        : null,
      next_block: next,
      blocks,
    },
  };
}

// The TV read's budget: fixed windows, no memory of failure, no escalation. In-memory and per
// instance, like wallRateLimit.ts, and for the same reason: it protects the database from load,
// not the content from disclosure -- the device key does that. Expired buckets are swept at most
// once a second, not on every call, so a flood of fresh addresses costs a map insert each and not
// a full sweep each (reviewer A).
interface ReadBucket {
  windowStart: number;
  count: number;
}
const readBuckets = new Map<string, ReadBucket>();
let lastSweepMs = 0;

function consumeBucket(key: string, max: number, nowMs: number): { allowed: boolean; retryAfterSeconds: number } {
  const bucket = readBuckets.get(key);
  if (!bucket || nowMs - bucket.windowStart >= GYM_TV_READ_WINDOW_MS) {
    readBuckets.set(key, { windowStart: nowMs, count: 1 });
    return { allowed: true, retryAfterSeconds: 0 };
  }
  bucket.count += 1;
  if (bucket.count > max) {
    const remaining = GYM_TV_READ_WINDOW_MS - (nowMs - bucket.windowStart);
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(remaining / 1000)) };
  }
  return { allowed: true, retryAfterSeconds: 0 };
}

// `address` is the client IP; `deviceKey` is the cookie's plain key, bucketed by a prefix of its
// hash (never the key itself in a map that outlives the request). An empty key gets only the
// address bucket: there is nothing to key on before pairing.
export function consumeGymTvReadBudget(
  address: string,
  deviceKey: string,
  nowMs: number = Date.now(),
): { allowed: boolean; retryAfterSeconds: number } {
  if (nowMs - lastSweepMs >= 1000) {
    lastSweepMs = nowMs;
    for (const [existing, bucket] of readBuckets) {
      if (nowMs - bucket.windowStart >= GYM_TV_READ_WINDOW_MS) readBuckets.delete(existing);
    }
  }
  const byAddress = consumeBucket(`tv_read_ip:${address}`, GYM_TV_READ_MAX_PER_ADDRESS, nowMs);
  if (!byAddress.allowed) return byAddress;
  if (deviceKey.length === 0) return byAddress;
  return consumeBucket(`tv_read_key:${hashToken(deviceKey).slice(0, 16)}`, GYM_TV_READ_MAX_PER_KEY, nowMs);
}

/** Test seam. Never called in a request path. */
export function resetGymTvReadBudget(): void {
  readBuckets.clear();
  lastSweepMs = 0;
}
