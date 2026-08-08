import { GYM_TIME_ZONE } from '@/src/lib/gymTime';

import { query, queryOne } from './db';

// pilot.competence_levels, pilot.athlete_competence, pilot.cohort_definitions
// and pilot.v_athlete_tenure are owned by
// infra/azure/pilot_slice_postgres_competence_cohorts_migration.sql, applied
// through the apply-migrations workflow like every other table. Nothing here
// issues DDL.
//
// READ-ONLY MODULE. Recording a competence level is a coach judgement with its
// own evidence and audit requirements; this module reads what has been
// recorded and works out which rooms an athlete currently fits.
//
// AGE IS NOT A GROUPING AXIS. Athletes group by competence and time in the
// programme. Age enters only where a rulebook binds it -- round structure and
// contact eligibility -- so it is derived from pilot.athletes.dob at read time
// and never stored as a band. A cohort carrying an age bound must cite the
// rulebook imposing it (pilot_cohortdef_reg_basis); this module surfaces that
// citation rather than presenting a bare number.
//
// TENURE IS DERIVED FROM LOGGED TRAINING, NOT FROM THE CALENDAR. Someone
// enrolled eighteen months who attended twice is not an eighteen-month
// athlete. pilot.v_athlete_tenure bands on training hours for that reason.

export const COMPETENCE_DOMAINS = [
  'stance_base',
  'footwork',
  'offense',
  'defense',
  'distance_timing',
  'decision_making',
  'composure',
  'conditioning',
  'ring_craft',
  'partner_control',
] as const;

export type CompetenceDomain = (typeof COMPETENCE_DOMAINS)[number];

export interface CompetenceLevelRow {
  organization_id: string;
  level_key: string;
  ordinal: number;
  display_name: string;
  observable_test: string;
  typical_scale: 'A' | 'B' | 'C' | null;
}

export interface AthleteCompetenceRow {
  organization_id: string;
  competence_id: string;
  athlete_id: string;
  domain: CompetenceDomain;
  level_key: string;
  ordinal: number;
  display_name: string;
  basis: string;
  assessment_id: string | null;
  assessed_by_account_id: string;
  assessed_on: string;
  evidence_note: string;
}

export interface AthleteTenureRow {
  organization_id: string;
  athlete_id: string;
  first_session_on: string;
  last_session_on: string;
  sessions_logged: number;
  hours_logged: string;
  days_enrolled: number;
  tenure_band: string;
}

export interface CohortDefinitionRow {
  organization_id: string;
  cohort_id: string;
  cohort_name: string;
  discipline: string;
  min_level_ordinal: number | null;
  max_level_ordinal: number | null;
  required_domains: string;
  tenure_bands: string;
  min_age_regulatory: number | null;
  max_age_regulatory: number | null;
  regulatory_basis: string;
  contact_permitted: string;
  requires_coach_approval: boolean;
  notes: string;
  active_flag: boolean;
}

const LEVEL_FIELDS = 'organization_id, level_key, ordinal, display_name, observable_test, typical_scale';

const COHORT_FIELDS =
  'organization_id, cohort_id, cohort_name, discipline, min_level_ordinal, max_level_ordinal, '
  + 'required_domains, tenure_bands, min_age_regulatory, max_age_regulatory, regulatory_basis, '
  + 'contact_permitted, requires_coach_approval, notes, active_flag';

/** The gym's competence ladder, lowest rung first. */
export async function listCompetenceLevels(organizationId: string): Promise<CompetenceLevelRow[]> {
  return query<CompetenceLevelRow>(
    `select ${LEVEL_FIELDS} from pilot.competence_levels
     where organization_id = $1
     order by ordinal`,
    [organizationId],
  );
}

/**
 * One athlete's CURRENT level in each domain.
 *
 * Superseded rows are excluded: the migration keeps history rather than
 * overwriting a level, so reading without the `superseded_by is null` filter
 * would return every assessment an athlete has ever had and silently pick an
 * arbitrary one as current. The partial unique index guarantees at most one
 * live row per (athlete, domain).
 */
export async function getAthleteCompetence(
  organizationId: string,
  athleteId: string,
): Promise<AthleteCompetenceRow[]> {
  return query<AthleteCompetenceRow>(
    `select c.organization_id, c.competence_id, c.athlete_id, c.domain, c.level_key,
            l.ordinal, l.display_name, c.basis, c.assessment_id, c.assessed_by_account_id,
            c.assessed_on, c.evidence_note
     from pilot.athlete_competence c
     join pilot.competence_levels l
       on l.organization_id = c.organization_id and l.level_key = c.level_key
     where c.organization_id = $1
       and c.athlete_id = $2
       and c.superseded_by is null
     order by c.domain`,
    [organizationId, athleteId],
  );
}

/**
 * Time in the programme, derived from logged activity.
 *
 * Returns null for an athlete with no logged activity at all. That is not an
 * error and not a zero: pilot.v_athlete_tenure inner-joins pilot.activity_log,
 * so an athlete who has never trained has no row rather than a row of zeroes.
 * Callers must treat null as "no history yet", which is exactly what the
 * 'insufficient_history' band means once any sessions exist.
 */
export async function getAthleteTenure(
  organizationId: string,
  athleteId: string,
): Promise<AthleteTenureRow | null> {
  return queryOne<AthleteTenureRow>(
    // sessions_logged is count(*), which Postgres types as bigint and the
    // driver hands back as a STRING. Cast it so the declared number type is
    // true rather than a lie a caller would only discover doing arithmetic.
    // Dates are cast to text for the same reason: the driver otherwise returns
    // a Date built in the process timezone, which is not the gym's.
    `select organization_id, athlete_id,
            to_char(first_session_on, 'YYYY-MM-DD') as first_session_on,
            to_char(last_session_on, 'YYYY-MM-DD')  as last_session_on,
            sessions_logged::int                    as sessions_logged,
            hours_logged, days_enrolled, tenure_band
     from pilot.v_athlete_tenure
     where organization_id = $1 and athlete_id = $2`,
    [organizationId, athleteId],
  );
}

/** The cohort rules. Inactive definitions are hidden unless asked for. */
export async function listCohortDefinitions(
  organizationId: string,
  filter: { discipline?: string; includeInactive?: boolean } = {},
): Promise<CohortDefinitionRow[]> {
  return query<CohortDefinitionRow>(
    `select ${COHORT_FIELDS} from pilot.cohort_definitions
     where organization_id = $1
       and ($2::boolean or active_flag)
       and ($3::text is null or discipline = $3)
     order by coalesce(min_level_ordinal, 0), cohort_name`,
    [organizationId, filter.includeInactive ?? false, filter.discipline ?? null],
  );
}

// ---------------------------------------------------------------------------
// Eligibility. Pure, so it can be tested exhaustively without a database.

export interface CohortFit {
  cohort_id: string;
  cohort_name: string;
  eligible: boolean;
  /** Why not, in the coach's terms. Empty when eligible. */
  unmet: string[];
  /** True when the cohort still needs a coach to sign off even though the rules pass. */
  requires_coach_approval: boolean;
  contact_permitted: string;
  /** The cited rulebook, when this cohort carries an age bound. Empty otherwise. */
  regulatory_basis: string;
}

export interface CohortFitInput {
  /** domain -> current level ordinal. Domains never assessed are simply absent. */
  competenceByDomain: Partial<Record<CompetenceDomain, number>>;
  /** null when the athlete has no logged activity at all. */
  tenureBand: string | null;
  /** null only when dob is unknown, which pilot.athletes does not permit. */
  ageYears: number | null;
}

/** Splits a comma-separated definition field, tolerating spaces and trailing commas. */
function splitList(raw: string): string[] {
  return raw.split(',').map((part) => part.trim()).filter((part) => part !== '');
}

/**
 * Whole years old on a given gym-local day, computed by calendar arithmetic on
 * YYYY-MM-DD strings.
 *
 * Deliberately not done with Date subtraction: an athlete must age up at
 * midnight in the gym's own timezone, not at midnight UTC, which falls at 7pm
 * or 8pm the previous local evening -- exactly when a session is running and
 * exactly when a regulatory contact bound would flip on the wrong night.
 */
export function ageOnGymDay(dob: string, gymDay: string): number | null {
  const birth = dob.slice(0, 10).split('-').map(Number);
  const today = gymDay.slice(0, 10).split('-').map(Number);
  if (birth.length !== 3 || today.length !== 3 || birth.some(Number.isNaN) || today.some(Number.isNaN)) {
    return null;
  }
  const [by, bm, bd] = birth;
  const [ty, tm, td] = today;
  let age = ty - by;
  if (tm < bm || (tm === bm && td < bd)) {
    age -= 1;
  }
  return age;
}

/**
 * Today in the gym's timezone, as YYYY-MM-DD.
 *
 * Not formatGymDay, which renders "June 16, 2026" for people to read. This
 * needs the sortable, parseable form, so it goes through en-CA -- the locale
 * whose short date IS YYYY-MM-DD -- pinned to the gym's zone. Using
 * toISOString() instead would name the wrong day every evening, because UTC is
 * already tomorrow while the gym is still training.
 */
export function gymToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: GYM_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/**
 * Does this athlete fit this cohort, and if not, what is missing?
 *
 * Every check reports its own reason rather than short-circuiting, so a coach
 * sees everything standing between an athlete and a room instead of fixing one
 * gap only to find another.
 */
export function evaluateCohortFit(input: CohortFitInput, cohort: CohortDefinitionRow): CohortFit {
  const unmet: string[] = [];

  const requiredDomains = splitList(cohort.required_domains);
  const { min_level_ordinal: min, max_level_ordinal: max } = cohort;

  if (min !== null || max !== null) {
    const inRange = (ordinal: number) => (min === null || ordinal >= min) && (max === null || ordinal <= max);

    if (requiredDomains.length > 0) {
      // Named domains: EVERY one must be assessed and in range. A domain the
      // athlete has never been assessed in is not a pass by omission.
      for (const domain of requiredDomains) {
        const ordinal = input.competenceByDomain[domain as CompetenceDomain];
        if (ordinal === undefined) {
          unmet.push(`No assessed level in ${domain.replace(/_/g, ' ')}.`);
        } else if (!inRange(ordinal)) {
          unmet.push(`${domain.replace(/_/g, ' ')} is at level ${ordinal}, outside this room's range.`);
        }
      }
    } else {
      // Blank required_domains means any domain qualifies, so one in-range
      // domain is enough -- but zero assessments is still not enough.
      const ordinals = Object.values(input.competenceByDomain).filter(
        (o): o is number => typeof o === 'number',
      );
      if (ordinals.length === 0) {
        unmet.push('No assessed competence levels yet.');
      } else if (!ordinals.some(inRange)) {
        unmet.push("No assessed domain falls in this room's level range.");
      }
    }
  }

  const bands = splitList(cohort.tenure_bands);
  if (bands.length > 0) {
    if (input.tenureBand === null) {
      unmet.push('No logged training yet, so time in the programme cannot be established.');
    } else if (!bands.includes(input.tenureBand)) {
      unmet.push(`Time in the programme is "${input.tenureBand.replace(/_/g, ' ')}", which this room does not take.`);
    }
  }

  if (cohort.min_age_regulatory !== null || cohort.max_age_regulatory !== null) {
    if (input.ageYears === null) {
      unmet.push('Date of birth is unknown, so the regulatory age bound cannot be checked.');
    } else {
      if (cohort.min_age_regulatory !== null && input.ageYears < cohort.min_age_regulatory) {
        unmet.push(`Regulatory minimum age is ${cohort.min_age_regulatory} (${cohort.regulatory_basis}).`);
      }
      if (cohort.max_age_regulatory !== null && input.ageYears > cohort.max_age_regulatory) {
        unmet.push(`Regulatory maximum age is ${cohort.max_age_regulatory} (${cohort.regulatory_basis}).`);
      }
    }
  }

  return {
    cohort_id: cohort.cohort_id,
    cohort_name: cohort.cohort_name,
    eligible: unmet.length === 0,
    unmet,
    requires_coach_approval: cohort.requires_coach_approval,
    contact_permitted: cohort.contact_permitted,
    regulatory_basis: cohort.regulatory_basis,
  };
}

export interface AthleteCohortReport {
  athlete_id: string;
  tenure: AthleteTenureRow | null;
  age_years: number | null;
  competence: AthleteCompetenceRow[];
  fits: CohortFit[];
}

/**
 * The full picture for one athlete: what they have been assessed at, how long
 * they have actually trained, and which rooms that puts them in.
 *
 * A cohort is a rule, not a roster -- nothing here writes a membership row, so
 * an athlete moves rooms the moment their assessed level or logged hours
 * change, with no list to keep in sync.
 */
export async function getAthleteCohortReport(
  organizationId: string,
  athleteId: string,
  options: { discipline?: string; now?: Date } = {},
): Promise<AthleteCohortReport | null> {
  const athlete = await queryOne<{ athlete_id: string; dob: string }>(
    // dob is cast to text in the query rather than converted in JS. The driver
    // returns a `date` column as a Date object constructed in the process
    // timezone, so a JS-side conversion would shift the birthday by a day
    // whenever the server runs west of UTC -- and this value decides a
    // regulatory contact bound.
    `select athlete_id, to_char(dob, 'YYYY-MM-DD') as dob
     from pilot.athletes
     where organization_id = $1 and athlete_id = $2`,
    [organizationId, athleteId],
  );
  if (!athlete) {
    return null;
  }

  const [competence, tenure, cohorts] = await Promise.all([
    getAthleteCompetence(organizationId, athleteId),
    getAthleteTenure(organizationId, athleteId),
    listCohortDefinitions(organizationId, { discipline: options.discipline }),
  ]);

  const ageYears = ageOnGymDay(String(athlete.dob), gymToday(options.now));

  const competenceByDomain: Partial<Record<CompetenceDomain, number>> = {};
  for (const row of competence) {
    competenceByDomain[row.domain] = row.ordinal;
  }

  const fitInput: CohortFitInput = {
    competenceByDomain,
    tenureBand: tenure?.tenure_band ?? null,
    ageYears,
  };

  return {
    athlete_id: athleteId,
    tenure,
    age_years: ageYears,
    competence,
    fits: cohorts.map((cohort) => evaluateCohortFit(fitInput, cohort)),
  };
}
