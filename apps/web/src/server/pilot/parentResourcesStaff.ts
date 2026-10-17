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
 * family read leaves it out, and it is not published until its link changes.
 *
 * Every family, or one of this gym's active programs (Q1 B). A resource whose
 * program has since been archived is marked, and is not published until it
 * names an active program or every family. Nothing is deleted: a resource is
 * archived, and can be published again; the database keeps the first
 * publication time through both.
 *
 * Every change names the version it was made against (updated_at, as the
 * list hands it out); a change against an older version is a 409 and the
 * newer one is kept.
 */
import { query, queryOne } from './db';
import { STAFF_AUTHOR_NAME_FLOOR, getStaffAuthorName } from './achievements';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from './errors';
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
  /** The version a change names back (UTC, to the microsecond); a change against an older one is refused. */
  updated_at: string;
  written_by: string;
  edited_by: string | null;
  /** An internal page the building map does not list for parents: the family read leaves it out. */
  parents_cannot_open: boolean;
  /** Its program is no longer active: no family sees it through that program, and it is not published so. */
  program_archived: boolean;
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

export const STALE_MESSAGE = 'Someone else changed this resource. Reload to see their version.';
export const PROGRAM_ARCHIVED_MESSAGE = 'That program is archived. Choose an active program or every family before publishing.';

// The same host rule as PH-10's destination check, so a link is refused here
// in words rather than by the database.
const HTTPS_LINK = /^https:\/\/([A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?\.)+[A-Za-z]{2,63}(:[0-9]{1,5})?(\/|$)/;
// A resource id has the shape of a uuid; anything else is not in this gym (a
// 404), never a cast error.
const RESOURCE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// The version in the shape SELECT hands it out.
const VERSION = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const VERSION_MESSAGE = 'updated_at is the version of this resource you read.';

interface StoredRow {
  resource_id: string;
  title: string;
  summary: string;
  resource_type: ResourceType;
  destination_kind: 'internal' | 'external';
  destination: string;
  program_id: string | null;
  program_name: string | null;
  program_archived: boolean;
  state: ResourceState;
  published_at: string | null;
  updated_at: string;
  created_by_account_id: string | null;
  created_by_role: string;
  updated_by_account_id: string | null;
  updated_by_role: string | null;
}

// updated_at leaves as text to the microsecond: a JavaScript Date keeps only
// milliseconds, and the version check compares it exactly.
const SELECT = `select r.resource_id::text as resource_id, r.title, r.summary, r.resource_type, r.destination_kind,
         r.destination, r.program_id, p.program_name,
         (r.program_id is not null and p.status is distinct from 'active') as program_archived,
         r.state, r.published_at,
         to_char(r.updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as updated_at,
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

async function programIsActive(organizationId: string, programId: string): Promise<boolean> {
  const program = await queryOne<{ program_id: string }>(
    `select program_id from pilot.programs where organization_id = $1 and program_id = $2 and status = 'active'`,
    [organizationId, programId],
  );
  return program !== null;
}

// Characters as Postgres counts them (char_length): code points, not UTF-16 units.
const characters = (text: string) => [...text].length;

async function checkedFields(
  organizationId: string,
  input: ResourceFields,
  kept?: { programId: string | null; published: boolean },
) {
  const title = input.title.trim();
  const summary = input.summary.trim();
  const destination = input.destination.trim();
  if (characters(title) < 1 || characters(title) > 200) throw new ValidationError('A title is 1 to 200 characters.');
  if (characters(summary) < 1 || characters(summary) > 1000) throw new ValidationError('A summary is 1 to 1000 characters.');
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
    // The database's limits on every link, in words before it is asked.
    if (destination.length > 2000 || /[\s\\]/.test(destination)) {
      throw new ValidationError('That app link is over 2000 characters or has a space or backslash in it.');
    }
    if (!parentMayOpenPath(destination)) {
      throw new ValidationError('Parents cannot open that page in the app. Link a parent page or an https address.');
    }
    destinationKind = 'internal';
  } else {
    throw new ValidationError('The link is an app page starting with / or an https address.');
  }
  const programId = input.program_id?.trim() || null;
  if (programId !== null) {
    if (kept === undefined || programId !== kept.programId) {
      // A new program must be this gym's and active.
      if (!(await programIsActive(organizationId, programId))) {
        throw new ValidationError("That program is not one of this gym's active programs.");
      }
    } else if (kept.published && !(await programIsActive(organizationId, programId))) {
      // A program kept as it was is judged again only while the resource is
      // published. A draft or an archived one may keep an archived program;
      // publishing judges it then.
      throw new ValidationError(PROGRAM_ARCHIVED_MESSAGE);
    }
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
  // A version in the right shape that is not a real time ('2026-02-31T...').
  if (code === '22007' || code === '22008') throw new ValidationError(VERSION_MESSAGE);
  throw error;
}

async function readOne(organizationId: string, resourceId: string): Promise<StoredRow> {
  const row = RESOURCE_ID.test(resourceId)
    ? await queryOne<StoredRow>(`${SELECT} and r.resource_id = $2::uuid`, [organizationId, resourceId])
    : null;
  if (!row) throw new NotFoundError('Not found: that resource is not in this gym.');
  return row;
}

export async function createResource(writer: Writer, input: ResourceFields, publish: boolean): Promise<StaffParentResource> {
  const fields = await checkedFields(writer.organizationId, input);
  let id: { resource_id: string } | null = null;
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
  if (!id) throw new Error('parent resource insert returned no row');
  return present(writer.organizationId, await readOne(writer.organizationId, id.resource_id));
}

/** Change what is sent; a field left out keeps what is stored (program_id null means every family). */
export async function editResource(
  writer: Writer,
  resourceId: string,
  version: string,
  input: Partial<ResourceFields>,
): Promise<StaffParentResource> {
  const current = await readOne(writer.organizationId, resourceId);
  const fields = await checkedFields(writer.organizationId, {
    title: input.title ?? current.title,
    summary: input.summary ?? current.summary,
    resource_type: input.resource_type ?? current.resource_type,
    destination: input.destination ?? current.destination,
    program_id: input.program_id === undefined ? current.program_id : input.program_id,
  }, { programId: current.program_id, published: current.state === 'published' });
  return write(writer, resourceId, version,
    `title = $4, summary = $5, resource_type = $6, destination_kind = $7, destination = $8, program_id = $9`,
    [fields.title, fields.summary, fields.resourceType, fields.destinationKind, fields.destination, fields.programId]);
}

/**
 * Publish (first time, or again after archiving) or archive. The first
 * publication time is the database's and is kept. Asking for the state it is
 * already in writes nothing and returns it as it is.
 */
export async function setResourceState(
  writer: Writer,
  resourceId: string,
  state: 'published' | 'archived',
  version: string,
): Promise<StaffParentResource> {
  const current = await readOne(writer.organizationId, resourceId);
  if (current.state === state) return present(writer.organizationId, current);
  if (state === 'published') {
    if (current.destination_kind === 'internal' && !parentMayOpenPath(current.destination)) {
      throw new ValidationError('Parents cannot open that page in the app. Change the link before publishing.');
    }
    if (current.program_id !== null && !(await programIsActive(writer.organizationId, current.program_id))) {
      throw new ValidationError(PROGRAM_ARCHIVED_MESSAGE);
    }
  }
  return write(writer, resourceId, version,
    state === 'published' ? `state = 'published', published_at = coalesce(published_at, now())` : `state = 'archived'`, []);
}

// One change, made only to the version the caller read. No row means another
// change came first (nothing is deleted or moves gyms, and readOne has just
// found it): that change is kept and the caller reloads.
async function write(writer: Writer, resourceId: string, version: string, set: string, values: unknown[]): Promise<StaffParentResource> {
  if (!VERSION.test(version)) throw new ValidationError(VERSION_MESSAGE);
  const editor = values.length + 4;
  let rows: { resource_id: string }[] = [];
  try {
    rows = await query<{ resource_id: string }>(
      `update pilot.parent_resources
          set ${set}, updated_by_account_id = $${editor}, updated_by_role = $${editor + 1}
        where organization_id = $1 and resource_id = $2::uuid and updated_at = $3::timestamptz
        returning resource_id::text as resource_id`,
      [writer.organizationId, resourceId, version, ...values, writer.accountId, writer.role],
    );
  } catch (error) {
    rethrowWrite(error);
  }
  if (rows.length !== 1) throw new ConflictError(STALE_MESSAGE);
  return present(writer.organizationId, await readOne(writer.organizationId, resourceId));
}
