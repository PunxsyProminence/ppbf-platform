import type { DatasetSpec } from '../types';
import { bool, keyColumn, organizationColumn, text, vocabulary } from './common';

// pilot.disciplines (multidiscipline migration :35-50). Loaded today by
// seed-disciplines.mjs:162-201.

export const disciplinesDataset: DatasetSpec = {
  name: 'disciplines',
  title: 'Disciplines',
  folder: 'multidiscipline',
  summary:
    'The sports the gym teaches. Other files name a discipline by its key. Five tables point at the key, so '
    + 'under R2 the planned revision is an in-place update with the old row kept in a history ledger.',
  loadedToday: 'seed-reference-data workflow, dataset disciplines (npm run seed:disciplines): inserts new keys, skips existing ones.',
  files: [
    {
      dataset: 'disciplines',
      folder: 'multidiscipline',
      file: 'seed_disciplines.csv',
      rowMeaning: 'one discipline',
      key: ['discipline'],
      nameColumn: 'display_name',
      columns: [
        organizationColumn(),
        keyColumn('discipline', 'slug', 'The discipline key, e.g. boxing. Keep it on a revision.', false),
        text('display_name', 'The name people see.', { required: true }),
        vocabulary('lane', 'discipline_lane', 'The kind of sport.', { required: true }),
        vocabulary('exposure_model', 'exposure_model', 'The kind of contact exposure it carries.', { required: true }),
        text('governing_body', 'Who sanctions it.'),
        text('age_policy_source', 'Where youth eligibility actually comes from.'),
        // Required, not defaulted: the loader reads a blank as false
        // (seed-disciplines.mjs:184-186, toBool('') === false) while the table
        // defaults two of these to true, so a blank would mean different
        // things depending on which path loaded it.
        bool('youth_permitted', 'Youth may train it.', { required: true }),
        bool('adult_permitted', 'Adults may train it.', { required: true }),
        bool('mixed_age_permitted', 'Adults and youth may train it together.', { required: true }),
        text('evidence_note', 'Evidence behind the entry, with claim ids.'),
        // CONTENT here, not a system flag: this is the gym's on/off switch for
        // the discipline, and the committed file sets it false for wrestling,
        // bjj and combatives. Versioned tables use `active` differently.
        bool('active', 'The discipline is offered.', { blankDefault: 'true' }),
      ],
    },
  ],
};
