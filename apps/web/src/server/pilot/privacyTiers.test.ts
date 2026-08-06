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

  it('never gets compared numerically anywhere in the pilot server code', () => {
    // The header says tiers are not a ladder. This keeps it true: no
    // production module may index or rank PRIVACY_TIERS -- the registry
    // itself and this test are the only legitimate mentions.
    const offenders: string[] = [];
    const files = readdirSync(HERE).filter(
      (file) => file.endsWith('.ts') && !file.endsWith('.test.ts') && file !== 'privacyTiers.ts',
    );
    for (const file of files) {
      const source = readFileSync(path.join(HERE, file), 'utf8');
      if (/PRIVACY_TIERS\s*\.\s*indexOf|PRIVACY_TIERS\s*\[/.test(source)) {
        offenders.push(file);
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

  it('covers every column the public-surface denylist forbids', () => {
    // The column denylist and the field registry must not drift apart: a
    // column forbidden on public surfaces is sensitive, so it has a tier.
    const fieldColumns = Object.keys(FIELD_TIERS).map((key) => key.split('.').pop());
    for (const column of PUBLIC_SURFACE_FORBIDDEN_COLUMNS) {
      const bare = column.split('.').pop();
      expect({ column, tiered: fieldColumns.includes(bare) || column === 'checked_in_by_role' }).toEqual({
        column,
        tiered: true,
      });
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

describe('the promoted denylists stay non-empty and health-shaped', () => {
  it('forbidden tables still include the clinical core', () => {
    for (const table of ['pilot.medical_intake', 'pilot.shadow_medical', 'pilot.shadow_near_misses', 'pilot.feedback']) {
      expect(PUBLIC_SURFACE_FORBIDDEN_TABLES).toContain(table);
    }
  });

  it('ranking tables stay separate from sensitivity tables', () => {
    for (const table of PUBLIC_RANKING_FORBIDDEN_TABLES) {
      expect(PUBLIC_SURFACE_FORBIDDEN_TABLES).not.toContain(table);
    }
  });
});
