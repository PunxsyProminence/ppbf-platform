// POST /api/pilot/shadow/migrate — Run DB migrations for SHADOW system tables
// One-time idempotent setup. Safe to call repeatedly (uses IF NOT EXISTS).
// Protected: platform_owner session OR bootstrap key.
import { NextResponse, type NextRequest } from 'next/server';
import { query } from '@/src/server/pilot/db';
import { SHADOW_JOBS_MIGRATION } from '@/src/server/pilot/shadowJobQueue';
import { LEARNING_LOOP_MIGRATION } from '@/src/server/pilot/shadowLearningLoop';
import { SHADOW_UNLOCKS_MIGRATION } from '@/src/server/pilot/shadowUnlocks';

export const runtime = 'nodejs';

export async function POST(request: NextRequest): Promise<NextResponse> {
  // Auth: bootstrap key or platform_owner session
  const bootstrapKey = request.headers.get('x-bootstrap-key');
  const expectedKey = process.env.PPBF_PILOT_BOOTSTRAP_KEY;

  if (!bootstrapKey || bootstrapKey !== expectedKey) {
    try {
      const { requirePrincipal } = await import('@/src/server/pilot/http');
      const { requireRole } = await import('@/src/server/pilot/access');
      const principal = await requirePrincipal(request);
      requireRole(principal, ['platform_owner']);
    } catch {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
  }

  const results: Array<{ migration: string; status: 'ok' | 'error'; error?: string }> = [];

  const migrations = [
    { name: 'shadow_jobs + indexes', sql: SHADOW_JOBS_MIGRATION },
    { name: 'shadow_learning_events + library_review_flags', sql: LEARNING_LOOP_MIGRATION },
    { name: 'shadow_feature_thresholds + unlock_snapshots', sql: SHADOW_UNLOCKS_MIGRATION },
  ];

  for (const { name, sql } of migrations) {
    try {
      // Split on semicolons and run each statement individually
      const statements = sql
        .split(';')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);

      for (const stmt of statements) {
        await query(stmt, []);
      }
      results.push({ migration: name, status: 'ok' });
    } catch (err) {
      results.push({
        migration: name,
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const allOk = results.every((r) => r.status === 'ok');
  return NextResponse.json({ ok: allOk, results }, { status: allOk ? 200 : 207 });
}
