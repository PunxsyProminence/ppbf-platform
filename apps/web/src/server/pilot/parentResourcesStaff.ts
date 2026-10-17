/*
 * PARENT RESOURCES, the staff side (PH-11b): list, add, edit, publish and
 * archive the gym's resources for families (pilot.parent_resources, PH-10).
 *
 * Writers are coaches, organization admins and admins (PH-10 Q1 A, Q-E A),
 * for the whole gym; the gym comes from the session. Every write carries the
 * caller's own account and session role, and the database judges that seat
 * (an active membership with that role, on a live account): its refusal
 * (pilot_parent_resources_writer_of_this_gym) is a 403 here, never a guess
 * made in advance.
 *
 * A link a parent can open (PH-11 Q-A A): an internal path must be a page the
 * building map lists for parents (parentMayOpenPath), the same check the
 * family read applies; anything else is refused before it is written. A row
 * already stored whose page parents can no longer open is marked, because the
 * family read leaves it out.
 *
 * Every family, or one of this gym's active programs (Q1 B). Nothing is
 * deleted: a resource is archived, and can be published again; the database
 * keeps the first publication time through both.
 */
import { query, queryOne } from './db';
import { STAFF_AUTHOR_NAME_FLOOR, getStaffAuthorName } from './achievements';
import { ForbiddenError, NotFoundError, ValidationError } from './errors';
import { parentMayOpenPath } from './parentResources';

export const RESOURCE_TYPES = ['guide', 'checklist', 'video', 'policy'] as const;
export type ResourceType = (typeof RESOURCE_TYPES)[number];
export type ResourceState = 'draft' | 'published' | 'archived';

export interface StaffParentResource {
  resource_id: string;
  title: string;
  summary: string;
  resource_type: ResourceType;
  destination_kind: 'internal' | 'external';
  destination: string;
  program_id: string | null;
  program_name: string | null;
  state: ResourceState;
  published_at: string | null;
  updated_at: string;
  written_by: string;
  edited_by: string | null;
  /** An internal page the building map does not list for parents: the family read leaves it out. */
  parents_cannot_open: boolean;
}

export interface ResourceFields {
  title: string;
  summary: string;
  resource_type: string;
  destination: string;
  program_id: string | null;
}

export interface Writer {
  organizationId: string;
  accountId: string;
  role: string;
}

// The same host rule as PH-10's destination check, so a link is refused here
// in words rather than by the database.
const HTTPS_LINK = /^https:\/\/([A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?\.)+[A-Za-z]{2,63}(:[0-9]{1,5})?(\/|$)/;

interface StoredRow {
  resource_id: string;
  title: string;
  summary: string;
  resource_type: ResourceType;
  destination_kind: 'internal' | 'external';
  destination: string;
  program_id: string | null;
  program_name: string | null;
  state: ResourceState;
  published_at: string | null;
  updated_at: string;
  created_by_account_id: string | null;
  created_by_role: string;
  updated_by_account_id: string | null;
  updated_by_role: string | null;
}

const SELECT = `select r.resource_id::text as resource_id, r.title, r.summary, r.resource_type, r.destination_kind,
         r.destination, r.program_id, p.program_name, r.state, r.published_at, r.updated_at,
         r.created_by_account_id, r.created_by_role, r.updated_by_account_id, r.updated_by_role
    from pilot.parent_resources r
    left join pilot.programs p on p.organization_id = r.organization_id and p.program_id = r.program_id
   where r.organization_id = $1`;

async function present(organizationId: string, row: StoredRow): Promise<StaffParentResource> {
  const name = (accountId: string | null, role: string | null) =>
    accountId && role ? getStaffAuthorName(organizationId, accountId, role) : Promise.resolve(null);
  const {
    created_by_account_id: createdBy, created_by_role: createdRole,
    updated_by_account_id: updatedBy, updated_by_role: updatedRole, ...shown
  } = row;
  return {
    ...shown,
    written_by: (await name(createdBy, createdRole)) ?? STAFF_AUTHOR_NAME_FLOOR,
    edited_by: await name(updatedBy, updatedRole),
    parents_cannot_open: row.destination_kind === 'internal' && !parentMayOpenPath(row.destination),
  };
}

/** Every resource of the gym, in any state, newest change first; and the programs a new one may name. */
export async function listResourcesForStaff(organizationId: string): Promise<{
  items: StaffParentResource[];
  programs: { program_id: string; program_name: string }[];
}> {
  const rows = await query<StoredRow>(`${SELECT} order by r.updated_at desc, r.resource_id`, [organizationId]);
  const items: StaffParentResource[] = [];
  for (const row of rows) items.push(await present(organizationId, row));
  const programs = await query<{ program_id: string; program_name: string }>(
    `select program_id, program_name from pilot.programs
      where organization_id = $1 and status = 'active' order by program_name`,
    [organizationId],
  );
  return { items, programs };
}

async function checkedFields(organizationId: string, input: ResourceFields, keptProgramId?: string | null) {
  const title = input.title.trim();
  const summary = input.summary.trim();
  const destination = input.destination.trim();
  if (title.length < 1 || title.length > 200) throw new ValidationError('A title is 1 to 200 characters.');
  if (summary.length < 1 || summary.length > 1000) throw new ValidationError('A summary is 1 to 1000 characters.');
  if (!(RESOURCE_TYPES as readonly string[]).includes(input.resource_type)) {
    throw new ValidationError('The type is guide, checklist, video or policy.');
  }
  let destinationKind: 'internal' | 'external';
  if (destination.startsWith('https://')) {
    if (destination.length > 2000 || /[\s\\]/.test(destination) || !HTTPS_LINK.test(destination)) {
      throw new ValidationError('That link is not a full https address.');
    }
    destinationKind = 'external';
  } else if (destination.startsWith('/')) {
    if (!parentMayOpenPath(destination)) {
      throw new ValidationError('Parents cannot open that page in the app. Link a parent page or an https address.');
    }
    destinationKind = 'internal';
  } else {
    throw new ValidationError('The link is an app page starting with / or an https address.');
  }
  const programId = input.program_id?.trim() || null;
  // A program kept as it was is not judged again; a new one must be this gym's and active.
  if (programId !== null && programId !== keptProgramId) {
    const program = await queryOne<{ program_id: string }>(
      `select program_id from pilot.programs where organization_id = $1 and program_id = $2 and status = 'active'`,
      [organizationId, programId],
    );
    if (!program) throw new ValidationError("That program is not one of this gym's active programs.");
  }
  return { title, summary, resourceType: input.resource_type, destinationKind, destination, programId };
}

// The database's own refusals, in words. Its seat check is the authority on
// who may write; a value it refuses that the checks above missed is a 400.
function rethrowWrite(error: unknown): never {
  const { code, constraint } = (typeof error === 'object' && error !== null ? error : {}) as { code?: unknown; constraint?: unknown };
  if (code === '23514' && constraint === 'pilot_parent_resources_writer_of_this_gym') {
    throw new ForbiddenError('Forbidden: your seat at this gym does not allow writing parent resources.');
  }
  if (code === '23514' || code === '23503') throw new ValidationError('That resource is outside the limits the gym keeps.');
  throw error;
}

async function readOne(organizationId: string, resourceId: string): Promise<StoredRow> {
  const row = /^[0-9a-f-]{36}$/i.test(resourceId)
    ? await queryOne<StoredRow>(`${SELECT} and r.resource_id = $2::uuid`, [organizationId, resourceId])
    : null;
  if (!row) throw new NotFoundError('Not found: that resource is not in this gym.');
  return row;
}

export async function createResource(writer: Writer, input: ResourceFields, publish: boolean): Promise<StaffParentResource> {
  const fields = await checkedFields(writer.organizationId, input);
  let id: { resource_id: string } | null;
  try {
    id = await queryOne<{ resource_id: string }>(
      `insert into pilot.parent_resources
         (organization_id, title, summary, resource_type, destination_kind, destination, program_id, state, published_at,
          created_by_account_id, created_by_role)
       values ($1, $2, $3, $4, $5, $6, $7, $8, case when $8 = 'published' then now() end, $9, $10)
       returning resource_id::text as resource_id`,
      [writer.organizationId, fields.title, fields.summary, fields.resourceType, fields.destinationKind, fields.destination,
        fields.programId, publish ? 'published' : 'draft', writer.accountId, writer.role],
    );
  } catch (error) {
    rethrowWrite(error);
  }
  return present(writer.organizationId, await readOne(writer.organizationId, id!.resource_id));
}

export async function editResource(writer: Writer, resourceId: string, input: ResourceFields): Promise<StaffParentResource> {
  const current = await readOne(writer.organizationId, resourceId);
  const fields = await checkedFields(writer.organizationId, input, current.program_id);
  return write(writer, resourceId,
    `title = $3, summary = $4, resource_type = $5, destination_kind = $6, destination = $7, program_id = $8`,
    [fields.title, fields.summary, fields.resourceType, fields.destinationKind, fields.destination, fields.programId]);
}

/** Publish (first time, or again after archiving) or archive. The first publication time is the database's and is kept. */
export async function setResourceState(writer: Writer, resourceId: string, state: 'published' | 'archived'): Promise<StaffParentResource> {
  const current = await readOne(writer.organizationId, resourceId);
  if (state === 'published' && current.destination_kind === 'internal' && !parentMayOpenPath(current.destination)) {
    throw new ValidationError('Parents cannot open that page in the app. Change the link before publishing.');
  }
  return write(writer, resourceId,
    state === 'published' ? `state = 'published', published_at = coalesce(published_at, now())` : `state = 'archived'`, []);
}

async function write(writer: Writer, resourceId: string, set: string, values: unknown[]): Promise<StaffParentResource> {
  const editor = values.length + 3;
  try {
    await query(
      `update pilot.parent_resources
          set ${set}, updated_by_account_id = $${editor}, updated_by_role = $${editor + 1}
        where organization_id = $1 and resource_id = $2::uuid`,
      [writer.organizationId, resourceId, ...values, writer.accountId, writer.role],
    );
  } catch (error) {
    rethrowWrite(error);
  }
  return present(writer.organizationId, await readOne(writer.organizationId, resourceId));
}
