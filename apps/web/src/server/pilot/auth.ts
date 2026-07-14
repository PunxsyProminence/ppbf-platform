import type { NextRequest } from 'next/server';

import type { PilotRole } from './contracts';
import { PILOT_SESSION_COOKIE } from './env';
import { createOpaqueToken, hashPin, hashToken, verifyPin } from './security';
import { query, queryOne } from './db';

export interface PilotPrincipal {
  accountId: string;
  role: PilotRole;
  athleteId: string | null;
  sessionToken: string;
}

interface AccountRow {
  account_id: string;
  role: PilotRole;
  athlete_id: string | null;
  pin_hash: string;
  active_flag: boolean;
}

export async function loginWithAccountIdAndPin(accountId: string, pin: string): Promise<{ principal: PilotPrincipal; token: string } | null> {
  const data = await queryOne<AccountRow>(
    'select account_id, role, athlete_id, pin_hash, active_flag from pilot.accounts where account_id = $1',
    [accountId],
  );

  if (!data?.active_flag) {
    return null;
  }

  const pinIsValid = await verifyPin(pin, data.pin_hash);
  if (!pinIsValid) {
    return null;
  }

  const token = createOpaqueToken();
  const tokenHash = hashToken(token);

  await query('insert into pilot.session_tokens (token_hash, account_id) values ($1, $2)', [tokenHash, data.account_id]);

  return {
    token,
    principal: {
      accountId: data.account_id,
      role: data.role,
      athleteId: data.athlete_id,
      sessionToken: token,
    },
  };
}

export async function resolvePrincipal(request: NextRequest): Promise<PilotPrincipal | null> {
  const token = request.cookies.get(PILOT_SESSION_COOKIE)?.value;
  if (!token) {
    return null;
  }

  const tokenHash = hashToken(token);

  const row = await queryOne<{
    account_id: string;
    role: PilotRole;
    athlete_id: string | null;
    active_flag: boolean;
  }>(
    `select a.account_id, a.role, a.athlete_id, a.active_flag
     from pilot.session_tokens st
     join pilot.accounts a on a.account_id = st.account_id
     where st.token_hash = $1 and st.revoked_at is null`,
    [tokenHash],
  );

  if (!row?.active_flag) {
    return null;
  }

  return {
    accountId: row.account_id,
    role: row.role,
    athleteId: row.athlete_id,
    sessionToken: token,
  };
}

export async function logoutWithToken(token: string): Promise<void> {
  const tokenHash = hashToken(token);

  await query('update pilot.session_tokens set revoked_at = now() where token_hash = $1 and revoked_at is null', [tokenHash]);
}

export async function revokeAllSessionsForAccount(accountId: string): Promise<void> {
  await query('update pilot.session_tokens set revoked_at = now() where account_id = $1 and revoked_at is null', [accountId]);
}

export async function resetAccountPin(accountId: string, pin: string): Promise<void> {
  const pinHash = await hashPin(pin);

  await query('update pilot.accounts set pin_hash = $1 where account_id = $2', [pinHash, accountId]);

  await revokeAllSessionsForAccount(accountId);
}

export async function createAthleteAccount(accountId: string, athleteId: string, pin: string): Promise<void> {
  const pinHash = await hashPin(pin);

  await query(
    'insert into pilot.accounts (account_id, role, athlete_id, pin_hash, active_flag) values ($1, $2, $3, $4, $5)',
    [accountId, 'athlete', athleteId, pinHash, true],
  );
}

export async function createOrRotateAdminAccount(accountId: string, pin: string): Promise<void> {
  const pinHash = await hashPin(pin);

  await query(
    `insert into pilot.accounts (account_id, role, athlete_id, pin_hash, active_flag)
     values ($1, $2, $3, $4, $5)
     on conflict (account_id) do update set
       role = excluded.role,
       athlete_id = excluded.athlete_id,
       pin_hash = excluded.pin_hash,
       active_flag = excluded.active_flag`,
    [accountId, 'admin', null, pinHash, true],
  );

  await revokeAllSessionsForAccount(accountId);
}
