import type { DatasetSpec } from '../types';
import { bool, integer, keyColumn, number, organizationColumn, systemColumn, text, vocabulary } from './common';

// pilot.assessment_protocols (assessment_protocols migration :30-61).
//
// WHY THIS TYPE IS HERE (R4, "all, types"). The table exists, the app reads it
// (assessmentProtocols.ts:89-120), and nothing writes it: the only insert
// anywhere is a test fixture (assessmentProtocols.pg.test.ts:146). Its seed
// material already sits in the research package as
// shadow-research/2026-08-08/physical_test_battery.csv (20 tests, A5-T01..T20).
//
// THE COLUMNS ARE THE TABLE'S, not the battery CSV's. The battery is research
// output with its own headings (test_name, time_min, citation_ref, ...); a
// hand-off states the protocol the gym will use in the table's own terms.
// No column is invented here.
//
// SPEC ONLY IN THIS SLICE: no committed file, and no loader yet.

export const assessmentProtocolsDataset: DatasetSpec = {
  name: 'assessment-protocols',
  title: 'Assessment protocols',
  folder: 'assessment-protocols',
  summary:
    'Physical tests, skill rubrics and questionnaires the gym administers, with their retest guidance and '
    + 'measurement properties. Under R2 a changed protocol becomes the next protocol_version; a recorded result '
    + 'keeps pointing at the version it was taken with (pilot_assessments_protocol_fk).',
  loadedToday: 'Nothing yet. The table exists and the app reads it, but no loader writes it; the file validates today.',
  files: [
    {
      dataset: 'assessment-protocols',
      folder: 'assessment-protocols',
      file: 'seed_assessment_protocols.csv',
      rowMeaning: 'one protocol',
      key: ['protocol_id'],
      nameColumn: 'name',
      unique: [
        { columns: ['name'], description: 'name is unique among active protocols (pilot_assessment_protocols_one_active_name).' },
      ],
      columns: [
        organizationColumn(),
        keyColumn(
          'protocol_id',
          'assessment_protocol',
          "The test's id from the research battery, e.g. A5-T01. It is the protocol's identity: keep it on a revision.",
          false,
        ),
        systemColumn('protocol_version', '1', 'a changed protocol becomes the next version at load'),
        text('name', 'The protocol name.', { required: true }),
        vocabulary('measure_kind', 'assessment_measure_kind', 'What kind of measure.', { required: true }),
        text('source_ref', 'Where it came from, e.g. the battery row or citation.', { label: true }),
        text('quality_measured', 'What it measures.', { required: true }),
        text('protocol_summary', 'How to administer it.', { required: true }),
        text('equipment_needed', 'Equipment.'),
        integer('time_to_administer_min', 'Minutes to administer.'),
        integer('retest_interval_days', 'Days between retests, 1 or more.', {
          bound: 'positive',
          blankMeans: 'the research gave no defensible interval',
        }),
        number('retest_after_training_hours', 'Training hours between retests, above 0.', {
          bound: 'positive',
          blankMeans: 'the research gave no defensible interval',
        }),
        text('retest_interval_basis', 'Why that interval.', { blankDefault: 'TBD - no defensible basis' }),
        text('reliability_status', 'How reliable the measure is known to be.', { blankDefault: 'UNVALIDATED - PPBF MUST ESTABLISH' }),
        text('validity_status', 'What it is known to be valid for.', { blankDefault: 'UNKNOWN' }),
        text('evidence_class', 'Strength of the evidence behind it.', { blankDefault: 'INSUFFICIENT EVIDENCE' }),
        text('boxing_specific', 'Whether it was developed in boxing.', { blankDefault: 'NO - transferred' }),
        number('minimal_detectable_change', 'Smallest change that is not measurement error.', {
          blankMeans: 'unknown until PPBF\'s reliability study supplies it',
        }),
        bool('human_authority_required', 'A qualified person must administer or interpret it.', { blankDefault: 'true' }),
        systemColumn('active', 'true', 'retiring a protocol is a separate action'),
      ],
    },
  ],
};
