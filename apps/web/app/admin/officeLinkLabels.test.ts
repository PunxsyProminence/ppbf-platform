/**
 * Lane AS-10, AS10-6a (app scrub OFF-15): link words that named a page by
 * something other than its title now use the title (OD-2026-10-17-001 ruling 1,
 * "Each menu label matches its page title", applied to in-page links: INFERRED,
 * as the scrub does for AS-13). Read from the page sources; each page's own
 * suite renders its link.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

const APP = path.join(__dirname, '..');

function source(route: string): string {
  return readFileSync(path.join(APP, ...route.split('/').filter(Boolean), 'page.tsx'), 'utf8');
}

/** The text of each <h1> on a page, with tags dropped and &amp; read as &. */
function titles(route: string): string[] {
  return [...source(route).matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/g)]
    .map((m) => m[1].replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim());
}

/** The words of every plain link to `href` on `route`. */
function wordsOfLinksTo(route: string, href: string): string[] {
  const escaped = href.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [...source(route).matchAll(new RegExp(`<Link\\s+href="${escaped}"[^>]*>\\s*([^<]*?)\\s*</Link>`, 'g'))]
    .map((m) => m[1].replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim());
}

const LINKS: ReadonlyArray<{ from: string; href: string; target: string; count: number }> = [
  // consent :363 "Guardian Media Consent desk" and :547 "consent desk" (main 4f77642).
  { from: '/admin/consent', href: '/admin/athlete-consent', target: '/admin/athlete-consent', count: 2 },
  // waiver-status :613 "Photo & Media Consent Audit".
  { from: '/admin/waiver-status', href: '/admin/athlete-consent', target: '/admin/athlete-consent', count: 1 },
  // compliance-center :636 "Cleared tonight".
  { from: '/admin/compliance-center', href: '/admin/waiver-status?view=all', target: '/admin/waiver-status', count: 1 },
];

test.each(LINKS)('every link from $from to $href says the title of the page it opens', ({ from, href, target, count }) => {
  const [title] = titles(target);
  expect(title).toBeTruthy();
  const words = wordsOfLinksTo(from, href);
  expect(words).toHaveLength(count);
  for (const word of words) expect(word).toBe(title);
});
