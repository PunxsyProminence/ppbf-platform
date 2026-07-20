// POST /api/pilot/admin/migrate-master-shadow — Add has_master_shadow_access column
// Temporary endpoint to run the master shadow migration

import { query } from '@/src/server/pilot/db';

export async function POST(request: Request) {
  try {
    // Run the migration
    await query(
      'ALTER TABLE pilot.accounts ADD COLUMN IF NOT EXISTS has_master_shadow_access boolean NOT NULL DEFAULT false;'
    );

    return Response.json({
      ok: true,
      migration: 'has_master_shadow_access',
      result: 'Column added successfully',
    });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error('Migration error:', error);
    return Response.json(
      { error: 'Migration failed', details: error },
      { status: 500 }
    );
  }
}
