import { NextResponse, type NextRequest } from 'next/server';

import { requireRole } from '@/src/server/pilot/access';
import { query } from '@/src/server/pilot/db';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';

export const runtime = 'nodejs';

// A coach's view of the org-wide audit trace is an ALLOW-list, not a
// deny-list. This route shipped excluding exactly one type (training_hold),
// and the 2026-08-25 audit found the rot that shape guarantees: by then
// parent_barrier_report, guardian_media_consent, guardian_link,
// athlete_check_in, intake_case and intake_document had all joined the
// vocabulary, and any coach could enumerate them org-wide for children they
// never coach. A deny-list must be re-curated every time a writer adds a
// type; this list fails CLOSED instead -- a new entity type is invisible to
// coaches until someone deliberately adds it here, under review.
//
// What belongs here: training-floor operational records. What never does:
// guardian/consent, intake, medical, account/credential, payment, platform,
// board, or safety-scoped types -- each of those has a dedicated route whose
// own gate decides what a coach may see of it (training-holds/route.ts is
// the model), and this general-purpose reader must not become the back door
// around any of them.
const COACH_ALLOWED_ENTITY_TYPES = new Set([
  'announcement',
  'athlete_milestone',
  'athlete_program',
  'behavior_standard',
  'coach_coverage',
  'coach_note',
  'coach_review',
  'drill',
  'external_competition_entry',
  'floor_plan',
  'goal',
  'intervention_evidence_link',
  'intervention_execution',
  'intervention_outcome_review',
  'intervention_protocol',
  'mentorship',
  'one_percent_nomination',
  'program_phase',
  'rabbit_hole',
  'recognition',
  'scheduler_coaching_request',
  'session',
  'video_session',
  'wrestling_league_roster_entry',
]);

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['organization_admin', 'coach']);

    const body = (await request.json()) as {
      entity_type?: string;
      entity_id?: string;
      limit?: number;
    };

    const entityType = body.entity_type?.trim() || null;
    if (principal.role === 'coach' && entityType && !COACH_ALLOWED_ENTITY_TYPES.has(entityType)) {
      throw new Error('Forbidden: role not allowed to read this entity type');
    }

    const limit = Math.max(1, Math.min(100, Number(body.limit ?? 20)));

    const rows = await query(
      `select *
       from pilot.audit_events
       where organization_id = $1
         and ($2::text is null or entity_type = $2)
         and ($3::text is null or entity_id = $3)
         and ($5::boolean is not true or entity_type = any($4::text[]))
       order by created_at desc
       limit $6`,
      [
        principal.organizationId,
        entityType,
        body.entity_id?.trim() || null,
        [...COACH_ALLOWED_ENTITY_TYPES],
        principal.role === 'coach',
        limit,
      ],
    );

    return NextResponse.json({ ok: true, events: rows });
  } catch (error) {
    return jsonError(error);
  }
}
