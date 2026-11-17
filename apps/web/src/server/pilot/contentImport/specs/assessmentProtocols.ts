import type { FileSpec } from '../types';
import { bool, integer, keyColumn, number, organizationColumn, systemColumn, text, vocabulary } from './common';

// pilot.assessment_protocols (assessment_protocols migration :30-61; the
// backbone label columns, assessment_catalog migration (1)).
//
// One file of the assessment-catalog dataset (specs/assessmentCatalog.ts):
// it was a spec-only dataset of its own ('assessment-protocols', never
// loaded) until lane CAT-b folded it in, because the engine finds a file's
// spec by its file name alone (specs/index.ts fileSpecByName).
//
// THE COLUMNS ARE THE TABLE'S. A changed protocol becomes the next
// protocol_version (R2); a recorded result keeps pointing at the version it was
// taken with (pilot_assessments_protocol_fk). A protocol the file leaves out is
// left alone: this file is not a snapshot of the table.
//
// BLANK LOADS BLANK, FOR THIS DATASET (Overwatch's CAT step-1 ruling Q1,
// applying OD-2026-11-12-001's principle). quality_measured is not required,
// and a blank boxing_specific or evidence_class is stored blank: the table's
// defaults ('NO - transferred', 'INSUFFICIENT EVIDENCE') would state a fact the
// backbone does not, and for the Long Road scorecard a false one. The other
// defaults stay (retest_interval_basis's 'TBD - no defensible basis' is true of
// a protocol that states no interval).

export const ASSESSMENT_PROTOCOLS_FILE = 'seed_assessment_protocols.csv';

export const assessmentProtocolsFile: FileSpec = {
  dataset: 'assessment-catalog',
  folder: 'assessment-catalog',
  file: ASSESSMENT_PROTOCOLS_FILE,
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
      "The protocol's id, e.g. PP-T01 (backbone) or A5-T01 (research battery). It is the protocol's identity: keep it on a revision.",
      false,
    ),
    systemColumn('protocol_version', '1', 'a changed protocol becomes the next version at load'),
    text('name', 'The protocol name.', { required: true }),
    vocabulary('measure_kind', 'assessment_measure_kind', 'What kind of measure.', { required: true }),
    text('source_ref', 'Where it came from, e.g. the battery row or citation.', { label: true }),
    text('quality_measured', 'What it measures.', { blankMeans: 'not stated; stored blank (the backbone states none for its 46)' }),
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
    text('evidence_class', 'Strength of the evidence behind it.', { blankMeans: 'not stated; stored blank (CAT ruling Q1)' }),
    text('boxing_specific', 'Whether it was developed in boxing.', { blankMeans: 'not stated; stored blank (CAT ruling Q1)' }),
    number('minimal_detectable_change', 'Smallest change that is not measurement error.', {
      blankMeans: 'unknown until PPBF\'s reliability study supplies it',
    }),
    bool(
      'human_authority_required',
      'A qualified person must administer or interpret it. The backbone does not state it per protocol: its protocols load '
      + 'true, labelled INFERRED in field_labels (backbone RULES section 1, AI informs and humans decide).',
      { blankDefault: 'true' },
    ),
    text('protocol_group', 'The backbone group the protocol belongs to (e.g. Physical test battery).', { label: true }),
    vocabulary('status', 'record_status', 'The record status (backbone RULES section 10).'),
    { name: 'sources', role: 'content', type: 'text', list: '|', label: true, description: 'Source keys, separated by |.' },
    text('decision', 'The decision record the protocol rests on (e.g. D-OQ182).', { label: true }),
    text('backbone_version', 'The backbone snapshot the row comes from. A new value is a new version of the protocol.', { label: true }),
    systemColumn('active', 'true', 'the current version is active; an earlier one is kept inactive'),
  ],
};
