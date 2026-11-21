/**
 * Lane AS-10, AS10-5 (app scrub OFF-11, OFF-17, OFF-19, OFF-21; Overwatch Q10 A
 * on #2018): the links the office pages gained so each paired page leads to
 * where its work is done.
 *
 * Two rules, read from the page sources (not rendered; each page's own suite
 * renders its link):
 *   1. A link's words are the title of the page it opens (OD-2026-10-17-001
 *      ruling 1, "Each menu label matches its page title", applied to in-page
 *      links -- INFERRED as the scrub does for AS-13).
 *   2. A link never sends a reader to a page that refuses them: a plain link
 *      only where every role the source page admits is admitted by the target;
 *      otherwise a RoleLink whose roles are exactly the target page's gate.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

const APP = path.join(__dirname, '..');

function source(route: string): string {
  return readFileSync(path.join(APP, ...route.split('/').filter(Boolean), 'page.tsx'), 'utf8');
}

/** The roles in a page's RoleSessionGate / RoleStandaloneView `allowedRoles`. */
function gate(route: string): string[] {
  const match = source(route).match(/allowedRoles=\{\[([^\]]*)\]\}/);
  if (!match) throw new Error(`no allowedRoles on ${route}`);
  return [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]).sort();
}

/** The text of each <h1> on a page, with tags dropped and &amp; read as &. */
function titles(route: string): string[] {
  return [...source(route).matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/g)]
    .map((m) => m[1].replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim());
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Every link to `href` on `route`, as written: plain Link or RoleLink, its roles, its words. */
function linksTo(route: string, href: string) {
  const pattern = new RegExp(
    `<(Link|RoleLink)\\s+href="${escape(href)}"([^>]*)>\\s*([^<]*?)\\s*</\\1>`,
    'g',
  );
  return [...source(route).matchAll(pattern)].map((m) => ({
    kind: m[1],
    roles: m[1] === 'RoleLink'
      ? [...(m[2].match(/roles=\{\[([^\]]*)\]\}/)?.[1] ?? '').matchAll(/'([^']+)'/g)].map((r) => r[1]).sort()
      : null,
    words: m[3].replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim(),
  }));
}

const LINKS: ReadonlyArray<{ from: string; href: string; target: string; title: string }> = [
  // OFF-11: Safety Review's holds open the Clearance Board (Q10 A: holds only).
  { from: '/admin/safety-review', href: '/coach/sports-medicine', target: '/coach/sports-medicine', title: 'Clearance Board' },
  // OFF-11: Escalations and Safety Flags lead back to the rollup.
  { from: '/admin/escalations', href: '/admin/safety-review', target: '/admin/safety-review', title: 'Safety Review' },
  { from: '/admin/safety-flags', href: '/admin/safety-review', target: '/admin/safety-review', title: 'Safety Review' },
  // OFF-17: Coach Coverage and Staff Credentials.
  { from: '/admin/coach-coverage', href: '/admin/credentials', target: '/admin/credentials', title: 'Staff Credentials' },
  { from: '/admin/credentials', href: '/admin/coach-coverage', target: '/admin/coach-coverage', title: 'Coach Coverage' },
  // OFF-19: the two waiver pages; Volunteers, Gym Office and Staff Credentials.
  { from: '/admin/consent', href: '/admin/waiver-status', target: '/admin/waiver-status', title: 'Waiver Compliance' },
  { from: '/admin/waiver-status', href: '/admin/consent', target: '/admin/consent', title: 'Waivers & Consent' },
  { from: '/admin/volunteer-management', href: '/admin/people', target: '/admin/people', title: 'Gym Office' },
  { from: '/admin/volunteer-management', href: '/admin/credentials', target: '/admin/credentials', title: 'Staff Credentials' },
  { from: '/admin/people', href: '/admin/volunteer-management', target: '/admin/volunteer-management', title: 'Volunteers' },
  // OFF-21: Load a Roster opens Gym Office on Add Athlete; Duplicate Guardians links Gym Office.
  { from: '/admin/import', href: '/admin/people?tab=add-athlete', target: '/admin/people', title: 'Gym Office' },
  { from: '/admin/data-quality', href: '/admin/people', target: '/admin/people', title: 'Gym Office' },
];

describe.each(LINKS)('$from links $title', ({ from, href, target, title }) => {
  test('the target page carries that title', () => {
    expect(titles(target)).toContain(title);
  });

  test('exactly one link, in the target page\'s own words, shown only to roles the target admits', () => {
    const links = linksTo(from, href);
    expect(links).toHaveLength(1);
    const [link] = links;
    expect(link.words).toBe(title);
    const sourceRoles = gate(from);
    const targetRoles = gate(target);
    if (link.kind === 'Link') {
      // Everyone this page admits is admitted there.
      expect(sourceRoles.filter((role) => !targetRoles.includes(role))).toEqual([]);
    } else {
      expect(link.roles).toEqual(targetRoles);
    }
  });
});
