import { query } from '@/src/server/pilot/db';
import { hashPin } from '@/src/server/pilot/security';

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { pin?: string };
    const pin = body.pin?.trim() || '1234'; // Default PIN for setup

    // Hash the PIN
    const pinHash = await hashPin(pin);

    // Create or update coach_jason as a platform_owner (highest level)
    await query(
      `INSERT INTO pilot.accounts (account_id, role, organization_id, pin_hash, active_flag, is_platform_owner)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (account_id) DO UPDATE SET
         role = $2,
         pin_hash = $4,
         active_flag = $5,
         is_platform_owner = $6,
         updated_at = now()`,
      ['coach_jason', 'platform_owner', null, pinHash, true, true]
    );

    return Response.json({
      ok: true,
      message: 'Coach Jason created as platform_owner',
      account_id: 'coach_jason',
      role: 'platform_owner',
      pin: pin,
    });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error('Setup Coach Jason error:', error);
    return Response.json(
      { error: 'Failed to setup Coach Jason', details: error },
      { status: 500 }
    );
  }
}
