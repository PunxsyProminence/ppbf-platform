import { existsSync } from 'node:fs';
import path from 'node:path';

// F-037 and F-038 (lane N4-04, #1484 deleted them): these pages showed a
// made-up approval pipeline naming the owner, signed out, or drew invented
// figures (a per-child "cleared to publish" value, a return-to-play figure).
// Their own honesty tests went with them, so nothing else notices if one comes
// back. A page here returns only as a real feature, with this list edited on
// purpose.
const REMOVED_PAGES = [
  'source-control/page.tsx',
  'source-control/publication-workflow/page.tsx',
  'admin/communications/page.tsx',
  'admin/curriculum/page.tsx',
  'coach/operations/page.tsx',
  'admin/macro-analytics/page.tsx',
];

test.each(REMOVED_PAGES)('app/%s stays deleted', (page) => {
  expect(existsSync(path.join(__dirname, page))).toBe(false);
});
