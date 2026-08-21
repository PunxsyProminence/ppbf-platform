import { NextResponse, type NextRequest } from 'next/server';

import { assertActorCanAccessAthlete, isOrganizationAdminRole } from '@/src/server/pilot/access';
import {
  issueCoachCard,
  issueCoachCardToProgram,
  listCoachCards,
  type CoachCardRow,
} from '@/src/server/pilot/coachCards';
import { DRILL_DIFFICULTIES, getDrill, isDrillDifficulty } from '@/src/server/pilot/drills';
import { ValidationError } from '@/src/server/pilot/errors';
import { hiddenNotFound, jsonError, requirePrincipal, requireRole } from '@/src/server/pilot/http';

export const runtime = 'nodejs';

// Coach Cards: a coach issues work straight onto the assignment spine --
// to one athlete (individual card) or to a program's active members (group
// card). The organization is ALWAYS the principal's own; nothing in the
// body can name another gym.

interface CardBody {
  athlete_id?: string;
  program_id?: string;
  title?: string;
  description?: string;
  drill_id?: string;
  drill_difficulty?: string;
  rep_count?: number;
  duration_minutes?: number;
  frequency_per_week?: number;
  due_date?: string;
}

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['coach', 'admin', 'organization_admin']);

    const body = (await request.json()) as CardBody;

    const athleteId = body.athlete_id?.trim() || null;
    const programId = body.program_id?.trim() || null;
    // Exactly one target. Both is ambiguous (which set of athletes did the
    // coach mean?), neither is no card at all -- refused before any read.
    if ((athleteId === null) === (programId === null)) {
      throw new ValidationError('Provide exactly one of athlete_id or program_id.');
    }

    // Same content rule as the assignments route: a card either anchors to
    // a library drill or carries typed title and description -- either way
    // the athlete sees complete work, never an empty shell.
    const drillId = body.drill_id?.trim() || null;
    const typedTitle = body.title?.trim() || '';
    const typedDescription = body.description?.trim() || '';
    if (!drillId && (!typedTitle || !typedDescription)) {
      throw new ValidationError('Missing required fields: drill_id, or title and description.');
    }

    if (body.drill_difficulty !== undefined && !isDrillDifficulty(body.drill_difficulty)) {
      throw new ValidationError(`Unsupported drill_difficulty: one of ${DRILL_DIFFICULTIES.join(', ')}`);
    }

    // Another gym's drill_id must read as absent rather than as a drill the
    // caller may not touch, and a retired drill is not silently revived --
    // both verbatim from the assignments route.
    const drill = drillId ? await getDrill(principal.organizationId, drillId) : null;
    if (drillId && !drill) {
      return hiddenNotFound();
    }
    if (drill && !drill.active) {
      throw new ValidationError('Unsupported drill_id: that drill is retired');
    }

    const content = {
      drillId,
      // What the coach typed wins over the drill's own wording -- the typed
      // text is the record of what was issued.
      drillName: typedTitle || (drill ? drill.name : ''),
      drillDescription: typedDescription || (drill ? drill.focus : ''),
      drillDifficulty: body.drill_difficulty || (drill ? drill.difficulty : 'intermediate'),
      repCount: body.rep_count,
      durationMinutes: body.duration_minutes,
      frequencyPerWeek: body.frequency_per_week,
      dueDate: body.due_date,
    };

    if (athleteId) {
      // "Doesn't exist" and "exists but off this coach's roster" collapse to
      // the same 404, so this endpoint cannot be used to probe which athlete
      // ids are real.
      try {
        await assertActorCanAccessAthlete(principal, athleteId);
      } catch {
        return hiddenNotFound();
      }

      const card = await issueCoachCard({
        organizationId: principal.organizationId,
        athleteId,
        assignedByAccountId: principal.accountId,
        ...content,
      });
      return NextResponse.json(card, { status: 201 });
    }

    // Group card. Per-member authorization happens inside the module via
    // accessibleAthleteIds; a cross-org program_id resolves to null and is
    // cloaked exactly like an unknown one.
    const result = await issueCoachCardToProgram({
      actor: principal,
      programId: programId as string,
      ...content,
    });
    if (!result) {
      return hiddenNotFound();
    }

    // The issued/skipped split is the report the UI shows verbatim -- a
    // group card that reached 9 of 11 members must say so, not imply 11.
    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    return jsonError(error);
  }
}

/** One issuance as the GET response groups it: a group card's rows together, an individual card alone. */
interface IssuanceGroup {
  issuance_id: string | null;
  assigned_at: string;
  cards: CoachCardRow[];
}

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['coach', 'admin', 'organization_admin']);

    // A coach reads the cards they issued; an admin reads every card in the
    // organization. Both reads are inside principal.organizationId only.
    const issuer = isOrganizationAdminRole(principal.role) ? null : principal.accountId;
    const rows = await listCoachCards(principal.organizationId, issuer);

    // Group by issuance: rows sharing an issuance_id were one act of
    // issuing; an individual card (issuance_id null) stands alone. Insertion
    // order follows the rows' assigned_at desc ordering, so groups list
    // newest first.
    const groups = new Map<string, IssuanceGroup>();
    for (const row of rows) {
      const key = row.issuance_id ?? `single:${row.assignment_id}`;
      const existing = groups.get(key);
      if (existing) {
        existing.cards.push(row);
      } else {
        groups.set(key, { issuance_id: row.issuance_id, assigned_at: row.assigned_at, cards: [row] });
      }
    }

    return NextResponse.json({ items: Array.from(groups.values()) });
  } catch (error) {
    return jsonError(error);
  }
}
