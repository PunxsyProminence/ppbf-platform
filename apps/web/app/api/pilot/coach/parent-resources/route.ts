// The gym's resources for families, staff side (PH-11b): GET lists every one
// in any state with the active programs a resource may name; POST adds one
// (a draft, or published at once); PATCH edits, publishes or archives one.
//
// Coaches, organization admins and admins, for the whole gym; the gym, the
// writer's account and the writer's role all come from the session. The
// database judges the writer's seat; its refusal is a 403. An internal link
// must be a page parents can open (parentResourcesStaff.ts). Nothing is
// deleted: archive is the end of a resource.
import { NextResponse, type NextRequest } from 'next/server';

import { ValidationError } from '@/src/server/pilot/errors';
import { jsonError, requirePrincipal, requireRole } from '@/src/server/pilot/http';
import {
  createResource,
  editResource,
  listResourcesForStaff,
  setResourceState,
  type ResourceFields,
} from '@/src/server/pilot/parentResourcesStaff';

export const runtime = 'nodejs';

const RESOURCE_WRITER_ROLES = ['coach', 'organization_admin', 'admin'] as const;

async function readBody(request: NextRequest): Promise<Record<string, unknown>> {
  const body: unknown = await request.json().catch(() => null);
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ValidationError('Request body must be an object.');
  return body as Record<string, unknown>;
}

function fieldsOf(body: Record<string, unknown>): ResourceFields {
  const text = (key: string) => {
    if (typeof body[key] !== 'string') throw new ValidationError(`Missing ${key}.`);
    return body[key] as string;
  };
  const program = body.program_id;
  if (program !== undefined && program !== null && typeof program !== 'string') {
    throw new ValidationError('program_id is a program id, or null for every family.');
  }
  return {
    title: text('title'),
    summary: text('summary'),
    resource_type: text('resource_type'),
    destination: text('destination'),
    program_id: (program as string | null | undefined) ?? null,
  };
}

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...RESOURCE_WRITER_ROLES]);
    return NextResponse.json({ ok: true, ...(await listResourcesForStaff(principal.organizationId)) });
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...RESOURCE_WRITER_ROLES]);
    const body = await readBody(request);
    const writer = { organizationId: principal.organizationId, accountId: principal.accountId, role: principal.role };
    const item = await createResource(writer, fieldsOf(body), body.publish === true);
    return NextResponse.json({ ok: true, item });
  } catch (error) {
    return jsonError(error);
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...RESOURCE_WRITER_ROLES]);
    const body = await readBody(request);
    const resourceId = typeof body.resource_id === 'string' ? body.resource_id.trim() : '';
    if (!resourceId) throw new ValidationError('Missing resource_id.');
    const writer = { organizationId: principal.organizationId, accountId: principal.accountId, role: principal.role };
    let item;
    if (body.action === 'edit') item = await editResource(writer, resourceId, fieldsOf(body));
    else if (body.action === 'publish') item = await setResourceState(writer, resourceId, 'published');
    else if (body.action === 'archive') item = await setResourceState(writer, resourceId, 'archived');
    else throw new ValidationError('action is edit, publish or archive.');
    return NextResponse.json({ ok: true, item });
  } catch (error) {
    return jsonError(error);
  }
}
