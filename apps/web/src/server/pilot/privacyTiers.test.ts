import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { BOARD_MINIMUM_COHORT_SIZE } from './boardSummary';
import {
  FIELD_TIERS,
  PRIVACY_TIER_DOCTRINE,
  PRIVACY_TIERS,
  PUBLIC_RANKING_FORBIDDEN_TABLES,
  PUBLIC_SURFACE_FORBIDDEN_COLUMNS,
  PUBLIC_SURFACE_FORBIDDEN_TABLES,
} from './privacyTiers';
import { MINOR_CIRCLE } from './profileVisibility';
import { SHADOW_PHI_ROLES } from './shadowRoleSets';

/**
 * The tier registry is a set of CLAIMS about enforcement that lives
 * elsewhere. Claims drift; these tests are the alarm. Each one asserts that
 * the thing a tier says about the codebase is still true of the codebase --
 * the same drift-guard shape as safetyGateSeedsOwnership.test.ts and
 * auditEventVocabulary.test.ts, and for the same reason: a registry that
 * can silently diverge from its enforcers is worse than no registry,
 * because readers will trust the registry.
 */

const HERE = __dirname;

describe('the tier vocabulary', () => {
  it('is closed: exactly the six tiers, each with doctrine', () => {
    expect(PRIVACY_TIERS).toHaveLength(6);
    expect([...PRIVACY_TIERS].sort()).toEqual(Object.keys(PRIVACY_TIER_DOCTRINE).sort());
  });

  it('never gets compared numerically anywhere in the pilot server code or routes', () => {
    // The header says tiers are not a ladder. This keeps it true: no
    // production module may index, rank, or sort PRIVACY_TIERS -- the
    // registry itself and this test are the only legitimate mentions.
    // Recursive over BOTH roots (matching the guardianAccess sweep's
    // scope), so formulas/ and route files cannot hide a comparison.
    const offenders: string[] = [];
    const webRoot = path.resolve(HERE, '../../..');

    function* walk(dir: string): Generator<string> {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const resolved = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          yield* walk(resolved);
        } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
          yield resolved;
        }
      }
    }

    for (const root of [HERE, path.join(webRoot, 'app/api/pilot')]) {
      for (const file of walk(root)) {
        if (path.basename(file) === 'privacyTiers.ts') continue;
        const source = readFileSync(file, 'utf8');
        if (/PRIVACY_TIERS\s*\.\s*(indexOf|findIndex|sort)|PRIVACY_TIERS\s*\[/.test(source)) {
          offenders.push(path.relative(webRoot, file));
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('each tier still holds the invariant it claims', () => {
  it('minor_circle: exactly self, coach_of_subject, guardian_of_subject', () => {
    expect([...MINOR_CIRCLE]).toEqual(['self', 'coach_of_subject', 'guardian_of_subject']);
  });

  it('board_aggregate: the k-anonymity floor is five distinct athletes', () => {
    expect(BOARD_MINIMUM_COHORT_SIZE).toBe(5);
  });

  it('deidentified_platform: platform_owner holds no PHI role', () => {
    expect(SHADOW_PHI_ROLES).not.toContain('platform_owner');
  });

  it('athlete_record: access.ts still refuses platform_owner and board outright', () => {
    const source = readFileSync(path.join(HERE, 'access.ts'), 'utf8');
    expect(source).toContain('platform owner cannot access organization-private athlete records');
    expect(source).toContain('board role is restricted to organization-level aggregates');
  });

  it('public: the wall consent gate still defaults to initials', () => {
    const source = readFileSync(path.join(HERE, 'wallDisplay.ts'), 'utf8');
    expect(source).toContain('resolveDisplayVisibility');
    expect(source.toLowerCase()).toContain('initials');
  });
});

describe('every enforcedBy names real code', () => {
  const references = [
    ...Object.values(PRIVACY_TIER_DOCTRINE).flatMap((doctrine) => doctrine.enforcedBy),
    ...Object.values(FIELD_TIERS).map((entry) => entry.enforcedBy),
  ];

  it.each([...new Set(references)])('%s exists and contains its symbol', (reference) => {
    const [file, symbol] = reference.split('#');
    const resolved = path.join(HERE, file);
    expect({ reference, exists: existsSync(resolved) }).toEqual({ reference, exists: true });
    if (symbol) {
      const source = readFileSync(resolved, 'utf8');
      expect({ reference, found: source.includes(symbol) }).toEqual({ reference, found: true });
    }
  });
});

describe('the field registry', () => {
  it('assigns only known tiers', () => {
    for (const [field, entry] of Object.entries(FIELD_TIERS)) {
      expect({ field, known: PRIVACY_TIERS.includes(entry.tier) }).toEqual({ field, known: true });
    }
  });

  it('covers every column the public-surface denylist forbids -- no exemptions', () => {
    // The column denylist and the field registry must not drift apart: a
    // column forbidden on public surfaces is sensitive, so it has a tier.
    // The bare 'note' entry matches by prefix: it stands in for every
    // *.note / *.notes field the registry carries.
    const fieldColumns = Object.keys(FIELD_TIERS).map((key) => key.split('.').pop() ?? '');
    for (const column of PUBLIC_SURFACE_FORBIDDEN_COLUMNS) {
      const tiered = fieldColumns.some((name) => name === column || name.startsWith(column));
      expect({ column, tiered }).toEqual({ column, tiered: true });
    }
  });

  it('no public tier is ever assigned to a field -- public is earned per read via consent, not per field', () => {
    for (const [field, entry] of Object.entries(FIELD_TIERS)) {
      expect({ field, tier: entry.tier === 'public' ? 'public' : 'not-public' }).toEqual({
        field,
        tier: 'not-public',
      });
    }
  });
});

describe('the promoted denylists are pinned exactly', () => {
  // Promotion created a single point of weakening: one deletion here would
  // silently narrow BOTH wall suites at once, where the old inline lists
  // required edits inside the files that own the teeth. So the contents are
  // pinned exactly, the same way MINOR_CIRCLE is -- shrinking a denylist is
  // an edit somebody has to make in two places, on purpose, with a diff
  // that says so.
  it('the forbidden tables are exactly the twelve clinical/safety/conduct tables', () => {
    expect([...PUBLIC_SURFACE_FORBIDDEN_TABLES].sort()).toEqual([
      'pilot.assessments',
      'pilot.coach_observations',
      'pilot.compliance_records',
      'pilot.documents',
      'pilot.emergency_contacts',
      'pilot.feedback',
      'pilot.intake_cases',
      'pilot.medical_intake',
      'pilot.readiness',
      'pilot.shadow_medical',
      'pilot.shadow_near_misses',
      'pilot.training_holds',
    ]);
  });

  it('the forbidden columns are exactly the eight', () => {
    expect([...PUBLIC_SURFACE_FORBIDDEN_COLUMNS].sort()).toEqual([
      'checked_in_by_account_id',
      'checked_in_by_role',
      'clearance_status',
      'emergency_contact',
      'gym_status',
      'note',
      'signed_by_name',
      'weight_class',
    ]);
  });

  it('the ranking tables are exactly the four, and stay separate from sensitivity tables', () => {
    expect([...PUBLIC_RANKING_FORBIDDEN_TABLES].sort()).toEqual([
      'pilot.athlete_milestones',
      'pilot.attendance',
      'pilot.scheduler_attendance',
      'pilot.sessions',
    ]);
    for (const table of PUBLIC_RANKING_FORBIDDEN_TABLES) {
      expect(PUBLIC_SURFACE_FORBIDDEN_TABLES).not.toContain(table);
    }
  });
});
