import { NextResponse, type NextRequest } from 'next/server';

import { requireRole } from '@/src/server/pilot/access';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { sanitizedSqlState } from '@/src/server/pilot/db';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';
import {
  clearLabellerCredential,
  getOwnLabellerCredential,
  setOwnLabellerCredential,
} from '@/src/server/pilot/labellerCredentials';

import { requireAnnotator } from '../../calibration/annotatorGate';

export const runtime = 'nodejs';

/**
 * The labelling PIN for the shared-tablet hand-over (labellerCredentials.ts).
 *
 *   GET     whether the caller has one, and their picker name. Never the hash.
 *   PUT     the caller sets or replaces their OWN PIN and picker name.
 *   DELETE  an organization admin clears a member's PIN. They never see or
 *           choose one; the member sets a new one.
 *
 * Every verb needs an ordinary signed-in session (requirePrincipal), so the
 * PIN is set by someone who proved who they are with their full sign-in, and
 * every id written is the caller's own or, for DELETE, inside the caller's
 * own organization.
 */

// The change is committed when this runs, so a lost audit row must not turn
// it into a 500 -- the set-password route's doctrine. Never carries the PIN.
async function auditLabellerPin(event: Parameters<typeof writePilotAuditEvent>[0]): Promise<void> {
  try {
    await writePilotAuditEvent(event);
  } catch (error) {
    const rawCode = error && typeof error === 'object' && 'code' in error ? (error as { code: unknown }).code : undefined;
    const code = sanitizedSqlState(rawCode);
    console.error({ event: 'pilot-labeller-pin-audit-write-failed', ...(code ? { code } : {}) });
  }
}

// A body that is not a JSON object (unparseable, `null`, an array, a number)
// is treated as empty, so a missing field is a 400 rather than a TypeError 500.
async function readJsonObject(request: NextRequest): Promise<Record<string, unknown>> {
  const raw: unknown = await request.json().catch(() => null);
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
}

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireAnnotator(principal);
    const credential = await getOwnLabellerCredential(principal.organizationId, principal.accountId);
    return NextResponse.json({
      has_pin: credential !== null,
      display_name: credential?.display_name ?? null,
      set_at: credential?.set_at ?? null,
    });
  } catch (error) {
    return jsonError(error);
  }
}

export async function PUT(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireAnnotator(principal);
    const body = (await readJsonObject(request)) as { display_name?: unknown; pin?: unknown };

    await setOwnLabellerCredential({
      organizationId: principal.organizationId,
      accountId: principal.accountId,
      displayName: body.display_name,
      pin: body.pin,
    });

    await auditLabellerPin({
      event_type: 'update',
      actor_account_id: principal.accountId,
      actor_role: principal.role,
      organization_id: principal.organizationId,
      entity_type: 'labeller_credential',
      entity_id: principal.accountId,
      details: { action: 'set_own_labelling_pin' },
      shadow_mirror: false,
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    return jsonError(error);
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['organization_admin']);
    const body = (await readJsonObject(request)) as { account_id?: unknown };
    const accountId = typeof body.account_id === 'string' ? body.account_id.trim() : '';
    if (!accountId) {
      throw new Error('Missing account_id');
    }

    const cleared = await clearLabellerCredential({
      organizationId: principal.organizationId,
      actorAccountId: principal.accountId,
      accountId,
    });

    if (cleared) {
      await auditLabellerPin({
        event_type: 'update',
        actor_account_id: principal.accountId,
        actor_role: principal.role,
        organization_id: principal.organizationId,
        entity_type: 'labeller_credential',
        entity_id: accountId,
        details: { action: 'clear_labelling_pin' },
        shadow_mirror: false,
      });
    }

    return NextResponse.json({ ok: true, cleared });
  } catch (error) {
    return jsonError(error);
  }
}
