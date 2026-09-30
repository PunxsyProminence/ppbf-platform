import { MINT } from '../ids';
import type { DatasetSpec } from '../types';
import { parseBoolean } from '../values';
import { bool, childIdColumn, organizationColumn, referenceColumn, text, vocabulary } from './common';

// pilot.transfer_claims (transfer_claims migration :35-82). No loader yet: the
// content-import engine has no dataset module for it (datasets/index.ts), and
// the seed workflow leaves it out of its choices, because every committed row
// points at a drill that is not in the library (seed-reference-data.yml header,
// seedWorkflowContract.test.ts). contentPackageContract.test.ts pins that
// defect as exactly 173 orphaned rows over 61 drill ids.

export const transferClaimsDataset: DatasetSpec = {
  name: 'transfer-claims',
  title: 'Transfer claims',
  folder: 'transfer-claims',
  summary:
    'What a drill or a script block is claimed to develop beyond the sport, and how strong the evidence is. '
    + 'A claim is part of its drill\'s or script\'s material.',
  loadedToday:
    'Nothing yet. The content-import core has no loader for this dataset (a load that names it is refused, '
    + 'npm run seed:transfer-claims included), and seed-reference-data leaves it out of its choices because every '
    + 'committed row points at a drill that is not in the library.',
  files: [
    {
      dataset: 'transfer-claims',
      folder: 'transfer-claims',
      file: 'seed_transfer_claims.csv',
      rowMeaning: 'one claim about one drill, script or script block',
      key: ['transfer_id'],
      mint: {
        column: 'transfer_id',
        idKind: 'transfer',
        mint: (row) => MINT.transfer(row.drill_id || row.block_id || row.script_id, row.claim_kind, row.statement),
      },
      columns: [
        organizationColumn(),
        childIdColumn(
          'transfer_id',
          'transfer',
          'KEEP it on a revision: a blank one finds a committed claim only by the same target, claim_kind and statement.',
        ),
        referenceColumn('drill_id', 'drill', "A drill's lineage key or a new:<short-name> in this package.", { idKind: 'drill', allowNew: true }),
        referenceColumn('block_id', 'block', 'A session script block id.', { idKind: 'block' }),
        referenceColumn('script_id', 'script', 'A script id or a new:<short-name> in this package.', { idKind: 'script', allowNew: true }),
        vocabulary('claim_kind', 'claim_kind', 'What kind of transfer.', { required: true }),
        text('statement', 'The claim.', { required: true }),
        text('named_structure', "A brain structure the claim names, e.g. cerebellum; blank when none."),
        vocabulary('evidence_class', 'transfer_evidence_class', 'How strong the evidence is.', { blankDefault: 'MECHANISM-THEORISED' }),
        referenceColumn(
          'registry_claim_id',
          'claim',
          'The research claim behind it, from the LOADED research package. Required for EVIDENCE-SUPPORTED.',
          { idKind: 'claim' },
        ),
        text('source_document', 'Which PPBF document it came from.', { label: true }),
        bool('athlete_facing', 'Athletes may see it.', { blankDefault: 'true' }),
        bool('public_facing', 'It may be shown outside the gym.', { blankDefault: 'false' }),
      ],
      rowRules: [
        {
          description: 'Exactly one of drill_id, block_id and script_id.',
          mirrors: { table: 'transfer_claims', constraint: 'pilot_transfer_one_target' },
          check: (row) => {
            const targets = [row.drill_id, row.block_id, row.script_id].filter(Boolean).length;
            return targets === 1 ? null : `names ${targets} targets; exactly one of drill_id, block_id, script_id is required`;
          },
        },
        {
          description: 'EVIDENCE-SUPPORTED needs a registry_claim_id.',
          mirrors: { table: 'transfer_claims', constraint: 'pilot_transfer_evidence' },
          check: (row) =>
            row.evidence_class === 'EVIDENCE-SUPPORTED' && !row.registry_claim_id
              ? 'EVIDENCE-SUPPORTED needs registry_claim_id'
              : null,
        },
        {
          description: 'A public claim that names a brain structure must be EVIDENCE-SUPPORTED.',
          mirrors: { table: 'transfer_claims', constraint: 'pilot_transfer_public_gate' },
          check: (row) =>
            parseBoolean(row.public_facing) === true && row.named_structure
            && (row.evidence_class || 'MECHANISM-THEORISED') !== 'EVIDENCE-SUPPORTED'
              ? `public_facing names ${row.named_structure} without EVIDENCE-SUPPORTED`
              : null,
        },
      ],
    },
  ],
};
