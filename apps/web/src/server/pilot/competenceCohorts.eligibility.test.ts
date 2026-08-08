import {
  ageOnGymDay,
  evaluateCohortFit,
  gymToday,
  type CohortDefinitionRow,
  type CohortFitInput,
} from './competenceCohorts';

// evaluateCohortFit and ageOnGymDay are the only judgement in the module;
// everything else is a straight read. They decide which room an athlete stands
// in, so every branch is worth pinning.

function cohort(overrides: Partial<CohortDefinitionRow> = {}): CohortDefinitionRow {
  return {
    organization_id: 'org-1',
    cohort_id: 'coh-1',
    cohort_name: 'Working Group',
    discipline: 'boxing',
    min_level_ordinal: null,
    max_level_ordinal: null,
    required_domains: '',
    tenure_bands: '',
    min_age_regulatory: null,
    max_age_regulatory: null,
    regulatory_basis: '',
    contact_permitted: 'none',
    requires_coach_approval: true,
    notes: '',
    active_flag: true,
    ...overrides,
  };
}

function input(overrides: Partial<CohortFitInput> = {}): CohortFitInput {
  return {
    competenceByDomain: {},
    tenureBand: 'fundamentals',
    ageYears: 20,
    ...overrides,
  };
}

describe('evaluateCohortFit -- level range', () => {
  it('admits an athlete when the cohort constrains nothing at all', () => {
    expect(evaluateCohortFit(input(), cohort()).eligible).toBe(true);
  });

  it('requires every named domain to be assessed, not just one of them', () => {
    const fit = evaluateCohortFit(
      input({ competenceByDomain: { defense: 5 } }),
      cohort({ min_level_ordinal: 4, required_domains: 'defense,composure,partner_control' }),
    );

    expect(fit.eligible).toBe(false);
    expect(fit.unmet).toEqual([
      'No assessed level in composure.',
      'No assessed level in partner control.',
    ]);
  });

  it('treats an unassessed required domain as missing, never as a pass by omission', () => {
    const fit = evaluateCohortFit(
      input({ competenceByDomain: {} }),
      cohort({ min_level_ordinal: 1, required_domains: 'defense' }),
    );

    expect(fit.eligible).toBe(false);
  });

  it('reports every unmet domain rather than stopping at the first', () => {
    // A coach fixing one gap should not have to re-run to discover the next.
    const fit = evaluateCohortFit(
      input({ competenceByDomain: { defense: 1, composure: 1 } }),
      cohort({ min_level_ordinal: 4, required_domains: 'defense,composure' }),
    );

    expect(fit.unmet).toHaveLength(2);
  });

  it('admits when every named domain sits inside the range', () => {
    const fit = evaluateCohortFit(
      input({ competenceByDomain: { defense: 4, composure: 5, partner_control: 6 } }),
      cohort({ min_level_ordinal: 4, max_level_ordinal: 6, required_domains: 'defense,composure,partner_control' }),
    );

    expect(fit.eligible).toBe(true);
    expect(fit.unmet).toEqual([]);
  });

  it('rejects a domain above the ceiling, not only below the floor', () => {
    // The top of a range matters: an athlete who has outgrown the entry room
    // should stop being offered it.
    const fit = evaluateCohortFit(
      input({ competenceByDomain: { defense: 9 } }),
      cohort({ max_level_ordinal: 2, required_domains: 'defense' }),
    );

    expect(fit.eligible).toBe(false);
    expect(fit.unmet[0]).toMatch(/outside this room's range/);
  });

  it('with blank required_domains, one in-range domain is enough', () => {
    const fit = evaluateCohortFit(
      input({ competenceByDomain: { footwork: 2, offense: 9 } }),
      cohort({ min_level_ordinal: 1, max_level_ordinal: 3 }),
    );

    expect(fit.eligible).toBe(true);
  });

  it('with blank required_domains, zero assessments is still not enough', () => {
    const fit = evaluateCohortFit(
      input({ competenceByDomain: {} }),
      cohort({ min_level_ordinal: 1, max_level_ordinal: 3 }),
    );

    expect(fit.eligible).toBe(false);
    expect(fit.unmet).toEqual(['No assessed competence levels yet.']);
  });

  it('with blank required_domains and no in-range domain, says so', () => {
    const fit = evaluateCohortFit(
      input({ competenceByDomain: { offense: 9 } }),
      cohort({ min_level_ordinal: 1, max_level_ordinal: 3 }),
    );

    expect(fit.unmet).toEqual(["No assessed domain falls in this room's level range."]);
  });

  it('applies a floor with no ceiling, and a ceiling with no floor', () => {
    const floorOnly = cohort({ min_level_ordinal: 4, required_domains: 'defense' });
    expect(evaluateCohortFit(input({ competenceByDomain: { defense: 99 } }), floorOnly).eligible).toBe(true);
    expect(evaluateCohortFit(input({ competenceByDomain: { defense: 3 } }), floorOnly).eligible).toBe(false);

    const ceilingOnly = cohort({ max_level_ordinal: 2, required_domains: 'defense' });
    expect(evaluateCohortFit(input({ competenceByDomain: { defense: 1 } }), ceilingOnly).eligible).toBe(true);
    expect(evaluateCohortFit(input({ competenceByDomain: { defense: 3 } }), ceilingOnly).eligible).toBe(false);
  });

  it('tolerates spacing and trailing commas in required_domains', () => {
    const fit = evaluateCohortFit(
      input({ competenceByDomain: { defense: 4, composure: 4 } }),
      cohort({ min_level_ordinal: 4, required_domains: ' defense , composure , ' }),
    );

    expect(fit.eligible).toBe(true);
  });
});

describe('evaluateCohortFit -- tenure', () => {
  it('admits any tenure when the cohort names none', () => {
    expect(evaluateCohortFit(input({ tenureBand: 'introduction' }), cohort()).eligible).toBe(true);
  });

  it('admits a band the cohort names', () => {
    const fit = evaluateCohortFit(
      input({ tenureBand: 'development' }),
      cohort({ tenure_bands: 'development,established' }),
    );
    expect(fit.eligible).toBe(true);
  });

  it('rejects a band the cohort does not name', () => {
    const fit = evaluateCohortFit(
      input({ tenureBand: 'introduction' }),
      cohort({ tenure_bands: 'development,established' }),
    );

    expect(fit.eligible).toBe(false);
    expect(fit.unmet[0]).toMatch(/does not take/);
  });

  it('treats a null tenure band as unestablished, not as a wildcard', () => {
    // An athlete with no logged training has no row in v_athlete_tenure at all.
    // Reading that absence as "matches anything" would put a first-timer in the
    // sparring room.
    const fit = evaluateCohortFit(
      input({ tenureBand: null }),
      cohort({ tenure_bands: 'development,established' }),
    );

    expect(fit.eligible).toBe(false);
    expect(fit.unmet[0]).toMatch(/No logged training yet/);
  });

  it('still admits a null tenure band when the cohort names no bands', () => {
    expect(evaluateCohortFit(input({ tenureBand: null }), cohort()).eligible).toBe(true);
  });
});

describe('evaluateCohortFit -- regulatory age', () => {
  it('ignores age entirely when the cohort carries no bound', () => {
    expect(evaluateCohortFit(input({ ageYears: 8 }), cohort()).eligible).toBe(true);
  });

  it('rejects below a regulatory minimum and cites the rulebook', () => {
    const fit = evaluateCohortFit(
      input({ ageYears: 12 }),
      cohort({ min_age_regulatory: 15, regulatory_basis: 'USA Boxing Rulebook 2026 s.3.1' }),
    );

    expect(fit.eligible).toBe(false);
    // The citation is the point: a bare number would be an invented age band.
    expect(fit.unmet[0]).toContain('USA Boxing Rulebook 2026 s.3.1');
  });

  it('rejects above a regulatory maximum and cites the rulebook', () => {
    const fit = evaluateCohortFit(
      input({ ageYears: 41 }),
      cohort({ max_age_regulatory: 40, regulatory_basis: 'USA Boxing Rulebook 2026 s.3.2' }),
    );

    expect(fit.eligible).toBe(false);
    expect(fit.unmet[0]).toContain('USA Boxing Rulebook 2026 s.3.2');
  });

  it('treats the bounds as inclusive', () => {
    const bounded = cohort({
      min_age_regulatory: 15,
      max_age_regulatory: 40,
      regulatory_basis: 'rulebook',
    });
    expect(evaluateCohortFit(input({ ageYears: 15 }), bounded).eligible).toBe(true);
    expect(evaluateCohortFit(input({ ageYears: 40 }), bounded).eligible).toBe(true);
  });

  it('refuses to guess when the date of birth is unknown', () => {
    const fit = evaluateCohortFit(
      input({ ageYears: null }),
      cohort({ min_age_regulatory: 15, regulatory_basis: 'rulebook' }),
    );

    expect(fit.eligible).toBe(false);
    expect(fit.unmet[0]).toMatch(/cannot be checked/);
  });
});

describe('evaluateCohortFit -- reporting', () => {
  it('collects failures from all three axes at once', () => {
    const fit = evaluateCohortFit(
      input({ competenceByDomain: {}, tenureBand: 'introduction', ageYears: 10 }),
      cohort({
        min_level_ordinal: 4,
        required_domains: 'defense',
        tenure_bands: 'established',
        min_age_regulatory: 15,
        regulatory_basis: 'rulebook',
      }),
    );

    expect(fit.eligible).toBe(false);
    expect(fit.unmet).toHaveLength(3);
  });

  it('carries the approval and contact facts through even when eligible', () => {
    // Passing the rules is not the same as being cleared to spar; the coach
    // sign-off and the contact level must survive to the caller.
    const fit = evaluateCohortFit(
      input(),
      cohort({ requires_coach_approval: true, contact_permitted: 'controlled_sparring' }),
    );

    expect(fit.eligible).toBe(true);
    expect(fit.requires_coach_approval).toBe(true);
    expect(fit.contact_permitted).toBe('controlled_sparring');
  });
});

describe('ageOnGymDay', () => {
  it('counts whole years', () => {
    expect(ageOnGymDay('2000-06-15', '2026-06-15')).toBe(26);
  });

  it('does not round up the day before a birthday', () => {
    expect(ageOnGymDay('2000-06-15', '2026-06-14')).toBe(25);
  });

  it('ages up exactly on the birthday, not after it', () => {
    expect(ageOnGymDay('2000-06-15', '2026-06-16')).toBe(26);
  });

  it('handles a birthday later in the year than today', () => {
    expect(ageOnGymDay('2000-12-31', '2026-01-01')).toBe(25);
  });

  it('handles a 29 February birth date without inventing a year', () => {
    expect(ageOnGymDay('2004-02-29', '2026-02-28')).toBe(21);
    expect(ageOnGymDay('2004-02-29', '2026-03-01')).toBe(22);
  });

  it('accepts a full timestamp and reads only the date part', () => {
    expect(ageOnGymDay('2000-06-15T00:00:00.000Z', '2026-06-15T23:00:00.000Z')).toBe(26);
  });

  it('returns null rather than a wrong number for an unparseable date', () => {
    expect(ageOnGymDay('not-a-date', '2026-06-15')).toBeNull();
  });
});

describe('gymToday', () => {
  // These pin a real defect found by the Postgres suite, not by this file: the
  // first version called formatGymDay, which renders "June 16, 2026" for people
  // to read. ageOnGymDay parsed that to NaN and every regulatory age check
  // silently returned "date of birth unknown".
  it('returns a sortable YYYY-MM-DD, not a human-readable date', () => {
    expect(gymToday(new Date('2026-06-16T12:00:00Z'))).toBe('2026-06-16');
  });

  it('produces a value ageOnGymDay can actually parse', () => {
    expect(ageOnGymDay('2008-06-15', gymToday(new Date('2026-06-16T12:00:00Z')))).toBe(18);
  });

  it('names the gym\'s day, not UTC\'s, during an evening session', () => {
    // 01:30 UTC on the 17th is 21:30 on the 16th in the gym's zone -- mid
    // session. Using the UTC date would age an athlete up a day early, and that
    // value gates a regulatory contact bound.
    expect(gymToday(new Date('2026-06-17T01:30:00Z'))).toBe('2026-06-16');
  });

  it('agrees with UTC during the gym\'s afternoon', () => {
    expect(gymToday(new Date('2026-06-16T18:00:00Z'))).toBe('2026-06-16');
  });
});
