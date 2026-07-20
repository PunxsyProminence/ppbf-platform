import { query } from '@/src/server/pilot/db';

export async function POST(request: Request) {
  try {
    await query(
      `UPDATE pilot.accounts 
       SET has_master_shadow_access = true 
       WHERE account_id = $1 AND role = $2;`,
      ['coach_jason', 'coach']
    );

    return Response.json({
      ok: true,
      message: 'Master shadow access enabled for Coach Jason',
    });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error('Enable shadow access error:', error);
    return Response.json(
      { error: 'Failed to enable shadow access', details: error },
      { status: 500 }
    );
  }
}
