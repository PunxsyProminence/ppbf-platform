// The gym's resources for families, staff side (PH-11b): GET lists every one
// in any state with the active programs a resource may name; POST adds one
// (a draft, or published at once); PATCH edits, publishes or archives one.
//
// Coaches, organization admins and admins, for the whole gym; the gym, the
// writer's account and the writer's role all come from the session. The
// database judges the writer's seat; its refusal is a 403. An internal link
// must be a page parents can open (parentResourcesStaff.ts). Nothing is
// deleted: archive is the end of a resource.
//
// PATCH names the version it was made against: updated_at exactly as the GET
// (or the last write's item) returned it. A change against an older version is
// a 409 and the newer one is kept. An edit changes only the fields it sends.
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
const TEXT_FIELDS = ['title', 'summary', 'resource_type', 'destination'] as const;

async function readBody(request: NextRequest): Promise<Record<string, unknown>> {
  const body: unknown = await request.json().catch(() => null);
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ValidationError('Request body must be an object.');
  return body as Record<string, unknown>;
}

function programOf(body: Record<string, unknown>): string | null | undefined {
  const program = body.program_id;
  if (program !== undefined && program !== null && typeof program !== 'string') {
    throw new ValidationError('program_id is a program id, or null for every family.');
  }
  return program as string | null | undefined;
}

function fieldsOf(body: Record<string, unknown>): ResourceFields {
  const text = (key: string) => {
    if (typeof body[key] !== 'string') throw new ValidationError(`Missing ${key}.`);
    return body[key] as string;
  };
  return {
    title: text('title'),
    summary: text('summary'),
    resource_type: text('resource_type'),
    destination: text('destination'),
    program_id: programOf(body) ?? null,
  };
}

// Only what is sent: a field left out is kept as stored.
function changedFieldsOf(body: Record<string, unknown>): Partial<ResourceFields> {
  const changed: Partial<ResourceFields> = {};
  for (const key of TEXT_FIELDS) {
    if (body[key] === undefined) continue;
    if (typeof body[key] !== 'string') throw new ValidationError(`${key} is text.`);
    changed[key] = body[key] as string;
  }
  const program = programOf(body);
  if (program !== undefined) changed.program_id = program;
  return changed;
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
    const version = typeof body.updated_at === 'string' ? body.updated_at.trim() : '';
    if (!version) throw new ValidationError('Missing updated_at.');
    const writer = { organizationId: principal.organizationId, accountId: principal.accountId, role: principal.role };
    let item;
    if (body.action === 'edit') item = await editResource(writer, resourceId, version, changedFieldsOf(body));
    else if (body.action === 'publish') item = await setResourceState(writer, resourceId, 'published', version);
    else if (body.action === 'archive') item = await setResourceState(writer, resourceId, 'archived', version);
    else throw new ValidationError('action is edit, publish or archive.');
    return NextResponse.json({ ok: true, item });
  } catch (error) {
    return jsonError(error);
  }
}
