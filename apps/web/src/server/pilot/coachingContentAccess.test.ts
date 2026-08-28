import fs from 'node:fs';
import path from 'node:path';

import { COACHING_CONTENT_READER_ROLES } from './coachingContentAccess';
import { ORGANIZATION_MEMBER_ROLES } from './shadowRoleSets';
import type { PilotRole } from './contracts';

// The decision itself, and the three properties that keep it from decaying
// back into what it replaced.
//
// It replaced three answers to one question. /api/pilot/drills gated gym-wide
// drill content to seven roles; /api/pilot/drill-library and
// /api/pilot/coach/cue-library gated it to nothing. Each had a written
// rationale. None cited the others, and nothing failed when they disagreed.
//
// So the cases here are not only "the list has the right roles in it". Two of
// them are about the ways a correct list stops being one: by a sibling policy
// changing underneath it, and by a route quietly keeping a copy.

const ROUTES_DIR = path.resolve(__dirname, '../../../app/api/pilot');

function routeSource(relative: string): string {
  return fs.readFileSync(path.join(ROUTES_DIR, relative), 'utf8');
}

const GATED_READ_ROUTES = [
  'drills/route.ts',
  'drill-library/route.ts',
  'coach/cue-library/route.ts',
];

describe('the coaching-content read policy', () => {
  it('admits the platform owner and refuses the board', () => {
    // The two roles the decision actually moved. Everything else was preserved.
    expect(COACHING_CONTENT_READER_ROLES).toContain('platform_owner');
    expect(COACHING_CONTENT_READER_ROLES).not.toContain('board');
  });

  it('preserves every organization member role', () => {
    // "Do not weaken" is a real constraint, not a formality: the decision moved
    // one role in and one role out, and a list rebuilt from scratch could
    // satisfy both of those while dropping, say, volunteer.
    for (const role of ORGANIZATION_MEMBER_ROLES) {
      expect(COACHING_CONTENT_READER_ROLES).toContain(role);
    }
  });

  it('is exactly the organization members plus the platform owner, and says so if that stops being true', () => {
    // THE DRIFT TRIPWIRE.
    //
    // ORGANIZATION_MEMBER_ROLES belongs to shadowRoleSets.ts and exists for
    // SHADOW route authorization. Today it is set-identical to what this policy
    // covers, minus platform_owner -- which is exactly why deriving this list
    // from it would have been tempting and wrong. A role added there for
    // SHADOW's reasons would silently change who may read a gym's drills.
    //
    // The two lists are therefore independent, and their relationship is
    // asserted. If it breaks, that is not a bug in this file: it is someone
    // having changed one of the two sets, and the question of whether the
    // other should follow is an owner decision, not a test repair.
    const expected = [...ORGANIZATION_MEMBER_ROLES, 'platform_owner' as PilotRole];

    expect([...COACHING_CONTENT_READER_ROLES].sort()).toEqual([...expected].sort());
  });

  it('names each role once', () => {
    // A duplicate is harmless to `includes` and is the visible symptom of a
    // list that was edited by two people who could not see each other.
    expect(new Set(COACHING_CONTENT_READER_ROLES).size).toBe(COACHING_CONTENT_READER_ROLES.length);
  });
});

describe('every surface serving this content reaches the one policy', () => {
  it.each(GATED_READ_ROUTES)('%s imports and applies it', (relative) => {
    const source = routeSource(relative);

    expect(source).toMatch(
      /import \{ COACHING_CONTENT_READER_ROLES \} from '@\/src\/server\/pilot\/coachingContentAccess'/,
    );
    expect(source).toMatch(/requireRole\(principal, \[\.\.\.COACHING_CONTENT_READER_ROLES\]\)/);
  });

  it('no route keeps a private reader list beside the shared one', () => {
    // The failure mode this whole module exists to prevent, asserted directly.
    // A route could import the policy, apply it, and still carry its own
    // DRILL_READER_ROLES used somewhere else in the file -- passing every case
    // above while the drift is already back.
    for (const relative of GATED_READ_ROUTES) {
      expect(routeSource(relative)).not.toMatch(/DRILL_READER_ROLES/);
    }
  });

  it('all three use the aliasing requireRole, so admin and organization_admin cannot diverge by route', () => {
    // There are two requireRole implementations. access.ts treats 'admin' and
    // 'organization_admin' as aliases of each other; http.ts does not. Both
    // strings are in the policy list, so the choice does not change today's
    // outcome -- and it would if either name were ever removed from the list,
    // which is the point at which three routes importing two different gates
    // would start disagreeing again.
    for (const relative of GATED_READ_ROUTES) {
      expect(routeSource(relative)).toMatch(
        /import \{ requireRole \} from '@\/src\/server\/pilot\/access'/,
      );
    }
  });
});

describe('read access did not become write access', () => {
  it('leaves drill authoring at coach and the two admin roles', () => {
    // The decision was explicit that the platform owner receiving READ access
    // must not broaden authoring. Asserted here rather than left to the drills
    // route's own tests, because this is the file whose change would have
    // caused it: DRILL_AUTHOR_ROLES sits directly beneath the reader gate that
    // moved, and is one careless edit away.
    const source = routeSource('drills/route.ts');

    expect(source).toMatch(
      /const DRILL_AUTHOR_ROLES = \['coach', 'organization_admin', 'admin'\] as const;/,
    );
    expect(source).not.toMatch(/DRILL_AUTHOR_ROLES = \[[^\]]*platform_owner/);
  });

  it('still gates POST and PATCH on the author list, not the reader list', () => {
    // Naming the constant is not using it. A route that imported the reader
    // policy and applied it to POST would satisfy the case above.
    const source = routeSource('drills/route.ts');
    const authorGates = source.match(/requireRole\(principal, \[\.\.\.DRILL_AUTHOR_ROLES\]\)/g) ?? [];

    // Exactly two: POST and PATCH.
    expect(authorGates).toHaveLength(2);
  });
});
