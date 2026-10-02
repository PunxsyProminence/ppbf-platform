import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * GOLDEN ERA 003 — MY CORNER (Athlete Workspace).
 *
 * Pins the athlete's real tab groups: a later pass must not quietly drop one,
 * and "it matched when we shipped" is not a guarantee. A deliberate change to
 * the groups updates the list below in the same PR.
 *
 * MUTATION: remove a tab group -- this turns red.
 */
const WORKSPACE = readFileSync(path.resolve(__dirname, '../../components/AthleteWorkspace.tsx'), 'utf8');

describe('the 003 visual pass kept every athlete tab group', () => {
  const REAL_GROUPS = ['Today', 'Development', 'Learn', 'Schedule', 'Messages', 'SHADOW'] as const;

  function groupBlock(): string {
    const m = WORKSPACE.match(/const TAB_GROUPS[\s\S]*?\n\];/);
    expect(m).not.toBeNull();
    return (m as RegExpMatchArray)[0];
  }

  test.each(REAL_GROUPS)('the %s group still exists', (label) => {
    expect(groupBlock()).toContain(`label: '${label}'`);
  });
});
