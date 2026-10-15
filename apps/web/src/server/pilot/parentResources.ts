/*
 * PARENT RESOURCES, the family's read (#1593, PH-11): the guides,
 * checklists, videos and policies a gym has published for families, from
 * pilot.parent_resources (PH-10).
 *
 * What a guardian reads, for one child linked to them now (linked, not
 * deleted, under 18; anything else is the same 404):
 *   - published resources for every family of the gym, and
 *   - published resources for a program the child is an ACTIVE member of
 *     (PH-11 Q1 default B). A membership names its program by name
 *     (pilot.program_memberships), so it is matched to pilot.programs by the
 *     canonical name the programs table keeps unique, and only an active
 *     program counts.
 * Drafts and archived resources never show. No writer or account id leaves.
 *
 * A link only to somewhere the parent can go (PH-11 Q-A default A): an
 * internal destination is kept only if the building map lists that page for
 * parents (components/buildingMap.ts, which exists so nothing advertises a
 * door that bounces). The page's own guard stays the authority; this keeps a
 * dead link off a family's screen. External destinations are https only
 * (PH-10's check) and open outside the app.
 */
import { query } from './db';
import { NotFoundError } from './errors';
import { isGuardianLinkedToAthlete } from './guardianAccess';
import { OPEN, doorForPath } from '@/components/buildingMap';

const NOT_YOUR_CHILD = 'Not found: that child is not on your page.';

export interface ParentResourceItem {
  resource_id: string;
  title: string;
  summary: string;
  resource_type: 'guide' | 'checklist' | 'video' | 'policy';
  destination_kind: 'internal' | 'external';
  destination: string;
}

/** True when the building map lists the page an app path opens as one a parent may open. */
export function parentMayOpenPath(destination: string): boolean {
  const pathname = destination.split(/[?#]/, 1)[0] ?? '';
  const door = doorForPath(pathname);
  return door !== null && (door.roles === OPEN || door.roles.includes('parent'));
}

export async function listResourcesForGuardian(
  organizationId: string,
  accountId: string,
  athleteId: string,
): Promise<ParentResourceItem[]> {
  if (!(await isGuardianLinkedToAthlete(organizationId, accountId, athleteId))) {
    throw new NotFoundError(NOT_YOUR_CHILD);
  }
  const rows = await query<ParentResourceItem>(
    `select r.resource_id::text as resource_id, r.title, r.summary, r.resource_type,
            r.destination_kind, r.destination
       from pilot.parent_resources r
      where r.organization_id = $1
        and r.state = 'published'
        and (
          r.program_id is null
          or r.program_id in (
            select p.program_id
              from pilot.programs p
              join pilot.program_memberships m
                on m.organization_id = p.organization_id
               and lower(btrim(m.program_name)) = lower(btrim(p.program_name))
             where p.organization_id = $1
               and p.status = 'active'
               and m.athlete_id = $2
               and m.status = 'active'
          )
        )
      order by r.published_at desc, r.resource_id`,
    [organizationId, athleteId],
  );
  return rows.filter((row) => row.destination_kind === 'external' || parentMayOpenPath(row.destination));
}
