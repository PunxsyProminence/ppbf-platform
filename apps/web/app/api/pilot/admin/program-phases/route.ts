import { NextResponse, type NextRequest } from 'next/server';

import { requireRole } from '@/src/server/pilot/access';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import type { PilotPrincipal } from '@/src/server/pilot/auth';
import { ValidationError } from '@/src/server/pilot/errors';
import { hiddenNotFound, jsonError, requirePrincipal } from '@/src/server/pilot/http';
import { endPhase, listPhases, startPhase } from '@/src/server/pilot/programPhases';

export const runtime = 'nodejs';

// Program phases (module 129). Staff read; admin declares. A phase is
// program-level context stated by a human -- it changes nothing about any
// athlete, and nothing here computes or recommends a phase.

const PHASE_READ_ROLES = ['coach', 'organization_admin', 'admin'] as const;
const PHASE_WRITE_ROLES = ['organization_admin', 'admin'] as const;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function requireDate(value: unknown, field: string): string {
  if (typeof value !== 'string' || !ISO_DATE.test(value.trim())) {
    throw new ValidationError(`${field} must be a date (YYYY-MM-DD).`);
  }
  return value.trim();
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new ValidationError(`Missing ${field}.`);
  return value.trim();
}

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...PHASE_READ_ROLES]);

    const programName = request.nextUrl.searchParams.get('program_name')?.trim() || undefined;
    const items = await listPhases(principal.organizationId, programName);
    return NextResponse.json({ items });
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...PHASE_WRITE_ROLES]);

    const body = (await request.json()) as Record<string, unknown>;
    const item = await startPhase({
      organizationId: principal.organizationId,
      programName: requireText(body.program_name, 'program_name'),
      phaseName: requireText(body.phase_name, 'phase_name'),
      focus: typeof body.focus === 'string' ? body.focus : undefined,
      startedOn: requireDate(body.started_on, 'started_on'),
      notes: typeof body.notes === 'string' ? body.notes : undefined,
      createdByAccountId: principal.accountId,
    });
    // null means the requested start would predate the open phase it
    // replaces -- a timeline cannot run backwards.
    if (!item) {
      throw new ValidationError('A new phase must start after the current phase began.');
    }

    await audit(principal, item.phase_id, {
      action: 'start_phase', program_name: item.program_name, phase_name: item.phase_name, started_on: item.started_on,
    });
    return NextResponse.json({ item });
  } catch (error) {
    return jsonError(error);
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...PHASE_WRITE_ROLES]);

    const body = (await request.json()) as Record<string, unknown>;
    const item = await endPhase({
      organizationId: principal.organizationId,
      phaseId: requireText(body.phase_id, 'phase_id'),
      endedOn: requireDate(body.ended_on, 'ended_on'),
    });
    if (!item) return hiddenNotFound();

    await audit(principal, item.phase_id, {
      action: 'end_phase', program_name: item.program_name, ended_on: item.ended_on,
    });
    return NextResponse.json({ item });
  } catch (error) {
    return jsonError(error);
  }
}

async function audit(principal: PilotPrincipal, phaseId: string, details: Record<string, unknown>) {
  await writePilotAuditEvent({
    event_type: 'update',
    actor_account_id: principal.accountId,
    actor_role: principal.role,
    organization_id: principal.organizationId,
    entity_type: 'program_phase',
    entity_id: phaseId,
    details,
  });
}
