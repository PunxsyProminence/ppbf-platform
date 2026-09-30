import { MINT } from '../ids';
import type { DatasetSpec } from '../types';
import { integerText, isIntegerText, parseBoolean } from '../values';
import {
  bool,
  integer,
  keyColumn,
  organizationColumn,
  referenceColumn,
  systemColumn,
  text,
  vocabulary,
} from './common';

// pilot.competence_levels and pilot.cohort_definitions (competence_cohorts
// migration :28-37, :107-142). Loaded by the content-import core (seed-reference-data, npm run seed:competence-cohorts).

export const competenceLevelsDataset: DatasetSpec = {
  name: 'competence-levels',
  title: 'Competence levels',
  folder: 'competence-cohorts',
  summary:
    'The ladder a coach places an athlete on in each domain. Cohorts qualify athletes by a level ORDINAL, '
    + "so changing a level's ordinal changes which athletes every cohort admits. Other tables point at "
    + 'level_key, so under R2 the planned revision is an in-place update with the old row kept in a history ledger.',
  loadedToday:
    'seed-reference-data workflow, dataset competence-levels (npm run seed:competence-cohorts loads it with the cohorts), '
    + 'through the content-import core: a new key is inserted, a changed row is revised in place with before and after '
    + 'kept in the history ledger, an unchanged one is skipped. An ordinal change is refused.',
  files: [
    {
      dataset: 'competence-levels',
      folder: 'competence-cohorts',
      file: 'seed_competence_levels.csv',
      rowMeaning: 'one level',
      key: ['level_key'],
      nameColumn: 'display_name',
      unique: [{ columns: ['ordinal'], description: 'ordinal is unique (the database refuses a second level at the same position).' }],
      columns: [
        organizationColumn(),
        keyColumn('level_key', 'slug', 'The level key, e.g. holding. Keep it on a revision.', false),
        integer('ordinal', 'Position on the ladder; cohorts refer to levels by this number.', { required: true }),
        text('display_name', 'The name people see.', { required: true }),
        text('observable_test', 'What the coach must SEE to place an athlete here.', { required: true }),
        vocabulary('typical_scale', 'scale_level', 'The scale level athletes at this level usually work at.'),
      ],
    },
  ],
};

function ordinalValue(value: string): number | null {
  return value && isIntegerText(value) ? Number(integerText(value)) : null;
}

export const cohortDefinitionsDataset: DatasetSpec = {
  name: 'cohort-definitions',
  title: 'Cohort definitions',
  folder: 'competence-cohorts',
  summary:
    'The rooms athletes are grouped into, by competence and time in the programme (never by age, except where '
    + 'a rulebook binds it). The table has no version columns, so under R2 the planned revision is an in-place '
    + 'update with the old row kept in a history ledger.',
  loadedToday:
    'seed-reference-data workflow, dataset cohort-definitions (npm run seed:competence-cohorts loads it with the levels), '
    + 'through the content-import core: a new id is inserted, a changed row is revised in place with before and after '
    + 'kept in the history ledger, an unchanged one is skipped.',
  files: [
    {
      dataset: 'cohort-definitions',
      folder: 'competence-cohorts',
      file: 'seed_cohort_definitions.csv',
      rowMeaning: 'one cohort',
      key: ['cohort_id'],
      nameColumn: 'cohort_name',
      mint: { column: 'cohort_id', idKind: 'cohort', mint: (row) => MINT.cohort(row.cohort_name) },
      columns: [
        organizationColumn(),
        keyColumn('cohort_id', 'cohort', 'Keep the existing id on a revision; new:<short-name> for a new cohort.', true),
        text('cohort_name', 'The name people see.', { required: true }),
        referenceColumn('discipline', 'discipline', 'A discipline key.', { required: true, idKind: 'slug' }),
        {
          name: 'min_level_ordinal',
          role: 'reference',
          type: 'integer',
          references: 'level_ordinal',
          description: 'Lowest competence level ordinal admitted.',
          blankMeans: 'no lower bound',
        },
        {
          name: 'max_level_ordinal',
          role: 'reference',
          type: 'integer',
          references: 'level_ordinal',
          description: 'Highest competence level ordinal admitted.',
          blankMeans: 'no upper bound',
        },
        // ',' and not '|': these two are stored as one text value and split on
        // ',' by the reader (competenceCohorts.ts:210-211, :266, :300), so the
        // separator is part of the stored format, not a file convention.
        {
          ...vocabulary(
            'required_domains',
            'competence_domain',
            'Domains that must each be assessed, and inside the level range when one is set.',
          ),
          list: ',',
          blankMeans: 'any one assessed domain in range qualifies',
        },
        {
          ...vocabulary('tenure_bands', 'tenure_band', 'Time-in-programme bands admitted.'),
          list: ',',
          blankMeans: 'any tenure',
        },
        integer('min_age_regulatory', 'Youngest age a RULEBOOK allows; needs regulatory_basis.'),
        integer('max_age_regulatory', 'Oldest age a RULEBOOK allows; needs regulatory_basis.'),
        text('regulatory_basis', 'Which rulebook and clause imposes the age bound.'),
        vocabulary('contact_permitted', 'cohort_contact_permitted', 'The most contact this cohort may do.', { blankDefault: 'none' }),
        bool('requires_coach_approval', 'A coach must approve each athlete into the cohort.', { blankDefault: 'true' }),
        text('notes', 'Coach notes.'),
        systemColumn('active_flag', 'true', 'retiring a cohort is a separate action'),
      ],
      rowRules: [
        {
          description: 'min_level_ordinal is not above max_level_ordinal.',
          mirrors: { table: 'cohort_definitions', constraint: 'pilot_cohortdef_level_order' },
          check: (row) => {
            const min = ordinalValue(row.min_level_ordinal);
            const max = ordinalValue(row.max_level_ordinal);
            return min !== null && max !== null && max < min
              ? `min_level_ordinal ${min} is above max_level_ordinal ${max}`
              : null;
          },
        },
        {
          description: 'An age bound names the rulebook imposing it in regulatory_basis.',
          mirrors: { table: 'cohort_definitions', constraint: 'pilot_cohortdef_reg_basis' },
          check: (row) =>
            (row.min_age_regulatory || row.max_age_regulatory) && !row.regulatory_basis
              ? 'an age bound needs regulatory_basis: which rulebook and clause imposes it'
              : null,
        },
        {
          description: 'Sparring cohorts (controlled_sparring, open_sparring) require coach approval.',
          mirrors: { table: 'cohort_definitions', constraint: 'pilot_cohortdef_contact_gate' },
          check: (row) => {
            const contact = row.contact_permitted || 'none';
            const approval = row.requires_coach_approval ? parseBoolean(row.requires_coach_approval) : true;
            return !['none', 'light_technical'].includes(contact) && approval === false
              ? `contact_permitted ${contact} needs requires_coach_approval true`
              : null;
          },
        },
      ],
    },
  ],
};
