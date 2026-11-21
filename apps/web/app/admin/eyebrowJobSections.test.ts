import { readFileSync } from 'node:fs';
import path from 'node:path';

import { BUILDING } from '../../components/buildingMap';
import { JOB_BARS } from '../../components/jobBars';
import type { ClubRole } from '../../components/roleRoutes';

/**
 * AS10-6b (lane AS-10; app scrub OFF-15 eyebrows; plan #2018 Q13 A): a page's
 * eyebrow is the name of the AS-4 job section the page sits under. The names
 * are read from JOB_BARS, never retyped, so a section renamed in jobBars.ts
 * turns this suite red until the eyebrow follows it.
 *
 * "Sits under" is read for the roles that see the eyebrow: the roles on the
 * page's door in BUILDING, unless the page draws that eyebrow for fewer roles
 * (named per case). Q13 A: where no section fits, the page falls back to C and
 * its eyebrow is left as it was.
 */

const APP = path.resolve(__dirname, '..');

/**
 * The page's header eyebrow: the first plain-text `t-eyebrow` paragraph inside the first
 * `<header>` that holds the page's `<h1>`. Report and tile labels elsewhere on a page also use
 * `t-eyebrow` (Attendance's "Report by athlete" comes first in its file), so the search is
 * confined to the header.
 */
function headerEyebrow(file: string): string {
  const source = readFileSync(path.join(APP, file), 'utf8');
  const header = (source.match(/<header[\s\S]*?<\/header>/g) ?? []).find((block) => block.includes('<h1'));
  if (!header) throw new Error(`${file}: no <header> holding the page's <h1>`);
  const match = header.match(/<p className="t-eyebrow[^"]*">([^<{]+)<\/p>/);
  if (!match) throw new Error(`${file}: no t-eyebrow paragraph with plain text in the page header`);
  // JSX text writes '&' as '&amp;' in this repo (Parent Consent's h1, Teach Shadow's h2).
  return match[1].replace(/&amp;/g, '&').trim();
}

function doorRoles(href: string): ClubRole[] {
  const door = BUILDING.find((candidate) => candidate.href === href);
  if (!door) throw new Error(`${href}: no door in BUILDING`);
  if (!Array.isArray(door.roles)) throw new Error(`${href}: the door is open to everyone`);
  return [...(door.roles as readonly ClubRole[])];
}

/** Every distinct section name that holds `href` on the bars of `roles`. */
function sectionNames(href: string, roles: readonly ClubRole[]): string[] {
  const names = new Set<string>();
  for (const role of roles) {
    for (const section of JOB_BARS[role]?.sections ?? []) {
      if (section.items.some((item) => item.href === href)) names.add(section.label);
    }
  }
  return [...names];
}

interface EyebrowCase {
  readonly file: string;
  readonly href: string;
  /** Set only where the page draws this eyebrow for fewer roles than its door admits. */
  readonly seenBy?: readonly ClubRole[];
}

const roles = (page: EyebrowCase) => page.seenBy ?? doorRoles(page.href);

/** Pages whose eyebrow becomes their one section name. */
const TAKES_SECTION_NAME: readonly EyebrowCase[] = [
  { file: 'admin/athlete-consent/page.tsx', href: '/admin/athlete-consent' },
  { file: 'admin/feedback/page.tsx', href: '/admin/feedback' },
  { file: 'admin/video-compliance/page.tsx', href: '/admin/video-compliance' },
  { file: 'admin/portrait-review/page.tsx', href: '/admin/portrait-review' },
  { file: 'admin/data-deletion/page.tsx', href: '/admin/data-deletion' },
  { file: 'admin/content-import/page.tsx', href: '/admin/content-import' },
  { file: 'admin/export/page.tsx', href: '/admin/export' },
  { file: 'operations/page.tsx', href: '/operations' },
  // Held by #2063 (AS10-5) until it merged on 2026-11-21.
  { file: 'admin/attendance/page.tsx', href: '/admin/attendance' },
  { file: 'admin/coach-coverage/page.tsx', href: '/admin/coach-coverage' },
  { file: 'admin/safety-review/page.tsx', href: '/admin/safety-review' },
  { file: 'admin/volunteer-management/page.tsx', href: '/admin/volunteer-management' },
  { file: 'admin/waiver-status/page.tsx', href: '/admin/waiver-status' },
  { file: 'admin/escalations/page.tsx', href: '/admin/escalations' },
];

/** Q13 A's fallback C: no section fits for the roles that see the eyebrow, so it is left. */
const NO_SECTION: readonly EyebrowCase[] = [
  { file: 'admin/door-register/page.tsx', href: '/admin/door-register' },
  { file: 'admin/page.tsx', href: '/admin' },
  // "Admin Workspace" is drawn only in the organization admin's view (GymSystemView); the
  // platform owner's view has its own eyebrow, "Platform Desk". The admin's bar has no section
  // for /admin/system.
  { file: 'admin/system/page.tsx', href: '/admin/system', seenBy: ['admin'] },
];

describe('AS10-6b: each office eyebrow is the job section the page sits under', () => {
  it.each(TAKES_SECTION_NAME.map((page) => [page.file, page] as const))(
    '%s reads its one section name',
    (_file, page) => {
      const names = sectionNames(page.href, roles(page));
      expect(names).toHaveLength(1);
      expect(headerEyebrow(page.file)).toBe(names[0]);
    },
  );

  it.each(NO_SECTION.map((page) => [page.file, page] as const))(
    '%s sits under no section for the roles that see its eyebrow, so it is left (Q13 C)',
    (_file, page) => {
      expect(sectionNames(page.href, roles(page))).toEqual([]);
    },
  );

  it('no changed page keeps the old shared words', () => {
    for (const page of TAKES_SECTION_NAME) {
      expect(headerEyebrow(page.file)).not.toMatch(/^(Admin Workspace|Gym Administration)$/);
    }
  });
});
