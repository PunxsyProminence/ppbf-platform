import { MINT } from '../ids';
import type { DatasetSpec } from '../types';
import { integer, keyColumn, organizationColumn, text, vocabulary } from './common';

// R3 (Jason, 2026-09-29): "every drill is different so the rules would vary,
// obviously injury of some sort would require stoppage universally". The small
// gym-wide set -- injury and the like -- is stored ONCE and applies to every
// drill, instead of being copied onto 119 drills the way the five boilerplate
// lines labelled 'universal' are today (those are NOT universal; see the stop
// rules file).
//
// SPEC ONLY IN THIS SLICE: no file is committed yet and no table holds these
// rows until the content-import migration lands (plan IMP-03). The wording of
// the set is Jason's to supply.

export const universalStopRulesDataset: DatasetSpec = {
  name: 'universal-stop-rules',
  title: 'Universal stop rules',
  folder: 'drill-library',
  summary:
    'The few stop conditions that apply to EVERY drill (injury and the like), stored once. A drill\'s own rules '
    + 'go in seed_drill_stop_rules.csv. Under R2 a changed rule becomes a new version.',
  loadedToday:
    'No committed file yet. When one lands, seed-reference-data `all` loads it through the content-import core '
    + '(pilot.universal_stop_rules): a new rule is inserted, a changed one becomes a new version and supersedes the old.',
  files: [
    {
      dataset: 'universal-stop-rules',
      folder: 'drill-library',
      file: 'seed_universal_stop_rules.csv',
      rowMeaning: 'one gym-wide stop condition',
      key: ['universal_rule_id'],
      nameColumn: 'condition_text',
      unique: [{ columns: ['ordinal'], description: 'ordinal is unique across the set.' }],
      mint: { column: 'universal_rule_id', idKind: 'universal_rule', mint: (row) => MINT.universalRule(row.condition_text) },
      columns: [
        organizationColumn(),
        keyColumn('universal_rule_id', 'universal_rule', 'Keep the existing id on a revision; new:<short-name> for a new rule.', true),
        integer('ordinal', 'Order in which the rules are shown.', { required: true, bound: 'positive' }),
        text('condition_text', 'Stop when ...', { required: true }),
        vocabulary('rule_kind', 'stop_rule_kind', 'What kind of stop.', { required: true }),
        {
          ...vocabulary('applies_to_contact_levels', 'contact_level', 'Drill contact levels the rule applies to, separated by |.'),
          list: '|',
          blankMeans: 'every drill',
        },
      ],
    },
  ],
};
